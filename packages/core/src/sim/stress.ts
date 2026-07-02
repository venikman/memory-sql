/**
 * Stage 2b — adversarial instance stress: the closed-world analogue of
 * reasoner consistency checking. An OWL reasoner would flag an inconsistent
 * ABox; here the "ABox" is rows in DuckDB, so consistency is a set of named
 * SQL/world invariants derived from the ontology (referential integrity,
 * required presence, value-set membership, period ordering, ...).
 *
 * The engine has three parts:
 *   - mutators: pure functions that take the CLEAN generated world and plant
 *     exactly one named defect (dangling reference, reversed period, ...);
 *   - invariants: checks over the loaded world (SQL) or over the in-memory
 *     world (pure) that report violations;
 *   - replay: load a world, run every invariant, report per-invariant
 *     violations.
 *
 * The contract that makes this "validation by simulation": the clean world
 * replays with ZERO violations, and each mutator trips its expected
 * invariant(s) — runStress produces that mutator x invariant matrix. If a
 * defect class ever stops firing its invariant, the validation layer itself
 * has regressed, which is exactly what the matrix is there to catch.
 *
 * Everything here is generic over the Ontology: invariants are derived from
 * attributes/relations, mutators search the ontology for applicable targets.
 * FHIR only appears in configuration (which entity/attribute a mutator
 * prefers, the Claim->Coverage->Patient chain, birth-date bounds).
 */
import { Effect } from "effect"
import type { EntityType, Ontology, Relation } from "../ontology/model.js"
import { getEntityType } from "../ontology/model.js"
import type { DbError, SqlValue } from "../store/db.js"
import { DuckDb } from "../store/db.js"
import type { InstanceWorld, Row } from "../store/load.js"
import { loadWorld, sqlLiteral } from "../store/load.js"
import { quoteIdent, relationRefColumn, relationRefTypeColumn, tableName } from "../store/schema.js"
import { REFERENCE_DATE } from "../synth/generate.js"
import type { Rng } from "../synth/rng.js"
import { makeRng } from "../synth/rng.js"

// ─────────────────────────────────────────────────────────────────────────────
// Invariant model
// ─────────────────────────────────────────────────────────────────────────────

export interface InvariantViolation {
  readonly invariantId: string
  readonly entityType: string
  readonly rowId: string | null
  readonly detail: string
}

/**
 * Pure check over the in-memory world. Needed where the store cannot help:
 * duplicate ids violate the `id TEXT PRIMARY KEY` constraint, so a
 * duplicate-id world fails the LOAD — the invariant must see the world
 * before the store does.
 */
export interface WorldInvariant {
  readonly id: string
  readonly describe: string
  readonly kind: "world"
  readonly check: (ontology: Ontology, world: InstanceWorld) => readonly InvariantViolation[]
}

/** Check executed as SQL over the loaded world. */
export interface SqlInvariant {
  readonly id: string
  readonly describe: string
  readonly kind: "sql"
  readonly check: (ontology: Ontology) => Effect.Effect<readonly InvariantViolation[], DbError, DuckDb>
}

export type Invariant = WorldInvariant | SqlInvariant

/** Cap per violation query — reports stay readable, defects still undeniable. */
const VIOLATION_LIMIT = 25

const queryViolations = (
  invariantId: string,
  entityType: string,
  sql: string,
  detail: (row: ReadonlyArray<SqlValue>) => string
): Effect.Effect<readonly InvariantViolation[], DbError, DuckDb> =>
  Effect.gen(function* () {
    const db = yield* DuckDb
    const result = yield* db.query(sql)
    return result.rows.map((row) => ({
      invariantId,
      entityType,
      rowId: typeof row[0] === "string" ? row[0] : null,
      detail: detail(row)
    }))
  })

// ─────────────────────────────────────────────────────────────────────────────
// Generic invariants (derived entirely from the ontology)
// ─────────────────────────────────────────────────────────────────────────────

