/**
 * fetch-fhir — one-time, reproducible derivation of the committed FHIR ontology data.
 *
 * Downloads the official FHIR R4 (4.0.1) definitions from hl7.org:
 *   - profiles-resources.json  (StructureDefinitions for every resource)
 *   - valuesets.json           (ValueSet + CodeSystem definitions, used to expand
 *                               required bindings into enumerable value sets)
 * extracts the 50 payer-weighted resources listed in SPEC.md, trims each
 * StructureDefinition down to exactly what the ontology needs, and writes
 * packages/core/fhir-data/top50.json (committed — build and CI stay offline).
 *
 * The output is deliberately deterministic (no timestamps): re-running the script
 * against the same spec release produces a byte-identical file.
 *
 * ── Trimming / flattening rules (mirrored in packages/core/src/ontology.ts) ──
 * 1. Only depth-1 elements (Resource.field) are considered, plus an explicit
 *    whitelist of backbone leaves that carry payer-critical joins/amounts
 *    (e.g. Claim.insurance.coverage, ExplanationOfBenefit.payment.amount).
 * 2. Infrastructure fields are dropped: id, meta, implicitRules, language, text,
 *    contained, extension, modifierExtension; likewise elements with max = 0.
 * 3. Primitive type map: string/markdown/id/uri/url/canonical/oid/uuid/
 *    base64Binary/xhtml/time -> 'string'; code -> 'code'; boolean -> 'boolean';
 *    integer/positiveInt/unsignedInt -> 'integer'; decimal -> 'decimal';
 *    date -> 'date'; dateTime/instant -> 'datetime'.
 * 4. Complex types flatten to a small documented column set:
 *    CodeableConcept/Coding -> <f>            ('code'; primary code only)
 *    Period                 -> <f>_start, <f>_end        (datetime)
 *    Money                  -> <f>_cents ('integer'), <f>_currency ('string')
 *    Quantity family        -> <f>_value ('decimal'), <f>_unit ('string')
 *    Identifier             -> <f>_value ('string'; first repetition, system dropped)
 *    HumanName              -> <f>_family, <f>_given     ('string')
 *    Address                -> <f>_city, <f>_state       ('string')
 *    Reference(X|Y)         -> relation { name, target: [X, Y] }
 *    Everything else (Attachment, Annotation, ContactPoint, Dosage, Timing,
 *    Ratio, Range, SampledData, Signature, BackboneElement outside the
 *    whitelist, ...) is pruned.
 * 5. Choice elements (field[x]) resolve to ONE deterministic variant:
 *    (a) if a Reference(Medication) variant exists, take the Reference (the
 *        MedicationRequest->Medication join edge beats an inline code);
 *    (b) the element named value[x] prefers Quantity (it is the measurement);
 *    (c) otherwise first match in the preference order
 *        dateTime, date, boolean, Quantity, Age, Duration, Money, Period,
 *        string, code, CodeableConcept, Coding, integer, positiveInt,
 *        unsignedInt, decimal, instant, time, Reference.
 * 6. Repeating elements (max = *) are represented by their first repetition.
 * 7. required = (min >= 1). For a required Period only <f>_start is required;
 *    for a required Money only <f>_cents; for Quantity only <f>_value.
 * 8. Bindings: only strength 'required' bindings on code/Coding/CodeableConcept
 *    elements are expanded (via ValueSet.compose -> CodeSystem concepts).
 *    Expansions with more than 25 codes, or that need filters / nested value
 *    sets / absent code systems, are treated as non-enumerable and omitted.
 * 9. Reference targets are intersected with the top-50 set; Reference(Any) is
 *    collapsed to the documented default target list Patient|Encounter|Observation;
 *    relations whose intersected target list is empty are pruned.
 * 10. Attribute budget: every resource keeps all required attributes, then
 *     optional ones in element order up to 18 total. Relations are never capped.
 * 11. All emitted names are lower_snake_case of the FHIR camelCase names;
 *     backbone-whitelist leaves are named <backbone>_<leaf>.
 *
 * Usage: npm run fetch-fhir            (network required)
 *        FHIR_CACHE_DIR=/tmp/fhir npm run fetch-fhir   (cache downloads there)
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PROFILES_URL = "https://hl7.org/fhir/R4/profiles-resources.json"
const VALUESETS_URL = "https://hl7.org/fhir/R4/valuesets.json"
const OUT_PATH = new URL("../packages/core/fhir-data/top50.json", import.meta.url)

/** The fixed, payer-weighted top-50 FHIR R4 resource list (SPEC.md). */
const TOP50: readonly string[] = [
  "Patient", "Practitioner", "PractitionerRole", "Organization", "Location",
  "Encounter", "Observation", "Condition", "Procedure", "MedicationRequest",
  "Medication", "MedicationDispense", "MedicationStatement", "Immunization",
  "AllergyIntolerance", "DiagnosticReport", "DocumentReference", "ServiceRequest",
  "CarePlan", "CareTeam", "Goal", "Device", "Specimen", "ImagingStudy",
  "Appointment", "Schedule", "Slot", "Coverage", "Claim", "ClaimResponse",
  "ExplanationOfBenefit", "CoverageEligibilityRequest", "CoverageEligibilityResponse",
  "PaymentNotice", "PaymentReconciliation", "Account", "ChargeItem", "Invoice",
  "Person", "RelatedPerson", "Group", "HealthcareService", "Endpoint",
  "Communication", "CommunicationRequest", "Task", "Questionnaire",
  "QuestionnaireResponse", "Provenance", "AuditEvent"
]

