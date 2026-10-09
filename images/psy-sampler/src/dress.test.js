import { describe, expect, it } from "vitest";
import { SYNTHS } from "./audio/params.js";
import { DEFAULTS, defaultData, paramSpecs } from "./audio/patterns.js";
import { dress } from "./dress.js";

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
