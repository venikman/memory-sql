/**
 * Stage 2a — metamorphic testing. A metamorphic relation (MR) states how the
 * answer to a question MUST change (or must not change) under a known
 * transformation of the world or of the question. That property is checkable
 * without any gold labels: we never need to know the right answer, only how
 * two answers relate. This is the zero-annotation complement to the Stage 1
 * dual oracle — it validates the *answer layer* (any AnswerPath) against the
 * structure of the ontology itself.
 *
 * Shipped relations (all generic over the Ontology; nothing FHIR-specific in
 * the engine — the relations only read the generic model + the binding's
 * parameter record):
 *
 *   1. irrelevant-augmentation  — generating a fresh, id-disjoint mini-cohort
 *      and merging it into the world must not change a patient-scoped answer.
 *   2. temporal-narrowing       — shrinking a {period} can only shrink the
 *      result. The source case is answered by the SQL oracle (deterministic
 *      ground truth on the wide period) and the follow-up by the AnswerPath
 *      under test (narrow period): a path that ignores or botches temporal
 *      filters over-returns and lands outside the wide truth, so the subset
 *      check catches it — path-vs-path would let "ignores the filter
 *      entirely" pass as a trivially equal set. The subset check alone is
 *      one-sided (an under-returning path answers the narrow case empty and
 *      passes trivially), so the relation ALSO answers the narrowed binding
 *      with the SQL oracle — same world, so the store holds the truth — and
 *      demands the path match that narrow ground truth exactly; a bisection
 *      probe then walks the oracle down to a provably POPULATED short window
 *      and demands equality there too, so short-span blindness is caught
 *      deterministically instead of only when a random narrow window happens
 *      to contain rows.
 *   3. referential-symmetry     — traversing a relation over the in-memory
 *      world (rows whose `<rel>_ref` hits a target id) must equal the reverse
 *      SQL lookup in the loaded store. Catches load/traversal asymmetries.
 *   4. cross-oracle-equality    — on the identity transform, the AnswerPath
 *      answer equals the SqlOracle answer for every binding: the MR form of
 *      the dual oracle.
 *
 * The runner drives fast-check over (sampled binding, per-case seed) pairs,
 * so a violated relation comes back with a *shrunk* counterexample — the
 * smallest binding index and case seed that still break the relation.
 */
import { Data, Effect } from "effect"
import * as fc from "fast-check"
import type { EntityType, Ontology, Relation } from "../ontology/model.js"
import { getEntityType } from "../ontology/model.js"
import type { DbError, SqlValue } from "../store/db.js"
import { DuckDb } from "../store/db.js"
import type { InstanceWorld, Row } from "../store/load.js"
import { loadWorld, sqlLiteral } from "../store/load.js"
import { quoteIdent, relationRefColumn, relationRefTypeColumn, tableName } from "../store/schema.js"
import { generateWorld } from "../synth/generate.js"
import type { Rng } from "../synth/rng.js"
import { makeRng } from "../synth/rng.js"
import { formatIsoDate, parseIsoDays } from "../synth/date.js"
import type { Answer, CqBinding, Period } from "../cq/model.js"
import { answerValuesEqual, canonicalizeAnswer, isPeriod, withParam } from "../cq/model.js"
import type { AnswerPath } from "../cq/engine.js"
import type { Oracle } from "../oracle/sql.js"

