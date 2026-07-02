/**
 * Stage 2b — adversarial stress (split from sim.ts per SPEC v2's one-file
 * split allowance; sim.ts re-exports the public surface). Mutators plant
 * exactly one named defect in the clean world; invariants (SQL over the
 * loaded world, or pure over the in-memory world) must catch it. runStress
 * produces the mutator x invariant matrix: the clean world replays silent and
 * every planted defect fires its expected invariant(s) — if a defect class
 * stops firing, the validation layer itself has regressed. The closed-world
 * analogue of reasoner (ABox) consistency checking.
 */
import { MemorySqlError, getEntityType } from "./ontology.js"
import type { EntityType, Ontology, Relation } from "./ontology.js"
import { REFERENCE_DATE, makeRng } from "./rng.js"
import type { Rng } from "./rng.js"
import { loadWorld, openStore, quoteIdent, relationRefColumn, relationRefTypeColumn, sqlLiteral, tableName } from "./store.js"
import type { InstanceWorld, Row, SqlValue, Store } from "./store.js"
import { generateWorld } from "./synth.js"

/** Deterministic per-name seed derivation, independent of list order (shared with the metamorphic runner). */
export const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export const describeCause = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : cause !== null && typeof cause === "object" && "message" in cause
      ? String((cause as { readonly message: unknown }).message)
      : String(cause)

// ── Invariants ───────────────────────────────────────────────────────────────

export interface InvariantViolation { readonly invariantId: string; readonly entityType: string; readonly rowId: string | null; readonly detail: string }

/** Pure check over the in-memory world. Needed where the store cannot help:
 * duplicate ids violate `id TEXT PRIMARY KEY`, so a duplicate-id world fails
 * the LOAD — the invariant must see the world before the store does. */
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
  readonly check: (store: Store, ontology: Ontology) => Promise<readonly InvariantViolation[]>
}

export type Invariant = WorldInvariant | SqlInvariant

/** Cap per violation query — reports stay readable, defects still undeniable. */
const VIOLATION_LIMIT = 25

interface ViolationQuery { readonly entityType: string; readonly sql: string; readonly detail: (row: ReadonlyArray<SqlValue>) => string }

/** SQL invariant from a list of violation queries (first selected column = row id). */
const sqlInvariant = (id: string, describe: string, queries: (ontology: Ontology) => readonly ViolationQuery[]): SqlInvariant => ({
  id,
  describe,
  kind: "sql",
  check: async (store, ontology) => {
    const out: InvariantViolation[] = []
    for (const q of queries(ontology)) {
      for (const row of (await store.query(q.sql)).rows) {
        out.push({ invariantId: id, entityType: q.entityType, rowId: typeof row[0] === "string" ? row[0] : null, detail: q.detail(row) })
      }
    }
    return out
  }
})

/** Multi-target refs resolve only when `<rel>_ref_type` names a relation target AND
 * the id exists there; a NULL/unknown type with a non-null ref is a defect. */
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
  const refType = quoteIdent(relationRefTypeColumn(rel.name))
  const resolved = rel.target
    .map((t) => `(s.${refType} = ${sqlLiteral(t)} AND EXISTS (SELECT 1 FROM ${quoteIdent(tableName(t))} t WHERE t."id" = s.${ref}))`)
    .join(" OR ")
  return (
    `SELECT s."id", s.${ref} FROM ${table} s WHERE s.${ref} IS NOT NULL` +
    ` AND (s.${refType} IS NULL OR NOT (${resolved}))` +
    ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`
  )
}

const referentialIntegrity: SqlInvariant = sqlInvariant(
  "referential-integrity",
  "every non-null relation reference resolves to an existing row of a declared target type",
  (ontology) =>
    ontology.entityTypes.flatMap((et) =>
      et.relations.map((rel) => ({
        entityType: et.name,
        sql: referentialIntegritySql(et, rel),
        detail: (row: ReadonlyArray<SqlValue>) => `${et.name}.${rel.name}_ref = "${String(row[1] ?? "")}" does not resolve`
      }))
    )
)

const requiredPresent: SqlInvariant = sqlInvariant(
  "required-present",
  "required attributes and required relations are never NULL",
  (ontology) =>
    ontology.entityTypes.flatMap((et) =>
      [
        ...et.attributes.filter((a) => a.required).map((a) => a.name),
        ...et.relations.filter((r) => r.required).map((r) => relationRefColumn(r.name))
      ].map((column) => ({
        entityType: et.name,
        sql: `SELECT s."id" FROM ${quoteIdent(tableName(et.name))} s WHERE s.${quoteIdent(column)} IS NULL ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
        detail: () => `${et.name}.${column} is required but NULL`
      }))
    )
)

