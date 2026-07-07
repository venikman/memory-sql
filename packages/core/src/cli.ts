#!/usr/bin/env node
/**
 * memory-sql CLI — node:util parseArgs, plain async main.
 * `synth` writes a deterministic clean world; `cq` runs the dual-oracle suite
 * (GraphPath vs the SQL oracle). CI-gate semantics:
 * exit 0 = pass; exit 1 on any divergence, on 0 sampled bindings
 * ("nothing graded is not nothing wrong"), on a rejected/degenerate world,
 * and on any expected failure — always a friendly one-line error, never a
 * stack trace. Determinism: everything flows from --seed; no wall clock
 * anywhere.
 */
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import type { CqReport, InstanceWorld } from "./index.js"
import {
  bindTemplates,
  fhirCqTemplates,
  formatCqReport,
  generateWorld,
  loadFhirOntology,
  makeGraphPath,
  makeRng,
  MemorySqlError,
  openStore,
  runCq
} from "./index.js"

const USAGE = `memory-sql — ontology-backed SQL memory layer with built-in validation (FHIR R4 top-50 over DuckDB)

Usage:
  memory-sql synth [--seed N] [--patients N] [--out FILE]    generate a deterministic, referentially consistent world
  memory-sql cq    [--seed N] [--world FILE] [--bindings N]  run the CQ dual-oracle suite (exit 1 on any divergence)

Flags:
  -s, --seed N      PRNG seed — same seed, same world, same report (default 42)
  -p, --patients N  cohort size; patient-scoped resources scale with it (default 20)
  -o, --out FILE    output path for the generated InstanceWorld JSON (default world.json)
      --world FILE  InstanceWorld JSON to grade against (default: generate from --seed)
  -n, --bindings N  number of Monte-Carlo sampled bindings (default 50)

Exit codes: 0 = pass; 1 = divergences, an empty suite, or any expected failure.`

const DEFAULT_SEED = 42
const DEFAULT_PATIENTS = 20
const DEFAULT_BINDINGS = 50
const MAX_FINDINGS_SHOWN = 10

// ── Flag parsing (node:util parseArgs — no CLI framework) ────────────────────

type FlagSpec = Readonly<Record<string, { readonly type: "string"; readonly short?: string }>>

/** Parse the flags of one subcommand; unknown flags become a friendly error. */
const parsedFlags = <T extends FlagSpec>(args: readonly string[], options: T): { readonly [K in keyof T]: string | undefined } => {
  try {
    const { values } = parseArgs({ args: [...args], options, allowPositionals: false })
    return values as unknown as { readonly [K in keyof T]: string | undefined }
  } catch (cause) {
    throw new MemorySqlError(
      "cli",
      `${cause instanceof Error ? cause.message : String(cause)} — run \`memory-sql --help\` for usage`,
      cause
    )
  }
}

const intFlag = (name: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new MemorySqlError("cli", `--${name} expects an integer, got "${raw}"`)
  return value
}

/** Every expected error becomes one friendly, actionable line + exit 1 — never a stack trace. */
const explain = (error: unknown): string =>
  error instanceof MemorySqlError
    ? `memory-sql: [${error.op}] ${error.message}`
    : `memory-sql: ${error instanceof Error ? error.message : String(error)}`

/** A finding fails the run (CI-gate semantics) without aborting the printout. */
const failRun = (message: string): void => {
  console.log(message)
  process.exitCode = 1
}

// ── --world boundary: incoming JSON is validated down to the store's scalar
// domain before it gets near the engines (per-column type validation against
// the ontology then happens in loadWorld). ──────────────────────────────────

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"

const parseWorld = (raw: unknown, path: string): InstanceWorld => {
  const bad = (detail: string): MemorySqlError => new MemorySqlError("parse", `--world file ${path}: ${detail}`)
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw bad("expected an object mapping entity type -> array of rows")
  }
  for (const [entityType, rows] of Object.entries(raw)) {
    if (!Array.isArray(rows)) throw bad(`"${entityType}" must map to an array of rows`)
    for (const [i, row] of rows.entries()) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw bad(`${entityType}[${i}] must be an object of column -> scalar`)
      }
      for (const [column, value] of Object.entries(row as Record<string, unknown>)) {
        if (!isScalar(value)) throw bad(`${entityType}[${i}].${column} must be string | number | boolean | null`)
      }
    }
  }
  return raw as InstanceWorld
}

