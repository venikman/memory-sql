/**
 * Shipped CQ templates over the FHIR top-50 ontology — the FHIR-specific
 * configuration layer of Stage 1. Each template pairs a question with two
 * independent execution plans: ground-truth SQL for the oracle and a typed
 * graph plan for the reference AnswerPath. The engine and both executors are
 * generic; everything FHIR lives here.
 *
 * Writing rules (they are what keeps the dual oracle honest):
 *   - SQL and graph plans MUST have identical NULL semantics: a SQL equality/
 *     range predicate drops NULLs, so every graph filter first requires the
 *     value to be present (typeof checks) before comparing.
 *   - Multi-target relations (e.g. `subject` -> Patient|Group) filter on BOTH
 *     `<rel>_ref` and `<rel>_ref_type`; single-target relations (e.g. Claim's
 *     `patient`, Coverage's `beneficiary`) have no ref_type column and must
 *     not mention one.
 *   - Temporal predicates are plain ISO-string comparison (dates are TEXT and
 *     the generator emits YYYY-MM-DD; see store/schema.ts) with REFERENCE_DATE
 *     as "today".
 *   - No FHIR identifier used here is a reserved SQL word, so identifiers stay
 *     unquoted (the reserved names — "group", "start", "end", "order" — do not
 *     occur in these queries).
 *   - Scalar templates select each contributing row exactly once (no joins),
 *     because the oracle sums the `value` column.
 *
 * Domain notes: "denied claim" is modeled as a Claim whose ClaimResponse has
 * outcome = 'error' (FHIR claims carry no denial status themselves).
 * "Prescribing practitioner" uses MedicationRequest.recorder — its targets
 * (Practitioner|PractitionerRole) make it the practitioner-typed authorship
 * relation in the trimmed ontology.
 */
import { sqlLiteral } from "../store/load.js"
import { REFERENCE_DATE } from "../synth/generate.js"
import type { CqBinding, CqTemplate, GraphNode, GraphView, ParamSpec, SupportRow } from "./model.js"
import { paramPeriod, paramString } from "./model.js"

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const PATIENT: ParamSpec = { name: "patient", kind: "entity-id", entityType: "Patient" }
const PERIOD: ParamSpec = { name: "period", kind: "period" }

/** SQL literal of the bound patient id. */
const pid = (b: CqBinding): string => sqlLiteral(paramString(b, "patient"))

const supportOf = (node: GraphNode): SupportRow => ({
  entityType: node.entityType,
  id: String(node.row["id"] ?? "")
})

const patientOf = (g: GraphView, b: CqBinding): GraphNode | undefined =>
  g.node("Patient", paramString(b, "patient"))

/** Present-and-in-range check mirroring SQL `col >= start AND col <= end`. */
const inPeriod = (value: unknown, start: string, end: string): value is string =>
  typeof value === "string" && value >= start && value <= end

/** A code the synthetic generator can never emit (open code pools are `<attr>-1..6`). */
const NONEXISTENT_CODE = "code-999"

// ─────────────────────────────────────────────────────────────────────────────
// Point lookups
// ─────────────────────────────────────────────────────────────────────────────

const activeConditions: CqTemplate = {
  id: "active-conditions",
  regime: "point-lookup",
  expectedKind: "set",
  resultEntityType: "Condition",
  params: [PATIENT],
  text: (b) => `Which conditions of patient ${paramString(b, "patient")} are clinically active?`,
  sql: (b) =>
    `SELECT id FROM condition WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND clinical_status = 'active'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("Condition", "subject", patient)
      .filter((n) => n.row["clinical_status"] === "active")
      .map(supportOf)
  }
}

const completedImmunizations: CqTemplate = {
  id: "completed-immunizations",
  regime: "point-lookup",
  expectedKind: "set",
  resultEntityType: "Immunization",
  params: [PATIENT],
  text: (b) => `Which immunizations were completed for patient ${paramString(b, "patient")}?`,
  sql: (b) =>
    `SELECT id FROM immunization WHERE patient_ref = ${pid(b)} AND status = 'completed'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("Immunization", "patient", patient)
      .filter((n) => n.row["status"] === "completed")
      .map(supportOf)
  }
}

