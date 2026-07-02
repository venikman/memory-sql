/**
 * Stage 1 — the CQ dual oracle. A competency question is a parametrized
 * template answered two independent ways — the SQL oracle (ground truth,
 * oracle.ts) and a pluggable AnswerPath — then graded with the four-way
 * verdict. This module owns the canonical Answer form + verdict rules, the 13
 * FHIR templates (ALL FHIR knowledge lives here; the engines are
 * ontology-generic), `bindTemplates` (Monte-Carlo sampling from the ACTUAL
 * world, round-robin over templates), the reference GraphPath, and `runCq` ->
 * CqReport. Template rules: SQL and graph plans MUST share NULL semantics (a
 * SQL predicate drops NULLs, so graph filters require presence before
 * comparing); multi-target relations filter on BOTH `<rel>_ref` and
 * `<rel>_ref_type`; temporal predicates are plain ISO TEXT comparison with
 * REFERENCE_DATE as "today"; scalar templates select each contributing row
 * exactly once.
 */
import { answerFromSupport, canonicalCitations, makeSqlOracle } from "./oracle.js"
import type { Oracle } from "./oracle.js"
import { MemorySqlError, getEntityType } from "./ontology.js"
import type { Ontology, Relation } from "./ontology.js"
import { REFERENCE_DATE, formatIsoDate, parseIsoDays } from "./rng.js"
import type { Rng } from "./rng.js"
import { loadWorld, relationRefColumn, relationRefTypeColumn, sqlLiteral } from "./store.js"
import type { InstanceWorld, Row, Store } from "./store.js"

// ── Answers, citations, verdicts ─────────────────────────────────────────────

/** Question regimes — each stresses a different retrieval competency. */
export type CqRegime = "point-lookup" | "cross-entity" | "aggregate" | "temporal" | "negative-control"

/** Fixed presentation order for per-regime breakdowns. */
const CQ_REGIMES: ReadonlyArray<CqRegime> = ["point-lookup", "cross-entity", "aggregate", "temporal", "negative-control"]

export type AnswerKind = "set" | "scalar" | "boolean"

/** A citation names the exact stored row that supports (part of) an answer. */
export interface Citation { readonly entityType: string; readonly id: string }

export type ScalarValue = number | string | boolean | null

/** 'set' answers are sorted unique row ids; 'scalar'/'boolean' are single values. */
export type AnswerValue = ReadonlyArray<string> | ScalarValue

export interface Answer { readonly kind: AnswerKind; readonly value: AnswerValue; readonly citations: ReadonlyArray<Citation> }

/** One supporting row, with an optional numeric contribution for scalar answers. */
export interface SupportRow { readonly entityType: string; readonly id: string; readonly value?: number }

/** Normalize an Answer into canonical form (set values + citations deduped and
 * sorted). Idempotent; applied before any verdict math so plug-in paths are not
 * penalized for row ordering. */
export const canonicalizeAnswer = (answer: Answer): Answer => {
  const citations = canonicalCitations(answer.citations)
  if (answer.kind === "set" && Array.isArray(answer.value)) {
    return { kind: answer.kind, value: [...new Set(answer.value.map(String))].sort(), citations }
  }
  return { kind: answer.kind, value: answer.value, citations }
}

export type Verdict = "match" | "missing" | "divergent" | "unsupported-citation"

/** "The path returned nothing": empty set, or a null scalar. Booleans are never
 * empty — a wrong `false` is divergent, not missing; a scalar `0` is a claim. */
export const isEmptyAnswer = (answer: Answer): boolean =>
  answer.kind === "set" ? Array.isArray(answer.value) && answer.value.length === 0 : answer.kind === "scalar" && answer.value === null

/** Structural value equality over canonicalized answers (kind mismatch = unequal;
 * Object.is on scalars/booleans — no string coercion). */
export const answerValuesEqual = (a: Answer, b: Answer): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind === "set") {
    const av = a.value
    const bv = b.value
    if (!Array.isArray(av) || !Array.isArray(bv)) return false
    return av.length === bv.length && av.every((v, i) => v === bv[i])
  }
  return Object.is(a.value, b.value)
}

/** Path citations that do NOT participate in the oracle's support set. The oracle's
 * citations ARE its support set, so containment IS the mechanical citation audit. */
const unsupportedCitations = (oracle: Answer, path: Answer): Citation[] =>
  path.citations.filter((c) => !oracle.citations.some((o) => o.entityType === c.entityType && o.id === c.id))

/** Four-way verdict per SPEC (inputs canonicalized defensively). Order matters: an
 * empty path answer against a non-empty oracle is `missing` even though the values
 * also differ — failing to answer is diagnostically different from answering wrongly. */