const SKIP_FIELDS = new Set([
  "id", "meta", "implicitRules", "language", "text", "contained",
  "extension", "modifierExtension"
])

const PRIMITIVE_MAP: Record<string, AttributeType> = {
  "string": "string", "markdown": "string", "id": "string", "uri": "string",
  "url": "string", "canonical": "string", "oid": "string", "uuid": "string",
  "base64Binary": "string", "xhtml": "string", "time": "string",
  "http://hl7.org/fhirpath/System.String": "string",
  "code": "code",
  "boolean": "boolean",
  "integer": "integer", "positiveInt": "integer", "unsignedInt": "integer",
  "decimal": "decimal",
  "date": "date",
  "dateTime": "datetime", "instant": "datetime"
}

const QUANTITY_TYPES = new Set(["Quantity", "SimpleQuantity", "Age", "Duration", "Count", "Distance", "MoneyQuantity"])

const CHOICE_PREFERENCE: readonly string[] = [
  "dateTime", "date", "boolean", "Quantity", "Age", "Duration", "Money",
  "Period", "string", "code", "CodeableConcept", "Coding", "integer",
  "positiveInt", "unsignedInt", "decimal", "instant", "time", "Reference"
]

/** Reference(Any) collapses to this documented default target list (rule 9). */
const ANY_REFERENCE_TARGETS: readonly string[] = ["Patient", "Encounter", "Observation"]

const MAX_ATTRIBUTES = 18
const MAX_VALUESET = 25

/**
 * Backbone leaves we deliberately keep (rule 1): the coverage joins that make
 * the patient -> claim -> coverage chain queryable and the payment amounts
 * needed for aggregate CQs. `kind` selects the flattening applied to the leaf.
 */
const BACKBONE_WHITELIST: ReadonlyArray<{
  readonly path: string
  readonly kind: "reference" | "money"
  readonly name: string
}> = [
  { path: "Claim.insurance.coverage", kind: "reference", name: "insurance_coverage" },
  { path: "ExplanationOfBenefit.insurance.coverage", kind: "reference", name: "insurance_coverage" },
  { path: "ExplanationOfBenefit.payment.amount", kind: "money", name: "payment_amount" },
  { path: "ClaimResponse.payment.amount", kind: "money", name: "payment_amount" },
  { path: "Appointment.participant.actor", kind: "reference", name: "participant_actor" },
  { path: "Provenance.agent.who", kind: "reference", name: "agent_who" }
]

// ─────────────────────────────────────────────────────────────────────────────
// Minimal raw-FHIR shapes (only the slices this script touches)
// ─────────────────────────────────────────────────────────────────────────────

type AttributeType = "string" | "code" | "boolean" | "integer" | "decimal" | "date" | "datetime"

interface TrimmedAttribute {
  readonly name: string
  readonly type: AttributeType
  readonly required: boolean
  readonly valueSet?: readonly string[]
}
interface TrimmedRelation {
  readonly name: string
  readonly target: readonly string[]
  readonly required: boolean
}
interface TrimmedResource {
  readonly name: string
  readonly kind: "resource"
  readonly attributes: readonly TrimmedAttribute[]
  readonly relations: readonly TrimmedRelation[]
}