const activeAllergyToCode: CqTemplate = {
  id: "active-allergy-to-code",
  regime: "point-lookup",
  expectedKind: "boolean",
  resultEntityType: "AllergyIntolerance",
  params: [
    PATIENT,
    { name: "code", kind: "attribute-value", entityType: "AllergyIntolerance", attribute: "code" }
  ],
  text: (b) =>
    `Does patient ${paramString(b, "patient")} have an active allergy or intolerance to code "${paramString(b, "code")}"?`,
  sql: (b) =>
    `SELECT id FROM allergy_intolerance WHERE patient_ref = ${pid(b)} AND clinical_status = 'active' AND code = ${sqlLiteral(paramString(b, "code"))}`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const code = paramString(b, "code")
    return g
      .incoming("AllergyIntolerance", "patient", patient)
      .filter((n) => n.row["clinical_status"] === "active" && n.row["code"] === code)
      .map(supportOf)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Temporal
// ─────────────────────────────────────────────────────────────────────────────

const observationsInPeriod: CqTemplate = {
  id: "observations-in-period",
  regime: "temporal",
  expectedKind: "set",
  resultEntityType: "Observation",
  params: [PATIENT, PERIOD],
  text: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `Which observations were effective for patient ${paramString(b, "patient")} between ${start} and ${end}?`
  },
  sql: (b) => {
    const { start, end } = paramPeriod(b, "period")
    return `SELECT id FROM observation WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND effective >= ${sqlLiteral(start)} AND effective <= ${sqlLiteral(end)}`
  },
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const { start, end } = paramPeriod(b, "period")
    return g
      .incoming("Observation", "subject", patient)
      .filter((n) => inPeriod(n.row["effective"], start, end))
      .map(supportOf)
  }
}