const referentialIntegritySql = (et: EntityType, rel: Relation): string => {
  const table = quoteIdent(tableName(et.name))
  const ref = quoteIdent(relationRefColumn(rel.name))
  const only = rel.target[0]
  if (rel.target.length === 1 && only !== undefined) {
    return (
      `SELECT s."id", s.${ref} FROM ${table} s WHERE s.${ref} IS NOT NULL` +
      ` AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(tableName(only))} t WHERE t."id" = s.${ref})` +
      ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`
    )
  }
  // Multi-target: the `<rel>_ref_type` column names the target table. A ref is
  // resolved only when its declared type is one of the relation's targets AND
  // the id exists there; a NULL/unknown type with a non-null ref is a defect.
  const refType = quoteIdent(relationRefTypeColumn(rel.name))
  const resolved = rel.target
    .map(
      (targetType) =>
        `(s.${refType} = ${sqlLiteral(targetType)} AND EXISTS ` +
        `(SELECT 1 FROM ${quoteIdent(tableName(targetType))} t WHERE t."id" = s.${ref}))`
    )
    .join(" OR ")
  return (
    `SELECT s."id", s.${ref} FROM ${table} s WHERE s.${ref} IS NOT NULL` +
    ` AND (s.${refType} IS NULL OR NOT (${resolved}))` +
    ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`
  )
}

export const referentialIntegrity: SqlInvariant = {
  id: "referential-integrity",
  describe: "every non-null relation reference resolves to an existing row of a declared target type",
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const out: InvariantViolation[] = []
      for (const et of ontology.entityTypes) {
        for (const rel of et.relations) {
          out.push(
            ...(yield* queryViolations(
              "referential-integrity",
              et.name,
              referentialIntegritySql(et, rel),
              (row) => `${et.name}.${rel.name}_ref = "${String(row[1] ?? "")}" does not resolve`
            ))
          )
        }
      }
      return out
    })
}

export const requiredPresent: SqlInvariant = {
  id: "required-present",
  describe: "required attributes and required relations are never NULL",
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const out: InvariantViolation[] = []
      for (const et of ontology.entityTypes) {
        const table = quoteIdent(tableName(et.name))
        const requiredColumns = [
          ...et.attributes.filter((a) => a.required).map((a) => a.name),
          ...et.relations.filter((r) => r.required).map((r) => relationRefColumn(r.name))
        ]
        for (const column of requiredColumns) {
          out.push(
            ...(yield* queryViolations(
              "required-present",
              et.name,
              `SELECT s."id" FROM ${table} s WHERE s.${quoteIdent(column)} IS NULL ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
              () => `${et.name}.${column} is required but NULL`
            ))
          )
        }
      }
      return out
    })
}

export const valueSetMembership: SqlInvariant = {
  id: "value-set-membership",
  describe: "every non-null value of a value-set attribute is one of its codes",
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const out: InvariantViolation[] = []
      for (const et of ontology.entityTypes) {
        const table = quoteIdent(tableName(et.name))
        for (const attr of et.attributes) {
          const valueSet = attr.valueSet
          if (valueSet === undefined || valueSet.length === 0) continue
          const column = quoteIdent(attr.name)
          const codes = valueSet.map((code) => sqlLiteral(code)).join(", ")
          out.push(
            ...(yield* queryViolations(
              "value-set-membership",
              et.name,
              `SELECT s."id", s.${column} FROM ${table} s WHERE s.${column} IS NOT NULL AND s.${column} NOT IN (${codes}) ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
              (row) => `${et.name}.${attr.name} = "${String(row[1] ?? "")}" is outside its value set`
            ))
          )
        }
      }
      return out
    })
}

/**
 * Date-typed `<f>_start`/`<f>_end` attribute pairs of an entity type — i.e.
 * the columns produced by flattening a FHIR Period. Bare `start`/`end`
 * columns (Appointment, Slot) are deliberately NOT pairs: in FHIR R4 those
 * are two independent `instant` fields, the ontology does not relate them,
 * and the generator does not order them — an invariant over them would flag
 * clean worlds.
 */
const periodPairsOf = (et: EntityType): ReadonlyArray<{ readonly start: string; readonly end: string }> => {
  const dateNames = new Set(
    et.attributes.filter((a) => a.type === "date" || a.type === "datetime").map((a) => a.name)
  )
  const pairs: Array<{ readonly start: string; readonly end: string }> = []
  for (const name of dateNames) {
    if (!name.endsWith("_start")) continue
    const partner = `${name.slice(0, -6)}_end`
    if (dateNames.has(partner)) pairs.push({ start: name, end: partner })
  }
  return pairs
}

