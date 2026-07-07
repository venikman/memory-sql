/**
 * Store: ontology -> SQL DDL, DuckDB access, world loading. The DDL mapping
 * is intentionally boring so the SQL oracle stays auditable: one table per
 * entity type (lower_snake name), `id TEXT PRIMARY KEY`, one column per
 * attribute (names verbatim), `<relation>_ref TEXT` per relation
 * (+ `<relation>_ref_type TEXT` when multi-target). 'date'/'datetime' are
 * TEXT holding ISO-8601 — lexicographic order IS chronological order, so
 * temporal SQL is exact. FHIR legitimately produces reserved-word identifiers
 * (table `group`, columns `start`/`end`), so ALL generated identifiers are
 * quoted. loadWorld validates world keys AND value JS types against the
 * ontology BEFORE any DDL/INSERT: otherwise DuckDB would
 * silently cast on INSERT (string "2500" into INTEGER) while the GraphPath
 * reads the raw in-memory row — the two reference oracles would see different
 * values for the same world. Poisoned worlds are rejected at the boundary
 * with a pointed MemorySqlError instead.
 */
import { DuckDBInstance } from "@duckdb/node-api"
import type { AttributeType, EntityType, Ontology } from "./ontology.js"
import { getEntityType, MemorySqlError } from "./ontology.js"

// ── Schema mapping (pure) ────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** "ExplanationOfBenefit" -> "explanation_of_benefit". */
export const tableName = (entityTypeName: string): string => entityTypeName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()

/** Attribute name -> column name. Identity, but validated so a malformed ontology can never smuggle SQL. */
export const columnName = (attributeName: string): string => {
  if (!NAME_PATTERN.test(attributeName)) throw new MemorySqlError("store", `illegal column name "${attributeName}"`)
  return attributeName
}

/** Double-quote a validated identifier for generated SQL (reserved-word safety). */
export const quoteIdent = (name: string): string => `"${columnName(name)}"`

/** Column holding the target row id of a relation. */
export const relationRefColumn = (relationName: string): string => `${columnName(relationName)}_ref`

/** Column holding the target entity type of a multi-target relation. */
export const relationRefTypeColumn = (relationName: string): string => `${columnName(relationName)}_ref_type`

/** Attribute type -> DuckDB column type (dates are ISO TEXT — see header). */
export const sqlType = (type: AttributeType): string =>
  type === "boolean" ? "BOOLEAN" : type === "integer" ? "INTEGER" : type === "decimal" ? "DOUBLE" : "TEXT"

export interface ColumnDef { readonly name: string; readonly sqlType: string }

/** Full column list of an entity type's table: id first, attributes, then relation columns. */
export const tableColumns = (entityType: EntityType): readonly ColumnDef[] => [
  { name: "id", sqlType: "TEXT" },
  ...entityType.attributes.map((a) => ({ name: columnName(a.name), sqlType: sqlType(a.type) })),
  ...entityType.relations.flatMap((rel) => [
    { name: relationRefColumn(rel.name), sqlType: "TEXT" },
    ...(rel.target.length > 1 ? [{ name: relationRefTypeColumn(rel.name), sqlType: "TEXT" }] : [])
  ])
]

const createTableSql = (table: string, columns: readonly ColumnDef[]): string => {
  const body = columns.map((c) => (c.name === "id" ? `"id" TEXT PRIMARY KEY` : `${quoteIdent(c.name)} ${c.sqlType}`)).join(", ")
  return `CREATE TABLE ${quoteIdent(table)} (${body})`
}

/** CREATE TABLE statement for one entity type; identifiers fully quoted. */
export const createTable = (entityType: EntityType): string => createTableSql(tableName(entityType.name), tableColumns(entityType))

/** DDL for the whole ontology — one CREATE TABLE per entity type, in ontology order. */
export const ddl = (ontology: Ontology): string[] => ontology.entityTypes.map(createTable)

// ── Store (DuckDB, plain async) ──────────────────────────────────────────────

/** The scalar value domain of the store (see the type map above). */
export type SqlValue = string | number | boolean | null

export interface QueryResult { readonly columns: readonly string[]; readonly rows: ReadonlyArray<ReadonlyArray<SqlValue>> }

/** `path`: database file path; omit for in-memory (the default). */
export interface StoreOptions { readonly path?: string }

/** `run` executes for effect (DDL, INSERT); `query` materializes all rows
 * normalized to SqlValue; `close` is idempotent and synchronous. */
export interface Store {
  readonly run: (sql: string) => Promise<void>
  readonly query: (sql: string) => Promise<QueryResult>
  readonly close: () => void
}

/** Fold driver values into the SqlValue domain: bigint aggregates (COUNT/SUM)
 * become plain numbers when safely representable — canonical Answers must be
 * plain JSON; other driver objects should not occur with this schema. */
const toSqlValue = (value: unknown): SqlValue => {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return value
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
    default:
      return value instanceof Date ? value.toISOString() : String(value)
  }
}

const trimSql = (sql: string): string => (sql.length > 200 ? `${sql.slice(0, 200)}…` : sql)

/** Open a DuckDB-backed Store. Default is a fresh in-memory database; pass
 * { path } to persist. Single connection: statements run sequentially (the
 * engines do), never raced. */
