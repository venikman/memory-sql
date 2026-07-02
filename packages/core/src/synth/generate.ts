/**
 * Deterministic InstanceWorld generator — the CLEAN baseline every validation
 * engine measures against. Referential consistency is guaranteed *by
 * construction*, not by post-hoc checking:
 *
 *   - all rows of all entity types are created first (pass 1), then relations
 *     are wired (pass 2), so every `<relation>_ref` points at an id that
 *     exists — even across FHIR's reference cycles;
 *   - required attributes are always filled; value-set attributes draw from
 *     their value set; `<x>_start` <= `<x>_end` for every period pair;
 *     birth dates precede REFERENCE_DATE; rows never reference themselves;
 *   - clinical resources are patient-scoped: each row remembers its owning
 *     patient, Patient-targeting relations bind to that owner, and
 *     patient-scoped targets (a Claim's Coverage, an EOB's Claim) are chosen
 *     from the same patient's rows — so patient -> claim -> coverage chains
 *     resolve within one patient, and ClaimResponse/ExplanationOfBenefit/
 *     CoverageEligibilityResponse are paired 1:1 with the resource they answer.
 *
 * Adversarial corruption deliberately lives elsewhere (sim/stress.ts): this
 * generator's cleanliness is itself a tested contract (zero invariant
 * violations on a fresh world).
 *
 * The generator is generic over the Ontology (attribute filling and relation
 * wiring only read the model); the FHIR-specific parts are pure *sizing and
 * pairing configuration* keyed by entity names — unknown entity types fall
 * back to a small default sizing, so non-FHIR ontologies generate fine.
 */
import type { Attribute, EntityType, Ontology } from "../ontology/model.js"
import { getEntityType } from "../ontology/model.js"
import type { SqlValue } from "../store/db.js"
import type { InstanceWorld, Row } from "../store/load.js"
import { relationRefColumn, relationRefTypeColumn, tableName } from "../store/schema.js"
import { daysFromCivil, formatIsoDate, parseIsoDays } from "./date.js"
import type { Rng } from "./rng.js"
import { makeRng } from "./rng.js"

/** The fixed "today" of the product — no Date.now anywhere (SPEC determinism). */
export const REFERENCE_DATE = "2026-01-01"

