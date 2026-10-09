// What every loop variant plays on each of the 32 steps. Pure data + lookups:
// the voices in voices.js turn these events into sound.
import { NOTE, midiToFreq } from "./music.js";

const { A1, A2, C3, D3, E3, G3, A3, C4, E4, G4, A4, C5 } = NOTE;

export const KICK_PUNCHY = { f0: 170, f1: 50, sweep: 0.07, decay: 0.2, click: true };
export const KICK_LONG = { f0: 120, f1: 42, sweep: 0.16, decay: 0.34, click: false };

// 16-step acid line in A minor; null is a rest, accents open the filter further.
export const ACID_LINE = [
  { note: A2, accent: true }, { note: A2 }, null, { note: A3 },
  { note: A2 }, { note: C3 }, null, { note: A2, accent: true },
  { note: E3 }, { note: A2 }, null, { note: G3 },
  { note: A2, accent: true }, null, { note: C3 }, { note: D3 },
];

export const ARP_NOTES = [A3, C4, E4, A4];
export const MELODY = [A4, C5, G4, E4]; // one note every 8 steps, ends on E to pull back to A
export const PAD_CHORD = [A3, C4, E4];

// Slow drift of the acid filter's base cutoff: 300 Hz -> 1.5 kHz -> 300 Hz every
// ACID_SWEEP_PERIOD seconds, on a log scale so it moves evenly to the ear. It is
// driven by the audio clock, not the step, so it keeps evolving across loop
// repeats instead of restarting every 2 bars.
export const ACID_SWEEP_PERIOD = 16;
export function acidCutoff(t) {
  const phase = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / ACID_SWEEP_PERIOD);
  return 300 * 5 ** phase;
}

const on = (cond, ev) => (cond ? [ev] : []);
const bass = (midi) => ({ voice: "bass", freq: midiToFreq(midi) });

// Step positions: s % 4 === 0 is a beat (kick), s % 4 === 2 the offbeat.
const PATTERNS = {
  "kick.punchy": (s) => on(s % 4 === 0, { voice: "kick", ...KICK_PUNCHY }),
  "kick.long": (s) => on(s % 4 === 0, { voice: "kick", ...KICK_LONG }),

  "bass.offbeat": (s) => on(s % 4 === 2, bass(A1)),
  "bass.rolling": (s) => on(s % 4 !== 0, bass(A1)),
  "bass.rollingOct": (s) => on(s % 4 !== 0, bass(s % 4 === 2 ? A2 : A1)),

  "perc.hat": (s) => on(s % 4 === 2, { voice: "hat" }),
  "perc.shaker": (s) => [{ voice: "shaker", accent: s % 2 === 0 }],
  "perc.clap": (s) => on(s % 8 === 4, { voice: "clap" }), // beats 2 and 4

  "lead.acid": (s) => {
    const n = ACID_LINE[s % 16];
    return n ? [{ voice: "acid", freq: midiToFreq(n.note), accent: Boolean(n.accent) }] : [];
  },
  "lead.arp": (s) => [{ voice: "arp", freq: midiToFreq(ARP_NOTES[s % 4]) }],
  // Sustained variants: on `entering` (the lane's first step) they start the
  // note already in progress with whatever is left of it, instead of waiting
  // up to 8 / 16 steps of silence for the next retrigger.
  "lead.melodic": (s, entering) =>
    on(s % 8 === 0 || entering, {
      voice: "lead",
      freq: midiToFreq(MELODY[Math.floor(s / 8)]),
      steps: 8 - (s % 8),
    }),

  "pad.chord": (s, entering) =>
    on(s % 16 === 0 || entering, { voice: "pad", freqs: PAD_CHORD.map(midiToFreq), steps: 16 - (s % 16) }),
};

export const LOOP_VARIANTS = Object.keys(PATTERNS);

export const notesAt = (variant, step, entering = false) => PATTERNS[variant]?.(step, entering) ?? [];
