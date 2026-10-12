import { describe, expect, it } from "vitest";
import { CLASSICS, CLASSIC_IDS, line, midiOf } from "./classics.js";
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

  it("run as many loops as the melody, to its last one", () => {
    const loops = Object.fromEntries(CLASSIC_IDS.map((id) => [id, DEFAULTS[`classic.${id}`].data.loops]));
    expect(loops).toEqual({
      sandstorm: 2, axelF: 2, popcorn: 8, tetris: 4, mountainKing: 1, furElise: 6, toccata: 4, funkytown: 4, misirlou: 3,
    });
    for (const id of CLASSIC_IDS) {
      const { notes, loops: n } = DEFAULTS[`classic.${id}`].data;
      const end = Math.max(...notes.map((x) => x.step + x.len));
      expect(end, id).toBeGreaterThan((n - 1) * 32);
      expect(end, id).toBeLessThanOrEqual(n * 32);
    }
  });

  it("never overlap a note on its own row", () => {
    for (const id of CLASSIC_IDS) {
      const notes = [...DEFAULTS[`classic.${id}`].data.notes].sort((a, b) => a.step - b.step);
      for (const [i, n] of notes.entries()) {
        const next = notes.slice(i + 1).find((m) => m.midi === n.midi);
        if (next) expect(next.step, `${id} ${n.step}`).toBeGreaterThanOrEqual(n.step + n.len);
      }
    }
  });

  it("write a melody one note after the other", () => {
    expect(line([["A4", 2], [null, 1], ["C5", 1]], 4)).toEqual([[4, "A4", 2], [7, "C5", 1]]);
  });

  it("start on the downbeat", () => {
    for (const id of CLASSIC_IDS) expect(DEFAULTS[`classic.${id}`].data.notes[0].step, id).toBe(0);
  });
});