export const openStore = async (opts?: StoreOptions): Promise<Store> => {
  const target = opts?.path ?? ":memory:"
  let instance: DuckDBInstance
  let connection: Awaited<ReturnType<DuckDBInstance["connect"]>>
  try {
    instance = await DuckDBInstance.create(target)
    connection = await instance.connect()
  } catch (cause) {
    throw new MemorySqlError("store", `cannot open DuckDB (${target}): ${String(cause)}`, cause)
  }
  let closed = false
  return {
    run: async (sql) => {
      try {
        await connection.run(sql)
      } catch (cause) {
        throw new MemorySqlError("store", `run failed: ${String(cause)} [sql: ${trimSql(sql)}]`, cause)
      }
    },
    query: async (sql) => {
      try {
        const reader = await connection.runAndReadAll(sql)
        return { columns: reader.columnNames(), rows: reader.getRowsJS().map((row) => row.map(toSqlValue)) }
      } catch (cause) {
        throw new MemorySqlError("store", `query failed: ${String(cause)} [sql: ${trimSql(sql)}]`, cause)
      }
    },
    close: () => {
      if (closed) return
      closed = true
      connection.closeSync()
      instance.closeSync()
    }
  }
}

// ── World loading ────────────────────────────────────────────────────────────

/** One instance row; keys are SQL column names, values the store scalar domain. */
export type Row = Readonly<Record<string, SqlValue>>

/** Entity type name -> rows. The unit of generation and loading. */
export interface InstanceWorld { readonly [entityType: string]: ReadonlyArray<Row> }

/** Render a SqlValue as a SQL literal. Strings are single-quoted with quote
 * doubling; non-finite numbers degrade to NULL. */
export const sqlLiteral = (value: SqlValue): string => {
  if (value === null) return "NULL"
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  return `'${value.replace(/'/g, "''")}'`
}

const INSERT_CHUNK = 500

/** JS type the store expects for a SQL column type (dates are ISO TEXT). */
const jsTypeFor = (sqlType: string): "string" | "number" | "boolean" =>
  sqlType === "BOOLEAN" ? "boolean" : sqlType === "INTEGER" || sqlType === "DOUBLE" ? "number" : "string"

/** First value whose JS type contradicts its ontology column type, or null (see file header). */
const findTypeMismatch = (typeName: string, rows: ReadonlyArray<Row>, columns: ReadonlyArray<ColumnDef>): string | null => {
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column.name]
      if (value === null || value === undefined) continue
      const expected = jsTypeFor(column.sqlType)
      if (typeof value !== expected) {
        return (
          `world row ${typeName}[${String(row["id"] ?? "?")}] column "${column.name}": ` +
          `expected ${expected} (${column.sqlType}), got ${typeof value} ${JSON.stringify(value)} — ` +
          `fix the world so the SQL store and the in-memory graph see the same value`
        )
      }
    }
  }
  return null
}

/** Infer a column layout from rows when no ontology is supplied: id first, then
 * every key in first-seen order, typed by the first non-null value observed. */
const inferColumns = (rows: ReadonlyArray<Row>): ColumnDef[] => {
  const names: string[] = ["id"]
  const seen = new Set(names)
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key)
        names.push(key)
      }
    }
  }
  return names.map((name) => {
    let sqlType = "TEXT"
    for (const row of rows) {
      const v = row[name]
      if (v === null || v === undefined) continue
      if (typeof v === "boolean") sqlType = "BOOLEAN"
      else if (typeof v === "number") sqlType = Number.isInteger(v) ? "INTEGER" : "DOUBLE"
      break
    }
    return { name, sqlType }
  })
}

/**
 * Create tables and insert every row of the world. Idempotent per table
 * (DROP TABLE IF EXISTS + CREATE) so tests and callers can reload replacement
 * worlds into the same store; `id TEXT PRIMARY KEY` is a real constraint — a world
 * carrying duplicate ids fails the INSERT. With an `ontology` the DDL covers
 * ALL entity types (even empty tables exist — negative-control CQs query
 * them) and world keys AND value JS types are validated first (no silent
 * implicit casts). With `undefined`, tables are inferred from the rows
 * (hand-rolled fixture worlds in tests).
 */
export const loadWorld = async (store: Store, ontology: Ontology | undefined, world: InstanceWorld): Promise<void> => {
  const worldTypes = Object.keys(world)
  // Table name -> ordered column list, driving both DDL and inserts.
  const layouts = new Map<string, readonly ColumnDef[]>()
  if (ontology !== undefined) {
    for (const t of worldTypes) {
      const et = getEntityType(ontology, t)
      if (et === undefined) throw new MemorySqlError("load", `world contains entity type "${t}" that is not in the ontology`)
      const mismatch = findTypeMismatch(t, world[t] ?? [], tableColumns(et)) // reject BEFORE any DDL/INSERT
      if (mismatch !== null) throw new MemorySqlError("load", mismatch)
    }
    for (const et of ontology.entityTypes) {
      layouts.set(et.name, tableColumns(et))
      await store.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName(et.name))}`)
      await store.run(createTable(et))
    }
  } else {
    for (const t of worldTypes) {
      const columns = inferColumns(world[t] ?? [])
      layouts.set(t, columns)
      await store.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName(t))}`)
      await store.run(createTableSql(tableName(t), columns))
    }
  }

  for (const t of worldTypes) {
    const rows = world[t] ?? []
    const columns = layouts.get(t)
    if (rows.length === 0 || columns === undefined) continue
    const columnNames = columns.map((c) => c.name)
    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
      const values = rows
        .slice(offset, offset + INSERT_CHUNK)
        .map((row) => `(${columnNames.map((c) => sqlLiteral(row[c] ?? null)).join(", ")})`)
        .join(", ")
      await store.run(`INSERT INTO ${quoteIdent(tableName(t))} (${columnNames.map(quoteIdent).join(", ")}) VALUES ${values}`)
    }
  }
}