export const computeVerdict = (oracle: Answer, path: Answer): Verdict => {
  const o = canonicalizeAnswer(oracle)
  const p = canonicalizeAnswer(path)
  if (isEmptyAnswer(p) && !isEmptyAnswer(o)) return "missing"
  if (!answerValuesEqual(o, p)) return "divergent"
  return unsupportedCitations(o, p).length > 0 ? "unsupported-citation" : "match"
}

// ── Stable answer-value keys (shared with sim.ts, which must grade exactly as
// strictly as computeVerdict — order-insensitive sets, no type coercion) ─────

/** Recursive key-sorted serialization (a JSON.stringify replacer ARRAY would
 * filter nested keys down to the top-level key set — never use one here). */
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const rec = value as Record<string, unknown>
  return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`
}

/** Type-tagged so `3500`, `"3500"`, `true` and `"true"` never collide. */
export const stableKey = (el: unknown): string => {
  if (el === null || el === undefined) return "null"
  if (typeof el === "string") return `s:${el}`
  if (typeof el === "number") return `n:${String(el)}`
  if (typeof el === "boolean") return `b:${String(el)}`
  if (Array.isArray(el)) return `[${el.map(stableKey).join(",")}]`
  const rec = el as Record<string, unknown>
  // Citation-shaped / row-shaped elements identify by (entityType, id).
  if (typeof rec["id"] === "string") return `${typeof rec["entityType"] === "string" ? rec["entityType"] : ""}:${rec["id"]}`
  return stableStringify(rec)
}

/** Render an answer value as a stable, order-insensitive string (reports). */
export const canonicalValue = (value: unknown): string =>
  Array.isArray(value) ? value.map(stableKey).sort().join("; ") : stableKey(value)

// ── Templates, parameters, bindings ──────────────────────────────────────────

/** A closed date interval, ISO YYYY-MM-DD on both ends (TEXT-comparable). */
export interface Period { readonly start: string; readonly end: string }

export type ParamValue = string | Period

export const isPeriod = (value: ParamValue): value is Period => typeof value !== "string"

/** How the sampler fills one template parameter (real ids/values, or the product's date range). */
export type ParamSpec =
  | { readonly name: string; readonly kind: "entity-id"; readonly entityType: string }
  | { readonly name: string; readonly kind: "attribute-value"; readonly entityType: string; readonly attribute: string }
  | { readonly name: string; readonly kind: "date"; readonly min?: string; readonly max?: string }
  | { readonly name: string; readonly kind: "period"; readonly min?: string; readonly max?: string }

export type CqParams = Readonly<Record<string, ParamValue>>

/** A template bound to concrete parameter values — the unit both oracles answer. */
export interface CqBinding { readonly template: CqTemplate; readonly params: CqParams }

/** Copy of a binding with one parameter replaced (metamorphic transforms use this). */
export const withParam = (binding: CqBinding, name: string, value: ParamValue): CqBinding => ({
  template: binding.template,
  params: { ...binding.params, [name]: value }
})

/** Read a string parameter; throwing here is a template-configuration bug. */
export const paramString = (binding: CqBinding, name: string): string => {
  const value = binding.params[name]
  if (typeof value !== "string") {
    throw new MemorySqlError("cq", `template "${binding.template.id}": parameter "${name}" is ${value === undefined ? "missing" : "not a string"}`)
  }
  return value
}

/** Read a period parameter; throwing here is a template-configuration bug. */
export const paramPeriod = (binding: CqBinding, name: string): Period => {
  const value = binding.params[name]
  if (value === undefined || typeof value === "string") {
    throw new MemorySqlError("cq", `template "${binding.template.id}": parameter "${name}" is ${value === undefined ? "missing" : "not a period"}`)
  }
  return value
}

/** A row tagged with its entity type — the node of the typed instance graph. */
export interface GraphNode { readonly entityType: string; readonly row: Row }

/** Typed traversal over an in-memory InstanceWorld. The ontology drives the
 * typing: single-target relations resolve via their declared target, multi-target
 * ones via the `<relation>_ref_type` column. `follow` returns undefined on
 * null/dangling refs; `incoming` is the reverse lookup. */
export interface GraphView {
  readonly nodes: (entityType: string) => ReadonlyArray<GraphNode>
  readonly node: (entityType: string, id: string) => GraphNode | undefined
  readonly follow: (node: GraphNode, relation: string) => GraphNode | undefined
  readonly incoming: (sourceType: string, relation: string, target: GraphNode) => ReadonlyArray<GraphNode>
}

/** A competency question template. `sql` compiles the binding to the oracle's
 * ground-truth SQL (support-set convention in oracle.ts); `graph` computes the
 * same support set by typed traversal — the reference AnswerPath executes it.
 * `resultEntityType` types supporting rows when the SQL result has no
 * entity_type column. */
export interface CqTemplate {
  readonly id: string
  readonly regime: CqRegime
  readonly expectedKind: AnswerKind
  readonly resultEntityType: string
  readonly params: ReadonlyArray<ParamSpec>
  readonly text: (binding: CqBinding) => string
  readonly sql: (binding: CqBinding) => string
  readonly graph: (graph: GraphView, binding: CqBinding) => ReadonlyArray<SupportRow>
}

// ── The 13 shipped FHIR templates (3 point-lookup, 2 temporal, 4 cross-entity,
// 2 aggregate, 2 negative-control). "Denied claim" = Claim whose ClaimResponse
// has outcome 'error'; "prescribing practitioner" = MedicationRequest.recorder.

const PATIENT: ParamSpec = { name: "patient", kind: "entity-id", entityType: "Patient" }
const PERIOD: ParamSpec = { name: "period", kind: "period" }

const pid = (b: CqBinding): string => sqlLiteral(paramString(b, "patient"))

const supportOf = (node: GraphNode): SupportRow => ({ entityType: node.entityType, id: String(node.row["id"] ?? "") })

/** Resolve the bound patient node and apply `f`; missing patient = empty support. */
const forPatient = (g: GraphView, b: CqBinding, f: (patient: GraphNode) => ReadonlyArray<SupportRow>): ReadonlyArray<SupportRow> => {
  const patient = g.node("Patient", paramString(b, "patient"))
  return patient === undefined ? [] : f(patient)
}

/** Graph plan shared by most templates: the patient's incoming rows of one type, filtered. */
const incomingWhere =
  (type: string, rel: string, pred: (n: GraphNode, b: CqBinding, g: GraphView) => boolean) =>
  (g: GraphView, b: CqBinding): ReadonlyArray<SupportRow> =>
    forPatient(g, b, (p) => g.incoming(type, rel, p).filter((n) => pred(n, b, g)).map(supportOf))

/** Present-and-in-range check mirroring SQL `col >= start AND col <= end`. */
const inPeriod = (value: unknown, start: string, end: string): value is string =>
  typeof value === "string" && value >= start && value <= end

/** A code the synthetic generator can never emit (open code pools are `<attr>-1..6`). */
const NONEXISTENT_CODE = "code-999"

const activeConditions: CqTemplate = {
  id: "active-conditions", regime: "point-lookup", expectedKind: "set", resultEntityType: "Condition", params: [PATIENT],
  text: (b) => `Which conditions of patient ${paramString(b, "patient")} are clinically active?`,
  sql: (b) => `SELECT id FROM condition WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND clinical_status = 'active'`,
  graph: incomingWhere("Condition", "subject", (n) => n.row["clinical_status"] === "active")
}

const completedImmunizations: CqTemplate = {
  id: "completed-immunizations", regime: "point-lookup", expectedKind: "set", resultEntityType: "Immunization", params: [PATIENT],
  text: (b) => `Which immunizations were completed for patient ${paramString(b, "patient")}?`,
  sql: (b) => `SELECT id FROM immunization WHERE patient_ref = ${pid(b)} AND status = 'completed'`,
  graph: incomingWhere("Immunization", "patient", (n) => n.row["status"] === "completed")
}

const activeAllergyToCode: CqTemplate = {
  id: "active-allergy-to-code", regime: "point-lookup", expectedKind: "boolean", resultEntityType: "AllergyIntolerance",
  params: [PATIENT, { name: "code", kind: "attribute-value", entityType: "AllergyIntolerance", attribute: "code" }],
  text: (b) => `Does patient ${paramString(b, "patient")} have an active allergy or intolerance to code "${paramString(b, "code")}"?`,
  sql: (b) =>
    `SELECT id FROM allergy_intolerance WHERE patient_ref = ${pid(b)} AND clinical_status = 'active' AND code = ${sqlLiteral(paramString(b, "code"))}`,
  graph: incomingWhere("AllergyIntolerance", "patient", (n, b) => n.row["clinical_status"] === "active" && n.row["code"] === paramString(b, "code"))
}

const observationsInPeriod: CqTemplate = {
  id: "observations-in-period", regime: "temporal", expectedKind: "set", resultEntityType: "Observation", params: [PATIENT, PERIOD],
  text: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `Which observations were effective for patient ${paramString(b, "patient")} between ${start} and ${end}?`
  },
  sql: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `SELECT id FROM observation WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND effective >= ${sqlLiteral(start)} AND effective <= ${sqlLiteral(end)}`
  },
  graph: incomingWhere("Observation", "subject", (n, b) => {
    const { start, end } = paramPeriod(b, "period")
    return inPeriod(n.row["effective"], start, end)
  })
}

const activeCoverageOnDate: CqTemplate = {
  id: "active-coverage-on-date", regime: "temporal", expectedKind: "set", resultEntityType: "Coverage",
  params: [PATIENT, { name: "date", kind: "date" }],
  text: (b) => `Which coverages of patient ${paramString(b, "patient")} were active on ${paramString(b, "date")}?`,
  // active AND the period covers the date; an open-ended period (period_end
  // NULL) counts as still covering — mirrored exactly in the graph plan.
  sql: (b) => {
    const date = sqlLiteral(paramString(b, "date"))
    return `SELECT id FROM coverage WHERE beneficiary_ref = ${pid(b)} AND status = 'active' AND period_start IS NOT NULL AND period_start <= ${date} AND (period_end IS NULL OR period_end >= ${date})`
  },
  graph: incomingWhere("Coverage", "beneficiary", (n, b) => {
    const date = paramString(b, "date")
    const start = n.row["period_start"]
    const end = n.row["period_end"]
    return n.row["status"] === "active" && typeof start === "string" && start <= date &&
      (end === null || end === undefined || (typeof end === "string" && end >= date))
  })
}

const deniedClaims: CqTemplate = {
  id: "denied-claims", regime: "cross-entity", expectedKind: "set", resultEntityType: "Claim", params: [PATIENT],
  text: (b) => `Which claims of patient ${paramString(b, "patient")} were denied (claim response outcome 'error')?`,
  sql: (b) =>
    `SELECT DISTINCT c.id AS id FROM claim c JOIN claim_response cr ON cr.request_ref = c.id WHERE c.patient_ref = ${pid(b)} AND cr.outcome = 'error'`,
  graph: incomingWhere("Claim", "patient", (claim, _b, g) => g.incoming("ClaimResponse", "request", claim).some((r) => r.row["outcome"] === "error"))
}

const medicationRequestsWithMedications: CqTemplate = {
  id: "medication-requests-with-medications", regime: "cross-entity", expectedKind: "set", resultEntityType: "MedicationRequest",
  params: [PATIENT],
  text: (b) => `Which medication requests exist for patient ${paramString(b, "patient")}, and which medications do they order?`,
  // Two entity types in one result set: the entity_type column tags each row.
  sql: (b) =>
    `SELECT 'MedicationRequest' AS entity_type, id FROM medication_request WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient'` +
    ` UNION ` +
    `SELECT 'Medication' AS entity_type, m.id AS id FROM medication m JOIN medication_request mr ON mr.medication_ref = m.id WHERE mr.subject_ref = ${pid(b)} AND mr.subject_ref_type = 'Patient'`,
  graph: (g, b) =>
    forPatient(g, b, (p) => {
      const requests = g.incoming("MedicationRequest", "subject", p)
      const medications = requests.flatMap((r) => {
        const med = g.follow(r, "medication")
        return med === undefined ? [] : [med]
      })
      return [...requests, ...medications].map(supportOf)
    })
}

