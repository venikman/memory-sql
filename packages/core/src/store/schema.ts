/**
 * Ontology -> SQL DDL. One table per entity type; the mapping is intentionally
 * boring so the SQL oracle stays a ground truth anyone can audit:
 *   - table name  = lower_snake entity name ("ExplanationOfBenefit" -> explanation_of_benefit)
 *   - id TEXT PRIMARY KEY
 *   - one column per attribute (attribute names are already lower_snake_case
 *     and are used verbatim as column names)
 *   - one `<relation>_ref TEXT` column per relation, holding the target row id;
 *     multi-target relations additionally get `<relation>_ref_type TEXT`
 *     holding the target entity type name.
 *
 * Type map note: 'date' and 'datetime' are stored as TEXT holding ISO-8601
 * strings. ISO-8601 sorts lexicographically in chronological order, so
 * temporal SQL (BETWEEN, <=) is exact without any driver date-object
 * round-tripping — determinism beats storage elegance here.
 */
import type { AttributeType, EntityType, Ontology, Relation } from "../ontology/model.js"

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** "ExplanationOfBenefit" -> "explanation_of_benefit". */
export const tableName = (entityTypeName: string): string =>
  entityTypeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()

/**
 * Attribute name -> column name. Identity (ontology attribute names are the
 * column names), but validated so a malformed ontology can never smuggle SQL.
 */
export const columnName = (attributeName: string): string => {
  if (!NAME_PATTERN.test(attributeName)) {
    throw new Error(`memory-sql: illegal column name "${attributeName}"`)
  }
  return attributeName
}

/**
 * Double-quote an identifier for generated SQL. FHIR legitimately produces
 * column names that are reserved SQL keywords (Appointment.start/end,
 * Coverage.order), so ALL generated DDL/INSERT identifiers are quoted.
 * Identifiers are validated lowercase, so unquoted references in hand-written
 * SQL still match (DuckDB folds unquoted identifiers to lowercase) — except
 * the reserved words themselves, which must be quoted in queries too.
 */
export const quoteIdent = (name: string): string => `"${columnName(name)}"`

/** Column holding the target row id of a relation. */
export const relationRefColumn = (relationName: string): string =>
  `${columnName(relationName)}_ref`

/** Column holding the target entity type of a multi-target relation. */
export const relationRefTypeColumn = (relationName: string): string =>
  `${columnName(relationName)}_ref_type`

/** Attribute type -> DuckDB column type (see header for the TEXT-date rationale). */
export const sqlType = (type: AttributeType): string => {
  switch (type) {
    case "string":
    case "code":
    case "date":
    case "datetime":
      return "TEXT"
    case "boolean":
      return "BOOLEAN"
    case "integer":
      return "INTEGER"
    case "decimal":
      return "DOUBLE"
  }
}

export interface ColumnDef {
  readonly name: string
  readonly sqlType: string
}

const relationColumnDefs = (relation: Relation): ColumnDef[] => {
  const columns: ColumnDef[] = [{ name: relationRefColumn(relation.name), sqlType: "TEXT" }]
  if (relation.target.length > 1) {
    columns.push({ name: relationRefTypeColumn(relation.name), sqlType: "TEXT" })
  }
  return columns
}

/** Full column list of an entity type's table: id first, attributes, then relation columns. */
export const tableColumns = (entityType: EntityType): readonly ColumnDef[] => [
  { name: "id", sqlType: "TEXT" },
  ...entityType.attributes.map((a) => ({ name: columnName(a.name), sqlType: sqlType(a.type) })),
  ...entityType.relations.flatMap(relationColumnDefs)
]

/** CREATE TABLE statement for one entity type. Table + column identifiers are
 * quoted: FHIR yields reserved-word names (table `group`, columns `start`/
 * `end`/`order`) that would otherwise break the parser. */
export const createTable = (entityType: EntityType): string => {
  const columns = tableColumns(entityType)
    .map((c) => (c.name === "id" ? `"id" TEXT PRIMARY KEY` : `${quoteIdent(c.name)} ${c.sqlType}`))
    .join(", ")
  return `CREATE TABLE ${quoteIdent(tableName(entityType.name))} (${columns})`
}

/** DDL for the whole ontology — one CREATE TABLE per entity type, in ontology order. */
export const ddl = (ontology: Ontology): string[] =>
  ontology.entityTypes.map(createTable)
