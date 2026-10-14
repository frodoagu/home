// Every variant as editable data, plus the lookup that turns that data into
// the events voices.js plays. Three kinds:
//
//   drum   { steps: [32 × OFF|HIT|ACCENT], mods: [32 × mod|null],
//            params, level }                                      one voice
//   notes  { notes: [{step, midi, len, accent, ...mod}], synth,
//            params, level, scale, transpose, len, loops }        piano roll
//
// A notes part is `loops` 2-bar loops long (PART_LOOPS): its steps run up to
// loops × 32, and from the second loop on it plays on from where the first
// left off.
//   fx     { params, level }                                      one-shot
//
// All three also carry `insert` (its filter and distortion, insert.js) and
// `sample`: null, or a user's sample { id, name, pitch, start, length,
// reverse } that plays instead of the voice. A sample event names the voice
// it replaces as `fallback`, which plays whenever the sample is not loaded.
//
// A mod (Strudel's sometimes / every / ply, Elektron's trig conditions) rides
// on one hit or note: { p, cond, ply }, each key only when it is not the
// default. See passes() below.
//
// DEFAULTS holds the factory data; the UI keeps edited copies and hands them
// to the engine, which passes them back into eventsAt() on every step.
import { CLASSICS, midiOf } from "./classics.js";
import { DRIVE_TYPES, FILTER_TYPES, INSERT_DEFAULT, LFO_RATES, LFO_SHAPES, TREM_RATES, VOWELS } from "./insert.js";
import { NOTE, SCALES, midiToFreq } from "./music.js";
import { GROOVE_PARAMS, INSERT_PARAMS, LEVEL, PARAMS, SAMPLE_PARAMS, SYNTH_IDS, paramDefaults } from "./params.js";
import { LOOP_STEPS } from "./timing.js";

// How many 2-bar loops a notes part can run.
export const PART_LOOPS = [1, 2, 3, 4, 6, 8];

export const OFF = 0;
export const HIT = 1;
export const ACCENT = 2;

const { A1, Bb1, C2, E2, G2, A2, Bb2, C3, D3, E3, F3, G3, A3, Bb3, B3, C4, D4, E4, F4, G4, A4, C5, D5, E5, A5 } = NOTE;

