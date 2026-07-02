/**
 * Example 01 — Stage 1 end to end: the CQ dual oracle on the clean world.
 *
 * One question, two independent answerers: the deterministic SQL oracle
 * (DuckDB over the loaded world — ground truth) and the reference GraphPath
 * (typed reference-walk over the same world in memory). On the clean generated
 * world the two must agree on every sampled binding; the printed CqReport is
 * the evidence, and any verdict other than `match` fails the script (exit 1 —
 * the same CI-gate semantics as `memory-sql cq`).
 *
 * That agreement is the point: once two independent implementations agree on
 * the ground truth, ANY memory layer can be graded against it — see example 03.
 *
 * Isolation: imports ONLY the published "memory-sql" surface (by package name).
 */
import {
  bindTemplates,
  fhirCqTemplates,
  generateWorld,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  openStore,
  runCq
} from "memory-sql"

const SEED = 42
const PATIENTS = 20
const SUITE_SIZE = 50

const pct = (x) => `${(x * 100).toFixed(1)}%`

const showReport = (report) => {
  console.log(
    `CqReport — path "${report.pathName}" vs SqlOracle, ${report.total} bindings ` +
      `over ${fhirCqTemplates.length} templates (seed ${SEED}, ${PATIENTS} patients)`
  )
  console.log("")
  console.log(
    `  match ${report.match}  missing ${report.missing}  divergent ${report.divergent}` +
      `  unsupported-citation ${report.unsupportedCitation}`
  )
  console.log(
    `  answerable ${pct(report.answerableRate)}  agreement ${pct(report.agreementRate)}` +
      `  citations-resolve ${pct(report.citationResolvesRate)}`
  )
  console.log("")
  console.log("  regime              total  match  miss  div  unsup  agreement")
  for (const r of report.byRegime) {
    console.log(
      `  ${r.regime.padEnd(18)} ${String(r.total).padStart(5)}  ${String(r.match).padStart(5)}` +
        `  ${String(r.missing).padStart(4)}  ${String(r.divergent).padStart(3)}` +
        `  ${String(r.unsupportedCitation).padStart(5)}  ${pct(r.agreementRate).padStart(9)}`
    )
  }
}

const main = async () => {
  // 1. Ontology (FHIR R4 top-50, committed JSON) + deterministic clean world.
  const ontology = loadFhirOntology()
  const world = generateWorld(ontology, { seed: SEED, patients: PATIENTS })

  const store = await openStore()
  try {
    // 2. Monte-Carlo bind the shipped templates against REAL ids/values/dates
    //    from this world — same seed, same suite, byte-identical report.
    const bindings = bindTemplates(fhirCqTemplates, world, makeRng(SEED), SUITE_SIZE)

    // 3. Answer everything twice (SQL oracle vs GraphPath) and grade. runCq
    //    loads the world into DuckDB itself; { ontology } gives it exact DDL —
    //    one table per entity type, empty tables included (negative-control
    //    questions must find real, empty tables).
    const report = await runCq(store, world, bindings, makeGraphPath(world, ontology), { ontology })

    showReport(report)

    const disagreements = report.results.filter((r) => r.verdict !== "match")
    if (disagreements.length > 0) {
      console.log("")
      console.log("dual-oracle disagreements on the CLEAN world (this is a bug):")
      for (const r of disagreements) {
        console.log(`  [${r.verdict}] ${r.question}`)
        console.log(`    oracle: ${JSON.stringify(r.oracle.value)}`)
        console.log(
          `    path:   ${r.path === null ? `(failed: ${r.pathError})` : JSON.stringify(r.path.value)}`
        )
      }
      process.exitCode = 1
    } else {
      console.log("")
      console.log("clean world: SQL oracle and GraphPath agree on every binding.")
    }
  } finally {
    store.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
