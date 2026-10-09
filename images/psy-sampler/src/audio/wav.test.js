import { describe, expect, it } from "vitest";
import { encodeWav, trimTail } from "./wav.js";

const text = (view, at, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(at + i)));
const int24 = (view, at) => {
  const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  return v & 0x800000 ? v - 0x1000000 : v;
};

describe("encodeWav", () => {
  const left = new Float32Array([0, 1, -1, 0.5]);
  const right = new Float32Array([0, -0.5, 2, -2]);
  const view = new DataView(encodeWav({ sampleRate: 48000, channels: [left, right] }));

  it("writes a 24-bit stereo PCM header", () => {
    expect(text(view, 0, 4)).toBe("RIFF");
    expect(text(view, 8, 8)).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 6);
    expect(view.getUint16(32, true)).toBe(6);
    expect(view.getUint16(34, true)).toBe(24);
    expect(text(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4 * 6);
    expect(view.byteLength).toBe(44 + 24);
  });

  it("interleaves the channels and clips to full scale", () => {
    const samples = Array.from({ length: 8 }, (_, i) => int24(view, 44 + i * 3));
    expect(samples).toEqual([0, 0, 0x7fffff, -0x3fffff, -0x7fffff, 0x7fffff, 0x400000, -0x7fffff]);
  });
});

describe("trimTail", () => {
  it("cuts the silence after the last audible sample, keeping a short pad", () => {
    const a = new Float32Array(1000);
    const b = new Float32Array(1000);
    a[100] = 0.5;
    b[300] = -0.2;
    const [x, y] = trimTail([a, b], 1000);
    expect(x.length).toBe(301 + 50);
    expect(y[300]).toBeCloseTo(-0.2);
  });
});
