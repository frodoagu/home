// Pure edits behind the editors. Every function returns new data and never
// mutates its input, so the UI can hand the result straight to the engine.
import { ACCENT, HIT, MOD_DEFAULTS, OFF, cleanMod } from "./audio/patterns.js";
import { isRoot } from "./audio/music.js";
import { BAR_STEPS, LOOP_STEPS } from "./audio/timing.js";

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

// Drum data with the bar starting at `from` replaced by the build-up, mods
// and all, read in place: a roll has no "sometimes" and no speed.
export function withBuildUp(data, from) {
  const steps = data.steps.slice();
  const mods = data.mods.slice();
  BUILD_UP.forEach((v, i) => {
    steps[(from + i) % steps.length] = v;
    mods[(from + i) % steps.length] = null;
  });
  return { ...data, steps, mods, speed: 1, iter: 1, echo: null };
}

// Bar overlays: what a sound plays for one bar (a drop's gap, a phrase-end
// fill), laid over its data and taken off on the next bar line. Like the
// build-up they read their bar in place: no speed, iter or echo.
const inPlace = (data, steps, mods) => ({ ...data, steps, mods, speed: 1, iter: 1, echo: null });

/** Nothing at all, drums and notes alike: kick and bass in the bar before a drop. */
export function silenced(data) {
  if (data.notes) return { ...data, notes: [], echo: null };
  return inPlace(data, data.steps.map(() => OFF), data.mods.map(() => null));
}

// A fill takes the last two beats of the bar before a new phrase.
export const FILL_STEPS = BAR_STEPS / 2;
// The percussion's fill: 8ths, then 16ths, the last two accented.
export const ROLL = [HIT, OFF, HIT, OFF, HIT, HIT, ACCENT, ACCENT];

function fillBar(data, from, pattern) {
  const steps = data.steps.slice();
  const mods = data.mods.slice();
  pattern.forEach((v, i) => {
    const at = (from + BAR_STEPS - FILL_STEPS + i) % steps.length;
    steps[at] = v;
    mods[at] = null;
  });
  return inPlace(data, steps, mods);
}

/** A break: the bar starting at `from` loses its last two beats (a kick's fill). */
export const withBreak = (data, from) => fillBar(data, from, Array(FILL_STEPS).fill(OFF));

/** A roll over the last two beats of the bar starting at `from` (a drum's fill). */
export const withRoll = (data, from) => fillBar(data, from, ROLL);

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
  return addNote(notes, step, midi, len, false);
}

function addNote(notes, step, midi, len, accent) {
  const nextStart = Math.min(
    LOOP_STEPS,
    ...notes.filter((n) => n.midi === midi && n.step > step).map((n) => n.step),
  );
  return [...notes, { step, midi, len: Math.min(len, nextStart - step), accent }];
}

// The same 16th in every beat of the bar holding `step`, or of both bars.
export function beatEchoes(step, bothBars = false) {
  const from = bothBars ? 0 : step - (step % BAR_STEPS);
  const beats = (bothBars ? LOOP_STEPS : BAR_STEPS) / 4;
  return Array.from({ length: beats }, (_, k) => from + (step % 4) + 4 * k);
}

// Ctrl+click on the drum grid: the clicked step's new state on all its echoes.
export function cycleStepEcho(steps, i, bothBars = false) {
  const v = cycleStep(steps, i)[i];
  const out = steps.slice();
  for (const s of beatEchoes(i, bothBars)) out[s] = v;
  return out;
}

/**
 * Ctrl+click on the piano roll: the clicked note's new state (note, accent or
 * gone) on every echo of its start in that row. A cell already inside a
 * longer note is left alone.
 */
export function cycleNoteEcho(notes, step, midi, len, bothBars = false) {
  const hit = noteAt(notes, step, midi);
  const state = !hit ? HIT : hit.accent ? OFF : ACCENT;
  let out = notes;
  // From the last echo back, so each new note is shortened by the ones after it.
  for (const s of beatEchoes(hit ? hit.step : step, bothBars).reverse()) {
    const head = out.find((n) => n.midi === midi && n.step === s);
    if (state === OFF) {
      if (head) out = out.filter((n) => n !== head);
    } else if (head) {
      out = out.map((n) => (n === head ? { ...n, accent: state === ACCENT } : n));
    } else if (!noteAt(out, s, midi)) {
      out = addNote(out, s, midi, len, state === ACCENT);
    }
  }
  return out;
}

// Drag on a row: the dragged span wins over whatever it covers on that row.
export function placeNote(notes, step, midi, len) {
  const end = Math.min(LOOP_STEPS, step + len);
  const kept = notes.filter((n) => n.midi !== midi || n.step + n.len <= step || n.step >= end);
  return [...kept, { step, midi, len: end - step, accent: false }];
}

/* ---------------------------------------------------------------- mods -- */

