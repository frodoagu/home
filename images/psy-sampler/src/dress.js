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

// The ✨ AI's take on a sound (planner.js `dress`): four macros from -2 to 2,
// 0 leaving the seed's dress, and maybe another synth of the group. They move
// the seed's and the factory's values, never the live ones, so a plan
// replays the same whatever came before it.
export const MACROS = ["tone", "length", "drive", "motion"];
export const MACRO_MAX = 2;
// No motion on these: a phaser or a filter sweep on the kick or the bass muddies the low end.
export const STILL = ["kick", "bass"];
const MACRO_STEP = 0.15; // of a slider's range per unit, in octaves where it has no 0
const TONE_KEYS = ["tone", "f0", "click", "bright"];
const LENGTH_KEYS = ["decay", "sweep"];
const DRIVE_AT = [0, 0.4, 0.75]; // the least drive amount per unit up
const PHASER_PER = 0.25;
const LFO_PER = 0.3;

const layerOf = (id) => id.split(".")[0];
const twentieth = (v) => Math.round(v * 20) / 20; // the insert sliders' 0.05 steps

function nudge(v, p, units) {
  if (p.min > 0) return snap(v * (p.max / p.min) ** (units * MACRO_STEP), p);
  return snap(v + units * MACRO_STEP * (p.max - p.min), p);
}

/** The synths a melodic sound may switch to: its own group's ([] for a drum or an FX). */
export function synthsFor(id) {
  if (defOf(id).kind !== "notes") return [];
  const { group } = SYNTHS.find((s) => s.id === defOf(id).data.synth);
  return SYNTHS.filter((s) => s.group === group).map((s) => s.id);
}

/** May `macro` move `id`? */
export const moves = (id, macro) => macro !== "motion" || !STILL.includes(layerOf(id));

// The insert keys the AI sets, from the factory's: drive and motion.
function insertOf(id, { drive = 0, motion = 0 }) {
  const base = defOf(id).data.insert;
  const out = { drive: base.drive, amount: base.amount, phaser: base.phaser, lfo: base.lfo };
  if (drive < 0) {
    if (drive <= -MACRO_MAX || base.drive === "off") out.drive = "off";
    else out.amount = twentieth(base.amount / 2);
  } else if (drive > 0) {
    if (base.drive === "off") out.drive = drive >= MACRO_MAX ? "hard" : "soft";
    out.amount = Math.max(base.amount, DRIVE_AT[drive]);
  }
  if (!moves(id, "motion") || !motion) return out;
  if (motion < 0) {
    out.phaser = motion <= -MACRO_MAX ? 0 : twentieth(base.phaser / 2);
    out.lfo = motion <= -MACRO_MAX ? 0 : twentieth(base.lfo / 2);
  } else {
    out.phaser = Math.max(base.phaser, twentieth(motion * PHASER_PER));
    if (base.filter !== "off") out.lfo = Math.max(base.lfo, twentieth(motion * LFO_PER));
  }
  return out;
}

/**
 * { params, synth?, insert? }: `id` dressed by the seed and then by the AI's
 * `macros` (a plan's dress entry, or null). `insert` is the live one: only
 * the drive and motion keys change, so the autopilot's tone rides stay.
 */
export function restyle(id, seed, macros, insert) {
  const out = dress(id, seed);
  if (!macros) return out;
  for (const p of paramSpecs(id)) {
    const macro = TONE_KEYS.includes(p.key) ? "tone" : LENGTH_KEYS.includes(p.key) ? "length" : null;
    if (macro && macros[macro]) out.params[p.key] = nudge(out.params[p.key], p, macros[macro]);
  }
  if (macros.synth && synthsFor(id).includes(macros.synth)) out.synth = macros.synth;
  if (insert) out.insert = { ...insert, ...insertOf(id, macros) };
  return out;
}

// A phrase-end fill: the kick breaks for the last two beats, the percussion
// rolls over them, both, or nothing. From the seed, the section and the
// loop, like a sound's dress, so a section's fills come back with it.
export const FILLS = [null, "break", "roll", "both"];

/** A number in [0, 1) for `seed` and `key`: the same in any browser, and it never touches a track's rng. */
export const coin = (seed, key) => seeded(hashSeed(`${seed}/${key}`))();

/** The fill ending loop `at` of `section` under `seed`. */
export const fillOf = (seed, section, at) => FILLS[Math.floor(coin(seed, `fill/${section}/${at}`) * FILLS.length)];
