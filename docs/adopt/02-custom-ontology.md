# 02 — Replace the FHIR ontology with your own schema

Goal: memory-sql's store, oracle, and CQ runner operate over YOUR domain
model. The validation path is ontology-generic — all FHIR knowledge lives in
the committed data and shipped templates. You supply an `Ontology` object and
an `InstanceWorld`; nothing in the core needs changing.

Worked case study throughout: `wiki-index/harness/` derived a 14-entity
ontology from a real, pre-existing DuckDB (`data/fhir.duckdb`) and loads it
read-only. Quote its patterns; do not re-invent them.

## 1. The model (copied from `packages/core/src/ontology.ts`)

```ts
export type AttributeType = "string" | "code" | "boolean" | "integer" | "decimal" | "date" | "datetime"

export interface Attribute { readonly name: string; readonly type: AttributeType; readonly required: boolean; readonly valueSet?: readonly string[] }
export interface Relation  { readonly name: string; readonly target: readonly string[]; readonly required: boolean }
export interface EntityType { readonly name: string; readonly attributes: readonly Attribute[]; readonly relations: readonly Relation[] }
export interface Ontology  { readonly entityTypes: readonly EntityType[] }
```

The model is flat and honest: one EntityType = one table, one Attribute = one
column, one Relation = one foreign-key column. That flatness is what keeps
the SQL oracle auditable.

## 2. The SQL type map (from `packages/core/src/store.ts`)

| ontology type | DuckDB column | JS value in a `Row` |
| --- | --- | --- |
| `boolean` | `BOOLEAN` | `boolean` |
| `integer` | `INTEGER` | `number` |
| `decimal` | `DOUBLE` | `number` |
| `string`, `code`, `date`, `datetime` | `TEXT` | `string` |

Dates/datetimes are **ISO-8601 TEXT** end to end — lexicographic order IS
chronological order, so temporal SQL is plain string comparison. Naming and
column derivation:

- Entity names are PascalCase; `tableName("ExplanationOfBenefit")` →
  `"explanation_of_benefit"`. Pick names so `tableName()` round-trips to your
  real table names (harness: `MedicationRequest` → `medication_request`,
  `Cohort30` → `cohort30`).
- Attribute names are `lower_snake_case` and ARE the column names.
- A relation `r` yields column `<r>_ref TEXT`, plus `<r>_ref_type TEXT` only
  when it has multiple targets.
- Every table gets `id TEXT PRIMARY KEY` — a real constraint; duplicate ids
  fail the INSERT.
- `validateOntology(ontology)` returns human-readable problems (empty array =
  valid): unique type names, legal snake_case, no column collisions, every
  relation target resolvable. Run it; do not skip it.

## 3. How `loadWorld` validation behaves (know this before debugging)

`loadWorld(store, ontology, world)` — from `packages/core/src/store.ts`:

1. Every world key must be an ontology entity type, or:
   `MemorySqlError [load] world contains entity type "X" that is not in the ontology`.
2. **Every value's JS type is checked against its column type BEFORE any DDL
   or INSERT.** Otherwise DuckDB would silently cast on INSERT while
   in-memory readers see the raw value — two oracles, two truths. A poisoned
   world is rejected with a pointed one-liner, e.g. (real output):

   ```
   memory-sql: [load] world row Patient[patient-001] column "birth_date": expected string (TEXT), got number 12345 — fix the world so the SQL store and the in-memory graph see the same value
   ```

3. With an `ontology`, DDL covers ALL entity types — empty tables exist, so
   negative-control SQL can query them. With `ontology === undefined`,
   columns are inferred from rows (test fixtures only — do not ship that).
4. Loading is idempotent per table (`DROP TABLE IF EXISTS` + `CREATE`), so
   the same store can be reloaded with a corrected or regenerated world.

Consequence: when your source DB hands you driver types (JS `Date`, `bigint`),
you must coerce them to the promised JS type before `loadWorld`.

## 4. Case study: the wiki-index harness ontology

### 4a. The descriptor (`wiki-index/harness/src/ontology.ts`)

Derived by inspecting the REAL database — not guessed. Patterns to copy:

```ts
// tiny constructors (exactOptionalPropertyTypes: never set valueSet: undefined)
const a = (name: string, type: AttributeType): Attribute => ({ name, type, required: false })
const r = (name: string, target: string): Relation => ({ name, target: [target], required: false })

const PATIENT_REL = r("patient", "Patient")      // the FK-like column patient_id, as a relation

const Condition: EntityType = {
  name: "Condition",
  attributes: [a("onset_ts", "datetime"), a("code", "code"), a("display", "string"), /* … every non-json column */],
  relations: [PATIENT_REL, ENCOUNTER_REL]
}
```

Decisions the harness documents in its header comment, verbatim rules you
will face too:

- **FK columns become relations**: source columns `patient_id`/`encounter_id`
  are modelled as relations `patient`/`encounter`; memory-sql materializes
  them as `patient_ref`/`encounter_ref`. The rename is bridged by an explicit
  map the loader consumes:

  ```ts
  export const RELATION_SOURCE_COLUMN: Readonly<Record<string, string>> = {
    patient: "patient_id",
    encounter: "encounter_id"
  }
  ```

- **A table without an `id` column** (`cohort30` has only `patient_id`) is
  modelled with `id` sourced from another unique column:

  ```ts
  export const ID_SOURCE_COLUMN: Readonly<Record<string, string>> = { Cohort30: "patient_id" }
  ```

- **Deliberately unmodeled columns stay pinned.** The bulky `json` column is
  excluded from the ontology (speed) but still listed in an exported `TABLES`
  constant — the exact physical column list of every source table, in ordinal
  order — because that export is the raw schema truth the drift test asserts.

