import { describe, expect, it } from "vitest";
import { DB, SYNTH_DB, trimOf } from "./loudness.js";
import { DEFAULTS, defaultData, sampleDefaults } from "./patterns.js";
import { SYNTH_IDS } from "./params.js";

const db = (gain) => 20 * Math.log10(gain);

describe("loudness", () => {
  it("names only real sounds and synths, and leaves the kicks as the reference", () => {
    for (const id of Object.keys(DB)) expect(DEFAULTS).toHaveProperty([id]);
    for (const synth of Object.keys(SYNTH_DB)) expect(SYNTH_IDS).toContain(synth);
    for (const id of Object.keys(DEFAULTS).filter((k) => k.startsWith("kick."))) {
      expect(trimOf(id, defaultData(id))).toBe(1);
    }
  });

  it("a sound plays at its own level times its synth's; a copy at its base's", () => {
    const data = defaultData("lead.acid");
    expect(db(trimOf("lead.acid", data))).toBeCloseTo(DB["lead.acid"] + SYNTH_DB.acid, 9);
    expect(trimOf("lead.acid~2", data)).toBe(trimOf("lead.acid", data));
    const swapped = { ...data, synth: "piano" };
    expect(db(trimOf("lead.acid", swapped))).toBeCloseTo(DB["lead.acid"] + SYNTH_DB.piano, 9);
  });

  it("a user's sample plays at the layer's level: it is not the voice that was measured", () => {
    const data = { ...defaultData("lead.techno"), sample: sampleDefaults("abcdefghijklmnop") };
    expect(trimOf("lead.techno", data)).toBe(1);
  });

  it("the sounds that buried the kick come down at least 6 dB", () => {
    for (const id of ["lead.techno", "lead.squelch", "lead.stabs", "pad.supersaw", "classic.toccata"]) {
      expect(db(trimOf(id, defaultData(id)))).toBeLessThan(-6);
    }
  });
});