export const periodOrdering: SqlInvariant = {
  id: "period-ordering",
  describe: "every flattened Period (`<f>_start`/`<f>_end`) satisfies start <= end (ISO TEXT compares chronologically)",
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const out: InvariantViolation[] = []
      for (const et of ontology.entityTypes) {
        const table = quoteIdent(tableName(et.name))
        for (const pair of periodPairsOf(et)) {
          const start = quoteIdent(pair.start)
          const end = quoteIdent(pair.end)
          out.push(
            ...(yield* queryViolations(
              "period-ordering",
              et.name,
              `SELECT s."id", s.${start}, s.${end} FROM ${table} s WHERE s.${start} IS NOT NULL AND s.${end} IS NOT NULL AND s.${start} > s.${end} ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
              (row) => `${et.name}.${pair.start} "${String(row[1] ?? "")}" > ${pair.end} "${String(row[2] ?? "")}"`
            ))
          )
        }
      }
      return out
    })
}

export const uniqueIds: WorldInvariant = {
  id: "unique-ids",
  describe: "row ids are unique per entity type (checked on the world: duplicates cannot even load)",
  kind: "world",
  check: (_ontology, world) => {
    const out: InvariantViolation[] = []
    for (const [typeName, rows] of Object.entries(world)) {
      const seen = new Map<string, number>()
      for (const row of rows) {
        const id = row["id"]
        if (typeof id !== "string" || id.length === 0) {
          out.push({
            invariantId: "unique-ids",
            entityType: typeName,
            rowId: null,
            detail: `${typeName} row without a string id`
          })
          continue
        }
        seen.set(id, (seen.get(id) ?? 0) + 1)
      }
      for (const [id, count] of seen) {
        if (count > 1) {
          out.push({
            invariantId: "unique-ids",
            entityType: typeName,
            rowId: id,
            detail: `id "${id}" appears ${count} times in ${typeName}`
          })
        }
      }
    }
    return out
  }
}

export const noSelfReference: SqlInvariant = {
  id: "no-self-reference",
  describe: "no row references itself through a relation that may target its own entity type",
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const out: InvariantViolation[] = []
      for (const et of ontology.entityTypes) {
        const table = quoteIdent(tableName(et.name))
        for (const rel of et.relations) {
          if (!rel.target.includes(et.name)) continue
          const ref = quoteIdent(relationRefColumn(rel.name))
          // Multi-target: only a self-typed (or untyped) ref equal to the own
          // id is a self-link; a ref typed at another table is judged by
          // referential integrity instead.
          const typeFilter =
            rel.target.length > 1
              ? ` AND (s.${quoteIdent(relationRefTypeColumn(rel.name))} IS NULL OR s.${quoteIdent(relationRefTypeColumn(rel.name))} = ${sqlLiteral(et.name)})`
              : ""
          out.push(
            ...(yield* queryViolations(
              "no-self-reference",
              et.name,
              `SELECT s."id" FROM ${table} s WHERE s.${ref} = s."id"${typeFilter} ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
              (row) => `${et.name}[${String(row[0] ?? "")}].${rel.name} references itself`
            ))
          )
        }
      }
      return out
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Configurable invariant factories (FHIR specifics live in the configs below)
// ─────────────────────────────────────────────────────────────────────────────

export interface JoinConsistencyConfig {
  readonly id: string
  readonly describe: string
  /** Entity holding the reference under scrutiny, e.g. "Claim". */
  readonly child: string
  /** Relation from child to parent, e.g. "insurance_coverage". */
  readonly viaRelation: string
  /** The referenced entity, e.g. "Coverage". */
  readonly parent: string
  /** Relation on the child that must agree, e.g. "patient". */
  readonly childKeyRelation: string
  /** Relation on the parent that must agree, e.g. "beneficiary". */
  readonly parentKeyRelation: string
}

/**
 * "The chain resolves AND agrees": child.via must reach a parent row whose
 * key reference equals the child's key reference. Fires both when the via
 * reference dangles and when it reaches a row for a different key (e.g. a
 * Claim whose Coverage belongs to another patient). Inapplicable configs
 * (entity/relations absent from the ontology) check vacuously — the factory
 * keeps the engine generic across ontologies.
 */
export const makeJoinConsistencyInvariant = (config: JoinConsistencyConfig): SqlInvariant => ({
  id: config.id,
  describe: config.describe,
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const child = getEntityType(ontology, config.child)
      const parent = getEntityType(ontology, config.parent)
      const via = child?.relations.find((r) => r.name === config.viaRelation)
      const childKey = child?.relations.find((r) => r.name === config.childKeyRelation)
      const parentKey = parent?.relations.find((r) => r.name === config.parentKeyRelation)
      if (child === undefined || parent === undefined || via === undefined || childKey === undefined || parentKey === undefined) {
        return []
      }
      const viaRef = quoteIdent(relationRefColumn(via.name))
      const childKeyRef = quoteIdent(relationRefColumn(childKey.name))
      const parentKeyRef = quoteIdent(relationRefColumn(parentKey.name))
      const sql =
        `SELECT c."id", c.${viaRef} FROM ${quoteIdent(tableName(child.name))} c` +
        ` WHERE c.${viaRef} IS NOT NULL AND NOT EXISTS (` +
        `SELECT 1 FROM ${quoteIdent(tableName(parent.name))} p` +
        ` WHERE p."id" = c.${viaRef} AND p.${parentKeyRef} = c.${childKeyRef})` +
        ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`
      return yield* queryViolations(config.id, config.child, sql, (row) =>
        `${config.child}[${String(row[0] ?? "")}].${config.viaRelation} -> "${String(row[1] ?? "")}" does not reach a ${config.parent} agreeing on ${config.childKeyRelation}/${config.parentKeyRelation}`
      )
    })
})

export interface DateRangeConfig {
  readonly id: string
  readonly describe: string
  readonly entityType: string
  readonly attribute: string
  readonly min: string
  readonly max: string
}

/** Non-null dates of one attribute must lie in [min, max] (plain ISO TEXT comparison). */
export const makeDateRangeInvariant = (config: DateRangeConfig): SqlInvariant => ({
  id: config.id,
  describe: config.describe,
  kind: "sql",
  check: (ontology) =>
    Effect.gen(function* () {
      const et = getEntityType(ontology, config.entityType)
      if (et === undefined || !et.attributes.some((a) => a.name === config.attribute)) return []
      const column = quoteIdent(config.attribute)
      const sql =
        `SELECT s."id", s.${column} FROM ${quoteIdent(tableName(config.entityType))} s` +
        ` WHERE s.${column} IS NOT NULL AND (s.${column} < ${sqlLiteral(config.min)} OR s.${column} > ${sqlLiteral(config.max)})` +
        ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`
      return yield* queryViolations(config.id, config.entityType, sql, (row) =>
        `${config.entityType}.${config.attribute} = "${String(row[1] ?? "")}" outside [${config.min}, ${config.max}]`
      )
    })
})

