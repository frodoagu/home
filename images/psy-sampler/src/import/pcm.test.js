import { describe, expect, it } from "vitest";
import { au, aiff, bytesOf, caf, ramp, wav, wav16, wav24, wavFloat } from "../test/audioFiles.js";
import { decodeAiff, decodeAu, decodeCaf, decodePcm, decodeWav, isPlainWav } from "./pcm.js";

const L = ramp(64);
const R = ramp(64, 8000).reverse();
const near = (actual, ints, scale) => ints.forEach((x, i) => expect(actual[i]).toBeCloseTo(x / scale, 6));

describe("WAV", () => {
  it("reads 16- and 24-bit PCM, and 32/64-bit float", () => {
    const a = decodeWav(wav16([L, R], 44100));
    expect(a.sampleRate).toBe(44100);
    near(a.channels[0], L, 32768);
    near(a.channels[1], R, 32768);
    const b = decodeWav(wav24([L.map((x) => x * 256)]));
    near(b.channels[0], L, 32768);
    const floats = [L.map((x) => x / 20000)];
    expect(decodeWav(wavFloat(floats)).channels[0][3]).toBeCloseTo(floats[0][3], 6);
    expect(decodeWav(wavFloat(floats, 48000, 64)).channels[0][3]).toBeCloseTo(floats[0][3], 6); // into a Float32Array
  });

  it("reads 8-bit (unsigned), A-law and μ-law", () => {
    expect([...decodeWav(wav({ bits: 8, raw: Uint8Array.of(0, 128, 255) })).channels[0]]).toEqual([-1, 0, 127 / 128]);
    // G.711: 0xD5 is A-law's smallest positive step, 0xFF μ-law's silence.
    expect(decodeWav(wav({ bits: 8, tag: 6, raw: Uint8Array.of(0xd5, 0x55) })).channels[0][0]).toBeCloseTo(8 / 32768, 9);
    expect([...decodeWav(wav({ bits: 8, tag: 7, raw: Uint8Array.of(0xff, 0x00, 0x80) })).channels[0]]).toEqual([0, -32124 / 32768, 32124 / 32768]);
  });

  it("reads WAVE_FORMAT_EXTENSIBLE and RF64/BW64, whose sizes live in ds64", () => {
    near(decodeWav(wav24([L.map((x) => x * 256)], 48000, { extensible: true })).channels[0], L, 32768);
    for (const riff of ["RF64", "BW64"]) {
      const out = decodeWav(wav24([L, R], 96000, { riff }));
      expect(out.sampleRate).toBe(96000);
      expect(out.channels[1]).toHaveLength(64);
    }
  });

  it("skips other chunks, plays a truncated file up to where it ends, rejects what it can't read", () => {
    const withJunk = wav({ raw: new Uint8Array(new Int16Array(L).buffer), extra: [bytesOf("bext", [3, 0, 0, 0], [1, 2, 3, 0])] });
    near(decodeWav(withJunk).channels[0], L, 32768);
    const full = wav16([L]);
    expect(decodeWav(full.subarray(0, full.length - 20)).channels[0]).toHaveLength(54);
    expect(decodeWav(wav({ tag: 2, bits: 4, raw: new Uint8Array(8) }))).toBeNull(); // MS ADPCM
    expect(decodeWav(bytesOf("RIFF", [0, 0, 0, 0], "AVI "))).toBeNull();
  });

  it("knows which WAVs every browser decodes as they are", () => {
    expect(isPlainWav(wav16([L]))).toBe(true);
    expect(isPlainWav(wav24([L]))).toBe(true);
    expect(isPlainWav(wavFloat([[0.5]]))).toBe(true);
    expect(isPlainWav(wavFloat([[0.5]], 48000, 64))).toBe(false);
    expect(isPlainWav(wav24([L], 48000, { extensible: true }))).toBe(false);
    expect(isPlainWav(wav24([L], 48000, { riff: "RF64" }))).toBe(false);
    expect(isPlainWav(wav({ bits: 8, tag: 7, raw: new Uint8Array(4) }))).toBe(false);
  });
});

describe("AIFF", () => {
  it("reads big-endian AIFF at its 80-bit sample rate", () => {
    const out = decodeAiff(aiff([L, R]));
    expect(out.sampleRate).toBe(44100);
    near(out.channels[0], L, 32768);
    near(out.channels[1], R, 32768);
    expect(decodeAiff(aiff([L.map((x) => x * 256)], { bits: 24, rate: 96000 })).sampleRate).toBe(96000);
  });

  it("reads AIFF-C: sowt (little-endian), fl32, ulaw", () => {
    const sowt = new Uint8Array(new Int16Array(L).buffer);
    near(decodeAiff(aiff([L], { compression: "sowt", raw: sowt })).channels[0], L, 32768);
    const fl32 = new DataView(new ArrayBuffer(8));
    fl32.setFloat32(0, 0.25);
    fl32.setFloat32(4, -0.5);
    expect([...decodeAiff(aiff([[0, 0]], { compression: "fl32", bits: 32, raw: new Uint8Array(fl32.buffer) })).channels[0]]).toEqual([0.25, -0.5]);
    expect(decodeAiff(aiff([[0]], { compression: "ulaw", raw: Uint8Array.of(0xff) })).channels[0][0]).toBe(0);
    expect(decodeAiff(aiff([[0]], { compression: "ima4", raw: new Uint8Array(34) }))).toBeNull();
  });
});

describe("CAF and AU", () => {
  it("reads CAF linear PCM, integer and float, either endianness", () => {
    near(decodeCaf(caf([L, R])).channels[1], R, 32768);
    near(decodeCaf(caf([L.map((x) => x * 256)], { bits: 24, little: false })).channels[0], L, 32768);
    expect(decodeCaf(caf([[0.5, -0.25]], { bits: 32, float: true })).channels[0][1]).toBe(-0.25);
  });

  it("reads Sun .au: 16-bit and μ-law", () => {
    const raw = new Uint8Array(4);
    new DataView(raw.buffer).setInt16(0, -16384);
    expect([...decodeAu(au({ encoding: 3, raw })).channels[0]]).toEqual([-0.5, 0]);
    expect(decodeAu(au({ encoding: 1, raw: Uint8Array.of(0xff) })).sampleRate).toBe(8000);
    expect(decodeAu(au({ encoding: 23, raw: new Uint8Array(4) }))).toBeNull(); // G.721 ADPCM
  });

  it("decodePcm tries every format, and nothing else", () => {
    for (const bytes of [wav16([L]), aiff([L]), caf([L]), au({ encoding: 1, raw: new Uint8Array(4) })]) expect(decodePcm(bytes)).not.toBeNull();
    expect(decodePcm(bytesOf("ID3", new Uint8Array(40)))).toBeNull();
    expect(decodePcm(new Uint8Array(0))).toBeNull();
  });
});
