// Every variant as editable data, plus the lookup that turns that data into
// the events voices.js plays. Three kinds:
//
//   drum   { steps: [32 × OFF|HIT|ACCENT], params, level }       one voice
//   notes  { notes: [{step, midi, len, accent}], synth, params,
//            level, scale, transpose, len }                       piano roll
//   fx     { params, level }                                      one-shot
//
// DEFAULTS holds the factory data; the UI keeps edited copies and hands them
// to the engine, which passes them back into eventsAt() on every step.
import { NOTE, SCALES, midiToFreq } from "./music.js";
import { LEVEL, PARAMS, SYNTH_IDS, paramDefaults } from "./params.js";
import { LOOP_STEPS } from "./timing.js";

export const OFF = 0;
export const HIT = 1;
export const ACCENT = 2;

const { A1, Bb1, E2, G2, A2, Bb2, C3, D3, E3, F3, G3, A3, Bb3, B3, C4, D4, E4, F4, G4, A4, C5, D5, E5, A5 } = NOTE;

export const KICK_PUNCHY = { f0: 170, f1: 50, sweep: 0.07, decay: 0.2, click: 1 };
export const KICK_LONG = { f0: 120, f1: 42, sweep: 0.16, decay: 0.34, click: 0 };
export const KICK_TOK = { f0: 230, f1: 58, sweep: 0.035, decay: 0.12, click: 1 };
export const KICK_FULLON = { f0: 150, f1: 46, sweep: 0.1, decay: 0.26, click: 0.6 };
export const KICK_TECHNO = { f0: 200, f1: 52, sweep: 0.05, decay: 0.32, click: 0.8 };
export const KICK_RUMBLE = { f0: 110, f1: 38, sweep: 0.2, decay: 0.6, click: 0.3 };
export const KICK_PROG = { f0: 140, f1: 48, sweep: 0.09, decay: 0.24, click: 0.4 };
export const KICK_PSYTECH = { f0: 190, f1: 55, sweep: 0.045, decay: 0.16, click: 0.9 };
export const KICK_DARK = { f0: 250, f1: 62, sweep: 0.025, decay: 0.09, click: 1 };

// 16-step acid line in A minor; null is a rest, accents open the filter further.
export const ACID_LINE = [
  { note: A2, accent: true }, { note: A2 }, null, { note: A3 },
  { note: A2 }, { note: C3 }, null, { note: A2, accent: true },
  { note: E3 }, { note: A2 }, null, { note: G3 },
  { note: A2, accent: true }, null, { note: C3 }, { note: D3 },
];

// Same, in Phrygian: the B♭ against the root is the dark-psy colour.
export const ACID_DARK = [
  { note: A2, accent: true }, { note: A2 }, { note: Bb2 }, { note: A2 },
  null, { note: A3 }, { note: A2 }, { note: Bb2, accent: true },
  { note: A2 }, null, { note: E3 }, { note: A2 },
  { note: Bb2 }, null, { note: A2, accent: true }, { note: G2 },
];

export const ARP_NOTES = [A3, C4, E4, A4];
export const ARP3_NOTES = [A3, E4, A4]; // 3 against 4: the cycle drifts across the beat
export const MELODY = [A4, C5, G4, E4]; // one note every 8 steps, ends on E to pull back to A
export const PAD_CHORD = [A3, C4, E4];
export const STAB_CHORD = [A4, C5, E5];
export const STAB_STEPS = [3, 6, 11, 19, 22, 27, 30];
export const HITECH_ROLL = [null, A1, A2, E2]; // per beat, after the kick
export const BELL_LINE = [
  [0, A4], [3, C5], [6, E5], [10, D5], [12, C5],
  [16, A4], [19, C5], [22, E5], [26, G4], [28, A4],
];
export const TECHNO_CHORD = [A3, C4, E4, G4]; // Am7
export const TOM_LINE = [
  [3, A3], [7, E3], [11, A3], [14, G3], [19, A3], [23, E3],
  [27, C4], [28, A3], [29, G3], [30, E3], [31, C3],
];

