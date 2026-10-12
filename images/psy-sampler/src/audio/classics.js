// The hooks everyone knows from electronic music, as 2-bar parts for the
// "classic" layer. Each one is moved to A like every other sound here, so it
// sits on top of any mix; `scale` is the piano roll's (notes outside it stay
// visible). `speed: 0.5` stretches a tune that needs 4 bars over two loops.
//
// Notes are [step, pitch, len], pitch in scientific notation ("C#5").

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" -> 69, "C#5" -> 73, "Bb4" -> 70. */
export function midiOf(name) {
  const [, letter, accidental, octave] = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + PITCH[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0);
}

// `count` 16ths of `pitch` from `step`, the last one `last` long.
const run = (step, pitch, count, last = 1) =>
  Array.from({ length: count }, (_, i) => [step + i, pitch, i === count - 1 ? last : 1]);

export const CLASSICS = {
  // Darude, 1999 (B minor): 5, 7, 7 and 7 notes, each run ending long, and 2 to turn around.
  sandstorm: {
    synth: "supersaw",
    notes: [...run(0, "A4", 5, 2), ...run(6, "A4", 7, 2), ...run(14, "D5", 7, 2), ...run(22, "C5", 7, 2), ...run(30, "G4", 2)],
  },
  // Harold Faltermeyer, 1984; Crazy Frog's in 2005 (F minor).
  axelF: {
    synth: "lead",
    notes: [
      [0, "A4", 4], [4, "C5", 3], [7, "A4", 2], [9, "A4", 1], [10, "D5", 2], [12, "A4", 2], [14, "G4", 2],
      [16, "A4", 4], [20, "E5", 3], [23, "A4", 2], [25, "A4", 1], [26, "F5", 2], [28, "E5", 2], [30, "C5", 2],
    ],
  },
  // Gershon Kingsley, 1969; Hot Butter's Moog in 1972 (B minor). The bar, twice.
  popcorn: {
    synth: "pluck",
    notes: [0, 16].flatMap((bar) =>
      [["A4", 1], ["G4", 1], ["A4", 1], ["E4", 1], ["C4", 1], ["E4", 1], ["A3", 2]].map(([p, len], i) => [bar + i * 2, p, len]),
    ),
  },
  // Korobeiniki, the Tetris theme; Doctor Spin's in 1992. Already in A minor.
  tetris: {
    synth: "bitLead",
    speed: 0.5,
    notes: [
      [0, "E5", 2], [2, "B4", 1], [3, "C5", 1], [4, "D5", 2], [6, "C5", 1], [7, "B4", 1],
      [8, "A4", 2], [10, "A4", 1], [11, "C5", 1], [12, "E5", 2], [14, "D5", 1], [15, "C5", 1],
      [16, "B4", 3], [19, "C5", 1], [20, "D5", 2], [22, "E5", 2],
      [24, "C5", 2], [26, "A4", 2], [28, "A4", 4],
    ],
  },
  // Grieg's In the Hall of the Mountain King (B minor): the top note slides down a semitone, twice.
  mountainKing: {
    synth: "pluck",
    scale: "chromatic",
    notes: [
      ...["A4", "B4", "C5", "D5", "E5", "C5"].map((p, i) => [i, p, 1]), [6, "E5", 2],
      [8, "D#5", 1], [9, "B4", 1], [10, "D#5", 2],
      [12, "D5", 1], [13, "Bb4", 1], [14, "D5", 2],
      ...["A4", "B4", "C5", "D5", "E5", "C5", "E5", "A5", "G5", "E5", "C5", "E5"].map((p, i) => [16 + i, p, 1]),
      [28, "G5", 4],
    ],
  },
  // Beethoven's Für Elise (A minor), the theme of every trance cover of it.
  furElise: {
    synth: "fmBell",
    scale: "chromatic",
    speed: 0.5,
    notes: [
      ...["E5", "D#5", "E5", "B4", "D5", "C5"].map((p, i) => [i, p, 1]),
      [6, "A4", 2], [9, "C4", 1], [10, "E4", 1], [11, "A4", 1],
      [12, "B4", 2], [15, "E4", 1], [16, "G#4", 1], [17, "B4", 1],
      [18, "C5", 2], [21, "E4", 1], [22, "E5", 1], [23, "D#5", 1],
      ...["E5", "D#5", "E5", "B4", "D5", "C5"].map((p, i) => [24 + i, p, 1]),
      [30, "A4", 2],
    ],
  },
  // Bach's Toccata in D minor: the mordent, the held note, the run down to the leading tone.
  toccata: {
    synth: "analog",
    scale: "harmonic",
    notes: [
      [0, "E5", 1], [1, "D5", 1], [2, "E5", 10],
      [16, "D5", 1], [17, "C5", 1], [18, "B4", 1], [19, "A4", 1], [20, "G#4", 4], [24, "A4", 8],
    ],
  },
  // Lipps Inc., 1979 (C): the synth riff, twice. The C# is its major third.
  funkytown: {
    synth: "rubber",
    scale: "chromatic",
    notes: [0, 16].flatMap((bar) =>
      [[0, "A4"], [1, "A4"], [2, "G4"], [3, "A4"], [6, "E4"], [10, "E4"], [11, "A4"], [12, "D5"], [13, "C#5"], [14, "A4", 2]].map(
        ([s, p, len = 1]) => [bar + s, p, len],
      ),
    ),
  },
  // Misirlou, the Greek-Arab standard behind Pump It (E): up the Phrygian dominant and back down.
  misirlou: {
    synth: "acid",
    scale: "chromatic",
    notes: [
      [0, "A4", 2], [2, "Bb4", 2], [4, "C#5", 2], [6, "D5", 2], [8, "E5", 2], [10, "F5", 2], [12, "E5", 4],
      [16, "F5", 2], [18, "E5", 2], [20, "D5", 2], [22, "C#5", 2], [24, "Bb4", 1], [25, "C#5", 1], [26, "Bb4", 2], [28, "A4", 4],
    ],
  },
};

export const CLASSIC_IDS = Object.keys(CLASSICS);
