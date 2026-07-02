/**
 * Stage 2a — metamorphic relations (the stress engine lives in sim-stress.ts;
 * its public surface is re-exported below, so `memory-sql` stays one flat
 * entry). A metamorphic relation states how an answer MUST change (or not)
 * under a known transformation of the world or question — checkable with zero
 * gold labels. Answers are compared through Stage 1's OWN canonicalization
 * (cq.ts canonicalizeAnswer + answerValuesEqual), so the sim grades exactly
 * as strictly as computeVerdict. The seeded runner (no fast-check) reports
 * the FIRST failing case (binding index + case seed, replayable) — no
 * shrinking, the documented v2 trade-off.
 */
import { answerValuesEqual, canonicalValue, canonicalizeAnswer, isPeriod, makeGraphPath, stableKey, withParam } from "./cq.js"
import type { Answer, AnswerPath, CqBinding, Period } from "./cq.js"
import { makeSqlOracle } from "./oracle.js"
import type { Oracle } from "./oracle.js"
import { MemorySqlError, getEntityType } from "./ontology.js"
import type { EntityType, Ontology, Relation } from "./ontology.js"
import { formatIsoDate, makeRng, parseIsoDays } from "./rng.js"
import type { Rng } from "./rng.js"
import { describeCause, fnv1a } from "./sim-stress.js"
import { loadWorld, quoteIdent, relationRefColumn, relationRefTypeColumn, sqlLiteral, tableName } from "./store.js"
import type { InstanceWorld, Row, SqlValue, Store } from "./store.js"
import { generateWorld } from "./synth.js"

export {
  duplicateIdMutator, fhirInvariants, fhirStressMutators, formatStressReport, replay, runStress
} from "./sim-stress.js"
export type {
  Invariant, InvariantViolation, MutationResult, ReplayResult, SqlInvariant, StressMutator, StressMutatorRun,
  StressReport, StressRunOptions, WorldInvariant
} from "./sim-stress.js"

// ── Metamorphic model ────────────────────────────────────────────────────────

/** Who answers a case: the AnswerPath under test or the deterministic SQL oracle. */
export type MrEvaluator = "path" | "oracle"

export type MrExpectation = "equal" | "subset" | "unchanged-answer"

/** The source case an MR transforms. */
export interface MrCase { readonly ontology: Ontology; readonly world: InstanceWorld; readonly binding: CqBinding }

/** The transformed follow-up case; `null` from a transform means "not applicable". */
export interface MrFollowup { readonly world: InstanceWorld; readonly binding: CqBinding; readonly note?: string }

/** Everything a relation needs: the loaded source world, the AnswerPath under test,
 * `makePath` to rebuild the path over a transformed world, the oracle, the store. */
export interface MrHarness {
  readonly ontology: Ontology
  readonly world: InstanceWorld
  readonly path: AnswerPath
  readonly makePath: (world: InstanceWorld) => AnswerPath
  readonly oracle: Oracle
  readonly store: Store
}

export interface MrOutcome { readonly holds: boolean; readonly skipped: boolean; readonly detail: string }

const mrHolds = (detail: string): MrOutcome => ({ holds: true, skipped: false, detail })
const mrFails = (detail: string): MrOutcome => ({ holds: false, skipped: false, detail })
const mrSkip = (detail: string): MrOutcome => ({ holds: true, skipped: true, detail })

/**
 * A metamorphic relation. Declarative relations provide `transform` and let the
 * default pipeline compare source vs follow-up under `expect` (`followupEvaluator`
 * must stay "path" when the transform changes the world — the store holds the
 * source world); relations that do not fit provide `check` and own their
 * comparison. `applicable` restricts sampling to bindings the relation can use.
 */
export interface MetamorphicRelation {
  readonly id: string
  readonly describe: string
  readonly expect: MrExpectation
  readonly sourceEvaluator?: MrEvaluator
  readonly followupEvaluator?: MrEvaluator
  readonly applicable?: (binding: CqBinding) => boolean
  readonly transform?: (source: MrCase, rng: Rng) => MrFollowup | null
  readonly check?: (harness: MrHarness, binding: CqBinding, rng: Rng) => Promise<MrOutcome>
}

/** Normalize a set-ish value: arrays keep elements, null/undefined mean "empty set". */
const asSetKeys = (value: unknown): readonly string[] | null =>
  Array.isArray(value) ? value.map(stableKey) : value === null || value === undefined ? [] : null

