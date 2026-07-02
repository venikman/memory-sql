/**
 * SPEC testing contract #7 — stress (the mutator x invariant matrix).
 *
 * Why this is "validation by simulation": the closed-world analogue of
 * reasoner consistency checking only proves anything if BOTH directions hold —
 * the clean generated world replays with ZERO violations (no false alarms),
 * and every named planted defect fires its named invariant (no blind spots).
 * A defect class that stops firing means the validation layer itself has
 * regressed; a violation on the clean world means the generator or an
 * invariant is lying. This suite pins the full matrix plus the one deliberate
 * asymmetry: a duplicate-id world cannot even load (id is a real PRIMARY
 * KEY), so unique-ids must be caught on the world, pre-store.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  duckDbLayer,
  duplicateIdMutator,
  fhirInvariants,
  fhirStressMutators,
  generateWorld,
  loadFhirOntology,
  makeRng,
  replay,
  runStress
} from "memory-sql"
import type { DuckDb, InstanceWorld, Ontology, StressReport } from "memory-sql"

const ontology: Ontology = await Effect.runPromise(loadFhirOntology())
const world: InstanceWorld = generateWorld(ontology, { seed: 42, patients: 6 })

const withDb = <A, E>(effect: Effect.Effect<A, E, DuckDb>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, duckDbLayer()))

/** SPEC-named mutators and the invariant each one MUST trip (the matrix diagonal). */
const SPEC_DIAGONAL: ReadonlyArray<readonly [mutator: string, invariant: string]> = [
  ["dangling-reference", "referential-integrity"],
  ["missing-required", "required-present"],
  ["illegal-code", "value-set-membership"],
  ["reversed-period", "period-ordering"],
  ["orphan-eob", "eob-claim-consistency"],
  ["duplicate-id", "unique-ids"],
  ["future-dated-birth", "birthdate-sanity"],
  ["self-reference", "no-self-reference"]
]

describe("stress: shipped surface", () => {
  it("ships the 8 SPEC mutators and the invariant set they map onto", () => {
    expect(fhirStressMutators.map((m) => m.id).sort()).toEqual(
      SPEC_DIAGONAL.map(([mutator]) => mutator).sort()
    )
    const invariantIds = fhirInvariants.map((i) => i.id)
    expect(new Set(invariantIds).size).toBe(invariantIds.length)
    for (const [, invariant] of SPEC_DIAGONAL) {
      expect(invariantIds, invariant).toContain(invariant)
    }
    // Chain invariant per SPEC: claim -> coverage -> patient resolves.
    expect(invariantIds).toContain("claim-coverage-patient-chain")
  })

  it("mutators are pure: planting a defect never touches the input world", () => {
    const before = JSON.stringify(world)
    for (const mutator of fhirStressMutators) {
      const mutation = mutator.mutate(ontology, world, makeRng(99))
      expect(mutation, mutator.id).not.toBeNull()
      expect(JSON.stringify(mutation?.world)).not.toBe(before) // it DID plant something
    }
    expect(JSON.stringify(world)).toBe(before)
  })
})

describe("stress: replay", () => {
  it("clean world -> zero violations, clean load, nothing skipped", async () => {
    const result = await withDb(replay(world, ontology, fhirInvariants))
    expect(result.violations).toEqual([])
    expect(result.firedInvariants).toEqual([])
    expect(result.loadError).toBeNull()
    expect(result.skippedInvariants).toEqual([])
  })

  it("duplicate-id worlds fail the load (PRIMARY KEY) yet still convict via the world invariant", async () => {
    const mutation = duplicateIdMutator.mutate(ontology, world, makeRng(1))
    expect(mutation).not.toBeNull()
    const result = await withDb(replay(mutation!.world, ontology))
    // unique-ids is a world-kind invariant: it must fire without the store.
    expect(result.firedInvariants).toContain("unique-ids")
    // The store refuses the world outright, and SQL invariants report skipped
    // instead of silently green — no verdict laundering through a failed load.
    expect(result.loadError).not.toBeNull()
    expect(result.skippedInvariants.length).toBeGreaterThan(0)
    expect(result.skippedInvariants).toContain("referential-integrity")
  })
})

describe("stress: the mutator x invariant matrix", () => {
  it("clean row is silent and every mutator trips its named invariant", async () => {
    const report: StressReport = await withDb(runStress({ ontology, world, seed: 2026 }))

    expect(report.cleanPassed).toBe(true)
    expect(report.clean.violations).toEqual([])

    expect(report.runs).toHaveLength(fhirStressMutators.length)
    const misses = report.runs
      .filter((r) => !r.applied || !r.expectationMet)
      .map((r) => `${r.mutatorId}: applied=${String(r.applied)} fired=[${r.firedInvariants.join(", ")}]`)
    expect(misses).toEqual([])

    // The SPEC diagonal, asserted independently of the mutators' own
    // expectedInvariants declarations (so weakening those cannot pass).
    for (const [mutatorId, invariantId] of SPEC_DIAGONAL) {
      const run = report.runs.find((r) => r.mutatorId === mutatorId)
      expect(run, mutatorId).toBeDefined()
      expect(run?.firedInvariants, `${mutatorId} must trip ${invariantId}`).toContain(invariantId)
    }

    expect(report.passed).toBe(true)
  })

  it("defects are surgical: no mutator sets the clean-world baseline on fire", async () => {
    const report = await withDb(runStress({ ontology, world, seed: 2026 }))
    for (const run of report.runs) {
      // One planted defect must not light up more than a few invariants —
      // a defect that fires half the matrix means invariants are entangled.
      // (dangling refs legitimately fire integrity + their chain invariant.)
      expect(run.replay, run.mutatorId).not.toBeNull()
      expect(run.firedInvariants.length, run.mutatorId).toBeGreaterThanOrEqual(1)
      expect(run.firedInvariants.length, run.mutatorId).toBeLessThanOrEqual(3)
    }
  })

  it("is deterministic: same seed, same world, same matrix", async () => {
    const a = await withDb(runStress({ ontology, world, seed: 7 }))
    const b = await withDb(runStress({ ontology, world, seed: 7 }))
    expect(a).toEqual(b)
  })
})
