/**
 * SPEC testing contract #5 — CQ dual oracle.
 *
 * Why this validates the product surface: the pitch is "plug your answer
 * layer into AnswerPath and memory-sql tells you where it is wrong". That
 * only holds if (a) the two independent shipped implementations — SQL oracle
 * and typed graph walk — agree perfectly on a clean generated world, and
 * (b) each *kind* of wrongness maps to its own verdict. So we run the suite
 * once with the reference GraphPath (all match) and then with deliberately
 * broken paths: wrong values must grade `divergent`, fabricated citations
 * `unsupported-citation`, and a path that fails to answer `missing`. Also
 * pinned here: the SPEC gate "0 sampled bindings is a failure, not a pass" —
 * nothing graded is not nothing wrong.
 */
import { describe, expect, it } from "vitest"
import {
  MemorySqlError,
  bindTemplates,
  fhirCqTemplates,
  generateWorld,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  openStore,
  runCq
} from "memory-sql"
import type {
  Answer,
  AnswerPath,
  CqBinding,
  CqRegime,
  CqReport,
  Ontology
} from "memory-sql"

const ontology: Ontology = loadFhirOntology()
const world = generateWorld(ontology, { seed: 42, patients: 10 })
const graphPath = makeGraphPath(world, ontology)

// Round-robin sampling: 3 bindings per shipped template covers every regime.
const SUITE_SIZE = fhirCqTemplates.length * 3
const bindings = bindTemplates(fhirCqTemplates, world, makeRng(7), SUITE_SIZE)

/** Load the world and grade `path` against the SQL oracle over all bindings. */
const suite = async (path: AnswerPath): Promise<CqReport> => {
  const store = await openStore()
  try {
    return await runCq(store, world, bindings, path, { ontology })
  } finally {
    store.close()
  }
}

describe("cq: binding sampler", () => {
  it("samples every template from real world rows, deterministically", () => {
    expect(fhirCqTemplates.length).toBeGreaterThanOrEqual(10) // the 13 shipped templates
    expect(bindings).toHaveLength(SUITE_SIZE)
    const sampledTemplates = new Set(bindings.map((b) => b.template.id))
    expect(sampledTemplates.size).toBe(fhirCqTemplates.length)
    // Same seed, same world -> the identical suite.
    const again = bindTemplates(fhirCqTemplates, world, makeRng(7), SUITE_SIZE)
    const view = (bs: ReadonlyArray<CqBinding>) =>
      bs.map((b) => ({ id: b.template.id, params: b.params }))
    expect(view(again)).toEqual(view(bindings))
  })

  it("ships all five question regimes, including negative controls", () => {
    const regimes = new Set<CqRegime>(fhirCqTemplates.map((t) => t.regime))
    expect([...regimes].sort()).toEqual(
      ["aggregate", "cross-entity", "negative-control", "point-lookup", "temporal"].sort()
    )
    expect(fhirCqTemplates.filter((t) => t.regime === "negative-control").length)
      .toBeGreaterThanOrEqual(2)
  })
})

