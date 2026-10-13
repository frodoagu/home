// A seed's take on a sound. The autopilot "dresses" every sound it brings in:
// its params move around the factory values and a melodic part may get
// another synth of its group. Each draw comes from the seed AND the sound's
// id, so a seed always gives the same kick and the same bass synth, whatever
// order the sounds come in. FX lengths stay: they time the transitions.
import { INSERT_PARAMS, SYNTHS } from "./audio/params.js";
import { DRIVE_TYPES, LFO_SHAPES } from "./audio/insert.js";
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

// The ✨ AI's level high (planner.js LEVELS) also builds each sound's insert
// and echo, from named choices mapped onto values here: "" (or 0) leaves the
// factory's. Every one is a whole choice, so a plan stays small and replays.
export const FILTERS = ["off", "lowpass", "highpass", "bandpass", "vowel a", "vowel e", "vowel i", "vowel o", "vowel u"];
export const SWEEPS = { off: 0, beat: 4, "half bar": 8, bar: 16, "2 bars": 32, "4 bars": 64 }; // steps per LFO cycle
export const TREMOLOS = { off: 0, "1/16": 1, "1/8": 2, "1/4": 4, "1/2": 8 }; // steps per cycle
export const AUTOPANS = { off: 0, slow: 64, fast: 16 }; // steps per swing
export const ECHOES = { off: 0, "1/8": 2, "dotted 1/8": 3, "1/4": 4 }; // steps late
// Each tweak's choices; the unit ones run -MACRO_MAX..MACRO_MAX like the macros.
export const CHOICES = {
  filter: FILTERS,
  sweep: Object.keys(SWEEPS),
  shape: LFO_SHAPES,
  distortion: DRIVE_TYPES,
  trem: Object.keys(TREMOLOS),
  autopan: Object.keys(AUTOPANS),
  echo: Object.keys(ECHOES),
};
export const UNIT_TWEAKS = ["cutoff", "res", "env"];
export const TWEAKS = ["filter", "cutoff", "res", "sweep", "shape", "env", "distortion", "trem", "autopan", "echo"];
// What the low end takes: the kick only grit; the bass a lowpass that may
// open and close per note, but no sweep or swing (they muddy it) and no echo.
const ALLOWED = {
  kick: ["distortion"],
  bass: ["filter", "cutoff", "res", "env", "distortion"],
};
const BASS_FILTERS = ["off", "lowpass"];
const RES_AT = { "-2": 0.5, "-1": 0.8, 1: 5, 2: 12 };
const SWEEP_DEPTH = 0.4;
const ENV_PER = 0.25; // of ENV_CENTS per unit: ±2 octaves at most
const TREM_DEPTH = 0.5;
const AUTOPAN_WIDTH = 0.6;
const CUTOFF = INSERT_PARAMS.find((p) => p.key === "cutoff");

/** May the AI set the tweak `key` of `id` to `value`? */
export function fits(id, key, value) {
  const allowed = ALLOWED[layerOf(id)];
  if (allowed && !allowed.includes(key)) return false;
  if (key === "filter" && layerOf(id) === "bass" && !BASS_FILTERS.includes(value)) return false;
  if (key === "echo" && defOf(id).kind !== "notes") return false;
  if (UNIT_TWEAKS.includes(key)) return Number.isInteger(value) && value !== 0 && Math.abs(value) <= MACRO_MAX;
  return Object.hasOwn(CHOICES, key) && CHOICES[key].includes(value);
}

export const isTweaked = (macros) => TWEAKS.some((k) => Object.hasOwn(macros, k));

// The factory's insert with the AI's tweaks on it.
function tweaked(id, t) {
  const out = { ...defOf(id).data.insert };
  if (t.filter) {
    const [filter, vowel] = t.filter.split(" ");
    out.filter = filter;
    if (vowel) out.vowel = vowel;
  }
  if (t.cutoff) out.cutoff = nudge(out.cutoff, CUTOFF, t.cutoff);
  if (t.res) out.res = RES_AT[t.res];
  if (t.sweep) {
    out.lfo = SWEEPS[t.sweep] ? Math.max(out.lfo, SWEEP_DEPTH) : 0;
    if (SWEEPS[t.sweep]) out.rate = SWEEPS[t.sweep];
  }
  if (t.shape) out.shape = t.shape;
  if (t.env) out.env = t.env * ENV_PER;
  if (t.distortion) out.drive = t.distortion;
  if (t.trem) {
    out.trem = TREMOLOS[t.trem] ? TREM_DEPTH : 0;
    if (TREMOLOS[t.trem]) out.tremRate = TREMOLOS[t.trem];
  }
  if (t.autopan) {
    out.width = AUTOPANS[t.autopan] ? AUTOPAN_WIDTH : 0;
    if (AUTOPANS[t.autopan]) out.panRate = AUTOPANS[t.autopan];
  }
  return out;
}

// The insert keys the AI sets: drive and motion over the factory's, and with
// tweaks every key they reach, so a dress replaces the one before it whole.
const MACRO_KEYS = ["drive", "amount", "phaser", "lfo"];
const TWEAK_KEYS = ["filter", "vowel", "cutoff", "res", "rate", "shape", "env", "trem", "tremRate", "width", "panRate"];

function insertOf(id, macros) {
  const { drive = 0, motion = 0 } = macros;
  const base = isTweaked(macros) ? tweaked(id, macros) : defOf(id).data.insert;
  const keys = isTweaked(macros) ? [...MACRO_KEYS, ...TWEAK_KEYS] : MACRO_KEYS;
  const out = Object.fromEntries(keys.map((k) => [k, base[k]]));
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
 * { params, synth?, insert?, echo? }: `id` dressed by the seed and then by
 * the AI's `macros` (a plan's dress entry, or null). `insert` is the live
 * one: only the keys the AI sets change, so the autopilot's tone rides stay.
 * A melodic sound's dress with tweaks sets its echo too (or the factory's).
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
  if (isTweaked(macros) && defOf(id).kind === "notes") {
    const steps = ECHOES[macros.echo];
    out.echo = macros.echo ? (steps ? { steps, semis: 0 } : null) : (defaultData(id).echo ?? null);
  }
  return out;
}

// A phrase-end fill: the kick breaks for the last two beats, the percussion
// rolls over them, both, or nothing. From the seed, the section and the
// loop, like a sound's dress, so a section's fills come back with it. The
// kick breaks on a third of the phrases (FILL_WEIGHTS), so a section runs on.
export const FILLS = [null, "break", "roll", "both"];
const FILL_WEIGHTS = [2, 1, 2, 1];
const FILL_TOTAL = FILL_WEIGHTS.reduce((a, b) => a + b);

/** A number in [0, 1) for `seed` and `key`: the same in any browser, and it never touches a track's rng. */
export const coin = (seed, key) => seeded(hashSeed(`${seed}/${key}`))();

/** The fill ending loop `at` of `section` under `seed`. */
export function fillOf(seed, section, at) {
  let r = coin(seed, `fill/${section}/${at}`) * FILL_TOTAL;
  return FILLS.find((_, i) => (r -= FILL_WEIGHTS[i]) < 0) ?? null;
}