export const KICK_PUNCHY = { f0: 170, f1: 50, sweep: 0.07, decay: 0.2, click: 1 };
export const KICK_LONG = { f0: 120, f1: 42, sweep: 0.16, decay: 0.34, click: 0 };
export const KICK_TOK = { f0: 230, f1: 58, sweep: 0.035, decay: 0.12, click: 1 };
export const KICK_FULLON = { f0: 150, f1: 46, sweep: 0.1, decay: 0.26, click: 0.6 };
export const KICK_TECHNO = { f0: 200, f1: 52, sweep: 0.05, decay: 0.32, click: 0.8 };
export const KICK_RUMBLE = { f0: 110, f1: 38, sweep: 0.2, decay: 0.6, click: 0.3 };
export const KICK_PROG = { f0: 140, f1: 48, sweep: 0.09, decay: 0.24, click: 0.4 };
export const KICK_PSYTECH = { f0: 190, f1: 55, sweep: 0.045, decay: 0.16, click: 0.9 };
export const KICK_DARK = { f0: 250, f1: 62, sweep: 0.025, decay: 0.09, click: 1 };
export const KICK_HOUSE = { f0: 160, f1: 47, sweep: 0.06, decay: 0.3, click: 0.7 };
export const KICK_TECHHOUSE = { f0: 175, f1: 50, sweep: 0.05, decay: 0.22, click: 0.5 };

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
// Hi-tech 16ths in Phrygian, the B♭ rubbing against the root.
export const BITS_LINE = [[0, A3], [2, A3], [3, Bb3], [6, E4], [8, A3], [10, C4], [11, Bb3], [14, G3]];
export const TOM_LINE = [
  [3, A3], [7, E3], [11, A3], [14, G3], [19, A3], [23, E3],
  [27, C4], [28, A3], [29, G3], [30, E3], [31, C3],
];
// Progressive lift over 2 bars: climbs to E5, answers from G4 and lands on D5.
export const SOARING_LINE = [
  [0, A4, 3], [3, C5, 3], [6, E5, 4], [10, D5, 2], [12, C5, 4],
  [16, G4, 3], [19, C5, 3], [22, D5, 2], [24, E5, 6], [30, D5, 2],
];
// Every note answered by its own echo a dotted 8th later, written in.
export const GRID_LINE = [[0, A3], [6, E4], [12, C4], [16, A3], [22, G4], [28, E4]];
export const GRID_ECHO = 3;
// House organ bass: one note per offbeat, the octave answering once a bar, climbing to C at the end.
export const HOUSE_BASS = [
  [2, A1], [6, A1], [10, A1], [11, A2], [14, G2],
  [18, A1], [22, A1], [26, C2], [27, C3], [30, E2],
];
// Tech house: short plucks around the offbeat, accented on it.
export const TECH_BASS = [
  [2, A1, true], [3, A1], [7, A1], [10, A1, true], [11, A1], [14, E2],
  [18, A1, true], [19, A1], [23, A1], [26, A1, true], [28, G2], [30, A1],
];
// Deep house: long round notes off the beat with air between them, pumping under the kick.
export const DEEP_BASS = [
  [3, A1, 3], [7, A1], [10, C2, 2], [14, A1],
  [19, A1, 3], [23, A1], [26, E2, 2], [30, G2],
];
export const BONGO_LINE = [
  [3, E4], [6, A3], [7, A3], [11, E4], [14, A3],
  [19, E4], [22, A3], [23, A3], [26, C4], [27, E4], [30, A3],
];
// Piano house: x..x..x...x.x... on Am7, then Dm7 over the same A and C.
export const PIANO_HITS = [0, 3, 6, 10, 12];
export const PIANO_CHORDS = [[A3, C4, E4, G4], [A3, C4, D4, F4]];
export const ORGAN_STEPS = [2, 6, 10, 13, 18, 22, 26, 29];
export const ORGAN_CHORD = [A3, E4, G4, C5]; // Am7, open
// Am9 -> Dm9 without their roots: C and E stay, the rest steps down.
export const DEEP_CHORDS = [[G3, B3, C4, E4], [F3, A3, C4, E4]];

const steps = (fn) => Array.from({ length: LOOP_STEPS }, (_, s) => fn(s));
const note = (step, midi, len = 1, accent = false, mod = null) => ({ step, midi, len, accent, ...mod });
const every = (fn) => steps(fn).filter(Boolean);

// How a loop reads its part (Strudel's fast/slow, iter and off): the speed,
// how many parts the loop start moves through, and an echo { steps, semis }.
const PLAYBACK = { speed: 1, iter: 1, echo: null };

// Where it sits: `swing` delays every odd 16th by that much of a step,
// `nudge` moves every hit by ms, `duck` is how deep the kick pumps it.
const GROOVE = { swing: 0, nudge: 0, duck: 0 };

// What every variant starts with on top of its own data.
const extras = (insert = {}) => ({ insert: { ...INSERT_DEFAULT, ...insert }, sample: null });

function drum(voice, pattern, params = {}) {
  return {
    kind: "drum",
    voice,
    data: {
      steps: pattern,
      mods: Array(LOOP_STEPS).fill(null),
      ...PLAYBACK,
      ...GROOVE,
      params: { ...paramDefaults(voice), ...params },
      level: 1,
      ...extras(),
    },
  };
}

// low/high: the piano roll's range. `len` is what a click adds.
function notes(synth, list, { low, high, len = 1, scale = "minor", insert }) {
  return {
    kind: "notes",
    low,
    high,
    data: {
      notes: list,
      ...PLAYBACK,
      ...GROOVE,
      synth,
      params: paramDefaults("synth"),
      level: 1,
      scale,
      transpose: 0,
      len,
      loops: 1,
      ...extras(insert),
    },
  };
}

