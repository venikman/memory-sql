/**
 * The single seeded PRNG of the product. Determinism is a hard requirement
 * (SPEC): generators, binding samplers, and mutators all draw from an Rng made
 * here — never Math.random, never Date.now. Same seed => same stream => same
 * world => same report, which is what makes validation runs comparable.
 *
 * Implementation: splitmix32 — tiny, fast, well distributed, and stable across
 * platforms (only 32-bit integer ops and one division).
 */

export interface Rng {
  /** The seed this stream was created from. */
  readonly seed: number
  /** Uniform integer in [min, max], both inclusive. */
  readonly int: (min: number, max: number) => number
  /** Uniform element of a non-empty array; throws on empty (programmer error). */
  readonly pick: <T>(items: readonly T[]) => T
  /** True with the given probability in [0, 1]. */
  readonly chance: (probability: number) => boolean
  /** Uniform float in [min, max); defaults to [0, 1). */
  readonly float: (min?: number, max?: number) => number
  /** Deterministic uuid-shaped identifier (8-4-4-4-12 hex). */
  readonly uuid: () => string
  /** Fisher-Yates shuffled copy (input untouched). */
  readonly shuffle: <T>(items: readonly T[]) => T[]
}

export const makeRng = (seed: number): Rng => {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z ^= z >>> 16
    z = Math.imul(z, 0x21f0aaad)
    z ^= z >>> 15
    z = Math.imul(z, 0x735a2d97)
    z ^= z >>> 15
    return (z >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`makeRng.int: max ${max} < min ${min}`)
    return min + Math.floor(next() * (max - min + 1))
  }

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("makeRng.pick: empty array")
    return items[int(0, items.length - 1)] as T
  }

  const chance = (probability: number): boolean => next() < probability

  const float = (min = 0, max = 1): number => min + next() * (max - min)

  const uuid = (): string => {
    const hex = (): string => int(0, 15).toString(16)
    const run = (n: number): string => Array.from({ length: n }, hex).join("")
    return `${run(8)}-${run(4)}-${run(4)}-${run(4)}-${run(12)}`
  }

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i)
      const tmp = out[i] as T
      out[i] = out[j] as T
      out[j] = tmp
    }
    return out
  }

  return { seed, int, pick, chance, float, uuid, shuffle }
}
