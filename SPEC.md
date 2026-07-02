# memory-sql — Implementation Specification (interface contract)

**memory-sql** is a product-grade TypeScript library: an **ontology-backed SQL
memory layer with built-in validation**. The ontology is derived from the
**FHIR R4 specification (top 50 resources)**; instances live in SQL (DuckDB);
and the product ships two validation engines proven out in prior research:

- **Stage 1 — CQ dual-oracle**: parametrized competency questions answered two
  ways — a deterministic **SQL oracle** (ground truth) and a pluggable
  **AnswerPath** (any knowledge/memory/retrieval layer under test) — with
  four-way verdicts (`match | missing | divergent | unsupported-citation`).
- **Stage 2 — Simulation**: (a) **metamorphic testing** (relations that need
  zero gold labels) and (b) **adversarial instance stress** (mutate worlds,
  replay invariants — the closed-world analogue of reasoner consistency
  checking).

The product pitch: *plug your own answer layer (LLM, RAG, wiki, graph) into
`AnswerPath`; memory-sql generates the data, owns the ground truth, and tells
you where your layer is wrong.* A reference `GraphPath` implementation
(typed reference-walk over loaded instances) is included so everything runs
out of the box.

## Non-negotiables

- **TypeScript 6.x**, strict, ESM only. **No Python anywhere.** Node >= 22.
- **Effect (latest)** for all effectful code: `Effect.gen`, services via
  `Effect.Service`/`Context.Tag` + Layers, `Data.TaggedError`, `effect/Schema`
  at parse boundaries, `Config` for env, `@effect/cli` for the CLI,
  `NodeRuntime.runMain`. Pure logic (ontology model transforms, metamorphic
  relations, verdict math) stays plain synchronous functions.
- **Determinism**: no `Math.random`, no `Date.now()`/`new Date()` in
  generators, engines, or reports. One seeded PRNG module. Fixed
  `REFERENCE_DATE = "2026-01-01"` constant where a "today" is unavoidable.
- **Isolation (user-mandated)**: `packages/core` is the product; `examples/`
  and `tests/` are separate npm workspaces that import **only the published
  surface** (`memory-sql` package by name — never `../packages/core/src/...`
  relative reaches). Tests test the public API.
- **Types**: co-located per module (each module exports its own types),
  aggregated re-export from the package root `index.ts`. No global `types.ts`
  dumping ground.

## Repository layout (npm workspaces)

```
memory-sql/
  README.md                    # product README (see requirements at bottom)
  SPEC.md                      # this file
  LICENSE                      # MIT
  package.json                 # workspaces: packages/core, examples, tests; root scripts
  tsconfig.base.json           # shared strict TS6 NodeNext config
  .github/workflows/ci.yml     # Node 22: npm ci, typecheck (all ws), test
  scripts/fetch-fhir.ts        # one-time: download FHIR R4 definitions, trim to top-50, write committed JSON
  packages/core/               # THE PRODUCT — package name "memory-sql"
    package.json               # name memory-sql, exports ./dist/index.js, bin memory-sql -> dist/cli.js
    tsconfig.json
    fhir-data/top50.json       # committed trimmed StructureDefinitions (output of fetch-fhir)
    src/
      index.ts                 # public API surface (everything below re-exported)
      cli.ts                   # @effect/cli: memory-sql synth|cq|sim commands
      ontology/
        model.ts               # generic Ontology model (see contract)
        fhir.ts                # FHIR StructureDefinitions -> Ontology (top 50)
      store/
        schema.ts              # Ontology -> SQL DDL (one table per entity type)
        db.ts                  # DuckDb Effect service (scoped Layer)
        load.ts                # load InstanceWorld into the store
      synth/
        rng.ts                 # makeRng(seed): int/pick/chance/float/uuid-like
        generate.ts            # deterministic InstanceWorld generator over the Ontology
      oracle/
        sql.ts                 # SqlOracle: CQ binding -> SQL -> canonical Answer
      cq/                      # STAGE 1
        model.ts               # CqTemplate, CqBinding, Answer, Verdict (four-way), Citation
        engine.ts              # runSuite(templates, bindings, oracle, path) -> CqReport
        graph-path.ts          # reference AnswerPath: typed graph walk over the world
        templates.ts           # ~12 shipped FHIR CQ templates (see list)
      sim/                     # STAGE 2
        metamorphic.ts         # MR model + 4 shipped relations + fast-check runner
        stress.ts              # adversarial mutators + invariants + replay engine
  examples/                    # workspace "memory-sql-examples" (private)
    package.json               # depends on "memory-sql": "workspace:*" (file/workspace protocol per npm)
    src/01-cq-dual-oracle.ts   # generate world -> run CQ suite -> print report
    src/02-simulation.ts       # metamorphic run + stress run -> print reports
    src/03-custom-answer-path.ts  # THE PRODUCT DEMO: implement AnswerPath for a toy
                                  # "notes file" memory layer and watch memory-sql grade it
  tests/                       # workspace "memory-sql-tests" (private)
    package.json               # depends on "memory-sql"; vitest here
    src/ontology.test.ts  store.test.ts  synth.test.ts  oracle.test.ts
        cq.test.ts  metamorphic.test.ts  stress.test.ts
```