// A variant whose odd 16ths land late from the start (GROOVE swing).
const swung = (def, swing) => ({ ...def, data: { ...def.data, swing } });
// A notes variant that starts from another "Brillo" (the tom's: its decay).
// A variant that starts pumping under the kick by `duck`.
const ducked = (def, duck) => ({ ...def, data: { ...def.data, duck } });
// A notes variant whose part runs `loops` 2-bar loops (PART_LOOPS).
const looped = (def, loops) => ({ ...def, data: { ...def.data, loops } });
const bright = (def, value) => ({ ...def, data: { ...def.data, params: { ...def.data.params, bright: value } } });

function fx(id) {
  return { kind: "fx", data: { params: paramDefaults(id), level: 1, ...extras() } };
}

const BEATS = steps((s) => (s % 4 === 0 ? HIT : OFF));
const BASS = { low: A1, high: A3 };
const LEAD = { low: A2, high: A5 };
const PAD = { low: A2, high: A4 };
// A classic's roll spans its melody, from the A below to the A above, and
// its part as many loops as the melody needs.
const A_BELOW = (midi) => midi - (((midi - 9) % 12) + 12) % 12;
function classic({ synth, notes: list, speed = 1 }) {
  const midis = list.map(([, p]) => midiOf(p));
  const end = Math.max(...list.map(([s, , len]) => s + len));
  const def = notes(synth, list.map(([s, p, len]) => note(s, midiOf(p), len)), {
    low: A_BELOW(Math.min(...midis)),
    high: A_BELOW(Math.max(...midis) + 11),
    scale: "chromatic",
  });
  def.data.speed = speed;
  def.data.loops = PART_LOOPS.find((n) => n * LOOP_STEPS >= end);
  return def;
}

/**
 * Björklund's Euclidean rhythm (Toussaint): `k` onsets spread as evenly as
 * they go over `n` steps, as 0/1, turned `rotate` steps later. Pulses and
 * rests start as single groups; the remainder is appended onto the front
 * groups until one group or none is left over, like Euclid's GCD.
 */
export function euclid(k, n, rotate = 0) {
  if (k <= 0) return Array(n).fill(0);
  if (k >= n) return Array(n).fill(1);
  let front = Array.from({ length: k }, () => [1]);
  let rest = Array.from({ length: n - k }, () => [0]);
  while (rest.length > 1) {
    const m = Math.min(front.length, rest.length);
    const paired = front.slice(0, m).map((group, i) => [...group, ...rest[i]]);
    rest = front.length > m ? front.slice(m) : rest.slice(m);
    front = paired;
  }
  const flat = [...front, ...rest].flat();
  return flat.map((_, i) => flat[(((i - rotate) % n) + n) % n]);
}

// E(k, 16) on each bar, turned `rotations[bar]` steps: the accents move,
// the groove stays.
const euclidBars = (k, rotations, accent = () => false) => {
  const bars = rotations.map((r) => euclid(k, 16, r));
  return steps((s) => (bars[Math.floor(s / 16)][s % 16] ? (accent(s) ? ACCENT : HIT) : OFF));
};

// A note per onset of E(k, 16), walking `line` hit by hit.
const euclidLine = (k, rotate, line, accent) => {
  const bar = euclid(k, 16, rotate);
  let i = 0;
  return every((s) => bar[s % 16] && note(s, line[i++ % line.length], 1, accent(s)));
};

