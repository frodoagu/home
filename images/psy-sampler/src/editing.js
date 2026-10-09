// Pure edits behind the editors. Every function returns new data and never
// mutates its input, so the UI can hand the result straight to the engine.
import { ACCENT, HIT, OFF } from "./audio/patterns.js";
import { isRoot } from "./audio/music.js";
import { LOOP_STEPS } from "./audio/timing.js";

// Drum grid click: off -> hit -> accent -> off.
export function cycleStep(steps, i) {
  const next = steps.slice();
  next[i] = steps[i] === ACCENT ? OFF : steps[i] + 1;
  return next;
}

/**
 * ×2: a new hit halfway between each marked hit and the next one (wrapping
 * around the loop), so quarters become 8ths and 8ths become 16ths. A gap of
 * one step has no middle and stays as it is.
 */
export function doubleSteps(steps) {
  const hits = steps.flatMap((v, s) => (v === OFF ? [] : [s]));
  const out = steps.slice();
  hits.forEach((s, i) => {
    const next = hits[i + 1] ?? hits[0] + steps.length;
    const half = Math.floor((next - s) / 2);
    if (half) out[(s + half) % steps.length] = HIT;
  });
  return out;
}

// One bar whose rate doubles as it goes: half a bar of quarters, a quarter
// of 8ths, then a run of accented 16ths into the next bar.
export const BUILD_UP = [
  HIT, OFF, OFF, OFF, HIT, OFF, OFF, OFF,
  HIT, OFF, HIT, OFF, ACCENT, ACCENT, ACCENT, ACCENT,
];

// `steps` with the bar starting at `from` replaced by the build-up.
export function withBuildUp(steps, from) {
  const out = steps.slice();
  BUILD_UP.forEach((v, i) => {
    out[(from + i) % out.length] = v;
  });
  return out;
}

export const noteAt = (notes, step, midi) =>
  notes.find((n) => n.midi === midi && n.step <= step && n.step + n.len > step);

/**
 * Piano-roll click, same cycle as the drum grid: an empty cell gets a new
 * note of `len` 16ths (shortened so it never runs into the next note on that
 * row or past the loop end); clicking a note accents it, clicking an accented
 * note deletes it.
 */
export function cycleNote(notes, step, midi, len) {
  const hit = noteAt(notes, step, midi);
  if (hit) {
    return hit.accent ? notes.filter((n) => n !== hit) : notes.map((n) => (n === hit ? { ...n, accent: true } : n));
  }
  const nextStart = Math.min(
    LOOP_STEPS,
    ...notes.filter((n) => n.midi === midi && n.step > step).map((n) => n.step),
  );
  return [...notes, { step, midi, len: Math.min(len, nextStart - step), accent: false }];
}

// Drag on a row: the dragged span wins over whatever it covers on that row.
export function placeNote(notes, step, midi, len) {
  const end = Math.min(LOOP_STEPS, step + len);
  const kept = notes.filter((n) => n.midi !== midi || n.step + n.len <= step || n.step >= end);
  return [...kept, { step, midi, len: end - step, accent: false }];
}

/* ------------------------------------------------------- improvisation -- */

// Small seeded PRNG (mulberry32) so tests can pin an improvisation.
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

// Improvisation style of a variant: its layer, except pitched percussion.
export const styleOf = (id) => (id.startsWith("perc.") ? "perc" : id.split(".")[0]);

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/**
 * A new 2-bar part over `rows` (the editor's scale rows, highest first).
 * Not random noise: each style follows the genre's habits.
 *   bass  rolling 16ths between the kicks, mostly on the root
 *   lead  an 8-step motif played A A' A B, so it repeats like a riff
 *   pad   one triad per bar built on scale degrees
 *   perc  sparse pitched hits leaning on the offbeats, with a fill at the end
 */
export function improvise(style, rows, rng = Math.random) {
  const asc = [...rows].sort((a, b) => a - b);
  const roots = asc.filter(isRoot);
  const root = roots[0] ?? asc[0];
  if (style === "bass") return improviseBass(asc, root, rng);
  if (style === "pad") return improvisePad(asc, rng);
  if (style === "perc") return improvisePerc(asc, rng);
  // Leads start around the middle root so the motif has room both ways.
  return improviseLead(asc, roots.length ? roots[Math.floor(roots.length / 2)] : root, rng);
}

function improviseBass(asc, root, rng) {
  const near = asc.filter((m) => m > root && m <= root + 12);
  const rhythm = pick([[1, 2, 3], [2], [2, 3], [1, 2, 3]], rng);
  const out = [];
  for (let s = 0; s < LOOP_STEPS; s++) {
    if (!rhythm.includes(s % 4)) continue;
    const fill = s >= 28 && rng() < 0.6;
    const midi = fill || rng() < 0.15 ? pick(near.length ? near : [root], rng) : root;
    out.push({ step: s, midi, len: 1, accent: false });
  }
  return out;
}

function improviseLead(asc, center, rng) {
  let idx = Math.max(0, asc.indexOf(center));
  const motif = () => {
    const m = [];
    for (let i = 0; i < 8; i++) {
      if (rng() > (i % 2 === 0 ? 0.75 : 0.5)) continue;
      idx = Math.min(asc.length - 1, Math.max(0, idx + pick([-2, -1, -1, 0, 1, 1, 2, 3], rng)));
      m.push({ at: i, midi: asc[idx], accent: rng() < 0.2 });
    }
    return m.length ? m : [{ at: 0, midi: center, accent: true }];
  };
  const a = motif();
  const b = motif();
  const variant = a.map((n, i) => (i >= a.length - 2 ? { ...n, midi: pick(asc, rng) } : n));
  const out = [];
  [a, variant, a, b].forEach((m, k) => {
    for (const n of m) out.push({ step: k * 8 + n.at, midi: n.midi, len: 1, accent: n.accent });
  });
  return dedupe(out);
}

