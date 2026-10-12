// The hooks everyone knows from electronic music, whole, for the "classic"
// layer. Each one is moved to A like every other sound here, so it sits on
// top of any mix; the piano roll is chromatic so every note shows. A part
// runs as many 2-bar loops as its melody needs (patterns.js `loops`), and
// `speed: 0.5` plays one written in eighths at the tempo it is known at.
//
// A melody is written as a run of [pitch, len] in 16ths, pitch in scientific
// notation ("C#5", "Bb4"), null a rest; chords are [step, pitch, len] notes.

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" -> 69, "C#5" -> 73, "Bb4" -> 70. */
export function midiOf(name) {
  const [, letter, accidental, octave] = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + PITCH[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0);
}

/** [[pitch | null, len], ...] one after the other from `step` -> [step, pitch, len] notes. */
export function line(events, step = 0) {
  const out = [];
  for (const [pitch, len] of events) {
    if (pitch) out.push([step, pitch, len]);
    step += len;
  }
  return out;
}

// `count` 16ths of `pitch`, the last one an eighth: Sandstorm's runs.
const run = (pitch, count) => [...Array(count - 1).fill([pitch, 1]), [pitch, 2]];
// Each pitch an eighth apart, played short: Popcorn's staccato.
const eighths = (pitches) => pitches.flatMap((p) => [[p, 1], [null, 1]]);
const each = (pitches, len = 1) => pitches.map((p) => [p, len]);

/* ---- Darude, Sandstorm (1999, B minor): the lead, 4 bars ---- */
const SANDSTORM = [
  ...run("A4", 5), ...run("A4", 7), ...run("D5", 7), ...run("C5", 7), ["G4", 1], ["G4", 1],
  ...[0, 1].flatMap(() => [...run("A4", 5), ...run("A4", 7), ["D5", 1], ["D5", 1]]),
];

/* ---- Harold Faltermeyer, Axel F (1984, F minor; Crazy Frog's in 2005): 4 bars ---- */
const AXEL_F = [
  ["A4", 4], ["C5", 3], ["A4", 2], ["A4", 1], ["D5", 2], ["A4", 2], ["G4", 2],
  ["A4", 4], ["E5", 3], ["A4", 2], ["A4", 1], ["F5", 2], ["E5", 2], ["C5", 2],
  ["A4", 2], ["E5", 2], ["A5", 2], ["A4", 1], ["G4", 2], ["G4", 1], ["E4", 2], ["B4", 2], ["A4", 16], [null, 2],
];

/* ---- Gershon Kingsley, Popcorn (1969; Hot Butter, 1972, B minor): the
   riff twice and its answer, then all of it on the dominant. 16 bars ---- */
const POPCORN_RIFF = eighths(["A4", "G4", "A4", "E4", "C4", "E4", "A3", null]);
const POPCORN_UP = eighths(["E5", "D5", "E5", "B4", "G4", "B4", "E4", null]);
const POPCORN = [
  ...POPCORN_RIFF, ...POPCORN_RIFF,
  ...eighths(["A4", "B4", "C5", "B4", "C5", "A4", "B4", "A4", "B4", "G4", "A4", "G4", "E4", "G4", "A4", null]),
  ...POPCORN_RIFF, ...POPCORN_RIFF,
  ...eighths(["A4", "B4", "C5", "B4", "C5", "A4", "B4", "A4", "B4", "G4", "A4", "G4", "A4", "B4", "C5", null]),
  ...POPCORN_UP, ...POPCORN_UP,
  ...eighths(["E5", "F#5", "G5", "F#5", "G5", "E5", "F#5", "E5", "F#5", "D5", "E5", "D5", "B4", "D5", "E5", null]),
  ...POPCORN_UP, ...POPCORN_UP,
  ...eighths(["E5", "F#5", "G5", "F#5", "G5", "E5", "F#5", "E5", "F#5", "D5", "E5", "D5", "E5", "F#5", "G5", null]),
];

/* ---- Korobeiniki, the Tetris theme (Doctor Spin, 1992; A minor): A and B,
   written in eighths (one step each) and played at speed ×½. 16 bars ---- */
const TETRIS = [
  ["E5", 2], ["B4", 1], ["C5", 1], ["D5", 2], ["C5", 1], ["B4", 1],
  ["A4", 2], ["A4", 1], ["C5", 1], ["E5", 2], ["D5", 1], ["C5", 1],
  ["B4", 3], ["C5", 1], ["D5", 2], ["E5", 2],
  ["C5", 2], ["A4", 2], ["A4", 2], [null, 2],
  [null, 1], ["D5", 2], ["F5", 1], ["A5", 2], ["G5", 1], ["F5", 1],
  ["E5", 3], ["C5", 1], ["E5", 2], ["D5", 1], ["C5", 1],
  ["B4", 2], ["B4", 1], ["C5", 1], ["D5", 2], ["E5", 2],
  ["C5", 2], ["A4", 2], ["A4", 2], [null, 2],
  ["E5", 4], ["C5", 4], ["D5", 4], ["B4", 4], ["C5", 4], ["A4", 4], ["G#4", 4], ["B4", 2], [null, 2],
  ["E5", 4], ["C5", 4], ["D5", 4], ["B4", 4], ["C5", 2], ["E5", 2], ["A5", 4], ["G#5", 8],
];

/* ---- Grieg, In the Hall of the Mountain King (B minor): the theme in
   16ths, the top note sliding down E → D# → D ---- */
