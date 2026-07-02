/**
 * SPEC testing contract #2 — store.
 *
 * Why this validates the ontology->SQL mapping: the SQL oracle is only ground
 * truth if the DDL is a faithful, deterministic image of the ontology (one
 * table per entity type, one column per attribute/relation, reserved words
 * quoted) and loadWorld round-trips the generated world losslessly. Every
 * assertion here runs against the public API and a real (in-memory) DuckDB.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  DuckDb,
  columnName,
  createTable,
  ddl,
  duckDbLayer,
  entityTypeNames,
  generateWorld,
  loadFhirOntology,
  loadWorld,
  quoteIdent,
  relationRefColumn,
  relationRefTypeColumn,
  requireEntityType,
  sqlType,
  tableColumns,
  tableName
} from "memory-sql"
import type { InstanceWorld, Ontology, SqlValue } from "memory-sql"

const ontology: Ontology = await Effect.runPromise(loadFhirOntology())

/** Run an effect against a fresh scoped in-memory DuckDB (closed on settle). */
const withDb = <A, E>(effect: Effect.Effect<A, E, DuckDb>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, duckDbLayer()))

const countRows = (table: string) =>
  Effect.gen(function* () {
    const db = yield* DuckDb
    const result = yield* db.query(`SELECT COUNT(*) FROM ${quoteIdent(table)}`)
    return Number(result.rows[0]?.[0])
  })

describe("store: pure schema mapping", () => {
  it("maps names deterministically", () => {
    expect(tableName("Patient")).toBe("patient")
    expect(tableName("ExplanationOfBenefit")).toBe("explanation_of_benefit")
    expect(columnName("birth_date")).toBe("birth_date")
    expect(() => columnName("BadName")).toThrow()
    expect(() => columnName("1starts_with_digit")).toThrow()
    expect(quoteIdent("group")).toBe(`"group"`)
    expect(relationRefColumn("subject")).toBe("subject_ref")
    expect(relationRefTypeColumn("subject")).toBe("subject_ref_type")
  })

  it("maps attribute types to the documented SQL types", () => {
    // Dates/datetimes are TEXT holding ISO strings — temporal SQL is exact
    // string comparison, which is what keeps the oracle deterministic.
    expect(sqlType("string")).toBe("TEXT")
    expect(sqlType("code")).toBe("TEXT")
    expect(sqlType("date")).toBe("TEXT")
    expect(sqlType("datetime")).toBe("TEXT")
    expect(sqlType("boolean")).toBe("BOOLEAN")
    expect(sqlType("integer")).toBe("INTEGER")
    expect(sqlType("decimal")).toBe("DOUBLE")
  })

  it("lays out Claim columns: id first, attributes, then relation refs", () => {
    const claim = requireEntityType(ontology, "Claim")
    const columns = tableColumns(claim)
    expect(columns[0]).toEqual({ name: "id", sqlType: "TEXT" })
    const names = columns.map((c) => c.name)
    expect(names).toContain("status")
    expect(names).toContain("total_cents")
    // Single-target relation: ref column only.
    expect(names).toContain("patient_ref")
    expect(names).not.toContain("patient_ref_type")
    expect(names).toContain("insurance_coverage_ref")
    expect(names).not.toContain("insurance_coverage_ref_type")
    // Multi-target relation: ref + ref_type discriminator.
    expect(names).toContain("provider_ref")
    expect(names).toContain("provider_ref_type")
  })

  it("emits one CREATE TABLE per entity type, in ontology order, fully quoted", () => {
    const statements = ddl(ontology)
    expect(statements).toHaveLength(ontology.entityTypes.length)
    for (const [i, statement] of statements.entries()) {
      const et = ontology.entityTypes[i]!
      expect(statement).toMatch(/^CREATE TABLE /)
      expect(statement).toContain(quoteIdent(tableName(et.name)))
    }
    // Reserved-word landmines must come out double-quoted.
    const group = createTable(requireEntityType(ontology, "Group"))
    expect(group).toContain(`"group"`)
    const coverage = createTable(requireEntityType(ontology, "Coverage"))
    expect(coverage).toContain(`"order"`)
  })
})

describe("store: live DuckDB", () => {
  it("DDL creates all 50 tables", async () => {
    const tables = await withDb(
      Effect.gen(function* () {
        const db = yield* DuckDb
        // Single connection: run statements strictly sequentially.
        for (const statement of ddl(ontology)) {
          yield* db.run(statement)
        }
        const result = yield* db.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
        )
        return result.rows.map((r) => String(r[0]))
      })
    )
    const expected = entityTypeNames(ontology).map(tableName).sort()
    expect(tables).toEqual(expected)
  })

  it("loadWorld round-trips row counts for every entity type", async () => {
    const world = generateWorld(ontology, { seed: 7, patients: 5 })
    const counts = await withDb(
      Effect.gen(function* () {
        yield* loadWorld(world, ontology)
        const out: Record<string, number> = {}
        for (const name of entityTypeNames(ontology)) {
          out[name] = yield* countRows(tableName(name))
        }
        return out
      })
    )
    for (const name of entityTypeNames(ontology)) {
      expect(counts[name], name).toBe(world[name]?.length ?? 0)
    }
  })

  it("loadWorld is idempotent (reload does not duplicate rows)", async () => {
    const world = generateWorld(ontology, { seed: 11, patients: 3 })
    const [first, second] = await withDb(
      Effect.gen(function* () {
        yield* loadWorld(world, ontology)
        const a = yield* countRows("patient")
        yield* loadWorld(world, ontology)
        const b = yield* countRows("patient")
        return [a, b] as const
      })
    )
    expect(first).toBe(world["Patient"]?.length ?? 0)
    expect(second).toBe(first)
  })

  it("round-trips cell values, including NULLs and reserved-word columns", async () => {
    const patients = generateWorld(ontology, { seed: 13, patients: 4 })["Patient"] ?? []
    expect(patients.length).toBeGreaterThan(0)
    const sample = patients[0]!
    const world: InstanceWorld = { Patient: patients }
    const row = await withDb(
      Effect.gen(function* () {
        yield* loadWorld(world, ontology)
        const db = yield* DuckDb
        const result = yield* db.query(
          `SELECT "gender", "birth_date", "deceased" FROM "patient" WHERE "id" = '${sample["id"]}'`
        )
        return result.rows[0]
      })
    )
    const normalize = (v: SqlValue | undefined): SqlValue => (v === undefined ? null : v)
    expect(row).toBeDefined()
    expect(row?.[0]).toBe(normalize(sample["gender"]))
    expect(row?.[1]).toBe(normalize(sample["birth_date"]))
    expect(row?.[2]).toBe(normalize(sample["deceased"]))
  })

  it("with an ontology, loadWorld creates empty tables for absent types (negative controls)", async () => {
    // A world holding only patients must still produce a queryable (empty)
    // claim table — negative-control CQs depend on querying empty tables.
    const world: InstanceWorld = {
      Patient: [{ id: "patient-1", gender: "female", birth_date: "1980-04-01" }]
    }
    const claimCount = await withDb(
      Effect.gen(function* () {
        yield* loadWorld(world, ontology)
        return yield* countRows("claim")
      })
    )
    expect(claimCount).toBe(0)
  })

  it("rejects a world keyed by an unknown entity type", async () => {
    const world: InstanceWorld = { NotAResource: [{ id: "x-1" }] }
    await expect(withDb(loadWorld(world, ontology))).rejects.toThrow(/NotAResource/)
  })
})