function improvisePad(asc, rng) {
  const out = [];
  for (const start of [0, 16]) {
    const base = pick(asc.slice(0, Math.max(1, asc.length - 4)), rng);
    const i = asc.indexOf(base);
    for (const k of [0, 2, 4]) out.push({ step: start, midi: asc[Math.min(asc.length - 1, i + k)], len: 16, accent: false });
  }
  return dedupe(out);
}

function improvisePerc(asc, rng) {
  const out = [];
  for (let s = 0; s < LOOP_STEPS; s++) {
    const chance = s >= 26 ? 0.7 : s % 4 === 2 ? 0.5 : s % 4 === 0 ? 0.05 : 0.2;
    if (rng() < chance) out.push({ step: s, midi: pick(asc, rng), len: 1, accent: rng() < 0.25 });
  }
  return out;
}

// Two notes on the same row and step are one note.
function dedupe(notes) {
  const seen = new Set();
  return notes.filter((n) => {
    const key = `${n.step}:${n.midi}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ---------------------------------------------------------- variations -- */

/**
 * How many changes one variation makes at `amount` (0-1, the improvise
 * slider): none at 0, 1-2 at the default 0.5, 6-7 at 1.
 */
export const IMPROV_DEFAULT = 0.5;
export const changesFor = (amount, rng) => Math.floor(6 * amount * amount + rng());

/**
 * The improvise toggle: a light variation of `notes` (the part the user
 * chose), never a rewrite. Each change does one of: move a note to a nearby
 * row (further at a higher `amount`), flip an accent, echo a note a few steps
 * later, or drop one. Callers always vary the original, not the last
 * variation, so the part breathes around what was written instead of
 * drifting away from it.
 */
export function varyNotes(notes, rows, rng = Math.random, amount = IMPROV_DEFAULT) {
  const asc = [...rows].sort((a, b) => a - b);
  const changes = changesFor(amount, rng);
  const reach = 1 + Math.round(Math.max(0, amount - 0.5) * 4);
  let out = notes.map((n) => ({ ...n }));
  const fits = (list, n, skip) =>
    list.every((o) => o === skip || o.midi !== n.midi || o.step + o.len <= n.step || o.step >= n.step + n.len);
  for (let c = 0; c < changes && out.length; c++) {
    const target = pick(out, rng);
    const r = rng();
    if (r < 0.5) {
      const i = asc.indexOf(target.midi);
      const jump = (1 + Math.floor(rng() * reach)) * (rng() < 0.5 ? -1 : 1);
      const midi = asc[Math.max(0, Math.min(asc.length - 1, (i < 0 ? 0 : i) + jump))];
      const moved = { ...target, midi };
      if (fits(out, moved, target)) out = out.map((n) => (n === target ? moved : n));
    } else if (r < 0.75) {
      out = out.map((n) => (n === target ? { ...n, accent: !n.accent } : n));
    } else if (r < 0.9 || out.length <= 2) {
      const step = target.step + pick([2, 3, 4], rng);
      const echo = { step, midi: target.midi, len: 1, accent: false };
      if (step < LOOP_STEPS && fits(out, echo)) out = [...out, echo];
    } else {
      out = out.filter((n) => n !== target);
    }
  }
  return out;
}

/**
 * Same idea for a drum row: flip an accent or a ghost hit, only off the beat,
 * so the pulse (and a kick's four-on-the-floor) never moves.
 */
export function varySteps(steps, rng = Math.random, amount = IMPROV_DEFAULT) {
  const out = steps.slice();
  const offBeat = out.map((_, s) => s).filter((s) => s % 4 !== 0);
  const changes = changesFor(amount, rng);
  for (let c = 0; c < changes; c++) {
    const s = pick(offBeat, rng);
    out[s] = out[s] === OFF ? HIT : out[s] === HIT ? (rng() < 0.5 ? OFF : ACCENT) : HIT;
  }
  return out;
}

/* -------------------------------------------------------- new melodies -- */

/**
 * The autopilot's new part for a variant, from its factory notes. A lead
 * made of chords or long notes keeps that rhythm and those chord shapes and
 * walks them to new scale degrees; any other lead, and every other style, gets
 * a fresh improvise() part.
 */
export function newPart(style, factory, rows, rng = Math.random) {
  if (style !== "lead") return improvise(style, rows, rng);
  const byStep = new Map();
  for (const n of factory) byStep.set(n.step, [...(byStep.get(n.step) ?? []), n]);
  const shaped = [...byStep.values()].some((g) => g.length > 1) || factory.some((n) => n.len > 1);
  if (!shaped) return improvise("lead", rows, rng);
  const asc = [...rows].sort((a, b) => a - b);
  const nearest = (midi) =>
    asc.reduce((best, m, i) => (Math.abs(m - midi) < Math.abs(asc[best] - midi) ? i : best), 0);
  const out = [];
  let shift = pick([-2, -1, 0, 1, 2], rng);
  for (const step of [...byStep.keys()].sort((a, b) => a - b)) {
    shift = Math.max(-4, Math.min(4, shift + pick([-2, -1, 0, 0, 1, 2], rng)));
    for (const n of byStep.get(step)) {
      const i = Math.max(0, Math.min(asc.length - 1, nearest(n.midi) + shift));
      out.push({ ...n, midi: asc[i] });
    }
  }
  return dedupe(out);
}