Root scripts: `typecheck` (tsc -b or per-workspace `--noEmit`), `build`
(core), `test` (vitest in tests workspace), `example:01|02|03` (tsx),
`fetch-fhir`. Examples run with `tsx` against the **built** core (build first)
to honor isolation.

## FHIR-derived ontology

- **Source**: FHIR **R4 (4.0.1)** — the US-payer-mandated version.
  `scripts/fetch-fhir.ts` downloads `https://hl7.org/fhir/R4/profiles-resources.json`
  (and `profiles-types.json` if needed), extracts the top-50 resource
  StructureDefinitions, trims each to what the ontology needs (name, kind,
  element paths, types, cardinalities, required bindings + their value sets
  where enumerable, reference targets), and writes
  `packages/core/fhir-data/top50.json` (committed — build and CI are offline;
  the script exists so the data is reproducible).
- **Top 50 resources** (fixed list, payer-weighted): Patient, Practitioner,
  PractitionerRole, Organization, Location, Encounter, Observation, Condition,
  Procedure, MedicationRequest, Medication, MedicationDispense,
  MedicationStatement, Immunization, AllergyIntolerance, DiagnosticReport,
  DocumentReference, ServiceRequest, CarePlan, CareTeam, Goal, Device,
  Specimen, ImagingStudy, Appointment, Schedule, Slot, Coverage, Claim,
  ClaimResponse, ExplanationOfBenefit, CoverageEligibilityRequest,
  CoverageEligibilityResponse, PaymentNotice, PaymentReconciliation, Account,
  ChargeItem, Invoice, Person, RelatedPerson, Group, HealthcareService,
  Endpoint, Communication, CommunicationRequest, Task, Questionnaire,
  QuestionnaireResponse, Provenance, AuditEvent.
- **`ontology/model.ts` (generic — not FHIR-specific)**:
  `Ontology { entityTypes: EntityType[] }`;
  `EntityType { name, attributes: Attribute[], relations: Relation[] }`;
  `Attribute { name, type: 'string'|'code'|'boolean'|'integer'|'decimal'|'date'|'datetime', required, valueSet?: string[] }`;
  `Relation { name, target: string[], required }` (FHIR Reference(X|Y) yields
  multiple targets). Keep it flat and honest: FHIR's nested
  BackboneElements are flattened to dotted attribute paths for scalar leaves
  we keep; complex types (CodeableConcept, Period, Money, Quantity,
  Identifier, Reference) map to a small documented set of flattened columns
  (e.g. `code`, `period_start`, `period_end`, `amount_cents`, `currency`).
  Depth cap and pruning rules are the implementer's choice but MUST be
  documented in model.ts and deterministic. Target ≈ 5-15 attributes + the
  reference relations per resource — enough for real CQs, not a full FHIR ORM.
- **`ontology/fhir.ts`**: `loadFhirOntology(): Effect<Ontology, FhirLoadError>`
  reading the committed JSON; validated with `effect/Schema`.

## Store, synth, oracle contracts

