/**
 * SPEC testing contract #4 — oracle.
 *
 * Why this validates the ground truth: the SQL oracle is only trustworthy if
 * its mechanics — support-set convention (id / entity_type / value columns),
 * canonicalization (sorted unique ids, deduped sorted citations, integer-cents
 * sums), and template-bug surfacing — are exactly right. So we hand it a tiny
 * hand-rolled world plus purpose-built templates and compare against answers
 * computed by hand. The oracle is generic over any ontology, so these
 * templates are fixtures of this test, not the shipped FHIR ones (those are
 * cross-checked against the GraphPath in cq.test.js).
 */
import { describe, expect, it } from "vitest"
import {
  MemorySqlError,
  isEmptyAnswer,
  loadWorld,
  makeSqlOracle,
  openStore,
  paramPeriod,
  paramString,
  sqlLiteral
} from "memory-sql"

// ── Tiny world: 3 patients, 4 conditions, 4 EOBs — small enough to grade by eye ──
const tiny = {
  Patient: [
    { id: "patient-1", gender: "female" },
    { id: "patient-2", gender: "male" },
    { id: "patient-3", gender: "other" } // no conditions, no EOBs
  ],
  Condition: [
    { id: "condition-1", subject_ref: "patient-1", clinical_status: "active" },
    { id: "condition-2", subject_ref: "patient-1", clinical_status: "resolved" },
    { id: "condition-3", subject_ref: "patient-2", clinical_status: "active" },
    { id: "condition-4", subject_ref: "patient-1", clinical_status: "active" }
  ],
  ExplanationOfBenefit: [
    { id: "eob-1", patient_ref: "patient-1", created: "2025-03-10", payment_amount_cents: 1000 },
    { id: "eob-2", patient_ref: "patient-1", created: "2025-06-20", payment_amount_cents: 2500 },
    // outside the queried period — must NOT contribute:
    { id: "eob-3", patient_ref: "patient-1", created: "1999-01-05", payment_amount_cents: 7777 },
    // other patient — must NOT contribute:
    { id: "eob-4", patient_ref: "patient-2", created: "2025-04-01", payment_amount_cents: 500 }
  ]
}

// Fixture templates. `graph` is irrelevant to the SQL oracle; stubbed empty.
const noGraph = () => []

const activeConditions = {
  id: "test-active-conditions",
  regime: "point-lookup",
  expectedKind: "set",
  resultEntityType: "Condition",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `Active conditions of ${paramString(b, "patient")}`,
  // ORDER BY id DESC on purpose: canonicalization, not the SQL, must sort.
  sql: (b) =>
    `SELECT id FROM condition WHERE subject_ref = ${sqlLiteral(paramString(b, "patient"))}
     AND clinical_status = 'active' ORDER BY id DESC`,
  graph: noGraph
}

const totalPaid = {
  id: "test-total-paid",
  regime: "aggregate",
  expectedKind: "scalar",
  resultEntityType: "ExplanationOfBenefit",
  params: [
    { name: "patient", kind: "entity-id", entityType: "Patient" },
    { name: "period", kind: "period" }
  ],
  text: (b) => `Total EOB paid for ${paramString(b, "patient")}`,
  sql: (b) => {
    const period = paramPeriod(b, "period")
    return `SELECT id, payment_amount_cents AS value FROM explanation_of_benefit
            WHERE patient_ref = ${sqlLiteral(paramString(b, "patient"))}
            AND created BETWEEN ${sqlLiteral(period.start)} AND ${sqlLiteral(period.end)}`
  },
  graph: noGraph
}

const hasActiveCondition = {
  id: "test-has-active-condition",
  regime: "point-lookup",
  expectedKind: "boolean",
  resultEntityType: "Condition",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `Does ${paramString(b, "patient")} have an active condition?`,
  sql: (b) =>
    `SELECT id FROM condition WHERE subject_ref = ${sqlLiteral(paramString(b, "patient"))}
     AND clinical_status = 'active'`,
  graph: noGraph
}

const crossEntity = {
  id: "test-cross-entity",
  regime: "cross-entity",
  expectedKind: "set",
  resultEntityType: "Condition",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `All clinical + financial rows for ${paramString(b, "patient")}`,
  sql: (b) => {
    const patient = sqlLiteral(paramString(b, "patient"))
    return `SELECT id, 'Condition' AS entity_type FROM condition WHERE subject_ref = ${patient}
            UNION ALL
            SELECT id, 'ExplanationOfBenefit' AS entity_type FROM explanation_of_benefit
            WHERE patient_ref = ${patient}`
  },
  graph: noGraph
}

const bind = (template, params) => ({
  template,
  params
})

/** Run `f` over a fresh store pre-loaded with the tiny world (tables inferred from rows). */
const withTinyWorld = async (f) => {
  const store = await openStore()
  try {
    await loadWorld(store, undefined, tiny)
    return await f(store)
  } finally {
    store.close()
  }
}

