# memory-sql

**An ontology-backed SQL memory layer with built-in validation — one runtime
dependency, plain ESM JavaScript, Effect optional.**

> **This branch (`js`) is the no-TypeScript variant.** All sources are plain
> ESM `.js`; there is no build step — `node` runs `packages/core/src/`
> directly and the package `exports` map points straight at the sources. The
> `main` branch remains the TypeScript variant. What this branch gives up is
> **compile-time checking** (type annotations, `tsc`, editor-level contract
> enforcement); every **runtime** validation gate — `loadWorld` type-checking
> of world values, the CQ citation audit, the stress invariants, the Effect
> isolation test — is unchanged and behaves byte-for-byte like `main`.
> Contract shapes below are still written in TypeScript *notation* as
> documentation only.

memory-sql derives a typed ontology from the FHIR R4 specification (top 50
payer-weighted resources), generates deterministic instance worlds into SQL
(DuckDB), and ships two validation engines that grade *any* memory or
retrieval layer against deterministic ground truth:

- **Stage 1 — CQ dual-oracle.** Parametrized competency questions are answered
  two ways: by a deterministic **SQL oracle** (ground truth) and by a
  pluggable **`AnswerPath`** (the layer under test). Every answer gets a
  four-way verdict: `match | missing | divergent | unsupported-citation`.
- **Stage 2 — Simulation.** (a) **Metamorphic testing** — relations that need
  zero gold labels, checked over seeded samples of real bindings; failures
  come back with the concrete failing case. (b) **Adversarial instance
  stress** — mutate clean worlds with named defects, replay SQL invariants,
  and demand the mutator × invariant matrix comes back exact.

The product pitch: *plug your own answer layer (LLM, RAG, wiki agent, graph
store) into `AnswerPath`; memory-sql generates the data, owns the ground
truth, and tells you where — and how — your layer is wrong.* A reference
`GraphPath` (typed reference-walk over the in-memory world) is included so
everything runs out of the box, no external services required.

**Why a SQL oracle?** Because it makes validation deterministic. Every
competency question compiles to a SQL query over a world the generator built
from a seed. Same seed → same world → same rows → same canonical answer,
byte-for-byte, forever. There is no LLM judge, no gold-label annotation, no
sampling noise in the ground truth. Citations are mechanical too: a template's
SQL must surface the *supporting rows*, so "does this citation actually back
the answer?" is a set-membership check, not a judgment call.

## The minimal core (v2)

*("v2" is the SPEC revision — on npm it is `memory-sql@0.2.x`.)*

The core is deliberately small and flat:

- **One runtime dependency**: `@duckdb/node-api`. No CLI framework (the CLI is
  `node:util` `parseArgs`), no property-testing library (sampling runs on the
  in-repo seeded PRNG), no schema library, no Effect in the core.
- **Eleven flat source files**, one public entry (`memory-sql`) that
  re-exports everything — no deep import paths.
- **Plain `async/await`** and one op-tagged `Error` subclass
  (`MemorySqlError { op }`) are the idiom throughout.
- Determinism is a hard rule: one seeded PRNG module, no `Math.random`, no
  wall clock — a fixed `REFERENCE_DATE = "2026-01-01"` stands in where a
  "today" is unavoidable.

**What was traded for minimalism** (honest notes):

- The metamorphic runner samples cases with the seeded PRNG and reports the
  *failing case as sampled* — there is **no shrinking** of counterexamples
  (fast-check is gone). Failing cases are still fully reproducible from the
  seed.
- The CLI has no framework niceties (no auto-generated completions, no nested
  help trees) — `parseArgs` + a usage string.

## Effect users

Everything is wrapped in **`memory-sql/effect`**; the core never imports
Effect — **enforced by an executable test** (`tests/src/isolation.test.js`
walks every `.js` source in `packages/core/src`, `examples/src`, `tests/src`,
and `scripts` and fails the suite if anything outside the adapter, its
example, and its test imports `effect` or `@effect/*`).

The adapter (`packages/core/src/effect.js`, the ONLY file importing `effect`)
provides:

