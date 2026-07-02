/**
 * SPEC testing contract #6 — metamorphic.
 *
 * Why this validates the answer layer with zero gold labels: a metamorphic
 * relation only states how two answers must RELATE under a known transform,
 * so it can interrogate any AnswerPath without ever knowing a right answer.
 * We assert (a) the four shipped relations hold on the correct stack
 * (GraphPath + SqlOracle over a clean world), deterministically per seed, and
 * (b) the engine has teeth: a planted traversal bug — a GraphPath variant
 * that ignores period filters — is caught by `temporal-narrowing` with a
 * shrunk fast-check counterexample. The buggy path answers the narrowed
 * follow-up with rows from ALL time, which cannot stay inside the oracle's
 * wide-period ground truth, so the subset expectation must fail.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  SqlOracle,
  bindTemplates,
  duckDbLayer,
  fhirCqTemplates,
  generateWorld,
  isPeriod,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  metamorphicRelations,
  runMetamorphic,
  temporalNarrowing,
  withParam
} from "memory-sql"
import type {
  AnswerPath,
  CqBinding,
  DuckDb,
  InstanceWorld,
  MetamorphicReport,
  Ontology
} from "memory-sql"

const ontology: Ontology = await Effect.runPromise(loadFhirOntology())
const world = generateWorld(ontology, { seed: 42, patients: 8 })

// Round-robin: two bindings per shipped template, from real world rows.
const bindings = bindTemplates(fhirCqTemplates, world, makeRng(11), fhirCqTemplates.length * 2)

// The relation under attack samples uniformly over the bindings it is given,
// so the planted-bug run feeds it period-parameterized bindings only.
const temporalBindings = bindings.filter((b) => b.template.params.some((p) => p.kind === "period"))

const correctPath = (w: InstanceWorld): AnswerPath => makeGraphPath(w, ontology)

/**
 * The planted traversal bug: a GraphPath variant that ignores every period
 * filter by silently widening any {period} parameter to all of time before
 * delegating to the real typed traversal.
 */
const periodIgnoringPath = (w: InstanceWorld): AnswerPath => {
  const inner = makeGraphPath(w, ontology)
  return {
    name: "graph-path-ignoring-period-filters",
    answer: (binding) => {
      let widened: CqBinding = binding
      for (const [name, value] of Object.entries(binding.params)) {
        if (isPeriod(value)) {
          widened = withParam(widened, name, { start: "1900-01-01", end: "2999-12-31" })
        }
      }
      return inner.answer(widened)
    }
  }
}

const withDb = <A, E>(effect: Effect.Effect<A, E, DuckDb>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, duckDbLayer()))

describe("metamorphic: shipped relations", () => {
  it("ships exactly the four SPEC relations", () => {
    expect(metamorphicRelations.map((r) => r.id).sort()).toEqual([
      "cross-oracle-equality",
      "irrelevant-augmentation",
      "referential-symmetry",
      "temporal-narrowing"
    ])
  })

  it("all four hold on the correct stack (GraphPath + SqlOracle, clean world)", async () => {
    const report: MetamorphicReport = await withDb(
      runMetamorphic({
        ontology,
        world,
        bindings,
        makePath: correctPath,
        oracle: SqlOracle,
        seed: 2026,
        runsPerRelation: 40
      })
    )
    expect(report.results).toHaveLength(4)
    const failures = report.results
      .filter((r) => !r.passed)
      .map((r) => `${r.relationId}: ${r.counterexample?.detail ?? "no counterexample detail"}`)
    expect(failures).toEqual([])
    expect(report.passed).toBe(true)
    for (const result of report.results) {
      expect(result.counterexample, result.relationId).toBeNull()
    }
  })

  it("is deterministic: same seed, same world, same report", async () => {
    const opts = {
      ontology,
      world,
      bindings,
      makePath: correctPath,
      oracle: SqlOracle,
      seed: 7,
      runsPerRelation: 15
    }
    const a = await withDb(runMetamorphic(opts))
    const b = await withDb(runMetamorphic(opts))
    expect(a).toEqual(b)
  })
})

describe("metamorphic: temporal-narrowing has teeth", () => {
  it("exercises real narrowings on period-parameterized bindings (not vacuous)", async () => {
    expect(temporalBindings.length).toBeGreaterThan(0)
    const report = await withDb(
      runMetamorphic({
        ontology,
        world,
        bindings: temporalBindings,
        makePath: correctPath,
        oracle: SqlOracle,
        seed: 2026,
        relations: [temporalNarrowing],
        runsPerRelation: 60
      })
    )
    const result = report.results[0]
    expect(result?.relationId).toBe("temporal-narrowing")
    expect(result?.passed).toBe(true)
    // Tripwire: every binding here HAS a {period} parameter, so the relation
    // must actually transform cases — an all-skipped run would mean the
    // narrowing never engages and could never catch a temporal bug.
    expect(result?.skipped ?? 0).toBeLessThan(result?.runs ?? 0)
  })

  it("catches the planted period-ignoring traversal bug with a shrunk counterexample", async () => {
    const report = await withDb(
      runMetamorphic({
        ontology,
        world,
        bindings: temporalBindings,
        makePath: periodIgnoringPath,
        oracle: SqlOracle,
        seed: 2026,
        relations: [temporalNarrowing],
        runsPerRelation: 60
      })
    )
    const result = report.results[0]
    expect(result?.relationId).toBe("temporal-narrowing")
    expect(result?.passed).toBe(false)
    expect(report.passed).toBe(false)
    // fast-check must hand back the shrunk failing case, replayable by seed.
    expect(result?.counterexample).not.toBeNull()
    expect(result?.counterexample?.detail).toMatch(/temporal-narrowing/)
    expect(result?.counterexample?.bindingIndex).toBeGreaterThanOrEqual(0)
    expect(result?.counterexample?.bindingIndex).toBeLessThan(temporalBindings.length)
  })
})
