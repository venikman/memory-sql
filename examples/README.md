# memory-sql examples

Three runnable walkthroughs of the product surface. Each script imports **only
the published `memory-sql` package by name** (`04` additionally imports
`memory-sql/effect` — it is the ONLY example allowed to import `effect`, per
the isolation gate) — never relative paths into `packages/core/src` — so they
exercise exactly what a downstream consumer gets. They run with `tsx` against
the **built** core; the root scripts build first.

From the repository root:

```sh
npm run example:01   # CQ dual-oracle on the clean world
npm run example:03   # plug YOUR OWN memory layer in as an AnswerPath
npm run example:04   # the Effect adapter: memory-sql/effect
```

Everything is deterministic: fixed seeds, fixed `REFERENCE_DATE`, no wall
clock. Running an example twice prints byte-identical reports.

## 01 — CQ dual-oracle (`src/01-cq-dual-oracle.ts`)

The CQ pipeline end to end:

1. Load the FHIR-derived ontology (50 entity types) and generate a seeded,
   referentially consistent `InstanceWorld`.
2. Load the world into DuckDB (one table per entity type).
3. Monte-Carlo bind the shipped competency-question templates against real ids
   from the world.
4. Answer every binding twice — the deterministic **SQL oracle** (ground
   truth) and the reference **GraphPath** (typed traversal of the in-memory
   world) — and print the `CqReport`: per-verdict counts, agreement rate,
   citation-resolution rate, per-regime breakdown.

On the clean world the two sides must agree on every binding; the script exits
non-zero if any verdict is not `match`. That agreement is itself the first
validation result: two independent implementations, one answer.

## 03 — Custom AnswerPath (`src/03-custom-answer-path.ts`)

**The product demo.** `AnswerPath` is the plug-in surface: anything that can
answer a bound competency question — an LLM, a RAG stack, a wiki agent, a
graph store — can be graded against the SQL ground truth.

This script implements `NotesPath`, a deliberately imperfect "notes file"
memory layer: a flat text digest per patient (the kind of memory an LLM agent
might keep), answered by naive lookups. It is wrong in ways real memory
layers are wrong:

- **truncated charts** → a value the oracle disagrees with → `divergent`
- **fabricated provenance** → a right answer citing a row that does not
  support it (or does not exist) → `unsupported-citation`
- **missing notes** → no answer where the oracle has one → `missing`
- everything it did write down correctly → `match`

The point of the example: you never told memory-sql *how* NotesPath works.
You handed it an `answer(binding)` function; the dual-oracle engine generated
the questions, computed ground truth in SQL, and told you exactly where — and
how — your memory layer is wrong. Swap `NotesPath` for your own layer and the
same report grades it.

## 04 — Effect adapter (`src/04-effect-adapter.ts`)

The optional `memory-sql/effect` subpath for Effect users: the scoped
`MemorySql` layer (store opened via `Effect.acquireRelease`, closed on scope
exit), the wrapped API (`generateWorld`, `runCq`, …) with failures surfacing
as the tagged `MemorySqlError { op, cause }` on the typed error channel, and
`answerPath` adapting an Effect-based answerer to the plain `AnswerPath`.
It also demonstrates failure wrapping: loading a type-poisoned world is
caught as a tagged error, not a defect. The plain core never imports Effect —
this example (with the adapter and its test) is allowlisted by the isolation
gate in `tests/src/isolation.test.ts`.

## Notes

- The examples resolve `memory-sql` via the workspace (`file:../packages/core`)
  and its `exports` map, i.e. `dist/`. If you edit core sources, rerun the
  root `npm run example:NN` scripts (they rebuild) rather than invoking `tsx`
  directly.
- The CLI exercises the same code paths:
  `node packages/core/dist/cli.js synth --seed 42 --patients 20 --out world.json`,
  `... cq --seed 42 [--world world.json] [-n 50]`
  (or `npx memory-sql ...` once the package is installed).
