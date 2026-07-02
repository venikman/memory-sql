/**
 * DuckDb — the Effect service wrapping a DuckDB instance + connection.
 * Provided as a scoped Layer: acquiring opens the database (in-memory by
 * default), releasing closes connection and instance, so every engine run is
 * hermetic — no state leaks between CQ suites, metamorphic runs, or stress
 * replays.
 *
 * Query results are normalized to plain JS scalars (string | number | boolean
 * | null): DuckDB returns BIGINT/HUGEINT aggregates as bigint, which is folded
 * to number when safely representable — canonical Answers must be plain JSON.
 */
import { DuckDBInstance } from "@duckdb/node-api"
import type { DuckDBConnection } from "@duckdb/node-api"
import { Context, Data, Effect, Layer } from "effect"

export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string
  readonly sql?: string
  readonly cause?: unknown
}> {}

/** The scalar value domain of the store (see store/schema.ts type map). */
export type SqlValue = string | number | boolean | null

export interface QueryResult {
  readonly columns: readonly string[]
  readonly rows: ReadonlyArray<ReadonlyArray<SqlValue>>
}

export interface DuckDbService {
  /** Execute a statement for its effect (DDL, INSERT, ...). */
  readonly run: (sql: string) => Effect.Effect<void, DbError>
  /** Execute a query and materialize all rows, normalized to SqlValue. */
  readonly query: (sql: string) => Effect.Effect<QueryResult, DbError>
}

export class DuckDb extends Context.Tag("memory-sql/DuckDb")<DuckDb, DuckDbService>() {}

export interface DuckDbOptions {
  /** Database file path; omit for in-memory (the default). */
  readonly path?: string
}

/** Fold driver values into the SqlValue domain (documented normalizations only). */
const toSqlValue = (value: unknown): SqlValue => {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case "boolean":
      return value
    case "number":
      return value
    case "string":
      return value
    case "bigint":
      // COUNT/SUM come back as bigint; canonical answers need plain numbers.
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString()
    default:
      // Dates and other driver value objects should not occur with the TEXT/
      // INTEGER/DOUBLE/BOOLEAN schema; stringify rather than crash.
      return value instanceof Date ? value.toISOString() : String(value)
  }
}

const makeService = (connection: DuckDBConnection): DuckDbService => ({
  run: (sql) =>
    Effect.tryPromise({
      try: async () => {
        await connection.run(sql)
      },
      catch: (cause) => new DbError({ message: `run failed: ${String(cause)}`, sql, cause })
    }),
  query: (sql) =>
    Effect.tryPromise({
      try: async () => {
        const reader = await connection.runAndReadAll(sql)
        return {
          columns: reader.columnNames(),
          rows: reader.getRowsJS().map((row) => row.map(toSqlValue))
        } satisfies QueryResult
      },
      catch: (cause) => new DbError({ message: `query failed: ${String(cause)}`, sql, cause })
    })
})

/**
 * Scoped DuckDb layer. Default is a fresh in-memory database; pass { path } to
 * persist. Note the single connection: statements issued through the service
 * are expected to run sequentially (the engines do), not raced across fibers.
 */
export const layer = (opts?: DuckDbOptions): Layer.Layer<DuckDb, DbError> =>
  Layer.scoped(
    DuckDb,
    Effect.gen(function* () {
      const acquired = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const instance = await DuckDBInstance.create(opts?.path ?? ":memory:")
            const connection = await instance.connect()
            return { instance, connection }
          },
          catch: (cause) =>
            new DbError({ message: `cannot open DuckDB (${opts?.path ?? ":memory:"})`, cause })
        }),
        ({ connection, instance }) =>
          Effect.sync(() => {
            connection.closeSync()
            instance.closeSync()
          })
      )
      return makeService(acquired.connection)
    })
  )

/** Alias for `layer` with an unambiguous name at the package root. */
export const duckDbLayer = layer
