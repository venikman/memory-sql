import { defineConfig } from "vitest/config"

/**
 * Test-suite policy per SPEC: tests exercise ONLY the published "memory-sql"
 * surface (the workspace dependency resolves to the built package), run fully
 * offline, and are deterministic (fixed seeds everywhere — no retries needed).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // DuckDB is a native addon; child-process forks isolate it more reliably
    // than worker threads when several suites each open their own database.
    pool: "forks",
    // CQ suites + seeded metamorphic runs do real SQL work per test.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Determinism: no retry masking — a flaky test is a bug in this product.
    retry: 0
  }
})