// Mods only live on hits: whatever sits on an empty step goes.
export const pruneMods = (steps, mods) => mods.map((m, s) => (steps[s] ? m : null));

/**
 * The mod brush: `key` set to `value` on `mod` (one hit's or one note's).
 * Painting a value that is already there takes it off, so a second click
 * undoes the first.
 */
export function brushMod(mod, key, value) {
  const next = { ...cleanMod(mod) };
  next[key] = mod?.[key] === value ? MOD_DEFAULTS[key] : value;
  return cleanMod(next);
}

// A note with `mod` as its mod keys, in the shape sanitize() writes.
const noteWith = (n, mod) => {
  const { step, midi, len, accent } = n;
  return { step, midi, len, accent, ...mod };
};

/**
 * Brush click on the drum grid: an empty step gets a hit carrying the brush;
 * a hit gets brushMod(). `echo` (Ctrl+click) puts the clicked step's result
 * on the same 16th of every beat of its bar, or of both bars.
 */
export function brushStep(data, i, key, value, { echo = false, bothBars = false } = {}) {
  const mod = data.steps[i] ? brushMod(data.mods[i], key, value) : brushMod(null, key, value);
  const steps = data.steps.slice();
  const mods = data.mods.slice();
  for (const s of echo ? beatEchoes(i, bothBars) : [i]) {
    steps[s] ||= HIT;
    mods[s] = mod;
  }
  return { steps, mods };
}

/**
 * The brush on every hit at once (Strudel's `.sometimes()` on a whole
 * pattern). When they all carry it already, it comes off all of them.
 */
export function brushAllSteps(data, key, value) {
  const hits = data.steps.flatMap((v, s) => (v ? [s] : []));
  const off = hits.length > 0 && hits.every((s) => data.mods[s]?.[key] === value);
  const mods = data.mods.map((m, s) => {
    if (!data.steps[s]) return null;
    return cleanMod({ ...m, [key]: off ? MOD_DEFAULTS[key] : value });
  });
  return { mods };
}

/**
 * Brush click on the piano roll: the note under the cell gets brushMod();
 * an empty cell gets a new `len` note carrying the brush. `echo` as in
 * brushStep(), on the note's start; a cell inside a longer note is left alone.
 */
export function brushNote(notes, step, midi, len, key, value, { echo = false, bothBars = false } = {}) {
  const hit = noteAt(notes, step, midi);
  const mod = brushMod(hit ? cleanMod(hit) : null, key, value);
  let out = notes;
  for (const s of (echo ? beatEchoes(hit ? hit.step : step, bothBars) : [hit ? hit.step : step]).reverse()) {
    const head = out.find((n) => n.midi === midi && n.step === s);
    if (head) out = out.map((n) => (n === head ? noteWith(n, mod) : n));
    else if (!noteAt(out, s, midi)) {
      const added = addNote(out, s, midi, len, false);
      out = [...out, noteWith(added.at(-1), mod)];
    }
  }
  return out;
}

// brushAllSteps() for notes.
export function brushAllNotes(notes, key, value) {
  const off = notes.length > 0 && notes.every((n) => n[key] === value);
  return notes.map((n) => noteWith(n, cleanMod({ ...n, [key]: off ? MOD_DEFAULTS[key] : value })));
}

/* ------------------------------------------------------ pattern tools -- */

