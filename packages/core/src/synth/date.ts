/**
 * Pure civil-date arithmetic (Howard Hinnant's algorithms), shared by the
 * generator, the CQ engine, and the metamorphic engine. The store holds ISO
 * strings and the SPEC bans Date construction in generators, engines, and
 * reports, so every date computation in the product is integer day math end
 * to end — deterministic on every platform, no wall clock, no Date object.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/** Days since the civil epoch 1970-01-01 for a (year, month 1-12, day) triple. */
export const daysFromCivil = (y0: number, m: number, d: number): number => {
  const y = m <= 2 ? y0 - 1 : y0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of daysFromCivil: day count since 1970-01-01 back to a civil triple. */
export const civilFromDays = (
  days: number
): { readonly y: number; readonly m: number; readonly d: number } => {
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
export const parseIsoDays = (value: unknown): number | null => {
  if (typeof value !== "string") return null
  const match = ISO_DATE.exec(value)
  if (match === null) return null
  const y = Number(match[1] ?? "")
  const m = Number(match[2] ?? "")
  const d = Number(match[3] ?? "")
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  return daysFromCivil(y, m, d)
}

/** Format a day count as ISO `YYYY-MM-DD`. */
export const formatIsoDate = (days: number): string => {
  const { y, m, d } = civilFromDays(days)
  const pad = (n: number, w: number): string => String(n).padStart(w, "0")
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}
