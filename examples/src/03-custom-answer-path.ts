/**
 * Example 03 — THE PRODUCT DEMO: plug your own memory layer into memory-sql.
 *
 * `AnswerPath` is the plug-in surface: anything that can answer a bound
 * competency question — an LLM with a context window, a RAG stack, a wiki
 * agent, a graph store — implements `answer(binding): Promise<Answer>` and is
 * graded against the deterministic SQL oracle.
 *
 * Here the layer under test is `NotesPath`, a toy "notes file" memory: one
 * chart digest per patient, written once by a note-taker that reads the world,
 * then consulted (and ONLY the notes — never the database) to answer
 * questions. The note-taker is deliberately imperfect in ways real memory
 * layers are imperfect:
 *
 *   - busy charts get truncated  -> a value the oracle disagrees with -> divergent
 *   - provenance gets fabricated -> right answer, citation that resolves to
 *     no supporting row                                 -> unsupported-citation
 *   - whole topics never make it into the notes         -> missing
 *   - everything written down faithfully                -> match
 *
 * memory-sql was never told HOW NotesPath works. It generated the data, owns
 * the ground truth in SQL, and the CqReport says exactly where — and how —
 * the notes are wrong. Swap NotesPath for your own layer; the grading is the
 * same.
 *
 * Isolation: imports ONLY the published "memory-sql" surface (by package name).
 */
import type {
  Answer,
  AnswerPath,
  Citation,
  CqBinding,
  CqReport,
  CqTemplate,
  InstanceWorld,
  Row,
  SupportRow
} from "memory-sql"
import {
  generateWorld,
  loadFhirOntology,
  openStore,
  paramString,
  REFERENCE_DATE,
  runCq,
  sqlLiteral
} from "memory-sql"

const SEED = 2026

// ─────────────────────────────────────────────────────────────────────────────
// 1. Three competency questions, typed against the public CqTemplate model.
//    Examples 01/02 use the shipped FHIR templates; here we bring our own to
//    show the model is open: any question expressible as SQL (the oracle plan)
//    plus a typed traversal (the reference plan) over the ontology.
// ─────────────────────────────────────────────────────────────────────────────

const activeConditions: CqTemplate = {
  id: "notes/active-conditions",
  regime: "point-lookup",
  expectedKind: "set",
  resultEntityType: "Condition",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `Which active Conditions does ${paramString(b, "patient")} have?`,
  // `subject` is multi-target (Patient|Group), so the SQL filters ref AND
  // ref_type — mirroring how the graph plan's `incoming` resolves typing.
  sql: (b) =>
    `SELECT "id" FROM "condition" WHERE "subject_ref" = ${sqlLiteral(paramString(b, "patient"))}` +
    ` AND "subject_ref_type" = 'Patient' AND "clinical_status" = 'active' ORDER BY "id"`,
  graph: (g, b) => {
    const patient = g.node("Patient", paramString(b, "patient"))
    if (patient === undefined) return []
    return g
      .incoming("Condition", "subject", patient)
      .filter((n) => n.row["clinical_status"] === "active")
      .map((n) => ({ entityType: "Condition", id: String(n.row["id"]) }))
  }
}

// Scalar templates follow the oracle's support-set convention: one row per
// supporting instance with its numeric contribution in a "value" column — the
// oracle sums contributions, so citations stay auditable even for aggregates.
const eobPaidTotal: CqTemplate = {
  id: "notes/eob-paid-total",
  regime: "aggregate",
  expectedKind: "scalar",
  resultEntityType: "ExplanationOfBenefit",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `Total ExplanationOfBenefit payment (cents) for ${paramString(b, "patient")}?`,
  sql: (b) =>
    `SELECT "id", "payment_amount_cents" AS "value" FROM "explanation_of_benefit"` +
    ` WHERE "patient_ref" = ${sqlLiteral(paramString(b, "patient"))} ORDER BY "id"`,
  graph: (g, b) => {
    const patient = g.node("Patient", paramString(b, "patient"))
    if (patient === undefined) return []
    return g.incoming("ExplanationOfBenefit", "patient", patient).map((n): SupportRow => {
      const cents = n.row["payment_amount_cents"]
      return {
        entityType: "ExplanationOfBenefit",
        id: String(n.row["id"]),
        value: typeof cents === "number" ? cents : 0
      }
    })
  }
}

