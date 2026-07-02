/**
 * SPEC testing contract #2 — store.
 *
 * Why this validates the ontology->SQL mapping: the SQL oracle is only ground
 * truth if the DDL is a faithful, deterministic image of the ontology (one
 * table per entity type, one column per attribute/relation, reserved words
 * quoted) and loadWorld round-trips the generated world losslessly. The v2
 * load boundary additionally rejects worlds whose JS value types contradict
 * the ontology BEFORE any DDL/INSERT — without it DuckDB would silently cast
 * on INSERT while the GraphPath reads the raw in-memory row, and the two
 * reference oracles would see different values for the same world. Every
 * assertion here runs against the public API and a real (in-memory) DuckDB.
 */
import { describe, expect, it } from "vitest"
import {
  MemorySqlError,
  columnName,
  createTable,
  ddl,
  entityTypeNames,
  generateWorld,
  loadFhirOntology,
  loadWorld,
  openStore,
  quoteIdent,
  relationRefColumn,
  relationRefTypeColumn,
  requireEntityType,
  sqlType,
  tableColumns,
  tableName
} from "memory-sql"
import type { InstanceWorld, Ontology, SqlValue, Store } from "memory-sql"

const ontology: Ontology = loadFhirOntology()

/** Run `f` against a fresh in-memory DuckDB store (closed on settle). */
const withStore = async <A>(f: (store: Store) => Promise<A>): Promise<A> => {
  const store = await openStore()
  try {
    return await f(store)
  } finally {
    store.close()
  }
}

const countRows = async (store: Store, table: string): Promise<number> => {
  const result = await store.query(`SELECT COUNT(*) FROM ${quoteIdent(table)}`)
  return Number(result.rows[0]?.[0])
}

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
    const tables = await withStore(async (store) => {
      // Single connection: run statements strictly sequentially.
      for (const statement of ddl(ontology)) {
        await store.run(statement)
      }
      const result = await store.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      )
      return result.rows.map((r) => String(r[0]))
    })
    const expected = entityTypeNames(ontology).map(tableName).sort()
    expect(tables).toEqual(expected)
  })

  it("loadWorld round-trips row counts for every entity type", async () => {
    const world = generateWorld(ontology, { seed: 7, patients: 5 })
    const counts = await withStore(async (store) => {
      await loadWorld(store, ontology, world)
      const out: Record<string, number> = {}
      for (const name of entityTypeNames(ontology)) {
        out[name] = await countRows(store, tableName(name))
      }
      return out
    })
    for (const name of entityTypeNames(ontology)) {
      expect(counts[name], name).toBe(world[name]?.length ?? 0)
    }
  })

  it("loadWorld is idempotent (reload does not duplicate rows)", async () => {
    const world = generateWorld(ontology, { seed: 11, patients: 3 })
    const [first, second] = await withStore(async (store) => {
      await loadWorld(store, ontology, world)
      const a = await countRows(store, "patient")
      await loadWorld(store, ontology, world)
      const b = await countRows(store, "patient")
      return [a, b] as const
    })
    expect(first).toBe(world["Patient"]?.length ?? 0)
    expect(second).toBe(first)
  })

  it("round-trips cell values, including NULLs and reserved-word columns", async () => {
    const patients = generateWorld(ontology, { seed: 13, patients: 4 })["Patient"] ?? []
    expect(patients.length).toBeGreaterThan(0)
    const sample = patients[0]!
    const world: InstanceWorld = { Patient: patients }
    const row = await withStore(async (store) => {
      await loadWorld(store, ontology, world)
      const result = await store.query(
        `SELECT "gender", "birth_date", "deceased" FROM "patient" WHERE "id" = '${sample["id"]}'`
      )
      return result.rows[0]
    })
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
    const claimCount = await withStore(async (store) => {
      await loadWorld(store, ontology, world)
      return countRows(store, "claim")
    })
    expect(claimCount).toBe(0)
  })

  it("without an ontology, loadWorld infers tables from the rows (fixture worlds)", async () => {
    const world: InstanceWorld = {
      Condition: [
        { id: "condition-1", subject_ref: "patient-1", clinical_status: "active" },
        { id: "condition-2", subject_ref: "patient-2", clinical_status: "resolved" }
      ]
    }
    const rows = await withStore(async (store) => {
      await loadWorld(store, undefined, world)
      const result = await store.query(`SELECT "id" FROM "condition" ORDER BY "id"`)
      return result.rows.map((r) => String(r[0]))
    })
    expect(rows).toEqual(["condition-1", "condition-2"])
  })
})

describe("store: the load boundary rejects bad worlds (pre-DDL, pointed errors)", () => {
  it("rejects a world keyed by an unknown entity type", async () => {
    const world: InstanceWorld = { NotAResource: [{ id: "x-1" }] }
    await withStore(async (store) => {
      await expect(loadWorld(store, ontology, world)).rejects.toThrow(/NotAResource/)
      await expect(loadWorld(store, ontology, world)).rejects.toMatchObject({
        name: "MemorySqlError",
        op: "load"
      })
    })
  })

  it("rejects a type-poisoned world instead of letting DuckDB silently cast", async () => {
    // total_cents is INTEGER in the ontology; a string "2500" would be cast on
    // INSERT (store sees 2500) while the in-memory graph sees "2500" — the two
    // reference oracles would diverge on a world defect. Reject at the boundary.
    const poisoned: InstanceWorld = {
      Claim: [{ id: "claim-1", total_cents: "2500" }]
    }
    await withStore(async (store) => {
      const failure = await loadWorld(store, ontology, poisoned).then(
        () => null,
        (cause: unknown) => cause
      )
      expect(failure).toBeInstanceOf(MemorySqlError)
      const error = failure as MemorySqlError
      expect(error.op).toBe("load")
      // Pointed: names the row, the column, and both sides of the mismatch.
      expect(error.message).toMatch(/Claim\[claim-1\]/)
      expect(error.message).toMatch(/total_cents/)
      expect(error.message).toMatch(/expected number/)
      expect(error.message).toMatch(/got string/)
      // Rejected BEFORE any DDL: the store must be untouched.
      const tables = await store.query(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main'"
      )
      expect(Number(tables.rows[0]?.[0])).toBe(0)
    })
  })

  it("duplicate ids still fail the INSERT — id is a real PRIMARY KEY", async () => {
    const world: InstanceWorld = {
      Patient: [
        { id: "patient-1", gender: "female", birth_date: "1980-04-01" },
        { id: "patient-1", gender: "male", birth_date: "1990-08-15" }
      ]
    }
    await withStore(async (store) => {
      await expect(loadWorld(store, ontology, world)).rejects.toMatchObject({
        name: "MemorySqlError",
        op: "store"
      })
    })
  })
})
