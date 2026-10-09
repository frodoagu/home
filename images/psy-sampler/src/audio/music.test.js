import { describe, expect, it } from "vitest";
import { centsToRatio, inAMinor, inScale, isRoot, midiToFreq, noteName, NOTE, scaleRows } from "./music.js";

describe("music", () => {
  it("maps MIDI to equal-tempered Hz around A4 = 440", () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(NOTE.A1)).toBeCloseTo(55, 10);
    expect(midiToFreq(NOTE.C4)).toBeCloseTo(261.626, 3);
  });

  it("converts cents to a frequency ratio", () => {
    expect(centsToRatio(1200)).toBe(2);
    expect(centsToRatio(0)).toBe(1);
    expect(centsToRatio(7) * centsToRatio(-7)).toBeCloseTo(1, 12);
  });

  it("knows the A natural minor scale", () => {
    expect([NOTE.A2, NOTE.C3, NOTE.D3, NOTE.E3, NOTE.G3].every(inAMinor)).toBe(true);
    expect(inAMinor(61)).toBe(false); // C#4
    expect(inAMinor(66)).toBe(false); // F#4
  });

  it("knows Phrygian (B♭) and harmonic minor (G#)", () => {
    expect(inScale(58, "phrygian")).toBe(true); // B♭3
    expect(inScale(59, "phrygian")).toBe(false); // B3
    expect(inScale(56, "harmonic")).toBe(true); // G#3
    expect(inScale(55, "harmonic")).toBe(false); // G3
    expect([...Array(12).keys()].every((i) => inScale(60 + i, "chromatic"))).toBe(true);
  });

  it("names notes in Spanish with their octave", () => {
    expect(noteName(69)).toBe("La4");
    expect(noteName(60)).toBe("Do4");
    expect(noteName(NOTE.Bb3)).toBe("Si♭3");
    expect(noteName(NOTE.A1)).toBe("La1");
    expect(isRoot(NOTE.A2) && !isRoot(NOTE.C3)).toBe(true);
  });

  it("builds piano-roll rows highest first, keeping notes outside the scale", () => {
    expect(scaleRows("minor", 57, 69)).toEqual([69, 67, 65, 64, 62, 60, 59, 57]);
    expect(scaleRows("minor", 57, 69, [61, 69])).toEqual([69, 67, 65, 64, 62, 61, 60, 59, 57]);
    expect(scaleRows("chromatic", 57, 69)).toHaveLength(13);
  });
});