const encountersAtOrganization: CqTemplate = {
  id: "encounters-at-organization", regime: "cross-entity", expectedKind: "set", resultEntityType: "Encounter",
  params: [PATIENT, { name: "organization", kind: "entity-id", entityType: "Organization" }],
  text: (b) => `Which encounters did patient ${paramString(b, "patient")} have at organization ${paramString(b, "organization")}?`,
  sql: (b) =>
    `SELECT id FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND service_provider_ref = ${sqlLiteral(paramString(b, "organization"))}`,
  // ref-column comparison (not follow) keeps semantics identical to the SQL
  // predicate even on worlds with dangling service_provider refs
  graph: incomingWhere("Encounter", "subject", (n, b) => n.row["service_provider_ref"] === paramString(b, "organization"))
}

const practitionersRecordingMedicationRequests: CqTemplate = {
  id: "practitioners-recording-medication-requests", regime: "cross-entity", expectedKind: "set", resultEntityType: "Practitioner",
  params: [PATIENT],
  text: (b) => `Which practitioners recorded medication requests for patient ${paramString(b, "patient")}?`,
  sql: (b) =>
    `SELECT DISTINCT p.id AS id FROM practitioner p JOIN medication_request mr ON mr.recorder_ref = p.id AND mr.recorder_ref_type = 'Practitioner' WHERE mr.subject_ref = ${pid(b)} AND mr.subject_ref_type = 'Patient'`,
  graph: (g, b) =>
    forPatient(g, b, (p) =>
      g.incoming("MedicationRequest", "subject", p)
        .flatMap((mr) => {
          const recorder = g.follow(mr, "recorder")
          return recorder !== undefined && recorder.entityType === "Practitioner" ? [recorder] : []
        })
        .map(supportOf)
    )
}

