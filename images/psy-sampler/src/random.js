// Seeded randomness: the one PRNG behind seeds, improvisations, dressing and
// the voices' scatter, so anything drawn from a seed replays the same.

// mulberry32: a 32-bit state, uniform in [0, 1).
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (list, rng) => list[Math.floor(rng() * list.length)];