export const SQUELCH_LINE = [A3, A3, A4, A3, C4, A3, A3, E4, A3, G3, A3];
export const INSECT_LINE = [A3, A3, Bb3, A3, E4, A3, F3, A3, Bb3];
// 6 steps against the loop's 32: the phrase comes back to the 1 every 3 loops.
export const MORPH_PHRASE = [[0, A3, 3], [3, E4, 2], [5, C4, 1]];
export const MORPH_LOOPS = 3;

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
  "kick.house": drum("kick", BEATS, KICK_HOUSE),
  "kick.techHouse": drum("kick", BEATS, KICK_TECHHOUSE),

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
  "bass.house": notes("organBass", HOUSE_BASS.map(([s, m]) => note(s, m)), BASS),
  "bass.deep": ducked(notes("sub", DEEP_BASS.map(([s, m, len]) => note(s, m, len)), BASS), 0.35),
  "bass.techHouse": notes("bass", TECH_BASS.map(([s, m, accent]) => note(s, m, 1, Boolean(accent))), BASS),
  "bass.wavetable": notes(
    "wavetable",
    every((s) => s % 4 !== 0 && note(s, s === 31 ? G2 : s % 16 === 15 ? E2 : A1, 1, s % 4 === 1)),
    BASS,
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
  "perc.keys": drum("keys", steps((s) => (s % 8 === 6 ? ACCENT : [3, 9].includes(s % 16) ? HIT : OFF))),
  "perc.shuffle": swung(drum("chat", steps((s) => (s % 4 === 2 ? ACCENT : s % 2 ? HIT : OFF))), 0.16),
  "perc.bongos": bright(notes("tom", BONGO_LINE.map(([s, m]) => note(s, m)), { low: A2, high: A4 }), 0.6),
  "perc.euclid5": drum("rim", euclidBars(5, [2, 2], (s) => s % 16 === 2), { tone: 2400, decay: 0.03 }),
  "perc.euclid7": drum("shaker", euclidBars(7, [0, 2], (s) => s % 4 === 2)),

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
  // Ships with a resonant lowpass wobbling over 2 bars: the insert at work.
  "lead.bits": notes(
    "bitLead",
    [0, 16].flatMap((bar) => BITS_LINE.map(([s, m]) => note(bar + s, bar && s === 14 ? E4 : m))),
    { ...LEAD, scale: "phrygian", insert: { filter: "lowpass", cutoff: 2200, res: 7, lfo: 0.45, rate: 32 } },
  ),
  "lead.chirp": notes(
    "chirp",
    every((s) => s % 4 >= 2 && note(s, s % 16 === 15 ? E5 : s % 8 === 3 ? C5 : A4, 1, s % 4 === 2)),
    LEAD,
  ),
  "lead.soaring": notes("glide", SOARING_LINE.map(([s, m, len]) => note(s, m, len)), { ...LEAD, len: 2 }),
  "lead.grid": notes(
    "pluck",
    GRID_LINE.flatMap(([s, m]) => [note(s, m, 1, true), note(s + GRID_ECHO, m)]),
    LEAD,
  ),
  "lead.vowel": notes(
    "vowel",
    every((s) => [2, 3, 6, 10, 11, 14].includes(s % 16) && note(s, s % 16 === 11 ? Bb3 : s % 16 === 14 ? C4 : A3, 1, s % 8 === 2)),
    { ...LEAD, scale: "phrygian" },
  ),
  "lead.rubber": notes(
    "rubber",
    every((s) => (s % 8 === 3 || s % 8 === 6) && note(s, s % 16 === 14 ? G3 : s % 16 === 11 ? C4 : A3, 1, s % 16 === 3)),
    LEAD,
  ),

  "lead.squelch": notes("squelch", euclidLine(11, 15, SQUELCH_LINE, (s) => s % 4 === 2), LEAD),
  "lead.insect": notes("insect", euclidLine(9, 1, INSECT_LINE, (s) => s % 8 === 3), { ...LEAD, scale: "phrygian" }),
  "lead.morph": looped(
    notes(
      "morph",
      Array.from({ length: (MORPH_LOOPS * LOOP_STEPS) / 6 }, (_, r) =>
        MORPH_PHRASE.map(([s, m, len]) => note(r * 6 + s, m, len, s === 0)),
      ).flat(),
      { ...LEAD, len: 2 },
    ),
    MORPH_LOOPS,
  ),

  "lead.piano": notes(
    "piano",
    [0, 1].flatMap((bar) => PIANO_HITS.flatMap((s) => PIANO_CHORDS[bar].map((m) => note(bar * 16 + s, m, 2)))),
    { ...LEAD, len: 2 },
  ),
  "lead.organ": notes("organ", ORGAN_STEPS.flatMap((s) => ORGAN_CHORD.map((m) => note(s, m))), LEAD),

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
  "pad.grains": notes("grains", PAD_CHORD.map((m) => note(0, m, 32)), { ...PAD, len: 32 }),
  "pad.deep": notes(
    "pad",
    DEEP_CHORDS.flatMap((chord, i) => chord.map((m) => note(i * 16, m, 16))),
    { ...PAD, len: 16 },
  ),

  // Step positions as above; most glitches sit just before a kick or between beats.
  "glitch.stutter": drum("stutter", steps((s) => (s % 16 === 15 ? ACCENT : s % 16 === 14 || s === 7 ? HIT : OFF))),
  "glitch.blips": drum("blip", steps((s) => ([2, 3, 7, 10, 13].includes(s % 16) ? HIT : OFF))),
  "glitch.zips": drum("zip", steps((s) => (s % 4 === 3 ? (s % 16 === 15 ? ACCENT : HIT) : OFF))),
  "glitch.crush": drum("crush", steps((s) => (s % 8 === 6 ? HIT : s === 31 ? ACCENT : OFF))),
  "glitch.metal": drum("metal", steps((s) => ([3, 6, 10, 13].includes(s % 16) ? (s % 16 === 10 ? ACCENT : HIT) : OFF))),
  "glitch.ring": drum("ring", steps((s) => (s % 8 === 5 ? ACCENT : s % 16 === 11 ? HIT : OFF))),
  "glitch.crackle": drum("crackle", steps(() => HIT)),
  "glitch.rise": drum("rise", steps((s) => (s % 8 === 7 ? HIT : OFF))),
  "glitch.tape": drum("tape", steps((s) => (s === 28 ? ACCENT : s === 12 ? HIT : OFF))),
  "glitch.lasers": drum("laser", steps((s) => (s % 4 === 2 ? (s % 16 === 14 ? ACCENT : HIT) : OFF))),

  ...Object.fromEntries(Object.entries(CLASSICS).map(([id, tune]) => [`classic.${id}`, classic(tune)])),

  "fx.riser": fx("fx.riser"),
  "fx.riserImpact": fx("fx.riserImpact"),
  "fx.down": fx("fx.down"),
  "fx.sweep": fx("fx.sweep"),
  "fx.impact": fx("fx.impact"),
  "fx.crash": fx("fx.crash"),
  "fx.siren": fx("fx.siren"),
  "fx.reverse": fx("fx.reverse"),
  "fx.stutter": fx("fx.stutter"),
  "fx.tapeStop": fx("fx.tapeStop"),
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

/* ---------------------------------------------------------------- mods -- */

// Strudel's names for these chances: always, almostAlways, often, sometimes,
// rarely, almostNever.
export const CHANCES = [1, 0.9, 0.75, 0.5, 0.25, 0.1];
export const COND_EVERY = [2, 4, 8];
// "a:b" plays on loop a of every b; "!a:b" on every other loop.
export const CONDS = COND_EVERY.flatMap((b) => Array.from({ length: b }, (_, i) => `${i + 1}:${b}`));
export const PLIES = [1, 2, 3, 4];
export const MOD_KEYS = ["p", "cond", "ply"];
export const MOD_DEFAULTS = { p: 1, cond: null, ply: 1 };

const isCond = (v) => typeof v === "string" && CONDS.includes(v.replace(/^!/, ""));

/** A mod with only its valid, non-default keys, in MOD_KEYS order; null when none is left. */
export function cleanMod(saved) {
  if (!saved || typeof saved !== "object") return null;
  const out = {};
  if (CHANCES.includes(saved.p) && saved.p !== 1) out.p = saved.p;
  if (isCond(saved.cond)) out.cond = saved.cond;
  if (PLIES.includes(saved.ply) && saved.ply !== 1) out.ply = saved.ply;
  return Object.keys(out).length ? out : null;
}

// FNV-1a and a murmur finalizer: a well spread draw in [0, 1).
function draw(id, loop, step) {
  let h = 0x811c9dc5;
  for (const c of `${id}|${loop}|${step}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Whether a hit (or note) starting on `step` with `mod` plays on `loop`
 * (2-bar loops counted from ▶, 0 first). The chance is a draw from id, loop
 * and step, never Math.random: a restart, a WAV export and a share link all
 * hear the same loops, and a chord drops as one.
 */
export function passes(mod, id, step, loop) {
  if (!mod) return true;
  if (mod.cond) {
    const [a, b] = mod.cond.replace("!", "").split(":").map(Number);
    if ((((loop % b) + b) % b === a - 1) === mod.cond.startsWith("!")) return false;
  }
  return mod.p === undefined || draw(id, loop, step) < mod.p;
}

// A ratchet: `n` copies of `ev` inside its `len` steps, each one `offset`
// steps after the first (the engine adds it to the step's time).
function plied(ev, n = 1, len = 1) {
  if (n === 1) return [ev];
  return Array.from({ length: n }, (_, k) => ({ ...ev, offset: (k * len) / n, ...(ev.steps && { steps: ev.steps / n }) }));
}

/* ------------------------------------------------------------ playback -- */

export const SPEEDS = [0.5, 1, 2];
export const ITERS = [1, 2, 4, 8];
export const ECHO_STEPS = [1, 2, 3, 4, 6, 8];
export const ECHO_SEMIS = [-12, 0, 5, 7, 12];

const wrap = (v, n) => ((v % n) + n) % n;

/** How many loop steps a part spans before it repeats. */
export const partSteps = (data) => LOOP_STEPS * (data.loops ?? 1);

// Where in its part a sound is on `step` of `loop`, in part steps (half
// steps at ×½). Iter moves the start on by 1/iter of the part each loop. A
// part longer than a loop counts its loops from `from`, the absolute step
// its lane came in on, so it always starts from its beginning; a 2-bar part
// counts from ▶.
export function positionAt(step, loop, { speed = 1, iter = 1, loops = 1 }, from = 0) {
  const size = LOOP_STEPS * loops;
  const t = loop * LOOP_STEPS + step - (loops > 1 ? from : 0);
  const shift = iter > 1 ? wrap(Math.floor(t / LOOP_STEPS), iter) * (size / iter) : 0;
  return wrap(t * speed + shift, size);
}

// The part steps that start inside `step`: { at, offset } with `offset` the
// fraction of the step where each one lands. ×2 reads two, ×½ one every other.
export function readsAt(step, loop, data, from = 0) {
  const pos = positionAt(step, loop, data, from);
  if (data.speed === 2) return [{ at: pos, offset: 0 }, { at: wrap(pos + 1, partSteps(data)), offset: 0.5 }];
  return Number.isInteger(pos) ? [{ at: pos, offset: 0 }] : [];
}

/**
 * Events variant `id` plays on `step` of `loop`. Notes start on their own step; on
 * `entering` (the lane's first step) notes already in progress also start,
 * with whatever is left of them, so a pad switched on mid-phrase sounds now
 * instead of up to 2 bars later. Mods decide on the step a note starts.
 *
 * A sound with a speed or an iter reads its part out of place, so nothing it
 * plays runs past the loop end, and each loop starts by joining whatever its
 * new position is in the middle of.
 */
// With a sample, the event plays it and keeps its own voice as the fallback.
const withSample = (ev, data) => (data.sample ? { ...ev, voice: "sample", fallback: ev.voice, sample: data.sample } : ev);

export function eventsAt(id, step, entering = false, data = defOf(id)?.data, loop = 0, from = 0) {
  const def = defOf(id);
  if (!def || def.kind === "fx") return [];
  const { speed = 1, iter = 1, echo = null } = data;
  const moved = speed !== 1 || iter > 1;
  const scale = 1 / speed; // loop steps per part step
  const room = moved ? LOOP_STEPS - step : Infinity; // loop steps left before the loop end
  const events = [];
  const at = (offset, list) => list.map((ev) => (offset ? { ...ev, offset: offset + (ev.offset ?? 0) } : ev));
  for (const read of readsAt(step, loop, data, from)) {
    events.push(...at(read.offset, starts(id, def, data, read.at, loop, scale, room - read.offset)));
    if (echo) {
      const copies = starts(id, def, data, wrap(read.at - echo.steps, partSteps(data)), loop, scale, room - read.offset, echo);
      events.push(...at(read.offset, copies));
    }
  }
  if (def.kind === "notes" && (entering || (moved && step === 0))) {
    const pos = positionAt(step, loop, data, from);
    for (const n of data.notes) {
      if (!(n.step < pos && n.step + n.len > pos) || !passes(n, id, n.step, loop)) continue;
      events.push(noteEvent(data, n, Math.min((n.step + n.len - pos) * scale, room)));
    }
  }
  // Swing: everything on an odd 16th lands `swing` of a step late.
  return step % 2 && data.swing ? at(data.swing, events) : events;
}

const noteEvent = (data, n, steps, semis = 0, accent = n.accent) =>
  withSample(
    { voice: data.synth, ...data.params, freq: midiToFreq(n.midi + data.transpose + semis), steps, accent },
    data,
  );

// What starts on part step `at`, `scale` loop steps per part step, cut at
// `room`. An echo copy plays unaccented, transposed and without a ratchet.
function starts(id, def, data, at, loop, scale, room, echo = null) {
  if (def.kind === "drum") {
    const v = data.steps[at];
    const mod = data.mods?.[at];
    if (!v || !passes(mod, id, at, loop)) return [];
    const ev = withSample({ voice: def.voice, ...data.params, accent: !echo && v === ACCENT }, data);
    return echo ? [ev] : plied(ev, mod?.ply, scale);
  }
  const out = [];
  for (const n of data.notes) {
    if (n.step !== at || !passes(n, id, at, loop)) continue;
    const len = Math.min(n.len * scale, room);
    if (echo) out.push(noteEvent(data, n, len, echo.semis, false));
    else out.push(...plied(noteEvent(data, n, len), n.ply, len));
  }
  return out;
}

// One note (or hit) to preview in the editor, outside the loop.
export function auditionEvent(id, data, { midi, accent = false } = {}) {
  const def = defOf(id);
  if (def.kind === "drum") return withSample({ voice: def.voice, ...data.params, accent }, data);
  if (def.kind === "notes") {
    const ev = { voice: data.synth, ...data.params, freq: midiToFreq(midi + data.transpose), steps: 2, accent };
    return withSample(ev, data);
  }
  return null;
}

/* -------------------------------------------------- stored data check -- */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export const NOTE_LENGTHS = [1, 2, 4, 8, 16, 32];
export const TRANSPOSE = [-24, -12, 0, 12, 24];
// What psy-sync hands out: 16 random bytes, base64url.
export const SAMPLE_ID = /^[A-Za-z0-9_-]{16,32}$/;
const SAMPLE_NAME_MAX = 60;

const cleanNumbers = (out, saved, specs) => {
  for (const p of specs) if (Number.isFinite(saved[p.key])) out[p.key] = clamp(saved[p.key], p.min, p.max);
  return out;
};

export function cleanInsert(saved, base = INSERT_DEFAULT) {
  if (!saved || typeof saved !== "object") return { ...base };
  const out = cleanNumbers({ ...base }, saved, INSERT_PARAMS);
  if (FILTER_TYPES.includes(saved.filter)) out.filter = saved.filter;
  if (DRIVE_TYPES.includes(saved.drive)) out.drive = saved.drive;
  if (LFO_RATES.includes(saved.rate)) out.rate = saved.rate;
  if (LFO_RATES.includes(saved.panRate)) out.panRate = saved.panRate;
  if (LFO_RATES.includes(saved.phaserRate)) out.phaserRate = saved.phaserRate;
  if (TREM_RATES.includes(saved.tremRate)) out.tremRate = saved.tremRate;
  if (LFO_SHAPES.includes(saved.shape)) out.shape = saved.shape;
  if (Object.hasOwn(VOWELS, saved.vowel)) out.vowel = saved.vowel;
  return out;
}

export const sampleDefaults = (id, name = "") => ({
  id,
  name: String(name).slice(0, SAMPLE_NAME_MAX),
  ...Object.fromEntries(SAMPLE_PARAMS.map((p) => [p.key, p.def])),
  reverse: false,
});

export function cleanSample(saved) {
  if (!saved || typeof saved !== "object" || !SAMPLE_ID.test(saved.id)) return null;
  const out = cleanNumbers(sampleDefaults(saved.id, typeof saved.name === "string" ? saved.name.trim() : ""), saved, SAMPLE_PARAMS);
  out.reverse = saved.reverse === true;
  return out;
}

// A drum echo repeats the hit: it has no pitch to move.
export function cleanEcho(saved, kind) {
  if (!saved || !ECHO_STEPS.includes(saved.steps) || !ECHO_SEMIS.includes(saved.semis)) return null;
  return { steps: saved.steps, semis: kind === "drum" ? 0 : saved.semis };
}

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
  out.insert = cleanInsert(saved.insert, base.insert);
  out.sample = cleanSample(saved.sample);

  if (def.kind !== "fx") {
    cleanNumbers(out, saved, GROOVE_PARAMS);
    if (def.voice === "kick") out.duck = 0; // the kick is what ducks the rest
  }
  if (SPEEDS.includes(saved.speed)) out.speed = saved.speed;
  if (ITERS.includes(saved.iter)) out.iter = saved.iter;
  out.echo = cleanEcho(saved.echo, def.kind);
  if (def.kind === "drum") {
    if (Array.isArray(saved.steps) && saved.steps.length === LOOP_STEPS) {
      out.steps = saved.steps.map((v) => (isInt(v, OFF, ACCENT) ? v : OFF));
    }
    // A mod lives on a hit: on an empty step it is dropped.
    const mods = Array.isArray(saved.mods) && saved.mods.length === LOOP_STEPS ? saved.mods : base.mods;
    out.mods = mods.map((m, s) => (out.steps[s] ? cleanMod(m) : null));
  }
  if (def.kind === "notes") {
    // Saved before parts could be longer: a 2-bar part.
    if (PART_LOOPS.includes(saved.loops)) out.loops = saved.loops;
    else if (Array.isArray(saved.notes)) out.loops = 1;
    const size = partSteps(out);
    if (Array.isArray(saved.notes)) {
      out.notes = saved.notes
        .filter((n) => n && isInt(n.step, 0, size - 1) && isInt(n.midi, 12, 108) && isInt(n.len, 1, size - n.step))
        .map((n) => note(n.step, n.midi, n.len, n.accent === true, cleanMod(n)));
    }
    if (SYNTH_IDS.includes(saved.synth)) out.synth = saved.synth;
    if (Object.hasOwn(SCALES, saved.scale)) out.scale = saved.scale;
    if (TRANSPOSE.includes(saved.transpose)) out.transpose = saved.transpose;
    if (NOTE_LENGTHS.includes(saved.len)) out.len = saved.len;
  }
  return out;
}
