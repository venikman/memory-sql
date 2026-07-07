# AGENTS.md — standing contract for agents working in memory-sql

## What this is

memory-sql is an ontology-backed SQL memory layer with built-in validation.
It derives a typed ontology (shipped: FHIR R4 top-50 resources,
`packages/core/fhir-data/top50.json`), generates deterministic instance worlds
into DuckDB, and grades *any* answer/memory/retrieval layer against a
deterministic **SQL oracle**: the CQ runner executes parametrized competency questions
through both the oracle and a pluggable `AnswerPath` and issues a four-way
verdict per question. Same seed → same world → same report, byte-for-byte.
No LLM judge anywhere.

The core is deliberately minimal: nine flat files in `packages/core/src`,
one runtime dependency (`@duckdb/node-api`), plain `async/await`, one error
class (`MemorySqlError { op }`), one public entry (`memory-sql`). Effect is an
optional adapter behind `memory-sql/effect`. Workspaces: `packages/core` is
the product; `examples/` and `tests/` consume it by package name only.

## Commands that matter

```sh
npm install          # all three workspaces
npm run build        # tsc: packages/core/src -> dist/ (examples/tests import dist)
npm test             # builds, then runs the vitest suite in tests/
                     # expected tail: "Test Files  7 passed (7)" — always run via
                     # npm test; bare `npx vitest run` from the repo root misses
                     # tests/vitest.config.ts (120s testTimeout) and can time out
npm run typecheck    # tsc --noEmit across workspaces + scripts/
```

CLI (dev: `npx tsx packages/core/src/cli.ts …`; built: `node packages/core/dist/cli.js …`):

```sh
node packages/core/dist/cli.js synth --seed 42 --patients 20 --out world.json
# synth: 832 rows across 50 entity types (seed 42, 20 patients) -> world.json
node packages/core/dist/cli.js cq --seed 42 --bindings 40
# …report…
# cq: PASS — the two oracles agree on every binding        (exit 0)
```

Exit codes are CI-gate semantics: `0` = pass; `1` on any non-`match` verdict,
**0 sampled bindings** ("nothing graded is not nothing wrong"), a
rejected/degenerate world, or any expected failure — always a one-line error,
never a stack trace.

## The four-way verdict

| verdict | meaning |
| --- | --- |
| `match` | values equal AND every path citation resolves into the oracle's support set |
| `missing` | the path returned nothing (empty set / null scalar) or its `answer()` rejected, where the oracle has an answer |
| `divergent` | the path answered, but the value differs from the oracle's |
| `unsupported-citation` | right value, but a cited row does not support it (fabricated provenance) |

Verdict rules live in `packages/core/src/cq.ts` (`computeVerdict`); the shared
canonicalization in `oracle.ts` (`answerFromSupport`, `canonicalCitations`).

## THE PRIME DIRECTIVE — the harness is the judge

**An agent must NEVER modify oracle SQL, verdict logic (`computeVerdict`,
`answerValuesEqual`, `isEmptyAnswer`), canonicalization (`canonicalizeAnswer`,
`answerFromSupport`, `canonicalCitations`, `stableKey`), or tests to make its
own integration pass.**

- If the harness flags your layer (`divergent`, `missing`,
  `unsupported-citation`), **your layer is wrong**. Fix the layer, not the
  referee.
- Template SQL *is* the ground truth. If a question's ground truth cannot be
  reproduced honestly by SQL, mark the template skipped with a reason — never
  bend the SQL toward an expected answer (see `docs/adopt/03-add-cq-templates.md`).
- If you genuinely believe the oracle or a verdict rule is
  wrong: **STOP and report** the exact template id / rule, the binding, both
  answers, and why you think ground truth is off. Do not patch it. Do not
  weaken a test. A green suite obtained by editing the judge is worthless and
  poisons every downstream comparison.

## Effect isolation (enforced)

Exactly ONE file may import `effect`: `packages/core/src/effect.ts` (the
`memory-sql/effect` adapter). `tests/src/isolation.test.ts` walks every `.ts`
source in `packages/core/src`, `examples/src`, `tests/src`, and `scripts/` and
fails the build if anything outside the allowlist (the adapter,
`examples/src/04-effect-adapter.ts`, `tests/src/effect-adapter.test.ts`)
imports `effect` or `@effect/*`. Never add Effect to the core; never extend
the allowlist to sneak it in. `effect` stays an optional peer dependency.

## Citation shape gotcha

Citations are `{ entityType: string; id: string }` **objects**, never bare id
strings. The citation audit is set-membership against the oracle's support
rows, so a bare `"condition-006"` never resolves and an otherwise-correct
answer grades `unsupported-citation`. TypeScript catches this; from plain JS,
mind the shape.

```ts
citations: [{ entityType: "Condition", id: "condition-006" }]   // right
citations: ["condition-006"]                                     // wrong — never resolves
```

## Playbooks

Task-specific step-by-step guides with acceptance commands live in
`docs/adopt/` — start at `docs/adopt/README.md`:

1. `01-wire-answerpath.md` — plug your LLM/RAG/wiki/API layer in as an `AnswerPath`
2. `02-custom-ontology.md` — replace the FHIR ontology with your own schema
3. `03-add-cq-templates.md` — add domain competency questions
4. `04-interpret-verdicts.md` — read reports, gate CI

A completed real-world adoption (custom ontology from a live DuckDB, 14 CQ
templates, two AnswerPaths) lives at `wiki-index/harness/` and is quoted
throughout the playbooks.

## Branches

- `main` — TypeScript (this branch). Build step: `tsc` → `dist/`.
- `js` — plain ESM JavaScript, no TypeScript, no build step (`node` runs
  `packages/core/src/` directly). **The public API is identical**; only
  compile-time checking differs. Do not port changes between branches
  half-way: a behavior change lands on both or neither.
