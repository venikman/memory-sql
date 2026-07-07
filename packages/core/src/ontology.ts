/**
 * Ontology model + FHIR R4 top-50 loader. The model is flat and honest — an
 * EntityType is a bag of scalar attributes plus named relations — which is
 * what makes the SQL oracle auditable: one type = one table, one attribute =
 * one column, one relation = one foreign-key column. The FHIR flattening
 * rules live in scripts/fetch-fhir.ts; the committed output is
 * fhir-data/top50.json. Also home of MemorySqlError, the ONE error class of
 * the package — every core failure throws it, tagged with `op`.
 */
import { readFileSync } from "node:fs"

/** The single error class of memory-sql. `op` tags where it came from. */
export class MemorySqlError extends Error {
  readonly op: string
  constructor(op: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "MemorySqlError"
    this.op = op
  }
}

/** Scalar attribute types. Dates/datetimes are ISO-8601 strings end to end. */
export type AttributeType = "string" | "code" | "boolean" | "integer" | "decimal" | "date" | "datetime"

/** `name` is lower_snake_case and doubles as the SQL column name; `valueSet` is present only for enumerable required bindings. */
export interface Attribute { readonly name: string; readonly type: AttributeType; readonly required: boolean; readonly valueSet?: readonly string[] }

/** SQL columns are `<name>_ref` (+ `<name>_ref_type` when multi-target — FHIR Reference(X|Y) yields several targets). */
export interface Relation { readonly name: string; readonly target: readonly string[]; readonly required: boolean }

/** PascalCase entity name (e.g. "ExplanationOfBenefit") + its attributes and relations. */
export interface EntityType { readonly name: string; readonly attributes: readonly Attribute[]; readonly relations: readonly Relation[] }

export interface Ontology { readonly entityTypes: readonly EntityType[] }

/** Look up an entity type by name; undefined when absent. */
export const getEntityType = (ontology: Ontology, name: string): EntityType | undefined =>
  ontology.entityTypes.find((t) => t.name === name)

/** Look up an entity type by name; throws on absence (programmer error, not a runtime condition). */
export const requireEntityType = (ontology: Ontology, name: string): EntityType => {
  const found = getEntityType(ontology, name)
  if (found === undefined) throw new MemorySqlError("ontology", `unknown entity type "${name}"`)
  return found
}

export const entityTypeNames = (ontology: Ontology): readonly string[] => ontology.entityTypes.map((t) => t.name)

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** Structural sanity of an ontology — returns human-readable problems (empty =
 * valid): unique type names, legal snake_case member names, no column
 * collisions, every relation target resolvable. */
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
      if (!NAME_PATTERN.test(attr.name)) problems.push(`${et.name}.${attr.name}: attribute name is not lower_snake_case`)
      if (columns.has(attr.name)) problems.push(`${et.name}.${attr.name}: duplicate column`)
      columns.add(attr.name)
      if (attr.valueSet !== undefined && attr.valueSet.length === 0) problems.push(`${et.name}.${attr.name}: empty valueSet`)
    }
    for (const rel of et.relations) {
      if (!NAME_PATTERN.test(rel.name)) problems.push(`${et.name}.${rel.name}: relation name is not lower_snake_case`)
      for (const col of [`${rel.name}_ref`, `${rel.name}_ref_type`]) {
        if (columns.has(col)) problems.push(`${et.name}.${rel.name}: column "${col}" collides`)
        columns.add(col)
      }
      if (rel.target.length === 0) problems.push(`${et.name}.${rel.name}: no targets`)
      for (const target of rel.target) {
        if (!typeNames.has(target)) problems.push(`${et.name}.${rel.name}: unknown target entity type "${target}"`)
      }
    }
  }
  return problems
}

// ── FHIR top-50 loader (plain JSON.parse + hand validation — no schema lib) ──

/** The committed trimmed spec (src/ and dist/ both sit one level under packages/core). */
const FHIR_TOP50_URL = new URL("../fhir-data/top50.json", import.meta.url)