const activeCoverageOnDate: CqTemplate = {
  id: "active-coverage-on-date",
  regime: "temporal",
  expectedKind: "set",
  resultEntityType: "Coverage",
  params: [PATIENT, { name: "date", kind: "date" }],
  text: (b) =>
    `Which coverages of patient ${paramString(b, "patient")} were active on ${paramString(b, "date")}?`,
  // active status AND the period covers the date; an open-ended period
  // (period_end NULL) counts as still covering — mirrored exactly in the graph.
  sql: (b) => {
    const date = sqlLiteral(paramString(b, "date"))
    return `SELECT id FROM coverage WHERE beneficiary_ref = ${pid(b)} AND status = 'active' AND period_start IS NOT NULL AND period_start <= ${date} AND (period_end IS NULL OR period_end >= ${date})`
  },
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const date = paramString(b, "date")
    return g
      .incoming("Coverage", "beneficiary", patient)
      .filter((n) => {
        const start = n.row["period_start"]
        const end = n.row["period_end"]
        return (
          n.row["status"] === "active" &&
          typeof start === "string" &&
          start <= date &&
          (end === null || end === undefined || (typeof end === "string" && end >= date))
        )
      })
      .map(supportOf)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-entity
// ─────────────────────────────────────────────────────────────────────────────

const deniedClaims: CqTemplate = {
  id: "denied-claims",
  regime: "cross-entity",
  expectedKind: "set",
  resultEntityType: "Claim",
  params: [PATIENT],
  text: (b) =>
    `Which claims of patient ${paramString(b, "patient")} were denied (claim response outcome 'error')?`,
  sql: (b) =>
    `SELECT DISTINCT c.id AS id FROM claim c JOIN claim_response cr ON cr.request_ref = c.id WHERE c.patient_ref = ${pid(b)} AND cr.outcome = 'error'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("Claim", "patient", patient)
      .filter((claim) =>
        g.incoming("ClaimResponse", "request", claim).some((r) => r.row["outcome"] === "error")
      )
      .map(supportOf)
  }
}

const medicationRequestsWithMedications: CqTemplate = {
  id: "medication-requests-with-medications",
  regime: "cross-entity",
  expectedKind: "set",
  resultEntityType: "MedicationRequest",
  params: [PATIENT],
  text: (b) =>
    `Which medication requests exist for patient ${paramString(b, "patient")}, and which medications do they order?`,
  // Two entity types in one result set: the entity_type column tags each row.
  sql: (b) =>
    `SELECT 'MedicationRequest' AS entity_type, id FROM medication_request WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient'` +
    ` UNION ` +
    `SELECT 'Medication' AS entity_type, m.id AS id FROM medication m JOIN medication_request mr ON mr.medication_ref = m.id WHERE mr.subject_ref = ${pid(b)} AND mr.subject_ref_type = 'Patient'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const requests = g.incoming("MedicationRequest", "subject", patient)
    const medications = requests.flatMap((r) => {
      const med = g.follow(r, "medication")
      return med === undefined ? [] : [med]
    })
    return [...requests, ...medications].map(supportOf)
  }
}

const encountersAtOrganization: CqTemplate = {
  id: "encounters-at-organization",
  regime: "cross-entity",
  expectedKind: "set",
  resultEntityType: "Encounter",
  params: [PATIENT, { name: "organization", kind: "entity-id", entityType: "Organization" }],
  text: (b) =>
    `Which encounters did patient ${paramString(b, "patient")} have at organization ${paramString(b, "organization")}?`,
  sql: (b) =>
    `SELECT id FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND service_provider_ref = ${sqlLiteral(paramString(b, "organization"))}`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const org = paramString(b, "organization")
    return g
      .incoming("Encounter", "subject", patient)
      // ref-column comparison (not follow) to keep semantics identical to the
      // SQL predicate even on worlds with dangling service_provider refs
      .filter((n) => n.row["service_provider_ref"] === org)
      .map(supportOf)
  }
}

const practitionersRecordingMedicationRequests: CqTemplate = {
  id: "practitioners-recording-medication-requests",
  regime: "cross-entity",
  expectedKind: "set",
  resultEntityType: "Practitioner",
  params: [PATIENT],
  text: (b) =>
    `Which practitioners recorded medication requests for patient ${paramString(b, "patient")}?`,
  sql: (b) =>
    `SELECT DISTINCT p.id AS id FROM practitioner p JOIN medication_request mr ON mr.recorder_ref = p.id AND mr.recorder_ref_type = 'Practitioner' WHERE mr.subject_ref = ${pid(b)} AND mr.subject_ref_type = 'Patient'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("MedicationRequest", "subject", patient)
      .flatMap((mr) => {
        const recorder = g.follow(mr, "recorder")
        return recorder !== undefined && recorder.entityType === "Practitioner" ? [recorder] : []
      })
      .map(supportOf)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates
// ─────────────────────────────────────────────────────────────────────────────

const eobPaidTotalInPeriod: CqTemplate = {
  id: "eob-paid-total-in-period",
  regime: "aggregate",
  expectedKind: "scalar",
  resultEntityType: "ExplanationOfBenefit",
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
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    const { start, end } = paramPeriod(b, "period")
    return g.incoming("ExplanationOfBenefit", "patient", patient).flatMap((n) => {
      const cents = n.row["payment_amount_cents"]
      return inPeriod(n.row["created"], start, end) && typeof cents === "number"
        ? [{ entityType: n.entityType, id: String(n.row["id"] ?? ""), value: cents }]
        : []
    })
  }
}

const encounterCount: CqTemplate = {
  id: "encounter-count",
  regime: "aggregate",
  expectedKind: "scalar",
  resultEntityType: "Encounter",
  params: [PATIENT],
  text: (b) => `How many encounters does patient ${paramString(b, "patient")} have on record?`,
  sql: (b) =>
    `SELECT id, 1 AS value FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient'`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("Encounter", "subject", patient)
      .map((n) => ({ entityType: n.entityType, id: String(n.row["id"] ?? ""), value: 1 }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls — the clean world provably contains no matching rows, so
// the only correct answer is empty; anything else is fabrication.
// ─────────────────────────────────────────────────────────────────────────────

const ncFutureEncounters: CqTemplate = {
  id: "nc-future-encounters",
  regime: "negative-control",
  expectedKind: "set",
  resultEntityType: "Encounter",
  params: [PATIENT],
  text: (b) =>
    `Which encounters of patient ${paramString(b, "patient")} start after ${REFERENCE_DATE} (i.e. in the future)?`,
  // the generator draws every period_start strictly before REFERENCE_DATE
  sql: (b) =>
    `SELECT id FROM encounter WHERE subject_ref = ${pid(b)} AND subject_ref_type = 'Patient' AND period_start > ${sqlLiteral(REFERENCE_DATE)}`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("Encounter", "subject", patient)
      .filter((n) => {
        const start = n.row["period_start"]
        return typeof start === "string" && start > REFERENCE_DATE
      })
      .map(supportOf)
  }
}

const ncUnknownAllergyCode: CqTemplate = {
  id: "nc-unknown-allergy-code",
  regime: "negative-control",
  expectedKind: "set",
  resultEntityType: "AllergyIntolerance",
  params: [PATIENT],
  text: (b) =>
    `Which allergy or intolerance records of patient ${paramString(b, "patient")} carry the code "${NONEXISTENT_CODE}"?`,
  sql: (b) =>
    `SELECT id FROM allergy_intolerance WHERE patient_ref = ${pid(b)} AND code = ${sqlLiteral(NONEXISTENT_CODE)}`,
  graph: (g, b) => {
    const patient = patientOf(g, b)
    if (patient === undefined) return []
    return g
      .incoming("AllergyIntolerance", "patient", patient)
      .filter((n) => n.row["code"] === NONEXISTENT_CODE)
      .map(supportOf)
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shipped suite: 13 templates spanning all five regimes
 * (3 point-lookup, 2 temporal, 4 cross-entity, 2 aggregate, 2 negative-control).
 */
export const fhirCqTemplates: ReadonlyArray<CqTemplate> = [
  activeConditions,
  completedImmunizations,
  activeAllergyToCode,
  observationsInPeriod,
  activeCoverageOnDate,
  deniedClaims,
  medicationRequestsWithMedications,
  encountersAtOrganization,
  practitionersRecordingMedicationRequests,
  eobPaidTotalInPeriod,
  encounterCount,
  ncFutureEncounters,
  ncUnknownAllergyCode
]
