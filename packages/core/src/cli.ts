#!/usr/bin/env node
/**
 * memory-sql CLI (@effect/cli):
 *
 *   memory-sql synth --seed 42 --patients 20 --out world.json
 *   memory-sql cq    --seed 42 [--world world.json] [--n 50]
 *   memory-sql sim   --seed 42 [--mrs 200]
 *
 * `synth` writes a deterministic clean world; `cq` runs the Stage 1
 * dual-oracle suite (GraphPath vs SqlOracle); `sim` runs Stage 2 (metamorphic
 * relations + adversarial stress). CI-gate semantics per SPEC: any divergence
 * or violation exits 1 — a green exit code IS the validation result. Domain
 * errors are mapped to one-line friendly messages (no defect dumps); the
 * runtime only sees already-handled effects.
 *
 * Determinism: everything flows from --seed; no wall clock anywhere.
 */
import { Command, Options } from "@effect/cli"
import { isValidationError } from "@effect/cli/ValidationError"
import { FileSystem } from "@effect/platform"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Option, Schema } from "effect"
import { loadFhirOntology } from "./ontology/fhir.js"
import type { Ontology } from "./ontology/model.js"
import { duckDbLayer } from "./store/db.js"
import type { InstanceWorld } from "./store/load.js"
import { loadWorld } from "./store/load.js"
import { generateWorld } from "./synth/generate.js"
import { makeRng } from "./synth/rng.js"
import { SqlOracle } from "./oracle/sql.js"
import type { CqReport } from "./cq/engine.js"
import { bindTemplates, runSuite } from "./cq/engine.js"
import { makeGraphPath } from "./cq/graph-path.js"
import { fhirCqTemplates } from "./cq/templates.js"
import { formatMetamorphicReport, runMetamorphic } from "./sim/metamorphic.js"
import { formatStressReport, runStress } from "./sim/stress.js"

// ─────────────────────────────────────────────────────────────────────────────
// Shared options + helpers
// ─────────────────────────────────────────────────────────────────────────────

const seedOption = Options.integer("seed").pipe(
  Options.withAlias("s"),
  Options.withDefault(42),
  Options.withDescription("PRNG seed — same seed, same world, same report")
)

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

/**
 * Friendly tagged-error mapping: every domain failure becomes one actionable
 * line + exit 1, instead of a fiber failure dump. Defects (real bugs) still
 * crash loudly through the runtime.
 */
const explain = (error: unknown): string => {
  const tag =
    error !== null && typeof error === "object" && "_tag" in error
      ? String((error as { readonly _tag: unknown })._tag)
      : "Error"
  const message =
    error !== null && typeof error === "object" && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : String(error)
  const hint =
    tag === "FhirLoadError"
      ? " (fhir-data/top50.json is committed — re-derive with `npm run fetch-fhir`)"
      : tag === "DbError"
        ? " (DuckDB rejected a statement over the loaded world)"
        : tag === "OracleError"
          ? " (a CQ template's ground-truth SQL failed — this is a template bug, not a path failure)"
          : tag === "ParseError"
            ? " (--world file is not a valid InstanceWorld JSON — produce one with `memory-sql synth`)"
            : ""
  return `memory-sql: [${tag}] ${message}${hint}`
}

const friendly = <E, R>(effect: Effect.Effect<void, E, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      Console.error(explain(error)).pipe(
        Effect.zipRight(Effect.sync(() => {
          process.exitCode = 1
        }))
      )
    )
  )

/** Findings fail the run (CI-gate semantics) without aborting the printout. */
const failRun = (message: string): Effect.Effect<void> =>
  Console.log(message).pipe(
    Effect.zipRight(Effect.sync(() => {
      process.exitCode = 1
    }))
  )

const worldStats = (world: InstanceWorld): { readonly types: number; readonly rows: number } => {
  const lists = Object.values(world)
  return { types: lists.length, rows: lists.reduce((n, rows) => n + rows.length, 0) }
}

// The --world parse boundary: whatever JSON comes in is Schema-validated down
// to the store's scalar domain before it is allowed near the engines.
const InstanceWorldSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Array(
    Schema.Record({
      key: Schema.String,
      value: Schema.NullOr(Schema.Union(Schema.String, Schema.Number, Schema.Boolean))
    })
  )
})

