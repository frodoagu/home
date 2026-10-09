import { describe, expect, it } from "vitest";
import { centsToRatio, inAMinor, midiToFreq, NOTE } from "./music.js";

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
});
