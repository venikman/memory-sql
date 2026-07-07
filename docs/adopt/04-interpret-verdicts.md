# 04 — Interpret verdicts, read reports, gate CI

Goal: turn a `CqReport` into a diagnosis and an exit code. All examples below
are REAL output from `npm run example:03` (the `NotesPath` demo — a
deliberately flawed notes-file memory layer graded over seed 2026), so you
can regenerate them verbatim.

## 1. The four verdicts, one real example each

Verdict logic (`computeVerdict` in `packages/core/src/cq.ts`) runs on
canonicalized answers, in this order: empty-vs-nonempty → `missing`; values
differ → `divergent`; unresolvable citation → `unsupported-citation`; else
`match`. Order matters: failing to answer is diagnostically different from
answering wrongly.

### `match` — nothing to do

Values equal after canonicalization AND every path citation resolves into the
oracle's support set. In the demo run: 39 of 60.

### `missing` — the layer has a gap (or crashed)

The path returned nothing (empty set / null scalar), or its `answer()`
promise rejected (`pathError` is set, `path` is null), where the oracle has
an answer.

```
missing: Which Coverage is active for patient-003 on 2026-01-01?
  oracle: ["coverage-003"] cites [Coverage/coverage-003]
  notes:  [] cites []
```

Failure class: **retrieval/coverage gap** — a topic that never made it into
the layer (the demo's note-taker never records insurance), an index that
does not cover the entity type, a crashed sub-process, a timeout. Check
`result.pathError` first to split "crashed" from "genuinely empty".

### `divergent` — the layer answers, wrongly

Values differ. Never citation-related; content is wrong.

```
divergent: Which active Conditions does patient-004 have?
  oracle: ["condition-006","condition-007"] cites [Condition/condition-006, Condition/condition-007]
  notes:  ["condition-006"] cites [Condition/condition-006]
```

Failure class: **wrong content** — truncation (the demo drops the last
condition on busy charts), stale data, off-by-one aggregation, a temporal
filter applied wrongly, a hallucinated value, or an `expectedKind` mismatch.
Also the verdict a wrong boolean gets (`false` is a claim, not an absence).

### `unsupported-citation` — right answer, fabricated provenance

Value matches, but at least one cited row does not participate in the
oracle's support set. Only the mechanical citation audit catches this class.

```
unsupported-citation: Total ExplanationOfBenefit payment (cents) for patient-002?
  oracle: 177462 cites [ExplanationOfBenefit/explanation_of_benefit-002]
  notes:  177462 cites [ExplanationOfBenefit/explanation_of_benefit-999]
```

Failure class: **provenance fabrication** — the layer knows the answer but
invents where it came from (id -999 does not exist). In practice also: bare
string citations instead of `{ entityType, id }` objects (they never
resolve), wrong `entityType` on a correct id, or citing a plausible-but-wrong
sibling row. An LLM path that cannot verify a row id must cite NOTHING (an
empty citation list on a matching value is vacuously supported) — the
wiki-index RAG path's rule: "unverifiable citations are dropped, never
fabricated".

## 2. Rates and breakdowns (`CqReport`, from `packages/core/src/cq.ts`)

| field | meaning | use |
| --- | --- | --- |
| `answerableRate` | share of bindings where the path produced a non-missing answer | capacity: can it answer at all? |
| `agreementRate` | share graded `match` — the headline dual-oracle number | the number to gate on |
| `citationResolvesRate` | share of path citations resolving into oracle support | trustworthiness of provenance |
| `byRegime` | ARRAY of per-regime rows (`regime`, `total`, per-verdict counts, `agreementRate`) | localize weakness: temporal-only failures ≠ aggregate-only failures |
| `byTemplate` | per-template binding counts over the DECLARED template list | the 0-binding trap, below |
| `results` | every graded question with both answers, `pathError`, verdict | forensics |

Vacuous-rate convention: `citationResolvesRate` with zero citations reads
`1` — nothing was wrong. Per-regime agreement tells you *which competency*
is broken; e.g. a layer green everywhere but `temporal` has a date-window
bug, not a retrieval problem.

## 3. The 0-bindings trap — "nothing graded is not nothing wrong"

Two protections exist; know both:

1. **Empty suite is an error, not a pass.** `runCq` throws
   `MemorySqlError` when the binding list is empty, and the CLI exits 1:

   ```
   $ node packages/core/dist/cli.js cq --seed 42 --world degenerate.json
   cq: FAIL — 0 bindings could be sampled from this world (empty or missing entity pools); nothing was graded
   $ echo $?
   1
   ```

2. **A silently unsampled template is made visible.** Pass your declared
   suite as `opts.templates`; every template then appears in `byTemplate`
   even with 0 bindings, and `formatCqReport` prints:

   ```
   WARNING — N of M templates produced no binding on this world and go ungraded: <ids>
   ```

   Treat that warning as red in CI: a 100% agreement rate over 3 of 14
   templates is not a pass. Assert coverage explicitly, as the harness does:

   ```ts
   expect(report.byTemplate).toHaveLength(14)
   for (const t of report.byTemplate) expect(t.bindings, t.templateId).toBe(1)
   ```

## 4. Exit-code gating recipe

The CLI already carries gate semantics (`0` pass; `1` on any non-match
verdict, 0 bindings, rejected world, or expected failure). For the shipped
FHIR suite:

```sh
node packages/core/dist/cli.js cq --seed 42 --bindings 50
```

For a custom runner, gate exactly like `wiki-index/harness/src/run.ts`:

```ts
const report = await runCq(store, world, bindings, path, { ontology, templates })
console.log(formatCqReport(report))
const clean = report.missing + report.divergent + report.unsupportedCitation === 0
process.exitCode = clean ? 0 : 1
```

CI job sketch (fails on any verdict regression, any ungraded template, any
crash — `runCq`'s own throw on 0 bindings propagates as exit 1):

```sh
set -e
npm ci && npm run build
node dist/gate.js            # the runner above; exits 1 on any non-match
```

Gate on **counts, not only rates**: `agreementRate >= 0.9` hides a new
fabrication class if `unsupported-citation` went 0 → 3 while `missing`
dropped. Minimum bar: `unsupportedCitation === 0` gates hard (fabricated
provenance is never acceptable); `missing`/`divergent` thresholds are a
product decision — record them in the gate script, not in your head.

## 5. Regenerating the examples

```sh
cd <memory-sql-repo>
npm run example:03
```

Expected (real output, deterministic — seed 2026, abridged to the headline):

```
memory-sql grading "notes-file" — 60 questions, seed 2026

verdicts:
  match                  39
  divergent              5
  unsupported-citation   10
  missing                6

agreement rate:          65.0%
citation-resolves rate:  78.7%
```

> **STOP AND REPORT IF** you are about to "fix" a verdict by changing what is
> being measured — editing template SQL, `computeVerdict`, canonicalization,
> or deleting a failing template from the suite. Verdicts are only comparable
> across runs and across layers because the judge does not move. If the judge
> looks wrong, report it (template id, binding, both answers, reasoning) and
> stop.
