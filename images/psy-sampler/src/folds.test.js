import { describe, expect, it } from "vitest";
import { DEFAULTS } from "./audio/patterns.js";
import { FOLDS, cleanFolds, foldActive } from "./folds.js";

const tweaked = (id, patch = {}, insert = {}) => {
  const data = DEFAULTS[id].data;
  return { ...data, ...patch, insert: { ...data.insert, ...insert } };
};

describe("cleanFolds", () => {
  it("folds every box unless it was stored open", () => {
    expect(cleanFolds()).toEqual({ insert: false, modulation: false, space: false, pattern: false });
    expect(cleanFolds({ pattern: true, space: "yes", gone: true })).toEqual({
      insert: false,
      modulation: false,
      space: false,
      pattern: true,
    });
  });
});

describe("foldActive", () => {
  it("no box is active on a neutral factory sound, of any kind", () => {
    for (const id of ["kick.punchy", "bass.offbeat", "pad.chord", "fx.riser"]) {
      expect(FOLDS.filter((k) => foldActive(k, DEFAULTS[id].data)), id).toEqual([]);
    }
  });

  it("a factory filter counts: active means off neutral, not off the factory", () => {
    expect(foldActive("insert", DEFAULTS["lead.bits"].data)).toBe(true);
  });

  it("the insert: a filter, a distortion, or the tone closed from either end", () => {
    expect(foldActive("insert", tweaked("pad.chord", {}, { filter: "vowel" }))).toBe(true);
    expect(foldActive("insert", tweaked("pad.chord", {}, { drive: "crush" }))).toBe(true);
    expect(foldActive("insert", tweaked("pad.chord", {}, { hp: 21 }))).toBe(true);
    expect(foldActive("insert", tweaked("pad.chord", {}, { lp: 19999 }))).toBe(true);
    // Knobs of a filter that is off change nothing.
    expect(foldActive("insert", tweaked("pad.chord", {}, { cutoff: 300, res: 9, lfo: 1, env: 1 }))).toBe(false);
  });

  it("modulation: phaser or tremolo, whatever their rates", () => {
    expect(foldActive("modulation", tweaked("pad.chord", {}, { phaserRate: 2, tremRate: 1 }))).toBe(false);
    expect(foldActive("modulation", tweaked("pad.chord", {}, { phaser: 0.05 }))).toBe(true);
    expect(foldActive("modulation", tweaked("pad.chord", {}, { trem: 0.05 }))).toBe(true);
  });

  it("space: groove or pan; an FX has no groove at all", () => {
    for (const patch of [{ swing: 0.1 }, { nudge: -3 }, { duck: 0.5 }]) {
      expect(foldActive("space", tweaked("bass.offbeat", patch))).toBe(true);
    }
    expect(foldActive("space", tweaked("fx.riser", {}, { pan: -0.5 }))).toBe(true);
    expect(foldActive("space", tweaked("fx.riser", {}, { width: 0.2 }))).toBe(true);
    expect(foldActive("space", tweaked("fx.riser", {}, { panRate: 8 }))).toBe(false);
  });

  it("pattern: speed, iter or echo", () => {
    expect(foldActive("pattern", tweaked("kick.punchy", { speed: 0.5 }))).toBe(true);
    expect(foldActive("pattern", tweaked("kick.punchy", { iter: 4 }))).toBe(true);
    expect(foldActive("pattern", tweaked("lead.bits", { echo: { steps: 3, semis: 7 } }))).toBe(true);
    expect(foldActive("pattern", tweaked("kick.punchy", { echo: null }))).toBe(false);
  });
});