const wrap = (s) => ((s % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;

// Each note kept inside the loop and clear of the next one on its row.
function tidy(notes) {
  const sorted = [...notes].sort((a, b) => a.step - b.step || a.midi - b.midi);
  return sorted
    .filter((n, i) => !sorted.slice(0, i).some((o) => o.midi === n.midi && o.step === n.step))
    .map((n) => {
      const next = Math.min(LOOP_STEPS, ...sorted.filter((o) => o.midi === n.midi && o.step > n.step).map((o) => o.step));
      return { ...n, len: Math.min(n.len, next - n.step) };
    });
}

// Drum steps (and their mods) or notes moved by `move(step)`.
function remap(data, kind, move) {
  if (kind === "drum") {
    const steps = Array(LOOP_STEPS).fill(OFF);
    const mods = Array(LOOP_STEPS).fill(null);
    data.steps.forEach((v, s) => {
      steps[move(s)] = v;
      mods[move(s)] = data.mods[s];
    });
    return { steps, mods };
  }
  return { notes: tidy(data.notes.map((n) => ({ ...n, step: move(n.step) }))) };
}

// Strudel's early / late by one 16th: the part `by` steps later, wrapping.
export const rotatePart = (data, kind, by) => remap(data, kind, (s) => wrap(s + by));

/**
 * The part backwards around its first step (a retrograde): step s goes to
 * -s, so what sat on the beat stays on a beat and an offbeat stays an
 * offbeat; notes keep their length.
 */
export const reversePart = (data, kind) => remap(data, kind, (s) => wrap(-s));

/**
 * Bjorklund's `k` hits as evenly as possible over `n` steps, the same
 * pattern as Strudel's euclid(k, n), started `rot` steps in (euclidRot).
 */
export function euclid(k, n, rot = 0) {
  let a = Array.from({ length: k }, () => [1]);
  let b = Array.from({ length: n - k }, () => [0]);
  while (b.length > 1 && a.length > 0) {
    const m = Math.min(a.length, b.length);
    const rest = a.length > m ? a.slice(m) : b.slice(m);
    a = a.slice(0, m).map((x, i) => [...x, ...b[i]]);
    b = rest;
  }
  const one = [...a, ...b].flat();
  return Array.from({ length: n }, (_, i) => one[(i + rot) % n]);
}

/**
 * A drum row from euclid(): the n-step cycle repeats across the loop, so an
 * n that does not divide 32 runs against the bar (a polymeter) and restarts
 * on every loop.
 */
export function euclidSteps(k, n, rot = 0) {
  const cycle = euclid(k, n, rot);
  const steps = Array.from({ length: LOOP_STEPS }, (_, s) => (cycle[s % n] ? HIT : OFF));
  return { steps, mods: Array(LOOP_STEPS).fill(null) };
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

/* ------------------------------------------------------- the AI's parts -- */

// A plan's part (planner.js `parts`) is written in scale degrees: "1" the
// part's root, "8" the octave up, "-" a rest.
export const REST = "-";
export const DEGREE_MAX = 15;
export const DEGREES = [REST, ...Array.from({ length: DEGREE_MAX }, (_, i) => String(i + 1))];
// How many degrees each style writes: a lead's motif and its answer, a pad's
// chord per bar, a bass's one-beat cell.
export const PART_LENGTHS = { lead: 16, pad: 2, bass: 4 };

const cycle = (list, n) => Array.from({ length: n }, (_, i) => list[i % list.length]);

/**
 * The 2-bar part a plan's `degrees` make for a `style` variant over `rows`,
 * or null when they hold no note. The genre's habits do the rest, as in
 * improvise(): a lead plays motif, motif (its last note a degree lower),
 * motif, answer; a lead made of chords or long notes keeps the factory's
 * rhythm and shapes and walks them onto the degrees instead; a pad holds a
 * triad on each bar's degree; a bass repeats its cell under every beat.
 */
export function writePart(style, degrees, rows, factory = []) {
  const n = PART_LENGTHS[style];
  if (!n || !Array.isArray(degrees) || !degrees.length) return null;
  const asc = [...rows].sort((a, b) => a - b);
  const roots = asc.filter(isRoot);
  const base = style === "lead" ? (roots[Math.floor(roots.length / 2) - 1] ?? roots[0]) : roots[0];
  const from = Math.max(0, asc.indexOf(base ?? asc[0]));
  const row = (i) => asc[Math.max(0, Math.min(asc.length - 1, i))];
  const at = (d) => (d === REST ? null : from + Number(d) - 1);
  const ds = cycle(degrees, n).map(at);
  const out = [];
  if (style === "bass") {
    for (let s = 0; s < LOOP_STEPS; s++) {
      const i = ds[s % 4];
      if (i !== null) out.push({ step: s, midi: row(i), len: 1, accent: false });
    }
  } else if (style === "pad") {
    ds.forEach((i, bar) => {
      if (i === null) return;
      for (const k of [0, 2, 4]) out.push({ step: bar * BAR_STEPS, midi: row(i + k), len: BAR_STEPS, accent: false });
    });
  } else {
    const sounding = ds.filter((i) => i !== null);
    if (!sounding.length) return null;
    const byStep = new Map();
    for (const note of factory) byStep.set(note.step, [...(byStep.get(note.step) ?? []), note]);
    const shaped = [...byStep.values()].some((g) => g.length > 1) || factory.some((note) => note.len > 1);
    if (shaped) {
      const nearest = (midi) => asc.reduce((best, m, i) => (Math.abs(m - midi) < Math.abs(asc[best] - midi) ? i : best), 0);
      [...byStep.keys()]
        .sort((a, b) => a - b)
        .forEach((step, k) => {
          const group = byStep.get(step);
          const shift = sounding[k % sounding.length] - nearest(Math.min(...group.map((note) => note.midi)));
          for (const note of group) out.push({ ...note, midi: row(nearest(note.midi) + shift) });
        });
    } else {
      const a = ds.slice(0, 8);
      const last = a.findLastIndex((i) => i !== null);
      const question = a.map((i, k) => (k === last && i !== null ? i - 1 : i));
      [a, question, a, ds.slice(8)].forEach((phrase, p) => {
        const first = phrase.findIndex((i) => i !== null);
        phrase.forEach((i, k) => {
          if (i !== null) out.push({ step: p * 8 + k, midi: row(i), len: 1, accent: k === first });
        });
      });
    }
  }
  return out.length ? dedupe(out) : null;
}
