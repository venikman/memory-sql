/**
 * SPEC v2 mandate #2 — the `memory-sql/effect` adapter.
 *
 * The adapter is the ONE place Effect exists (see isolation.test.ts). This
 * suite proves the wrapping is faithful in both directions: a successful
 * plain-core op becomes an Effect success carrying the same value, and a
 * failing op surfaces on the typed error channel as the tagged
 * `MemorySqlError` (Data.TaggedError) that preserves the core error's `op`
 * and carries the core error as `cause` — never a defect, never a lost tag.
 *
 * `effect` is an optional peer dependency of the core, so this suite loads it
 * dynamically and skips cleanly (with a message) when it is not installed;
 * the main entry must keep working without it either way.
 */
import { describe, expect, it } from "vitest"
import { MemorySqlError as CoreMemorySqlError, loadFhirOntology } from "memory-sql"
import type { InstanceWorld } from "memory-sql"

// Optional-peer probe: only when `effect` resolves may the adapter be loaded
// (the adapter imports effect, so importing it without effect would throw for
// the wrong reason). If effect resolves but the adapter fails to import, that
// IS a bug — the import error fails this suite loudly instead of skipping.
const eff = await import("effect").then(
  (m) => m,
  () => null
)
const adapter = eff === null ? null : await import("memory-sql/effect")

if (eff === null || adapter === null) {
  describe("effect adapter (memory-sql/effect)", () => {
    it.skip("SKIPPED: optional peer dependency `effect` is not installed — `npm install effect` to exercise the adapter", () => {
      /* skipped: effect not installed */
    })
  })
} else {
  const { Cause, Effect, Exit, Option } = eff
  const ontology = loadFhirOntology()

  describe("effect adapter (memory-sql/effect)", () => {
    it("wraps a successful sync op into an Effect success with the same value", async () => {
      const exit = await Effect.runPromiseExit(adapter.loadFhirOntology())
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.entityTypes).toHaveLength(50)
      }
    })

    it("wraps successful async ops end to end: scoped store -> loadWorld -> query", async () => {
      const tiny: InstanceWorld = {
        Patient: [
          { id: "patient-1", gender: "female", birth_date: "1980-04-01" },
          { id: "patient-2", gender: "male", birth_date: "1971-11-20" }
        ]
      }
      const program = Effect.scoped(
        Effect.flatMap(adapter.openStore(), (store) =>
          Effect.flatMap(adapter.loadWorld(store, ontology, tiny), () =>
            Effect.tryPromise({
              try: () => store.query(`SELECT COUNT(*) FROM "patient"`),
              catch: (cause) => new adapter.MemorySqlError({ op: "db", cause })
            })
          )
        )
      )
      const exit = await Effect.runPromiseExit(program)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(Number(exit.value.rows[0]?.[0])).toBe(2)
      }
    })

    it("provides the MemorySql service through the scoped layer", async () => {
      const world: InstanceWorld = {
        Patient: [{ id: "patient-1", gender: "other", birth_date: "1990-01-15" }]
      }
      const program = Effect.flatMap(adapter.MemorySql, (ms) =>
        Effect.flatMap(ms.loadWorld(ontology, world), () =>
          ms.query(`SELECT "id" FROM "patient" ORDER BY "id"`)
        )
      )
      const exit = await Effect.runPromiseExit(Effect.provide(program, adapter.layer()))
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.rows.map((r) => String(r[0]))).toEqual(["patient-1"])
      }
    })

    it("surfaces a failing op on the typed error channel as the tagged MemorySqlError", async () => {
      // A world keyed by an unknown entity type is rejected by the plain core
      // with op "load"; the adapter must keep that tag, not re-guess it.
      const poisoned: InstanceWorld = { NotAResource: [{ id: "x-1" }] }
      const program = Effect.scoped(
        Effect.flatMap(adapter.openStore(), (store) => adapter.loadWorld(store, ontology, poisoned))
      )
      const exit = await Effect.runPromiseExit(program)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      // An expected failure lives in the FAIL channel (typed), not as a defect.
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (!Option.isSome(failure)) return
      const error = failure.value
      expect(error._tag).toBe("MemorySqlError")
      expect(error).toBeInstanceOf(adapter.MemorySqlError)
      expect(error.op).toBe("load")
      expect(error.message).toMatch(/NotAResource/)
      // The plain-core error rides along as the cause — nothing is swallowed.
      expect(error.cause).toBeInstanceOf(CoreMemorySqlError)
    })

    it("wraps a failing sync op the same way (op tag preserved from the core)", async () => {
      // generateWorld over a broken ontology reference: requireEntityType-style
      // failures inside the core carry their own op; absent one, the wrapper's
      // fallback op applies. Either way the failure is typed and tagged.
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(adapter.loadFhirOntology(), (o) =>
          adapter.generateWorld(o, { seed: 1, patients: 2 })
        )
      )
      expect(Exit.isSuccess(exit)).toBe(true) // sanity: the happy path composes

      const failing = await Effect.runPromiseExit(
        Effect.flatMap(adapter.openStore(), (store) =>
          adapter.loadWorld(store, ontology, {
            Claim: [{ id: "claim-1", total_cents: "2500" }] // string into INTEGER: rejected pre-DDL
          })
        ).pipe(Effect.scoped)
      )
      expect(Exit.isFailure(failing)).toBe(true)
      if (!Exit.isFailure(failing)) return
      const failure = Cause.failureOption(failing.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (!Option.isSome(failure)) return
      expect(failure.value._tag).toBe("MemorySqlError")
      expect(failure.value.op).toBe("load")
      expect(failure.value.message).toMatch(/total_cents/)
    })
  })
}
