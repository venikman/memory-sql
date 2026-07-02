/**
 * SPEC v2 mandate #2 — the executable Effect isolation gate.
 *
 * The core's pitch is "plain JavaScript, one runtime dependency; Effect users
 * get an optional adapter". That claim is only credible if it is enforced:
 * this test walks every .js source in the three workspaces and asserts that
 * nothing imports `effect` (or any `@effect/*` package) except the three
 * explicitly allowlisted files — the adapter itself, the example that demos
 * it, and the adapter's own test. A violation anywhere fails the build.
 */
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** The scanned source roots (repo-relative, posix separators). scripts/ is
 * included so the SPEC rule "fetch-fhir.js must not import effect" is
 * executable rather than grep-enforced. */
const SCANNED_DIRS = ["packages/core/src", "examples/src", "tests/src", "scripts"]

/** The ONLY files allowed to import effect / @effect/*. */
const ALLOWED = new Set([
  "packages/core/src/effect.js", // the adapter (subpath export memory-sql/effect)
  "examples/src/04-effect-adapter.js", // the example demoing the adapter
  "tests/src/effect-adapter.test.js" // the adapter's own test
])

/**
 * Import-shaped references to the effect ecosystem: static `from` clauses
 * (multi-line-safe: the clause, not the line, is matched), side-effect and
 * dynamic imports, and CommonJS require. Plain prose mentioning the word
 * "effect" does not match — only quoted module specifiers do.
 */
const EFFECT_IMPORT_PATTERNS = [
  /\bfrom\s*["'](?:effect|@effect\/[^"']*)["']/,
  /\bimport\s*\(?\s*["'](?:effect|@effect\/[^"']*)["']/,
  /\brequire\s*\(\s*["'](?:effect|@effect\/[^"']*)["']\s*\)/
]

const importsEffect = (source) =>
  EFFECT_IMPORT_PATTERNS.some((pattern) => pattern.test(source))

/** All .js sources under a repo-relative dir (recursive), as repo-relative posix paths. */
const jsFilesUnder = (dir) =>
  readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) =>
      path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
    )
    .sort()

const allFiles = SCANNED_DIRS.flatMap(jsFilesUnder)

describe("isolation: effect stays quarantined in the adapter", () => {
  it("scans a real, non-empty source tree (the gate cannot pass vacuously)", () => {
    for (const dir of SCANNED_DIRS) {
      expect(allFiles.some((f) => f.startsWith(`${dir}/`)), dir).toBe(true)
    }
    // The gate must see the plain core it protects…
    expect(allFiles).toContain("packages/core/src/index.js")
    expect(allFiles).toContain("packages/core/src/store.js")
    // …and every allowlisted file must actually exist (a stale allowlist is a hole).
    for (const allowed of ALLOWED) {
      expect(allFiles, allowed).toContain(allowed)
    }
  })

  it("detector sanity: the adapter itself is seen importing effect", () => {
    // Proves the detector works — if this stops matching, a real violation
    // elsewhere could go unnoticed, so the gate must fail loudly here first.
    const adapterSource = readFileSync(path.join(repoRoot, "packages/core/src/effect.js"), "utf8")
    expect(importsEffect(adapterSource)).toBe(true)
  })

  it("no file outside the allowlist imports effect or @effect/*", () => {
    const offenders = allFiles.filter(
      (file) => !ALLOWED.has(file) && importsEffect(readFileSync(path.join(repoRoot, file), "utf8"))
    )
    expect(offenders, "files importing effect outside the allowlist").toEqual([])
  })
})
