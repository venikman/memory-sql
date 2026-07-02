/**
 * Determinism kernel: the single seeded PRNG (splitmix32 — tiny, well
 * distributed, stable across platforms), the fixed REFERENCE_DATE ("today" of
 * the product), and pure civil-date arithmetic (Howard Hinnant's algorithms).
 * Every date computation is integer day math on ISO strings — no Date object,
 * no wall clock, never Math.random. Same seed => same stream => same world =>
 * same report.
 */
import { MemorySqlError } from "./ontology.js"

/** The fixed "today" of the product — no Date.now anywhere (SPEC determinism). */
export const REFERENCE_DATE = "2026-01-01"

/**
 * Create a seeded rng stream:
 *   seed   — the seed this stream was created from;
 *   int    — uniform integer in [min, max], both inclusive;
 *   pick   — uniform element of a non-empty array; throws on empty (programmer error);
 *   chance — true with the given probability in [0, 1];
 *   float  — uniform float in [min, max); defaults to [0, 1);
 *   uuid   — deterministic uuid-shaped identifier (8-4-4-4-12 hex).
 */
export const makeRng = (seed) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z ^= z >>> 16
    z = Math.imul(z, 0x21f0aaad)
    z ^= z >>> 15
    z = Math.imul(z, 0x735a2d97)
    z ^= z >>> 15
    return (z >>> 0) / 4294967296
  }
  const int = (min, max) => {
    if (max < min) throw new MemorySqlError("rng", `makeRng.int: max ${max} < min ${min}`)
    return min + Math.floor(next() * (max - min + 1))
  }
  const pick = (items) => {
    if (items.length === 0) throw new MemorySqlError("rng", "makeRng.pick: empty array")
    return items[int(0, items.length - 1)]
  }
  const uuid = () => {
    const run = (n) => Array.from({ length: n }, () => int(0, 15).toString(16)).join("")
    return `${run(8)}-${run(4)}-${run(4)}-${run(4)}-${run(12)}`
  }
  return { seed, int, pick, chance: (p) => next() < p, float: (min = 0, max = 1) => min + next() * (max - min), uuid }
}

// ── Civil-date arithmetic (pure integer day math; ISO YYYY-MM-DD in and out) ─

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/** Days since the civil epoch 1970-01-01 for a (year, month 1-12, day) triple. */
export const daysFromCivil = (y0, m, d) => {
  const y = m <= 2 ? y0 - 1 : y0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of daysFromCivil: day count since 1970-01-01 back to a civil triple. */
const civilFromDays = (days) => {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: m <= 2 ? y + 1 : y, m, d }
}

/** Parse an ISO `YYYY-MM-DD` prefix into a day count; null when not a date. */
export const parseIsoDays = (value) => {
  if (typeof value !== "string") return null
  const match = ISO_DATE.exec(value)
  if (match === null) return null
  const y = Number(match[1] ?? "")
  const m = Number(match[2] ?? "")
  const d = Number(match[3] ?? "")
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) ? daysFromCivil(y, m, d) : null
}

/** Format a day count as ISO `YYYY-MM-DD`. */
export const formatIsoDate = (days) => {
  const { y, m, d } = civilFromDays(days)
  const pad = (n, w) => String(n).padStart(w, "0")
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}