const MOUNTAIN_KING = [
  ...each(["A4", "B4", "C5", "D5", "E5", "C5"]), ["E5", 2],
  ["D#5", 1], ["B4", 1], ["D#5", 2],
  ["D5", 1], ["Bb4", 1], ["D5", 2],
  ...each(["A4", "B4", "C5", "D5", "E5", "C5", "E5", "A5", "G5", "E5", "C5", "E5"]), ["G5", 4],
];

/* ---- Beethoven, Für Elise (A minor), in its own 3/8 (6 steps a bar) at
   speed ×½: A, A' into the bridge, A' and the bridge again. 32 bars of 3/8,
   so it runs against the 4/4 grid as the piece does ---- */
const ELISE_RUN = each(["E5", "D#5", "E5", "B4", "D5", "C5"]);
const ELISE_A = [
  ...ELISE_RUN,
  ["A4", 2], [null, 1], ...each(["C4", "E4", "A4"]),
  ["B4", 2], [null, 1], ...each(["E4", "G#4", "B4"]),
  ["C5", 2], [null, 1], ...each(["E4", "E5", "D#5"]),
  ...ELISE_RUN,
  ["A4", 2], [null, 1], ...each(["C4", "E4", "A4"]),
  ["B4", 2], [null, 1], ...each(["E4", "C5", "B4"]),
];
const ELISE_BRIDGE = [
  ["E5", 3], ...each(["G4", "F5", "E5"]),
  ["D5", 3], ...each(["F4", "E5", "D5"]),
  ["C5", 3], ...each(["E4", "D5", "C5"]),
  ["B4", 2], [null, 1], ...each(["E4", "E5", "D#5"]),
];
const ELISE_INTO_BRIDGE = [["A4", 2], [null, 1], ...each(["B4", "C5", "D5"])];
const FUR_ELISE = [
  ...ELISE_A, ["A4", 2], [null, 2], ...each(["E5", "D#5"]),
  ...ELISE_A, ...ELISE_INTO_BRIDGE, ...ELISE_BRIDGE,
  ...ELISE_A, ...ELISE_INTO_BRIDGE, ...ELISE_BRIDGE,
];

/* ---- Bach, Toccata in D minor: the mordent and its run in three octaves,
   then the diminished chord rolled up over the pedal, landing on the major ---- */
const TOCCATA_LINE = [
  ...line([["E5", 1], ["D5", 1], ["E5", 10], [null, 4], ...each(["D5", "C5", "B4", "A4"]), ["G#4", 4], ["A4", 8]]),
  ...line([["E4", 1], ["D4", 1], ["E4", 10], [null, 4], ...each(["B3", "C4"]), ["G#3", 4], ["A3", 10]], 32),
  ...line([["E3", 1], ["D3", 1], ["E3", 10], [null, 4], ...each(["D3", "C3", "B2", "A2"]), ["G#2", 4], ["A2", 8]], 64),
];
const TOCCATA_ROLL = ["G#2", "B2", "D3", "F3", "G#3", "B3", "D4", "F4"].map((p, i) => [98 + i, p, 14 - i]);
const TOCCATA_CHORD = ["A3", "C#4", "E4", "A4"].map((p) => [112, p, 16]);

/* ---- Lipps Inc., Funkytown (1979, C mixolydian, 128 BPM): the synth riff
   on C, again, on G, and on C with the pickup back into it. 8 bars ---- */
const funky = (root, fourth, third, low, { pickup = false } = {}) => [
  [root, 2], [root, 2], [low.seventh, 2], [root, 4], [low.fifth, 4], [low.fifth, 2],
  [root, 2], [fourth, 2], [third, 2], [root, 2], [null, pickup ? 6 : 8], ...(pickup ? [[low.fifth, 2]] : []),
];
const ON_A = ["A4", "D5", "C#5", { seventh: "G4", fifth: "E4" }];
const ON_E = ["E4", "A4", "G#4", { seventh: "D4", fifth: "B3" }];
const FUNKYTOWN = [...funky(...ON_A), ...funky(...ON_A), ...funky(...ON_E), ...funky(...ON_A, { pickup: true })];

/* ---- Misirlou (the Greek-Arab standard; Dick Dale, 1962; Pump It, 2005;
   E Phrygian dominant): up the scale and down. 6 bars ---- */
const MISIRLOU = [
  ["A4", 16],
  ["Bb4", 2], ["C#5", 2], ["D5", 2], ["E5", 4], ["F5", 1], ["E5", 5],
  ["A4", 8], ["Bb4", 2], ["C#5", 2], ["D5", 2], ["E5", 2],
  ["E5", 4], ["F5", 1], ["E5", 3], ...each(["F5", "E5", "D5", "E5", "D5", "C#5", "Bb4", "C#5"]),
  ["C#5", 12], ...each(["E5", "D5", "E5", "D5"]),
  ...each(["C#5", "D5", "C#5", "D5", "C#5", "Bb4"]), ["A4", 10],
];

export const CLASSICS = {
  sandstorm: { synth: "supersaw", notes: line(SANDSTORM) },
  axelF: { synth: "lead", notes: line(AXEL_F) },
  popcorn: { synth: "pluck", notes: line(POPCORN) },
  tetris: { synth: "bitLead", speed: 0.5, notes: line(TETRIS) },
  mountainKing: { synth: "pluck", notes: line(MOUNTAIN_KING) },
  furElise: { synth: "fmBell", speed: 0.5, notes: line(FUR_ELISE) },
  toccata: { synth: "analog", notes: [...TOCCATA_LINE, [96, "A1", 32], ...TOCCATA_ROLL, ...TOCCATA_CHORD] },
  funkytown: { synth: "funky", notes: line(FUNKYTOWN) },
  misirlou: { synth: "lead", notes: line(MISIRLOU) },
};

export const CLASSIC_IDS = Object.keys(CLASSICS);
