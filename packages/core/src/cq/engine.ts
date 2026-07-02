/**
 * Stage 1 engine: Monte-Carlo binding sampler + the dual-oracle suite runner.
 *
 * `AnswerPath` is THE product plug-in surface: any knowledge/memory/retrieval
 * layer (LLM, RAG, wiki, graph) implements `answer(binding)` and memory-sql
 * grades it against the SQL oracle. Implementations close over their own
 * dependencies — the effect requirement is `never` so a path can be anything
 * from a pure lookup to a network call wrapped in its own runtime.
 *
 * `bindTemplates` samples parameter bindings from the ACTUAL world (real
 * patient/organization/claim ids, real attribute values, dates in the
 * generator's window) with the product's seeded PRNG — same seed, same world,
 * same suite. Templates are cycled round-robin so every regime (including the
 * negative controls) is represented at any suite size.
 *
 * `runSuite` answers every binding twice, computes the four-way verdict per
 * binding (cq/model.ts), and folds the results into a CqReport with
 * answerable / agreement / citation-resolves rates plus a per-regime
 * breakdown. Bindings run sequentially — the DuckDb service is a single
 * connection by design.
 */
import { Data, Effect, Either } from "effect"
import type { Oracle, OracleError } from "../oracle/sql.js"
import type { DuckDb } from "../store/db.js"
import type { InstanceWorld } from "../store/load.js"
import { formatIsoDate, parseIsoDays } from "../synth/date.js"
import { REFERENCE_DATE } from "../synth/generate.js"
import type { Rng } from "../synth/rng.js"
import type { Answer, CqBinding, CqParams, CqRegime, CqTemplate, ParamSpec, ParamValue, Verdict } from "./model.js"
import { CQ_REGIMES, canonicalizeAnswer, computeVerdict, unsupportedCitations } from "./model.js"

