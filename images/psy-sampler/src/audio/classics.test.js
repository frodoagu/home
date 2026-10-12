import { describe, expect, it } from "vitest";
import { CLASSICS, CLASSIC_IDS, midiOf } from "./classics.js";
import { DEFAULTS } from "./patterns.js";
import { layerById } from "../catalog.js";

describe("classics", () => {
  it("reads pitch names", () => {
    expect(midiOf("A4")).toBe(69);
    expect(midiOf("C4")).toBe(60);
    expect(midiOf("C#5")).toBe(73);
    expect(midiOf("Bb4")).toBe(70);
    expect(midiOf("G#4")).toBe(68);
  });

  it("are all in the classic layer, as melodic variants that keep their speed", () => {
    expect(layerById("classic").variants).toEqual(CLASSIC_IDS.map((id) => `classic.${id}`));
    for (const id of CLASSIC_IDS) {
      const { kind, data } = DEFAULTS[`classic.${id}`];
      expect(kind).toBe("notes");
      expect(data.speed).toBe(CLASSICS[id].speed ?? 1);
      expect(data.notes).toHaveLength(CLASSICS[id].notes.length);
    }
  });

  it("never overlap themselves: one note at a time", () => {
    for (const id of CLASSIC_IDS) {
      const notes = [...DEFAULTS[`classic.${id}`].data.notes].sort((a, b) => a.step - b.step);
      for (let i = 1; i < notes.length; i++) {
        expect(notes[i].step, id).toBeGreaterThanOrEqual(notes[i - 1].step + notes[i - 1].len);
      }
    }
  });

  it("start on the downbeat", () => {
    for (const id of CLASSIC_IDS) expect(DEFAULTS[`classic.${id}`].data.notes[0].step, id).toBe(0);
  });
});
