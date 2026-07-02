/**
 * memory-sql — public API surface.
 *
 * Everything a consumer (examples/, tests/, downstream users) may touch is
 * re-exported here; the package `exports` map points at this module only, so
 * this file IS the isolation boundary the SPEC mandates. Types stay co-located
 * with their modules and are aggregated here rather than living in a global
 * types dump.
 *
 * Foundation modules (ontology/store/synth) are re-exported by explicit name
 * so the root surface is deliberate — in particular the DuckDb layer is only
 * exposed under its unambiguous `duckDbLayer` alias, keeping the generic name
 * `layer` free at the package root. The engine modules (oracle/cq/sim) own
 * their surfaces and are re-exported wholesale.
 */

// ── Ontology: generic model + the committed FHIR R4 top-50 derivation ──
export type { Attribute, AttributeType, EntityType, Ontology, Relation } from "./ontology/model.js"
export { entityTypeNames, getEntityType, requireEntityType, validateOntology } from "./ontology/model.js"
export { FHIR_TOP50_COUNT, FHIR_TOP50_URL, FhirLoadError, loadFhirOntology } from "./ontology/fhir.js"

// ── Store: Ontology -> DDL, the DuckDb service, world loading ──
export type { ColumnDef } from "./store/schema.js"
export {
  columnName,
  createTable,
  ddl,
  quoteIdent,
  relationRefColumn,
  relationRefTypeColumn,
  sqlType,
  tableColumns,
  tableName
} from "./store/schema.js"
export type { DuckDbOptions, DuckDbService, QueryResult, SqlValue } from "./store/db.js"
export { DbError, DuckDb, duckDbLayer } from "./store/db.js"
export type { InstanceWorld, Row } from "./store/load.js"
export { loadWorld, sqlLiteral } from "./store/load.js"

// ── Synth: seeded PRNG + deterministic clean-world generator ──
export type { Rng } from "./synth/rng.js"
export { makeRng } from "./synth/rng.js"
export type { GenerateOptions } from "./synth/generate.js"
export { generateWorld, REFERENCE_DATE } from "./synth/generate.js"

// ── Oracle: CQ binding -> SQL -> canonical Answer (the ground truth) ──
export * from "./oracle/sql.js"

// ── Stage 1: CQ dual-oracle (model, engine, reference GraphPath, templates) ──
export * from "./cq/model.js"
export * from "./cq/engine.js"
export * from "./cq/graph-path.js"
export * from "./cq/templates.js"

// ── Stage 2: simulation (metamorphic relations, adversarial stress) ──
export * from "./sim/metamorphic.js"
export * from "./sim/stress.js"
