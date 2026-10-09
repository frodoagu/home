import { describe, expect, it } from "vitest";
import { inScale, isRoot, scaleRows } from "./audio/music.js";
import { ACCENT, HIT, OFF } from "./audio/patterns.js";
import {
  BUILD_UP,
  cycleNote,
  cycleStep,
  doubleSteps,
  improvise,
  noteAt,
  placeNote,
  seeded,
  varyNotes,
  varySteps,
  withBuildUp,
} from "./editing.js";

const n = (step, midi, len = 1, accent = false) => ({ step, midi, len, accent });

describe("cycleStep", () => {
  it("goes off -> hit -> accent -> off without mutating", () => {
    const steps = Array(32).fill(OFF);
    const a = cycleStep(steps, 3);
    const b = cycleStep(a, 3);
    expect([a[3], b[3], cycleStep(b, 3)[3]]).toEqual([HIT, ACCENT, OFF]);
    expect(steps[3]).toBe(OFF);
  });
});

describe("doubleSteps", () => {
  const row = (hits) => Array.from({ length: 32 }, (_, s) => (hits.includes(s) ? HIT : OFF));
  const hitsOf = (steps) => steps.flatMap((v, s) => (v ? [s] : []));

  it("quarters -> 8ths -> 16ths, then stays full", () => {
    const quarters = row([0, 4, 8, 12, 16, 20, 24, 28]);
    const eighths = doubleSteps(quarters);
    expect(hitsOf(eighths)).toEqual(Array.from({ length: 16 }, (_, i) => i * 2));
    const sixteenths = doubleSteps(eighths);
    expect(hitsOf(sixteenths)).toHaveLength(32);
    expect(doubleSteps(sixteenths)).toEqual(sixteenths);
    expect(hitsOf(quarters)).toHaveLength(8); // not mutated
  });

  it("splits uneven gaps, wraps around the loop and keeps accents", () => {
    const steps = row([3, 8]);
    steps[3] = ACCENT;
    // 3 -> 8 (gap 5) adds 5; 8 -> 35 (gap 27, wrapping) adds 21.
    const out = doubleSteps(steps);
    expect(hitsOf(out)).toEqual([3, 5, 8, 21]);
    expect(out[3]).toBe(ACCENT);
    expect(doubleSteps(row([]))).toEqual(row([]));
  });
});

describe("withBuildUp", () => {
  it("replaces one bar, wherever it starts, with a roll that doubles its rate", () => {
    const steps = Array(32).fill(HIT);
    const hitsOf = (list) => list.flatMap((v, s) => (v ? [s] : []));
    expect(hitsOf(BUILD_UP)).toEqual([0, 4, 8, 10, 12, 13, 14, 15]);
    const second = withBuildUp(steps, 16);
    expect(second.slice(0, 16)).toEqual(steps.slice(0, 16));
    expect(second.slice(16)).toEqual(BUILD_UP);
    expect(withBuildUp(steps, 0).slice(0, 16)).toEqual(BUILD_UP);
    expect(steps.every((v) => v === HIT)).toBe(true);
  });
});

describe("cycleNote", () => {
  it("adds a note of the chosen length on an empty cell", () => {
    expect(cycleNote([], 4, 60, 4)).toEqual([n(4, 60, 4)]);
  });

  it("accents a note, then deletes it, from any cell it covers", () => {
    const a = cycleNote([n(4, 60, 4)], 6, 60, 1);
    expect(a).toEqual([n(4, 60, 4, true)]);
    expect(cycleNote(a, 7, 60, 1)).toEqual([]);
  });

  it("shortens a new note so it never runs into the next one or past the loop", () => {
    expect(cycleNote([n(6, 60)], 4, 60, 8)).toContainEqual(n(4, 60, 2));
    expect(cycleNote([], 30, 60, 8)).toEqual([n(30, 60, 2)]);
  });

  it("other rows are independent: chords are allowed", () => {
    expect(cycleNote([n(0, 60, 4)], 0, 64, 4)).toHaveLength(2);
  });
});

describe("placeNote", () => {
  it("a dragged span replaces whatever it covers on its row only", () => {
    const notes = [n(0, 60), n(2, 60, 4), n(8, 60), n(2, 64)];
    expect(placeNote(notes, 1, 60, 6)).toEqual([n(0, 60), n(8, 60), n(2, 64), n(1, 60, 6)]);
  });

  it("clips at the loop end", () => {
    expect(placeNote([], 28, 60, 10)).toEqual([n(28, 60, 4)]);
  });
});