interface ElementType { readonly code: string; readonly targetProfile?: readonly string[] }
interface ElementDef {
  readonly path: string
  readonly min?: number
  readonly max?: string
  readonly type?: readonly ElementType[]
  readonly binding?: { readonly strength?: string; readonly valueSet?: string }
}
interface StructureDefinition {
  readonly resourceType: string
  readonly name: string
  readonly kind?: string
  readonly abstract?: boolean
  readonly fhirVersion?: string
  readonly snapshot?: { readonly element?: readonly ElementDef[] }
}
interface Bundle { readonly entry?: ReadonlyArray<{ readonly resource?: Record<string, unknown> }> }
interface VsInclude {
  readonly system?: string
  readonly concept?: ReadonlyArray<{ readonly code: string }>
  readonly filter?: readonly unknown[]
  readonly valueSet?: readonly string[]
}
interface ValueSetRes {
  readonly url: string
  readonly compose?: { readonly include?: readonly VsInclude[]; readonly exclude?: readonly VsInclude[] }
}
interface CsConcept { readonly code: string; readonly concept?: readonly CsConcept[] }
interface CodeSystemRes { readonly url: string; readonly concept?: readonly CsConcept[] }

// ─────────────────────────────────────────────────────────────────────────────
// Pure trimming logic
// ─────────────────────────────────────────────────────────────────────────────

const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()

const lastSegment = (url: string): string => {
  const parts = url.split("/")
  return parts[parts.length - 1] ?? url
}

/** Index ValueSet + CodeSystem resources from the valuesets bundle by canonical url. */
const indexValueSets = (bundle: Bundle): { valueSets: Map<string, ValueSetRes>; codeSystems: Map<string, CodeSystemRes> } => {
  const valueSets = new Map<string, ValueSetRes>()
  const codeSystems = new Map<string, CodeSystemRes>()
  for (const entry of bundle.entry ?? []) {
    const res = entry.resource
    if (res === undefined) continue
    if (res["resourceType"] === "ValueSet") {
      const vs = res as unknown as ValueSetRes
      valueSets.set(vs.url, vs)
    } else if (res["resourceType"] === "CodeSystem") {
      const cs = res as unknown as CodeSystemRes
      codeSystems.set(cs.url, cs)
    }
  }
  return { valueSets, codeSystems }
}

const flattenConcepts = (concepts: readonly CsConcept[], into: string[]): void => {
  for (const c of concepts) {
    into.push(c.code)
    if (c.concept !== undefined) flattenConcepts(c.concept, into)
  }
}

/**
 * Expand a required-binding value set into an explicit code list (rule 8).
 * Returns undefined when the set is not cleanly enumerable — the ontology then
 * treats the attribute as an open code.
 */
const expandValueSet = (
  vsUrlVersioned: string,
  valueSets: Map<string, ValueSetRes>,
  codeSystems: Map<string, CodeSystemRes>
): readonly string[] | undefined => {
  const url = vsUrlVersioned.split("|")[0] ?? vsUrlVersioned
  const vs = valueSets.get(url)
  const includes = vs?.compose?.include
  if (vs === undefined || includes === undefined || (vs.compose?.exclude?.length ?? 0) > 0) return undefined
  const codes: string[] = []
  for (const inc of includes) {
    if (inc.filter !== undefined || inc.valueSet !== undefined) return undefined
    if (inc.concept !== undefined) {
      for (const c of inc.concept) codes.push(c.code)
    } else if (inc.system !== undefined) {
      const cs = codeSystems.get(inc.system)
      if (cs?.concept === undefined) return undefined
      flattenConcepts(cs.concept, codes)
    } else {
      return undefined
    }
  }
  const unique = [...new Set(codes)]
  return unique.length > 0 && unique.length <= MAX_VALUESET ? unique : undefined
}

/** Resolve a choice element (field[x]) to a single variant — rules 5(a)-(c). */
const resolveChoice = (field: string, types: readonly ElementType[]): ElementType | undefined => {
  const medRef = types.find((t) =>
    t.code === "Reference" && (t.targetProfile ?? []).some((p) => lastSegment(p) === "Medication")
  )
  if (medRef !== undefined) return medRef
  if (field === "value") {
    const quantity = types.find((t) => QUANTITY_TYPES.has(t.code))
    if (quantity !== undefined) return quantity
  }
  for (const pref of CHOICE_PREFERENCE) {
    const hit = types.find((t) => t.code === pref)
    if (hit !== undefined) return hit
  }
  return undefined
}

interface FlattenAcc {
  attributes: TrimmedAttribute[]
  relations: TrimmedRelation[]
}

