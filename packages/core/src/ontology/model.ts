/**
 * Generic ontology model. Deliberately NOT FHIR-specific: the CQ and simulation
 * engines are generic over this model, and everything FHIR-shaped is confined
 * to ontology/fhir.ts (which loads the committed trimmed spec) and to
 * template/mutator configuration.
 *
 * The model is flat and honest — an EntityType is a bag of scalar attributes
 * plus named relations to other entity types. That flatness is what makes the
 * SQL oracle deterministic: one entity type = one table, one attribute = one
 * column, one relation = one foreign-key column.
 *
 * ── How FHIR is flattened into this model (rules live in scripts/fetch-fhir.ts,
 *    committed output in fhir-data/top50.json; summarized here per SPEC) ──
 * - Depth cap: only depth-1 elements (Resource.field) are kept, plus a small
 *   whitelist of payer-critical backbone leaves (Claim.insurance.coverage,
 *   ExplanationOfBenefit.insurance.coverage, EOB/ClaimResponse payment.amount,
 *   Appointment.participant.actor, Provenance.agent.who) named
 *   `<backbone>_<leaf>`.
 * - Complex types flatten to documented column sets:
 *     CodeableConcept/Coding -> `<f>` ('code'),
 *     Period -> `<f>_start` / `<f>_end` ('datetime'),
 *     Money -> `<f>_cents` ('integer') / `<f>_currency` ('string'),
 *     Quantity family -> `<f>_value` ('decimal') / `<f>_unit` ('string'),
 *     Identifier -> `<f>_value`, HumanName -> `<f>_family` / `<f>_given`,
 *     Address -> `<f>_city` / `<f>_state`,
 *     Reference(X|Y) -> Relation { target: [X, Y] }.
 * - Choice elements ([x]) resolve deterministically (Reference(Medication)
 *   wins; value[x] prefers Quantity; else a fixed preference order).
 * - Repeating elements are represented by their first repetition.
 * - `required` = FHIR min >= 1. Required bindings with <= 25 codes become
 *   enumerable `valueSet`s; larger/filtered sets stay open codes.
 * - All names are lower_snake_case; attribute names double as SQL column names.
 */

/** Scalar attribute types. Dates/datetimes are ISO-8601 strings end to end. */
export type AttributeType =
  | "string"
  | "code"
  | "boolean"
  | "integer"
  | "decimal"
  | "date"
  | "datetime"

export interface Attribute {
  /** lower_snake_case; doubles as the SQL column name. */
  readonly name: string
  readonly type: AttributeType
  readonly required: boolean
  /** Present only for enumerable required bindings ('code' attributes). */
  readonly valueSet?: readonly string[]
}

export interface Relation {
  /** lower_snake_case; SQL columns are `<name>_ref` (+ `<name>_ref_type` when multi-target). */
  readonly name: string
  /** Entity type names this relation may point at (FHIR Reference(X|Y) yields several). */
  readonly target: readonly string[]
  readonly required: boolean
}

export interface EntityType {
  /** PascalCase entity name, e.g. "Patient", "ExplanationOfBenefit". */
  readonly name: string
  readonly attributes: readonly Attribute[]
  readonly relations: readonly Relation[]
}

export interface Ontology {
  readonly entityTypes: readonly EntityType[]
}

/** Look up an entity type by name; undefined when absent. */
export const getEntityType = (ontology: Ontology, name: string): EntityType | undefined =>
  ontology.entityTypes.find((t) => t.name === name)

/** Look up an entity type by name; throws on absence (programmer error, not a runtime condition). */
export const requireEntityType = (ontology: Ontology, name: string): EntityType => {
  const found = getEntityType(ontology, name)
  if (found === undefined) {
    throw new Error(`memory-sql: unknown entity type "${name}"`)
  }
  return found
}

export const entityTypeNames = (ontology: Ontology): readonly string[] =>
  ontology.entityTypes.map((t) => t.name)

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/**
 * Structural sanity of an ontology — returns human-readable problems (empty =
 * valid). This is what "the ontology is well-formed" means for every engine
 * downstream: unique type names, legal snake_case member names, no
 * attribute/relation-column collisions, and every relation target resolvable.
 */
export const validateOntology = (ontology: Ontology): readonly string[] => {
  const problems: string[] = []
  const typeNames = new Set<string>()
  for (const et of ontology.entityTypes) {
    if (typeNames.has(et.name)) problems.push(`duplicate entity type "${et.name}"`)
    typeNames.add(et.name)
  }
  for (const et of ontology.entityTypes) {
    const columns = new Set<string>(["id"])
    for (const attr of et.attributes) {
      if (!NAME_PATTERN.test(attr.name)) {
        problems.push(`${et.name}.${attr.name}: attribute name is not lower_snake_case`)
      }
      if (columns.has(attr.name)) problems.push(`${et.name}.${attr.name}: duplicate column`)
      columns.add(attr.name)
      if (attr.valueSet !== undefined && attr.valueSet.length === 0) {
        problems.push(`${et.name}.${attr.name}: empty valueSet`)
      }
    }
    for (const rel of et.relations) {
      if (!NAME_PATTERN.test(rel.name)) {
        problems.push(`${et.name}.${rel.name}: relation name is not lower_snake_case`)
      }
      for (const col of [`${rel.name}_ref`, `${rel.name}_ref_type`]) {
        if (columns.has(col)) problems.push(`${et.name}.${rel.name}: column "${col}" collides`)
        columns.add(col)
      }
      if (rel.target.length === 0) problems.push(`${et.name}.${rel.name}: no targets`)
      for (const target of rel.target) {
        if (!typeNames.has(target)) {
          problems.push(`${et.name}.${rel.name}: unknown target entity type "${target}"`)
        }
      }
    }
  }
  return problems
}