/** Claim -> Coverage -> Patient: a claim's coverage must exist and belong to the claim's patient. */
export const claimCoveragePatientChain: SqlInvariant = makeJoinConsistencyInvariant({
  id: "claim-coverage-patient-chain",
  describe: "every Claim's insurance coverage resolves to a Coverage whose beneficiary is the claim's patient",
  child: "Claim",
  viaRelation: "insurance_coverage",
  parent: "Coverage",
  childKeyRelation: "patient",
  parentKeyRelation: "beneficiary"
})

/**
 * EOB <-> Claim agreement. Item-level adjudications are pruned by the depth-1
 * FHIR flattening (see ontology/model.ts), so "EOB totals reconcile with item
 * adjudications" has no generated counterpart; the checkable analogue the
 * generator does guarantee is that an EOB explains a claim OF THE SAME
 * PATIENT — which is what an orphaned or cross-wired EOB breaks.
 */
export const eobClaimConsistency: SqlInvariant = makeJoinConsistencyInvariant({
  id: "eob-claim-consistency",
  describe: "every ExplanationOfBenefit that references a Claim references one for its own patient",
  child: "ExplanationOfBenefit",
  viaRelation: "claim",
  parent: "Claim",
  childKeyRelation: "patient",
  parentKeyRelation: "patient"
})

export const birthDateSanity: SqlInvariant = makeDateRangeInvariant({
  id: "birthdate-sanity",
  describe: `Patient.birth_date lies in [1900-01-01, ${REFERENCE_DATE}] (nobody is born after the product's fixed today)`,
  entityType: "Patient",
  attribute: "birth_date",
  min: "1900-01-01",
  max: REFERENCE_DATE
})

/** The ontology-generic invariant core. */
export const standardInvariants: readonly Invariant[] = [
  referentialIntegrity,
  requiredPresent,
  valueSetMembership,
  periodOrdering,
  uniqueIds,
  noSelfReference
]

/** The full FHIR product set: generic core + FHIR-configured chain/range checks. */
export const fhirInvariants: readonly Invariant[] = [
  ...standardInvariants,
  claimCoveragePatientChain,
  eobClaimConsistency,
  birthDateSanity
]

// ─────────────────────────────────────────────────────────────────────────────
// Mutators
// ─────────────────────────────────────────────────────────────────────────────

export interface MutationResult {
  /** The mutated world (input world untouched — mutators are pure). */
  readonly world: InstanceWorld
  /** Human-readable description of the planted defect. */
  readonly note: string
}

export interface StressMutator {
  readonly id: string
  readonly describe: string
  /** Invariants this defect MUST trip; the matrix marks the run "ok" only when all of them fire. */
  readonly expectedInvariants: readonly string[]
  /** Plant the defect; null when the ontology/world offers no applicable target. */
  readonly mutate: (ontology: Ontology, world: InstanceWorld, rng: Rng) => MutationResult | null
}

const rowsOf = (world: InstanceWorld, typeName: string): ReadonlyArray<Row> => world[typeName] ?? []