- **`store/schema.ts`**: `ddl(ontology): string[]` — one table per entity type
  (table = lower_snake resource name; `id TEXT PRIMARY KEY`; attribute columns
  per type map; relation columns as `<relation>_ref TEXT` holding target id;
  multi-target relations also get `<relation>_ref_type TEXT`).
- **`store/db.ts`**: `DuckDb` service — `run(sql)`, `query(sql) ->
  { columns: string[], rows: unknown[][] }`; `layer(opts?: { path?: string })`
  (default in-memory), scoped acquire/release; `DbError` tagged.
- **`store/load.ts`**: `InstanceWorld = { [entityType: string]: Row[] }`;
  `loadWorld(world): Effect<void, DbError, DuckDb>` (creates DDL + inserts).
- **`synth/generate.ts`**: `generateWorld(ontology, opts: { seed, patients?: number }): InstanceWorld`
  — deterministic, referentially consistent by construction (every reference
  points at a generated row; required attributes filled; value-set attributes
  drawn from the value set; periods ordered start<=end; claims link real
  Coverage+Patient; EOBs link real Claims). Sized ~= 20 patients default with
  proportionate related resources (~15-40 rows per major type). This CLEAN
  generator is the baseline; adversarial corruption lives in `sim/stress.ts`.
- **`oracle/sql.ts`**: `SqlOracle.answer(binding): Effect<Answer, OracleError, DuckDb>`
  — compiles a bound CQ template to SQL, executes, returns a canonical
  `Answer` (see cq/model). Canonicalization: result sets sorted by id;
  numbers as integers (cents) where money; dates ISO.

## Stage 1 — CQ dual-oracle (`cq/`)