const eobPaidTotalInPeriod: CqTemplate = {
  id: "eob-paid-total-in-period", regime: "aggregate", expectedKind: "scalar", resultEntityType: "ExplanationOfBenefit",
  params: [PATIENT, PERIOD],
  text: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `What is the total EOB payment (in cents) for patient ${paramString(b, "patient")} created between ${start} and ${end}?`
  },
  // each in-period EOB with a payment contributes its cents once; NULL-payment
  // EOBs contribute nothing and are excluded from the support set on both paths
  sql: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `SELECT id, payment_amount_cents AS value FROM explanation_of_benefit WHERE patient_ref = ${pid(b)} AND created >= ${sqlLiteral(start)} AND created <= ${sqlLiteral(end)} AND payment_amount_cents IS NOT NULL`
  },
  graph: (g, b) =>
    forPatient(g, b, (p) => {
      const { start, end } = paramPeriod(b, "period")
      return g.incoming("ExplanationOfBenefit", "patient", p).flatMap((n) => {
        const cents = n.row["payment_amount_cents"]
        return inPeriod(n.row["created"], start, end) && typeof cents === "number"
          ? [{ entityType: n.entityType, id: String(n.row["id"] ?? ""), value: cents }]
          : []
      })
    })
}

const encounterCount: CqTemplate = {
  id: "encounter-count", regime: "aggregate", expectedKind: "scalar", resultEntityType: "Encounter", params: [PATIENT],
  text: (b) => `How many encounters does patient ${paramString(b, "patient")} have on record?`,
  sql: (b) => `SELECT id, 1 AS value FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient'`,
  graph: (g, b) =>
    forPatient(g, b, (p) => g.incoming("Encounter", "subject", p).map((n) => ({ entityType: n.entityType, id: String(n.row["id"] ?? ""), value: 1 })))
}

