/**
 * SPEC testing contract #3 — synth.
 *
 * Why this validates the generator: the whole validation story rests on the
 * CLEAN world being clean *by construction*. If the generator ever emitted a
 * dangling reference or an out-of-value-set code, the stress engine's
 * "clean = zero violations" baseline (asserted engine-side in stress.test.ts)
 * would be meaningless and every mutator test would be ambiguous. Here we
 * verify determinism and re-derive referential consistency structurally from
 * the ontology metadata — an independent check that does not go through the
 * sim engine.
 */
import { describe, expect, it } from "vitest"
import {
  REFERENCE_DATE,
  entityTypeNames,
  generateWorld,
  loadFhirOntology,
  relationRefColumn,
  relationRefTypeColumn,
  requireEntityType,
  tableName
} from "memory-sql"
import type { InstanceWorld, Ontology } from "memory-sql"

const ontology: Ontology = loadFhirOntology()

describe("synth: determinism", () => {
  it("same seed => deep-equal worlds", () => {
    const a = generateWorld(ontology, { seed: 42, patients: 6 })
    const b = generateWorld(ontology, { seed: 42, patients: 6 })
    expect(a).toEqual(b)
    // Byte-level determinism too: identical key order and values.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it("different seeds => different worlds", () => {
    const a = generateWorld(ontology, { seed: 1, patients: 6 })
    const b = generateWorld(ontology, { seed: 2, patients: 6 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it("REFERENCE_DATE is the fixed product 'today'", () => {
    expect(REFERENCE_DATE).toBe("2026-01-01")
  })
})

describe("synth: sizing", () => {
  it("honors the patients option and populates every entity type", () => {
    const world = generateWorld(ontology, { seed: 42, patients: 20 })
    expect(world["Patient"]).toHaveLength(20)
    for (const name of entityTypeNames(ontology)) {
      // Every type carries rows so required relations always have a target
      // and negative controls are a property of the CQ, not missing data.
      expect(world[name]?.length ?? 0, name).toBeGreaterThanOrEqual(2)
    }
  })

  it("ids are '<table_name>-NNN' and unique within their type", () => {
    const world = generateWorld(ontology, { seed: 42, patients: 5 })
    for (const name of entityTypeNames(ontology)) {
      const rows = world[name] ?? []
      const ids = rows.map((r) => String(r["id"]))
      expect(new Set(ids).size, name).toBe(ids.length)
      for (const id of ids) {
        expect(id, `${name} id`).toMatch(new RegExp(`^${tableName(name)}-\\d+$`))
      }
    }
  })
})

/**
 * Structural clean-world validation: re-implements the core invariants
 * directly from ontology metadata (the closed-world analogue of "zero stress
 * violations" without depending on the sim engine — that engine-level zero
 * is asserted in stress.test.ts).
 */
describe("synth: referential consistency of the clean world", () => {
  const world: InstanceWorld = generateWorld(ontology, { seed: 42, patients: 10 })
  const idsByType = new Map<string, Set<string>>(
    entityTypeNames(ontology).map((name) => [
      name,
      new Set((world[name] ?? []).map((r) => String(r["id"])))
    ])
  )

  it("every non-null reference resolves to a generated row of a legal target type", () => {
    for (const et of ontology.entityTypes) {
      for (const row of world[et.name] ?? []) {
        for (const relation of et.relations) {
          const ref = row[relationRefColumn(relation.name)]
          if (ref === null || ref === undefined) continue
          const targetType =
            relation.target.length > 1
              ? String(row[relationRefTypeColumn(relation.name)])
              : relation.target[0]!
          expect(relation.target, `${et.name}.${relation.name} ref_type`).toContain(targetType)
          expect(
            idsByType.get(targetType)?.has(String(ref)),
            `${et.name} ${row["id"]} ${relation.name} -> ${targetType}/${ref}`
          ).toBe(true)
        }
      }
    }
  })

  it("required attributes and required relations are always filled", () => {
    for (const et of ontology.entityTypes) {
      for (const row of world[et.name] ?? []) {
        for (const attribute of et.attributes) {
          if (!attribute.required) continue
          const v = row[attribute.name]
          expect(v, `${et.name} ${row["id"]} ${attribute.name}`).not.toBeNull()
          expect(v, `${et.name} ${row["id"]} ${attribute.name}`).not.toBeUndefined()
        }
        for (const relation of et.relations) {
          if (!relation.required) continue
          const ref = row[relationRefColumn(relation.name)]
          expect(ref, `${et.name} ${row["id"]} ${relation.name}`).not.toBeNull()
          expect(ref, `${et.name} ${row["id"]} ${relation.name}`).not.toBeUndefined()
        }
      }
    }
  })

  it("value-set attributes stay inside their value set", () => {
    for (const et of ontology.entityTypes) {
      for (const row of world[et.name] ?? []) {
        for (const attribute of et.attributes) {
          if (attribute.valueSet === undefined) continue
          const v = row[attribute.name]
          if (v === null || v === undefined) continue
          expect(attribute.valueSet, `${et.name} ${row["id"]} ${attribute.name}`).toContain(
            String(v)
          )
        }
      }
    }
  })

  it("periods are ordered (start <= end) — plain ISO strings compare exactly", () => {
    // Pairing rule mirrors the stress engine's period-ordering invariant:
    // `<x>_start`/`<x>_end` pairs come from flattening a FHIR Period and must
    // be ordered. Bare `start`/`end` columns (Appointment, Slot) are two
    // independent FHIR `instant` fields, not a Period — deliberately excluded.
    for (const et of ontology.entityTypes) {
      const names = new Set(et.attributes.map((a) => a.name))
      const pairs = et.attributes
        .filter((a) => a.name.endsWith("_start"))
        .map((a) => [a.name, `${a.name.slice(0, -"_start".length)}_end`] as const)
        .filter((pair) => names.has(pair[1]))
      for (const row of world[et.name] ?? []) {
        for (const [startCol, endCol] of pairs) {
          const start = row[startCol]
          const end = row[endCol]
          if (typeof start !== "string" || typeof end !== "string") continue
          expect(
            start <= end,
            `${et.name} ${row["id"]} ${startCol}/${endCol}: ${start} > ${end}`
          ).toBe(true)
        }
      }
    }
  })

  it("no future-dated births relative to REFERENCE_DATE", () => {
    const patient = requireEntityType(ontology, "Patient")
    expect(patient.attributes.some((a) => a.name === "birth_date")).toBe(true)
    for (const row of world["Patient"] ?? []) {
      const birth = row["birth_date"]
      if (typeof birth !== "string") continue
      expect(birth <= REFERENCE_DATE, `${row["id"]} birth_date ${birth}`).toBe(true)
    }
  })

  it("patient-scoped financial chain: Claim -> Coverage of the same patient", () => {
    // The generator's ownership guarantee: a claim's insurance_coverage points
    // at a Coverage whose beneficiary is the claim's own patient.
    const coverageBeneficiary = new Map(
      (world["Coverage"] ?? []).map((c) => [String(c["id"]), String(c["beneficiary_ref"])])
    )
    const claims = world["Claim"] ?? []
    expect(claims.length).toBeGreaterThan(0)
    for (const claim of claims) {
      const coverageRef = claim["insurance_coverage_ref"]
      expect(coverageRef, `claim ${claim["id"]} insurance_coverage_ref`).not.toBeNull()
      expect(coverageBeneficiary.get(String(coverageRef)), `claim ${claim["id"]}`).toBe(
        String(claim["patient_ref"])
      )
    }
  })
})