export class MetamorphicRunError extends Data.TaggedError("MetamorphicRunError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Who answers a case: the AnswerPath under test or the deterministic SQL oracle. */
export type MrEvaluator = "path" | "oracle"

export type MrExpectation = "equal" | "subset" | "unchanged-answer"

/** The source case an MR transforms. */
export interface MrCase {
  readonly ontology: Ontology
  readonly world: InstanceWorld
  readonly binding: CqBinding
}

/** The transformed follow-up case; `null` from a transform means "relation not applicable to this binding". */
export interface MrFollowup {
  readonly world: InstanceWorld
  readonly binding: CqBinding
  readonly note?: string
}

/**
 * Everything a relation needs to evaluate answers. `world` is the loaded
 * source world; `path` is the AnswerPath under test over it; `makePath`
 * rebuilds the path over a transformed world (world-transforming relations
 * re-index); `oracle` is the ground-truth SQL oracle over the loaded store.
 * The runner never constructs paths or oracles itself — the caller wires
 * them in, which keeps this engine generic over both the Ontology and the
 * answer layer under test.
 */
export interface MrHarness {
  readonly ontology: Ontology
  readonly world: InstanceWorld
  readonly path: AnswerPath
  readonly makePath: (world: InstanceWorld) => AnswerPath
  readonly oracle: Oracle
}

export interface MrOutcome {
  readonly holds: boolean
  readonly skipped: boolean
  readonly detail: string
}

const mrHolds = (detail: string): MrOutcome => ({ holds: true, skipped: false, detail })
const mrFails = (detail: string): MrOutcome => ({ holds: false, skipped: false, detail })
const mrSkip = (detail: string): MrOutcome => ({ holds: true, skipped: true, detail })

/**
 * A metamorphic relation. Declarative relations provide `transform` (+ the
 * evaluator choices) and let the default pipeline compare source vs follow-up
 * answers under `expect`. Relations that do not fit the answer pipeline
 * (referential-symmetry compares world traversal against store lookup;
 * temporal-narrowing runs a two-sided subset + narrow-equality check)
 * provide `check` instead and own their comparison.
 */
export interface MetamorphicRelation {
  readonly id: string
  readonly describe: string
  readonly expect: MrExpectation
  /** Evaluator for the source case; defaults to "path". */
  readonly sourceEvaluator?: MrEvaluator
  /** Evaluator for the follow-up; defaults to "path". Must stay "path" when the transform changes the world (the store holds the source world). */
  readonly followupEvaluator?: MrEvaluator
  /**
   * Restricts sampling to bindings the relation can transform (e.g. only
   * period-carrying bindings for temporal narrowing), so every fast-check run
   * exercises the relation instead of skipping. Omitted = all bindings.
   */
  readonly applicable?: (binding: CqBinding) => boolean
  /** Metamorphic transform; omitted = identity (used with differing evaluators). */
  readonly transform?: (source: MrCase, rng: Rng) => MrFollowup | null
  /** Fully custom check, bypassing the transform/compare pipeline. */
  readonly check?: (
    harness: MrHarness,
    binding: CqBinding,
    rng: Rng
  ) => Effect.Effect<MrOutcome, MetamorphicRunError | DbError, DuckDb>
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer canonicalization + expectation semantics
//
// MRs compare answer VALUES (kind + canonicalized value); citation resolution
// is Stage 1's job (the four-way verdict). Both answers go through Stage 1's
// own `canonicalizeAnswer`, and equality is Stage 1's `answerValuesEqual` —
// the sim engine must grade exactly as strictly as `computeVerdict` does, so
// a path that (say) stringifies a boolean or a scalar fails here just as it
// would be `divergent` in Stage 1. Sets compare order-insensitively by
// stable, type-tagged element keys, so a path that returns rows in a
// different order than the oracle is not penalized here.
// ─────────────────────────────────────────────────────────────────────────────

/** Recursive key-sorted serialization (a JSON.stringify replacer ARRAY would
 * filter nested keys down to the top-level key set — never use one here). */
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const rec = value as Record<string, unknown>
  return `{${Object.keys(rec)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`)
    .join(",")}}`
}

/** Type-tagged so `3500`, `"3500"`, `true` and `"true"` never collide. */
const stableKey = (el: unknown): string => {
  if (el === null || el === undefined) return "null"
  if (typeof el === "string") return `s:${el}`
  if (typeof el === "number") return `n:${String(el)}`
  if (typeof el === "boolean") return `b:${String(el)}`
  if (Array.isArray(el)) return `[${el.map(stableKey).join(",")}]`
  const rec = el as Record<string, unknown>
  if (typeof rec["id"] === "string") {
    // Citation-shaped / row-shaped elements identify by (entityType, id).
    const entityType = typeof rec["entityType"] === "string" ? rec["entityType"] : ""
    return `${entityType}:${rec["id"]}`
  }
  return stableStringify(rec)
}

const canonicalValue = (value: unknown): string =>
  Array.isArray(value) ? value.map(stableKey).sort().join("; ") : stableKey(value)

const canonicalAnswer = (answer: Answer): string =>
  `${String(answer.kind)}: ${canonicalValue(answer.value)}`

/** Normalize a set-ish value: arrays keep elements, null/undefined mean "empty set". */
const asSetKeys = (value: unknown): readonly string[] | null =>
  Array.isArray(value) ? value.map(stableKey) : value === null || value === undefined ? [] : null

/**
 * `subset` semantics per answer kind, so temporal narrowing also constrains
 * aggregates: sets by inclusion, non-negative numeric scalars monotonically
 * (a narrower period cannot pay out more), booleans by implication.
 * Equality is Stage 1's: `canonicalizeAnswer` + `answerValuesEqual`
 * (`Object.is` on scalars/booleans — no string coercion).
 */
const compareAnswers = (expect: MrExpectation, rawSource: Answer, rawFollowup: Answer): MrOutcome => {
  const source = canonicalizeAnswer(rawSource)
  const followup = canonicalizeAnswer(rawFollowup)
  switch (expect) {
    case "equal":
    case "unchanged-answer": {
      return answerValuesEqual(source, followup)
        ? mrHolds("answers agree")
        : mrFails(
            `answers differ — source {${canonicalAnswer(source)}} vs follow-up {${canonicalAnswer(followup)}}`
          )
    }
    case "subset": {
      const sv: unknown = source.value
      const fv: unknown = followup.value
      const sKeys = asSetKeys(sv)
      const fKeys = asSetKeys(fv)
      if (sKeys !== null && fKeys !== null) {
        const sSet = new Set(sKeys)
        const extra = fKeys.filter((k) => !sSet.has(k))
        return extra.length === 0
          ? mrHolds(`subset holds (${fKeys.length} of ${sKeys.length})`)
          : mrFails(`follow-up returned ${extra.length} element(s) missing from the source: ${extra.slice(0, 5).join(", ")}`)
      }
      if (typeof sv === "number" && typeof fv === "number") {
        return fv <= sv
          ? mrHolds(`monotone scalar holds (${fv} <= ${sv})`)
          : mrFails(`follow-up scalar ${fv} exceeds source scalar ${sv}`)
      }
      if (typeof sv === "boolean" && typeof fv === "boolean") {
        return !fv || sv
          ? mrHolds("boolean implication holds")
          : mrFails("follow-up answered true where the source answered false")
      }
      if (typeof sv === "string" && typeof fv === "string") {
        return sv === fv ? mrHolds("scalar unchanged") : mrFails(`scalar changed "${sv}" -> "${fv}"`)
      }
      return mrFails(
        `subset not comparable: source value ${canonicalValue(sv)} vs follow-up ${canonicalValue(fv)}`
      )
    }
  }
}

/** Names of a binding's Period-valued parameters, sorted for deterministic choice. */
const periodParamNames = (binding: CqBinding): readonly string[] =>
  Object.keys(binding.params)
    .filter((name) => {
      const value = binding.params[name]
      return value !== undefined && isPeriod(value)
    })
    .sort()

// ─────────────────────────────────────────────────────────────────────────────
// World helpers for irrelevant augmentation
// ─────────────────────────────────────────────────────────────────────────────

const AUGMENT_SUFFIX = "-aug"

/**
 * Rewrite every id (and every internal reference — the generator is
 * referentially consistent, so all refs point inside the same world) with a
 * suffix, making the augmentation world id-disjoint from the source world:
 * the merged world keeps `id` PRIMARY KEY valid and the new rows can never
 * collide with — or be referenced by — the rows the binding is about.
 */
const suffixWorldIds = (ontology: Ontology, world: InstanceWorld, suffix: string): InstanceWorld => {
  const out: Record<string, ReadonlyArray<Row>> = {}
  for (const [typeName, rows] of Object.entries(world)) {
    const refCols = (getEntityType(ontology, typeName)?.relations ?? []).map((r) =>
      relationRefColumn(r.name)
    )
    out[typeName] = rows.map((row) => {
      const next: Record<string, SqlValue> = { ...row }
      if (typeof next["id"] === "string") next["id"] = `${next["id"]}${suffix}`
      for (const col of refCols) {
        const v = next[col]
        if (typeof v === "string") next[col] = `${v}${suffix}`
      }
      return next
    })
  }
  return out
}

const mergeWorlds = (a: InstanceWorld, b: InstanceWorld): InstanceWorld => {
  const out: Record<string, ReadonlyArray<Row>> = {}
  for (const key of Object.keys(a)) out[key] = a[key] ?? []
  for (const key of Object.keys(b)) out[key] = [...(out[key] ?? []), ...(b[key] ?? [])]
  return out
}

const countRows = (world: InstanceWorld): number =>
  Object.values(world).reduce((n, rows) => n + rows.length, 0)

// ─────────────────────────────────────────────────────────────────────────────
// The four shipped relations
// ─────────────────────────────────────────────────────────────────────────────

/** MR 1 — answers about a patient are invariant under adding unrelated patients' data. */
export const irrelevantAugmentation: MetamorphicRelation = {
  id: "irrelevant-augmentation",
  describe:
    "adding freshly generated resources for OTHER patients (id-disjoint mini-cohort) must not change the answer",
  expect: "unchanged-answer",
  transform: (source, rng) => {
    const extra = generateWorld(source.ontology, {
      seed: rng.int(0, 0x7fffffff),
      patients: rng.int(1, 2)
    })
    const disjoint = suffixWorldIds(source.ontology, extra, AUGMENT_SUFFIX)
    return {
      world: mergeWorlds(source.world, disjoint),
      binding: source.binding,
      note: `augmented with ${countRows(disjoint)} unrelated rows`
    }
  }
}

/**
 * The short-window probe floor (days). Windows never bisect below this, so
 * closed date-interval semantics stay exact for datetime columns too (a
 * `YYYY-MM-DDThh:mm` value on the boundary day still lexicographically
 * compares inside any window whose end is a LATER date).
 */
const PROBE_MAX_SPAN_DAYS = 7

/**
 * MR 2 — narrowing a period can only shrink the result (oracle wide, path
 * narrow; see header). Three checks per case, because the subset check alone
 * is one-sided — an under-returning path (say, one that silently answers
 * empty for short spans, a month-bucketed-index failure mode) satisfies it
 * trivially:
 *
 *   (a) subset — the path's narrow answer lies inside the oracle's WIDE truth
 *       (catches over-returning: ignored/botched temporal filters);
 *   (b) equal  — the path's narrow answer equals the oracle's NARROW truth
 *       (catches under-returning on whatever window the rng drew; the
 *       transform keeps the world unchanged, so the loaded store answers the
 *       narrowed binding too);
 *   (c) probe  — random short windows are usually EMPTY on realistic data, so
 *       (b) alone catches short-span blindness only by luck. The probe makes
 *       it deterministic: bisect the wide period, at each step following the
 *       half the ORACLE says still contains supporting rows, down to a
 *       <= PROBE_MAX_SPAN_DAYS window that provably contains support — then
 *       demand the path match the oracle exactly there.
 */
export const temporalNarrowing: MetamorphicRelation = {
  id: "temporal-narrowing",
  describe:
    "shrinking the {period} of a temporal question can only shrink the result set (narrow path answer must lie inside the wide oracle answer and match the narrow oracle answer, including on a provably populated short window)",
  expect: "subset",
  applicable: (binding) => periodParamNames(binding).length > 0,
  check: (harness, binding, rng) =>
    Effect.gen(function* () {
      const names = periodParamNames(binding)
      const name = names.length === 0 ? undefined : names.length === 1 ? (names[0] as string) : rng.pick(names)
      const period = name === undefined ? undefined : binding.params[name]
      if (name === undefined || period === undefined || !isPeriod(period)) {
        return mrSkip("temporal-narrowing: not applicable to this binding")
      }
      const start = parseIsoDays(period.start)
      const end = parseIsoDays(period.end)
      if (start === null || end === null || end < start) {
        return mrSkip("temporal-narrowing: binding period is not a well-formed ISO interval")
      }

      // start <= start' <= end' <= end by construction; rng makes the
      // narrowing deterministic per case seed, so fast-check can replay and
      // shrink it.
      const newStart = start + rng.int(0, end - start)
      const newEnd = newStart + rng.int(0, end - newStart)
      const narrowed: Period = { start: formatIsoDate(newStart), end: formatIsoDate(newEnd) }
      const narrowedBinding = withParam(binding, name, narrowed)
      const note = `param "${name}" [${period.start}, ${period.end}] narrowed to [${narrowed.start}, ${narrowed.end}]`
      const withNote = (outcome: MrOutcome): MrOutcome => ({
        ...outcome,
        detail: `${note} — ${outcome.detail}`
      })

      // (a) subset against the wide ground truth
      const wideOracle = yield* evaluate(harness, "oracle", harness.world, binding, "source")
      const narrowPath = yield* evaluate(harness, "path", harness.world, narrowedBinding, "follow-up")
      const subset = compareAnswers("subset", wideOracle, narrowPath)
      if (!subset.holds) return withNote(subset)

      // (b) equality against the narrow ground truth
      const narrowOracle = yield* evaluate(harness, "oracle", harness.world, narrowedBinding, "follow-up")
      const equal = compareAnswers("equal", narrowOracle, narrowPath)
      if (!equal.holds) {
        return withNote(mrFails(`narrow path answer diverges from the narrow oracle ground truth: ${equal.detail}`))
      }

      // (c) populated-short-window probe. Invariant: [lo, hi] contains oracle
      // support. Splitting at mid into [lo, mid] / [mid, hi] loses nothing
      // (shared boundary; datetime values on day mid land in the right half),
      // so when the left half is empty the right half must still be populated.
      if (wideOracle.citations.length > 0) {
        let lo = start
        let hi = end
        while (hi - lo > PROBE_MAX_SPAN_DAYS) {
          const mid = lo + Math.floor((hi - lo) / 2)
          const leftBinding = withParam(binding, name, { start: formatIsoDate(lo), end: formatIsoDate(mid) })
          const left = yield* evaluate(harness, "oracle", harness.world, leftBinding, "probe")
          if (left.citations.length > 0) hi = mid
          else lo = mid
        }
        const probePeriod: Period = { start: formatIsoDate(lo), end: formatIsoDate(hi) }
        const probeBinding = withParam(binding, name, probePeriod)
        const probeOracle = yield* evaluate(harness, "oracle", harness.world, probeBinding, "probe")
        const probePath = yield* evaluate(harness, "path", harness.world, probeBinding, "probe")
        const probeEqual = compareAnswers("equal", probeOracle, probePath)
        if (!probeEqual.holds) {
          return withNote(
            mrFails(
              `short-window probe [${probePeriod.start}, ${probePeriod.end}] (${hi - lo}-day span, provably populated) diverges: ${probeEqual.detail}`
            )
          )
        }
      }

      return withNote(mrHolds(`${subset.detail}; narrow and short-window probe answers equal the oracle`))
    })
}

/** MR 3 — world traversal and store lookup of the same relation edge must agree. */
export const referentialSymmetry: MetamorphicRelation = {
  id: "referential-symmetry",
  describe:
    "forward traversal over the in-memory world (rows whose <rel>_ref hits a target) equals the reverse SQL lookup in the loaded store",
  expect: "equal",
  check: (harness, _binding, rng) =>
    Effect.gen(function* () {
      // Candidate edges are derived from the ontology at check time — nothing
      // FHIR-specific: any (source type, relation, populated target type).
      const candidates: Array<{
        readonly source: EntityType
        readonly relation: Relation
        readonly targetType: string
      }> = []
      for (const et of harness.ontology.entityTypes) {
        if ((harness.world[et.name] ?? []).length === 0) continue
        for (const relation of et.relations) {
          for (const targetType of relation.target) {
            if ((harness.world[targetType] ?? []).length > 0) {
              candidates.push({ source: et, relation, targetType })
            }
          }
        }
      }
      if (candidates.length === 0) return mrSkip("no populated relation edge to test")

      const edge = rng.pick(candidates)
      const target = rng.pick(harness.world[edge.targetType] ?? [])
      const targetId = target["id"]
      if (typeof targetId !== "string") return mrSkip("target row has no string id")

      const refCol = relationRefColumn(edge.relation.name)
      const multiTarget = edge.relation.target.length > 1
      const typeCol = relationRefTypeColumn(edge.relation.name)

      const worldSide = (harness.world[edge.source.name] ?? [])
        .filter((row) => row[refCol] === targetId && (!multiTarget || row[typeCol] === edge.targetType))
        .map((row) => String(row["id"]))
        .sort()

      const typeFilter = multiTarget ? ` AND ${quoteIdent(typeCol)} = ${sqlLiteral(edge.targetType)}` : ""
      const sql =
        `SELECT "id" FROM ${quoteIdent(tableName(edge.source.name))}` +
        ` WHERE ${quoteIdent(refCol)} = ${sqlLiteral(targetId)}${typeFilter} ORDER BY "id"`
      const db = yield* DuckDb
      const result = yield* db.query(sql)
      const storeSide = result.rows.map((row) => String(row[0] ?? "")).sort()

      const label = `${edge.source.name}.${edge.relation.name} -> ${edge.targetType}[${targetId}]`
      return worldSide.join(",") === storeSide.join(",")
        ? mrHolds(`${label}: both sides return {${worldSide.join(", ")}}`)
        : mrFails(`${label}: world traversal {${worldSide.join(", ")}} != store lookup {${storeSide.join(", ")}}`)
    })
}

/** MR 4 — the identity transform across evaluators: the dual oracle as a metamorphic relation. */
export const crossOracleEquality: MetamorphicRelation = {
  id: "cross-oracle-equality",
  describe: "for every binding, the AnswerPath under test and the SQL oracle produce the same answer value",
  expect: "equal",
  sourceEvaluator: "path",
  followupEvaluator: "oracle"
}

export const metamorphicRelations: readonly MetamorphicRelation[] = [
  irrelevantAugmentation,
  temporalNarrowing,
  referentialSymmetry,
  crossOracleEquality
]

/** Alias: the shipped relations are already ontology-generic; this is the set the FHIR product runs. */
export const fhirMetamorphicRelations: readonly MetamorphicRelation[] = metamorphicRelations

// ─────────────────────────────────────────────────────────────────────────────
// Relation execution
// ─────────────────────────────────────────────────────────────────────────────

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause !== null && typeof cause === "object" && "message" in cause) {
    return String((cause as { readonly message: unknown }).message)
  }
  return String(cause)
}

const wrapAnswer = <R>(
  effect: Effect.Effect<Answer, unknown, R>,
  label: string
): Effect.Effect<Answer, MetamorphicRunError, R> =>
  Effect.catchAll(effect, (cause) =>
    Effect.fail(
      new MetamorphicRunError({ message: `${label} evaluation failed: ${describeCause(cause)}`, cause })
    )
  )

const evaluate = (
  harness: MrHarness,
  evaluator: MrEvaluator,
  world: InstanceWorld,
  binding: CqBinding,
  label: string
): Effect.Effect<Answer, MetamorphicRunError, DuckDb> => {
  if (evaluator === "oracle") {
    if (world !== harness.world) {
      return Effect.fail(
        new MetamorphicRunError({
          message:
            "relation misconfiguration: the SQL oracle answers over the loaded source world, " +
            `but the ${label} case transformed the world — world-transforming follow-ups must use the "path" evaluator`
        })
      )
    }
    return wrapAnswer(harness.oracle.answer(binding), `${label} (oracle)`)
  }
  const path = world === harness.world ? harness.path : harness.makePath(world)
  return wrapAnswer(path.answer(binding), `${label} (path "${path.name}")`)
}

const defaultCheck = (
  relation: MetamorphicRelation,
  harness: MrHarness,
  binding: CqBinding,
  rng: Rng
): Effect.Effect<MrOutcome, MetamorphicRunError | DbError, DuckDb> =>
  Effect.gen(function* () {
    const source: MrCase = { ontology: harness.ontology, world: harness.world, binding }
    const followup: MrFollowup | null =
      relation.transform === undefined
        ? { world: harness.world, binding }
        : relation.transform(source, rng)
    if (followup === null) return mrSkip(`${relation.id}: not applicable to this binding`)

    const sourceAnswer = yield* evaluate(
      harness,
      relation.sourceEvaluator ?? "path",
      harness.world,
      binding,
      "source"
    )
    const followupAnswer = yield* evaluate(
      harness,
      relation.followupEvaluator ?? "path",
      followup.world,
      followup.binding,
      "follow-up"
    )
    const outcome = compareAnswers(relation.expect, sourceAnswer, followupAnswer)
    return followup.note === undefined ? outcome : { ...outcome, detail: `${followup.note} — ${outcome.detail}` }
  })

const checkRelation = (
  relation: MetamorphicRelation,
  harness: MrHarness,
  binding: CqBinding,
  rng: Rng
): Effect.Effect<MrOutcome, MetamorphicRunError | DbError, DuckDb> =>
  relation.check !== undefined
    ? relation.check(harness, binding, rng)
    : defaultCheck(relation, harness, binding, rng)

// ─────────────────────────────────────────────────────────────────────────────
// fast-check runner
// ─────────────────────────────────────────────────────────────────────────────

/** The value fast-check generates AND shrinks: which binding, and the per-case seed. */
interface MrCaseSelector {
  readonly bindingIndex: number
  readonly caseSeed: number
}

export interface MrCounterexample {
  readonly bindingIndex: number
  readonly caseSeed: number
  readonly detail: string
}

export interface MetamorphicRelationResult {
  readonly relationId: string
  readonly describe: string
  readonly expect: MrExpectation
  readonly passed: boolean
  /** Executed property runs (on failure: runs up to and including the failing one). */
  readonly runs: number
  /** Cases where the transform turned out inapplicable (includes shrink re-executions). */
  readonly skipped: number
  /** How many of the sampled bindings the relation applies to (0 = vacuous pass). */
  readonly applicableBindings: number
  /** Shrunk counterexample when the relation is violated. */
  readonly counterexample: MrCounterexample | null
}

export interface MetamorphicReport {
  readonly seed: number
  readonly runsPerRelation: number
  readonly bindingCount: number
  readonly passed: boolean
  readonly results: readonly MetamorphicRelationResult[]
}

export interface MetamorphicRunOptions {
  readonly ontology: Ontology
  /** The clean source world (loaded into the store by the runner). */
  readonly world: InstanceWorld
  /** Bindings sampled from the world (cq/engine.bindTemplates output). */
  readonly bindings: readonly CqBinding[]
  /** Builds the AnswerPath under test over a given world, e.g. `(w) => makeGraphPath(w, ontology)`. */
  readonly makePath: (world: InstanceWorld) => AnswerPath
  /** Ground-truth SQL oracle (the shipped SqlOracle, or a substitute for fixture worlds). */
  readonly oracle: Oracle
  readonly seed: number
  readonly relations?: readonly MetamorphicRelation[]
  /** fast-check numRuns per relation; defaults to 50 (`memory-sql sim --mrs N`). */
  readonly runsPerRelation?: number
}

const toRelationResult = (
  relation: MetamorphicRelation,
  details: fc.RunDetails<[MrCaseSelector]>,
  skipped: number,
  applicableBindings: number
): MetamorphicRelationResult => {
  const base = {
    relationId: relation.id,
    describe: relation.describe,
    expect: relation.expect,
    runs: details.numRuns,
    skipped,
    applicableBindings
  }
  if (!details.failed) {
    return { ...base, passed: true, counterexample: null }
  }
  const shrunk = details.counterexample?.[0]
  const detail =
    details.errorInstance instanceof Error
      ? details.errorInstance.message
      : String(details.errorInstance ?? "metamorphic property failed")
  return {
    ...base,
    passed: false,
    counterexample:
      shrunk === undefined
        ? null
        : { bindingIndex: shrunk.bindingIndex, caseSeed: shrunk.caseSeed, detail }
  }
}

/**
 * Run every relation as a seeded fast-check property over sampled bindings.
 * Loads the source world (full ontology DDL, so negative-control queries see
 * empty tables), then executes relations sequentially — the DuckDb service is
 * a single connection and must not be raced across fibers.
 */
export const runMetamorphic = (
  opts: MetamorphicRunOptions
): Effect.Effect<MetamorphicReport, MetamorphicRunError | DbError, DuckDb> =>
  Effect.gen(function* () {
    const relations = opts.relations ?? metamorphicRelations
    const numRuns = opts.runsPerRelation ?? 50
    if (opts.bindings.length === 0) {
      return yield* new MetamorphicRunError({
        message: "runMetamorphic needs at least one sampled binding (bindTemplates over the world first)"
      })
    }

    yield* loadWorld(opts.world, opts.ontology)
    const db = yield* DuckDb
    const harness: MrHarness = {
      ontology: opts.ontology,
      world: opts.world,
      path: opts.makePath(opts.world),
      makePath: opts.makePath,
      oracle: opts.oracle
    }

    const results: MetamorphicRelationResult[] = []
    for (const relation of relations) {
      // Sample only bindings the relation applies to, so runs are never
      // wasted on foregone skips (temporal narrowing only makes sense for
      // period-carrying bindings). No applicable binding = vacuous pass.
      const applicableIndices = opts.bindings
        .map((binding, index) =>
          relation.applicable === undefined || relation.applicable(binding) ? index : -1
        )
        .filter((index) => index >= 0)
      if (applicableIndices.length === 0) {
        results.push({
          relationId: relation.id,
          describe: relation.describe,
          expect: relation.expect,
          passed: true,
          runs: 0,
          skipped: 0,
          applicableBindings: 0,
          counterexample: null
        })
        continue
      }
      let skipped = 0
      const selector = fc.record({
        bindingIndex: fc.constantFrom(...applicableIndices),
        caseSeed: fc.integer({ min: 0, max: 0x7fffffff })
      })
      const property = fc.asyncProperty(selector, async ({ bindingIndex, caseSeed }) => {
        const binding = opts.bindings[bindingIndex]
        if (binding === undefined) return
        // The property body re-enters Effect with the captured DuckDb service;
        // fast-check awaits each case, so store access stays sequential.
        const outcome = await Effect.runPromise(
          Effect.provideService(checkRelation(relation, harness, binding, makeRng(caseSeed)), DuckDb, db)
        )
        if (outcome.skipped) {
          skipped += 1
          return
        }
        if (!outcome.holds) {
          throw new Error(`[${relation.id}] ${outcome.detail}`)
        }
      })
      // Seeded => the whole run (including shrinking) is reproducible.
      const details = yield* Effect.promise(() => fc.check(property, { seed: opts.seed, numRuns }))
      results.push(toRelationResult(relation, details, skipped, applicableIndices.length))
    }

    return {
      seed: opts.seed,
      runsPerRelation: numRuns,
      bindingCount: opts.bindings.length,
      passed: results.every((r) => r.passed),
      results
    }
  })

export const formatMetamorphicReport = (report: MetamorphicReport): string => {
  const lines: string[] = [
    `Metamorphic run: seed ${report.seed}, ${report.runsPerRelation} runs/relation over ${report.bindingCount} bindings`
  ]
  for (const result of report.results) {
    if (result.passed && result.applicableBindings === 0) {
      lines.push(`  PASS ${result.relationId} (vacuous: no applicable bindings)`)
    } else if (result.passed) {
      lines.push(
        `  PASS ${result.relationId} (${result.runs} runs over ${result.applicableBindings} applicable bindings, ${result.skipped} skipped)`
      )
    } else {
      lines.push(`  FAIL ${result.relationId} (failed after ${result.runs} runs)`)
      if (result.counterexample !== null) {
        lines.push(
          `       shrunk counterexample: binding #${result.counterexample.bindingIndex}, case seed ${result.counterexample.caseSeed}`
        )
        lines.push(`       ${result.counterexample.detail}`)
      }
    }
  }
  lines.push(
    report.passed
      ? "All metamorphic relations hold."
      : "Metamorphic relations VIOLATED — the answer layer disagrees with the structure of the ontology."
  )
  return lines.join("\n")
}