// Negative controls — the clean world provably contains no matching rows, so
// the only correct answer is empty; anything else is fabrication.

const ncFutureEncounters: CqTemplate = {
  id: "nc-future-encounters", regime: "negative-control", expectedKind: "set", resultEntityType: "Encounter", params: [PATIENT],
  text: (b) => `Which encounters of patient ${paramString(b, "patient")} start after ${REFERENCE_DATE} (i.e. in the future)?`,
  // the generator draws every period_start strictly before REFERENCE_DATE
  sql: (b) =>
    `SELECT id FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND period_start > ${sqlLiteral(REFERENCE_DATE)}`,
  graph: incomingWhere("Encounter", "subject", (n) => {
    const start = n.row["period_start"]
    return typeof start === "string" && start > REFERENCE_DATE
  })
}

const ncUnknownAllergyCode: CqTemplate = {
  id: "nc-unknown-allergy-code", regime: "negative-control", expectedKind: "set", resultEntityType: "AllergyIntolerance",
  params: [PATIENT],
  text: (b) => `Which allergy or intolerance records of patient ${paramString(b, "patient")} carry the code "${NONEXISTENT_CODE}"?`,
  sql: (b) => `SELECT id FROM allergy_intolerance WHERE patient_ref = ${pid(b)} AND code = ${sqlLiteral(NONEXISTENT_CODE)}`,
  graph: incomingWhere("AllergyIntolerance", "patient", (n) => n.row["code"] === NONEXISTENT_CODE)
}

/** The shipped suite: 13 templates spanning all five regimes. */
export const fhirCqTemplates: ReadonlyArray<CqTemplate> = [
  activeConditions, completedImmunizations, activeAllergyToCode, observationsInPeriod, activeCoverageOnDate,
  deniedClaims, medicationRequestsWithMedications, encountersAtOrganization, practitionersRecordingMedicationRequests,
  eobPaidTotalInPeriod, encounterCount, ncFutureEncounters, ncUnknownAllergyCode
]

// ── Monte-Carlo binding sampler (pure civil-day arithmetic — no Date) ────────

const isoDays = (iso: string): number => {
  const days = parseIsoDays(iso)
  if (days === null) throw new MemorySqlError("cq", `invalid ISO date "${iso}" in a template's date range`)
  return days
}

