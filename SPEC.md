> **THIS IS THE `js` BRANCH** — the no-TypeScript variant. The spec below is
> the authoritative v2 contract written for the TS implementation on `main`;
> on this branch every behavioral clause applies unchanged, while the
> TypeScript-specific mandates read as their JS equivalents: plain ESM `.js`
> run directly by Node (no build), no `typescript`/`tsx` anywhere, and the
> Effect isolation gate scans `.js` files. Behavior parity with `main` is
> byte-verified (see README callout).

# memory-sql — SPEC v2 (minimalist refactor)

**memory-sql** is an ontology-backed SQL memory layer with built-in validation:
a FHIR-R4-derived ontology (top 50 resources) over DuckDB, a pluggable
**AnswerPath** graded against a deterministic **SQL oracle** (Stage 1, four-way
verdicts), and **simulation** engines (Stage 2: metamorphic relations +
adversarial stress). v2 keeps ALL of that behavior and rewrites the codebase to
be **very minimal**, with **Effect isolated to a single optional adapter**.

## v2 mandates (user-directed)

1. **Very minimalist codebase.** Budgets (hard):
   - Core source (`packages/core/src`, excluding `effect.ts` and committed
     `fhir-data`): **≤ ~2,000 LOC across ≤ 10 files**.
   - Runtime dependencies of the core: **exactly one** — `@duckdb/node-api`.
     No `@effect/*`, no `fast-check`, no `yaml`, nothing else at runtime.
   - Public API: small and flat — one `index.ts`, no deep import paths needed.
   - CLI uses `node:util` `parseArgs` — no CLI framework.
   - Sampling/generation uses the in-repo seeded PRNG (drop fast-check; the
     metamorphic runner reports the failing case without shrinking — README
     notes the trade-off).
2. **Effect lives in isolation and is only used-or-referred.**
   - Exactly ONE file may import `effect`:
     `packages/core/src/effect.ts`, published as the subpath export
     **`memory-sql/effect`**. It wraps the plain public API for Effect users:
     `Data.TaggedError("MemorySqlError")` carrying `{ op, cause }`, a
     `MemorySql` `Context.Tag` service with a scoped `layer(opts)` (store
     lifecycle via `Effect.acquireRelease`), and `Effect.tryPromise` wrappers
     for the async API (`synth`, `runCq`, `runSim`, `openStore` families).
     Keep it ~100–180 LOC.
   - `effect` is a **peerDependency with `peerDependenciesMeta.optional=true`**
     on the core (root devDependency so tests can exercise the adapter). The
     main entry (`memory-sql`) must be importable and fully functional with
     `effect` absent.
   - **Executable isolation gate**: a test (`tests/src/isolation.test.ts`)
     walks every `.ts` file in `packages/core/src`, `examples/src`, `tests/src`
     and asserts nothing imports `effect` (or `@effect/*`) except
     `packages/core/src/effect.ts`, the one example that demos the adapter,
     and the adapter's own test. The gate fails the build on violation.
3. **No Python anywhere** (standing rule). TypeScript 6.x strict, ESM only,
   Node >= 22. Plain `async/await` and small `Error` subclasses are now the
   idiom for the core (the "no bare async" rule from v1 applied to
   Effect-style code and is retired with it).

## What must NOT change (behavior parity contract)

- **Data**: `packages/core/fhir-data/top50.json` stays byte-identical (50
  resources, 536 attributes, 261 relations). `scripts/fetch-fhir.ts` stays.
- **Semantics**: ontology model (entity types/attributes/relations, flattening
  rules); DDL mapping; deterministic synth (same seed ⇒ identical world —
  regeneration parity with v1 is NOT required, but internal determinism is);
  adjudication of the 13 CQ templates; four-way verdict rules
  (`match | missing | divergent | unsupported-citation`, incl. the mechanical
  citation-support check); CqReport rates + per-regime breakdown; the 4
  metamorphic relations **including the v1 soundness fixes** (Stage-1
  canonicalization reused for comparison; temporal-narrowing three-sided with
  the oracle-guided bisection probe; short-period sampling); the 8 stress
  mutators + invariant set + mutator×invariant matrix; world-load boundary
  type validation (reject with pointed error, no silent DuckDB casts).
- **CLI contract**: `memory-sql synth|cq|sim` with the same flags
  (`--seed`, `--patients`, `--out`, `--world`, `--bindings`, `--mrs`) and the
  same exit-code semantics: 0 = pass; 1 = divergences/violations found, 0
  sampled bindings ("nothing graded ≠ nothing wrong"), rejected/degenerate
  world, or any expected failure — always a friendly one-line error, never a
  stack trace. Reports may be formatted more simply but must carry the same
  numbers (verdict counts, rates, per-regime rows, MR pass/fail + failing
  case, stress matrix with clean-world row).
