# memory-sql — SPEC v3 (memory-only)

**memory-sql** is an ontology-backed SQL memory layer with built-in validation:
a FHIR-R4-derived ontology (top 50 resources) over DuckDB and a pluggable
**AnswerPath** graded against a deterministic **SQL oracle** by the CQ
dual-oracle engine.

## Mandates

1. **Keep the product small.**
   - Runtime dependencies of the core: exactly one, `@duckdb/node-api`.
   - Public API: one flat `index.ts`, no required deep import paths.
   - CLI uses `node:util` `parseArgs`; no CLI framework.
   - Core stays plain TypeScript and `async/await`.
2. **Keep Effect isolated.**
   - Exactly one file may import `effect`: `packages/core/src/effect.ts`,
     published as `memory-sql/effect`.
   - `effect` remains an optional peer dependency for the core package.
   - `tests/src/isolation.test.ts` enforces the import allowlist.
3. **Keep the harness honest.**
   - Do not weaken oracle SQL, verdict logic, canonicalization, or tests to
     make an integration pass.
   - `0` sampled bindings is a failure, not a clean pass.
   - Expected failures use `MemorySqlError { op }` and one-line CLI output.

## Behavior Contract

- **Data**: `packages/core/fhir-data/top50.json` stays committed and offline.
- **Ontology/store**: entity types, attributes, relations, DDL mapping, and
  `loadWorld` type validation remain generic over any supplied `Ontology`.
- **Synthesis**: `generateWorld` remains deterministic for a given ontology,
  seed, and patient count.
- **CQ validation**: the 13 shipped FHIR templates, SQL oracle,
  `AnswerPath`, `GraphPath`, four-way verdicts, report rates, and per-regime
  breakdown remain the validation surface.
- **CLI**: `memory-sql synth|cq` remain the supported commands. Exit code `0`
  means pass; `1` means a divergence, an empty suite, a rejected/degenerate
  world, or another expected failure.
- **Workspaces**: `packages/core`, `examples`, and `tests` stay separate npm
  workspaces. Examples and tests import only `memory-sql` or
  `memory-sql/effect` by package name.

## Target Layout

```text
packages/core/
  package.json          # deps: @duckdb/node-api; peerDeps: effect (optional)
  fhir-data/top50.json  # committed ontology data
  src/
    index.ts            # flat public API re-exports
    ontology.ts         # model types + FHIR top50 loader
    rng.ts              # seeded PRNG + REFERENCE_DATE + civil-date helpers
    store.ts            # DuckDB open/close + DDL + loadWorld validation
    synth.ts            # deterministic world generator
    oracle.ts           # SQL oracle
    cq.ts               # templates + binding + GraphPath + verdicts
    cli.ts              # synth and cq commands
    effect.ts           # the only Effect file
examples/src/
  01-cq-dual-oracle.ts
  03-custom-answer-path.ts
  04-effect-adapter.ts
tests/src/*.test.ts
scripts/fetch-fhir.ts
```

## Acceptance

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run example:01`, `npm run example:03`, and `npm run example:04` run.
- CLI smoke checks pass:
  - `node packages/core/dist/cli.js synth --seed 42 --patients 20 --out world.json`
  - `node packages/core/dist/cli.js cq --seed 42 --bindings 40`
- The package surface stays focused on memory, ontology, store, synthesis,
  oracle, CQ validation, CLI, and the optional Effect adapter.
