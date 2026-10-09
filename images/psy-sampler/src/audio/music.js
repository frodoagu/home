// Pitch helpers. Equal temperament, A4 = 440 Hz (MIDI 69).

export const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

export const centsToRatio = (cents) => 2 ** (cents / 1200);

// MIDI numbers for the notes the default patterns use. A1 = 55 Hz.
export const NOTE = {
  A1: 33,
  A2: 45,
  C3: 48,
  D3: 50,
  E3: 52,
  F3: 53,
  G3: 55,
  A3: 57,
  Bb3: 58,
  C4: 60,
  D4: 62,
  E4: 64,
  F4: 65,
  G4: 67,
  A4: 69,
  C5: 72,
  E5: 76,
  A5: 81,
};

// Everything is in A: psytrance lives in minor and Phrygian (the flat second,
// B♭, is the genre's signature tension).
const ROOT = 9;

export const SCALES = {
  minor: { label: "La menor", steps: [0, 2, 3, 5, 7, 8, 10] },
  phrygian: { label: "La frigio", steps: [0, 1, 3, 5, 7, 8, 10] },
  harmonic: { label: "La menor armónica", steps: [0, 2, 3, 5, 7, 8, 11] },
  chromatic: { label: "Cromática", steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

const pitchClass = (midi) => ((midi % 12) + 12) % 12;

export const inScale = (midi, scale) => SCALES[scale].steps.includes(pitchClass(midi - ROOT));

export const inAMinor = (midi) => inScale(midi, "minor");

export const isRoot = (midi) => pitchClass(midi) === ROOT;

const NAMES = ["Do", "Do#", "Re", "Mi♭", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "Si♭", "Si"];

// Spanish name with scientific octave: 69 -> "La4", 60 -> "Do4".
export const noteName = (midi) => `${NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;

/**
 * Piano-roll rows, highest first: the scale's pitches in [low, high], plus
 * every pitch in `keep` so notes written outside the scale stay visible.
 */
export function scaleRows(scale, low, high, keep = []) {
  const rows = new Set(keep);
  for (let m = low; m <= high; m++) if (inScale(m, scale)) rows.add(m);
  return [...rows].sort((a, b) => b - a);
}