const steps = (fn) => Array.from({ length: LOOP_STEPS }, (_, s) => fn(s));
const note = (step, midi, len = 1, accent = false) => ({ step, midi, len, accent });
const every = (fn) => steps(fn).filter(Boolean);

function drum(voice, pattern, params = {}) {
  return { kind: "drum", voice, data: { steps: pattern, params: { ...paramDefaults(voice), ...params }, level: 1 } };
}

// low/high: the piano roll's range. `len` is what a click adds.
function notes(synth, list, { low, high, len = 1, scale = "minor" }) {
  return {
    kind: "notes",
    low,
    high,
    data: { notes: list, synth, params: paramDefaults("synth"), level: 1, scale, transpose: 0, len },
  };
}

function fx(id) {
  return { kind: "fx", data: { params: paramDefaults(id), level: 1 } };
}

const BEATS = steps((s) => (s % 4 === 0 ? HIT : OFF));
const BASS = { low: A1, high: A3 };
const LEAD = { low: A2, high: A5 };
const PAD = { low: A2, high: A4 };

export const DEFAULTS = {
  "kick.punchy": drum("kick", BEATS, KICK_PUNCHY),
  "kick.long": drum("kick", BEATS, KICK_LONG),
  "kick.tok": drum("kick", BEATS, KICK_TOK),
  "kick.fullon": drum("kick", BEATS, KICK_FULLON),
  "kick.techno": drum("kick", BEATS, KICK_TECHNO),
  "kick.rumble": drum("kick", BEATS, KICK_RUMBLE),
  "kick.prog": drum("kick", BEATS, KICK_PROG),
  "kick.psytech": drum("kick", BEATS, KICK_PSYTECH),
  "kick.dark": drum("kick", BEATS, KICK_DARK),

  // Step positions: s % 4 === 0 is a beat (kick), s % 4 === 2 the offbeat.
  "bass.offbeat": notes("bass", every((s) => s % 4 === 2 && note(s, A1)), BASS),
  "bass.rolling": notes("bass", every((s) => s % 4 !== 0 && note(s, A1)), BASS),
  "bass.rollingOct": notes("bass", every((s) => s % 4 !== 0 && note(s, s % 4 === 2 ? A2 : A1)), BASS),
  "bass.gallop": notes("bass", every((s) => s % 4 >= 2 && note(s, A1)), BASS),
  "bass.fm": notes("fmBass", every((s) => s % 4 !== 0 && note(s, s % 16 === 15 ? E2 : A1, 1, s % 4 === 1)), BASS),
  "bass.prog": notes("sub", every((s) => s % 4 === 2 && note(s, s === 30 ? G2 : A1, 2)), { ...BASS, len: 2 }),
  "bass.techno": notes("reese", every((s) => (s % 8 === 2 || s % 8 === 7) && note(s, A1, s % 8 === 2 ? 2 : 1)), BASS),
  "bass.hitech": notes("fmBass", every((s) => s % 4 !== 0 && note(s, HITECH_ROLL[s % 4])), BASS),
  "bass.phrygian": notes(
    "bass",
    every((s) => s % 4 !== 0 && note(s, s % 16 >= 13 ? Bb1 : A1)),
    { ...BASS, scale: "phrygian" },
  ),

  "perc.hat": drum("hat", steps((s) => (s % 4 === 2 ? HIT : OFF))),
  "perc.chat": drum("chat", steps((s) => (s % 2 === 1 ? HIT : OFF))),
  "perc.shaker": drum("shaker", steps((s) => (s % 2 === 0 ? ACCENT : HIT))),
  "perc.clap": drum("clap", steps((s) => (s % 8 === 4 ? HIT : OFF))), // beats 2 and 4
  "perc.snare": drum("snare", steps((s) => (s % 8 === 4 ? ACCENT : s >= 29 ? HIT : OFF))), // + roll into the loop
  "perc.ride": drum("ride", steps((s) => (s % 4 === 2 ? ACCENT : s % 4 === 0 ? HIT : OFF))),
  "perc.toms": notes("tom", TOM_LINE.map(([s, m]) => note(s, m)), { low: A2, high: A4 }),
  "perc.hat16": drum("chat", steps((s) => (s % 4 === 2 ? ACCENT : HIT)), { tone: 10000, decay: 0.03 }),
  "perc.rim": drum("rim", steps((s) => ([3, 6, 11, 14].includes(s % 16) ? HIT : OFF))),

  "lead.acid": notes(
    "acid",
    every((s) => {
      const n = ACID_LINE[s % 16];
      return n && note(s, n.note, 1, Boolean(n.accent));
    }),
    { low: A1, high: A4 },
  ),
  "lead.arp": notes("arp", every((s) => note(s, ARP_NOTES[s % 4])), LEAD),
  "lead.arp3": notes("pluck", every((s) => note(s, ARP3_NOTES[s % 3])), LEAD),
  "lead.melodic": notes("lead", MELODY.map((m, i) => note(i * 8, m, 8)), { ...LEAD, len: 8 }),
  "lead.stabs": notes("supersaw", STAB_STEPS.flatMap((s) => STAB_CHORD.map((m) => note(s, m))), LEAD),
  "lead.zap": notes("zap", every((s) => s % 2 === 0 && note(s, s % 8 === 6 ? E4 : A3, 1, s % 8 === 0)), LEAD),
  "lead.bell": notes("fmBell", BELL_LINE.map(([s, m]) => note(s, m, 2)), { ...LEAD, len: 2 }),
  "lead.acidPhryg": notes(
    "acid",
    every((s) => {
      const n = ACID_DARK[s % 16];
      return n && note(s, n.note, 1, Boolean(n.accent));
    }),
    { low: A1, high: A4, scale: "phrygian" },
  ),
  "lead.techno": notes("analog", [3, 11, 19, 27].flatMap((s) => TECHNO_CHORD.map((m) => note(s, m, 2))), {
    ...LEAD,
    len: 2,
  }),

  "pad.chord": notes("pad", [0, 16].flatMap((s) => PAD_CHORD.map((m) => note(s, m, 16))), { ...PAD, len: 16 }),
  // i -> bII: the Phrygian move that sounds like psy.
  "pad.prog": notes(
    "pad",
    [...PAD_CHORD.map((m) => note(0, m, 16)), ...[Bb3, D4, F4].map((m) => note(16, m, 16))],
    { ...PAD, len: 16 },
  ),
  "pad.drone": notes("drone", [note(0, A2, 32), note(0, E3, 32)], { low: A1, high: A3, len: 32 }),
  "pad.air": notes("air", [note(0, A4, 32)], { low: A3, high: A5, len: 32 }),
  "pad.sus": notes(
    "pad",
    [...[A3, D4, E4].map((m) => note(0, m, 16)), ...PAD_CHORD.map((m) => note(16, m, 16))],
    { ...PAD, len: 16 },
  ),
  "pad.dark": notes("drone", [A2, Bb2, E3].map((m) => note(0, m, 32)), { low: A1, high: A3, len: 32, scale: "phrygian" }),
  // i -> VI -> VII: the progressive lift.
  "pad.epic": notes(
    "pad",
    [
      ...PAD_CHORD.map((m) => note(0, m, 16)),
      ...[F3, A3, C4].map((m) => note(16, m, 8)),
      ...[G3, B3, D4].map((m) => note(24, m, 8)),
    ],
    { ...PAD, len: 16 },
  ),
  "pad.supersaw": notes("supersaw", [A3, C4, E4, A4].map((m) => note(0, m, 32)), { ...PAD, len: 32 }),
  "pad.fifths": notes("pad", [A2, E3, A3].map((m) => note(0, m, 32)), { ...PAD, len: 32 }),

  "fx.riser": fx("fx.riser"),
  "fx.riserImpact": fx("fx.riserImpact"),
  "fx.down": fx("fx.down"),
  "fx.sweep": fx("fx.sweep"),
  "fx.impact": fx("fx.impact"),
  "fx.zap": fx("fx.zap"),
  "fx.crash": fx("fx.crash"),
  "fx.siren": fx("fx.siren"),
  "fx.reverse": fx("fx.reverse"),
};