/** Apply the type-directed flattening of rules 3-4 to one (already chosen) element variant. */
const emitElement = (
  acc: FlattenAcc,
  base: string,
  typeCode: string,
  targetProfiles: readonly string[] | undefined,
  required: boolean,
  valueSet: readonly string[] | undefined
): void => {
  const attr = (name: string, type: AttributeType, req: boolean, vs?: readonly string[]): void => {
    acc.attributes.push(vs !== undefined ? { name, type, required: req, valueSet: vs } : { name, type, required: req })
  }
  if (typeCode === "Reference") {
    const raw = (targetProfiles ?? []).map(lastSegment)
    const collapsed = raw.length === 0 || raw.includes("Resource") ? ANY_REFERENCE_TARGETS : raw
    const target = [...new Set(collapsed)].filter((t) => TOP50.includes(t))
    if (target.length > 0) acc.relations.push({ name: base, target, required })
    return
  }
  if (typeCode === "CodeableConcept" || typeCode === "Coding") {
    attr(base, "code", required, valueSet)
    return
  }
  if (typeCode === "Period") {
    attr(`${base}_start`, "datetime", required)
    attr(`${base}_end`, "datetime", false)
    return
  }
  if (typeCode === "Money") {
    attr(`${base}_cents`, "integer", required)
    attr(`${base}_currency`, "string", false)
    return
  }
  if (QUANTITY_TYPES.has(typeCode)) {
    attr(`${base}_value`, "decimal", required)
    attr(`${base}_unit`, "string", false)
    return
  }
  if (typeCode === "Identifier") {
    attr(`${base}_value`, "string", required)
    return
  }
  if (typeCode === "HumanName") {
    attr(`${base}_family`, "string", false)
    attr(`${base}_given`, "string", false)
    return
  }
  if (typeCode === "Address") {
    attr(`${base}_city`, "string", false)
    attr(`${base}_state`, "string", false)
    return
  }
  const primitive = PRIMITIVE_MAP[typeCode]
  if (primitive !== undefined) {
    attr(base, primitive, required, primitive === "code" ? valueSet : undefined)
  }
  // anything else: pruned (rule 4)
}

