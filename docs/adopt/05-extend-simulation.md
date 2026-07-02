# 05 — Extend the simulation: metamorphic relations, mutators, invariants

Goal: add label-free checks for your domain. Stage 2 has two engines
(`packages/core/src/sim.ts`, `sim-stress.ts`): **metamorphic relations**
(how must an answer change — or not — under a known transformation; zero gold
labels needed) and the **adversarial stress matrix** (plant a named defect,
demand a named invariant convicts it).

## 1. The MR contract (copied from `packages/core/src/sim.ts`)

```ts
export interface MetamorphicRelation {
  readonly id: string
  readonly describe: string
  readonly expect: MrExpectation                      // "equal" | "subset" | "unchanged-answer"
  readonly sourceEvaluator?: MrEvaluator              // "path" | "oracle" (default "path")
  readonly followupEvaluator?: MrEvaluator
  readonly applicable?: (binding: CqBinding) => boolean
  readonly transform?: (source: MrCase, rng: Rng) => MrFollowup | null   // declarative form
  readonly check?: (harness: MrHarness, binding: CqBinding, rng: Rng) => Promise<MrOutcome>  // escape hatch
}
```

Rules the runner enforces (do not fight them):

- Declarative relations provide `transform`; the pipeline compares source vs
  follow-up under `expect`. **A world-transforming follow-up MUST use the
  `"path"` evaluator** — the SQL oracle answers over the loaded source world,
  and `evaluate()` throws `relation misconfiguration` if you point the oracle
  at a transformed world. The runner rebuilds the path over the transformed
  world via `makePath` (an `MrHarness` field), so your `makePath` must be a
  real constructor, not a closure over one fixed world.
- Relations that do not fit provide `check` and own their comparison,
  returning `MrOutcome { holds, skipped, detail }` — `skipped: true` means
  "inapplicable at check time", which is counted, not hidden.
- Comparison goes through Stage 1's OWN canonicalization
  (`canonicalizeAnswer` + `answerValuesEqual`) — the sim grades exactly as
  strictly as `computeVerdict`. `"subset"` is kind-aware: sets by inclusion,
  numeric scalars monotonically, booleans by implication.
- Sampling is seeded per relation (`seed ^ fnv1a(relation.id)`, list-order
  independent); a failure reports the FIRST failing case with `bindingIndex`
  + `caseSeed`, fully replayable. No shrinking (documented v2 trade-off).
- 0 applicable bindings = an **explicit vacuous pass** in the report
  (`PASS <id> (vacuous: no applicable bindings)`) — treat it like the
  0-bindings trap of playbook 04: visible, and yours to fix.

Run via `runMetamorphic(store, world, { ontology, bindings, seed, makePath?,
oracle?, relations?, runsPerRelation? })`; pass
`relations: [...metamorphicRelations, myRelation]` to extend the shipped set.

## 2. The vacuous-relation warning — the temporal-narrowing lesson

**A relation that can never fail is worse than no relation**: it reads as
green coverage while checking nothing. The shipped `temporal-narrowing` MR is
the cautionary tale, preserved in its own doc comment (`sim.ts`, MR 2):
"narrowing a period can only shrink the result" as a bare `subset` check is
**one-sided** — an under-returning path (one that returns nothing, or drops
rows on narrow windows) passes trivially, forever. And checking equality on a
randomly narrowed window barely helps: random short windows are usually
EMPTY, so short-span blindness is caught "only by luck".

The shipped fix is three-sided — copy the structure when your own relation
has a degenerate passing mode:

1. **subset** — narrow path answer inside the oracle's WIDE truth (catches
   over-returning: ignored/botched temporal filters);
2. **equal** — narrow path answer equals the oracle's NARROW truth (catches
   under-returning on the drawn window);
3. **probe** — bisect the wide period, following the half the ORACLE says
   still contains support, down to a `<= PROBE_MAX_SPAN_DAYS` (7-day) window
   that PROVABLY contains support — and demand exact match there.

