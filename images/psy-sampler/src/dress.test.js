import { describe, expect, it } from "vitest";
import { SYNTHS } from "./audio/params.js";
import { DEFAULTS, defaultData, paramSpecs } from "./audio/patterns.js";
import { FILLS, coin, dress, fillOf, fits, moves, restyle, synthsFor } from "./dress.js";

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
    expect(restyle("lead.acid", "s", { drive: 2 }, live).insert).toMatchObject({ drive: "hard", amount: 0.75, lp: 3000 });
    expect(restyle("lead.acid", "s", { drive: 1 }, live).insert).toMatchObject({ drive: "soft", amount: 0.4 });
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
    expect(next.insert).toMatchObject({ filter: "off", lfo: 0, trem: 0, width: 0, drive: "crush", amount: 0.75, lp: 3000 });
    expect(next.echo).toBeNull(); // the factory's
    expect(restyle("lead.grid", "s", { trem: "off" }, insertOf("lead.grid")).echo).toEqual(defaultData("lead.grid").echo ?? null);
    expect(restyle("lead.acid", "s", { tone: 1 }, live)).not.toHaveProperty("echo"); // no tweaks, no echo: mid as it was
    expect(restyle("lead.acid", "s", { sweep: "off" }, { ...live, lfo: 0.8 }).insert.lfo).toBe(0);
    expect(restyle("perc.hat", "s", { filter: "highpass" }, insertOf("perc.hat"))).not.toHaveProperty("echo");
  });

  it("the low end takes few tweaks: the kick grit, the bass a lowpass with an envelope", () => {
    expect(fits("kick.long", "distortion", "fold")).toBe(true);
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