const readWorldFile = (path: string): Effect.Effect<InstanceWorld, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path)
    return yield* Schema.decodeUnknown(Schema.parseJson(InstanceWorldSchema))(text)
  })

const worldFor = (
  ontology: Ontology,
  seed: number,
  worldPath: Option.Option<string>
): Effect.Effect<InstanceWorld, unknown, FileSystem.FileSystem> =>
  Option.match(worldPath, {
    onNone: () => Effect.succeed(generateWorld(ontology, { seed })),
    onSome: readWorldFile
  })

// ─────────────────────────────────────────────────────────────────────────────
// synth — write a deterministic clean world to JSON
// ─────────────────────────────────────────────────────────────────────────────

const patientsOption = Options.integer("patients").pipe(
  Options.withAlias("p"),
  Options.withDefault(20),
  Options.withDescription("cohort size (patient-scoped resources scale with it)")
)

const outOption = Options.file("out").pipe(
  Options.withAlias("o"),
  Options.withDefault("world.json"),
  Options.withDescription("output path for the generated InstanceWorld JSON")
)

const synthCommand = Command.make(
  "synth",
  { seed: seedOption, patients: patientsOption, out: outOption },
  ({ out, patients, seed }) =>
    friendly(
      Effect.gen(function* () {
        const ontology = yield* loadFhirOntology()
        const world = generateWorld(ontology, { seed, patients })
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(out, JSON.stringify(world, null, 2))
        const { rows, types } = worldStats(world)
        yield* Console.log(
          `synth: ${rows} rows across ${types} entity types (seed ${seed}, ${patients} patients) -> ${out}`
        )
      })
    )
).pipe(Command.withDescription("generate a deterministic, referentially consistent world"))

// ─────────────────────────────────────────────────────────────────────────────
// cq — Stage 1: dual-oracle suite, GraphPath vs SqlOracle
// ─────────────────────────────────────────────────────────────────────────────

const worldOption = Options.file("world", { exists: "yes" }).pipe(
  Options.optional,
  Options.withDescription("InstanceWorld JSON to grade against (default: generate from --seed)")
)

const suiteSizeOption = Options.integer("bindings").pipe(
  Options.withAlias("n"),
  Options.withDefault(50),
  Options.withDescription("number of Monte-Carlo sampled bindings (-n 50)")
)

const renderCqReport = (report: CqReport): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log(
      `cq: path "${report.pathName}" vs SqlOracle — ${report.total} bindings over ${fhirCqTemplates.length} templates`
    )
    yield* Console.log(
      `  match ${report.match}  missing ${report.missing}  divergent ${report.divergent}  unsupported-citation ${report.unsupportedCitation}`
    )
    yield* Console.log(
      `  answerable ${pct(report.answerableRate)}  agreement ${pct(report.agreementRate)}  citations-resolve ${pct(report.citationResolvesRate)}`
    )
    for (const r of report.byRegime) {
      yield* Console.log(
        `  ${r.regime.padEnd(18)} total ${String(r.total).padStart(3)}  match ${String(r.match).padStart(3)}  agreement ${pct(r.agreementRate)}`
      )
    }
  })

const MAX_FINDINGS_SHOWN = 10

