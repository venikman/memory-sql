/**
 * Example 02 — Stage 2: validation by simulation, no gold labels anywhere.
 *
 * Two engines, two complementary questions:
 *
 * (a) METAMORPHIC — "does the answer layer behave like the ontology says it
 *     must?" A metamorphic relation states how an answer must (or must not)
 *     change under a known transformation — add unrelated patients, narrow a
 *     period, flip a traversal direction, swap evaluators. No expected values
 *     are ever written down; the seeded property runner drives cases over
 *     sampled bindings and reports the failing case on violation (v2 trades
 *     fast-check shrinking for zero runtime dependencies). Here the layer
 *     under test is the reference GraphPath, so all relations must hold.
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
 * Deterministic end to end (seeded PRNG throughout); exit 1 on any violation,
 * mirroring `memory-sql sim`.
 *
 * Isolation: imports ONLY the published "memory-sql" surface (by package name).
 */
import {
  bindTemplates,
  fhirCqTemplates,
  formatMetamorphicReport,
  formatStressReport,
  generateWorld,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  openStore,
  runMetamorphic,
  runStress
} from "memory-sql"

const SEED = 7
const PATIENTS = 20
const BINDINGS = 40
const RUNS_PER_RELATION = 100

const main = async () => {
  const ontology = loadFhirOntology()
  const world = generateWorld(ontology, { seed: SEED, patients: PATIENTS })

  // (a) metamorphic relations over the correct stack: GraphPath under test,
  // the SQL oracle as ground truth where a relation calls for it. The engine
  // run gets its own in-memory store — hermetic by construction.
  const store = await openStore()
  let metamorphic
  try {
    metamorphic = await runMetamorphic(store, world, {
      ontology,
      bindings: bindTemplates(fhirCqTemplates, world, makeRng(SEED), BINDINGS),
      makePath: (w) => makeGraphPath(w, ontology),
      seed: SEED,
      runsPerRelation: RUNS_PER_RELATION
    })
  } finally {
    store.close()
  }

  console.log(formatMetamorphicReport(metamorphic))
  console.log("")

  // (b) adversarial stress: plant every named defect, replay every invariant.
  // runStress opens its own store and builds the mutated worlds itself.
  const stress = await runStress(ontology, { seed: SEED, world })

  console.log(formatStressReport(stress))
  console.log("")

  if (metamorphic.passed && stress.passed) {
    console.log(
      "simulation: PASS — relations hold, clean world is silent, every mutator was caught."
    )
  } else {
    console.log("simulation: FAIL — see the reports above.")
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
