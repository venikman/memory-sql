/**
 * SPEC testing contract #1 — ontology.
 *
 * Why this validates the ontology: everything downstream (DDL, the SQL oracle,
 * the graph path) trusts the committed FHIR-derived ontology to be
 * structurally sound. This suite pins (a) the committed top50.json loads and
 * validates (50 entity types / 536 attributes / 261 relations), (b) the
 * payer-critical resources kept the attributes and relations the shipped CQ
 * templates rely on, and (c) referential closure — every relation target is
 * itself a top-50 entity type, which is what makes "referential integrity" a
 * checkable invariant instead of a hope.
 */
import { describe, expect, it } from "vitest"
import {
  FHIR_TOP50_COUNT,
  entityTypeNames,
  getEntityType,
  loadFhirOntology,
  requireEntityType,
  validateOntology
} from "memory-sql"
import type { Attribute, EntityType, Ontology, Relation } from "memory-sql"

const ontology: Ontology = loadFhirOntology()

const attr = (et: EntityType, name: string): Attribute => {
  const found = et.attributes.find((a) => a.name === name)
  if (found === undefined) throw new Error(`${et.name} has no attribute "${name}"`)
  return found
}

const rel = (et: EntityType, name: string): Relation => {
  const found = et.relations.find((r) => r.name === name)
  if (found === undefined) throw new Error(`${et.name} has no relation "${name}"`)
  return found
}

describe("ontology: committed FHIR top-50", () => {
  it("loads exactly the 50 payer-weighted entity types", () => {
    expect(FHIR_TOP50_COUNT).toBe(50)
    expect(ontology.entityTypes).toHaveLength(FHIR_TOP50_COUNT)
    expect(entityTypeNames(ontology)).toHaveLength(FHIR_TOP50_COUNT)
    // Spot-membership across the clinical / financial / admin spread.
    for (const name of [
      "Patient",
      "Practitioner",
      "Organization",
      "Encounter",
      "Observation",
      "Condition",
      "MedicationRequest",
      "AllergyIntolerance",
      "Coverage",
      "Claim",
      "ClaimResponse",
      "ExplanationOfBenefit",
      "Group",
      "Provenance",
      "AuditEvent"
    ]) {
      expect(getEntityType(ontology, name), name).toBeDefined()
    }
  })

  it("carries the exact committed totals: 536 attributes and 261 relations", () => {
    const attributes = ontology.entityTypes.reduce((n, et) => n + et.attributes.length, 0)
    const relations = ontology.entityTypes.reduce((n, et) => n + et.relations.length, 0)
    expect(attributes).toBe(536)
    expect(relations).toBe(261)
  })

  it("is structurally valid (validateOntology finds no problems)", () => {
    expect(validateOntology(ontology)).toEqual([])
  })

  it("has unique entity type names", () => {
    const names = entityTypeNames(ontology)
    expect(new Set(names).size).toBe(names.length)
  })

  it("keeps every resource within the documented 4-18 attribute budget", () => {
    // The flattener targets "enough for real CQs, not a full FHIR ORM".
    for (const et of ontology.entityTypes) {
      expect(et.attributes.length, et.name).toBeGreaterThanOrEqual(4)
      expect(et.attributes.length, et.name).toBeLessThanOrEqual(18)
    }
  })
})

describe("ontology: Patient spot-check", () => {
  const patient = requireEntityType(ontology, "Patient")

  it("kept the demographic scalar attributes the templates filter on", () => {
    expect(attr(patient, "gender").type).toBe("code")
    expect([...(attr(patient, "gender").valueSet ?? [])].sort()).toEqual(
      ["female", "male", "other", "unknown"]
    )
    expect(attr(patient, "birth_date").type).toBe("date")
    // Choice element Patient.deceased[x] resolved to datetime, not boolean.
    expect(attr(patient, "deceased").type).toBe("datetime")
    // HumanName / Address flattening rules.
    expect(attr(patient, "name_family").type).toBe("string")
    expect(attr(patient, "name_given").type).toBe("string")
    expect(attr(patient, "address_city").type).toBe("string")
    expect(attr(patient, "address_state").type).toBe("string")
  })

  it("kept the two Patient reference relations", () => {
    const gp = rel(patient, "general_practitioner")
    expect(gp.required).toBe(false)
    expect(gp.target).toContain("Practitioner")
    expect(gp.target.length).toBeGreaterThan(1) // multi-target Reference(X|Y|Z)
    expect(rel(patient, "managing_organization").target).toEqual(["Organization"])
  })
})

describe("ontology: Claim spot-check", () => {
  const claim = requireEntityType(ontology, "Claim")

  it("kept the financial-status machinery", () => {
    const status = attr(claim, "status")
    expect(status.required).toBe(true)
    expect([...(status.valueSet ?? [])].sort()).toEqual(
      ["active", "cancelled", "draft", "entered-in-error"]
    )
    expect(attr(claim, "use").valueSet).toHaveLength(3)
    expect(attr(claim, "created").required).toBe(true)
    // Money flattening: total -> total_cents (integer) + total_currency.
    expect(attr(claim, "total_cents").type).toBe("integer")
    // Period flattening: billablePeriod -> _start/_end.
    expect(attr(claim, "billable_period_start").type).toBe("datetime")
    expect(attr(claim, "billable_period_end").type).toBe("datetime")
  })

  it("kept the required financial reference chain", () => {
    expect(rel(claim, "patient")).toEqual({ name: "patient", target: ["Patient"], required: true })
    // Backbone whitelist leaf: Claim.insurance.coverage survived flattening.
    expect(rel(claim, "insurance_coverage")).toEqual({
      name: "insurance_coverage",
      target: ["Coverage"],
      required: true
    })
    const provider = rel(claim, "provider")
    expect(provider.required).toBe(true)
    expect(provider.target.length).toBeGreaterThan(1)
  })
})

describe("ontology: Coverage spot-check", () => {
  const coverage = requireEntityType(ontology, "Coverage")

  it("kept temporal + subscriber attributes", () => {
    expect(attr(coverage, "status").required).toBe(true)
    expect(attr(coverage, "status").valueSet).toHaveLength(4)
    expect(attr(coverage, "period_start").type).toBe("datetime")
    expect(attr(coverage, "period_end").type).toBe("datetime")
    expect(attr(coverage, "subscriber_id").type).toBe("string")
    // SQL reserved word kept as a column — schema layer must quote it.
    expect(attr(coverage, "order").type).toBe("integer")
  })

  it("anchors coverage to a Patient beneficiary", () => {
    expect(rel(coverage, "beneficiary")).toEqual({
      name: "beneficiary",
      target: ["Patient"],
      required: true
    })
    expect(rel(coverage, "payor").required).toBe(true)
  })
})

describe("ontology: referential closure", () => {
  it("every relation target is a known entity type", () => {
    const known = new Set(entityTypeNames(ontology))
    for (const et of ontology.entityTypes) {
      for (const relation of et.relations) {
        expect(relation.target.length, `${et.name}.${relation.name}`).toBeGreaterThan(0)
        for (const target of relation.target) {
          expect(known.has(target), `${et.name}.${relation.name} -> ${target}`).toBe(true)
        }
      }
    }
  })

  it("lookup helpers behave: getEntityType misses -> undefined, requireEntityType throws", () => {
    expect(getEntityType(ontology, "NotAResource")).toBeUndefined()
    expect(() => requireEntityType(ontology, "NotAResource")).toThrow(/NotAResource/)
  })
})