const trimResource = (
  sd: StructureDefinition,
  valueSets: Map<string, ValueSetRes>,
  codeSystems: Map<string, CodeSystemRes>
): TrimmedResource => {
  const elements = sd.snapshot?.element ?? []
  const byPath = new Map(elements.map((el) => [el.path, el]))
  const acc: FlattenAcc = { attributes: [], relations: [] }

  const bindingFor = (el: ElementDef): readonly string[] | undefined =>
    el.binding?.strength === "required" && el.binding.valueSet !== undefined
      ? expandValueSet(el.binding.valueSet, valueSets, codeSystems)
      : undefined

  for (const el of elements) {
    if (!el.path.startsWith(`${sd.name}.`)) continue
    const rel = el.path.slice(sd.name.length + 1)
    if (rel.split(".").length !== 1) continue // deep paths only via the whitelist below
    if (el.max === "0") continue
    const isChoice = rel.endsWith("[x]")
    const field = isChoice ? rel.slice(0, -3) : rel
    if (SKIP_FIELDS.has(field)) continue
    const types = el.type ?? []
    if (types.length === 0) continue // contentReference elements carry no type
    const chosen = isChoice ? resolveChoice(field, types) : types[0]
    if (chosen === undefined) continue
    emitElement(acc, snake(field), chosen.code, chosen.targetProfile, (el.min ?? 0) >= 1, bindingFor(el))
  }

  // Whitelisted backbone leaves (rule 1). Required only when the whole chain is
  // required. Emitted into a separate accumulator so the attribute cap below
  // can never evict them — they exist precisely because CQs need them.
  const wlAcc: FlattenAcc = { attributes: [], relations: [] }
  for (const wl of BACKBONE_WHITELIST) {
    if (!wl.path.startsWith(`${sd.name}.`)) continue
    const leaf = byPath.get(wl.path)
    if (leaf === undefined) continue
    const backbonePath = wl.path.split(".").slice(0, 2).join(".")
    const backbone = byPath.get(backbonePath)
    const required = ((backbone?.min ?? 0) >= 1) && ((leaf.min ?? 0) >= 1)
    if (wl.kind === "reference") {
      emitElement(wlAcc, wl.name, "Reference", leaf.type?.[0]?.targetProfile, required, undefined)
    } else {
      emitElement(wlAcc, wl.name, "Money", undefined, required, undefined)
    }
  }

  // Attribute budget (rule 10): required always survive, optional in element order.
  const budget = MAX_ATTRIBUTES - wlAcc.attributes.length
  let attributes = acc.attributes
  if (attributes.length > budget) {
    const kept = new Set<TrimmedAttribute>(attributes.filter((a) => a.required))
    for (const a of attributes) {
      if (kept.size >= budget) break
      kept.add(a)
    }
    // restore original element order
    attributes = acc.attributes.filter((a) => kept.has(a))
  }
  return {
    name: sd.name,
    kind: "resource",
    attributes: [...attributes, ...wlAcc.attributes],
    relations: [...acc.relations, ...wlAcc.relations]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain async shell (SPEC v2: scripts must not import effect)
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch a JSON document, optionally caching it on disk under FHIR_CACHE_DIR. */
const loadJson = async (url: string, cacheDir: string | undefined, cacheName: string): Promise<unknown> => {
  if (cacheDir !== undefined) {
    try {
      const cached = await fs.readFile(path.join(cacheDir, cacheName), "utf8")
      return JSON.parse(cached) as unknown
    } catch {
      // cache miss — fall through to the network
    }
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`)
  const body = await res.text()
  if (cacheDir !== undefined) {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(path.join(cacheDir, cacheName), body, "utf8")
  }
  return JSON.parse(body) as unknown
}

const main = async (): Promise<void> => {
  const cacheDir = process.env["FHIR_CACHE_DIR"]
  console.log(`fetching FHIR R4 definitions (source: ${PROFILES_URL})`)
  const profiles = (await loadJson(PROFILES_URL, cacheDir, "profiles-resources.json")) as Bundle
  const valuesetsBundle = (await loadJson(VALUESETS_URL, cacheDir, "valuesets.json")) as Bundle

  const sds = new Map<string, StructureDefinition>()
  for (const entry of profiles.entry ?? []) {
    const res = entry.resource
    if (res !== undefined && res["resourceType"] === "StructureDefinition") {
      const sd = res as unknown as StructureDefinition
      if (sd.kind === "resource" && sd.abstract !== true) sds.set(sd.name, sd)
    }
  }
  const missing = TOP50.filter((n) => !sds.has(n))
  if (missing.length > 0) {
    throw new Error(`StructureDefinitions missing from bundle: ${missing.join(", ")}`)
  }

  const { valueSets, codeSystems } = indexValueSets(valuesetsBundle)
  const resources = TOP50.map((name) => trimResource(sds.get(name)!, valueSets, codeSystems))

  const out = {
    meta: {
      source: `${PROFILES_URL} + ${VALUESETS_URL}`,
      fhirVersion: sds.get("Patient")?.fhirVersion ?? "4.0.1",
      generatedBy: "scripts/fetch-fhir.ts",
      pruning: [
        "depth-1 elements only, plus whitelisted backbone leaves (Claim/EOB insurance.coverage, EOB/ClaimResponse payment.amount, Appointment.participant.actor, Provenance.agent.who)",
        "infra fields dropped (id, meta, implicitRules, language, text, contained, extension, modifierExtension); max=0 dropped",
        "CodeableConcept/Coding->code; Period->_start/_end; Money->_cents/_currency; Quantity->_value/_unit; Identifier->_value; HumanName->_family/_given; Address->_city/_state; other complex types pruned",
        "choice [x]: Reference(Medication) wins; value[x] prefers Quantity; else fixed preference order (see scripts/fetch-fhir.ts)",
        "repeating elements = first repetition; required = min>=1",
        "required bindings expanded to <=25 codes via ValueSet.compose + CodeSystem, else omitted",
        "Reference targets intersected with top-50; Reference(Any) -> Patient|Encounter|Observation; empty target lists pruned",
        "max 18 attributes per resource (required kept first); names lower_snake_case"
      ]
    },
    resources
  }
  const json = JSON.stringify(out, null, 1)
  await fs.writeFile(OUT_PATH, json, "utf8")

  const attrTotal = resources.reduce((n, r) => n + r.attributes.length, 0)
  const relTotal = resources.reduce((n, r) => n + r.relations.length, 0)
  console.log(
    `wrote ${OUT_PATH.pathname}: ${resources.length} resources, ` +
    `${attrTotal} attributes, ${relTotal} relations, ${(json.length / 1024).toFixed(1)} KiB`
  )
}

main().catch((err: unknown) => {
  console.error(`fetch-fhir failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
