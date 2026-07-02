/**
 * Example 02 — Stage 2: validation by simulation, no gold labels anywhere.
 *
 * Two engines, two complementary questions:
 *
 * (a) METAMORPHIC — "does the answer layer behave like the ontology says it
 *     must?" A metamorphic relation states how an answer must (or must not)
 *     change under a known transformation — add unrelated patients, narrow a
 *     period, flip a traversal direction, swap evaluators. No expected values
 *     are ever written down; fast-check drives seeded cases over sampled
 *     bindings and hands back a SHRUNK counterexample on violation. Here the
 *     layer under test is the reference GraphPath, so all relations must hold.
 *
 * (b) ADVERSARIAL STRESS — "would our invariants notice if the data went bad?"
 *     Each mutator plants one named defect in a copy of the clean world
 *     (dangling reference, dropped required attribute, illegal code, reversed
 *     period, orphan EOB, duplicate id, future-dated birth, self-reference);
 *     the SQL invariants are replayed over each mutated world. The printed
 *     mutator x invariant matrix is the contract: the CLEAN world is silent,
 *     and every planted defect is caught — the closed-world analogue of
 *     reasoner consistency checking.
 *
 * Deterministic end to end (seeded PRNG, seeded fast-check); exit 1 on any
 * violation, mirroring `memory-sql sim`.
 *
 * Isolation: imports ONLY the published "memory-sql" surface (by package name).
 */
import { Effect } from "effect"
import {
  bindTemplates,
  duckDbLayer,
  fhirCqTemplates,
  formatMetamorphicReport,
  formatStressReport,
  generateWorld,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  runMetamorphic,
  runStress,
  SqlOracle
} from "memory-sql"

const SEED = 7
const PATIENTS = 20
const BINDINGS = 40
const RUNS_PER_RELATION = 100

const program = Effect.gen(function* () {
  const ontology = yield* loadFhirOntology()
  const world = generateWorld(ontology, { seed: SEED, patients: PATIENTS })

  // (a) metamorphic relations over the correct stack: GraphPath under test,
  // SqlOracle as ground truth where a relation calls for it. Each engine run
  // gets its own scoped in-memory DuckDB — hermetic by construction.
  const metamorphic = yield* runMetamorphic({
    ontology,
    world,
    bindings: bindTemplates(fhirCqTemplates, world, makeRng(SEED), BINDINGS),
    makePath: (w) => makeGraphPath(w, ontology),
    oracle: SqlOracle,
    seed: SEED,
    runsPerRelation: RUNS_PER_RELATION
  }).pipe(Effect.provide(duckDbLayer()))

  console.log(formatMetamorphicReport(metamorphic))
  console.log("")

  // (b) adversarial stress: plant every named defect, replay every invariant.
  const stress = yield* runStress({ ontology, world, seed: SEED }).pipe(
    Effect.provide(duckDbLayer())
  )

  console.log(formatStressReport(stress))
  console.log("")

  if (metamorphic.passed && stress.passed) {
    console.log("simulation: PASS — relations hold, clean world is silent, every mutator was caught.")
  } else {
    console.log("simulation: FAIL — see the reports above.")
    process.exitCode = 1
  }
})

Effect.runPromise(program)
