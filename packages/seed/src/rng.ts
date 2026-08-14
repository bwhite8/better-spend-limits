/**
 * A tiny deterministic PRNG plus the sampling helpers the generator needs.
 *
 * Everything in `@bsl/seed` must be reproducible: `generateOrg(42)` has to
 * produce byte-identical data on every machine, forever, so that fixtures,
 * mock-API state and the seeded database all agree. That rules out
 * `Math.random()` and rules out any dependency whose implementation could
 * change between versions — hence mulberry32 written out in full below.
 *
 * The one rule for callers: draw values in a FIXED ORDER. Adding a draw in the
 * middle of the generator shifts every subsequent value, which is fine for
 * correctness but changes the whole synthetic universe (and therefore the
 * fixtures). Append new draws at the end of a phase where practical.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number;
  /** True with the given probability (0 → never, 1 → always). */
  bool(probability: number): boolean;
  /** Uniform choice from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates copy; the input is not mutated. */
  shuffle<T>(items: readonly T[]): T[];
  /** Standard normal sample scaled to `mean`/`stdDev` (Box–Muller). */
  normal(mean: number, stdDev: number): number;
  /** `exp(normal(mu, sigma))` — the heavy right tail real spend data has. */
  logNormal(mu: number, sigma: number): number;
}

/**
 * mulberry32: 32 bits of state, excellent distribution for our purposes, and
 * short enough to audit at a glance.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (max < min) throw new RangeError(`int(${min}, ${max}): max must be >= min`);
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError("pick() called on an empty list");
    return items[int(0, items.length - 1)]!;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const swap = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = swap;
    }
    return copy;
  };

  const normal = (mean: number, stdDev: number): number => {
    // Box–Muller needs a strictly positive first sample.
    let u = next();
    while (u === 0) u = next();
    const v = next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  return {
    next,
    int,
    bool: (probability: number) => next() < probability,
    pick,
    shuffle,
    normal,
    logNormal: (mu: number, sigma: number) => Math.exp(normal(mu, sigma)),
  };
}
