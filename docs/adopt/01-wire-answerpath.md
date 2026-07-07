# 01 — Wire an existing answer layer in as an AnswerPath

Goal: your LLM / RAG stack / wiki agent / HTTP API answers memory-sql's
competency questions and gets graded against the deterministic SQL oracle
with the four-way verdict. memory-sql never learns how your layer works — it
only sees `answer(binding): Promise<Answer>`.

## Prerequisites

- Node >= 22, ESM project (`"type": "module"`).
- The `memory-sql` package importable:
  - from a local checkout: run `npm run build` in the memory-sql repo first,
    then depend on `file:<path>/memory-sql/packages/core` (this is what
    `wiki-index/harness/package.json` does), or
  - from npm: `npm install memory-sql` (current package line: `memory-sql@0.2.x`).
- Read `AGENTS.md` first. In particular: if the oracle flags your layer, your
  layer is wrong — do not touch the oracle.

## 1. The plug-in surface (copied from `packages/core/src/cq.ts`)

```ts
export interface AnswerPath {
  readonly name: string
  readonly answer: (binding: CqBinding) => Promise<Answer>
}

export type AnswerKind = "set" | "scalar" | "boolean"
export interface Citation { readonly entityType: string; readonly id: string }
export type ScalarValue = number | string | boolean | null
export type AnswerValue = ReadonlyArray<string> | ScalarValue
export interface Answer {
  readonly kind: AnswerKind
  readonly value: AnswerValue                  // "set" = row ids; others = one scalar
  readonly citations: ReadonlyArray<Citation>  // the stored rows the answer relies on
}
```

Rules that decide your verdicts:

- `kind` must equal the template's `expectedKind` — a kind mismatch is
  `divergent` (`answerValuesEqual` returns false on kind mismatch).
- **`"set"` values are row ids** (strings). You do not need to sort or dedupe:
  `runCq` canonicalizes both sides (`canonicalizeAnswer` — sorted unique ids,
  deduped sorted citations) before any comparison, so ordering never costs you
  a verdict.
- **Citations are `{ entityType, id }` objects, never bare id strings.** A
  bare string never resolves into the oracle's support set and downgrades a
  correct value to `unsupported-citation`.
- Empty answers: an empty set or a `null` scalar means "I have nothing" —
  graded `missing` when the oracle has an answer, `match` when the oracle is
  also empty (negative controls). Booleans are never "empty": a wrong `false`
  is `divergent`. A scalar `0` is a claim, not an absence.

**The async-error rule:** a rejected `answer()` promise is recorded as that
question's `pathError` and graded `missing` — it never crashes the suite
(`runCq` catches per binding; see `packages/core/src/cq.ts`, the
`try { raw = await path.answer(binding) } catch` block). So: let per-question
failures reject; reserve pre-flight checks (missing API key, dead service)
for your path's constructor so the run fails fast with one friendly line —
the pattern `wiki-index/harness/src/paths/rag.ts` uses (`RagUnavailableError`
thrown from `makeRagPath()` before grading starts, per-question crashes
rejecting from `answer()`).

## 2. What a binding gives you

`CqBinding = { template, params }`. Useful fields for an external layer:

- `binding.template.text(binding)` — the natural-language question to send to
  your layer.
- `binding.template.id`, `binding.template.regime`,
  `binding.template.expectedKind`, `binding.template.resultEntityType`.
- `paramString(binding, "patient")` / `paramPeriod(binding, "period")` —
  typed parameter access (both exported from `memory-sql`).

## 3. Worked wiring (imports are the real public surface)

```ts
import type { Answer, AnswerPath } from "memory-sql"
import {
  bindTemplates, fhirCqTemplates, formatCqReport, generateWorld,
  loadFhirOntology, makeRng, openStore, runCq
} from "memory-sql"

const myPath: AnswerPath = {
  name: "my-rag-stack",
  answer: async (binding): Promise<Answer> => {
    const question = binding.template.text(binding)
    const hit = await myRetrievalLayer.ask(question)          // <- your layer
    return {
      kind: binding.template.expectedKind,
      value: hit.rowIds,                                       // e.g. ["condition-006"]
      citations: hit.rowIds.map((id) => ({ entityType: binding.template.resultEntityType, id }))
    }
  }
}

const ontology = loadFhirOntology()                            // sync, committed JSON
const world = generateWorld(ontology, { seed: 42, patients: 20 })
const bindings = bindTemplates(fhirCqTemplates, world, makeRng(42), 40)

const store = await openStore()                                // in-memory DuckDB
try {
  const report = await runCq(store, world, bindings, myPath, { ontology })
  console.log(formatCqReport(report))
  process.exitCode = report.match === report.total ? 0 : 1
} finally {
  store.close()
}
```

