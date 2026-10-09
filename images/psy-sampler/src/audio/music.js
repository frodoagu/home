// Pitch helpers. Equal temperament, A4 = 440 Hz (MIDI 69).

export const midiToFreq = (midi) => 440 * 2 ** ((midi - 69) / 12);

export const centsToRatio = (cents) => 2 ** (cents / 1200);

// MIDI numbers for the notes the patterns use. A1 = 55 Hz.
export const NOTE = {
  A1: 33,
  A2: 45,
  C3: 48,
  D3: 50,
  E3: 52,
  G3: 55,
  A3: 57,
  C4: 60,
  E4: 64,
  G4: 67,
  A4: 69,
  C5: 72,
};

// Pitch classes of A natural minor: A B C D E F G.
const A_MINOR = new Set([9, 11, 0, 2, 4, 5, 7]);

export const inAMinor = (midi) => A_MINOR.has(((midi % 12) + 12) % 12);
