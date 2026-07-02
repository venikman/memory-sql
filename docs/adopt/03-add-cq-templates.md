# 03 — Add domain competency questions (CqTemplates)

Goal: your domain's questions become executable, parametrized templates whose
SQL **is** the ground truth. The shipped FHIR suite
(`fhirCqTemplates`, 13 templates in `packages/core/src/cq.ts`) is the
reference implementation; the wiki-index harness
(`wiki-index/harness/src/templates.ts`, 14 templates ported from a
pre-existing eval set) is the reference adoption.

## 1. Template anatomy (copied from `packages/core/src/cq.ts`)

```ts
export interface CqTemplate {
  readonly id: string
  readonly regime: CqRegime            // "point-lookup" | "cross-entity" | "aggregate" | "temporal" | "negative-control"
  readonly expectedKind: AnswerKind    // "set" | "scalar" | "boolean"
  readonly resultEntityType: string    // types supporting rows when SQL has no entity_type column
  readonly params: ReadonlyArray<ParamSpec>
  readonly text: (binding: CqBinding) => string   // the natural-language question
  readonly sql: (binding: CqBinding) => string    // THE GROUND TRUTH
  readonly graph: (graph: GraphView, binding: CqBinding) => ReadonlyArray<SupportRow>
}

export type ParamSpec =
  | { readonly name: string; readonly kind: "entity-id"; readonly entityType: string }
  | { readonly name: string; readonly kind: "attribute-value"; readonly entityType: string; readonly attribute: string }
  | { readonly name: string; readonly kind: "date"; readonly min?: string; readonly max?: string }
  | { readonly name: string; readonly kind: "period"; readonly min?: string; readonly max?: string }
```

### The oracle SQL support-set convention (from `packages/core/src/oracle.ts`)

Whatever SQL a template ships IS the ground truth; the oracle is thin. The
result set must surface the **supporting rows**, so citations are auditable:

- required `id` column — citations come from here; a NULL id supports nothing;
- optional `entity_type` column — tags rows in cross-entity result sets
  (otherwise `resultEntityType` types every row);
- `value` column — **required for `scalar` templates**: one row per
  contributing instance with its numeric contribution; the oracle SUMS
  contributions (`SELECT id, 1 AS value FROM …` makes a count; per-row cents
  make a total). This keeps aggregates citable.

`kind` folding (`answerFromSupport`): set → sorted unique ids; scalar → sum
(0 when empty); boolean → "at least one supporting row exists".

### Template correctness rules (from the `cq.ts` header — these bite)

- SQL and graph plans MUST share NULL semantics: a SQL predicate drops NULLs,
  so graph filters must require presence before comparing.
- Multi-target relations filter on BOTH `<rel>_ref` AND `<rel>_ref_type`.
- Temporal predicates are plain ISO TEXT comparison; `REFERENCE_DATE`
  (`"2026-01-01"`) is "today" — never the wall clock.
- Scalar templates select each contributing row exactly once.
- Always build literals with `sqlLiteral(…)` (exported) — never hand-quote.
- `graph` plans: only needed if you run the reference `makeGraphPath` or the
  shipped metamorphic relations over your templates. The harness grades
  external paths only, so its stubs throw with a pointed message
  (`noGraphPlan` in `wiki-index/harness/src/templates.ts`) — acceptable, but
  then never hand those templates to `makeGraphPath`.

## 2. Regimes — cover all five

Each regime stresses a different retrieval competency; `runCq` reports a
per-regime breakdown. Shipped FHIR spread: 3 point-lookup, 4 cross-entity,
2 aggregate, 2 temporal, 2 negative-control. If your eval set has a regime
memory-sql lacks, map it and record the original — the harness maps its
`needle` regime to `point-lookup` and keeps `sourceRegime` on an extended
template interface (`WikiCqTemplate extends CqTemplate`).

**Negative controls are mandatory.** A question whose true answer is provably
empty is your fabrication detector — anything non-empty is a hallucination.
Two patterns from the shipped suite: a code the generator can never emit
(`NONEXISTENT_CODE = "code-999"`), and a temporal impossibility (encounters
starting after `REFERENCE_DATE`). Harness example (N2): glaucoma appears
nowhere in the cohort, so the only correct answer is `[]`.

## 3. Ground-truth SQL discipline — THE RULE

**Never fudge SQL to match an expected answer.** The workflow is:

1. Write the SQL that honestly answers the question over the schema.
2. Pin the expected answer (from your existing gold data / eval docs) in a
   test that runs the oracle and compares (see acceptance below).
3. If they disagree, investigate. Either the pin is stale (fix the pin, cite
   why) or the SQL is wrong (fix the SQL). Both fixes must be explainable
   from the data alone.
4. **If the ground truth is not SQL-reproducible at all, mark the template
   skipped — never bend it.** The harness mechanism (copy it):

   ```ts
   /** Reason this template is excluded from grading (ground truth not SQL-reproducible). */
   readonly skipped?: string
   // …
   export const skippedWikiTemplates = wikiCqTemplates.filter((t) => t.skipped !== undefined)
   export const activeWikiTemplates  = wikiCqTemplates.filter((t) => t.skipped === undefined)
   ```

   Skipped templates are excluded from grading AND printed by the runner so
   they are never silently green (`run.ts` prints
   `skipped templates (ground truth not SQL-reproducible — see README)`).

Legitimate pinning vs fudging, from the harness:

- **Pinning**: T2's reproductive-procedure whitelist
  (`T2_REPRODUCTIVE_PROCEDURES`) transcribes the categories the ground-truth
  document itself enumerates — the ground truth defines what counts; the SQL
  encodes that definition. Documented in the template's `note`.