export interface GenerateOptions {
  readonly seed: number
  /** Cohort size; defaults to 20. */
  readonly patients?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Sizing + pairing configuration (FHIR-aware data, not engine logic)
// ─────────────────────────────────────────────────────────────────────────────

interface Sizing {
  /** Fixed row count for shared (non-patient-scoped) types. */
  readonly base: number
  /** Per-patient row count range for patient-scoped types. */
  readonly perPatient: readonly [number, number]
}

const DEFAULT_SIZING: Sizing = { base: 3, perPatient: [0, 0] }

const SIZING: Readonly<Record<string, Sizing>> = {
  // shared directory / catalog resources
  Organization: { base: 6, perPatient: [0, 0] },
  Practitioner: { base: 10, perPatient: [0, 0] },
  PractitionerRole: { base: 10, perPatient: [0, 0] },
  Location: { base: 6, perPatient: [0, 0] },
  Medication: { base: 12, perPatient: [0, 0] },
  Endpoint: { base: 3, perPatient: [0, 0] },
  HealthcareService: { base: 4, perPatient: [0, 0] },
  Questionnaire: { base: 3, perPatient: [0, 0] },
  Schedule: { base: 5, perPatient: [0, 0] },
  Slot: { base: 12, perPatient: [0, 0] },
  Device: { base: 6, perPatient: [0, 0] },
  Group: { base: 2, perPatient: [0, 0] },
  Person: { base: 6, perPatient: [0, 0] },
  RelatedPerson: { base: 6, perPatient: [0, 0] },
  PaymentReconciliation: { base: 3, perPatient: [0, 0] },
  // patient-scoped clinical / financial resources
  Encounter: { base: 0, perPatient: [1, 3] },
  Observation: { base: 0, perPatient: [2, 5] },
  Condition: { base: 0, perPatient: [1, 3] },
  Procedure: { base: 0, perPatient: [0, 2] },
  MedicationRequest: { base: 0, perPatient: [1, 3] },
  MedicationDispense: { base: 0, perPatient: [0, 2] },
  MedicationStatement: { base: 0, perPatient: [0, 1] },
  Immunization: { base: 0, perPatient: [0, 2] },
  AllergyIntolerance: { base: 0, perPatient: [0, 2] },
  DiagnosticReport: { base: 0, perPatient: [0, 2] },
  DocumentReference: { base: 0, perPatient: [0, 1] },
  ServiceRequest: { base: 0, perPatient: [0, 2] },
  CarePlan: { base: 0, perPatient: [0, 1] },
  CareTeam: { base: 0, perPatient: [0, 1] },
  Goal: { base: 0, perPatient: [0, 1] },
  Specimen: { base: 0, perPatient: [0, 1] },
  ImagingStudy: { base: 0, perPatient: [0, 1] },
  Appointment: { base: 0, perPatient: [0, 2] },
  Coverage: { base: 0, perPatient: [1, 2] },
  Claim: { base: 0, perPatient: [1, 3] },
  CoverageEligibilityRequest: { base: 0, perPatient: [0, 1] },
  PaymentNotice: { base: 0, perPatient: [0, 1] },
  Account: { base: 0, perPatient: [0, 1] },
  ChargeItem: { base: 0, perPatient: [0, 2] },
  Invoice: { base: 0, perPatient: [0, 1] },
  Communication: { base: 0, perPatient: [0, 1] },
  CommunicationRequest: { base: 0, perPatient: [0, 1] },
  Task: { base: 0, perPatient: [0, 1] },
  QuestionnaireResponse: { base: 0, perPatient: [0, 1] },
  Provenance: { base: 0, perPatient: [1, 1] },
  AuditEvent: { base: 0, perPatient: [1, 1] }
}

/**
 * Derived types get exactly one row per source row (same owning patient), and
 * the named relation is wired to that source row: a ClaimResponse answers one
 * Claim, an EOB explains one Claim, an eligibility response answers one request.
 */
const PAIRINGS: Readonly<Record<string, { readonly source: string; readonly relation: string }>> = {
  ClaimResponse: { source: "Claim", relation: "request" },
  ExplanationOfBenefit: { source: "Claim", relation: "claim" },
  CoverageEligibilityResponse: { source: "CoverageEligibilityRequest", relation: "request" }
}

/** Every generated type keeps at least this many rows so required relations always have targets. */
const MIN_ROWS = 2

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic value pools (name-suffix keyed; documented in attributeValue)
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_NAMES = ["Alvarez", "Brandt", "Chen", "Dubois", "Eriksen", "Fontaine", "Garcia", "Hoffman", "Ivanov", "Jensen", "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov"] as const
const GIVEN_NAMES = ["Ada", "Boris", "Clara", "David", "Elena", "Farid", "Greta", "Hugo", "Ingrid", "Jonas", "Katya", "Liam", "Mira", "Noor", "Otto", "Priya"] as const
const CITIES = ["Springfield", "Riverton", "Lakewood", "Fairview", "Brookside", "Milltown", "Ashford", "Granite Bay"] as const
const STATES = ["CA", "CO", "IL", "MA", "NY", "OH", "TX", "WA"] as const
const UNITS = ["mg", "mL", "mmHg", "kg", "%", "1"] as const

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic date helpers (pure civil-day arithmetic from synth/date.ts —
// no Date construction per the SPEC; output is ISO YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────

const isoDays = (iso: string): number => {
  const days = parseIsoDays(iso)
  if (days === null) throw new Error(`memory-sql: generator produced a non-ISO date "${iso}"`)
  return days
}

const randomDate = (rng: Rng, fromYear: number, toYear: number): string => {
  const from = daysFromCivil(fromYear, 1, 1)
  const to = daysFromCivil(toYear, 12, 31)
  return formatIsoDate(from + rng.int(0, to - from))
}

const addDays = (iso: string, days: number): string => formatIsoDate(isoDays(iso) + days)

// ─────────────────────────────────────────────────────────────────────────────
// Attribute filling
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONAL_FILL_PROBABILITY = 0.85

/**
 * One attribute value. Generic over the model, with documented name-suffix
 * conventions so the flattened FHIR columns come out believable:
 *   code+valueSet -> 50% the first code (value sets lead with the primary
 *     state, e.g. 'active'), else uniform; open codes -> `<name>-1..6` (a
 *     small pool so codes recur across patients and CQ filters hit);
 *   *_cents -> 1000..250000; *_currency -> USD; *_unit -> clinical unit pool;
 *   *_family/_given/_city/_state -> name pools; birth_date -> 1935..2005;
 *   other dates/datetimes -> 2020..2025 as plain ISO dates (uniform TEXT
 *   comparability — see store/schema.ts); 'deceased' fills only 10% of the
 *   time; 'active' is true 90% of the time.
 */
const attributeValue = (attr: Attribute, rng: Rng): SqlValue => {
  const fillProbability = attr.name === "deceased" ? 0.1 : OPTIONAL_FILL_PROBABILITY
  if (!attr.required && !rng.chance(fillProbability)) return null
  switch (attr.type) {
    case "code": {
      const vs = attr.valueSet
      if (vs !== undefined && vs.length > 0) {
        return rng.chance(0.5) ? (vs[0] as string) : rng.pick(vs)
      }
      return `${attr.name}-${rng.int(1, 6)}`
    }
    case "boolean":
      return attr.name === "active" ? rng.chance(0.9) : rng.chance(0.5)
    case "integer":
      return attr.name.endsWith("_cents") ? rng.int(1_000, 250_000) : rng.int(1, 100)
    case "decimal":
      return Math.round(rng.float(0.5, 200) * 100) / 100
    case "date":
    case "datetime":
      return attr.name === "birth_date" ? randomDate(rng, 1935, 2005) : randomDate(rng, 2020, 2025)
    case "string":
      if (attr.name.endsWith("_currency")) return "USD"
      if (attr.name.endsWith("_family")) return rng.pick(FAMILY_NAMES)
      if (attr.name.endsWith("_given")) return rng.pick(GIVEN_NAMES)
      if (attr.name.endsWith("_city")) return rng.pick(CITIES)
      if (attr.name.endsWith("_state")) return rng.pick(STATES)
      if (attr.name.endsWith("_unit")) return rng.pick(UNITS)
      return `${attr.name}-${rng.int(100, 999)}`
  }
}

type MutableRow = Record<string, SqlValue>

/** Fill all attributes of a row; `<x>_start`/`<x>_end` pairs are generated together, ordered. */
const fillAttributes = (entityType: EntityType, row: MutableRow, rng: Rng): void => {
  const done = new Set<string>()
  for (const attr of entityType.attributes) {
    if (done.has(attr.name)) continue
    if (attr.name.endsWith("_start")) {
      const end = entityType.attributes.find((a) => a.name === `${attr.name.slice(0, -6)}_end`)
      if (end !== undefined) {
        const filled = attr.required || rng.chance(OPTIONAL_FILL_PROBABILITY)
        if (filled) {
          const start = randomDate(rng, 2020, 2025)
          row[attr.name] = start
          // periods may run past REFERENCE_DATE (open/active coverage) or be null (ongoing)
          row[end.name] = rng.chance(0.8) ? addDays(start, rng.int(30, 450)) : null
        } else {
          row[attr.name] = null
          row[end.name] = null
        }
        done.add(attr.name)
        done.add(end.name)
        continue
      }
    }
    row[attr.name] = attributeValue(attr, rng)
    done.add(attr.name)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateWorld
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a clean, referentially consistent world. Deterministic: the same
 * (ontology, seed, patients) triple always yields a deep-equal world.
 */
export const generateWorld = (ontology: Ontology, opts: GenerateOptions): InstanceWorld => {
  const rng = makeRng(opts.seed)
  const patientCount = Math.max(1, opts.patients ?? 20)
  const hasPatient = getEntityType(ontology, "Patient") !== undefined

  const rowsByType = new Map<string, MutableRow[]>()
  const idPool = new Map<string, string[]>()
  const ownerOf = new Map<string, string>() // row id -> owning patient id
  const byOwner = new Map<string, Map<string, string[]>>() // type -> patient id -> row ids

  const makeId = (typeName: string, index: number): string =>
    `${tableName(typeName)}-${String(index + 1).padStart(3, "0")}`

  const addRow = (et: EntityType, owner: string | undefined): MutableRow => {
    const list = rowsByType.get(et.name) ?? []
    const id = makeId(et.name, list.length)
    const row: MutableRow = { id }
    fillAttributes(et, row, rng)
    list.push(row)
    rowsByType.set(et.name, list)
    const pool = idPool.get(et.name) ?? []
    pool.push(id)
    idPool.set(et.name, pool)
    if (owner !== undefined) {
      ownerOf.set(id, owner)
      const perOwner = byOwner.get(et.name) ?? new Map<string, string[]>()
      const ownerIds = perOwner.get(owner) ?? []
      ownerIds.push(id)
      perOwner.set(owner, ownerIds)
      byOwner.set(et.name, perOwner)
    }
    return row
  }

  // ── Pass 1: rows + attributes for every entity type (ontology order) ──
  const patientIds: string[] = []
  for (const et of ontology.entityTypes) {
    if (et.name === "Patient" && hasPatient) {
      for (let i = 0; i < patientCount; i++) {
        patientIds.push(addRow(et, undefined)["id"] as string)
      }
      continue
    }
    const pairing = PAIRINGS[et.name]
    if (pairing !== undefined && getEntityType(ontology, pairing.source) !== undefined) {
      // one derived row per source row, same owner; wiring happens in pass 2
      for (const sourceId of idPool.get(pairing.source) ?? []) {
        addRow(et, ownerOf.get(sourceId))
      }
    } else {
      const sizing = SIZING[et.name] ?? DEFAULT_SIZING
      const [perMin, perMax] = sizing.perPatient
      if (hasPatient && perMax > 0) {
        for (const patientId of patientIds) {
          const n = rng.int(perMin, perMax)
          for (let i = 0; i < n; i++) addRow(et, patientId)
        }
      } else {
        const n = Math.max(sizing.base, MIN_ROWS)
        for (let i = 0; i < n; i++) addRow(et, undefined)
      }
    }
    // floor: required relations must always find a target, so no pool stays < MIN_ROWS
    while ((idPool.get(et.name) ?? []).length < MIN_ROWS) {
      const index = (idPool.get(et.name) ?? []).length
      addRow(et, hasPatient ? patientIds[index % patientIds.length] : undefined)
    }
  }

  // Pairing map: n-th derived row of a type pairs with the n-th source row
  // (both were created in source order with matching owners).
  const pairedSourceOf = new Map<string, string>()
  for (const [derivedType, pairing] of Object.entries(PAIRINGS)) {
    const derivedIds = idPool.get(derivedType) ?? []
    const sourceIds = idPool.get(pairing.source) ?? []
    derivedIds.forEach((id, i) => {
      const source = sourceIds[i % Math.max(1, sourceIds.length)]
      if (source !== undefined) pairedSourceOf.set(id, source)
    })
  }

  // ── Pass 2: wire relations (every pool exists now, cycles included) ──
  for (const et of ontology.entityTypes) {
    const pairing = PAIRINGS[et.name]
    for (const row of rowsByType.get(et.name) ?? []) {
      const rowId = row["id"] as string
      const owner = ownerOf.get(rowId)
      for (const rel of et.relations) {
        const refCol = relationRefColumn(rel.name)
        const refTypeCol = relationRefTypeColumn(rel.name)
        const set = (id: string | null, targetType: string | null): void => {
          row[refCol] = id
          if (rel.target.length > 1) row[refTypeCol] = id === null ? null : targetType
        }

        // 1:1 pairings are wired unconditionally (they define the derived row)
        if (pairing !== undefined && rel.name === pairing.relation) {
          const source = pairedSourceOf.get(rowId)
          if (source !== undefined) {
            set(source, pairing.source)
            continue
          }
        }

        if (!rel.required && !rng.chance(0.8)) {
          set(null, null)
          continue
        }

        // target type: prefer Patient (keeps clinical rows patient-centric),
        // else the first declared target with generated rows
        const targetType =
          rel.target.includes("Patient") && patientIds.length > 0
            ? "Patient"
            : rel.target.find((t) => (idPool.get(t) ?? []).length > 0)
        if (targetType === undefined) {
          set(null, null)
          continue
        }

        if (targetType === "Patient" && owner !== undefined) {
          set(owner, "Patient")
          continue
        }

        // same-patient rows win when the target type is patient-scoped
        const ownerPool = owner !== undefined ? byOwner.get(targetType)?.get(owner) : undefined
        const pool =
          ownerPool !== undefined && ownerPool.length > 0
            ? ownerPool
            : (idPool.get(targetType) as string[])
        let chosen: string | null = rng.pick(pool)
        if (chosen === rowId) {
          // self-reference guard: clean worlds never self-link (stress plants those)
          chosen =
            pool.find((x) => x !== rowId) ??
            (idPool.get(targetType) as string[]).find((x) => x !== rowId) ??
            null
        }
        set(chosen, chosen === null ? null : targetType)
      }
    }
  }

  const world: Record<string, Row[]> = {}
  for (const et of ontology.entityTypes) {
    world[et.name] = (rowsByType.get(et.name) ?? []) as Row[]
  }
  return world
}
