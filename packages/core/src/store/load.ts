/**
 * Load an InstanceWorld into the store. An InstanceWorld is the in-memory
 * representation shared by the generator, the GraphPath and the mutators:
 * entity type name -> rows, where row keys are exactly the SQL column names
 * (attribute names verbatim; `<relation>_ref` / `<relation>_ref_type` for
 * relations) so a world loads without any renaming step.
 *
 * loadWorld is idempotent per table (DROP TABLE IF EXISTS + CREATE) so stress
 * replays can reload mutated worlds into the same scoped database. Note that
 * `id TEXT PRIMARY KEY` is a real constraint: a world carrying duplicate ids
 * (the `duplicate-id` mutator) fails the INSERT with DbError — callers that
 * want to observe duplicates as *invariant violations* must check the world
 * before/instead of relying on the load to succeed.
 */
import { Effect } from "effect"
import type { Ontology } from "../ontology/model.js"
import { getEntityType } from "../ontology/model.js"
import type { SqlValue } from "./db.js"
import { DbError, DuckDb } from "./db.js"
import type { ColumnDef } from "./schema.js"
import { createTable, quoteIdent, tableColumns, tableName } from "./schema.js"

/** One instance row; keys are SQL column names, values the store scalar domain. */
export type Row = Readonly<Record<string, SqlValue>>

/** Entity type name -> rows. The unit of generation, mutation, and loading. */
export interface InstanceWorld {
  readonly [entityType: string]: ReadonlyArray<Row>
}

/**
 * Render a SqlValue as a SQL literal. Strings are single-quoted with quote
 * doubling; non-finite numbers degrade to NULL (the clean generator never
 * produces them; mutated worlds must still load so invariants can fire).
 */
export const sqlLiteral = (value: SqlValue): string => {
  if (value === null) return "NULL"
  switch (typeof value) {
    case "boolean":
      return value ? "TRUE" : "FALSE"
    case "number":
      return Number.isFinite(value) ? String(value) : "NULL"
    case "string":
      return `'${value.replace(/'/g, "''")}'`
  }
}

const INSERT_CHUNK = 500

/** JS type the store expects for a SQL column type (dates are ISO TEXT). */
const jsTypeFor = (sqlType: string): "string" | "number" | "boolean" =>
  sqlType === "BOOLEAN" ? "boolean" : sqlType === "INTEGER" || sqlType === "DOUBLE" ? "number" : "string"

/**
 * First value whose JS type contradicts its ontology column type, or null.
 * Without this check DuckDB would implicitly cast on INSERT (string "2500"
 * into an INTEGER column becomes 2500) while the GraphPath reads the raw
 * in-memory row — the two shipped reference oracles would then silently see
 * different values for the same world and report a bogus divergence. Worlds
 * are rejected at the load boundary instead, with a pointer at the row.
 */
const findTypeMismatch = (
  typeName: string,
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<ColumnDef>
): string | null => {
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
 * Create tables and insert every row of the world.
 *
 * With an `ontology` the DDL comes from store/schema.ts for ALL entity types
 * (so even empty tables exist — negative-control CQs query them), and world
 * keys AND value JS types are validated against it (no silent implicit
 * casts). Without one, tables are inferred from the rows (handy for
 * hand-rolled fixture worlds in tests).
 */
export const loadWorld = (
  world: InstanceWorld,
  ontology?: Ontology
): Effect.Effect<void, DbError, DuckDb> =>
  Effect.gen(function* () {
    const db = yield* DuckDb
    const worldTypes = Object.keys(world)

    // Table name -> ordered column list, driving both DDL and inserts.
    const layouts = new Map<string, readonly ColumnDef[]>()
    if (ontology !== undefined) {
      for (const t of worldTypes) {
        const et = getEntityType(ontology, t)
        if (et === undefined) {
          return yield* new DbError({
            message: `world contains entity type "${t}" that is not in the ontology`
          })
        }
        // Reject type-domain violations BEFORE any DDL/INSERT (see helper).
        const mismatch = findTypeMismatch(t, world[t] ?? [], tableColumns(et))
        if (mismatch !== null) {
          return yield* new DbError({ message: mismatch })
        }
      }
      for (const et of ontology.entityTypes) {
        layouts.set(et.name, tableColumns(et))
        yield* db.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName(et.name))}`)
        yield* db.run(createTable(et))
      }
    } else {
      for (const t of worldTypes) {
        const columns = inferColumns(world[t] ?? [])
        layouts.set(t, columns)
        const columnSql = columns
          .map((c) => (c.name === "id" ? `"id" TEXT PRIMARY KEY` : `${quoteIdent(c.name)} ${c.sqlType}`))
          .join(", ")
        yield* db.run(`DROP TABLE IF EXISTS ${quoteIdent(tableName(t))}`)
        yield* db.run(`CREATE TABLE ${quoteIdent(tableName(t))} (${columnSql})`)
      }
    }

    for (const t of worldTypes) {
      const rows = world[t] ?? []
      if (rows.length === 0) continue
      const columns = layouts.get(t)
      if (columns === undefined) continue
      const columnNames = columns.map((c) => c.name)
      for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK) {
        const chunk = rows.slice(offset, offset + INSERT_CHUNK)
        const values = chunk
          .map((row) => `(${columnNames.map((c) => sqlLiteral(row[c] ?? null)).join(", ")})`)
          .join(", ")
        const quoted = columnNames.map(quoteIdent).join(", ")
        yield* db.run(`INSERT INTO ${quoteIdent(tableName(t))} (${quoted}) VALUES ${values}`)
      }
    }
  })
