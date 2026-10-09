import { describe, expect, it } from "vitest";
import { inAMinor, midiToFreq, NOTE } from "./music.js";
import { ACID_LINE, ACID_SWEEP_PERIOD, acidCutoff, LOOP_VARIANTS, notesAt } from "./patterns.js";

const STEPS = [...Array(32).keys()];
const stepsWith = (variant) => STEPS.filter((s) => notesAt(variant, s).length > 0);
const first = (variant, step) => notesAt(variant, step)[0];

describe("kick", () => {
  it("hits once per beat in both variants", () => {
    expect(stepsWith("kick.punchy")).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(stepsWith("kick.long")).toEqual(stepsWith("kick.punchy"));
  });

  it("uses the specified pitch sweeps and decays", () => {
    expect(first("kick.punchy", 0)).toMatchObject({ f0: 170, f1: 50, sweep: 0.07, decay: 0.2, click: true });
    expect(first("kick.long", 0)).toMatchObject({ f0: 120, f1: 42, sweep: 0.16, decay: 0.34 });
  });
});

describe("bass", () => {
  it("offbeat plays A1 on step % 4 === 2 only", () => {
    expect(stepsWith("bass.offbeat")).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
    expect(first("bass.offbeat", 2).freq).toBeCloseTo(55, 10);
  });

  it("rolling fills the three 16ths between kicks", () => {
    const steps = stepsWith("bass.rolling");
    expect(steps).toHaveLength(24);
    expect(steps.every((s) => s % 4 !== 0)).toBe(true);
  });

  it("rolling with octave lifts the middle note", () => {
    expect(stepsWith("bass.rollingOct")).toEqual(stepsWith("bass.rolling"));
    expect(first("bass.rollingOct", 2).freq).toBeCloseTo(110, 10);
    expect(first("bass.rollingOct", 1).freq).toBeCloseTo(55, 10);
    expect(first("bass.rollingOct", 3).freq).toBeCloseTo(55, 10);
  });
});

describe("percussion", () => {
  it("open hat on the offbeat", () => {
    expect(stepsWith("perc.hat")).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
  });

  it("shaker on every step with alternating accent", () => {
    expect(stepsWith("perc.shaker")).toEqual(STEPS);
    expect(STEPS.map((s) => first("perc.shaker", s).accent)).toEqual(STEPS.map((s) => s % 2 === 0));
  });

  it("clap on beats 2 and 4", () => {
    expect(stepsWith("perc.clap")).toEqual([4, 12, 20, 28]);
  });
});

describe("lead", () => {
  it("acid repeats a 16-step A minor line with rests", () => {
    expect(ACID_LINE).toHaveLength(16);
    expect(ACID_LINE.some((n) => n === null)).toBe(true);
    expect(ACID_LINE.filter(Boolean).every((n) => inAMinor(n.note))).toBe(true);
    for (let s = 0; s < 16; s++) expect(notesAt("lead.acid", s)).toEqual(notesAt("lead.acid", s + 16));
  });

  it("arp walks A-C-E-A every 16th", () => {
    const freqs = [0, 1, 2, 3].map((s) => first("lead.arp", s).freq);
    expect(freqs).toEqual([NOTE.A3, NOTE.C4, NOTE.E4, NOTE.A4].map(midiToFreq));
    expect(first("lead.arp", 4).freq).toBe(freqs[0]);
  });

  it("melodic holds one note every 8 steps", () => {
    expect(stepsWith("lead.melodic")).toEqual([0, 8, 16, 24]);
    expect(first("lead.melodic", 8).steps).toBe(8);
  });

  it("melodic entering mid-note plays the rest of that note", () => {
    const ev = notesAt("lead.melodic", 11, true)[0];
    expect(ev.freq).toBe(first("lead.melodic", 8).freq);
    expect(ev.steps).toBe(5); // up to the retrigger on step 16
  });
});

describe("pad", () => {
  it("retriggers an A minor triad every 16 steps", () => {
    expect(stepsWith("pad.chord")).toEqual([0, 16]);
    const { freqs, steps } = first("pad.chord", 0);
    expect(freqs).toEqual([NOTE.A3, NOTE.C4, NOTE.E4].map(midiToFreq));
    expect(steps).toBe(16);
  });

  it("entering mid-phrase starts the chord right away, ending on the retrigger", () => {
    expect(notesAt("pad.chord", 21, true)[0].steps).toBe(11);
    expect(notesAt("pad.chord", 21, false)).toEqual([]);
  });
});

describe("acidCutoff", () => {
  it("drifts slowly between 300 Hz and 1.5 kHz", () => {
    expect(acidCutoff(0)).toBeCloseTo(300, 6);
    expect(acidCutoff(ACID_SWEEP_PERIOD / 2)).toBeCloseTo(1500, 6);
    expect(acidCutoff(ACID_SWEEP_PERIOD * 3 + 1)).toBeCloseTo(acidCutoff(1), 6);
    for (let t = 0; t < ACID_SWEEP_PERIOD; t += 0.37) {
      expect(acidCutoff(t)).toBeGreaterThanOrEqual(300 - 1e-9);
      expect(acidCutoff(t)).toBeLessThanOrEqual(1500 + 1e-9);
    }
  });
});

it("only sustained variants react to entering", () => {
  for (const v of LOOP_VARIANTS.filter((v) => !["lead.melodic", "pad.chord"].includes(v))) {
    for (let s = 0; s < 32; s++) expect(notesAt(v, s, true)).toEqual(notesAt(v, s));
  }
});

it("unknown variants play nothing", () => {
  expect(notesAt("nope", 0)).toEqual([]);
  expect(LOOP_VARIANTS).toHaveLength(12);
});