it("noteAt finds the note covering a cell", () => {
  expect(noteAt([n(4, 60, 4)], 7, 60)).toEqual(n(4, 60, 4));
  expect(noteAt([n(4, 60, 4)], 8, 60)).toBeUndefined();
});

describe("improvise", () => {
  const rows = scaleRows("phrygian", 45, 81);

  const valid = (notes) => {
    for (const x of notes) {
      expect(rows).toContain(x.midi);
      expect(Number.isInteger(x.step) && x.step >= 0 && x.step + x.len <= 32).toBe(true);
    }
    const keys = notes.map((x) => `${x.step}:${x.midi}`);
    expect(new Set(keys).size).toBe(keys.length);
  };

  it("is deterministic for a seed and stays in the given rows", () => {
    for (const style of ["bass", "lead", "pad", "perc"]) {
      const a = improvise(style, rows, seeded(7));
      expect(a).toEqual(improvise(style, rows, seeded(7)));
      expect(a.length).toBeGreaterThan(0);
      valid(a);
      expect(a.every((x) => inScale(x.midi, "phrygian"))).toBe(true);
    }
  });

  it("bass rolls between the kicks, mostly on the root", () => {
    for (let seed = 1; seed < 20; seed++) {
      const bass = improvise("bass", rows, seeded(seed));
      expect(bass.every((x) => x.step % 4 !== 0)).toBe(true);
      expect(bass.filter((x) => isRoot(x.midi)).length / bass.length).toBeGreaterThan(0.5);
    }
  });

  it("lead repeats its first motif as a riff (bars A ? A ?)", () => {
    const lead = improvise("lead", rows, seeded(3));
    const at = (from) => lead.filter((x) => x.step >= from && x.step < from + 8).map((x) => [x.step - from, x.midi]);
    expect(at(16)).toEqual(at(0));
  });

  it("pad plays one 3-note chord per bar", () => {
    const pad = improvise("pad", rows, seeded(5));
    expect(pad.filter((x) => x.step === 0).length).toBeGreaterThanOrEqual(2);
    expect(pad.every((x) => x.len === 16 && (x.step === 0 || x.step === 16))).toBe(true);
  });
});

describe("variations", () => {
  const rows = [57, 60, 62, 64, 65, 67, 69];
  const part = [
    { step: 0, midi: 57, len: 2, accent: false },
    { step: 4, midi: 60, len: 1, accent: true },
    { step: 8, midi: 64, len: 4, accent: false },
    { step: 16, midi: 69, len: 1, accent: false },
  ];
  const overlaps = (notes) =>
    notes.some((a, i) => notes.some((b, j) => i < j && a.midi === b.midi && a.step < b.step + b.len && b.step < a.step + a.len));
  const changed = (a, b) => {
    const key = (n) => `${n.step}:${n.midi}:${n.len}:${n.accent}`;
    const sa = new Set(a.map(key));
    return b.filter((n) => !sa.has(key(n))).length + a.filter((n) => !new Set(b.map(key)).has(key(n))).length;
  };

  it("stay close to the part: a couple of notes, on the rows, without overlaps", () => {
    for (let seed = 1; seed < 200; seed++) {
      const out = varyNotes(part, rows, seeded(seed));
      expect(out).not.toBe(part);
      expect(Math.abs(out.length - part.length)).toBeLessThanOrEqual(2);
      expect(changed(part, out)).toBeLessThanOrEqual(4);
      expect(overlaps(out)).toBe(false);
      for (const n of out) {
        expect(rows).toContain(n.midi);
        expect(n.step + n.len).toBeLessThanOrEqual(32);
      }
    }
    expect(part[0]).toEqual({ step: 0, midi: 57, len: 2, accent: false }); // input untouched
  });

  it("are reproducible with a seed and actually vary", () => {
    expect(varyNotes(part, rows, seeded(9))).toEqual(varyNotes(part, rows, seeded(9)));
    const outs = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(varyNotes(part, rows, seeded(i)))));
    expect(outs.size).toBeGreaterThan(5);
  });

  it("drum variations never touch the beat", () => {
    const kick = Array.from({ length: 32 }, (_, s) => (s % 4 === 0 ? 1 : 0));
    for (let seed = 1; seed < 100; seed++) {
      const out = varySteps(kick, seeded(seed));
      out.forEach((v, s) => {
        if (s % 4 === 0) expect(v).toBe(1);
      });
      expect(out.filter((v, s) => v !== kick[s]).length).toBeLessThanOrEqual(2);
    }
  });
});
