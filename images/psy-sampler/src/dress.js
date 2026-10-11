// A seed's take on a sound. The autopilot "dresses" every sound it brings in:
// its params move around the factory values and a melodic part may get
// another synth of its group. Each draw comes from the seed AND the sound's
// id, so a seed always gives the same kick and the same bass synth, whatever
// order the sounds come in. FX lengths stay: they time the transitions.
import { SYNTHS } from "./audio/params.js";
import { defOf, defaultData, paramSpecs } from "./audio/patterns.js";
import { seeded } from "./editing.js";
import { hashSeed } from "./share.js";

const SPREAD = 0.2; // of each slider's range, either way
const KEEP_SYNTH = 0.4;

const snap = (v, { min, max, step }) =>
  Number(Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step)).toFixed(6));

/** { params, synth? }: what the seed changes in `id`'s factory data. */
export function dress(id, seed) {
  const rng = seeded(hashSeed(`${seed}/${id}`));
  const base = defaultData(id);
  const params = { ...base.params };
  for (const p of paramSpecs(id)) {
    if (p.key === "bars") continue;
    params[p.key] = snap(base.params[p.key] + (rng() * 2 - 1) * (p.max - p.min) * SPREAD, p);
  }
  if (defOf(id).kind !== "notes") return { params };
  const { group } = SYNTHS.find((s) => s.id === base.synth);
  const pool = SYNTHS.filter((s) => s.group === group).map((s) => s.id);
  const synth = rng() < KEEP_SYNTH ? base.synth : pool[Math.floor(rng() * pool.length)];
  return { params, synth };
}

// A phrase-end fill: the kick breaks for the last two beats, the percussion
// rolls over them, both, or nothing. From the seed, the section and the
// loop, like a sound's dress, so a section's fills come back with it.
export const FILLS = [null, "break", "roll", "both"];

/** A number in [0, 1) for `seed` and `key`: the same in any browser, and it never touches a track's rng. */
export const coin = (seed, key) => seeded(hashSeed(`${seed}/${key}`))();

/** The fill ending loop `at` of `section` under `seed`. */
export const fillOf = (seed, section, at) => FILLS[Math.floor(coin(seed, `fill/${section}/${at}`) * FILLS.length)];