export const LOOP_VARIANTS = Object.keys(DEFAULTS).filter((id) => DEFAULTS[id].kind !== "fx");

/*
 * A duplicated variant ("kick.punchy~2") is its base variant with its own
 * data: same kind, voice and range, so everything keyed on the variant
 * resolves through the base.
 */
export const COPY_MARK = "~";
export const baseOf = (id) => id.split(COPY_MARK)[0];
export const defOf = (id) => DEFAULTS[baseOf(id)];
export const isCopy = (id) => id.includes(COPY_MARK);
export const isVariant = (id) =>
  typeof id === "string" && Boolean(defOf(id)) && (!isCopy(id) || /^[^~]+~[1-9]\d{0,5}$/.test(id));

export const defaultData = (id) => structuredClone(defOf(id).data);

// Which PARAMS spec a variant's sliders come from.
export function paramSpecs(id) {
  const def = defOf(id);
  if (def.kind === "drum") return PARAMS[def.voice];
  if (def.kind === "notes") return PARAMS.synth;
  return PARAMS[baseOf(id)] ?? [];
}

/**
 * Events variant `id` plays on `step`. Notes start on their own step; on
 * `entering` (the lane's first step) notes already in progress also start,
 * with whatever is left of them, so a pad switched on mid-phrase sounds now
 * instead of up to 2 bars later.
 */