Notes on `runCq(store, world, bindings, path, opts?)`:

- It loads the world itself. Pass `{ ontology }` so DDL covers ALL entity
  types (empty tables must exist — negative-control questions query them).
- `opts.oracle` substitutes ground truth (custom-oracle adoptions — see
  playbook 03); `opts.templates` makes per-template binding counts reflect
  your declared suite so an unsampled template shows as an explicit 0 row.
- It throws `MemorySqlError` on an empty binding list: nothing graded is not
  nothing wrong.
- Bindings run sequentially by design (single DB connection); do not
  parallelize inside `answer()` expecting the suite to interleave.

If your layer answers against real data instead of a generated world, replace
`generateWorld` with your own `InstanceWorld` (playbook 02) and
`fhirCqTemplates` with your own templates (playbook 03). The grading call is
identical — compare `wiki-index/harness/src/run.ts`:

```ts
const report = await runCq(store, world, graded, path, {
  ontology: wikiIndexOntology,
  oracle: makeWikiOracle(store),
  templates: activeWikiTemplates
})
```

## 4. Reading the report

`formatCqReport(report)` prints verdict counts, the three rates
(`answerable`, `agreement`, `citations-resolve`), per-regime rows, and
per-template binding counts. For per-question forensics iterate
`report.results`: each `CqResult` carries `templateId`, `question`, the
canonicalized `oracle` and `path` answers, `pathError` (when your promise
rejected), and the `verdict`. Full interpretation guide + CI gating:
[04-interpret-verdicts.md](./04-interpret-verdicts.md).

## Acceptance — scratch project recipe (runnable end to end)

```sh
# 0. build memory-sql once (skip if installing from npm)
cd <memory-sql-repo> && npm install && npm run build

# 1. scratch project
mkdir memory-sql-adoption && cd memory-sql-adoption
npm init -y && npm pkg set type=module
npm install <memory-sql-repo>/packages/core tsx typescript @types/node vitest
# vitest serves the test-file acceptance steps of playbooks 02/03/05
```

Create `grade.ts` — the snippet from step 3, with the path switchable so both
exit codes are exercised: default = `makeGraphPath(world, ontology)` (the
shipped known-good reference), `--stub` = a stub returning empty answers
(replace the stub's body with calls into YOUR layer when wiring for real):

```ts
import { makeGraphPath } from "memory-sql"   // flat-exported like everything in step 3

const stubPath: AnswerPath = {
  name: "my-layer",
  answer: async (binding): Promise<Answer> => ({
    kind: binding.template.expectedKind,
    value: binding.template.expectedKind === "set" ? [] : null,
    citations: []
  })
}
const path = process.argv.includes("--stub") ? stubPath : makeGraphPath(world, ontology)
```

Run both:

```sh
npx tsx grade.ts; echo "exit=$?"
```

Expected (exact, seed-determined):

```
cq: path "graph-path" vs SQL oracle — 40 bindings over 13 templates
  match 40  missing 0  divergent 0  unsupported-citation 0
  answerable 100.0%  agreement 100.0%  citations-resolve 100.0%
  ...
exit=0
```

```sh
npx tsx grade.ts --stub; echo "exit=$?"
```

Expected (exact, seed-determined):

```
cq: path "my-layer" vs SQL oracle — 40 bindings over 13 templates
  match 15  missing 22  divergent 3  unsupported-citation 0
  answerable 45.0%  agreement 37.5%  citations-resolve 100.0%
  ...
exit=1
```

Acceptance is met when **runCq prints a report and the exit code reflects the
verdicts** — 0 for the all-match reference path, 1 for the stub. (The stub's
15 matches are the negative controls plus bindings whose true answer is
empty; its 3 `divergent` are the boolean template's bindings — booleans are
never "empty", so a `null` non-answer to a boolean question is a wrong claim,
not an absence.)

> **STOP AND REPORT IF** your real layer's verdicts look wrong *because you
> believe the oracle is wrong* (e.g. you can show the template SQL disagrees
> with its own question text). Do not edit template SQL, `computeVerdict`, or
> canonicalization to get to green. Report the template id, the binding
> params, both answers, and your reasoning.