const replaceRow = (world: InstanceWorld, typeName: string, index: number, next: Row): InstanceWorld => ({
  ...world,
  [typeName]: rowsOf(world, typeName).map((row, i) => (i === index ? next : row))
})

const rowId = (row: Row): string => (typeof row["id"] === "string" ? row["id"] : "?")

export interface DanglingReferenceConfig {
  readonly id: string
  readonly describe: string
  readonly entityType: string
  readonly relation: string
  readonly expectedInvariants: readonly string[]
}

/** Point one row's relation at an id that exists nowhere (the ref TYPE stays legal — the defect is purely the dangling id). */
export const makeDanglingReferenceMutator = (config: DanglingReferenceConfig): StressMutator => ({
  id: config.id,
  describe: config.describe,
  expectedInvariants: config.expectedInvariants,
  mutate: (ontology, world, rng) => {
    const et = getEntityType(ontology, config.entityType)
    const rel = et?.relations.find((r) => r.name === config.relation)
    const rows = rowsOf(world, config.entityType)
    if (et === undefined || rel === undefined || rows.length === 0) return null
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    const ghost = `ghost-${rng.uuid()}`
    const patch: Record<string, SqlValue> = { ...victim, [relationRefColumn(rel.name)]: ghost }
    if (rel.target.length > 1) {
      const typeCol = relationRefTypeColumn(rel.name)
      const existing = victim[typeCol]
      patch[typeCol] =
        typeof existing === "string" && rel.target.includes(existing)
          ? existing
          : (rel.target[0] as string)
    }
    return {
      world: replaceRow(world, config.entityType, index, patch),
      note: `${config.entityType}[${rowId(victim)}].${rel.name}_ref -> "${ghost}" (no such row)`
    }
  }
})

/** Null out a required attribute (prefers the configured one; falls back to any required attribute with rows). */
const makeMissingRequiredMutator = (prefer: {
  readonly entityType: string
  readonly attribute: string
}): StressMutator => ({
  id: "missing-required",
  describe: "drop a required attribute (set it to NULL)",
  expectedInvariants: ["required-present"],
  mutate: (ontology, world, rng) => {
    const candidates: Array<{ readonly entityType: string; readonly attribute: string }> = []
    for (const et of ontology.entityTypes) {
      if (rowsOf(world, et.name).length === 0) continue
      for (const attr of et.attributes) {
        if (attr.required) candidates.push({ entityType: et.name, attribute: attr.name })
      }
    }
    if (candidates.length === 0) return null
    const preferred = candidates.find(
      (c) => c.entityType === prefer.entityType && c.attribute === prefer.attribute
    )
    const chosen = preferred ?? rng.pick(candidates)
    const rows = rowsOf(world, chosen.entityType)
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    return {
      world: replaceRow(world, chosen.entityType, index, { ...victim, [chosen.attribute]: null }),
      note: `${chosen.entityType}[${rowId(victim)}].${chosen.attribute} (required) -> NULL`
    }
  }
})

/** Write a code no value set contains (prefers the configured attribute). */
const makeIllegalCodeMutator = (prefer: {
  readonly entityType: string
  readonly attribute: string
}): StressMutator => ({
  id: "illegal-code",
  describe: "set a value-set attribute to a code outside its value set",
  expectedInvariants: ["value-set-membership"],
  mutate: (ontology, world, rng) => {
    const candidates: Array<{ readonly entityType: string; readonly attribute: string }> = []
    for (const et of ontology.entityTypes) {
      if (rowsOf(world, et.name).length === 0) continue
      for (const attr of et.attributes) {
        if (attr.valueSet !== undefined && attr.valueSet.length > 0) {
          candidates.push({ entityType: et.name, attribute: attr.name })
        }
      }
    }
    if (candidates.length === 0) return null
    const preferred = candidates.find(
      (c) => c.entityType === prefer.entityType && c.attribute === prefer.attribute
    )
    const chosen = preferred ?? rng.pick(candidates)
    const rows = rowsOf(world, chosen.entityType)
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    return {
      world: replaceRow(world, chosen.entityType, index, { ...victim, [chosen.attribute]: "__illegal-code__" }),
      note: `${chosen.entityType}[${rowId(victim)}].${chosen.attribute} -> "__illegal-code__" (not in value set)`
    }
  }
})