- **`model.ts`**: `CqTemplate { id, regime: 'point-lookup'|'cross-entity'|'aggregate'|'temporal'|'negative-control', text: (b) => string, params: ParamSpec[], sql: (b) => string, expectedKind: 'set'|'scalar'|'boolean' }`;
  `Answer { kind, value, citations: Citation[] }` where
  `Citation = { entityType, id }`; `Verdict = 'match'|'missing'|'divergent'|'unsupported-citation'`;
  verdict rules: path returned nothing the oracle has -> missing; values differ
  -> divergent; values match but a citation does not resolve to a real row
  (or resolves to a row that does not support the answer, checked
  mechanically: cited row's id participates in the oracle result) ->
  unsupported-citation; else match.
- **`engine.ts`**: `AnswerPath` interface —
  `{ name: string; answer(binding): Effect<Answer, PathError, never> }` (the
  pluggable product surface; implementations may close over their own deps).
  `bindTemplates(templates, world, rng, n)` — Monte-Carlo samples parameter
  bindings from the actual world (real patient/plan/claim ids).
  `runSuite(bindings, oracle, path): Effect<CqReport, ...>` where `CqReport`
  carries per-CQ verdicts + rates: answerable-rate, agreement-rate,
  citation-resolves-rate, per-regime breakdown.
- **`graph-path.ts`**: `GraphPath` — the reference AnswerPath: answers by
  typed traversal of the in-memory `InstanceWorld` (follow relations, filter,
  aggregate). It should agree with the oracle on the clean world (that
  agreement is itself a test) — it exists so the product runs end-to-end
  without any external answer layer.
- **`templates.ts`** — ~12 shipped templates over the FHIR ontology, e.g.:
  active Conditions of {patient}; Observations for {patient} in {period}
  (temporal); active Coverage for {patient} on {date}; denied Claims for
  {patient}; total EOB paid amount for {patient} in {period} (aggregate);
  MedicationRequests for {patient} and their Medications (cross-entity);
  Encounters for {patient} at {organization}; Practitioners who authored
  MedicationRequests for {patient}; does {patient} have an active
  AllergyIntolerance to {code} (boolean); at least 2 negative controls
  (a resource type the patient has none of -> must answer empty, not
  fabricate).

## Stage 2 — Simulation (`sim/`)

- **`metamorphic.ts`**: `MetamorphicRelation { id, describe, transform(world | binding), expect: 'equal'|'subset'|'unchanged-answer' }` + runner using
  **fast-check** over sampled bindings. Ship 4 relations:
  1. **irrelevant-augmentation**: adding resources for OTHER patients must not
     change any answer about {patient} (`unchanged-answer`).
  2. **temporal-narrowing**: shrinking a {period} can only shrink a result set
     (`subset`).
  3. **referential-symmetry**: forward traversal (Patient -> its Observations)
     equals reverse lookup (Observations whose subject_ref = patient).
  4. **cross-oracle-equality**: for every binding, `GraphPath` answer ==
     `SqlOracle` answer (the MR form of the dual oracle).
  Runner reports pass/fail per relation with the **shrunk counterexample**
  (fast-check) on failure.
- **`stress.ts`**: adversarial **mutators** (each takes a clean world + rng and
  plants a named defect): `dangling-reference` (point a claim at a
  nonexistent coverage), `missing-required` (drop a required attribute),
  `illegal-code` (status outside its value set), `reversed-period`
  (start > end), `orphan-eob` (EOB whose claim_ref resolves nowhere),
  `duplicate-id`, `future-dated-birth`, `self-reference`. And **invariants**
  (checked via SQL over the loaded world): referential integrity for every
  relation; required-attribute presence; value-set membership; period
  ordering; unique ids; claim->coverage->patient chain resolves;
  EOB<->Claim consistency (`eob-claim-consistency`: every EOB references a
  Claim of its own patient — the checkable analogue of "EOB totals = sum of
  item adjudications", whose item-level rows the depth-1 flattening prunes);
  birthDate sanity.
  `replay(world, invariants)` -> per-invariant violations.
  **The contract test of the whole example**: clean world -> zero violations;
  each named mutator -> its named invariant fires (a mutator x invariant
  matrix in the report). This is "validation by simulation".
- Both engines must be **generic over the Ontology** (no FHIR hardcoding in
  the engine logic; FHIR-specific bits live in templates/mutator configs).

## CLI (`memory-sql`, @effect/cli)

```
memory-sql synth --seed 42 --patients 20 --out world.json
memory-sql cq    --seed 42 [--world world.json] [--n 50]     # dual-oracle suite, prints CqReport
memory-sql sim   --seed 42 [--mrs 200]                        # metamorphic + stress, prints reports
```
All runnable via `npx tsx packages/core/src/cli.ts ...` in dev and
`node packages/core/dist/cli.js` built. Exit 1 when a suite finds
divergences/violations (CI-gate semantics); friendly tagged-error messages.

## Testing contract (tests/ workspace, vitest)

Import ONLY the `memory-sql` public API. No network. Required:
1. `ontology.test.ts` — top50.json loads; ontology has 50 entity types; spot-check
   Patient/Claim/Coverage attributes + relations; every relation target is a
   known entity type.
2. `store.test.ts` — DDL creates all tables; loadWorld round-trips row counts.
3. `synth.test.ts` — determinism (same seed => deep-equal worlds); referential
   consistency of the clean world (zero stress violations).
4. `oracle.test.ts` — hand-computed answers for 2-3 bindings on a tiny world.
5. `cq.test.ts` — GraphPath vs SqlOracle agree on the clean world (all match);
   a deliberately broken AnswerPath (wrong value / fake citation) yields
   `divergent` and `unsupported-citation` verdicts respectively; negative
   controls answer empty.
6. `metamorphic.test.ts` — all 4 MRs pass on the correct stack; a planted
   traversal bug (e.g. GraphPath variant that ignores the period filter) is
   caught by temporal-narrowing with a shrunk counterexample.
7. `stress.test.ts` — the mutator x invariant matrix: clean=0; each mutator
   trips its invariant.

## README requirements

Product framing (what memory-sql is, the AnswerPath plug-in surface, why a SQL
oracle makes validation deterministic); architecture diagram; quickstart
(install, build, run examples 01-03, CLI); the FHIR-top-50 ontology section
(R4, how fetch-fhir works, how to re-derive); Stage 1 + Stage 2 explained with
the SOTA lineage one-liners (competency questions; metamorphic testing;
adversarial ABox stress as closed-world consistency checking); how to plug a
real LLM/RAG layer in as AnswerPath (point at example 03); isolation layout
note (core/examples/tests workspaces); research-prototype disclaimer; MIT.