const sampleDate = (min: string, max: string, rng: Rng): string => {
  const from = isoDays(min)
  return formatIsoDate(from + rng.int(0, Math.max(0, isoDays(max) - from)))
}

/** Default sampling window = the synth generator's data window up to "today". */
const DEFAULT_MIN_DATE = "2020-01-01"
const DEFAULT_MAX_PERIOD_START = "2025-12-31"

const sampleParam = (spec: ParamSpec, world: InstanceWorld, rng: Rng): ParamValue | undefined => {
  switch (spec.kind) {
    case "entity-id": {
      const ids: string[] = []
      for (const row of world[spec.entityType] ?? []) {
        if (typeof row["id"] === "string") ids.push(row["id"])
      }
      return ids.length > 0 ? rng.pick(ids) : undefined
    }
    case "attribute-value": {
      // Frequency-weighted pick from real data; a world with no value at all
      // falls back to the generator's first pool code so the binding stays
      // askable (both oracles then agree on an empty answer).
      const values: string[] = []
      for (const row of world[spec.entityType] ?? []) {
        const v = row[spec.attribute]
        if (v !== null && v !== undefined) values.push(String(v))
      }
      return values.length > 0 ? rng.pick(values) : `${spec.attribute}-1`
    }
    case "date":
      return sampleDate(spec.min ?? DEFAULT_MIN_DATE, spec.max ?? REFERENCE_DATE, rng)
    case "period": {
      // Spans start at 0 (a single-day period) so the suite exercises the
      // short-period regime too — an answer layer that breaks on narrow
      // windows must be caught here, not only by sim's temporal narrowing.
      const start = sampleDate(spec.min ?? DEFAULT_MIN_DATE, spec.max ?? DEFAULT_MAX_PERIOD_START, rng)
      return { start, end: formatIsoDate(isoDays(start) + rng.int(0, 720)) }
    }
  }
}

/** Sample `n` bindings, cycling templates round-robin and drawing every parameter
 * from the world via the seeded rng. A binding whose parameters cannot be sampled
 * (an entity type with no rows) is skipped, so the result may be shorter than `n`
 * on degenerate worlds — never on generated ones. */
export const bindTemplates = (templates: ReadonlyArray<CqTemplate>, world: InstanceWorld, rng: Rng, n: number): ReadonlyArray<CqBinding> => {
  const bindings: CqBinding[] = []
  if (templates.length === 0) return bindings
  for (let i = 0; i < n; i++) {
    const template = templates[i % templates.length] as CqTemplate
    const params: Record<string, ParamValue> = {}
    let complete = true
    for (const spec of template.params) {
      const value = sampleParam(spec, world, rng)
      if (value === undefined) {
        complete = false
        break
      }
      params[spec.name] = value
    }
    if (complete) bindings.push({ template, params: params as CqParams })
  }
  return bindings
}

// ── GraphPath — the reference AnswerPath (typed reference-walk, SQL-free) ────

/** The pluggable answer layer under test: any knowledge/memory/retrieval layer
 * implements `answer(binding)` and memory-sql grades it against the SQL oracle.
 * A rejected promise is recorded as an unanswered question (verdict `missing`),
 * never a suite crash. */
export interface AnswerPath {
  readonly name: string
  readonly answer: (binding: CqBinding) => Promise<Answer>
}

/** Index an InstanceWorld as a typed graph. Dangling references simply fail to
 * resolve (follow -> undefined) rather than throwing: on mutated stress worlds
 * the graph must stay walkable so the *engines* can observe the corruption. */
const makeWorldGraph = (world: InstanceWorld, ontology: Ontology): GraphView => {
  const nodesByType = new Map<string, GraphNode[]>()
  const byId = new Map<string, Map<string, GraphNode>>()
  for (const [entityType, rows] of Object.entries(world)) {
    const nodes: GraphNode[] = rows.map((row) => ({ entityType, row }))
    nodesByType.set(entityType, nodes)
    const index = new Map<string, GraphNode>()
    for (const node of nodes) {
      if (typeof node.row["id"] === "string") index.set(node.row["id"], node)
    }
    byId.set(entityType, index)
  }

  /** Relation metadata drives the typing; an undeclared relation is a template bug. */
  const relationOf = (entityType: string, relation: string): Relation => {
    const found = getEntityType(ontology, entityType)?.relations.find((r) => r.name === relation)
    if (found === undefined) throw new MemorySqlError("cq", `graph traversal: unknown relation ${entityType}.${relation}`)
    return found
  }

  const nodes = (entityType: string): ReadonlyArray<GraphNode> => nodesByType.get(entityType) ?? []

  return {
    nodes,
    node: (entityType, id) => byId.get(entityType)?.get(id),
    follow: (from, relation) => {
      const rel = relationOf(from.entityType, relation)
      const ref = from.row[relationRefColumn(relation)]
      if (typeof ref !== "string") return undefined
      const targetType = rel.target.length > 1 ? from.row[relationRefTypeColumn(relation)] : rel.target[0]
      return typeof targetType === "string" ? byId.get(targetType)?.get(ref) : undefined
    },
    incoming: (sourceType, relation, target) => {
      // multi-target relations must also match on ref_type — the same id could
      // legitimately exist under several entity types in hand-rolled worlds
      const rel = relationOf(sourceType, relation)
      const refCol = relationRefColumn(relation)
      const typeCol = relationRefTypeColumn(relation)
      const multiTarget = rel.target.length > 1
      const targetId = target.row["id"]
      if (typeof targetId !== "string") return []
      return nodes(sourceType).filter((n) => n.row[refCol] === targetId && (!multiTarget || n.row[typeCol] === target.entityType))
    }
  }
}