### 4b. The read-only source idiom (`wiki-index/harness/src/world.ts`)

The source database is NEVER written; the store the oracle queries is a fresh
in-memory copy:

```ts
instance = await DuckDBInstance.create(dbPath, { access_mode: "read_only" })
```

Per entity type it builds a SELECT that aliases source columns onto
memory-sql's column names, then coerces per the ontology's promise:

```ts
const select: string[] = [`"${idColumn}" AS "id"`]
for (const attr of et.attributes) select.push(`"${attr.name}"`)
for (const rel of et.relations)  select.push(`"${RELATION_SOURCE_COLUMN[rel.name]}" AS "${rel.name}_ref"`)
```

```ts
// the one non-trivial coercion: DuckDB DATE arrives as a JS Date
const isoDate = (d: Date): string => d.toISOString().slice(0, 10)
// … case "date": return value instanceof Date ? isoDate(value) : …
```

Then materialize:

```ts
const world = await readWorld(dbPath)     // plain InstanceWorld
const store = await openStore()           // fresh :memory: DuckDB
await loadWorld(store, wikiIndexOntology, world)   // validation runs here
```

Caller owns `store` and must `store.close()`.

### 4c. The schema-drift test pattern (`wiki-index/harness/test/schema.test.ts`)

The descriptor was written against the live DB; a test keeps it that way, in
**both directions**, against `information_schema.columns` opened read-only:

1. live table/column layout `toEqual` the pinned `TABLES` (ordinal order,
   including unmodeled columns);
2. every ontology attribute / relation source / id source resolves to a
   physical column;
3. **every physical column is accounted for** — modeled, a relation/id
   source, or on an explicit exclusion list (`EXCLUDED_COLUMNS = new Set(["json"])`)
   — so a NEW column in the source DB fails loudly instead of being silently
   dropped.

Copy this test whenever your ontology mirrors a database you do not control.

## 5. Steps for your adoption

1. Enumerate your source tables and columns (from the live DB, not from
   memory).
2. Write `ontology.ts`: one EntityType per table, PascalCase names that
   `tableName()`-round-trip, every scalar column as an attribute with the
   type-map type, FK columns as relations + `RELATION_SOURCE_COLUMN`, id
   oddities in `ID_SOURCE_COLUMN`, unmodeled columns in `TABLES` + exclusion
   list. Run `validateOntology` — fix until it returns `[]`.
3. Write `world.ts`: read-only open, aliasing SELECT per entity, per-type
   coercion to the promised JS types, `openStore()` + `loadWorld()`.
4. Write the drift test (4c).
5. Move on to [03-add-cq-templates.md](./03-add-cq-templates.md) — an
   ontology with no questions grades nothing.

> **STOP AND REPORT IF** `loadWorld` rejects your world and the fix you are
> reaching for is loosening `findTypeMismatch`, widening a column type you
> know is wrong, or bypassing validation with the `undefined`-ontology path.
> The boundary check exists so the SQL store and in-memory readers see the
> same values; coerce your data, never the gate.

## Acceptance — ddl + loadWorld round-trip, then the drift test

Minimal round-trip (self-contained; swap in your real ontology/world). Save
as `ontology-roundtrip.ts` in the scratch project from playbook 01:

```ts
import type { InstanceWorld, Ontology } from "memory-sql"
import { ddl, loadWorld, openStore, validateOntology } from "memory-sql"

const ontology: Ontology = {
  entityTypes: [
    { name: "Account",
      attributes: [
        { name: "email", type: "string", required: true },
        { name: "tier", type: "code", required: true, valueSet: ["free", "pro"] }],
      relations: [] },
    { name: "SupportTicket",
      attributes: [
        { name: "opened_ts", type: "datetime", required: true },
        { name: "status", type: "code", required: true, valueSet: ["open", "closed"] }],
      relations: [{ name: "account", target: ["Account"], required: true }] }
  ]
}
const world: InstanceWorld = {
  Account: [{ id: "acct-1", email: "a@example.com", tier: "pro" }],
  SupportTicket: [{ id: "tick-1", opened_ts: "2026-01-01T09:00:00Z", status: "open", account_ref: "acct-1" }]
}

const problems = validateOntology(ontology)
if (problems.length > 0) throw new Error(`ontology invalid:\n  ${problems.join("\n  ")}`)
console.log("validateOntology: ok")
for (const statement of ddl(ontology)) console.log(statement)

const store = await openStore()
try {
  await loadWorld(store, ontology, world)
  const joined = await store.query(
    `SELECT t."id" FROM "support_ticket" t JOIN "account" a ON a."id" = t."account_ref" WHERE a."tier" = 'pro'`)
  console.log(`round-trip: ${joined.rows.length} row(s): ${joined.rows.map((r) => String(r[0])).join(", ")}`)
} finally { store.close() }
```

```sh
npx tsx ontology-roundtrip.ts; echo "exit=$?"
```

Expected (exact):

```
validateOntology: ok
CREATE TABLE "account" ("id" TEXT PRIMARY KEY, "email" TEXT, "tier" TEXT)
CREATE TABLE "support_ticket" ("id" TEXT PRIMARY KEY, "opened_ts" TEXT, "status" TEXT, "account_ref" TEXT)
round-trip: 1 row(s): tick-1
exit=0
```

Then, for a real source database, the drift gate:

```sh
npx vitest run test/schema.test.ts
```

Expected: all four drift assertions green (see 4c for the required
assertions). If assertion 1 or 4 fails after a source-schema change, that is
the gate WORKING — update the ontology and `TABLES` together, deliberately.