- `MemorySqlError` as a `Data.TaggedError("MemorySqlError")` carrying
  `{ op, cause }` — plain-core failures surface on the typed error channel;
- a `MemorySql` `Context.Tag` service with a scoped `layer(opts)` (store
  lifecycle via `Effect.acquireRelease` — the store closes when the scope
  closes);
- `Effect.tryPromise` / `Effect.try` wrappers for the plain API
  (`openStore`, `loadWorld`, `runCq`, `runMetamorphic`, `runStress`,
  `loadFhirOntology`, `generateWorld`), signatures inferred from the core so
  the two surfaces cannot drift;
- `answerPath(name, effectFn)` to adapt an Effect-based answerer to the plain
  `AnswerPath` the engines grade.

`effect` is an **optional peer dependency**: `import "memory-sql"` never loads
the adapter, and the main entry is fully functional with `effect` absent.
Declare `effect` in your own dependencies if you use `memory-sql/effect`.
See `examples/src/04-effect-adapter.js` for the full walkthrough.

### Migration note (v1 → v2): `AnswerPath` returns a `Promise`

In v1, `AnswerPath.answer` returned an Effect. In v2 the plug-in surface is
plain:

```ts
interface AnswerPath {
  readonly name: string
  readonly answer: (binding: CqBinding) => Promise<Answer>
}
```

This is the one deliberate public-surface change. If your answerer is written
in Effect, wrap it with the adapter's `answerPath(name, fn)` (it runs the
effect with `Effect.runPromise`); a rejected promise is graded `missing`,
never a suite crash.

## Architecture

```
                       ┌──────────────────────────────┐
  FHIR R4 spec ──────► │ ontology.js (generic model)  │
  (fetch-fhir.js,      │  top50.json → 50 EntityTypes │
   committed JSON)     │  (attributes + relations)    │
                       └───────────────┬──────────────┘
                                       │
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
             ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
             │ synth.js     │  │ store.js     │  │ cq.js       │
             │ seeded PRNG →│  │ DDL + DuckDB │  │ 13 FHIR CQs │
             │ InstanceWorld│  │ + loadWorld  │  │ (5 regimes) │
             └──────┬───────┘  └──────┬───────┘  └──────┬──────┘
                    │                 │                 │
                    ▼                 ▼                 ▼
             ┌─────────────────────────────────────────────────┐
             │ STAGE 1 · cq.js — dual oracle                   │
             │   oracle.js SqlOracle (ground truth)            │
             │   vs AnswerPath (GraphPath reference│YOUR layer)│
             │   → CqReport: match/missing/divergent/          │
             │     unsupported-citation, rates, per-regime     │
             └───────────────────────┬─────────────────────────┘
                                     │
             ┌───────────────────────▼─────────────────────────┐
             │ STAGE 2 · sim.js + sim-stress.js — simulation   │
             │   4 metamorphic relations (seeded sampling)     │
             │   8 mutators × 9 invariants stress matrix       │
             └─────────────────────────────────────────────────┘
```

## Quickstart

Requires Node >= 22.

```sh
npm install        # installs all three workspaces — no build step, ever
npm run check      # node --check syntax sweep over every source file
npm test           # runs the vitest suite in tests/ straight from src/

# the four examples (node runs the sources directly)
npm run example:01   # CQ dual-oracle on the clean world → CqReport
npm run example:02   # metamorphic relations + adversarial stress matrix
npm run example:03   # plug a custom (deliberately flawed) AnswerPath in
npm run example:04   # the Effect adapter (memory-sql/effect), from plain JS
```

Plain-API usage:

```js
import {
  bindTemplates, fhirCqTemplates, generateWorld, loadFhirOntology,
  makeGraphPath, makeRng, openStore, runCq
} from "memory-sql"

const ontology = loadFhirOntology()                       // sync, committed JSON
const world = generateWorld(ontology, { seed: 42, patients: 20 })
const bindings = bindTemplates(fhirCqTemplates, world, makeRng(42), 50)

const store = await openStore()                           // in-memory DuckDB
try {
  const report = await runCq(store, world, bindings, makeGraphPath(world, ontology), { ontology })
  console.log(report.agreementRate)
  // report.byRegime is an ARRAY of per-regime rows, e.g.
  // [{ regime: "point-lookup", total: 10, match: 10, missing: 0, divergent: 0,
  //    unsupportedCitation: 0, agreementRate: 1 }, ...]
  console.log(report.byRegime)
} finally {
  store.close()
}
```