- **Pinning**: A2 fixes `AGE_REFERENCE_DATE = "2026-06-11"` (the date the
  ground truth was compiled) because ages drift with "today" — determinism
  demands a fixed reference, and the constant is named and explained.
- **Fudging (forbidden)**: adding `AND id != 'row-x'` because one row makes
  the count off by one; widening a LIKE until the set matches; `LIMIT`ing to
  the expected cardinality.

Domain gotchas the harness documents (steal the conventions):

- Multi-part prose questions grade ONE canonical answer; the remaining pinned
  parts live in exported `auxSql` queries asserted by the test, so every
  number still comes from SQL over the same store (A2 grades the oldest
  patient; decade counts are `auxSql.a2DecadeCounts`).
- Timestamps with DST-varying offsets: compare `substr(ts, 1, 10)` civil-date
  prefixes, never full strings.
- Scope filters matter: harness clinical tables hold 100 patients, the eval
  cohort is 30 — every cohort question filters
  `patient_ref IN (SELECT patient_ref FROM cohort30)`.

> **STOP AND REPORT IF** a pinned expected answer and your honest SQL cannot
> be reconciled from the data. That is a finding about the gold data, not a
> reason to adjust the SQL until the diff disappears. Report the template id,
> the pin, the SQL result, and the rows that explain the difference.

## 4. Binding / parametrization

Two strategies, both real:

- **Monte-Carlo** (shipped): `bindTemplates(templates, world, makeRng(seed), n)`
  cycles templates round-robin and draws every parameter from the ACTUAL
  world (real ids via `"entity-id"`, frequency-weighted real values via
  `"attribute-value"`, seeded dates/periods). A template whose params cannot
  be sampled is skipped — the report then shows it as a 0-binding row (see
  playbook 04's trap).
- **Deterministic enumeration** (harness): fixed question sets need no rng —
  one binding per template; named subjects resolve to ids at bind time:

  ```ts
  export const bindWikiTemplates = (world, templates = activeWikiTemplates) =>
    templates.map((template) => ({
      template,
      params: template.subject === undefined ? {} :
        { patient: resolvePatientId(world, template.subject.given, template.subject.family) }
    }))
  ```

  `resolvePatientId` throws unless EXACTLY one row matches — ambiguity is a
  config error, not a shrug.

Inside plan functions read params with `paramString(binding, name)` /
`paramPeriod(binding, name)` — they throw a pointed `MemorySqlError` on
missing/mistyped params (template-configuration bugs).

## 5. When the numeric-scalar contract does not fit

The SQL oracle's scalar answers are numeric sums. If a question's answer is a
string (a date, a name), extend at the **oracle** seam — `runCq` accepts
`opts.oracle` — never by weakening the core. The harness pattern
(`makeWikiOracle` in `templates.ts`): templates flagged `scalarText: true`
SELECT `id` + `scalar_text`; the wrapper answers them with the single
distinct `scalar_text` value (null when no rows; >1 distinct values throws —
a template bug), citing the id rows, and delegates everything else to
`makeSqlOracle(store)`. Then always pass that oracle to `runCq`.

## Acceptance — pin ground truth, then self-check the plumbing

**(a) Template test pinning ground truth** (pattern:
`wiki-index/harness/test/templates.test.ts`). One vitest file that loads the
real store once, runs the oracle per template, and compares to hand-pinned
constants through honest mappings (row ids → display strings / slugs / dates;
normalize order only). The oracle seam (from `packages/core/src/oracle.ts`;
both exports flat from `"memory-sql"`):

```ts
export interface Oracle { readonly answer: (binding: CqBinding) => Promise<Answer> }
// makeSqlOracle(store: Store): Oracle — answers by running each template's own SQL

const oracle = makeSqlOracle(store)
const answerOf = (id: string) =>
  oracle.answer({ template: myTemplates.find((t) => t.id === id)!, params: {} })
  // bare binding — fill params for parametrized templates
```

```ts
const P2_DATE = "2019-09-30"   // hand-copied from the ground-truth doc, with provenance

it("P2: Helena Willms' bilateral tubal ligation date (scalar ISO string)", async () => {
  const answer = await answerOf("P2")
  expect(answer.kind).toBe("scalar")
  expect(answer.value).toBe(P2_DATE)
})
```

Also pin: the skipped list (`expect(skippedWikiTemplates).toEqual([])` or the
documented reasons), one-binding-per-template, aux queries for multi-part
questions, and that every oracle citation resolves to a real row.

```sh
npx vitest run test/templates.test.ts
```

Expected: every pin green; a red pin means step-3 investigation, not SQL
adjustment.

**(b) sql-baseline-style self-check** (pattern:
`wiki-index/harness/src/paths/sql-baseline.ts` + `test/baseline.test.ts`).
Build an AnswerPath that answers each binding by executing the template's own
oracle SQL and re-folding it with the public helpers (`answerFromSupport`,
`canonicalCitations`); grade it with `runCq`. This proves store + templates +
bindings + oracle + verdict plumbing end to end with zero LLM involvement —
anything below 100% match is YOUR wiring, deterministically reproducible.

```sh
npx tsx src/run.ts --path sql-baseline; echo "exit=$?"
```

Expected (harness, real output — yours differs only in ids/counts):

```
cq: path "sql-baseline" vs SQL oracle — 14 bindings over 14 templates
  match 14  missing 0  divergent 0  unsupported-citation 0
  answerable 100.0%  agreement 100.0%  citations-resolve 100.0%
  ...
  bindings/template: P1=1  P2=1  P3=1  C1=1  C2=1  C3=1  A1=1  A2=1  A3=1  T1=1  T2=1  T3=1  N1=1  N2=1
...
exit=0
```

Both (a) and (b) green = the suite is trustworthy; only now wire the real
answer layer (playbook 01) and interpret its verdicts (playbook 04).
