> **`js` branch note:** code snippets in these playbooks use TypeScript
> notation (written for `main`). On this branch, strip type annotations —
> imports, signatures, behavior, and acceptance outputs are identical, and
> there is no build step (`node` runs source directly).

# docs/adopt — adoption playbooks

Stepwise, machine-checkable guides for wiring memory-sql into an existing
system. Every playbook ends with **acceptance commands and expected output**
so you can verify your own work. Read `AGENTS.md` (repo root) first — it
carries the standing rules, including the prime directive: *the harness is
the judge; never modify the oracle, verdicts, canonicalization, invariants,
or tests to make your integration pass.*

## Which playbook?

| Your task | Playbook |
| --- | --- |
| "Wire our RAG / LLM / wiki agent / API layer in so memory-sql grades it" | [01-wire-answerpath.md](./01-wire-answerpath.md) |
| "Grade answers over OUR data model, not FHIR" (own tables, own DuckDB, own domain) | [02-custom-ontology.md](./02-custom-ontology.md) — then 03 |
| "Add domain questions / port our eval set into the suite" | [03-add-cq-templates.md](./03-add-cq-templates.md) |
| "The report says `divergent` / `missing` / `unsupported-citation` — what now?" or "gate CI on this" | [04-interpret-verdicts.md](./04-interpret-verdicts.md) |
| "Add label-free checks / defect detectors for our domain" (metamorphic relations, mutators, invariants) | [05-extend-simulation.md](./05-extend-simulation.md) |

Typical full adoption order: **02 → 03 → 01 → 04 → 05**. If you keep the
shipped FHIR ontology and templates and only bring your own answer layer,
**01 → 04** is enough.

## The reference adoption

`wiki-index/harness/` (sibling repo `wiki-index`, directory `harness/`) is a
completed adoption used as the worked case study throughout: a 14-table
ontology hand-derived from a real read-only DuckDB (`src/ontology.ts`,
`src/world.ts`), 14 CQ templates with test-pinned ground truth
(`src/templates.ts`, `test/templates.test.ts`), a schema-drift gate
(`test/schema.test.ts`), and two AnswerPaths — a deterministic SQL baseline
self-test (`src/paths/sql-baseline.ts`) and a real RAG pipeline
(`src/paths/rag.ts`).

## Ground rules for all playbooks

- Copy API signatures from `packages/core/src/` — never invent one. The whole
  public surface is re-exported flat from `packages/core/src/index.ts`
  (`import { … } from "memory-sql"`).
- Node >= 22, ESM. On `main` the package must be built (`npm run build`)
  before consumers can import `memory-sql`.
- Determinism is a hard rule: no `Math.random`, no wall clock. Use `makeRng`
  and `REFERENCE_DATE` from the package.