/** Force start > end on a period pair (prefers the configured entity's first pair). */
const makeReversedPeriodMutator = (prefer: { readonly entityType: string }): StressMutator => ({
  id: "reversed-period",
  describe: "reverse a period so start > end",
  expectedInvariants: ["period-ordering"],
  mutate: (ontology, world, rng) => {
    const candidates: Array<{
      readonly entityType: string
      readonly pair: { readonly start: string; readonly end: string }
    }> = []
    for (const et of ontology.entityTypes) {
      if (rowsOf(world, et.name).length === 0) continue
      for (const pair of periodPairsOf(et)) candidates.push({ entityType: et.name, pair })
    }
    if (candidates.length === 0) return null
    const chosen = candidates.find((c) => c.entityType === prefer.entityType) ?? rng.pick(candidates)
    const rows = rowsOf(world, chosen.entityType)
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    // Deterministic, unambiguously reversed constants: dates carry no other
    // invariant (not required-null, not value-set), so ONLY ordering breaks.
    const patch: Record<string, SqlValue> = {
      ...victim,
      [chosen.pair.start]: "2025-12-31",
      [chosen.pair.end]: "2020-01-01"
    }
    return {
      world: replaceRow(world, chosen.entityType, index, patch),
      note: `${chosen.entityType}[${rowId(victim)}].${chosen.pair.start}/"${chosen.pair.end}" reversed (2025-12-31 > 2020-01-01)`
    }
  }
})

/** Give one row another row's id. The world invariant must catch this: the load itself dies on the PRIMARY KEY. */
const duplicateIdMutatorImpl: StressMutator = {
  id: "duplicate-id",
  describe: "duplicate an existing row id within one entity type",
  expectedInvariants: ["unique-ids"],
  mutate: (_ontology, world, rng) => {
    const candidates = Object.keys(world)
      .filter((typeName) => rowsOf(world, typeName).length >= 2)
      .sort()
    if (candidates.length === 0) return null
    const typeName = rng.pick(candidates)
    const rows = rowsOf(world, typeName)
    const i = rng.int(0, rows.length - 1)
    const j = (i + rng.int(1, rows.length - 1)) % rows.length
    const victim = rows[j] as Row
    const stolen = rowId(rows[i] as Row)
    return {
      world: replaceRow(world, typeName, j, { ...victim, id: stolen }),
      note: `${typeName}[${rowId(victim)}].id -> "${stolen}" (already taken)`
    }
  }
}

export interface AttributeValueConfig {
  readonly id: string
  readonly describe: string
  readonly entityType: string
  readonly attribute: string
  readonly value: SqlValue
  readonly expectedInvariants: readonly string[]
}

/** Overwrite one attribute with a fixed defective value. */
export const makeAttributeValueMutator = (config: AttributeValueConfig): StressMutator => ({
  id: config.id,
  describe: config.describe,
  expectedInvariants: config.expectedInvariants,
  mutate: (ontology, world, rng) => {
    const et = getEntityType(ontology, config.entityType)
    const rows = rowsOf(world, config.entityType)
    if (et === undefined || !et.attributes.some((a) => a.name === config.attribute) || rows.length === 0) {
      return null
    }
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    return {
      world: replaceRow(world, config.entityType, index, { ...victim, [config.attribute]: config.value }),
      note: `${config.entityType}[${rowId(victim)}].${config.attribute} -> ${sqlLiteral(config.value)}`
    }
  }
})

/**
 * Wire a row to ITSELF through a relation that may target its own type
 * (Organization.part_of, Encounter.part_of, ...). Referential integrity
 * stays green — the id resolves, to the row itself — so only the dedicated
 * no-self-reference invariant can catch it. That separation is the point.
 */
const selfReferenceMutatorImpl: StressMutator = {
  id: "self-reference",
  describe: "make a row reference itself through a self-targetable relation",
  expectedInvariants: ["no-self-reference"],
  mutate: (ontology, world, rng) => {
    const candidates: Array<{ readonly entityType: string; readonly relation: Relation }> = []
    for (const et of ontology.entityTypes) {
      if (rowsOf(world, et.name).length === 0) continue
      for (const rel of et.relations) {
        if (rel.target.includes(et.name)) candidates.push({ entityType: et.name, relation: rel })
      }
    }
    if (candidates.length === 0) return null
    const chosen = rng.pick(candidates)
    const rows = rowsOf(world, chosen.entityType)
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    const patch: Record<string, SqlValue> = {
      ...victim,
      [relationRefColumn(chosen.relation.name)]: rowId(victim)
    }
    if (chosen.relation.target.length > 1) {
      patch[relationRefTypeColumn(chosen.relation.name)] = chosen.entityType
    }
    return {
      world: replaceRow(world, chosen.entityType, index, patch),
      note: `${chosen.entityType}[${rowId(victim)}].${chosen.relation.name} -> itself`
    }
  }
}

// ── The 8 named mutators (SPEC), FHIR-preferred targets, generic fallbacks ──

