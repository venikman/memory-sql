/**
 * Example 04 — the Effect adapter: `memory-sql/effect`.
 *
 * The plain core never imports Effect (enforced by tests/src/isolation.test.js);
 * Effect users get everything through this one subpath instead:
 *
 *   - `MemorySql`, a Context.Tag service over one open store, provided by the
 *     scoped `layer()` — the store is opened on layer construction and closed
 *     when the program's scope closes (Effect.acquireRelease underneath);
 *   - typed failures: every plain-core error surfaces as the tagged
 *     `MemorySqlError` carrying `{ op, cause }`, so `catchTag` works — shown
 *     below by loading a type-poisoned world and recovering;
 *   - `answerPath`, adapting an Effect-based answerer to the plain
 *     `AnswerPath` the engines grade.
 *
 * This is the ONLY example allowed to import `effect` (isolation gate).
 * Pure data types and helpers still come from the plain "memory-sql" surface.
 */
import { Effect } from "effect"
import { bindTemplates, fhirCqTemplates, makeGraphPath, makeRng } from "memory-sql"
import { generateWorld, layer, loadFhirOntology, MemorySql } from "memory-sql/effect"

const SEED = 42
const PATIENTS = 10
const SUITE_SIZE = 26 // two bindings per shipped template

// A world that LOOKS plausible but carries the wrong JS type: birth_date must
// be an ISO string (TEXT column), not a number. The load boundary rejects it
// with a pointed error instead of letting DuckDB cast silently — here it
// arrives on Effect's typed error channel as the tagged MemorySqlError.
const poisonedWorld = {
  Patient: [{ id: "patient-poisoned", birth_date: 19700101 }]
}

const program = Effect.gen(function* () {
  // Wrapped sync API: failures land on the error channel, not as defects.
  const ontology = yield* loadFhirOntology()
  const world = yield* generateWorld(ontology, { seed: SEED, patients: PATIENTS })

  // The service owns the store; no manual open/close anywhere in user code.
  const sql = yield* MemorySql

  // Stage 1 through the adapter: grade the reference GraphPath as usual
  // (runCq loads the world into the store; { ontology } = exact DDL).
  const bindings = bindTemplates(fhirCqTemplates, world, makeRng(SEED), SUITE_SIZE)
  const report = yield* sql.runCq(world, bindings, makeGraphPath(world, ontology), { ontology })
  console.log(
    `memory-sql/effect: path "${report.pathName}" — ${report.match}/${report.total} match, ` +
      `agreement ${(report.agreementRate * 100).toFixed(1)}%`
  )

  // The typed failure channel: a poisoned world is rejected by the plain core
  // (op-tagged Error) and surfaces here as a catchable tagged error.
  const outcome = yield* sql.loadWorld(ontology, poisonedWorld).pipe(
    Effect.as("loaded — UNEXPECTED: the type-poisoned world must be rejected"),
    Effect.catchTag("MemorySqlError", (error) =>
      Effect.succeed(`rejected as tagged MemorySqlError (op "${error.op}"): ${error.message}`)
    )
  )
  console.log(`poisoned world: ${outcome}`)

  const passed = report.match === report.total && outcome.startsWith("rejected")
  console.log(
    passed
      ? "effect adapter: PASS — scoped store, wrapped API, typed tagged failures."
      : "effect adapter: FAIL — see above."
  )
  if (!passed) process.exitCode = 1
})

program.pipe(
  Effect.provide(layer()),
  Effect.runPromise
).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