const valueSetMembership: SqlInvariant = sqlInvariant(
  "value-set-membership",
  "every non-null value of a value-set attribute is one of its codes",
  (ontology) =>
    ontology.entityTypes.flatMap((et) =>
      et.attributes
        .filter((attr) => attr.valueSet !== undefined && attr.valueSet.length > 0)
        .map((attr) => {
          const column = quoteIdent(attr.name)
          const codes = (attr.valueSet ?? []).map((code) => sqlLiteral(code)).join(", ")
          return {
            entityType: et.name,
            sql: `SELECT s."id", s.${column} FROM ${quoteIdent(tableName(et.name))} s WHERE s.${column} IS NOT NULL AND s.${column} NOT IN (${codes}) ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
            detail: (row: ReadonlyArray<SqlValue>) => `${et.name}.${attr.name} = "${String(row[1] ?? "")}" is outside its value set`
          }
        })
    )
)

/** Date-typed `<f>_start`/`<f>_end` pairs of an entity type — the columns of a
 * flattened FHIR Period. Bare `start`/`end` columns (Appointment, Slot) are
 * deliberately NOT pairs: in FHIR R4 those are two independent `instant` fields
 * the ontology does not relate and the generator does not order. */
const periodPairsOf = (et: EntityType): ReadonlyArray<{ readonly start: string; readonly end: string }> => {
  const dateNames = new Set(et.attributes.filter((a) => a.type === "date" || a.type === "datetime").map((a) => a.name))
  const pairs: Array<{ readonly start: string; readonly end: string }> = []
  for (const name of dateNames) {
    if (name.endsWith("_start") && dateNames.has(`${name.slice(0, -6)}_end`)) pairs.push({ start: name, end: `${name.slice(0, -6)}_end` })
  }
  return pairs
}

const periodOrdering: SqlInvariant = sqlInvariant(
  "period-ordering",
  "every flattened Period (`<f>_start`/`<f>_end`) satisfies start <= end (ISO TEXT compares chronologically)",
  (ontology) =>
    ontology.entityTypes.flatMap((et) =>
      periodPairsOf(et).map((pair) => {
        const start = quoteIdent(pair.start)
        const end = quoteIdent(pair.end)
        return {
          entityType: et.name,
          sql: `SELECT s."id", s.${start}, s.${end} FROM ${quoteIdent(tableName(et.name))} s WHERE s.${start} IS NOT NULL AND s.${end} IS NOT NULL AND s.${start} > s.${end} ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
          detail: (row: ReadonlyArray<SqlValue>) => `${et.name}.${pair.start} "${String(row[1] ?? "")}" > ${pair.end} "${String(row[2] ?? "")}"`
        }
      })
    )
)

const uniqueIds: WorldInvariant = {
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
          out.push({ invariantId: "unique-ids", entityType: typeName, rowId: null, detail: `${typeName} row without a string id` })
          continue
        }
        seen.set(id, (seen.get(id) ?? 0) + 1)
      }
      for (const [id, count] of seen) {
        if (count > 1) out.push({ invariantId: "unique-ids", entityType: typeName, rowId: id, detail: `id "${id}" appears ${count} times in ${typeName}` })
      }
    }
    return out
  }
}