export const danglingReferenceMutator: StressMutator = makeDanglingReferenceMutator({
  id: "dangling-reference",
  describe: "point a Claim at a Coverage id that does not exist",
  entityType: "Claim",
  relation: "insurance_coverage",
  expectedInvariants: ["referential-integrity", "claim-coverage-patient-chain"]
})

export const missingRequiredMutator: StressMutator = makeMissingRequiredMutator({
  entityType: "Claim",
  attribute: "created"
})

export const illegalCodeMutator: StressMutator = makeIllegalCodeMutator({
  entityType: "Claim",
  attribute: "status"
})

export const reversedPeriodMutator: StressMutator = makeReversedPeriodMutator({ entityType: "Claim" })

export const orphanEobMutator: StressMutator = makeDanglingReferenceMutator({
  id: "orphan-eob",
  describe: "ExplanationOfBenefit whose claim_ref resolves nowhere",
  entityType: "ExplanationOfBenefit",
  relation: "claim",
  expectedInvariants: ["referential-integrity", "eob-claim-consistency"]
})

export const duplicateIdMutator: StressMutator = duplicateIdMutatorImpl

export const futureDatedBirthMutator: StressMutator = makeAttributeValueMutator({
  id: "future-dated-birth",
  describe: "Patient born after the product's fixed today",
  entityType: "Patient",
  attribute: "birth_date",
  value: "2099-01-01",
  expectedInvariants: ["birthdate-sanity"]
})

export const selfReferenceMutator: StressMutator = selfReferenceMutatorImpl

export const fhirStressMutators: readonly StressMutator[] = [
  danglingReferenceMutator,
  missingRequiredMutator,
  illegalCodeMutator,
  reversedPeriodMutator,
  orphanEobMutator,
  duplicateIdMutator,
  futureDatedBirthMutator,
  selfReferenceMutator
]

/** Alias for the default mutator set at the package root. */
export const stressMutators: readonly StressMutator[] = fhirStressMutators

// ─────────────────────────────────────────────────────────────────────────────
// replay + runStress
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplayResult {
  readonly violations: readonly InvariantViolation[]
  /** Distinct invariant ids with at least one violation. */
  readonly firedInvariants: readonly string[]
  /** Load failure message (e.g. duplicate PRIMARY KEY), or null. */
  readonly loadError: string | null
  /** SQL invariants that could not run because the world failed to load. */
  readonly skippedInvariants: readonly string[]
}

/**
 * Load a world and run every invariant against it; per-invariant violations.
 * World-kind invariants run BEFORE the load (a duplicate-id world cannot
 * load at all — the PRIMARY KEY refuses it — so unique-ids must observe the
 * world, not the store). A failed load is reported, and SQL invariants are
 * marked skipped rather than silently green.
 */
export const replay = (
  world: InstanceWorld,
  ontology: Ontology,
  invariants: readonly Invariant[] = fhirInvariants
): Effect.Effect<ReplayResult, DbError, DuckDb> =>
  Effect.gen(function* () {
    const violations: InvariantViolation[] = []
    for (const invariant of invariants) {
      if (invariant.kind === "world") violations.push(...invariant.check(ontology, world))
    }

    const loaded = yield* Effect.either(loadWorld(world, ontology))
    let loadError: string | null = null
    const skippedInvariants: string[] = []
    if (loaded._tag === "Left") {
      loadError = loaded.left.message
      for (const invariant of invariants) {
        if (invariant.kind === "sql") skippedInvariants.push(invariant.id)
      }
    } else {
      for (const invariant of invariants) {
        if (invariant.kind === "sql") violations.push(...(yield* invariant.check(ontology)))
      }
    }

    return {
      violations,
      firedInvariants: [...new Set(violations.map((v) => v.invariantId))],
      loadError,
      skippedInvariants
    }
  })

export interface StressMutatorRun {
  readonly mutatorId: string
  readonly describe: string
  /** False when the mutator found no applicable target in this ontology/world. */
  readonly applied: boolean
  readonly note: string | null
  readonly expectedInvariants: readonly string[]
  readonly firedInvariants: readonly string[]
  /** All expected invariants fired. */
  readonly expectationMet: boolean
  readonly replay: ReplayResult | null
}

export interface StressReport {
  readonly seed: number
  readonly invariantIds: readonly string[]
  readonly clean: ReplayResult
  /** The clean generated world replayed with zero violations and loaded cleanly. */
  readonly cleanPassed: boolean
  readonly runs: readonly StressMutatorRun[]
  /** cleanPassed AND every mutator applied AND tripped its expected invariant(s). */
  readonly passed: boolean
}

