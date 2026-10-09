// Pure edits behind the editors. Every function returns new data and never
// mutates its input, so the UI can hand the result straight to the engine.
import { ACCENT, OFF } from "./audio/patterns.js";
import { isRoot } from "./audio/music.js";
import { LOOP_STEPS } from "./audio/timing.js";

// Drum grid click: off -> hit -> accent -> off.
export function cycleStep(steps, i) {
  const next = steps.slice();
  next[i] = steps[i] === ACCENT ? OFF : steps[i] + 1;
  return next;
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