const noSelfReference: SqlInvariant = sqlInvariant(
  "no-self-reference",
  "no row references itself through a relation that may target its own entity type",
  (ontology) =>
    ontology.entityTypes.flatMap((et) =>
      et.relations
        .filter((rel) => rel.target.includes(et.name))
        .map((rel) => {
          const ref = quoteIdent(relationRefColumn(rel.name))
          // Multi-target: only a self-typed (or untyped) ref equal to the own id is a
          // self-link; a ref typed at another table is judged by referential integrity.
          const typeFilter =
            rel.target.length > 1
              ? ` AND (s.${quoteIdent(relationRefTypeColumn(rel.name))} IS NULL OR s.${quoteIdent(relationRefTypeColumn(rel.name))} = ${sqlLiteral(et.name)})`
              : ""
          return {
            entityType: et.name,
            sql: `SELECT s."id" FROM ${quoteIdent(tableName(et.name))} s WHERE s.${ref} = s."id"${typeFilter} ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
            detail: (row: ReadonlyArray<SqlValue>) => `${et.name}[${String(row[0] ?? "")}].${rel.name} references itself`
          }
        })
    )
)

/** "The chain resolves AND agrees": child.via must reach a parent row whose key
 * reference equals the child's key reference — fires both when the via reference
 * dangles and when it reaches a row for a different key. Configs whose
 * entities/relations are absent from the ontology check vacuously. */
const joinConsistencyInvariant = (config: {
  readonly id: string; readonly describe: string; readonly child: string; readonly viaRelation: string
  readonly parent: string; readonly childKeyRelation: string; readonly parentKeyRelation: string
}): SqlInvariant =>
  sqlInvariant(config.id, config.describe, (ontology) => {
    const child = getEntityType(ontology, config.child)
    const parent = getEntityType(ontology, config.parent)
    const via = child?.relations.find((r) => r.name === config.viaRelation)
    const childKey = child?.relations.find((r) => r.name === config.childKeyRelation)
    const parentKey = parent?.relations.find((r) => r.name === config.parentKeyRelation)
    if (child === undefined || parent === undefined || via === undefined || childKey === undefined || parentKey === undefined) return []
    const viaRef = quoteIdent(relationRefColumn(via.name))
    const childKeyRef = quoteIdent(relationRefColumn(childKey.name))
    const parentKeyRef = quoteIdent(relationRefColumn(parentKey.name))
    return [
      {
        entityType: config.child,
        sql:
          `SELECT c."id", c.${viaRef} FROM ${quoteIdent(tableName(child.name))} c` +
          ` WHERE c.${viaRef} IS NOT NULL AND NOT EXISTS (` +
          `SELECT 1 FROM ${quoteIdent(tableName(parent.name))} p` +
          ` WHERE p."id" = c.${viaRef} AND p.${parentKeyRef} = c.${childKeyRef})` +
          ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
        detail: (row: ReadonlyArray<SqlValue>) =>
          `${config.child}[${String(row[0] ?? "")}].${config.viaRelation} -> "${String(row[1] ?? "")}" does not reach a ${config.parent} agreeing on ${config.childKeyRelation}/${config.parentKeyRelation}`
      }
    ]
  })

/** Claim -> Coverage -> Patient: a claim's coverage must exist and belong to the claim's patient. */
const claimCoveragePatientChain: SqlInvariant = joinConsistencyInvariant({
  id: "claim-coverage-patient-chain",
  describe: "every Claim's insurance coverage resolves to a Coverage whose beneficiary is the claim's patient",
  child: "Claim", viaRelation: "insurance_coverage", parent: "Coverage", childKeyRelation: "patient", parentKeyRelation: "beneficiary"
})

/** EOB <-> Claim agreement. Item-level adjudications are pruned by the depth-1
 * flattening, so the checkable analogue the generator guarantees is that an EOB
 * explains a claim OF THE SAME PATIENT — what an orphaned/cross-wired EOB breaks. */
const eobClaimConsistency: SqlInvariant = joinConsistencyInvariant({
  id: "eob-claim-consistency",
  describe: "every ExplanationOfBenefit that references a Claim references one for its own patient",
  child: "ExplanationOfBenefit", viaRelation: "claim", parent: "Claim", childKeyRelation: "patient", parentKeyRelation: "patient"
})

/** Non-null Patient.birth_date must lie in [1900-01-01, REFERENCE_DATE] (ISO TEXT comparison). */
const birthDateSanity: SqlInvariant = sqlInvariant(
  "birthdate-sanity",
  `Patient.birth_date lies in [1900-01-01, ${REFERENCE_DATE}] (nobody is born after the product's fixed today)`,
  (ontology) => {
    const et = getEntityType(ontology, "Patient")
    if (et === undefined || !et.attributes.some((a) => a.name === "birth_date")) return []
    return [
      {
        entityType: "Patient",
        sql:
          `SELECT s."id", s."birth_date" FROM ${quoteIdent(tableName("Patient"))} s` +
          ` WHERE s."birth_date" IS NOT NULL AND (s."birth_date" < '1900-01-01' OR s."birth_date" > ${sqlLiteral(REFERENCE_DATE)})` +
          ` ORDER BY 1 LIMIT ${VIOLATION_LIMIT}`,
        detail: (row: ReadonlyArray<SqlValue>) => `Patient.birth_date = "${String(row[1] ?? "")}" outside [1900-01-01, ${REFERENCE_DATE}]`
      }
    ]
  }
)

/** The full FHIR product set: the ontology-generic core (first six) + FHIR-configured chain/range checks. */
export const fhirInvariants: readonly Invariant[] = [
  referentialIntegrity, requiredPresent, valueSetMembership, periodOrdering, uniqueIds, noSelfReference,
  claimCoveragePatientChain, eobClaimConsistency, birthDateSanity
]

// ── Mutators ─────────────────────────────────────────────────────────────────

/** The mutated world (input world untouched — mutators are pure) + a description of the planted defect. */
export interface MutationResult { readonly world: InstanceWorld; readonly note: string }

/** `expectedInvariants` MUST all trip for the matrix to mark the run "ok";
 * `mutate` returns null when the ontology/world offers no applicable target. */
export interface StressMutator {
  readonly id: string
  readonly describe: string
  readonly expectedInvariants: readonly string[]
  readonly mutate: (ontology: Ontology, world: InstanceWorld, rng: Rng) => MutationResult | null
}

const rowsOf = (world: InstanceWorld, typeName: string): ReadonlyArray<Row> => world[typeName] ?? []

const replaceRow = (world: InstanceWorld, typeName: string, index: number, next: Row): InstanceWorld => ({
  ...world,
  [typeName]: rowsOf(world, typeName).map((row, i) => (i === index ? next : row))
})

const rowId = (row: Row): string => (typeof row["id"] === "string" ? row["id"] : "?")

/** Point one row's relation at an id that exists nowhere (the ref TYPE stays legal — the defect is purely the dangling id). */
const danglingReferenceMutator = (config: {
  readonly id: string; readonly describe: string; readonly entityType: string; readonly relation: string
  readonly expectedInvariants: readonly string[]
}): StressMutator => ({
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
      patch[typeCol] = typeof existing === "string" && rel.target.includes(existing) ? existing : (rel.target[0] as string)
    }
    return { world: replaceRow(world, config.entityType, index, patch), note: `${config.entityType}[${rowId(victim)}].${rel.name}_ref -> "${ghost}" (no such row)` }
  }
})

/** Mutator over a candidate list: prefer the configured target (deterministic on the
 * FHIR ontology), else rng.pick a candidate, then patch one random row of its type. */
const pickRowMutator = <C extends { readonly entityType: string }>(config: {
  readonly id: string
  readonly describe: string
  readonly expectedInvariants: readonly string[]
  readonly candidates: (ontology: Ontology, world: InstanceWorld) => readonly C[]
  readonly prefer: (candidate: C) => boolean
  readonly apply: (candidate: C, victim: Row) => { readonly values: Record<string, SqlValue>; readonly note: string }
}): StressMutator => ({
  id: config.id,
  describe: config.describe,
  expectedInvariants: config.expectedInvariants,
  mutate: (ontology, world, rng) => {
    const candidates = config.candidates(ontology, world)
    if (candidates.length === 0) return null
    const chosen = candidates.find(config.prefer) ?? rng.pick(candidates)
    const rows = rowsOf(world, chosen.entityType)
    const index = rng.int(0, rows.length - 1)
    const victim = rows[index] as Row
    const { values, note } = config.apply(chosen, victim)
    return { world: replaceRow(world, chosen.entityType, index, { ...victim, ...values }), note }
  }
})

/** Attribute candidates over populated entity types, filtered by `keep`. */
const attributeCandidates =
  (keep: (attr: { readonly required: boolean; readonly valueSet?: readonly string[] }) => boolean) =>
  (ontology: Ontology, world: InstanceWorld): ReadonlyArray<{ readonly entityType: string; readonly attribute: string }> =>
    ontology.entityTypes
      .filter((et) => rowsOf(world, et.name).length > 0)
      .flatMap((et) => et.attributes.filter(keep).map((attr) => ({ entityType: et.name, attribute: attr.name })))

/** Give one row another row's id. The world invariant must catch this: the load itself dies on the PRIMARY KEY. */
export const duplicateIdMutator: StressMutator = {
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
    return { world: replaceRow(world, typeName, j, { ...victim, id: stolen }), note: `${typeName}[${rowId(victim)}].id -> "${stolen}" (already taken)` }
  }
}

/** The 8 named mutators (SPEC) — FHIR-preferred targets, generic fallbacks.
 * self-reference is the separation case: referential integrity stays green (the
 * id resolves, to the row itself), so only no-self-reference can catch it. */
export const fhirStressMutators: readonly StressMutator[] = [
  danglingReferenceMutator({
    id: "dangling-reference",
    describe: "point a Claim at a Coverage id that does not exist",
    entityType: "Claim",
    relation: "insurance_coverage",
    expectedInvariants: ["referential-integrity", "claim-coverage-patient-chain"]
  }),
  pickRowMutator({
    id: "missing-required",
    describe: "drop a required attribute (set it to NULL)",
    expectedInvariants: ["required-present"],
    candidates: attributeCandidates((attr) => attr.required),
    prefer: (c) => c.entityType === "Claim" && c.attribute === "created",
    apply: (c, victim) => ({ values: { [c.attribute]: null }, note: `${c.entityType}[${rowId(victim)}].${c.attribute} (required) -> NULL` })
  }),
  pickRowMutator({
    id: "illegal-code",
    describe: "set a value-set attribute to a code outside its value set",
    expectedInvariants: ["value-set-membership"],
    candidates: attributeCandidates((attr) => attr.valueSet !== undefined && attr.valueSet.length > 0),
    prefer: (c) => c.entityType === "Claim" && c.attribute === "status",
    apply: (c, victim) => ({
      values: { [c.attribute]: "__illegal-code__" },
      note: `${c.entityType}[${rowId(victim)}].${c.attribute} -> "__illegal-code__" (not in value set)`
    })
  }),
  pickRowMutator({
    id: "reversed-period",
    describe: "reverse a period so start > end",
    expectedInvariants: ["period-ordering"],
    candidates: (ontology, world) =>
      ontology.entityTypes
        .filter((et) => rowsOf(world, et.name).length > 0)
        .flatMap((et) => periodPairsOf(et).map((pair) => ({ entityType: et.name, pair }))),
    prefer: (c) => c.entityType === "Claim",
    // Deterministic, unambiguously reversed constants: dates carry no other
    // invariant (not required-null, not value-set), so ONLY ordering breaks.
    apply: (c, victim) => ({
      values: { [c.pair.start]: "2025-12-31", [c.pair.end]: "2020-01-01" },
      note: `${c.entityType}[${rowId(victim)}].${c.pair.start}/"${c.pair.end}" reversed (2025-12-31 > 2020-01-01)`
    })
  }),
  danglingReferenceMutator({
    id: "orphan-eob",
    describe: "ExplanationOfBenefit whose claim_ref resolves nowhere",
    entityType: "ExplanationOfBenefit",
    relation: "claim",
    expectedInvariants: ["referential-integrity", "eob-claim-consistency"]
  }),
  duplicateIdMutator,
  pickRowMutator({
    id: "future-dated-birth",
    describe: "Patient born after the product's fixed today",
    expectedInvariants: ["birthdate-sanity"],
    candidates: (ontology, world) => {
      const et = getEntityType(ontology, "Patient")
      const ok = et !== undefined && et.attributes.some((a) => a.name === "birth_date") && rowsOf(world, "Patient").length > 0
      return ok ? [{ entityType: "Patient" }] : []
    },
    prefer: () => true,
    apply: (_c, victim) => ({ values: { birth_date: "2099-01-01" }, note: `Patient[${rowId(victim)}].birth_date -> '2099-01-01'` })
  }),
  pickRowMutator({
    id: "self-reference",
    describe: "make a row reference itself through a self-targetable relation",
    expectedInvariants: ["no-self-reference"],
    candidates: (ontology, world) =>
      ontology.entityTypes
        .filter((et) => rowsOf(world, et.name).length > 0)
        .flatMap((et) => et.relations.filter((rel) => rel.target.includes(et.name)).map((relation) => ({ entityType: et.name, relation }))),
    prefer: () => false,
    apply: (c, victim) => {
      const values: Record<string, SqlValue> = { [relationRefColumn(c.relation.name)]: rowId(victim) }
      if (c.relation.target.length > 1) values[relationRefTypeColumn(c.relation.name)] = c.entityType
      return { values, note: `${c.entityType}[${rowId(victim)}].${c.relation.name} -> itself` }
    }
  })
]

// ── replay + runStress ───────────────────────────────────────────────────────

/** `firedInvariants` = distinct invariant ids with >= 1 violation; `loadError` =
 * load failure message (e.g. duplicate PRIMARY KEY) or null; `skippedInvariants`
 * = SQL invariants that could not run because the world failed to load. */
export interface ReplayResult {
  readonly violations: readonly InvariantViolation[]
  readonly firedInvariants: readonly string[]
  readonly loadError: string | null
  readonly skippedInvariants: readonly string[]
}

/**
 * Load a world and run every invariant against it. World-kind invariants run
 * BEFORE the load (a duplicate-id world cannot load at all — the PRIMARY KEY
 * refuses it — so unique-ids must observe the world, not the store). A failed
 * load is reported, and SQL invariants are marked skipped, never silently green.
 */
export const replay = async (
  store: Store,
  world: InstanceWorld,
  ontology: Ontology,
  invariants: readonly Invariant[] = fhirInvariants
): Promise<ReplayResult> => {
  const violations: InvariantViolation[] = []
  for (const invariant of invariants) {
    if (invariant.kind === "world") violations.push(...invariant.check(ontology, world))
  }
  let loadError: string | null = null
  const skippedInvariants: string[] = []
  try {
    await loadWorld(store, ontology, world)
  } catch (cause) {
    loadError = describeCause(cause)
  }
  for (const invariant of invariants) {
    if (invariant.kind !== "sql") continue
    if (loadError !== null) skippedInvariants.push(invariant.id)
    else violations.push(...(await invariant.check(store, ontology)))
  }
  return { violations, firedInvariants: [...new Set(violations.map((v) => v.invariantId))], loadError, skippedInvariants }
}

/** One matrix row: `applied` false = no applicable target; `expectationMet` = all expected invariants fired. */
export interface StressMutatorRun {
  readonly mutatorId: string
  readonly describe: string
  readonly applied: boolean
  readonly note: string | null
  readonly expectedInvariants: readonly string[]
  readonly firedInvariants: readonly string[]
  readonly expectationMet: boolean
  readonly replay: ReplayResult | null
}

/** `cleanPassed` = the clean world replayed silent and loaded; `passed` = that AND every mutator applied and was caught. */
export interface StressReport {
  readonly seed: number
  readonly invariantIds: readonly string[]
  readonly clean: ReplayResult
  readonly cleanPassed: boolean
  readonly runs: readonly StressMutatorRun[]
  readonly passed: boolean
}

/** `world` defaults to generateWorld(ontology, { seed }); `store` defaults to a
 * fresh in-memory store closed on completion (pass one to own its lifecycle). */
export interface StressRunOptions {
  readonly seed: number
  readonly world?: InstanceWorld
  readonly store?: Store
  readonly mutators?: readonly StressMutator[]
  readonly invariants?: readonly Invariant[]
}

/**
 * The mutator x invariant matrix: replay the clean world (must be silent),
 * then each mutated world (its expected invariants must fire). Sequential by
 * design — one connection — and each replay reloads the world (loadWorld
 * drops/recreates tables), so runs are hermetic. Per-mutator seeds are
 * derived by fnv1a(mutator.id), independent of list order.
 */
export const runStress = async (ontology: Ontology, opts: StressRunOptions): Promise<StressReport> => {
  const mutators = opts.mutators ?? fhirStressMutators
  const invariants = opts.invariants ?? fhirInvariants
  const world = opts.world ?? generateWorld(ontology, { seed: opts.seed })
  const store = opts.store ?? (await openStore())
  try {
    const clean = await replay(store, world, ontology, invariants)
    const cleanPassed = clean.violations.length === 0 && clean.loadError === null
    const runs: StressMutatorRun[] = []
    for (const mutator of mutators) {
      const rng = makeRng((opts.seed ^ fnv1a(mutator.id)) >>> 0)
      const mutation = mutator.mutate(ontology, world, rng)
      const base = { mutatorId: mutator.id, describe: mutator.describe, expectedInvariants: mutator.expectedInvariants }
      if (mutation === null) {
        runs.push({ ...base, applied: false, note: null, firedInvariants: [], expectationMet: false, replay: null })
        continue
      }
      const result = await replay(store, mutation.world, ontology, invariants)
      runs.push({
        ...base,
        applied: true,
        note: mutation.note,
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
  } finally {
    if (opts.store === undefined) store.close()
  }
}

/** Render the mutator x invariant matrix as plain text (the CLI's sim output). */
export const formatStressReport = (report: StressReport): string => {
  const lines: string[] = [`Stress run (seed ${report.seed}) — mutator x invariant matrix`]
  report.invariantIds.forEach((id, i) => lines.push(`  [${String(i + 1)}] ${id}`))

  const names = ["clean world", ...report.runs.map((r) => r.mutatorId)]
  const nameWidth = Math.max(...names.map((n) => n.length))
  const cellWidth = Math.max(...report.invariantIds.map((_, i) => `[${String(i + 1)}]`.length), 4)

  const cellsFor = (violations: readonly InvariantViolation[], skipped: readonly string[], expected: readonly string[]): readonly string[] =>
    report.invariantIds.map((id) => {
      if (skipped.includes(id)) return "x"
      const count = violations.filter((v) => v.invariantId === id).length
      const marker = expected.includes(id) ? "*" : ""
      return count === 0 ? (marker === "" ? "." : "*0") : `${marker}${String(count)}`
    })

  const rowLine = (name: string, cells: readonly string[], verdict: string): string =>
    `${name.padEnd(nameWidth)}  ${cells.map((c) => c.padStart(cellWidth)).join(" ")}  ${verdict}`

  lines.push("", rowLine("", report.invariantIds.map((_, i) => `[${String(i + 1)}]`), "verdict"))
  lines.push(
    rowLine(
      "clean world",
      cellsFor(report.clean.violations, report.clean.skippedInvariants, []),
      report.cleanPassed ? "ok (zero violations)" : "FAIL (clean world must be silent)"
    )
  )
  for (const run of report.runs) {
    const verdict = !run.applied ? "n/a (no applicable target)" : run.expectationMet ? "ok" : "MISS (expected invariant stayed silent)"
    lines.push(rowLine(run.mutatorId, cellsFor(run.replay?.violations ?? [], run.replay?.skippedInvariants ?? [], run.expectedInvariants), verdict))
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
