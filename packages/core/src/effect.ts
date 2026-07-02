/**
 * memory-sql/effect — the Effect adapter, and THE ONLY module in the package
 * that imports `effect` (enforced by tests/src/isolation.test.ts). It wraps
 * the plain public API for Effect users:
 *
 *   - `MemorySqlError`: a `Data.TaggedError` carrying `{ op, cause }` — every
 *     plain-core failure (an op-tagged Error) surfaces on the typed error
 *     channel instead of as a defect;
 *   - `MemorySql`: a `Context.Tag` service over one open Store, provided by
 *     the scoped `layer(opts)` (store lifecycle via `Effect.acquireRelease`);
 *   - `Effect.tryPromise` wrappers for the async API (openStore/loadWorld,
 *     runCq, runMetamorphic/runStress) and `Effect.try` wrappers for the sync
 *     API (loadFhirOntology, generateWorld), signature-inferred from the core
 *     so the two surfaces cannot drift.
 *
 * `effect` is an optional peer dependency: importing "memory-sql" alone never
 * loads this file, and the plain core never imports Effect.
 */
import { Context, Data, Effect, Layer, Scope } from "effect"
import * as core from "./index.js"

export class MemorySqlError extends Data.TaggedError("MemorySqlError")<{
  readonly op: string
  readonly cause: unknown
}> {
  get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

/** Wrap an unknown failure; a plain-core MemorySqlError keeps its own op tag. */
const toError =
  (fallbackOp: string) =>
  (cause: unknown): MemorySqlError =>
    new MemorySqlError({ op: cause instanceof core.MemorySqlError ? cause.op : fallbackOp, cause })

/** Lift a sync core function into Effect (failures -> tagged MemorySqlError). */
const liftSync =
  <Args extends readonly unknown[], A>(op: string, f: (...args: Args) => A) =>
  (...args: Args): Effect.Effect<A, MemorySqlError> =>
    Effect.try({ try: () => f(...args), catch: toError(op) })

/** Lift an async core function into Effect (failures -> tagged MemorySqlError). */
const liftAsync =
  <Args extends readonly unknown[], A>(op: string, f: (...args: Args) => Promise<A>) =>
  (...args: Args): Effect.Effect<A, MemorySqlError> =>
    Effect.tryPromise({ try: () => f(...args), catch: toError(op) })

// ─────────────────────────────────────────────────────────────────────────────
// Plain-API wrappers (signatures inferred from the core)
// ─────────────────────────────────────────────────────────────────────────────

export const loadFhirOntology = liftSync("fhir", core.loadFhirOntology)
export const generateWorld = liftSync("synth", core.generateWorld)
export const loadWorld = liftAsync("loadWorld", core.loadWorld)
export const runCq = liftAsync("cq", core.runCq)
export const runMetamorphic = liftAsync("sim", core.runMetamorphic)
export const runStress = liftAsync("sim", core.runStress)

type StoreOptions = Parameters<typeof core.openStore>[0]
type SimOptions = Parameters<typeof core.runMetamorphic>[2]
type SimReport = Awaited<ReturnType<typeof core.runMetamorphic>>

/** Open a Store as a scoped resource: closing is guaranteed on scope exit. */
export const openStore = (opts?: StoreOptions): Effect.Effect<core.Store, MemorySqlError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => core.openStore(opts), catch: toError("store") }),
    (store) => Effect.sync(() => store.close())
  )

// ─────────────────────────────────────────────────────────────────────────────
// The MemorySql service: one open store + the store-bound API over it
// ─────────────────────────────────────────────────────────────────────────────

export interface MemorySqlService {
  /** The underlying plain Store (escape hatch for direct SQL beyond run/query). */
  readonly store: core.Store
  readonly run: (sql: string) => Effect.Effect<void, MemorySqlError>
  readonly query: (sql: string) => Effect.Effect<core.QueryResult, MemorySqlError>
  readonly loadWorld: (
    ontology: core.Ontology,
    world: core.InstanceWorld
  ) => Effect.Effect<void, MemorySqlError>
  readonly runCq: (
    world: core.InstanceWorld,
    bindings: ReadonlyArray<core.CqBinding>,
    path: core.AnswerPath,
    opts?: core.RunCqOptions
  ) => Effect.Effect<core.CqReport, MemorySqlError>
  readonly runMetamorphic: (
    world: core.InstanceWorld,
    opts: SimOptions
  ) => Effect.Effect<SimReport, MemorySqlError>
}

export class MemorySql extends Context.Tag("memory-sql/MemorySql")<MemorySql, MemorySqlService>() {}

const makeService = (store: core.Store): MemorySqlService => ({
  store,
  run: (sql) => Effect.tryPromise({ try: () => store.run(sql), catch: toError("db") }),
  query: (sql) => Effect.tryPromise({ try: () => store.query(sql), catch: toError("db") }),
  loadWorld: (ontology, world) =>
    Effect.tryPromise({ try: () => core.loadWorld(store, ontology, world), catch: toError("loadWorld") }),
  runCq: (world, bindings, path, opts) =>
    Effect.tryPromise({ try: () => core.runCq(store, world, bindings, path, opts), catch: toError("cq") }),
  runMetamorphic: (world, opts) =>
    Effect.tryPromise({ try: () => core.runMetamorphic(store, world, opts), catch: toError("sim") })
})

/**
 * Scoped MemorySql layer. Default is a fresh in-memory database; pass
 * `{ path }` to persist. The store is opened on layer construction and closed
 * when the layer's scope closes — every program run is hermetic.
 */
export const layer = (opts?: StoreOptions): Layer.Layer<MemorySql, MemorySqlError> =>
  Layer.scoped(MemorySql, Effect.map(openStore(opts), makeService))

/**
 * Adapt an Effect-based answerer to the plain `AnswerPath` the engines grade.
 * The effect must be self-contained (no requirements); failures reject the
 * promise and are graded `missing` by the suite, exactly like a thrown plain
 * path.
 */
export const answerPath = (
  name: string,
  answer: (binding: core.CqBinding) => Effect.Effect<core.Answer, unknown>
): core.AnswerPath => ({
  name,
  answer: (binding) => Effect.runPromise(answer(binding))
})