/** Load the tiny world and answer all bindings with the SQL oracle. */
const oracleAnswers = (bindings) =>
  withTinyWorld(async (store) => {
    const oracle = makeSqlOracle(store)
    const answers = []
    for (const binding of bindings) {
      answers.push(await oracle.answer(binding))
    }
    return answers
  })

describe("oracle: hand-computed answers on a tiny world", () => {
  it("set answer: sorted unique ids with matching citations", async () => {
    const [p1, p2] = await oracleAnswers([
      bind(activeConditions, { patient: "patient-1" }),
      bind(activeConditions, { patient: "patient-2" })
    ])
    // Hand-computed: patient-1's active conditions are exactly 1 and 4;
    // canonical order is ascending despite the template's ORDER BY id DESC.
    expect(p1).toEqual({
      kind: "set",
      value: ["condition-1", "condition-4"],
      citations: [
        { entityType: "Condition", id: "condition-1" },
        { entityType: "Condition", id: "condition-4" }
      ]
    })
    expect(p2?.value).toEqual(["condition-3"])
  })

  it("scalar answer: integer-cents sum of per-row contributions", async () => {
    const period = { start: "2025-01-01", end: "2025-12-31" }
    const [p1, p2] = await oracleAnswers([
      bind(totalPaid, { patient: "patient-1", period }),
      bind(totalPaid, { patient: "patient-2", period })
    ])
    // Hand-computed: 1000 + 2500; eob-3 (1999) and eob-4 (patient-2) excluded.
    expect(p1?.value).toBe(3500)
    expect(p1?.citations).toEqual([
      { entityType: "ExplanationOfBenefit", id: "eob-1" },
      { entityType: "ExplanationOfBenefit", id: "eob-2" }
    ])
    expect(p2?.value).toBe(500)
  })

  it("scalar over empty support is the claim 0, not an absence", async () => {
    const [answer] = await oracleAnswers([
      bind(totalPaid, { patient: "patient-1", period: { start: "1990-01-01", end: "1990-12-31" } })
    ])
    expect(answer?.value).toBe(0)
    expect(answer?.citations).toEqual([])
    // Verdict semantics depend on this: a 0 total is answerable, not "missing".
    expect(isEmptyAnswer(answer)).toBe(false)
  })

  it("boolean answer: true iff a supporting row exists", async () => {
    const [yes, no] = await oracleAnswers([
      bind(hasActiveCondition, { patient: "patient-2" }),
      bind(hasActiveCondition, { patient: "patient-3" })
    ])
    expect(yes?.value).toBe(true)
    expect(yes?.citations).toEqual([{ entityType: "Condition", id: "condition-3" }])
    expect(no?.value).toBe(false)
    expect(no?.citations).toEqual([])
  })

  it("cross-entity sets take per-row entity types from the entity_type column", async () => {
    const [answer] = await oracleAnswers([bind(crossEntity, { patient: "patient-1" })])
    expect(answer?.citations).toEqual([
      // canonical citation order: entityType, then id
      { entityType: "Condition", id: "condition-1" },
      { entityType: "Condition", id: "condition-2" },
      { entityType: "Condition", id: "condition-4" },
      { entityType: "ExplanationOfBenefit", id: "eob-1" },
      { entityType: "ExplanationOfBenefit", id: "eob-2" },
      { entityType: "ExplanationOfBenefit", id: "eob-3" }
    ])
    expect(answer?.value).toEqual([
      "condition-1",
      "condition-2",
      "condition-4",
      "eob-1",
      "eob-2",
      "eob-3"
    ])
  })

  it("empty set answers stay empty (the negative-control building block)", async () => {
    const [answer] = await oracleAnswers([bind(activeConditions, { patient: "patient-3" })])
    expect(answer?.value).toEqual([])
    expect(answer?.citations).toEqual([])
    expect(isEmptyAnswer(answer)).toBe(true)
  })
})

describe("oracle: template-bug surfacing", () => {
  /** Answer one binding, capturing the rejection (a template bug must throw). */
  const oracleFailure = (binding) =>
    withTinyWorld((store) =>
      makeSqlOracle(store)
        .answer(binding)
        .then(
          () => null,
          (cause) => cause
        )
    )

  it("fails with an op-tagged MemorySqlError when the SQL breaks the support-set convention", async () => {
    const noIdColumn = {
      ...activeConditions,
      id: "test-no-id-column",
      sql: () => `SELECT clinical_status FROM condition`
    }
    const error = await oracleFailure(bind(noIdColumn, { patient: "patient-1" }))
    expect(error).toBeInstanceOf(MemorySqlError)
    expect(error.op).toBe("oracle")
    expect(String(error.message)).toMatch(/"id" column/)
  })

  it("fails with an op-tagged MemorySqlError when the query itself is invalid SQL", async () => {
    const brokenSql = {
      ...activeConditions,
      id: "test-broken-sql",
      sql: () => `SELECT id FROM no_such_table`
    }
    const error = await oracleFailure(bind(brokenSql, { patient: "patient-1" }))
    expect(error).toBeInstanceOf(MemorySqlError)
    expect(error.op).toBe("oracle")
    expect(String(error.message)).toMatch(/oracle query failed/)
  })
})
