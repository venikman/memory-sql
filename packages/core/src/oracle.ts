/**
 * SqlOracle — the deterministic ground truth of the CQ dual oracle, plus the
 * shared support-set fold (`answerFromSupport`) BOTH oracles canonicalize
 * through, so a verdict difference can only come from query semantics, never
 * formatting. Template SQL convention: required `id` column (citations come
 * from here — auditable, not asserted), optional `entity_type` column for
 * cross-entity result sets, `value` column (required for scalars) holding the
 * per-row numeric contribution the oracle sums. The oracle is intentionally
 * thin: whatever SQL a template ships IS the ground truth.
 */
import type { Answer, AnswerKind, Citation, CqBinding, SupportRow } from "./cq.js"
import { MemorySqlError } from "./ontology.js"
import type { QueryResult, Store } from "./store.js"

const citationKey = (c: Citation): string => `${c.entityType} ${c.id}`

/** Dedupe + sort citations into canonical order (also used by cq.ts's canonicalizeAnswer). */
export const canonicalCitations = (citations: ReadonlyArray<Citation>): Citation[] => {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const c of citations) {
    if (!seen.has(citationKey(c))) {
      seen.add(citationKey(c))
      out.push({ entityType: c.entityType, id: c.id })
    }
  }
  return out.sort((a, b) =>
    a.entityType === b.entityType ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.entityType < b.entityType ? -1 : 1
  )
}

/**
 * Fold a support set into a canonical Answer — the single shared
 * canonicalization used by BOTH the SQL oracle and the GraphPath:
 * set -> sorted unique supporting ids; scalar -> sum of per-row contributions
 * (0 when empty); boolean -> "at least one supporting row exists".
 */
export const answerFromSupport = (kind: AnswerKind, support: ReadonlyArray<SupportRow>): Answer => {
  const citations = canonicalCitations(support)
  switch (kind) {
    case "set":
      return { kind, value: [...new Set(support.map((s) => s.id))].sort(), citations }
    case "scalar":
      return { kind, value: support.reduce((acc, s) => acc + (s.value ?? 0), 0), citations }
    case "boolean":
      return { kind, value: support.length > 0, citations }
  }
}

/** The oracle surface the engines consume; tests substitute hand-computed oracles through it. */
export interface Oracle {
  readonly answer: (binding: CqBinding) => Promise<Answer>
}

/**
 * Map a query result to support rows per the convention above. Contract
 * violations (missing id/value columns, non-numeric contributions) are
 * template bugs, surfaced as MemorySqlError rather than silently mis-grading.
 */
const supportFromResult = (binding: CqBinding, result: QueryResult): SupportRow[] => {
  const template = binding.template
  const idIdx = result.columns.indexOf("id")
  if (idIdx < 0) {
    throw new MemorySqlError(
      "oracle",
      `template "${template.id}": oracle SQL must SELECT an "id" column (got: ${result.columns.join(", ") || "none"})`
    )
  }
  const typeIdx = result.columns.indexOf("entity_type")
  const valueIdx = result.columns.indexOf("value")
  if (template.expectedKind === "scalar" && valueIdx < 0) {
    throw new MemorySqlError("oracle", `template "${template.id}": scalar templates must SELECT a numeric "value" column`)
  }
  const support: SupportRow[] = []
  for (const row of result.rows) {
    const id = row[idIdx]
    if (id === null || id === undefined) continue // a NULL id cannot support anything (outer joins etc.)
    const rawType = typeIdx >= 0 ? row[typeIdx] : undefined
    const entityType = typeof rawType === "string" ? rawType : template.resultEntityType
    if (valueIdx >= 0) {
      const raw = row[valueIdx]
      const value = raw === null || raw === undefined ? 0 : typeof raw === "number" ? raw : Number(raw)
      if (Number.isNaN(value)) {
        throw new MemorySqlError("oracle", `template "${template.id}": non-numeric "value" column entry ${String(raw)}`)
      }
      support.push({ entityType, id: String(id), value })
    } else {
      support.push({ entityType, id: String(id) })
    }
  }
  return support
}

/** The deterministic SQL ground truth over a loaded store. */
export const makeSqlOracle = (store: Store): Oracle => ({
  answer: async (binding) => {
    const templateId = binding.template.id
    let sql: string
    try {
      sql = binding.template.sql(binding)
    } catch (cause) {
      if (cause instanceof MemorySqlError) throw cause
      throw new MemorySqlError("oracle", `template "${templateId}": sql() threw: ${String(cause)}`, cause)
    }
    let result: QueryResult
    try {
      result = await store.query(sql)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new MemorySqlError("oracle", `template "${templateId}": oracle query failed: ${message}`, cause)
    }
    return answerFromSupport(binding.template.expectedKind, supportFromResult(binding, result))
  }
})