/** Wrap a world as the reference AnswerPath. Each answer runs the binding's
 * template graph plan over the typed world graph and canonicalizes the support
 * set with the same fold the SQL oracle uses — so a verdict difference can only
 * come from traversal semantics, never from formatting. */
export const makeGraphPath = (world: InstanceWorld, ontology: Ontology): AnswerPath => {
  const graph = makeWorldGraph(world, ontology)
  return {
    name: "graph-path",
    answer: async (binding) => {
      try {
        return answerFromSupport(binding.template.expectedKind, binding.template.graph(graph, binding))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new MemorySqlError("cq", `graph-path failed on template "${binding.template.id}": ${message}`, cause)
      }
    }
  }
}

// ── Suite runner + report ────────────────────────────────────────────────────

/** One graded question: both answers, the verdict, and the path failure if any
 * (`path` null = the path failed to produce an answer at all). */
export interface CqResult {
  readonly templateId: string
  readonly regime: CqRegime
  readonly question: string
  readonly binding: CqBinding
  readonly oracle: Answer
  readonly path: Answer | null
  readonly pathError: string | null
  readonly verdict: Verdict
}

export interface RegimeBreakdown {
  readonly regime: CqRegime
  readonly total: number
  readonly match: number
  readonly missing: number
  readonly divergent: number
  readonly unsupportedCitation: number
  readonly agreementRate: number
}

/** Per-template binding count — a template with 0 bindings is visible, never silently green. */
export interface TemplateBindings { readonly templateId: string; readonly regime: CqRegime; readonly bindings: number }

/** Verdict counts + rates: answerableRate (path produced a non-missing answer),
 * agreementRate (graded `match` — the headline dual-oracle number), and
 * citationResolvesRate (path citations resolving into the oracle's support set). */
export interface CqReport {
  readonly pathName: string
  readonly total: number
  readonly match: number
  readonly missing: number
  readonly divergent: number
  readonly unsupportedCitation: number
  readonly answerableRate: number
  readonly agreementRate: number
  readonly citationResolvesRate: number
  readonly byRegime: ReadonlyArray<RegimeBreakdown>
  readonly byTemplate: ReadonlyArray<TemplateBindings>
  readonly results: ReadonlyArray<CqResult>
}

/** `ontology` gives exact-DDL loading (all tables exist, even empty; omitted =
 * inferred from rows — fixtures); `oracle` substitutes ground truth; `templates`
 * feeds the 0-binding visibility rows (defaults to fhirCqTemplates). */
export interface RunCqOptions {
  readonly ontology?: Ontology
  readonly oracle?: Oracle
  readonly templates?: ReadonlyArray<CqTemplate>
}

/** Vacuous rates (no citations) read as 1 — nothing was wrong. */
const ratio = (num: number, den: number): number => (den === 0 ? 1 : num / den)

const questionOf = (binding: CqBinding): string => {
  try {
    return binding.template.text(binding)
  } catch {
    return binding.template.id // a text() bug must not take the suite down
  }
}

/**
 * Load the world, answer every binding with the oracle (ground truth — its
 * failure aborts the suite) and the path (its failure is data: verdict
 * `missing`), then fold verdicts into the report. Bindings run sequentially —
 * the store is a single connection by design. Throws MemorySqlError on an
 * empty binding list: nothing graded ≠ nothing wrong (SPEC gate semantics).
 */