export interface StressRunOptions {
  readonly ontology: Ontology
  /** The clean world (generateWorld output). */
  readonly world: InstanceWorld
  readonly seed: number
  readonly mutators?: readonly StressMutator[]
  readonly invariants?: readonly Invariant[]
}

/** Deterministic per-mutator seed derivation, independent of list order. */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * The mutator x invariant matrix: replay the clean world (must be silent),
 * then each mutated world (its expected invariants must fire). Sequential by
 * design — one DuckDb connection — and each replay reloads the world
 * (loadWorld drops/recreates tables), so runs are hermetic.
 */
export const runStress = (
  opts: StressRunOptions
): Effect.Effect<StressReport, DbError, DuckDb> =>
  Effect.gen(function* () {
    const mutators = opts.mutators ?? fhirStressMutators
    const invariants = opts.invariants ?? fhirInvariants

    const clean = yield* replay(opts.world, opts.ontology, invariants)
    const cleanPassed = clean.violations.length === 0 && clean.loadError === null

    const runs: StressMutatorRun[] = []
    for (const mutator of mutators) {
      const rng = makeRng((opts.seed ^ fnv1a(mutator.id)) >>> 0)
      const mutation = mutator.mutate(opts.ontology, opts.world, rng)
      if (mutation === null) {
        runs.push({
          mutatorId: mutator.id,
          describe: mutator.describe,
          applied: false,
          note: null,
          expectedInvariants: mutator.expectedInvariants,
          firedInvariants: [],
          expectationMet: false,
          replay: null
        })
        continue
      }
      const result = yield* replay(mutation.world, opts.ontology, invariants)
      runs.push({
        mutatorId: mutator.id,
        describe: mutator.describe,
        applied: true,
        note: mutation.note,
        expectedInvariants: mutator.expectedInvariants,
        firedInvariants: result.firedInvariants,
        expectationMet: mutator.expectedInvariants.every((id) => result.firedInvariants.includes(id)),
        replay: result
      })
    }

    return {
      seed: opts.seed,
      invariantIds: invariants.map((i) => i.id),
      clean,
      cleanPassed,
      runs,
      passed: cleanPassed && runs.every((r) => r.applied && r.expectationMet)
    }
  })

/** Render the mutator x invariant matrix as plain text (the CLI's sim output). */
export const formatStressReport = (report: StressReport): string => {
  const lines: string[] = [`Stress run (seed ${report.seed}) — mutator x invariant matrix`]
  report.invariantIds.forEach((id, i) => lines.push(`  [${String(i + 1)}] ${id}`))

  const names = ["clean world", ...report.runs.map((r) => r.mutatorId)]
  const nameWidth = Math.max(...names.map((n) => n.length))
  const cellWidth = Math.max(...report.invariantIds.map((_, i) => `[${String(i + 1)}]`.length), 4)

  const cellsFor = (
    violations: readonly InvariantViolation[],
    skipped: readonly string[],
    expected: readonly string[]
  ): readonly string[] =>
    report.invariantIds.map((id) => {
      if (skipped.includes(id)) return "x"
      const count = violations.filter((v) => v.invariantId === id).length
      const marker = expected.includes(id) ? "*" : ""
      return count === 0 ? (marker === "" ? "." : "*0") : `${marker}${String(count)}`
    })

  const rowLine = (name: string, cells: readonly string[], verdict: string): string =>
    `${name.padEnd(nameWidth)}  ${cells.map((c) => c.padStart(cellWidth)).join(" ")}  ${verdict}`

  lines.push(
    "",
    rowLine(
      "",
      report.invariantIds.map((_, i) => `[${String(i + 1)}]`),
      "verdict"
    )
  )
  lines.push(
    rowLine(
      "clean world",
      cellsFor(report.clean.violations, report.clean.skippedInvariants, []),
      report.cleanPassed ? "ok (zero violations)" : "FAIL (clean world must be silent)"
    )
  )
  for (const run of report.runs) {
    const verdict = !run.applied
      ? "n/a (no applicable target)"
      : run.expectationMet
        ? "ok"
        : "MISS (expected invariant stayed silent)"
    lines.push(
      rowLine(
        run.mutatorId,
        cellsFor(run.replay?.violations ?? [], run.replay?.skippedInvariants ?? [], run.expectedInvariants),
        verdict
      )
    )
  }

  lines.push(
    "",
    "legend: *N expected invariant fired (N violations), *0 expected but silent, . zero, x skipped (world failed to load, e.g. duplicate PRIMARY KEY)"
  )
  lines.push(
    report.passed
      ? "Stress contract holds: the clean world is clean and every planted defect fires its invariant."
      : "Stress contract VIOLATED."
  )
  return lines.join("\n")
}