const readWorldFile = async (path: string): Promise<InstanceWorld> => {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (cause) {
    throw new MemorySqlError("parse", `cannot read --world file ${path}`, cause)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch (cause) {
    throw new MemorySqlError("parse", `--world file ${path} is not valid JSON`, cause)
  }
  return parseWorld(raw, path)
}

// ── synth — write a deterministic clean world to JSON ────────────────────────

const synthCommand = async (args: readonly string[]): Promise<void> => {
  const flags = parsedFlags(args, {
    seed: { type: "string", short: "s" },
    patients: { type: "string", short: "p" },
    out: { type: "string", short: "o" }
  })
  const seed = intFlag("seed", flags.seed, DEFAULT_SEED)
  const patients = intFlag("patients", flags.patients, DEFAULT_PATIENTS)
  const out = flags.out ?? "world.json"

  const world = generateWorld(loadFhirOntology(), { seed, patients })
  await writeFile(out, JSON.stringify(world, null, 2))
  const lists = Object.values(world)
  const rows = lists.reduce((n, list) => n + list.length, 0)
  console.log(`synth: ${rows} rows across ${lists.length} entity types (seed ${seed}, ${patients} patients) -> ${out}`)
}

// ── cq — dual-oracle suite, GraphPath vs the SQL oracle ──────────────────────

const cqCommand = async (args: readonly string[]): Promise<void> => {
  const flags = parsedFlags(args, {
    seed: { type: "string", short: "s" },
    world: { type: "string" },
    bindings: { type: "string", short: "n" }
  })
  const seed = intFlag("seed", flags.seed, DEFAULT_SEED)
  const n = intFlag("bindings", flags.bindings, DEFAULT_BINDINGS)

  const ontology = loadFhirOntology()
  const world = flags.world === undefined ? generateWorld(ontology, { seed }) : await readWorldFile(flags.world)
  const bindings = bindTemplates(fhirCqTemplates, world, makeRng(seed), n)

  // A degenerate world (empty or missing entity pools) silently drops
  // bindings; the gate must distinguish "nothing wrong" from "nothing graded"
  // — a green exit code IS the validation result (SPEC).
  if (bindings.length === 0) {
    failRun(
      n === 0
        ? "cq: FAIL — --bindings 0 requested; nothing was graded, and nothing graded is not nothing wrong"
        : "cq: FAIL — 0 bindings could be sampled from this world (empty or missing entity pools); nothing was graded"
    )
    return
  }

  // runCq loads the world itself; { ontology } gives it exact DDL (all tables
  // exist, even empty ones — negative-control questions depend on that).
  const store = await openStore()
  let report: CqReport
  try {
    report = await runCq(store, world, bindings, makeGraphPath(world, ontology), { ontology })
  } finally {
    store.close()
  }

  console.log(formatCqReport(report))

  const findings = report.results.filter((r) => r.verdict !== "match")
  if (findings.length === 0) {
    console.log("cq: PASS — the two oracles agree on every binding")
    return
  }
  for (const r of findings.slice(0, MAX_FINDINGS_SHOWN)) {
    console.log(`  [${r.verdict}] (${r.templateId}) ${r.question}`)
    console.log(`    oracle ${JSON.stringify(r.oracle.value)}`)
    console.log(`    path   ${r.path === null ? `failed: ${r.pathError}` : JSON.stringify(r.path.value)}`)
  }
  if (findings.length > MAX_FINDINGS_SHOWN) {
    console.log(`  ... and ${findings.length - MAX_FINDINGS_SHOWN} more`)
  }
  failRun(`cq: FAIL — ${findings.length} of ${report.total} bindings did not match`)
}

// ── dispatch + run ───────────────────────────────────────────────────────────

const main = async (argv: readonly string[]): Promise<void> => {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
      console.log(USAGE)
      process.exitCode = 1
      return
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE)
      return
    case "synth":
      return synthCommand(rest)
    case "cq":
      return cqCommand(rest)
    default:
      throw new MemorySqlError("cli", `unknown command "${command}" — expected synth | cq`)
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(explain(error))
  process.exitCode = 1
})
