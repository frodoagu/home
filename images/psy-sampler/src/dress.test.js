import { describe, expect, it } from "vitest";
import { SYNTHS } from "./audio/params.js";
import { DEFAULTS, defaultData, paramSpecs } from "./audio/patterns.js";
import {
  BASS_CUT,
  DOUBLE_ROLL,
  DROPS,
  FILLS,
  bassCutOf,
  coin,
  doubleRollOf,
  dress,
  dropBars,
  dropOf,
  dropPlan,
  fillOf,
  fits,
  moves,
  restyle,
  synthsFor,
  touched,
} from "./dress.js";

const groupOf = (synth) => SYNTHS.find((s) => s.id === synth).group;

describe("dress", () => {
  it("is the same for the same seed and sound, and differs across seeds", () => {
    expect(dress("kick.punchy", "goa")).toEqual(dress("kick.punchy", "goa"));
    const kicks = new Set(["a", "b", "c", "d", "e"].map((seed) => JSON.stringify(dress("kick.punchy", seed))));
    expect(kicks.size).toBeGreaterThan(3);
  });

  it("keeps every param on its slider and every synth in its group", () => {
    for (const id of Object.keys(DEFAULTS)) {
      for (const seed of ["x1", "x2", "x3"]) {
        const { params, synth } = dress(id, seed);
        for (const p of paramSpecs(id)) {
          expect(params[p.key], `${id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
          expect(params[p.key], `${id}.${p.key}`).toBeLessThanOrEqual(p.max);
        }
        if (DEFAULTS[id].kind === "notes") expect(groupOf(synth)).toBe(groupOf(defaultData(id).synth));
        else expect(synth).toBeUndefined();
      }
    }
  });

  it("leaves FX lengths alone and picks other synths across seeds", () => {
    expect(dress("fx.riser", "zz").params.bars).toBe(defaultData("fx.riser").params.bars);
    const synths = new Set(Array.from({ length: 30 }, (_, i) => dress("lead.acid", `s${i}`).synth));
    expect(synths.size).toBeGreaterThan(2);
  });
});

describe("fillOf", () => {
  it("is the same for the same seed, section and loop, and uses every fill across them", () => {
    expect(fillOf("goa", "peak", 4)).toBe(fillOf("goa", "peak", 4));
    const seen = new Set();
    for (const seed of ["a", "b", "c", "d", "e", "f"]) for (const at of [4, 8, 12]) seen.add(fillOf(seed, "peak", at));
    expect([...seen].sort()).toEqual([...FILLS].sort());
  });
});

describe("doubleRollOf", () => {
  const share = (section, last) => {
    const seeds = Array.from({ length: 400 }, (_, i) => `s${i}`);
    return seeds.filter((seed) => doubleRollOf(seed, section, 4, last)).length / seeds.length;
  };

  it("rolls some of a peak's phrases and some sections' last loop, and nothing else", () => {
    expect(doubleRollOf("goa", "peak", 8, false)).toBe(doubleRollOf("goa", "peak", 8, false));
    for (const [section, last, odds] of [["peak", false, DOUBLE_ROLL.peak], ["groove", true, DOUBLE_ROLL.last]]) {
      expect(share(section, last)).toBeGreaterThan(odds - 0.1);
      expect(share(section, last)).toBeLessThan(odds + 0.1);
    }
    expect(share("groove", false)).toBe(0);
    expect(share("breakdown", false)).toBe(0);
  });
});

describe("coin", () => {
  it("is a number in [0, 1), the same for the same seed and key", () => {
    expect(coin("goa", "improv/peak/lead.acid")).toBe(coin("goa", "improv/peak/lead.acid"));
    const values = ["a", "b", "c", "d"].map((seed) => coin(seed, "x"));
    for (const v of values) expect(v >= 0 && v < 1).toBe(true);
    expect(new Set(values).size).toBe(4);
  });
});

describe("restyle: the AI's macros over the seed's dress", () => {
  const insertOf = (id) => defaultData(id).insert;

  it("is the seed's dress with no macros, and the same for the same macros", () => {
    expect(restyle("kick.long", "s", null, insertOf("kick.long"))).toEqual(dress("kick.long", "s"));
    const macros = { id: "lead.acid", tone: 1, drive: 2 };
    expect(restyle("lead.acid", "s", macros, insertOf("lead.acid"))).toEqual(restyle("lead.acid", "s", macros, insertOf("lead.acid")));
  });

  it("tone moves the brightness sliders and length the decays, within range", () => {
    const seed = dress("kick.long", "s").params;
    const bright = restyle("kick.long", "s", { tone: 2 }, null).params;
    const dark = restyle("kick.long", "s", { tone: -2 }, null).params;
    expect(bright.f0).toBeGreaterThan(seed.f0);
    expect(dark.f0).toBeLessThan(seed.f0);
    expect(bright.decay).toBe(seed.decay); // tone leaves the length alone
    const long = restyle("kick.long", "s", { length: 2 }, null).params;
    expect(long.decay).toBeGreaterThan(seed.decay);
    expect(restyle("lead.acid", "s", { tone: -2 }, null).params.bright).toBeLessThan(dress("lead.acid", "s").params.bright);
    for (const id of Object.keys(DEFAULTS)) {
      for (const tone of [-2, 2]) {
        const params = restyle(id, "s", { tone, length: tone }, null).params;
        for (const p of paramSpecs(id)) {
          expect(params[p.key]).toBeGreaterThanOrEqual(p.min);
          expect(params[p.key]).toBeLessThanOrEqual(p.max);
        }
      }
    }
  });

  it("drive and motion set the insert from the factory's, and leave the rest of the live one", () => {
    const live = { ...insertOf("lead.acid"), lp: 3000, drive: "fold", amount: 0.9 };
    expect(restyle("lead.acid", "s", { drive: 2 }, live).insert).toMatchObject({ drive: "hard", amount: 0.4, lp: 3000 });
    expect(restyle("lead.acid", "s", { drive: 1 }, live).insert).toMatchObject({ drive: "soft", amount: 0.35 });
    expect(restyle("lead.acid", "s", { tone: 1 }, live).insert).toMatchObject({ drive: "off", lp: 3000 }); // back to the factory's
    expect(restyle("lead.acid", "s", { motion: 2 }, live).insert.phaser).toBe(0.5);
    const bits = restyle("lead.bits", "s", { motion: 2 }, insertOf("lead.bits")).insert;
    expect(bits.lfo).toBe(0.6); // it has a filter to sweep
    expect(restyle("lead.bits", "s", { motion: -2 }, insertOf("lead.bits")).insert.lfo).toBe(0);
    expect(restyle("kick.long", "s", { motion: 2 }, insertOf("kick.long")).insert.phaser).toBe(0); // never on a kick
    expect(moves("bass.rolling", "motion")).toBe(false);
    expect(moves("bass.rolling", "drive")).toBe(true);
  });

  it("high's tweaks build the insert and the echo from the factory's, and a new dress replaces them whole", () => {
    const live = { ...insertOf("lead.acid"), lp: 3000 };
    const t = restyle("lead.acid", "s", { filter: "vowel o", res: 2, sweep: "2 bars", shape: "triangle", env: -2, trem: "1/8", autopan: "slow", echo: "dotted 1/8" }, live);
    expect(t.insert).toMatchObject({ filter: "vowel", vowel: "o", res: 12, lfo: 0.4, rate: 32, shape: "triangle", env: -0.5, trem: 0.5, tremRate: 2, width: 0.6, panRate: 64, lp: 3000 });
    expect(t.echo).toEqual({ steps: 3, semis: 0 });
    const bright = restyle("lead.acid", "s", { filter: "lowpass", cutoff: 2 }, live).insert;
    expect(bright.cutoff).toBeGreaterThan(insertOf("lead.acid").cutoff * 5);
    expect(bright.cutoff).toBeLessThanOrEqual(16000);
    const next = restyle("lead.acid", "s", { distortion: "crush", drive: 2 }, { ...live, ...t.insert });
    expect(next.insert).toMatchObject({ filter: "off", lfo: 0, trem: 0, width: 0, drive: "crush", amount: 0.5, lp: 3000 });
    expect(next.echo).toBeNull(); // the factory's
    expect(restyle("lead.grid", "s", { trem: "off" }, insertOf("lead.grid")).echo).toEqual(defaultData("lead.grid").echo ?? null);
    expect(restyle("lead.acid", "s", { tone: 1 }, live)).not.toHaveProperty("echo"); // no tweaks, no echo: mid as it was
    expect(restyle("lead.acid", "s", { sweep: "off" }, { ...live, lfo: 0.8 }).insert.lfo).toBe(0);
    expect(restyle("perc.hat", "s", { filter: "highpass" }, insertOf("perc.hat"))).not.toHaveProperty("echo");
  });

  it("the AI drives gently: its own amounts, never the factory's 40 %, and less on the low end", () => {
    const clean = insertOf("lead.acid");
    expect(restyle("lead.acid", "s", { distortion: "fold" }, clean).insert).toMatchObject({ drive: "fold", amount: 0.1 });
    expect(restyle("lead.acid", "s", { distortion: "fold", drive: 2 }, clean).insert).toMatchObject({ drive: "fold", amount: 0.3 });
    expect(restyle("kick.long", "s", { drive: 2 }, insertOf("kick.long")).insert).toMatchObject({ drive: "soft", amount: 0.3 });
    expect(restyle("bass.rolling", "s", { drive: 2 }, insertOf("bass.rolling")).insert).toMatchObject({ drive: "hard", amount: 0.25 });
    expect(restyle("lead.acid", "s", { drive: -1 }, clean).insert.drive).toBe("off");
  });

  it("the low end takes few tweaks: the kick a soft grit, the bass a lowpass with an envelope", () => {
    expect(fits("kick.long", "distortion", "soft")).toBe(true);
    for (const d of ["hard", "fold", "crush"]) expect(fits("kick.long", "distortion", d)).toBe(false);
    expect(fits("bass.rolling", "distortion", "hard")).toBe(true);
    for (const d of ["fold", "crush"]) expect(fits("bass.rolling", "distortion", d)).toBe(false);
    expect(fits("pad.chord", "distortion", "fold")).toBe(false);
    expect(fits("pad.chord", "distortion", "crush")).toBe(true);
    expect(fits("lead.acid", "distortion", "fold")).toBe(true);
    for (const [k, v] of [["filter", "lowpass"], ["sweep", "bar"], ["trem", "1/8"], ["echo", "1/8"]]) expect(fits("kick.long", k, v)).toBe(false);
    expect(fits("bass.rolling", "filter", "lowpass")).toBe(true);
    expect(fits("bass.rolling", "filter", "vowel a")).toBe(false);
    expect(fits("bass.rolling", "env", 2)).toBe(true);
    expect(fits("bass.rolling", "sweep", "bar")).toBe(false);
    expect(fits("lead.acid", "echo", "1/4")).toBe(true);
    expect(fits("perc.hat", "echo", "1/4")).toBe(false);
    expect(fits("lead.acid", "cutoff", 0)).toBe(false); // 0 leaves it
    expect(fits("lead.acid", "cutoff", 3)).toBe(false);
    expect(fits("lead.acid", "filter", "__proto__")).toBe(false);
    expect(fits("lead.acid", "toString", "x")).toBe(false);
  });

  it("switches synth only within the sound's group", () => {
    expect(restyle("lead.acid", "s", { synth: "supersaw" }, null).synth).toBe("supersaw");
    expect(restyle("lead.acid", "s", { synth: "sub" }, null).synth).toBe(dress("lead.acid", "s").synth);
    expect(synthsFor("kick.long")).toEqual([]);
    expect(synthsFor("pad.chord").every((id) => groupOf(id) === "pad")).toBe(true);
  });
});

describe("dropOf", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => `s${i}`);

  it("is the same for the same seed and section, and differs from one drop to the next", () => {
    expect(dropOf("goa", "build", 3, 8)).toBe(dropOf("goa", "build", 3, 8));
    const shapes = new Set(Array.from({ length: 20 }, (_, n) => dropOf("goa", "build", n, 8)));
    expect(shapes.size).toBeGreaterThan(2);
  });

  it("draws every shape that fits, and none longer than `most`", () => {
    const long = new Set(seeds.map((seed) => dropOf(seed, "build", 1, 8)));
    expect(long.size).toBe(DROPS.length);
    const short = seeds.map((seed) => dropBars(dropOf(seed, "groove", 1, 2)));
    expect(new Set(short)).toEqual(new Set([1, 2]));
    expect(seeds.every((seed) => dropBars(dropOf(seed, "build", 1, 4)) <= 4)).toBe(true);
    expect(dropBars(dropOf("goa", "build", 1, 0))).toBe(1);
  });

  it("plays the classic two bars most often", () => {
    const share = seeds.filter((seed) => dropBars(dropOf(seed, "build", 2, 8)) === 2).length / seeds.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.5);
  });
});

describe("dropPlan", () => {
  it("rolls the kick faster and faster into the build-up bar, then leaves the gap", () => {
    expect(DROPS.map(dropPlan)).toEqual([
      ["gap"],
      ["build", "gap"],
      ["pulse8", "build", "gap", "gap"],
      ["pulse4", "pulse8", "build", "gap"],
      ["pulse4", "pulse4", "pulse8", "pulse8", "pulse8", "build", "gap", "gap"],
    ]);
    for (const d of DROPS) expect(dropPlan(d)).toHaveLength(dropBars(d));
  });
});

describe("bassCutOf", () => {
  const seeds = Array.from({ length: 600 }, (_, i) => `s${i}`);
  const cuts = (section) => seeds.map((seed) => bassCutOf(seed, section, 4));

  it("cuts the bass out of some of a groove's and a peak's phrase ends, a bar more often than two", () => {
    expect(bassCutOf("goa", "peak", 8)).toBe(bassCutOf("goa", "peak", 8));
    for (const [section, odds] of Object.entries(BASS_CUT)) {
      const all = cuts(section);
      const share = all.filter(Boolean).length / all.length;
      expect(share).toBeGreaterThan(odds - 0.08);
      expect(share).toBeLessThan(odds + 0.08);
      expect(all.filter((b) => b === 1).length).toBeGreaterThan(all.filter((b) => b === 2).length);
      expect(new Set(all)).toEqual(new Set([0, 1, 2]));
    }
  });

  it("never in a section without a bass groove to cut", () => {
    for (const section of ["intro", "build", "breakdown", "outro"]) expect(cuts(section).every((b) => b === 0)).toBe(true);
  });
});

describe("touched: a ✨ touch over a sound's dress", () => {
  const live = { ...defaultData("lead.acid").insert, lp: 3000 };

  it("lays its filter and distortion over the dress, which keeps the rest", () => {
    const dressed = { id: "lead.acid", motion: 2, filter: "vowel o", trem: "1/8" };
    const insert = touched("lead.acid", "s", dressed, { id: "lead.acid", loops: 2, filter: "lowpass", res: 2, distortion: "hard", drive: 2 }, live);
    expect(insert).toMatchObject({ filter: "lowpass", res: 12, drive: "hard", amount: 0.4, trem: 0.5, lp: 3000 });
    expect(insert.phaser).toBe(restyle("lead.acid", "s", dressed, live).insert.phaser);
  });

  it("is the dress itself with nothing to lay, and a drive alone grits a clean sound", () => {
    expect(touched("lead.acid", "s", null, { id: "lead.acid", loops: 1 }, live)).toEqual(restyle("lead.acid", "s", {}, live).insert);
    expect(touched("lead.acid", "s", null, { id: "lead.acid", loops: 1, drive: 1 }, live)).toMatchObject({ drive: "soft", amount: 0.35 });
  });

  it("a distortion it names plays even where the dress drove the sound clean", () => {
    const clean = { id: "lead.acid", drive: -2 };
    expect(restyle("lead.acid", "s", { ...clean, distortion: "fold" }, live).insert.drive).toBe("off");
    expect(touched("lead.acid", "s", clean, { id: "lead.acid", loops: 1, distortion: "fold" }, live)).toMatchObject({ drive: "fold", amount: 0.1 });
  });
});
