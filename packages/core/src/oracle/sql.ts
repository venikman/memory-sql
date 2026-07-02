/**
 * SqlOracle — the deterministic ground truth of the CQ dual oracle.
 *
 * A bound CQ template compiles to plain SQL (template.sql), DuckDB executes it
 * over the loaded InstanceWorld, and the result set is folded into a canonical
 * Answer via the shared support-set convention (cq/model.ts):
 *
 *   - required `id` column: the supporting row ids (citations come from here,
 *     which is why oracle citations are auditable rather than asserted);
 *   - optional `entity_type` column: per-row entity type for cross-entity
 *     result sets (defaults to template.resultEntityType);
 *   - `value` column (required for scalar templates): the per-row numeric
 *     contribution; the oracle sums contributions, so money stays integer
 *     cents and counts are `1 AS value` per row.
 *
 * The oracle is intentionally thin: no query planning, no FHIR knowledge —
 * whatever SQL a template ships is the ground truth, and DuckDB (not this
 * module) is the execution engine the AnswerPath under test must agree with.
 */
import { Data, Effect } from "effect"
import type { Answer, CqBinding, SupportRow } from "../cq/model.js"
import { answerFromSupport } from "../cq/model.js"
import type { QueryResult } from "../store/db.js"
import { DuckDb } from "../store/db.js"

export class OracleError extends Data.TaggedError("OracleError")<{
  readonly message: string
  readonly templateId?: string
  readonly cause?: unknown
}> {}

/**
 * The oracle surface runSuite consumes. SqlOracle is the shipped
 * implementation; the interface exists so tests can substitute a
 * hand-computed oracle for tiny fixture worlds.
 */
export interface Oracle {
  readonly answer: (binding: CqBinding) => Effect.Effect<Answer, OracleError, DuckDb>
}

/**
 * Map a query result to support rows per the convention above. Throws on
 * contract violations (missing id/value columns, non-numeric contributions) —
 * those are template bugs, surfaced as OracleError by the caller rather than
 * silently mis-grading the path under test.
 */
const supportFromResult = (binding: CqBinding, result: QueryResult): SupportRow[] => {
  const template = binding.template
  const idIdx = result.columns.indexOf("id")
  if (idIdx < 0) {
    throw new Error(
      `template "${template.id}": oracle SQL must SELECT an "id" column (got: ${result.columns.join(", ") || "none"})`
    )
  }
  const typeIdx = result.columns.indexOf("entity_type")
  const valueIdx = result.columns.indexOf("value")
  if (template.expectedKind === "scalar" && valueIdx < 0) {
    throw new Error(
      `template "${template.id}": scalar templates must SELECT a numeric "value" column`
    )
  }
  const support: SupportRow[] = []
  for (const row of result.rows) {
    const id = row[idIdx]
    // a NULL id cannot support anything; skip defensively (outer joins etc.)
    if (id === null || id === undefined) continue
    const rawType = typeIdx >= 0 ? row[typeIdx] : undefined
    const entityType = typeof rawType === "string" ? rawType : template.resultEntityType
    if (valueIdx >= 0) {
      const raw = row[valueIdx]
      const value = raw === null || raw === undefined ? 0 : typeof raw === "number" ? raw : Number(raw)
      if (Number.isNaN(value)) {
        throw new Error(`template "${template.id}": non-numeric "value" column entry ${String(raw)}`)
      }
      support.push({ entityType, id: String(id), value })
    } else {
      support.push({ entityType, id: String(id) })
    }
  }
  return support
}

/** The deterministic SQL ground truth (requires a loaded DuckDb in context). */
export const SqlOracle: Oracle = {
  answer: (binding: CqBinding): Effect.Effect<Answer, OracleError, DuckDb> =>
    Effect.gen(function* () {
      const templateId = binding.template.id
      const db = yield* DuckDb
      const sql = yield* Effect.try({
        try: () => binding.template.sql(binding),
        catch: (cause) =>
          new OracleError({
            message: `template "${templateId}": sql() threw: ${String(cause)}`,
            templateId,
            cause
          })
      })
      const result = yield* db.query(sql).pipe(
        Effect.mapError(
          (cause) =>
            new OracleError({
              message: `template "${templateId}": oracle query failed: ${cause.message}`,
              templateId,
              cause
            })
        )
      )
      const support = yield* Effect.try({
        try: () => supportFromResult(binding, result),
        catch: (cause) =>
          new OracleError({
            message: cause instanceof Error ? cause.message : String(cause),
            templateId,
            cause
          })
      })
      return answerFromSupport(binding.template.expectedKind, support)
    })
}