Checklist for every new relation, before you ship it:

- Name the failure it detects. If you cannot, it detects nothing.
- Write the planted-bug test: run the relation against a deliberately broken
  `makePath` (e.g. one that drops the last row of every set answer) and
  assert `passed === false` with a counterexample. The shipped suites do this
  (`tests/src/metamorphic.test.ts`, "planted-bug-caught").
- Check the pass is not vacuous: `applicableBindings > 0` and `runs > 0` in
  the result.

## 3. Mutators × invariants (copied from `packages/core/src/sim-stress.ts`)

```ts
export interface StressMutator {
  readonly id: string
  readonly describe: string
  readonly expectedInvariants: readonly string[]   // ALL must fire for the run to be "ok"
  readonly mutate: (ontology: Ontology, world: InstanceWorld, rng: Rng) => MutationResult | null
}
// MutationResult = { world: InstanceWorld; note: string } — mutators are PURE (input world untouched)

export type Invariant = WorldInvariant | SqlInvariant

export interface WorldInvariant {      // pure check over the in-memory world; runs BEFORE load
  readonly id: string
  readonly describe: string
  readonly kind: "world"
  readonly check: (ontology: Ontology, world: InstanceWorld) => readonly InvariantViolation[]
}
export interface SqlInvariant {        // executed as SQL over the loaded world
  readonly id: string
  readonly describe: string
  readonly kind: "sql"
  readonly check: (store: Store, ontology: Ontology) => Promise<readonly InvariantViolation[]>
}
export interface InvariantViolation { readonly invariantId: string; readonly entityType: string; readonly rowId: string | null; readonly detail: string }
```

### The matrix discipline — both directions, always

`runStress(ontology, { seed, world?, store?, mutators?, invariants? })`
replays the clean world, then each mutated world, and the contract only
proves anything if BOTH directions hold (this is `tests/src/stress.test.ts`'s
opening argument):

- **the clean world replays with ZERO violations** — a violation there means
  your generator/loader or an invariant is lying (false alarms);
- **every mutator trips its named invariant(s)** — a defect class that stops
  firing means the validation layer itself regressed (blind spots).

Design rules learned from the shipped eight mutators:

- **One mutator = exactly one named defect.** The shipped `reversed-period`
  writes constants that break ONLY ordering (dates carry no other invariant);
  `self-reference` is the separation case — the ref resolves (to the row
  itself), so `referential-integrity` stays green and only
  `no-self-reference` can convict. If your mutator trips three invariants you
  did not name, it plants three defects, and the matrix stops localizing.
- **`mutate` returns `null`** when the ontology/world offers no applicable
  target — reported as `n/a`, and `report.passed` goes false (an inapplicable
  mutator is a coverage hole, not a pass).
- **The duplicate-id asymmetry**: `id` is a real PRIMARY KEY, so a
  duplicate-id world cannot even load. World-kind invariants run BEFORE the
  load; on a load failure SQL invariants are marked skipped (`x` in the
  matrix), never silently green.
- The first six shipped invariants are **ontology-generic** and reusable over
  any custom ontology: `referential-integrity`, `required-present`,
  `value-set-membership`, `period-ordering` (any `<f>_start`/`<f>_end`
  date-typed pair), `unique-ids`, `no-self-reference`. The other three are
  FHIR-configured and check vacuously elsewhere. Add domain chains with the
  `joinConsistencyInvariant`-style pattern (child.via must reach a parent
  agreeing on a key).

> **STOP AND REPORT IF** a mutator's expected invariant stays silent (`*0` in
> the matrix) or the clean world shows violations, and the change you are
> considering is weakening the invariant, widening `expectedInvariants`, or
> "cleaning" the clean world by deleting the offending rows. Both directions
> of the matrix are the product. Report the matrix row, the mutation note,
> and the violations (or their absence).

## Acceptance — the matrix test