const activeCoverage: CqTemplate = {
  id: "notes/active-coverage",
  regime: "temporal",
  expectedKind: "set",
  resultEntityType: "Coverage",
  params: [{ name: "patient", kind: "entity-id", entityType: "Patient" }],
  text: (b) => `Which Coverage is active for ${paramString(b, "patient")} on ${REFERENCE_DATE}?`,
  sql: (b) =>
    `SELECT "id" FROM "coverage" WHERE "beneficiary_ref" = ${sqlLiteral(paramString(b, "patient"))}` +
    ` AND "status" = 'active'` +
    ` AND ("period_start" IS NULL OR "period_start" <= '${REFERENCE_DATE}')` +
    ` AND ("period_end" IS NULL OR "period_end" >= '${REFERENCE_DATE}') ORDER BY "id"`,
  graph: (g, b) => {
    const patient = g.node("Patient", paramString(b, "patient"))
    if (patient === undefined) return []
    return g
      .incoming("Coverage", "beneficiary", patient)
      .filter((n) => {
        const start = n.row["period_start"]
        const end = n.row["period_end"]
        return (
          n.row["status"] === "active" &&
          (typeof start !== "string" || start <= REFERENCE_DATE) &&
          (typeof end !== "string" || end >= REFERENCE_DATE)
        )
      })
      .map((n) => ({ entityType: "Coverage", id: String(n.row["id"]) }))
  }
}

const templates = [activeConditions, eobPaidTotal, activeCoverage]

// Bindings are built explicitly over EVERY patient (rather than Monte-Carlo
// sampled with bindTemplates as in example 01) so the demo verdict mix is
// guaranteed by construction: 20 patients x 3 questions = 60 gradings.
const bindingsFor = (world: InstanceWorld): CqBinding[] =>
  (world["Patient"] ?? []).flatMap((row) =>
    templates.map((template) => ({
      template,
      params: { patient: String(row["id"]) }
    }))
  )

// ─────────────────────────────────────────────────────────────────────────────
// 2. The toy memory layer: take notes once, then answer from notes only.
// ─────────────────────────────────────────────────────────────────────────────

interface PatientNotes {
  /** Active condition ids as written down (busy charts get truncated). */
  readonly activeConditions: readonly string[]
  /** EOB payment total in cents, correctly summed at note-taking time. */
  readonly eobTotalCents: number
  /** Where the total supposedly came from (sometimes fabricated). */
  readonly eobSources: readonly Citation[]
}

const rowsOf = (world: InstanceWorld, entityType: string): readonly Row[] => world[entityType] ?? []

/**
 * The note-taker. Reads the world once and writes a digest per patient — with
 * three deliberate flaws called out inline. Deterministic: flaws key off world
 * structure (chart size, patient index), not off randomness, so the report is
 * identical on every run.
 */
const takeNotes = (world: InstanceWorld): Map<string, PatientNotes> => {
  const notes = new Map<string, PatientNotes>()
  rowsOf(world, "Patient").forEach((patient, index) => {
    const patientId = String(patient["id"])

    const active = rowsOf(world, "Condition")
      .filter((c) => c["subject_ref"] === patientId && c["clinical_status"] === "active")
      .map((c) => String(c["id"]))
      .sort()
    // FLAW 1 (-> divergent): on busy charts the note-taker stops early — the
    // last active condition never gets written down.
    const written = active.length >= 2 ? active.slice(0, -1) : active

    const eobs = rowsOf(world, "ExplanationOfBenefit").filter((e) => e["patient_ref"] === patientId)
    const total = eobs.reduce((sum, e) => {
      const cents = e["payment_amount_cents"]
      return sum + (typeof cents === "number" ? cents : 0)
    }, 0)
    // FLAW 2 (-> unsupported-citation): every other patient's total gets
    // attributed to an EOB id that does not exist — fabricated provenance, the
    // note-file equivalent of a hallucinated source. The VALUE is still right;
    // only the mechanical citation audit catches it.
    const eobSources: Citation[] =
      eobs.length > 0 && index % 2 === 1
        ? [{ entityType: "ExplanationOfBenefit", id: "explanation_of_benefit-999" }]
        : eobs.map((e) => ({ entityType: "ExplanationOfBenefit", id: String(e["id"]) }))

    // FLAW 3 (-> missing): insurance "lives in another system" — no Coverage
    // notes are ever taken, so active-coverage questions come back empty.

    notes.set(patientId, { activeConditions: written, eobTotalCents: total, eobSources })
  })
  return notes
}

