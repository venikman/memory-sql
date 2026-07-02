# memory-sql

**An ontology-backed SQL memory layer with built-in validation.**

memory-sql derives a typed ontology from the FHIR R4 specification (top 50
payer-weighted resources), generates deterministic instance worlds into SQL
(DuckDB), and ships two validation engines that grade *any* memory or
retrieval layer against deterministic ground truth:

- **Stage 1 — CQ dual-oracle.** Parametrized competency questions are answered
  two ways: by a deterministic **SQL oracle** (ground truth) and by a
  pluggable **`AnswerPath`** (the layer under test). Every answer gets a
  four-way verdict: `match | missing | divergent | unsupported-citation`.
- **Stage 2 — Simulation.** (a) **Metamorphic testing** — relations that need
  zero gold labels, checked with fast-check and shrunk counterexamples on
  failure. (b) **Adversarial instance stress** — mutate clean worlds with
  named defects, replay SQL invariants, and demand the mutator × invariant
  matrix comes back exact.

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

## Architecture

```
                       ┌──────────────────────────────┐
  FHIR R4 spec ──────► │ ontology/  (generic model)   │
  (fetch-fhir.ts,      │  fhir.ts: top50.json → 50    │
   committed JSON)     │  EntityTypes (attrs+relations)│
                       └───────────────┬──────────────┘
                                       │
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
             ┌──────────────┐  ┌──────────────┐  ┌─────────────┐
             │ synth/       │  │ store/       │  │ cq/templates│
             │ seeded PRNG →│  │ DDL + DuckDB │  │ 13 FHIR CQs │
             │ InstanceWorld│  │ Effect layer │  │ (5 regimes) │
             └──────┬───────┘  └──────┬───────┘  └──────┬──────┘
                    │                 │                 │
                    ▼                 ▼                 ▼
             ┌─────────────────────────────────────────────────┐
             │ STAGE 1 · cq/engine — dual oracle               │
             │   SqlOracle (ground truth)  vs  AnswerPath      │
             │   (GraphPath reference │ YOUR layer)            │
             │   → CqReport: match/missing/divergent/          │
             │     unsupported-citation, rates, per-regime     │
             └───────────────────────┬─────────────────────────┘
                                     │
             ┌───────────────────────▼─────────────────────────┐
             │ STAGE 2 · sim/ — validation by simulation       │
             │   metamorphic.ts: 4 relations + fast-check      │
             │   stress.ts: 8 mutators × 9 invariants matrix   │
             └─────────────────────────────────────────────────┘
```

Everything effectful runs on [Effect](https://effect.website) (services,
layers, tagged errors, `@effect/cli`); pure logic (ontology transforms,
verdict math, metamorphic relations) is plain synchronous TypeScript.
Determinism is a hard rule: one seeded PRNG module, no `Math.random`, no wall
clock — a fixed `REFERENCE_DATE = "2026-01-01"` stands in where a "today" is
unavoidable.

## Quickstart

Requires Node >= 22.

```sh
npm install        # installs all three workspaces
npm run build      # compiles packages/core → dist/
npm test           # builds, then runs the vitest suite in tests/

# the three examples (each rebuilds core first)
npm run example:01   # CQ dual-oracle on the clean world → CqReport
npm run example:02   # metamorphic relations + adversarial stress matrix
npm run example:03   # plug a custom (deliberately flawed) AnswerPath in
```

### CLI

```sh
# dev (tsx, from source)
npx tsx packages/core/src/cli.ts synth --seed 42 --patients 20 --out world.json
npx tsx packages/core/src/cli.ts cq    --seed 42 --world world.json -n 50
npx tsx packages/core/src/cli.ts sim   --seed 42 --mrs 200

# built
node packages/core/dist/cli.js --help
```

- `synth` writes a seeded, referentially consistent `InstanceWorld` JSON.
- `cq` runs the dual-oracle suite (GraphPath vs SqlOracle) and prints the
  `CqReport`. `--bindings`/`-n` sets the number of Monte-Carlo sampled
  bindings.
- `sim` runs metamorphic + stress and prints both reports.

Exit codes are CI-gate semantics: `cq` exits 1 on any non-`match` verdict,
`sim` exits 1 if a relation fails, the clean world has violations, or a
mutator slips past every invariant.

## The FHIR top-50 ontology

- **Source**: FHIR **R4 (4.0.1)** — the US-payer-mandated version.
- `scripts/fetch-fhir.ts` downloads `profiles-resources.json` from
  `hl7.org/fhir/R4`, extracts the 50 payer-weighted resource
  StructureDefinitions (Patient, Claim, Coverage, ExplanationOfBenefit,
  Encounter, Observation, MedicationRequest, …), trims each to what the
  ontology needs, and writes `packages/core/fhir-data/top50.json`. That file
  is **committed**, so build, tests, and CI are fully offline; rerun
  `npm run fetch-fhir` to re-derive it from the spec.