Self-contained runner (verified; swap in your ontology/world/mutators). Save
as `stress-matrix.ts` in the playbook-01 scratch project. It reuses the
playbook-02 `Account`/`SupportTicket` ontology — paste that `ontology` const
verbatim — but needs the TWO-rows-per-type clean world below (each mutator
rewrites row `[0]` and must keep row `[1]` intact; playbook 02's one-row
world would put `undefined` in the mutated array and crash), plus two
one-defect mutators:

```ts
import type { InstanceWorld, Ontology, StressMutator } from "memory-sql"
import { fhirInvariants, formatStressReport, runStress } from "memory-sql"

const cleanWorld: InstanceWorld = {
  Account: [
    { id: "acct-1", email: "a@example.com", tier: "pro" },
    { id: "acct-2", email: "b@example.com", tier: "free" }],
  SupportTicket: [
    { id: "tick-1", opened_ts: "2026-01-01T09:00:00Z", status: "open", account_ref: "acct-1" },
    { id: "tick-2", opened_ts: "2026-01-02T10:00:00Z", status: "closed", account_ref: "acct-2" }]
}

const mutators: readonly StressMutator[] = [
  { id: "dangling-account", describe: "point a ticket at an account id that does not exist",
    expectedInvariants: ["referential-integrity"],
    mutate: (_o, world) => ({
      world: { ...world, SupportTicket: [{ ...world["SupportTicket"]![0]!, account_ref: "ghost-999" }, world["SupportTicket"]![1]!] },
      note: "tick-1.account_ref -> ghost-999" }) },
  { id: "illegal-tier", describe: "set an account tier outside its value set",
    expectedInvariants: ["value-set-membership"],
    mutate: (_o, world) => ({
      world: { ...world, Account: [{ ...world["Account"]![0]!, tier: "platinum" }, world["Account"]![1]!] },
      note: "acct-1.tier -> platinum" }) }
]

const report = await runStress(ontology, { seed: 7, world: cleanWorld, mutators, invariants: fhirInvariants })
console.log(formatStressReport(report))
process.exitCode = report.passed ? 0 : 1
```

```sh
npx tsx stress-matrix.ts; echo "exit=$?"
```

Expected (real output):

```
Stress run (seed 7) — mutator x invariant matrix
  [1] referential-integrity
  ...
                   [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]  verdict
clean world          .    .    .    .    .    .    .    .    .  ok (zero violations)
dangling-account    *1    .    .    .    .    .    .    .    .  ok
illegal-tier         .    .   *1    .    .    .    .    .    .  ok

legend: *N expected invariant fired (N violations), *0 expected but silent, . zero, x skipped (world failed to load, e.g. duplicate PRIMARY KEY)
Stress contract holds: the clean world is clean and every planted defect fires its invariant.
exit=0
```

Pin it as a vitest matrix test (pattern: `tests/src/stress.test.ts`'s
`SPEC_DIAGONAL`) so regressions in either direction fail CI:

```ts
const DIAGONAL: ReadonlyArray<readonly [string, string]> = [
  ["dangling-account", "referential-integrity"],
  ["illegal-tier", "value-set-membership"]
]

it("clean world is silent; every planted defect fires its named invariant", async () => {
  const report = await runStress(ontology, { seed: 7, world: cleanWorld, mutators, invariants: fhirInvariants })
  expect(report.cleanPassed).toBe(true)
  for (const [mutatorId, invariantId] of DIAGONAL) {
    const run = report.runs.find((r) => r.mutatorId === mutatorId)
    expect(run?.applied, mutatorId).toBe(true)
    expect(run?.firedInvariants, mutatorId).toContain(invariantId)
    expect(run?.expectationMet, mutatorId).toBe(true)
  }
  expect(report.passed).toBe(true)
})
```

For the shipped FHIR configuration, the same acceptance is one command:

```sh
node packages/core/dist/cli.js sim --seed 42 --mrs 100; echo "exit=$?"
# ...
# Stress contract holds: the clean world is clean and every planted defect fires its invariant.
# sim: PASS — relations hold, clean world is silent, every mutator was caught
# exit=0
```