export function eventsAt(id, step, entering = false, data = defOf(id)?.data) {
  const def = defOf(id);
  if (!def || def.kind === "fx") return [];
  if (def.kind === "drum") {
    const v = data.steps[step];
    return v ? [{ voice: def.voice, ...data.params, accent: v === ACCENT }] : [];
  }
  const events = [];
  for (const n of data.notes) {
    const left =
      n.step === step ? n.len : entering && n.step < step && n.step + n.len > step ? n.step + n.len - step : 0;
    if (left) {
      events.push({
        voice: data.synth,
        ...data.params,
        freq: midiToFreq(n.midi + data.transpose),
        steps: left,
        accent: n.accent,
      });
    }
  }
  return events;
}

// One note (or hit) to preview in the editor, outside the loop.
export function auditionEvent(id, data, { midi, accent = false } = {}) {
  const def = defOf(id);
  if (def.kind === "drum") return { voice: def.voice, ...data.params, accent };
  if (def.kind === "notes") {
    return { voice: data.synth, ...data.params, freq: midiToFreq(midi + data.transpose), steps: 2, accent };
  }
  return null;
}

/* -------------------------------------------------- stored data check -- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export const NOTE_LENGTHS = [1, 2, 4, 8, 16, 32];
export const TRANSPOSE = [-24, -12, 0, 12, 24];

/**
 * Rebuilds variant data from whatever localStorage returned: every field is
 * checked against the default's shape and anything off falls back to the
 * factory value, so a stale or hand-edited entry can never break playback.
 */
export function sanitize(id, saved) {
  const base = defaultData(id);
  if (!saved || typeof saved !== "object") return base;
  const def = defOf(id);
  const out = { ...base };

  out.level = Number.isFinite(saved.level) ? clamp(saved.level, LEVEL.min, LEVEL.max) : base.level;
  const params = { ...base.params };
  for (const p of paramSpecs(id)) {
    const v = saved.params?.[p.key];
    if (Number.isFinite(v)) params[p.key] = clamp(v, p.min, p.max);
  }
  out.params = params;

  if (def.kind === "drum" && Array.isArray(saved.steps) && saved.steps.length === LOOP_STEPS) {
    out.steps = saved.steps.map((v) => (isInt(v, OFF, ACCENT) ? v : OFF));
  }
  if (def.kind === "notes") {
    if (Array.isArray(saved.notes)) {
      out.notes = saved.notes
        .filter((n) => n && isInt(n.step, 0, LOOP_STEPS - 1) && isInt(n.midi, 12, 108) && isInt(n.len, 1, LOOP_STEPS - n.step))
        .map((n) => note(n.step, n.midi, n.len, n.accent === true));
    }
    if (SYNTH_IDS.includes(saved.synth)) out.synth = saved.synth;
    if (saved.scale in SCALES) out.scale = saved.scale;
    if (TRANSPOSE.includes(saved.transpose)) out.transpose = saved.transpose;
    if (NOTE_LENGTHS.includes(saved.len)) out.len = saved.len;
  }
  return out;
}
