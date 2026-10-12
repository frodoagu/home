import { describe, expect, it } from "vitest";
import { inScale, isRoot, scaleRows } from "./audio/music.js";
import { ACCENT, HIT, OFF } from "./audio/patterns.js";
import {
  BUILD_UP,
  FILL_STEPS,
  ROLL,
  beatEchoes,
  brushAllNotes,
  brushAllSteps,
  brushMod,
  brushNote,
  brushStep,
  cycleNote,
  cycleNoteEcho,
  cycleStep,
  cycleStepEcho,
  doubleSteps,
  euclid,
  euclidSteps,
  changesFor,
  improvise,
  newPart,
  noteAt,
  placeNote,
  pruneMods,
  reversePart,
  rotatePart,
  seeded,
  silenced,
  varyNotes,
  varySteps,
  withBreak,
  withBuildUp,
  withRoll,
  writePart,
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
    const data = { steps: Array(32).fill(HIT), mods: Array(32).fill({ p: 0.5 }) };
    const hitsOf = (list) => list.flatMap((v, s) => (v ? [s] : []));
    expect(hitsOf(BUILD_UP)).toEqual([0, 4, 8, 10, 12, 13, 14, 15]);
    const second = withBuildUp(data, 16);
    expect(second.steps.slice(0, 16)).toEqual(data.steps.slice(0, 16));
    expect(second.steps.slice(16)).toEqual(BUILD_UP);
    expect(withBuildUp(data, 0).steps.slice(0, 16)).toEqual(BUILD_UP);
    expect(data.steps.every((v) => v === HIT)).toBe(true);
  });

  it("clears the mods of its bar only", () => {
    const data = { steps: Array(32).fill(HIT), mods: Array(32).fill({ p: 0.5 }) };
    const { mods } = withBuildUp(data, 16);
    expect(mods.slice(0, 16).every((m) => m.p === 0.5)).toBe(true);
    expect(mods.slice(16).every((m) => m === null)).toBe(true);
  });
});

describe("bar overlays", () => {
  const drums = () => ({ steps: Array(32).fill(HIT), mods: Array(32).fill({ p: 0.5 }), speed: 2, iter: 4, echo: { steps: 3, semis: 0 } });

  it("silenced plays nothing, drums and notes alike", () => {
    const d = silenced(drums());
    expect(d.steps.every((v) => v === OFF) && d.mods.every((m) => m === null)).toBe(true);
    expect([d.speed, d.iter, d.echo]).toEqual([1, 1, null]);
    const notes = { notes: [n(0, 33, 4)], echo: { steps: 3, semis: 7 }, synth: "sub" };
    expect(silenced(notes)).toEqual({ notes: [], echo: null, synth: "sub" });
  });

  it("a break empties the last two beats of its bar, in place", () => {
    const d = withBreak(drums(), 16);
    expect(FILL_STEPS).toBe(8);
    expect(d.steps.slice(0, 24).every((v) => v === HIT)).toBe(true);
    expect(d.steps.slice(24).every((v) => v === OFF)).toBe(true);
    expect(d.mods.slice(24).every((m) => m === null) && d.mods[23].p === 0.5).toBe(true);
    expect([d.speed, d.iter, d.echo]).toEqual([1, 1, null]);
    expect(withBreak(drums(), 0).steps.slice(8, 16).every((v) => v === OFF)).toBe(true);
  });

  it("a roll writes 8ths then accented 16ths over the last two beats", () => {
    const empty = { steps: Array(32).fill(OFF), mods: Array(32).fill(null) };
    const d = withRoll(empty, 0);
    expect(d.steps.slice(8, 16)).toEqual(ROLL);
    expect(ROLL).toEqual([HIT, OFF, HIT, OFF, HIT, HIT, ACCENT, ACCENT]);
    expect(d.steps.slice(16).every((v) => v === OFF)).toBe(true);
    expect(empty.steps.every((v) => v === OFF)).toBe(true); // never mutates
  });
});