- Flattening rules (documented in `ontology/model.ts`, applied
  deterministically by the fetch script): depth-1 elements plus a small
  whitelist of payer-critical backbone leaves; complex types map to fixed
  column sets (`Period → <f>_start/<f>_end`, `Money → <f>_cents/<f>_currency`,
  `CodeableConcept → <f>` code, `Reference(X|Y) →` a multi-target relation
  with `<f>_ref` + `<f>_ref_type` columns); choice elements resolve by a
  fixed preference order; required bindings with ≤ 25 codes become enumerable
  value sets.
- The ontology model itself (`ontology/model.ts`) is **generic** — the CQ and
  simulation engines never mention FHIR. All FHIR-specific knowledge lives in
  the committed data, the shipped templates, and the stress configuration, so
  the same engines run over any `Ontology` you hand them.

## Stage 1 — CQ dual-oracle

Lineage: **competency questions** — the classic ontology-engineering
technique (Grüninger & Fox) of specifying what a knowledge system must be
able to answer, here made executable and parametrized.

13 shipped templates cover five regimes: point-lookup, cross-entity,
aggregate, temporal, and negative-control (questions whose true answer is
provably empty — a fabrication detector). `bindTemplates` Monte-Carlo samples
parameters from the *actual world* (real patient/coverage/claim ids), the
`SqlOracle` computes ground truth, your `AnswerPath` answers the same
bindings, and `runSuite` grades each pair:

| verdict | meaning |
| --- | --- |
| `match` | values equal and every citation resolves to a supporting row |
| `missing` | the path returned nothing where the oracle has an answer |
| `divergent` | values differ |
| `unsupported-citation` | right value, but a cited row does not support it |

The `CqReport` carries answerable-rate, agreement-rate,
citation-resolves-rate, and a per-regime breakdown.

## Stage 2 — Simulation

- **Metamorphic testing** (lineage: Chen et al. — test without gold labels by
  checking *relations between* answers). Four shipped relations:
  irrelevant-augmentation (other patients' data must not change this
  patient's answers), temporal-narrowing (shrinking a period can only shrink
  a result set), referential-symmetry (forward traversal equals reverse
  lookup), cross-oracle-equality (GraphPath ≡ SqlOracle everywhere). The
  fast-check runner reports shrunk counterexamples on failure.
- **Adversarial instance stress** (lineage: the closed-world analogue of
  description-logic **ABox consistency checking** — instead of asking a
  reasoner whether assertions are consistent, plant a defect and demand a SQL
  invariant convicts it). Eight mutators (dangling-reference,
  missing-required, illegal-code, reversed-period, orphan-eob, duplicate-id,
  future-dated-birth, self-reference) × nine invariants. The contract: the
  clean world produces **zero** violations, and every mutator trips exactly
  its named invariant — printed as a matrix. This is "validation by
  simulation".

## Plugging in your own memory layer

`AnswerPath` is the product surface:

```ts
import { Effect } from "effect"
import type { AnswerPath } from "memory-sql"
import {
  bindTemplates, duckDbLayer, fhirCqTemplates, generateWorld,
  loadFhirOntology, loadWorld, makeRng, runSuite, SqlOracle
} from "memory-sql"

const myPath: AnswerPath = {
  name: "my-rag-stack",
  answer: (binding) => Effect.gen(function* () {
    // call your LLM / vector store / wiki agent here;
    // return { kind, value, citations } — cite the rows you relied on
  }),
}
```

Hand it to `runSuite(bindings, SqlOracle, myPath)` and read the report. The
wiring around that call: bindings come from
`bindTemplates(fhirCqTemplates, world, makeRng(seed), n)` over a world you
have `loadWorld`-ed (generate one with `generateWorld(ontology, { seed })`
after `loadFhirOntology()`), and `runSuite` returns an Effect that needs the
DuckDB service — run the whole thing under `Effect.provide(duckDbLayer())`.
Note for downstream consumers: declare `effect` in your own `dependencies`
(it is a regular dependency of `memory-sql`, so relying on hoisting works
under npm but breaks under pnpm / Yarn PnP strict resolution).
**`examples/src/03-custom-answer-path.ts` is the full walkthrough**: it
implements `NotesPath`, a deliberately imperfect "notes file" memory layer,
and watches memory-sql catch its truncated charts (`divergent`), fabricated
provenance (`unsupported-citation`), and gaps (`missing`) — without ever
being told how the layer works.

## Repository layout (isolation by construction)

npm workspaces: `packages/core` is the product (package name `memory-sql`);
`examples/` and `tests/` are separate private workspaces that depend on it
**by package name only** and import the published surface (`dist/` via the
`exports` map) — never `../packages/core/src/...` relative reaches. Tests
test the public API; the examples exercise exactly what a downstream consumer
gets.

```
packages/core/    the product: ontology/ store/ synth/ oracle/ cq/ sim/ cli
examples/         01 dual-oracle · 02 simulation · 03 custom AnswerPath
tests/            vitest suite over the public API (7 files)
scripts/          fetch-fhir.ts (one-time ontology derivation)
```

## Status & license

Research prototype. The FHIR flattening is deliberately shallow (depth-1 +
documented whitelist — enough for real competency questions, not a full FHIR
ORM), the synthetic worlds are statistical toys, and nothing here has been
validated for clinical or payment use.

MIT — see [LICENSE](./LICENSE).