export const runCq = async (
  store: Store,
  world: InstanceWorld,
  bindings: ReadonlyArray<CqBinding>,
  path: AnswerPath,
  opts?: RunCqOptions
): Promise<CqReport> => {
  if (bindings.length === 0) {
    throw new MemorySqlError(
      "cq",
      "0 bindings could be sampled from this world (empty or missing entity pools) — nothing was graded, and nothing graded is not nothing wrong"
    )
  }
  await loadWorld(store, opts?.ontology, world)
  const oracle = opts?.oracle ?? makeSqlOracle(store)

  const results: CqResult[] = []
  let supportedCitations = 0
  let totalCitations = 0

  for (const binding of bindings) {
    const oracleAnswer = canonicalizeAnswer(await oracle.answer(binding))
    const base = { templateId: binding.template.id, regime: binding.template.regime, question: questionOf(binding), binding, oracle: oracleAnswer }
    let raw: Answer
    try {
      raw = await path.answer(binding)
    } catch (cause) {
      results.push({ ...base, path: null, pathError: cause instanceof Error ? cause.message : String(cause), verdict: "missing" })
      continue
    }
    const pathAnswer = canonicalizeAnswer(raw)
    totalCitations += pathAnswer.citations.length
    supportedCitations += pathAnswer.citations.length - unsupportedCitations(oracleAnswer, pathAnswer).length
    results.push({ ...base, path: pathAnswer, pathError: null, verdict: computeVerdict(oracleAnswer, pathAnswer) })
  }

  const count = (rs: ReadonlyArray<CqResult>, v: Verdict): number => rs.filter((r) => r.verdict === v).length

  const byRegime: RegimeBreakdown[] = []
  for (const regime of CQ_REGIMES) {
    const rs = results.filter((r) => r.regime === regime)
    if (rs.length === 0) continue
    byRegime.push({
      regime,
      total: rs.length,
      match: count(rs, "match"),
      missing: count(rs, "missing"),
      divergent: count(rs, "divergent"),
      unsupportedCitation: count(rs, "unsupported-citation"),
      agreementRate: ratio(count(rs, "match"), rs.length)
    })
  }

  // Per-template counts over the DECLARED template list, so a template that
  // produced no binding on this world shows up as an explicit 0 row.
  const perTemplate = new Map<string, number>()
  for (const b of bindings) perTemplate.set(b.template.id, (perTemplate.get(b.template.id) ?? 0) + 1)
  const byTemplate: TemplateBindings[] = (opts?.templates ?? fhirCqTemplates).map((t) => ({
    templateId: t.id, regime: t.regime, bindings: perTemplate.get(t.id) ?? 0
  }))
  for (const b of bindings) {
    if (!byTemplate.some((t) => t.templateId === b.template.id)) {
      byTemplate.push({ templateId: b.template.id, regime: b.template.regime, bindings: perTemplate.get(b.template.id) ?? 0 })
    }
  }

  const answered = results.filter((r) => r.path !== null && r.verdict !== "missing").length

  return {
    pathName: path.name,
    total: results.length,
    match: count(results, "match"),
    missing: count(results, "missing"),
    divergent: count(results, "divergent"),
    unsupportedCitation: count(results, "unsupported-citation"),
    answerableRate: ratio(answered, results.length),
    agreementRate: ratio(count(results, "match"), results.length),
    citationResolvesRate: ratio(supportedCitations, totalCitations),
    byRegime,
    byTemplate,
    results
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/** Render a CqReport as plain text (verdict counts, rates, per-regime rows, per-template binding counts, ungraded templates). */
export const formatCqReport = (report: CqReport): string => {
  const lines: string[] = [
    `cq: path "${report.pathName}" vs SQL oracle — ${report.total} bindings over ${report.byTemplate.length} templates`,
    `  match ${report.match}  missing ${report.missing}  divergent ${report.divergent}  unsupported-citation ${report.unsupportedCitation}`,
    `  answerable ${pct(report.answerableRate)}  agreement ${pct(report.agreementRate)}  citations-resolve ${pct(report.citationResolvesRate)}`
  ]
  for (const r of report.byRegime) {
    lines.push(`  ${r.regime.padEnd(18)} total ${String(r.total).padStart(3)}  match ${String(r.match).padStart(3)}  agreement ${pct(r.agreementRate)}`)
  }
  lines.push(`  bindings/template: ${report.byTemplate.map((t) => `${t.templateId}=${t.bindings}`).join("  ")}`)
  const unsampled = report.byTemplate.filter((t) => t.bindings === 0)
  if (unsampled.length > 0) {
    lines.push(
      `  WARNING — ${unsampled.length} of ${report.byTemplate.length} templates produced no binding on this world and go ungraded: ${unsampled.map((t) => t.templateId).join(", ")}`
    )
  }
  return lines.join("\n")
}