### CLI

```sh
# node runs the source directly — no build, no tsx
node packages/core/src/cli.js synth --seed 42 --patients 20 --out world.json
node packages/core/src/cli.js cq    --seed 42 --world world.json -n 50
node packages/core/src/cli.js sim   --seed 42 --mrs 200
node packages/core/src/cli.js --help
```

- `synth` writes a seeded, referentially consistent `InstanceWorld` JSON.
- `cq` runs the dual-oracle suite (GraphPath vs SqlOracle) and prints the
  `CqReport`. `--bindings`/`-n` sets the number of Monte-Carlo sampled
  bindings.
- `sim` runs metamorphic + stress and prints both reports.

Exit codes are CI-gate semantics: `0` = pass; `1` on any non-`match` verdict,
a failed relation, a clean world with violations, a mutator that slips past
every invariant, `0` sampled bindings ("nothing graded is not nothing
wrong"), a rejected/degenerate world, or any expected failure — always a
friendly one-line error, never a stack trace.

## The FHIR top-50 ontology

- **Source**: FHIR **R4 (4.0.1)** — the US-payer-mandated version.
- `scripts/fetch-fhir.js` downloads `profiles-resources.json` from
  `hl7.org/fhir/R4`, extracts the 50 payer-weighted resource
  StructureDefinitions (Patient, Claim, Coverage, ExplanationOfBenefit,
  Encounter, Observation, MedicationRequest, …), trims each to what the
  ontology needs, and writes `packages/core/fhir-data/top50.json`. That file
  is **committed**, so tests and CI are fully offline; rerun
  `npm run fetch-fhir` to re-derive it from the spec.
- Flattening rules (documented in `packages/core/src/ontology.js`, applied
  deterministically by the fetch script): depth-1 elements plus a small
  whitelist of payer-critical backbone leaves; complex types map to fixed
  column sets (`Period → <f>_start/<f>_end`, `Money → <f>_cents/<f>_currency`,
  `CodeableConcept → <f>` code, `Reference(X|Y) →` a multi-target relation
  with `<f>_ref` + `<f>_ref_type` columns); choice elements resolve by a
  fixed preference order; required bindings with ≤ 25 codes become enumerable
  value sets.
- The ontology model itself is **generic** — the CQ and simulation engines
  never mention FHIR. All FHIR-specific knowledge lives in the committed
  data, the shipped templates, and the stress configuration, so the same
  engines run over any `Ontology` you hand them.

## Stage 1 — CQ dual-oracle

Lineage: **competency questions** — the classic ontology-engineering
technique (Grüninger & Fox) of specifying what a knowledge system must be
able to answer, here made executable and parametrized.

13 shipped templates cover five regimes: point-lookup, cross-entity,
aggregate, temporal, and negative-control (questions whose true answer is
provably empty — a fabrication detector). `bindTemplates` Monte-Carlo samples
parameters from the *actual world* (real patient/coverage/claim ids), the
SQL oracle computes ground truth, your `AnswerPath` answers the same
bindings, and `runCq` grades each pair:

| verdict | meaning |
| --- | --- |
| `match` | values equal and every citation resolves to a supporting row |
| `missing` | the path returned nothing where the oracle has an answer |
| `divergent` | values differ |
| `unsupported-citation` | right value, but a cited row does not support it |

The `CqReport` carries answerable-rate, agreement-rate,
citation-resolves-rate, a per-regime breakdown, and per-template binding
counts.

## Stage 2 — Simulation

- **Metamorphic testing** (lineage: Chen et al. — test without gold labels by
  checking *relations between* answers). Four shipped relations:
  irrelevant-augmentation (other patients' data must not change this
  patient's answers), temporal-narrowing (shrinking a period can only shrink
  a result set — three-sided, with an oracle-guided bisection probe),
  referential-symmetry (forward traversal equals reverse lookup),
  cross-oracle-equality (GraphPath ≡ SqlOracle everywhere). Cases are drawn
  with the seeded PRNG; a failing relation reports the concrete failing case
  (no shrinking — see the trade-off note above).
- **Adversarial instance stress** (lineage: the closed-world analogue of
  description-logic **ABox consistency checking** — instead of asking a
  reasoner whether assertions are consistent, plant a defect and demand a SQL
  invariant convicts it). Eight mutators (dangling-reference,
  missing-required, illegal-code, reversed-period, orphan-eob, duplicate-id,
  future-dated-birth, self-reference) × nine invariants. The contract: the
  clean world produces **zero** violations, and every mutator trips exactly
  its named invariant — printed as a matrix. This is "validation by
  simulation".

World loading is guarded at the boundary: `loadWorld` type-checks every value
against the ontology's column types and rejects a mistyped world with a
pointed, one-line error (op `load`) *before* any DDL or INSERT — no silent
DuckDB casts.

## Plugging in your own memory layer

`AnswerPath` is the product surface — plain `async`. Your `answer(binding)`
must resolve to an `Answer` of exactly this shape:

```ts
type AnswerKind = "set" | "scalar" | "boolean"
interface Citation { entityType: string; id: string }        // e.g. { entityType: "Condition", id: "condition-006" }
interface Answer {
  kind: AnswerKind
  value: ReadonlyArray<string> | number | string | boolean | null  // "set" = row ids; others = one scalar
  citations: ReadonlyArray<Citation>                         // the stored rows the answer relies on
}
```

Citations must be `{ entityType, id }` **objects**, not bare id strings — the
citation audit is a set-membership check against the oracle's support rows,
so a bare `"condition-006"` never resolves and an otherwise-correct answer is
graded `unsupported-citation`. (There is no compile-time check on this
branch — mind the shape; the runtime audit is what convicts a wrong one.)

```js
import {
  bindTemplates, fhirCqTemplates, generateWorld, loadFhirOntology,
  makeRng, openStore, runCq
} from "memory-sql"

const myPath = {
  name: "my-rag-stack",
  answer: async (binding) => {
    // call your LLM / vector store / wiki agent here, then e.g.:
    return { kind: "set", value: ["condition-006"], citations: [{ entityType: "Condition", id: "condition-006" }] }
  }
}

const ontology = loadFhirOntology()
const world = generateWorld(ontology, { seed: 42 })
const bindings = bindTemplates(fhirCqTemplates, world, makeRng(42), 50)
const store = await openStore()
const report = await runCq(store, world, bindings, myPath, { ontology })
```

**`examples/src/03-custom-answer-path.js` is the full walkthrough**: it
implements `NotesPath`, a deliberately imperfect "notes file" memory layer,
and watches memory-sql catch its truncated charts (`divergent`), fabricated
provenance (`unsupported-citation`), and gaps (`missing`) — without ever
being told how the layer works.

## Repository layout (isolation by construction)

npm workspaces: `packages/core` is the product (package name `memory-sql`);
`examples/` and `tests/` are separate private workspaces that depend on it
**by package name only** and import the published surface (`src/` via the
`exports` map) — never `../packages/core/src/...` relative reaches. Both
consumer workspaces declare their real dependencies (no phantom hoisting).
Tests test the public API; the examples exercise exactly what a downstream
consumer gets.

```
packages/core/src/  eleven flat files: ontology · rng · store · synth · oracle
                    · cq · sim · sim-stress · cli · index · effect (the ONLY
                    effect file)
examples/           01 dual-oracle · 02 simulation · 03 custom AnswerPath
                    · 04 effect adapter
tests/              vitest suite over the public API (9 files, incl. the
                    Effect isolation gate and the adapter test)
scripts/            fetch-fhir.js (one-time ontology derivation, plain JS)
```

## Status & license

Research prototype. The FHIR flattening is deliberately shallow (depth-1 +
documented whitelist — enough for real competency questions, not a full FHIR
ORM), the synthetic worlds are statistical toys, and nothing here has been
validated for clinical or payment use.

MIT — see [LICENSE](./LICENSE).
