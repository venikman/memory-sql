/**
 * memory-sql — the flat public API (SPEC v2). The package `exports` map points
 * "." here, so this module IS the plain-core boundary: consumers import
 * `memory-sql` by name, never deep paths. The Effect adapter lives behind the
 * separate `memory-sql/effect` subpath (effect.js) and is deliberately NOT
 * re-exported — the main entry stays fully functional with `effect` absent.
 */
export * from "./ontology.js"
export * from "./rng.js"
export * from "./store.js"
export * from "./synth.js"
export * from "./oracle.js"
export * from "./cq.js"
export * from "./sim.js"
