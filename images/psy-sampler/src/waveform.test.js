import { describe, expect, it } from "vitest";
import { SHAPE_DEFAULT } from "./audio/shape.js";
import { dragTo, gainLine, markers, peaks, pick } from "./waveform.js";

const flat = { ...SHAPE_DEFAULT };
const sample = { id: "abcdefghijklmnopqrstuv", name: "x", pitch: 0, start: 0.2, length: 0.5, reverse: false };

describe("markers", () => {
  it("a voice runs from 0 to its cut", () => {
    expect(markers({ length: 0.8, fadeIn: 0.25, fadeOut: 0.5 })).toEqual({ start: 0, end: 0.8, fadeIn: 0.2, fadeOut: 0.4 });
  });

  it("a sample runs from its start through its length of what is left", () => {
    const m = markers({ ...flat, length: 0.1, fadeIn: 0.5 }, sample);
    expect(m.start).toBe(0.2);
    expect(m.end).toBeCloseTo(0.6, 9);
    expect(m.fadeIn).toBeCloseTo(0.4, 9); // the voice's cut is not the sample's
  });
});

describe("pick", () => {
  const m = markers({ length: 0.8, fadeIn: 0.25, fadeOut: 0.25 }, null);

  it("the top grabs the fades, the bottom the cut", () => {
    expect(pick(m, 0.21, 0.1, 0.02, null)).toBe("fadeIn");
    expect(pick(m, 0.59, 0.1, 0.02, null)).toBe("fadeOut");
    expect(pick(m, 0.79, 0.9, 0.02, null)).toBe("end");
  });

  it("nothing within reach grabs nothing, and a voice's start never moves", () => {
    expect(pick(m, 0.4, 0.1, 0.02, null)).toBeNull();
    expect(pick(m, 0, 0.9, 0.02, null)).toBeNull();
    expect(pick(markers(flat, sample), 0.2, 0.9, 0.02, sample)).toBe("start");
  });
});

describe("dragTo", () => {
  it("moves a voice's cut", () => {
    expect(dragTo("end", 0.333, flat, null).shape.length).toBe(0.33);
    expect(dragTo("end", 0, flat, null).shape.length).toBe(0.02);
  });

  it("a sample's start keeps its end in place", () => {
    const next = dragTo("start", 0.4, flat, sample).sample;
    expect(next.start).toBe(0.4);
    expect(markers(flat, next).end).toBeCloseTo(0.6, 2);
  });

  it("a sample's end sets its length", () => {
    expect(dragTo("end", 0.6, flat, { ...sample, start: 0, length: 1 }).sample.length).toBe(0.6);
  });

  it("the fades stop at each other", () => {
    const shape = { length: 1, fadeIn: 0, fadeOut: 0.4 };
    expect(dragTo("fadeIn", 0.9, shape, null).shape.fadeIn).toBe(0.6);
    expect(dragTo("fadeOut", 0, { ...shape, fadeIn: 0.7 }, null).shape.fadeOut).toBe(0.3);
    expect(dragTo("fadeIn", -1, shape, null).shape.fadeIn).toBe(0);
  });
});

describe("gainLine", () => {
  it("a flat voice holds full gain and rings out", () => {
    expect(gainLine(flat, null)).toEqual([[0, 1], [0, 1], [1, 1], [1, 1]]);
  });

  it("a cut or a fade-out ends in silence; a fade-in starts there", () => {
    expect(gainLine({ length: 0.5, fadeIn: 0.5, fadeOut: 0 }, null)).toEqual([[0, 0], [0.25, 1], [0.5, 1], [0.5, 0]]);
    expect(gainLine({ ...flat, fadeOut: 0.5 }, null).at(-1)).toEqual([1, 0]);
  });
});

describe("peaks", () => {
  it("gives each column the lowest and highest frame it covers", () => {
    expect(peaks(new Float32Array([0.5, -0.25, 1, -1]), 2)).toEqual([[-0.25, 0.5], [-1, 1]]);
  });

  it("a wave shorter than the drawing still fills every column", () => {
    expect(peaks(new Float32Array([0.5]), 3)).toHaveLength(3);
  });
});