export class PathError extends Data.TaggedError("PathError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * The pluggable answer layer under test. `name` labels the report;
 * implementations may fail with PathError — the suite records the failure as
 * an unanswered question instead of aborting.
 */
export interface AnswerPath {
  readonly name: string
  readonly answer: (binding: CqBinding) => Effect.Effect<Answer, PathError>
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic date sampling (pure civil-day arithmetic from synth/date.ts —
// no Date construction per the SPEC)
// ─────────────────────────────────────────────────────────────────────────────

const isoDays = (iso: string): number => {
  const days = parseIsoDays(iso)
  if (days === null) throw new Error(`memory-sql: invalid ISO date "${iso}" in a template's date range`)
  return days
}

const addDays = (iso: string, days: number): string => formatIsoDate(isoDays(iso) + days)

const sampleDate = (min: string, max: string, rng: Rng): string => {
  const from = isoDays(min)
  const to = isoDays(max)
  return formatIsoDate(from + rng.int(0, Math.max(0, to - from)))
}

/** Default sampling window = the synth generator's data window up to "today". */
const DEFAULT_MIN_DATE = "2020-01-01"
const DEFAULT_MAX_PERIOD_START = "2025-12-31"

// ─────────────────────────────────────────────────────────────────────────────
// Monte-Carlo binding sampler
// ─────────────────────────────────────────────────────────────────────────────

const sampleParam = (spec: ParamSpec, world: InstanceWorld, rng: Rng): ParamValue | undefined => {
  switch (spec.kind) {
    case "entity-id": {
      const ids: string[] = []
      for (const row of world[spec.entityType] ?? []) {
        const id = row["id"]
        if (typeof id === "string") ids.push(id)
      }
      return ids.length > 0 ? rng.pick(ids) : undefined
    }
    case "attribute-value": {
      const values: string[] = []
      for (const row of world[spec.entityType] ?? []) {
        const v = row[spec.attribute]
        if (v !== null && v !== undefined) values.push(String(v))
      }
      // Frequency-weighted pick from real data; when the world has no value at
      // all, fall back to the generator's first pool code so the binding stays
      // askable (both oracles will then agree on an empty answer).
      return values.length > 0 ? rng.pick(values) : `${spec.attribute}-1`
    }
    case "date":
      return sampleDate(spec.min ?? DEFAULT_MIN_DATE, spec.max ?? REFERENCE_DATE, rng)
    case "period": {
      // Spans start at 0 (a single-day period) so the suite exercises the
      // short-period regime too — an answer layer that breaks on narrow
      // windows must be caught here, not only by sim's temporal narrowing.
      const start = sampleDate(spec.min ?? DEFAULT_MIN_DATE, spec.max ?? DEFAULT_MAX_PERIOD_START, rng)
      return { start, end: addDays(start, rng.int(0, 720)) }
    }
  }
}

/**
 * Sample `n` bindings, cycling templates round-robin and drawing every
 * parameter from the world via the seeded rng. A binding whose parameters
 * cannot be sampled (an entity type with no rows) is skipped, so the result
 * may be shorter than `n` on degenerate worlds — never on generated ones.
 */
export const bindTemplates = (
  templates: ReadonlyArray<CqTemplate>,
  world: InstanceWorld,
  rng: Rng,
  n: number
): ReadonlyArray<CqBinding> => {
  const bindings: CqBinding[] = []
  if (templates.length === 0) return bindings
  for (let i = 0; i < n; i++) {
    const template = templates[i % templates.length] as CqTemplate
    const params: Record<string, ParamValue> = {}
    let complete = true
    for (const spec of template.params) {
      const value = sampleParam(spec, world, rng)
      if (value === undefined) {
        complete = false
        break
      }
      params[spec.name] = value
    }
    if (complete) bindings.push({ template, params: params as CqParams })
  }
  return bindings
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite runner + report
// ─────────────────────────────────────────────────────────────────────────────

/** One graded question: both answers, the verdict, and the path failure if any. */
export interface CqResult {
  readonly templateId: string
  readonly regime: CqRegime
  readonly question: string
  readonly binding: CqBinding
  readonly oracle: Answer
  /** null when the path failed to produce an answer at all. */
  readonly path: Answer | null
  readonly pathError: string | null
  readonly verdict: Verdict
}

export interface RegimeBreakdown {
  readonly regime: CqRegime
  readonly total: number
  readonly match: number
  readonly missing: number
  readonly divergent: number
  readonly unsupportedCitation: number
  readonly agreementRate: number
}

export interface CqReport {
  readonly pathName: string
  readonly total: number
  readonly match: number
  readonly missing: number
  readonly divergent: number
  readonly unsupportedCitation: number
  /** Fraction of bindings the path answered (produced a non-missing answer). */
  readonly answerableRate: number
  /** Fraction of bindings graded `match` — the headline dual-oracle number. */
  readonly agreementRate: number
  /** Fraction of path citations that resolve into the oracle's support set. */
  readonly citationResolvesRate: number
  readonly byRegime: ReadonlyArray<RegimeBreakdown>
  readonly results: ReadonlyArray<CqResult>
}

/** Vacuous rates (no bindings, no citations) read as 1 — nothing was wrong. */
const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den)

const questionOf = (binding: CqBinding): string => {
  try {
    return binding.template.text(binding)
  } catch {
    return binding.template.id // a text() bug must not take the suite down
  }
}

/**
 * Answer every binding with the oracle (ground truth — its failure aborts the
 * suite) and the path (its failure is data: verdict `missing`), then fold
 * verdicts into the report. Both answers are canonicalized before grading so
 * external paths are compared on content, not on row order.
 */
export const runSuite = (
  bindings: ReadonlyArray<CqBinding>,
  oracle: Oracle,
  path: AnswerPath
): Effect.Effect<CqReport, OracleError, DuckDb> =>
  Effect.gen(function* () {
    const results: CqResult[] = []
    let supportedCitations = 0
    let totalCitations = 0

    for (const binding of bindings) {
      const oracleAnswer = canonicalizeAnswer(yield* oracle.answer(binding))
      const outcome = yield* Effect.either(path.answer(binding))
      if (Either.isRight(outcome)) {
        const pathAnswer = canonicalizeAnswer(outcome.right)
        const verdict = computeVerdict(oracleAnswer, pathAnswer)
        totalCitations += pathAnswer.citations.length
        supportedCitations +=
          pathAnswer.citations.length - unsupportedCitations(oracleAnswer, pathAnswer).length
        results.push({
          templateId: binding.template.id,
          regime: binding.template.regime,
          question: questionOf(binding),
          binding,
          oracle: oracleAnswer,
          path: pathAnswer,
          pathError: null,
          verdict
        })
      } else {
        results.push({
          templateId: binding.template.id,
          regime: binding.template.regime,
          question: questionOf(binding),
          binding,
          oracle: oracleAnswer,
          path: null,
          pathError: outcome.left.message,
          verdict: "missing"
        })
      }
    }

    const count = (rs: ReadonlyArray<CqResult>, v: Verdict): number =>
      rs.filter((r) => r.verdict === v).length

    const byRegime: RegimeBreakdown[] = []
    for (const regime of CQ_REGIMES) {
      const rs = results.filter((r) => r.regime === regime)
      if (rs.length === 0) continue
      byRegime.push({
        regime,
        total: rs.length,
        match: count(rs, "match"),
        missing: count(rs, "missing"),
        divergent: count(rs, "divergent"),
        unsupportedCitation: count(rs, "unsupported-citation"),
        agreementRate: ratio(count(rs, "match"), rs.length)
      })
    }

    const answered = results.filter((r) => r.path !== null && r.verdict !== "missing").length

    return {
      pathName: path.name,
      total: results.length,
      match: count(results, "match"),
      missing: count(results, "missing"),
      divergent: count(results, "divergent"),
      unsupportedCitation: count(results, "unsupported-citation"),
      answerableRate: ratio(answered, results.length),
      agreementRate: ratio(count(results, "match"), results.length),
      citationResolvesRate: ratio(supportedCitations, totalCitations),
      byRegime,
      results
    }
  })