describe("mods", () => {
  const empty = () => ({ steps: Array(32).fill(OFF), mods: Array(32).fill(null) });

  it("brushMod sets a key, and the same value again takes it off", () => {
    const a = brushMod(null, "p", 0.5);
    expect(a).toEqual({ p: 0.5 });
    const b = brushMod(a, "cond", "1:4");
    expect(b).toEqual({ p: 0.5, cond: "1:4" });
    expect(brushMod(b, "p", 0.25)).toEqual({ p: 0.25, cond: "1:4" });
    expect(brushMod(brushMod(b, "p", 0.5), "cond", "1:4")).toBeNull();
  });

  it("brushStep puts a hit carrying the brush on an empty step", () => {
    const out = brushStep(empty(), 5, "ply", 3);
    expect(out.steps[5]).toBe(HIT);
    expect(out.mods[5]).toEqual({ ply: 3 });
  });

  it("brushStep keeps an accent and echoes on every beat with Ctrl", () => {
    const data = empty();
    data.steps[2] = ACCENT;
    const out = brushStep(data, 2, "p", 0.75, { echo: true });
    expect(out.steps.flatMap((v, s) => (v ? [s] : []))).toEqual([2, 6, 10, 14]);
    expect(out.steps[2]).toBe(ACCENT);
    expect(out.mods.filter(Boolean)).toEqual(Array(4).fill({ p: 0.75 }));
  });

  it("brushAllSteps marks every hit, then unmarks them all", () => {
    const data = empty();
    data.steps[0] = HIT;
    data.steps[8] = HIT;
    data.mods[8] = { cond: "2:2" };
    const on = brushAllSteps(data, "p", 0.5);
    expect(on.mods[0]).toEqual({ p: 0.5 });
    expect(on.mods[8]).toEqual({ p: 0.5, cond: "2:2" });
    const off = brushAllSteps({ ...data, ...on }, "p", 0.5);
    expect(off.mods[0]).toBeNull();
    expect(off.mods[8]).toEqual({ cond: "2:2" });
  });

  it("pruneMods drops what sits on an empty step", () => {
    const steps = [HIT, OFF];
    expect(pruneMods(steps, [{ p: 0.5 }, { p: 0.5 }])).toEqual([{ p: 0.5 }, null]);
  });

  it("brushNote marks the note under the cell, or writes a new one", () => {
    const notes = [n(0, 57, 4)];
    const marked = brushNote(notes, 2, 57, 1, "cond", "!4:4");
    expect(marked).toEqual([{ ...n(0, 57, 4), cond: "!4:4" }]);
    const added = brushNote(notes, 8, 60, 2, "p", 0.25);
    expect(added[1]).toEqual({ ...n(8, 60, 2), p: 0.25 });
    expect(brushNote(marked, 0, 57, 1, "cond", "!4:4")).toEqual(notes);
  });

  it("brushNote with Ctrl echoes onto the beats and leaves longer notes alone", () => {
    const notes = [n(4, 57, 2)];
    const out = brushNote(notes, 0, 57, 1, "ply", 2, { echo: true });
    expect(out.map((x) => x.step).sort((a, b) => a - b)).toEqual([0, 4, 8, 12]);
    expect(out.every((x) => x.ply === 2)).toBe(true);
  });

  it("brushAllNotes marks every note, then unmarks them all", () => {
    const notes = [n(0, 57), { ...n(4, 60), p: 0.5 }];
    const on = brushAllNotes(notes, "p", 0.5);
    expect(on.every((x) => x.p === 0.5)).toBe(true);
    expect(brushAllNotes(on, "p", 0.5)).toEqual([n(0, 57), n(4, 60)]);
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

describe("beatEchoes", () => {
  it("the same 16th in each beat of the clicked bar, or of both bars", () => {
    expect(beatEchoes(2)).toEqual([2, 6, 10, 14]);
    expect(beatEchoes(21)).toEqual([17, 21, 25, 29]);
    expect(beatEchoes(21, true)).toEqual([1, 5, 9, 13, 17, 21, 25, 29]);
  });
});

describe("cycleStepEcho", () => {
  it("copies the clicked step's new state onto its echoes only", () => {
    const steps = Array(32).fill(OFF);
    steps[6] = ACCENT;
    steps[3] = HIT;
    const out = cycleStepEcho(steps, 2);
    expect(out.flatMap((v, s) => (v ? [s] : []))).toEqual([2, 3, 6, 10, 14]);
    expect([out[2], out[6]]).toEqual([HIT, HIT]);
    expect(cycleStepEcho(out, 18, true).every((v, s) => s % 4 !== 2 || v === HIT)).toBe(true);
    expect(steps[2]).toBe(OFF);
  });
});

describe("cycleNoteEcho", () => {
  it("adds the note on every beat of the bar, shortened before the next one", () => {
    expect(cycleNoteEcho([], 2, 60, 8)).toEqual([n(14, 60, 8), n(10, 60, 4), n(6, 60, 4), n(2, 60, 4)]);
    expect(cycleNoteEcho([], 1, 60, 1, true)).toHaveLength(8);
  });

  it("accents and deletes the echoes of the clicked note, row by row", () => {
    const notes = [n(2, 60), n(6, 60), n(10, 64), n(9, 60, 3)];
    const accented = cycleNoteEcho(notes, 2, 60, 1);
    expect(accented).toEqual([n(2, 60, 1, true), n(6, 60, 1, true), n(10, 64), n(9, 60, 3), n(14, 60, 1, true)]);
    expect(cycleNoteEcho(accented, 6, 60, 1)).toEqual([n(10, 64), n(9, 60, 3)]);
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

describe("improvise amount", () => {
  const kick = Array.from({ length: 32 }, (_, s) => (s % 4 === 0 ? 1 : 0));
  const diff = (out) => out.filter((v, s) => v !== kick[s]).length;

  it("changes nothing at 0, 1-2 things at the default and a lot at the top", () => {
    for (let seed = 1; seed < 50; seed++) {
      expect(changesFor(0, seeded(seed))).toBe(0);
      expect([1, 2]).toContain(changesFor(0.5, seeded(seed)));
      expect(changesFor(1, seeded(seed))).toBeGreaterThanOrEqual(6);
      expect(varySteps(kick, seeded(seed), 0)).toEqual(kick);
    }
    const total = (amount) =>
      Array.from({ length: 40 }, (_, i) => diff(varySteps(kick, seeded(i), amount))).reduce((a, b) => a + b);
    expect(total(1)).toBeGreaterThan(total(0.5) * 2);
    expect(total(0.25)).toBeLessThan(total(0.5));
  });

  it("moves notes further at a higher amount, always on the rows", () => {
    const rows = scaleRows("minor", 45, 81);
    const part = [n(0, 57), n(8, 60), n(16, 64), n(24, 69)];
    const spread = (amount) => {
      let max = 0;
      for (let seed = 0; seed < 80; seed++) {
        for (const o of varyNotes(part, rows, seeded(seed), amount)) {
          expect(rows).toContain(o.midi);
          const src = part.find((p) => p.step === o.step);
          if (src) max = Math.max(max, Math.abs(rows.indexOf(o.midi) - rows.indexOf(src.midi)));
        }
      }
      return max;
    };
    expect(spread(0.5)).toBeLessThanOrEqual(2);
    expect(spread(1)).toBeGreaterThan(spread(0.5));
    expect(varyNotes(part, rows, seeded(3), 0)).toEqual(part);
  });
});

describe("newPart", () => {
  const rows = scaleRows("minor", 45, 81);

  it("keeps the rhythm and the chord shapes of chordal or long leads, on new degrees", () => {
    const stabs = [57, 60, 64].flatMap((m) => [n(3, m, 2), n(11, m, 2)]);
    const outs = new Set();
    for (let seed = 1; seed < 20; seed++) {
      const out = newPart("lead", stabs, rows, seeded(seed));
      expect(out.map((o) => `${o.step}:${o.len}`).sort()).toEqual(stabs.map((o) => `${o.step}:${o.len}`).sort());
      for (const o of out) expect(rows).toContain(o.midi);
      outs.add(JSON.stringify(out));
    }
    expect(outs.size).toBeGreaterThan(3);
  });

  it("writes a fresh motif for single-step leads and other styles, reproducibly", () => {
    const arp = Array.from({ length: 32 }, (_, s) => n(s, 57));
    expect(newPart("lead", arp, rows, seeded(4))).toEqual(improvise("lead", rows, seeded(4)));
    expect(newPart("bass", [], rows, seeded(4))).toEqual(improvise("bass", rows, seeded(4)));
  });
});

describe("pattern tools", () => {
  const hitsOf = (steps) => steps.flatMap((v, s) => (v ? [s] : []));
  const drum = (hits) => {
    const steps = Array(32).fill(OFF);
    const mods = Array(32).fill(null);
    for (const s of hits) steps[s] = HIT;
    return { steps, mods };
  };

  it("euclid matches Strudel's euclid and euclidRot", () => {
    const x = (list) => list.map((v) => (v ? "x" : ".")).join("");
    expect(x(euclid(3, 8))).toBe("x..x..x.");
    expect(x(euclid(5, 8))).toBe("x.xx.xx.");
    expect(x(euclid(4, 16))).toBe("x...x...x...x...");
    expect(x(euclid(3, 8, 2))).toBe(".x..x.x.");
    expect(x(euclid(0, 4))).toBe("....");
    expect(x(euclid(4, 4))).toBe("xxxx");
  });

  it("euclidSteps repeats the cycle across the loop and clears the mods", () => {
    const { steps, mods } = euclidSteps(3, 8);
    expect(hitsOf(steps)).toEqual([0, 3, 6, 8, 11, 14, 16, 19, 22, 24, 27, 30]);
    expect(mods.every((m) => m === null)).toBe(true);
    // 5 does not divide 32: a polymeter that restarts on the loop.
    expect(hitsOf(euclidSteps(2, 5).steps).slice(0, 6)).toEqual([0, 2, 5, 7, 10, 12]);
  });

  it("rotatePart moves hits and their mods, wrapping", () => {
    const data = drum([0, 31]);
    data.mods[31] = { p: 0.5 };
    const out = rotatePart(data, "drum", 1);
    expect(hitsOf(out.steps)).toEqual([0, 1]);
    expect(out.mods[0]).toEqual({ p: 0.5 });
    expect(hitsOf(rotatePart(data, "drum", -1).steps)).toEqual([30, 31]);
  });

  it("reversePart mirrors around the first step, keeping the beat", () => {
    expect(hitsOf(reversePart(drum([0, 4, 6]), "drum").steps)).toEqual([0, 26, 28]);
    const notes = [n(0, 69, 8), n(8, 72, 8), n(16, 67, 8), n(24, 64, 8)];
    const out = reversePart({ notes }, "notes").notes;
    expect(out.map((x) => [x.step, x.midi])).toEqual([[0, 69], [8, 64], [16, 67], [24, 72]]);
  });

  it("moved notes stay inside the loop and clear of the next one on their row", () => {
    const out = rotatePart({ notes: [n(28, 60, 4), n(30, 60, 1)] }, "notes", 2).notes;
    expect(out).toEqual([n(0, 60, 1), n(30, 60, 2)]);
  });
});

describe("writePart: the AI's degrees as a 2-bar part", () => {
  const rows = (low, high, scale = "minor") => scaleRows(scale, low, high);
  const LEAD_ROWS = rows(45, 81); // A2..A5
  const at = (notes, step) => notes.filter((n) => n.step === step).map((n) => n.midi);

  it("plays a lead's motif, motif with its last note a degree lower, motif, answer", () => {
    const motif = ["1", "-", "3", "-", "5", "-", "-", "-"];
    const answer = ["8", "-", "-", "-", "7", "-", "-", "-"];
    const notes = writePart("lead", [...motif, ...answer], LEAD_ROWS);
    expect(at(notes, 0)).toEqual([57]); // degree 1: A3, the root below the middle one
    expect(at(notes, 2)).toEqual([60]); // C4
    expect(at(notes, 4)).toEqual([64]); // E4
    expect(at(notes, 12)).toEqual([62]); // the second motif ends a degree lower: D4
    expect(at(notes, 20)).toEqual([64]);
    expect(at(notes, 24)).toEqual([69]); // the answer: A4
    expect(at(notes, 28)).toEqual([67]);
    expect(notes.filter((n) => n.accent).map((n) => n.step)).toEqual([0, 8, 16, 24]);
    expect(notes.every((n) => inScale(n.midi, "minor"))).toBe(true);
  });

  it("repeats what is short, and writes nothing from rests", () => {
    expect(writePart("lead", ["1", "-", "3", "-", "5", "-", "-", "-"], LEAD_ROWS)).toEqual(
      writePart("lead", Array(2).fill(["1", "-", "3", "-", "5", "-", "-", "-"]).flat(), LEAD_ROWS),
    );
    expect(writePart("lead", ["-", "-"], LEAD_ROWS)).toBeNull();
    expect(writePart("lead", [], LEAD_ROWS)).toBeNull();
    expect(writePart("perc", ["1"], LEAD_ROWS)).toBeNull();
  });

  it("holds a triad on each bar's degree for a pad", () => {
    const notes = writePart("pad", ["1", "6"], rows(45, 69));
    expect(at(notes, 0)).toEqual([45, 48, 52]); // Am
    expect(at(notes, 16)).toEqual([53, 57, 60]); // F
    expect(notes.every((n) => n.len === 16)).toBe(true);
  });

  it("repeats a bass's one-beat cell under every beat", () => {
    const notes = writePart("bass", ["-", "1", "1", "5"], rows(33, 57));
    expect(notes).toHaveLength(24);
    expect(notes.some((n) => n.step % 4 === 0)).toBe(false);
    expect(at(notes, 1)).toEqual([33]);
    expect(at(notes, 31)).toEqual([40]); // E2
  });

  it("walks a lead made of chords onto the degrees, keeping its rhythm and shapes", () => {
    const factory = [0, 8].flatMap((s) => [57, 60, 64].map((midi) => ({ step: s, midi, len: 4, accent: false })));
    const notes = writePart("lead", ["1", "4"], LEAD_ROWS, factory);
    expect(at(notes, 0)).toEqual([57, 60, 64]);
    expect(at(notes, 8)).toEqual([62, 65, 69]); // the same shape on D
    expect(notes.every((n) => n.len === 4)).toBe(true);
  });
});