describe("cq: GraphPath vs SqlOracle on the clean world", () => {
  it("agrees on every binding — the dual-oracle contract", async () => {
    const report = await suite(graphPath)
    expect(report.total).toBe(bindings.length)
    const disagreements = report.results
      .filter((r) => r.verdict !== "match")
      .map((r) => `${r.templateId}: ${r.verdict} — ${r.question}`)
    expect(disagreements).toEqual([])
    expect(report.match).toBe(report.total)
    expect(report.missing).toBe(0)
    expect(report.divergent).toBe(0)
    expect(report.unsupportedCitation).toBe(0)
    expect(report.agreementRate).toBe(1)
    expect(report.answerableRate).toBe(1)
    expect(report.citationResolvesRate).toBe(1)
    // Per-regime breakdown covers all five regimes at full agreement.
    expect(report.byRegime.map((b) => b.regime).sort()).toEqual(
      ["aggregate", "cross-entity", "negative-control", "point-lookup", "temporal"].sort()
    )
    for (const regime of report.byRegime) {
      expect(regime.agreementRate, regime.regime).toBe(1)
    }
  })

  it("makes per-template binding counts visible — no template silently ungraded", async () => {
    const report = await suite(graphPath)
    // Every shipped template has an explicit row; round-robin gave each 3.
    expect(report.byTemplate.map((t) => t.templateId).sort()).toEqual(
      fhirCqTemplates.map((t) => t.id).sort()
    )
    for (const row of report.byTemplate) {
      expect(row.bindings, row.templateId).toBe(3)
    }
  })

  it("negative controls answer empty — no fabrication on both paths", async () => {
    const report = await suite(graphPath)
    const controls = report.results.filter((r) => r.regime === "negative-control")
    expect(controls.length).toBeGreaterThan(0)
    for (const result of controls) {
      expect(result.verdict, result.question).toBe("match")
      expect(result.oracle.value, result.question).toEqual([])
      expect(result.oracle.citations, result.question).toEqual([])
      expect(result.path?.value, result.question).toEqual([])
    }
  })
})

describe("cq: broken AnswerPaths get the right verdicts", () => {
  it("wrong values -> divergent on every binding", async () => {
    // Corrupt each kind minimally but surely: sets gain a fabricated member,
    // scalars drift by one cent, booleans flip. Never empty -> never `missing`.
    const corrupt = (a: Answer): Answer => {
      if (a.kind === "set" && Array.isArray(a.value)) {
        return { ...a, value: [...a.value, "fabricated-row-999"] }
      }
      if (a.kind === "scalar") {
        return { ...a, value: typeof a.value === "number" ? a.value + 1 : 1 }
      }
      return { ...a, value: a.value !== true }
    }
    const wrongValues: AnswerPath = {
      name: "broken-wrong-values",
      answer: async (binding) => corrupt(await graphPath.answer(binding))
    }
    const report = await suite(wrongValues)
    expect(report.divergent).toBe(report.total)
    expect(report.match).toBe(0)
    expect(report.agreementRate).toBe(0)
  })

  it("fabricated citations -> unsupported-citation on every binding", async () => {
    // Values stay exactly right; only the provenance is a lie. The verdict
    // must catch it mechanically (citation not in the oracle's support set).
    const fakeCitations: AnswerPath = {
      name: "broken-fake-citations",
      answer: async (binding) => {
        const a = await graphPath.answer(binding)
        return { ...a, citations: [{ entityType: "Patient", id: "patient-999-fabricated" }] }
      }
    }
    const report = await suite(fakeCitations)
    expect(report.unsupportedCitation).toBe(report.total)
    expect(report.divergent).toBe(0)
    expect(report.citationResolvesRate).toBe(0)
  })

  it("a path that cannot answer -> missing on every binding", async () => {
    const mute: AnswerPath = {
      name: "broken-mute",
      answer: () => Promise.reject(new Error("no memory layer attached"))
    }
    const report = await suite(mute)
    expect(report.missing).toBe(report.total)
    expect(report.answerableRate).toBe(0)
    for (const result of report.results) {
      expect(result.path).toBeNull()
      expect(result.pathError).toMatch(/no memory layer/)
    }
  })
})

describe("cq: the 0-binding gate", () => {
  it("an empty binding list is a failure, never a green report", async () => {
    const store = await openStore()
    try {
      const failure = await runCq(store, world, [], graphPath, { ontology }).then(
        () => null,
        (cause: unknown) => cause
      )
      expect(failure).toBeInstanceOf(MemorySqlError)
      expect((failure as MemorySqlError).op).toBe("cq")
      expect((failure as MemorySqlError).message).toMatch(/0 bindings/)
    } finally {
      store.close()
    }
  })
})