- **Isolation of workspaces**: `packages/core` (product) / `examples/` /
  `tests/` stay separate npm workspaces; examples and tests import only
  `memory-sql` / `memory-sql/effect` by name. Both consumer workspaces declare
  their real dependencies (no phantom hoisting).
- **Tests**: the 7 v1 suites' assertions carry over against the plain API
  (ontology, store, synth, oracle, cq incl. broken-AnswerPath verdicts +
  negative controls, metamorphic incl. planted-bug-caught, stress matrix),
  plus `isolation.test.ts` (the Effect gate) and `effect-adapter.test.ts`
  (adapter wraps success + failure into Effect values correctly).
- **Examples** (3, small): `01-cq-dual-oracle.ts` (plain API),
  `02-simulation.ts` (plain API), `03-custom-answer-path.ts` (the product
  demo: flawed toy layer graded — must show all four verdicts), plus
  `04-effect-adapter.ts` demonstrating `memory-sql/effect` (the only example
  allowed to import `effect`).

## v2 target layout

```
packages/core/
  package.json          # deps: @duckdb/node-api ONLY; peerDeps: effect (optional)
                        # exports: "." -> dist/index.js, "./effect" -> dist/effect.js
                        # bin: memory-sql -> dist/cli.js
  fhir-data/top50.json  # unchanged
  src/
    index.ts            # flat public API re-exports
    ontology.ts         # model types + FHIR top50 loader (was ontology/{model,fhir}.ts)
    rng.ts              # seeded PRNG + REFERENCE_DATE + civil-date helpers (absorbs synth/date.ts)
    store.ts            # DuckDB open/close + ddl + loadWorld w/ type validation (was store/*)
    synth.ts            # deterministic world generator (was synth/generate.ts)
    oracle.ts           # SqlOracle (was oracle/sql.ts)
    cq.ts               # templates + bind + runSuite + GraphPath + verdicts (was cq/*)
    sim.ts              # metamorphic relations + runner + stress mutators/invariants/replay (was sim/*)
    cli.ts              # node:util parseArgs, plain async main
    effect.ts           # THE ONLY EFFECT FILE (subpath export memory-sql/effect)
examples/src/01..04     # as above
tests/src/*.test.ts     # 9 suites (7 carried + isolation + effect-adapter)
scripts/fetch-fhir.ts   # unchanged (plain TS already ok; must not import effect)
```

`cq.ts` and `sim.ts` may each go up to ~450 LOC; if one would exceed it,
splitting into two files is allowed but the ≤10-file core budget holds.

## Plain-core API shape (guidance, implementer refines)

```ts
// errors
class MemorySqlError extends Error { op: string; }           // one class, op-tagged
// store
openStore(opts?: { path?: string }): Promise<Store>          // Store { query, run, close }
ddl(ontology): string[]; loadWorld(store, ontology, world): Promise<void>
// ontology / synth
loadFhirOntology(): Ontology; generateWorld(ontology, { seed, patients }): InstanceWorld
// stage 1
bindTemplates(templates, world, rng, n): CqBinding[]
runCq(store, world, bindings, path: AnswerPath): Promise<CqReport>
GraphPath: AnswerPath                                        // reference implementation
interface AnswerPath { name: string; answer(b: CqBinding): Promise<Answer> }
// stage 2
runMetamorphic(store, world, opts): Promise<MrReport>
runStress(ontology, { seed }): Promise<StressReport>         // builds worlds + replays invariants
```

AnswerPath moving from Effect to `Promise` is the one deliberate public-surface
change — document it in the README migration note.

## README v2 requirements

Update to match: minimal-core pitch ("one runtime dependency"), plain-API
quickstart, the Effect section — *"Effect users: everything is wrapped in
`memory-sql/effect`; the core never imports Effect (enforced by a test)"* —
with an honest note on what was traded for minimalism (no shrinking in MR
counterexamples; no CLI framework), the AnswerPath-is-a-Promise migration
note, and unchanged sections for FHIR derivation, stages, exit codes.

## Acceptance (integrator + my verification)

- `npm run typecheck` clean (3 workspaces); `npm test` green (all 9 suites —
  run the suite via `npm test` or `vitest run` from inside `tests/`, where
  vitest.config.ts carries the required 120s testTimeout; a bare
  `npx vitest run` from the repo root misses it and times out the two slow
  stress suites); isolation gate passes; core `package.json` has exactly one
  runtime dependency; `npm ls effect --workspace packages/core` shows no hard
  dep.
- CLI parity: `synth --seed 42 --patients 20` (50 entity types, deterministic
  across reruns), `cq --seed 42 --bindings 40` → 40/40 match exit 0,
  `sim --seed 42 --mrs 100` → 4/4 relations + exact stress matrix exit 0,
  degenerate-world (`{"Patient": []}`) → exit 1, type-poisoned world → pointed
  load error exit 1. Example 03 shows all four verdicts; example 04 runs the
  adapter.
- LOC report: `wc -l` per core file + total, printed in the final summary
  (target ≤ ~2,000; hard explain if over).
```