const cqCommand = Command.make(
  "cq",
  { seed: seedOption, world: worldOption, n: suiteSizeOption },
  ({ n, seed, world: worldPath }) =>
    friendly(
      Effect.gen(function* () {
        const ontology = yield* loadFhirOntology()
        const world = yield* worldFor(ontology, seed, worldPath)
        const bindings = bindTemplates(fhirCqTemplates, world, makeRng(seed), n)

        // A degenerate world (empty or missing entity pools) silently drops
        // bindings; the gate must distinguish "nothing wrong" from "nothing
        // graded" — a green exit code IS the validation result (SPEC).
        if (bindings.length === 0) {
          yield* failRun(
            "cq: FAIL — 0 bindings could be sampled from this world (empty or missing entity pools); nothing was graded"
          )
          return
        }
        const unsampled = fhirCqTemplates.filter((t) => !bindings.some((b) => b.template.id === t.id))
        if (unsampled.length > 0) {
          yield* Console.log(
            `cq: WARNING — ${unsampled.length} of ${fhirCqTemplates.length} templates produced no binding on this world and go ungraded: ${unsampled.map((t) => t.id).join(", ")}`
          )
        }

        const report = yield* Effect.gen(function* () {
          yield* loadWorld(world, ontology)
          return yield* runSuite(bindings, SqlOracle, makeGraphPath(world, ontology))
        }).pipe(Effect.provide(duckDbLayer()))

        yield* renderCqReport(report)

        const findings = report.results.filter((r) => r.verdict !== "match")
        if (findings.length === 0) {
          yield* Console.log("cq: PASS — the two oracles agree on every binding")
          return
        }
        for (const r of findings.slice(0, MAX_FINDINGS_SHOWN)) {
          yield* Console.log(`  [${r.verdict}] (${r.templateId}) ${r.question}`)
          yield* Console.log(`    oracle ${JSON.stringify(r.oracle.value)}`)
          yield* Console.log(
            `    path   ${r.path === null ? `failed: ${r.pathError}` : JSON.stringify(r.path.value)}`
          )
        }
        if (findings.length > MAX_FINDINGS_SHOWN) {
          yield* Console.log(`  ... and ${findings.length - MAX_FINDINGS_SHOWN} more`)
        }
        yield* failRun(`cq: FAIL — ${findings.length} of ${report.total} bindings did not match`)
      })
    )
).pipe(Command.withDescription("run the CQ dual-oracle suite (exit 1 on any divergence)"))

// ─────────────────────────────────────────────────────────────────────────────
// sim — Stage 2: metamorphic relations + adversarial stress
// ─────────────────────────────────────────────────────────────────────────────

const mrsOption = Options.integer("mrs").pipe(
  Options.withDefault(200),
  Options.withDescription("fast-check runs per metamorphic relation")
)

/** Bindings the metamorphic properties draw from (fast-check picks indices). */
const SIM_BINDING_COUNT = 50

const simCommand = Command.make(
  "sim",
  { seed: seedOption, mrs: mrsOption },
  ({ mrs, seed }) =>
    friendly(
      Effect.gen(function* () {
        const ontology = yield* loadFhirOntology()
        const world = generateWorld(ontology, { seed })

        // (a) metamorphic: label-free relations, fast-check over sampled
        // bindings, GraphPath as the answer layer under test
        const metamorphic = yield* runMetamorphic({
          ontology,
          world,
          bindings: bindTemplates(fhirCqTemplates, world, makeRng(seed), SIM_BINDING_COUNT),
          makePath: (w) => makeGraphPath(w, ontology),
          oracle: SqlOracle,
          seed,
          runsPerRelation: mrs
        }).pipe(Effect.provide(duckDbLayer()))
        yield* Console.log(formatMetamorphicReport(metamorphic))

        // (b) stress: mutator x invariant matrix — the clean world must be
        // silent, every planted defect must be caught
        const stress = yield* runStress({ ontology, world, seed }).pipe(
          Effect.provide(duckDbLayer())
        )
        yield* Console.log(formatStressReport(stress))

        if (metamorphic.passed && stress.passed) {
          yield* Console.log(
            "sim: PASS — relations hold, clean world is silent, every mutator was caught"
          )
        } else {
          yield* failRun("sim: FAIL — see the reports above")
        }
      })
    )
).pipe(Command.withDescription("run metamorphic + stress engines (exit 1 on violations)"))

// ─────────────────────────────────────────────────────────────────────────────
// wire + run
// ─────────────────────────────────────────────────────────────────────────────

const root = Command.make("memory-sql").pipe(
  Command.withDescription(
    "ontology-backed SQL memory layer with built-in validation (FHIR R4 top-50 over DuckDB)"
  ),
  Command.withSubcommands([synthCommand, cqCommand, simCommand])
)

const cli = Command.run(root, { name: "memory-sql", version: "0.1.0" })

cli(process.argv).pipe(
  // CliApp already rendered the usage error; just carry the exit code.
  Effect.catchIf(isValidationError, () =>
    Effect.sync(() => {
      process.exitCode = 1
    })
  ),
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