/** Number of resources the committed top-50 data must contain. */
export const FHIR_TOP50_COUNT = 50

const ATTRIBUTE_TYPES: readonly string[] = ["string", "code", "boolean", "integer", "decimal", "date", "datetime"]

const fail = (message: string, cause?: unknown): never => {
  throw new MemorySqlError("ontology", message, cause)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const asString = (v: unknown, at: string): string => (typeof v === "string" ? v : fail(`top50.json: ${at}: expected string, got ${typeof v}`))
const asBoolean = (v: unknown, at: string): boolean => (typeof v === "boolean" ? v : fail(`top50.json: ${at}: expected boolean, got ${typeof v}`))
const asArray = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : fail(`top50.json: ${at}: expected array, got ${typeof v}`))
const asStringArray = (v: unknown, at: string): string[] => asArray(v, at).map((x, i) => asString(x, `${at}[${i}]`))

const parseAttribute = (v: unknown, at: string): Attribute => {
  if (!isRecord(v)) return fail(`top50.json: ${at}: expected object`)
  const name = asString(v["name"], `${at}.name`)
  const type = asString(v["type"], `${at}.type`)
  if (!ATTRIBUTE_TYPES.includes(type)) return fail(`top50.json: ${at}.type: illegal type "${type}"`)
  const base = { name, type: type as AttributeType, required: asBoolean(v["required"], `${at}.required`) }
  return v["valueSet"] === undefined ? base : { ...base, valueSet: asStringArray(v["valueSet"], `${at}.valueSet`) }
}

const parseRelation = (v: unknown, at: string): Relation => {
  if (!isRecord(v)) return fail(`top50.json: ${at}: expected object`)
  return {
    name: asString(v["name"], `${at}.name`),
    target: asStringArray(v["target"], `${at}.target`),
    required: asBoolean(v["required"], `${at}.required`)
  }
}

const parseResource = (v: unknown, at: string): EntityType => {
  if (!isRecord(v)) return fail(`top50.json: ${at}: expected object`)
  const name = asString(v["name"], `${at}.name`)
  if (v["kind"] !== "resource") return fail(`top50.json: ${at}.kind: expected "resource"`)
  return {
    name,
    attributes: asArray(v["attributes"], `${at}.attributes`).map((a, i) => parseAttribute(a, `${name}.attributes[${i}]`)),
    relations: asArray(v["relations"], `${at}.relations`).map((r, i) => parseRelation(r, `${name}.relations[${i}]`))
  }
}

/** Load the FHIR-derived ontology from the committed trimmed spec data. Throws
 * MemorySqlError (op "ontology") when the file is missing, malformed, or fails
 * the structural validation every downstream engine relies on. */
export const loadFhirOntology = (): Ontology => {
  let text: string
  try {
    text = readFileSync(FHIR_TOP50_URL, "utf8")
  } catch (cause) {
    return fail(`cannot read ${FHIR_TOP50_URL.pathname}`, cause)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    return fail("top50.json is not valid JSON", cause)
  }
  if (!isRecord(raw)) return fail("top50.json: expected a top-level object")
  const meta = raw["meta"]
  if (!isRecord(meta)) return fail("top50.json: missing meta object")
  for (const key of ["source", "fhirVersion", "generatedBy"]) asString(meta[key], `meta.${key}`)
  asStringArray(meta["pruning"], "meta.pruning")
  const resources = asArray(raw["resources"], "resources")
  if (resources.length !== FHIR_TOP50_COUNT) return fail(`expected ${FHIR_TOP50_COUNT} resources in top50.json, found ${resources.length}`)
  const ontology: Ontology = { entityTypes: resources.map((r, i) => parseResource(r, `resources[${i}]`)) }
  const problems = validateOntology(ontology)
  if (problems.length > 0) return fail(`ontology validation failed:\n  ${problems.join("\n  ")}`)
  return ontology
}
