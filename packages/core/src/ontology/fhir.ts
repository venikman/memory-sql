/**
 * FHIR R4 (4.0.1) -> Ontology. The parse boundary of the package: reads the
 * committed, pre-trimmed StructureDefinition data (fhir-data/top50.json,
 * produced once by scripts/fetch-fhir.ts — see the flattening rules documented
 * there and in ontology/model.ts) and validates it with effect/Schema before
 * anything downstream trusts it. Build and CI stay offline; the fetch script
 * exists so the committed data is reproducible from the official spec.
 */
import { Data, Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import type { Ontology } from "./model.js"
import { validateOntology } from "./model.js"

export class FhirLoadError extends Data.TaggedError("FhirLoadError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Location of the committed trimmed spec. Resolved relative to this module so
 * it works both from src (tsx) and from dist (built): both live one directory
 * level under packages/core, next to fhir-data/.
 */
export const FHIR_TOP50_URL: URL = new URL("../../fhir-data/top50.json", import.meta.url)

const AttributeSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal("string", "code", "boolean", "integer", "decimal", "date", "datetime"),
  required: Schema.Boolean,
  valueSet: Schema.optionalWith(Schema.Array(Schema.String), { exact: true })
})

const RelationSchema = Schema.Struct({
  name: Schema.String,
  target: Schema.Array(Schema.String),
  required: Schema.Boolean
})

const ResourceSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("resource"),
  attributes: Schema.Array(AttributeSchema),
  relations: Schema.Array(RelationSchema)
})

const Top50FileSchema = Schema.Struct({
  meta: Schema.Struct({
    source: Schema.String,
    fhirVersion: Schema.String,
    generatedBy: Schema.String,
    pruning: Schema.Array(Schema.String)
  }),
  resources: Schema.Array(ResourceSchema)
})

/** Number of resources the committed top-50 data must contain. */
export const FHIR_TOP50_COUNT = 50

/**
 * Load the FHIR-derived ontology from the committed trimmed spec data.
 * Fails with FhirLoadError when the file is missing, malformed, or fails the
 * structural validation every downstream engine relies on (unique types,
 * resolvable relation targets, legal column names).
 */
export const loadFhirOntology = (): Effect.Effect<Ontology, FhirLoadError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => fs.readFile(FHIR_TOP50_URL, "utf8"),
      catch: (cause) =>
        new FhirLoadError({ message: `cannot read ${FHIR_TOP50_URL.pathname}`, cause })
    })
    const raw = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => new FhirLoadError({ message: "top50.json is not valid JSON", cause })
    })
    const decoded = yield* Schema.decodeUnknown(Top50FileSchema)(raw).pipe(
      Effect.mapError(
        (cause) => new FhirLoadError({ message: `top50.json failed schema validation: ${cause.message}`, cause })
      )
    )
    if (decoded.resources.length !== FHIR_TOP50_COUNT) {
      return yield* new FhirLoadError({
        message: `expected ${FHIR_TOP50_COUNT} resources in top50.json, found ${decoded.resources.length}`
      })
    }
    const ontology: Ontology = {
      entityTypes: decoded.resources.map((r) => ({
        name: r.name,
        attributes: r.attributes,
        relations: r.relations
      }))
    }
    const problems = validateOntology(ontology)
    if (problems.length > 0) {
      return yield* new FhirLoadError({
        message: `ontology validation failed:\n  ${problems.join("\n  ")}`
      })
    }
    return ontology
  })
