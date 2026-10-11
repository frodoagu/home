import { describe, expect, it } from "vitest";
import { inAMinor, inScale, midiToFreq, NOTE } from "./music.js";
import { LEVEL, PARAMS, SYNTH_IDS } from "./params.js";
import {
  ACCENT,
  ACID_LINE,
  DEFAULTS,
  HIT,
  LOOP_VARIANTS,
  auditionEvent,
  baseOf,
  defOf,
  isVariant,
  defaultData,
  eventsAt,
  paramSpecs,
  sampleDefaults,
  sanitize,
  cleanInsert,
  cleanMod,
  cleanSample,
  passes,
} from "./patterns.js";
import { INSERT_DEFAULT } from "./insert.js";

const STEPS = [...Array(32).keys()];
const stepsWith = (variant) => STEPS.filter((s) => eventsAt(variant, s).length > 0);
const first = (variant, step) => eventsAt(variant, step)[0];

describe("kick", () => {
  it("hits once per beat in every variant", () => {
    for (const v of ["kick.punchy", "kick.long", "kick.tok", "kick.fullon"]) {
      expect(stepsWith(v)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    }
  });

  it("carries the variant's sweep and decay into the event", () => {
    expect(first("kick.punchy", 0)).toMatchObject({ voice: "kick", f0: 170, f1: 50, sweep: 0.07, decay: 0.2, click: 1 });
    expect(first("kick.long", 0)).toMatchObject({ f0: 120, f1: 42, sweep: 0.16, decay: 0.34, click: 0 });
  });
});

describe("bass", () => {
  it("offbeat plays A1 on step % 4 === 2 only", () => {
    expect(stepsWith("bass.offbeat")).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
    expect(first("bass.offbeat", 2)).toMatchObject({ voice: "bass", steps: 1 });
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
  });

  it("gallop plays the last two 16ths of each beat (K-BB)", () => {
    expect(stepsWith("bass.gallop").slice(0, 4)).toEqual([2, 3, 6, 7]);
  });
});

describe("percussion", () => {
  it("open hat on the offbeat, closed hat on the odd 16ths", () => {
    expect(stepsWith("perc.hat")).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
    expect(stepsWith("perc.chat")).toEqual(STEPS.filter((s) => s % 2 === 1));
  });

  it("shaker on every step with alternating accent", () => {
    expect(stepsWith("perc.shaker")).toEqual(STEPS);
    expect(STEPS.map((s) => first("perc.shaker", s).accent)).toEqual(STEPS.map((s) => s % 2 === 0));
  });

  it("clap on beats 2 and 4; snare adds a roll into the loop", () => {
    expect(stepsWith("perc.clap")).toEqual([4, 12, 20, 28]);
    expect(stepsWith("perc.snare")).toEqual([4, 12, 20, 28, 29, 30, 31]);
  });

  it("toms are pitched notes played by the tom synth", () => {
    expect(first("perc.toms", 3)).toMatchObject({ voice: "tom", freq: midiToFreq(NOTE.A3) });
  });

  it("keys accent the offbeat of beats 2 and 4, with hits on steps 3 and 9", () => {
    expect(stepsWith("perc.keys")).toEqual([3, 6, 9, 14, 19, 22, 25, 30]);
    expect(stepsWith("perc.keys").filter((s) => first("perc.keys", s).accent)).toEqual([6, 14, 22, 30]);
  });
});

describe("lead", () => {
  it("acid repeats a 16-step A minor line with rests and accents", () => {
    expect(ACID_LINE).toHaveLength(16);
    expect(ACID_LINE.some((n) => n === null)).toBe(true);
    expect(ACID_LINE.filter(Boolean).every((n) => inAMinor(n.note))).toBe(true);
    for (let s = 0; s < 16; s++) expect(eventsAt("lead.acid", s)).toEqual(eventsAt("lead.acid", s + 16));
    expect(first("lead.acid", 0)).toMatchObject({ voice: "acid", accent: true });
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

  it("stabs play a 3-note chord per hit", () => {
    expect(eventsAt("lead.stabs", 3)).toHaveLength(3);
  });

  it("grid answers every accented note with the same note, unaccented, a dotted 8th later", () => {
    const hits = stepsWith("lead.grid");
    expect(hits).toEqual([0, 3, 6, 9, 12, 15, 16, 19, 22, 25, 28, 31]);
    for (const s of hits.filter((_, i) => i % 2 === 0)) {
      expect(first("lead.grid", s)).toMatchObject({ voice: "pluck", accent: true });
      expect(first("lead.grid", s + 3)).toMatchObject({ freq: first("lead.grid", s).freq, accent: false });
    }
  });
});

describe("pad", () => {
  it("retriggers an A minor triad every 16 steps", () => {
    expect(stepsWith("pad.chord")).toEqual([0, 16]);
    const chord = eventsAt("pad.chord", 0);
    expect(chord.map((e) => e.freq)).toEqual([NOTE.A3, NOTE.C4, NOTE.E4].map(midiToFreq));
    expect(chord.every((e) => e.steps === 16)).toBe(true);
  });

  it("the progression moves to B♭ major in bar 2", () => {
    expect(eventsAt("pad.prog", 16).map((e) => e.freq)).toEqual([NOTE.Bb3, NOTE.D4, NOTE.F4].map(midiToFreq));
  });
});

describe("entering (lane opened mid-phrase)", () => {
  it("starts notes in progress with what is left of them", () => {
    const ev = eventsAt("lead.melodic", 11, true)[0];
    expect(ev.freq).toBe(first("lead.melodic", 8).freq);
    expect(ev.steps).toBe(5); // up to the retrigger on step 16
    expect(eventsAt("pad.chord", 21, true).map((e) => e.steps)).toEqual([11, 11, 11]);
    expect(eventsAt("pad.chord", 21, false)).toEqual([]);
  });

  it("changes nothing for variants made of 1-step notes or drum hits", () => {
    for (const v of ["kick.punchy", "perc.shaker", "bass.rolling", "lead.acid", "lead.arp"]) {
      for (const s of STEPS) expect(eventsAt(v, s, true)).toEqual(eventsAt(v, s));
    }
  });
});

describe("edited data", () => {
  it("plays the data it is given instead of the defaults", () => {
    const data = { ...defaultData("perc.hat"), steps: STEPS.map((s) => (s === 5 ? ACCENT : 0)) };
    expect(STEPS.filter((s) => eventsAt("perc.hat", s, false, data).length)).toEqual([5]);
    expect(eventsAt("perc.hat", 5, false, data)[0].accent).toBe(true);
  });

  it("applies synth, params and transpose to every note", () => {
    const data = { ...defaultData("bass.offbeat"), synth: "fmBass", transpose: 12, params: { bright: 2 } };
    expect(eventsAt("bass.offbeat", 2, false, data)[0]).toMatchObject({ voice: "fmBass", bright: 2 });
    expect(eventsAt("bass.offbeat", 2, false, data)[0].freq).toBeCloseTo(110, 10);
  });

  it("defaultData is a deep copy", () => {
    const d = defaultData("lead.arp");
    d.notes.push({ step: 0, midi: 60, len: 1, accent: false });
    expect(DEFAULTS["lead.arp"].data.notes).toHaveLength(32);
  });
});

describe("defaults are consistent", () => {
  it("every param sits inside its slider range", () => {
    for (const id of Object.keys(DEFAULTS)) {
      const { params, level } = DEFAULTS[id].data;
      expect(level).toBe(LEVEL.def);
      for (const p of paramSpecs(id)) {
        expect(params[p.key], `${id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
        expect(params[p.key], `${id}.${p.key}`).toBeLessThanOrEqual(p.max);
      }
    }
  });

  it("melodic variants use a known synth, fit their roll and stay in key", () => {
    for (const id of LOOP_VARIANTS.filter((v) => DEFAULTS[v].kind === "notes")) {
      const { low, high, data } = DEFAULTS[id];
      expect(SYNTH_IDS).toContain(data.synth);
      for (const n of data.notes) {
        expect(n.midi).toBeGreaterThanOrEqual(low);
        expect(n.midi).toBeLessThanOrEqual(high);
        expect(n.step + n.len).toBeLessThanOrEqual(32);
        expect(inScale(n.midi, id === "pad.prog" ? "phrygian" : data.scale), `${id} ${n.midi}`).toBe(true);
      }
    }
  });

  it("every FX has its slider spec", () => {
    for (const id of Object.keys(DEFAULTS).filter((v) => DEFAULTS[v].kind === "fx")) expect(PARAMS[id]).toBeDefined();
  });
});

describe("auditionEvent", () => {
  it("previews a note with the variant's synth, or a hit with its voice", () => {
    const ev = auditionEvent("lead.acid", defaultData("lead.acid"), { midi: 69 });
    expect(ev).toMatchObject({ voice: "acid", freq: 440, steps: 2, accent: false });
    expect(auditionEvent("perc.clap", defaultData("perc.clap"), { accent: true })).toMatchObject({ voice: "clap", accent: true });
    expect(auditionEvent("fx.crash", defaultData("fx.crash"), {})).toBeNull();
  });
});

describe("sanitize", () => {
  it("falls back to the defaults for garbage", () => {
    expect(sanitize("perc.hat", null)).toEqual(defaultData("perc.hat"));
    expect(sanitize("perc.hat", "x")).toEqual(defaultData("perc.hat"));
  });

  it("keeps valid edits and clamps or drops the rest", () => {
    const out = sanitize("lead.arp", {
      notes: [
        { step: 0, midi: 60, len: 4, accent: true },
        { step: 30, midi: 60, len: 4 }, // runs past the loop
        { step: -1, midi: 60, len: 1 },
        "nope",
      ],
      synth: "theremin",
      scale: "phrygian",
      transpose: 7,
      len: 3,
      level: 9,
      params: { bright: 100 },
    });
    expect(out.notes).toEqual([{ step: 0, midi: 60, len: 4, accent: true }]);
    expect(out.synth).toBe("arp");
    expect(out.scale).toBe("phrygian");
    expect(sanitize("lead.arp", { scale: "constructor" }).scale).toBe(defaultData("lead.arp").scale);
    expect(out.transpose).toBe(0);
    expect(out.len).toBe(1);
    expect(out.level).toBe(LEVEL.max);
    expect(out.params.bright).toBe(4);
  });

  it("rejects drum grids of the wrong length and bad cell values", () => {
    expect(sanitize("perc.hat", { steps: [1, 2] }).steps).toEqual(defaultData("perc.hat").steps);
    const steps = sanitize("perc.hat", { steps: STEPS.map((s) => (s === 0 ? 7 : HIT)) }).steps;
    expect(steps[0]).toBe(0);
    expect(steps[1]).toBe(HIT);
  });
});

it("unknown variants and FX play nothing in the loop", () => {
  expect(eventsAt("nope", 0)).toEqual([]);
  expect(eventsAt("fx.riser", 0)).toEqual([]);
  expect(LOOP_VARIANTS).toHaveLength(62);
});

describe("copies", () => {
  it("resolve kind, params and events through their base variant", () => {
    expect(baseOf("kick.punchy~3")).toBe("kick.punchy");
    expect(defOf("bass.rolling~2")).toBe(DEFAULTS["bass.rolling"]);
    expect(paramSpecs("fx.riser~1")).toBe(paramSpecs("fx.riser"));
    expect(eventsAt("kick.punchy~1", 0)).toEqual(eventsAt("kick.punchy", 0));
    expect(sanitize("lead.acid~4", { synth: "pluck" }).synth).toBe("pluck");
  });

  it("only well-formed ids of known bases are variants", () => {
    expect(isVariant("kick.punchy")).toBe(true);
    expect(isVariant("kick.punchy~12")).toBe(true);
    for (const id of ["kick.nope", "kick.nope~1", "kick.punchy~", "kick.punchy~0", "kick.punchy~1~2", "kick.punchy~x", 3, null]) {
      expect(isVariant(id)).toBe(false);
    }
  });
});

describe("insert and sample data", () => {
  it("every variant starts with its insert bypassed (but lead.bits) and no sample", () => {
    for (const [id, def] of Object.entries(DEFAULTS)) {
      expect(def.data.sample, id).toBeNull();
      if (id !== "lead.bits") expect(def.data.insert, id).toEqual(INSERT_DEFAULT);
    }
    expect(DEFAULTS["lead.bits"].data.insert).toMatchObject({ filter: "lowpass", lfo: 0.45 });
  });

  it("a sample replaces the voice and keeps it as the fallback", () => {
    const sample = sampleDefaults("abcdefghijklmnopqrstuv", "Clap");
    const drum = { ...defaultData("perc.clap"), sample };
    expect(eventsAt("perc.clap", 4, false, drum)).toEqual([expect.objectContaining({ voice: "sample", fallback: "clap", sample })]);
    const notes = { ...defaultData("lead.melodic"), sample };
    const [ev] = eventsAt("lead.melodic", 0, false, notes);
    expect(ev).toMatchObject({ voice: "sample", fallback: "lead", sample, steps: 8 });
    expect(ev.freq).toBeCloseTo(440, 9);
    expect(auditionEvent("perc.clap", drum)).toMatchObject({ voice: "sample", fallback: "clap" });
  });

  it("sanitize keeps a valid insert and sample, and clamps or drops the rest", () => {
    const id = "abcdefghijklmnopqrstuv";
    const out = sanitize("perc.hat", {
      insert: { filter: "bandpass", cutoff: 99999, res: 3, lfo: -1, rate: 7, drive: "fuzz", amount: 0.5 },
      sample: { id, name: " Snare ", pitch: 99, start: 0.2, length: 0, reverse: "yes", extra: 1 },
    });
    expect(out.insert).toEqual({ ...INSERT_DEFAULT, filter: "bandpass", cutoff: 16000, res: 3, lfo: 0, amount: 0.5 });
    expect(out.sample).toEqual({ id, name: "Snare", pitch: 24, start: 0.2, length: 0.02, reverse: false });
    expect(sanitize("perc.hat", { sample: { id: "../../etc" } }).sample).toBeNull();
    expect(sanitize("perc.hat", { insert: "nope" }).insert).toEqual(INSERT_DEFAULT);
    expect(cleanSample({ id, reverse: true })).toMatchObject({ reverse: true, pitch: 0, length: 1 });
    expect(cleanInsert(undefined)).toEqual(INSERT_DEFAULT);
  });
});

describe("mods", () => {
  const hat = () => defaultData("perc.hat"); // offbeats: 2, 6, 10…

  it("a condition plays on loop a of every b, or never there with !", () => {
    const loops = Array.from({ length: 8 }, (_, l) => l);
    expect(loops.filter((l) => passes({ cond: "1:4" }, "x", 0, l))).toEqual([0, 4]);
    expect(loops.filter((l) => passes({ cond: "2:2" }, "x", 0, l))).toEqual([1, 3, 5, 7]);
    expect(loops.filter((l) => passes({ cond: "!4:4" }, "x", 0, l))).toEqual([0, 1, 2, 4, 5, 6]);
    // A WAV render's warm-up pass is loop -1: the last of every b.
    expect(passes({ cond: "4:4" }, "x", 0, -1)).toBe(true);
  });

  it("a chance is a fixed draw per id, loop and step, near its rate", () => {
    const plays = (p, id = "perc.hat") =>
      Array.from({ length: 400 }, (_, l) => passes({ p }, id, 2, l));
    expect(plays(0.5)).toEqual(plays(0.5));
    const rate = (p) => plays(p).filter(Boolean).length / 400;
    for (const p of [0.9, 0.75, 0.5, 0.25, 0.1]) expect(Math.abs(rate(p) - p)).toBeLessThan(0.08);
    expect(plays(0.5, "perc.hat~2")).not.toEqual(plays(0.5));
  });

  it("a drum hit is skipped by its mod and ratcheted by ply", () => {
    const d = hat();
    d.mods[2] = { cond: "2:2", ply: 3 };
    expect(eventsAt("perc.hat", 2, false, d, 0)).toEqual([]);
    const evs = eventsAt("perc.hat", 2, false, d, 1);
    expect(evs.map((e) => e.offset)).toEqual([0, 1 / 3, 2 / 3]);
    expect(eventsAt("perc.hat", 6, false, d, 0)).toHaveLength(1);
  });

  it("a note ratchets over its length and joins mid-note as one", () => {
    const d = defaultData("lead.melodic"); // 8-step notes on 0, 8, 16, 24
    d.notes[0] = { ...d.notes[0], ply: 4 };
    const evs = eventsAt("lead.melodic", 0, false, d);
    expect(evs.map((e) => [e.offset, e.steps])).toEqual([[0, 2], [2, 2], [4, 2], [6, 2]]);
    const joined = eventsAt("lead.melodic", 3, true, d);
    expect(joined).toHaveLength(1);
    expect(joined[0].steps).toBe(5);
    expect(joined[0].offset).toBeUndefined();
  });

  it("a note's chance and condition hold for its whole length", () => {
    const d = defaultData("lead.melodic");
    d.notes[0] = { ...d.notes[0], cond: "1:2" };
    expect(eventsAt("lead.melodic", 3, true, d, 1)).toEqual([]);
    expect(eventsAt("lead.melodic", 3, true, d, 0)).toHaveLength(1);
  });

  it("cleanMod keeps valid, non-default keys only", () => {
    expect(cleanMod({ p: 1, cond: null, ply: 1 })).toBeNull();
    expect(cleanMod({ p: 0.33, cond: "5:4", ply: 9 })).toBeNull();
    expect(cleanMod({ ply: 2, cond: "!3:8", p: 0.1, x: 1 })).toEqual({ p: 0.1, cond: "!3:8", ply: 2 });
    expect(Object.keys(cleanMod({ ply: 2, p: 0.5 }))).toEqual(["p", "ply"]);
  });

  it("sanitize keeps mods on hits and notes, and drops them elsewhere", () => {
    const d = defaultData("perc.hat");
    const mods = Array(32).fill(null);
    mods[2] = { p: 0.5 };
    mods[3] = { p: 0.5 }; // empty step
    const out = sanitize("perc.hat", { ...d, mods });
    expect(out.mods[2]).toEqual({ p: 0.5 });
    expect(out.mods[3]).toBeNull();
    expect(sanitize("perc.hat", { ...d, mods: "x" }).mods).toEqual(Array(32).fill(null));
    // Old saved data has no mods at all: it sanitizes back to the factory shape.
    const { mods: _, ...old } = d;
    expect(JSON.stringify(sanitize("perc.hat", old))).toBe(JSON.stringify(d));
    const notes = sanitize("lead.melodic", { ...defaultData("lead.melodic"), notes: [{ step: 0, midi: 69, len: 2, accent: false, ply: 2, p: 7 }] });
    expect(notes.notes).toEqual([{ step: 0, midi: 69, len: 2, accent: false, ply: 2 }]);
  });
});