const canonicalAnswer = (answer: Answer): string => `${String(answer.kind)}: ${canonicalValue(answer.value)}`

/** `subset` semantics per answer kind, so temporal narrowing also constrains
 * aggregates: sets by inclusion, numeric scalars monotonically (a narrower period
 * cannot pay out more), booleans by implication. Equality is Stage 1's. */
const compareAnswers = (expect: MrExpectation, rawSource: Answer, rawFollowup: Answer): MrOutcome => {
  const source = canonicalizeAnswer(rawSource)
  const followup = canonicalizeAnswer(rawFollowup)
  switch (expect) {
    case "equal":
    case "unchanged-answer": {
      return answerValuesEqual(source, followup)
        ? mrHolds("answers agree")
        : mrFails(`answers differ — source {${canonicalAnswer(source)}} vs follow-up {${canonicalAnswer(followup)}}`)
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
        return fv <= sv ? mrHolds(`monotone scalar holds (${fv} <= ${sv})`) : mrFails(`follow-up scalar ${fv} exceeds source scalar ${sv}`)
      }
      if (typeof sv === "boolean" && typeof fv === "boolean") {
        return !fv || sv ? mrHolds("boolean implication holds") : mrFails("follow-up answered true where the source answered false")
      }
      if (typeof sv === "string" && typeof fv === "string") {
        return sv === fv ? mrHolds("scalar unchanged") : mrFails(`scalar changed "${sv}" -> "${fv}"`)
      }
      return mrFails(`subset not comparable: source value ${canonicalValue(sv)} vs follow-up ${canonicalValue(fv)}`)
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

// ── World helpers for irrelevant augmentation ────────────────────────────────

const AUGMENT_SUFFIX = "-aug"

/** Rewrite every id (and every internal reference — the generator is referentially
 * consistent) with a suffix: the augmentation world is id-disjoint from the source,
 * so `id` PRIMARY KEY stays valid and new rows can never touch the binding's rows. */
const suffixWorldIds = (ontology: Ontology, world: InstanceWorld, suffix: string): InstanceWorld => {
  const out: Record<string, ReadonlyArray<Row>> = {}
  for (const [typeName, rows] of Object.entries(world)) {
    const refCols = (getEntityType(ontology, typeName)?.relations ?? []).map((r) => relationRefColumn(r.name))
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

const countRows = (world: InstanceWorld): number => Object.values(world).reduce((n, rows) => n + rows.length, 0)

// ── The four shipped relations ───────────────────────────────────────────────

/** MR 1 — answers about a patient are invariant under adding unrelated patients' data. */
const irrelevantAugmentation: MetamorphicRelation = {
  id: "irrelevant-augmentation",
  describe: "adding freshly generated resources for OTHER patients (id-disjoint mini-cohort) must not change the answer",
  expect: "unchanged-answer",
  transform: (source, rng) => {
    const extra = generateWorld(source.ontology, { seed: rng.int(0, 0x7fffffff), patients: rng.int(1, 2) })
    const disjoint = suffixWorldIds(source.ontology, extra, AUGMENT_SUFFIX)
    return { world: mergeWorlds(source.world, disjoint), binding: source.binding, note: `augmented with ${countRows(disjoint)} unrelated rows` }
  }
}

/** The short-window probe floor (days). Windows never bisect below this, so closed
 * date-interval semantics stay exact for datetime columns too (a `YYYY-MM-DDThh:mm`
 * value on the boundary day still compares inside any window ending a LATER date). */
const PROBE_MAX_SPAN_DAYS = 7

/**
 * MR 2 — narrowing a period can only shrink the result. Three checks per case,
 * because subset alone is one-sided (an under-returning path passes trivially):
 * (a) subset — narrow path answer inside the oracle's WIDE truth (catches
 * over-returning: ignored/botched temporal filters); (b) equal — narrow path
 * answer equals the oracle's NARROW truth (catches under-returning on the drawn
 * window); (c) probe — random short windows are usually EMPTY, so (b) catches
 * short-span blindness only by luck: bisect the wide period following the half
 * the ORACLE says still contains support, down to a <= PROBE_MAX_SPAN_DAYS
 * window that provably contains support, and demand exact match there.
 */
export const temporalNarrowing: MetamorphicRelation = {
  id: "temporal-narrowing",
  describe:
    "shrinking the {period} of a temporal question can only shrink the result set (narrow path answer must lie inside the wide oracle answer and match the narrow oracle answer, including on a provably populated short window)",
  expect: "subset",
  applicable: (binding) => periodParamNames(binding).length > 0,
  check: async (harness, binding, rng) => {
    const names = periodParamNames(binding)
    const name = names.length === 0 ? undefined : names.length === 1 ? (names[0] as string) : rng.pick(names)
    const period = name === undefined ? undefined : binding.params[name]
    if (name === undefined || period === undefined || !isPeriod(period)) return mrSkip("temporal-narrowing: not applicable to this binding")
    const start = parseIsoDays(period.start)
    const end = parseIsoDays(period.end)
    if (start === null || end === null || end < start) return mrSkip("temporal-narrowing: binding period is not a well-formed ISO interval")

    // start <= start' <= end' <= end by construction; the rng makes the
    // narrowing deterministic per case seed, so a failure replays exactly.
    const newStart = start + rng.int(0, end - start)
    const newEnd = newStart + rng.int(0, end - newStart)
    const narrowed: Period = { start: formatIsoDate(newStart), end: formatIsoDate(newEnd) }
    const narrowedBinding = withParam(binding, name, narrowed)
    const note = `param "${name}" [${period.start}, ${period.end}] narrowed to [${narrowed.start}, ${narrowed.end}]`
    const withNote = (outcome: MrOutcome): MrOutcome => ({ ...outcome, detail: `${note} — ${outcome.detail}` })

    // (a) subset against the wide ground truth
    const wideOracle = await evaluate(harness, "oracle", harness.world, binding, "source")
    const narrowPath = await evaluate(harness, "path", harness.world, narrowedBinding, "follow-up")
    const subset = compareAnswers("subset", wideOracle, narrowPath)
    if (!subset.holds) return withNote(subset)

    // (b) equality against the narrow ground truth
    const narrowOracle = await evaluate(harness, "oracle", harness.world, narrowedBinding, "follow-up")
    const equal = compareAnswers("equal", narrowOracle, narrowPath)
    if (!equal.holds) return withNote(mrFails(`narrow path answer diverges from the narrow oracle ground truth: ${equal.detail}`))

    // (c) populated-short-window probe. Invariant: [lo, hi] contains oracle
    // support; splitting at mid loses nothing (shared boundary), so an empty
    // left half implies a populated right half.
    if (wideOracle.citations.length > 0) {
      let lo = start
      let hi = end
      while (hi - lo > PROBE_MAX_SPAN_DAYS) {
        const mid = lo + Math.floor((hi - lo) / 2)
        const left = await evaluate(harness, "oracle", harness.world, withParam(binding, name, { start: formatIsoDate(lo), end: formatIsoDate(mid) }), "probe")
        if (left.citations.length > 0) hi = mid
        else lo = mid
      }
      const probePeriod: Period = { start: formatIsoDate(lo), end: formatIsoDate(hi) }
      const probeBinding = withParam(binding, name, probePeriod)
      const probeOracle = await evaluate(harness, "oracle", harness.world, probeBinding, "probe")
      const probePath = await evaluate(harness, "path", harness.world, probeBinding, "probe")
      const probeEqual = compareAnswers("equal", probeOracle, probePath)
      if (!probeEqual.holds) {
        return withNote(
          mrFails(`short-window probe [${probePeriod.start}, ${probePeriod.end}] (${hi - lo}-day span, provably populated) diverges: ${probeEqual.detail}`)
        )
      }
    }

    return withNote(mrHolds(`${subset.detail}; narrow and short-window probe answers equal the oracle`))
  }
}

/** MR 3 — world traversal and store lookup of the same relation edge must agree.
 * Candidate edges derive from the ontology at check time — nothing FHIR-specific. */
const referentialSymmetry: MetamorphicRelation = {
  id: "referential-symmetry",
  describe: "forward traversal over the in-memory world (rows whose <rel>_ref hits a target) equals the reverse SQL lookup in the loaded store",
  expect: "equal",
  check: async (harness, _binding, rng) => {
    const candidates: Array<{ readonly source: EntityType; readonly relation: Relation; readonly targetType: string }> = []
    for (const et of harness.ontology.entityTypes) {
      if ((harness.world[et.name] ?? []).length === 0) continue
      for (const relation of et.relations) {
        for (const targetType of relation.target) {
          if ((harness.world[targetType] ?? []).length > 0) candidates.push({ source: et, relation, targetType })
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
    const sql = `SELECT "id" FROM ${quoteIdent(tableName(edge.source.name))} WHERE ${quoteIdent(refCol)} = ${sqlLiteral(targetId)}${typeFilter} ORDER BY "id"`
    const storeSide = (await harness.store.query(sql)).rows.map((row) => String(row[0] ?? "")).sort()

    const label = `${edge.source.name}.${edge.relation.name} -> ${edge.targetType}[${targetId}]`
    return worldSide.join(",") === storeSide.join(",")
      ? mrHolds(`${label}: both sides return {${worldSide.join(", ")}}`)
      : mrFails(`${label}: world traversal {${worldSide.join(", ")}} != store lookup {${storeSide.join(", ")}}`)
  }
}

/** MR 4 — the identity transform across evaluators: the dual oracle as a metamorphic relation. */
const crossOracleEquality: MetamorphicRelation = {
  id: "cross-oracle-equality",
  describe: "for every binding, the AnswerPath under test and the SQL oracle produce the same answer value",
  expect: "equal",
  sourceEvaluator: "path",
  followupEvaluator: "oracle"
}

/** The shipped relations — ontology-generic; this is the set the FHIR product runs. */
export const metamorphicRelations: readonly MetamorphicRelation[] = [
  irrelevantAugmentation, temporalNarrowing, referentialSymmetry, crossOracleEquality
]

// ── Relation execution + seeded runner (first failing case, no shrinking) ───

const evaluate = async (harness: MrHarness, evaluator: MrEvaluator, world: InstanceWorld, binding: CqBinding, label: string): Promise<Answer> => {
  if (evaluator === "oracle" && world !== harness.world) {
    throw new MemorySqlError(
      "sim",
      "relation misconfiguration: the SQL oracle answers over the loaded source world, " +
        `but the ${label} case transformed the world — world-transforming follow-ups must use the "path" evaluator`
    )
  }
  const path = world === harness.world ? harness.path : harness.makePath(world)
  const who = evaluator === "oracle" ? "oracle" : `path "${path.name}"`
  try {
    return evaluator === "oracle" ? await harness.oracle.answer(binding) : await path.answer(binding)
  } catch (cause) {
    throw new MemorySqlError("sim", `${label} (${who}) evaluation failed: ${describeCause(cause)}`, cause)
  }
}

const checkRelation = async (relation: MetamorphicRelation, harness: MrHarness, binding: CqBinding, rng: Rng): Promise<MrOutcome> => {
  if (relation.check !== undefined) return relation.check(harness, binding, rng)
  const source: MrCase = { ontology: harness.ontology, world: harness.world, binding }
  const followup = relation.transform === undefined ? { world: harness.world, binding } : relation.transform(source, rng)
  if (followup === null) return mrSkip(`${relation.id}: not applicable to this binding`)
  const sourceAnswer = await evaluate(harness, relation.sourceEvaluator ?? "path", harness.world, binding, "source")
  const followupAnswer = await evaluate(harness, relation.followupEvaluator ?? "path", followup.world, followup.binding, "follow-up")
  const outcome = compareAnswers(relation.expect, sourceAnswer, followupAnswer)
  return followup.note === undefined ? outcome : { ...outcome, detail: `${followup.note} — ${outcome.detail}` }
}

/** The first failing case of a violated relation — replayable from (bindingIndex, caseSeed). */
export interface MrCounterexample { readonly bindingIndex: number; readonly caseSeed: number; readonly detail: string }

/** `runs` = executed runs (on failure: up to and including the failing one);
 * `skipped` = transform turned out inapplicable at check time; `applicableBindings`
 * 0 = vacuous pass; `counterexample` = first failing case (no shrinking in v2). */
export interface MetamorphicRelationResult {
  readonly relationId: string
  readonly describe: string
  readonly expect: MrExpectation
  readonly passed: boolean
  readonly runs: number
  readonly skipped: number
  readonly applicableBindings: number
  readonly counterexample: MrCounterexample | null
}

export interface MetamorphicReport {
  readonly seed: number
  readonly runsPerRelation: number
  readonly bindingCount: number
  readonly passed: boolean
  readonly results: readonly MetamorphicRelationResult[]
}

/** `bindings` come from cq.ts bindTemplates; `makePath` builds the AnswerPath under
 * test over a given world (defaults to the reference GraphPath); `oracle` defaults
 * to the SQL oracle over the store; `runsPerRelation` defaults to 50 (`--mrs N`). */
export interface MetamorphicRunOptions {
  readonly ontology: Ontology
  readonly bindings: readonly CqBinding[]
  readonly seed: number
  readonly makePath?: (world: InstanceWorld) => AnswerPath
  readonly oracle?: Oracle
  readonly relations?: readonly MetamorphicRelation[]
  readonly runsPerRelation?: number
}

/**
 * Run every relation as a seeded property over the sampled bindings. Loads the
 * source world (full ontology DDL, so negative-control queries see empty
 * tables), then executes relations sequentially — single connection, never
 * raced. Sampling only draws bindings a relation applies to; no applicable
 * binding = explicit vacuous pass.
 */
export const runMetamorphic = async (store: Store, world: InstanceWorld, opts: MetamorphicRunOptions): Promise<MetamorphicReport> => {
  const relations = opts.relations ?? metamorphicRelations
  const numRuns = opts.runsPerRelation ?? 50
  if (opts.bindings.length === 0) {
    throw new MemorySqlError("sim", "runMetamorphic needs at least one sampled binding (bindTemplates over the world first)")
  }

  await loadWorld(store, opts.ontology, world)
  const makePath = opts.makePath ?? ((w: InstanceWorld) => makeGraphPath(w, opts.ontology))
  const harness: MrHarness = { ontology: opts.ontology, world, path: makePath(world), makePath, oracle: opts.oracle ?? makeSqlOracle(store), store }

  const results: MetamorphicRelationResult[] = []
  for (const relation of relations) {
    const applicableIndices = opts.bindings
      .map((binding, index) => (relation.applicable === undefined || relation.applicable(binding) ? index : -1))
      .filter((index) => index >= 0)
    const base = { relationId: relation.id, describe: relation.describe, expect: relation.expect }
    if (applicableIndices.length === 0) {
      results.push({ ...base, passed: true, runs: 0, skipped: 0, applicableBindings: 0, counterexample: null })
      continue
    }
    // Per-relation seed stream (order-independent); each case gets its own
    // replayable caseSeed, mirroring the stress engine's per-mutator streams.
    const rng = makeRng((opts.seed ^ fnv1a(relation.id)) >>> 0)
    let skipped = 0
    let runs = 0
    let counterexample: MrCounterexample | null = null
    for (let i = 0; i < numRuns; i++) {
      const bindingIndex = rng.pick(applicableIndices)
      const caseSeed = rng.int(0, 0x7fffffff)
      const binding = opts.bindings[bindingIndex]
      if (binding === undefined) continue
      runs += 1
      const outcome = await checkRelation(relation, harness, binding, makeRng(caseSeed))
      if (outcome.skipped) {
        skipped += 1
        continue
      }
      if (!outcome.holds) {
        counterexample = { bindingIndex, caseSeed, detail: `[${relation.id}] ${outcome.detail}` }
        break
      }
    }
    results.push({ ...base, passed: counterexample === null, runs, skipped, applicableBindings: applicableIndices.length, counterexample })
  }

  return { seed: opts.seed, runsPerRelation: numRuns, bindingCount: opts.bindings.length, passed: results.every((r) => r.passed), results }
}

export const formatMetamorphicReport = (report: MetamorphicReport): string => {
  const lines: string[] = [`Metamorphic run: seed ${report.seed}, ${report.runsPerRelation} runs/relation over ${report.bindingCount} bindings`]
  for (const result of report.results) {
    if (result.passed && result.applicableBindings === 0) {
      lines.push(`  PASS ${result.relationId} (vacuous: no applicable bindings)`)
    } else if (result.passed) {
      lines.push(`  PASS ${result.relationId} (${result.runs} runs over ${result.applicableBindings} applicable bindings, ${result.skipped} skipped)`)
    } else {
      lines.push(`  FAIL ${result.relationId} (failed after ${result.runs} runs)`)
      if (result.counterexample !== null) {
        lines.push(`       first failing case: binding #${result.counterexample.bindingIndex}, case seed ${result.counterexample.caseSeed}`)
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