/** Answer from the notes alone. An AnswerPath closes over its own state and
 * returns a plain Promise — a layer brings its own world, its own runtime. */
const makeNotesPath = (notes: Map<string, PatientNotes>): AnswerPath => ({
  name: "notes-file",
  answer: async (binding: CqBinding): Promise<Answer> => {
    const chart = notes.get(paramString(binding, "patient"))
    switch (binding.template.id) {
      case "notes/active-conditions": {
        const ids = chart?.activeConditions ?? []
        return {
          kind: "set",
          value: [...ids],
          citations: ids.map((id) => ({ entityType: "Condition", id }))
        }
      }
      case "notes/eob-paid-total":
        return {
          kind: "scalar",
          value: chart?.eobTotalCents ?? 0,
          citations: [...(chart?.eobSources ?? [])]
        }
      default:
        // No notes on this topic at all — the layer simply has nothing.
        return { kind: "set", value: [], citations: [] }
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Generate, load, grade, read the report.
// ─────────────────────────────────────────────────────────────────────────────

const showReport = (report: CqReport): void => {
  console.log(`memory-sql grading "${report.pathName}" — ${report.total} questions, seed ${SEED}`)
  console.log("")
  console.log("verdicts:")
  console.log(`  match                  ${report.match}`)
  console.log(`  divergent              ${report.divergent}`)
  console.log(`  unsupported-citation   ${report.unsupportedCitation}`)
  console.log(`  missing                ${report.missing}`)
  console.log("")
  console.log(`agreement rate:          ${(report.agreementRate * 100).toFixed(1)}%`)
  console.log(`citation-resolves rate:  ${(report.citationResolvesRate * 100).toFixed(1)}%`)

  // One concrete grading per failure mode — the actionable part of the report.
  for (const wanted of ["divergent", "unsupported-citation", "missing"] as const) {
    const example = report.results.find((r) => r.verdict === wanted)
    if (example === undefined) continue
    console.log("")
    // citations are { entityType, id } objects; print them as EntityType/id so
    // nobody reads them back as bare id strings (bare strings never resolve)
    const cites = (cs: ReadonlyArray<Citation>): string => `[${cs.map((c) => `${c.entityType}/${c.id}`).join(", ")}]`
    console.log(`${wanted}: ${example.question}`)
    console.log(`  oracle: ${JSON.stringify(example.oracle.value)} cites ${cites(example.oracle.citations)}`)
    console.log(
      `  notes:  ${example.path === null ? "(no answer)" : JSON.stringify(example.path.value)}` +
        `${example.path === null ? "" : ` cites ${cites(example.path.citations)}`}`
    )
  }
}

const main = async (): Promise<void> => {
  const ontology = loadFhirOntology()
  const world = generateWorld(ontology, { seed: SEED, patients: 20 })

  const store = await openStore()
  let report: CqReport
  try {
    const notesPath = makeNotesPath(takeNotes(world))
    // runCq loads the world itself ({ ontology } = exact DDL); `templates`
    // makes the per-template rows reflect OUR three questions, not the
    // shipped FHIR suite.
    report = await runCq(store, world, bindingsFor(world), notesPath, { ontology, templates })
  } finally {
    store.close()
  }

  showReport(report)

  // The demo contract: an imperfect layer must be caught in every planted way —
  // all four verdicts: honest matches, divergent, unsupported-citation, missing.
  const caught =
    report.match > 0 && report.divergent > 0 && report.unsupportedCitation > 0 && report.missing > 0
  console.log("")
  console.log(
    caught
      ? "NotesPath graded: faithful notes matched, truncated charts diverged, fabricated provenance was caught, missing coverage notes surfaced as gaps."
      : "unexpected: the planted flaws were not all caught"
  )
  if (!caught) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
