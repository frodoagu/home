// Decoders for the uncompressed formats DAWs and recorders write, where
// browsers disagree: Chrome and Firefox can't decode AIFF or CAF at all, and
// none of them reads RF64/BW64, 64-bit float or G.711 (A-law/μ-law) WAVs.
// Each returns { sampleRate, channels: [Float32Array, ...] } or null when the
// bytes aren't that format (or use a codec this doesn't cover: ADPCM, ALAC…).
//
// Truncated files (a recorder that crashed) play up to where the data ends.

import { ascii, view } from "./bytes.js";

const MAX_CHANNELS = 32;
const MAX_RATE = 768000;

// G.711, as in the reference g711.c, scaled to ±1.
function alaw(byte) {
  const a = byte ^ 0x55;
  const seg = (a & 0x70) >> 4;
  let t = (a & 0x0f) << 4;
  t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1);
  return (a & 0x80 ? t : -t) / 32768;
}

function ulaw(byte) {
  const u = ~byte & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return (u & 0x80 ? 0x84 - t : t - 0x84) / 32768;
}

const ALAW = Float32Array.from({ length: 256 }, (_, i) => alaw(i));
const ULAW = Float32Array.from({ length: 256 }, (_, i) => ulaw(i));

// A reader for one sample: (DataView, offset) -> -1..1. `kind` is int | uint
// (offset binary) | float | alaw | ulaw; `size` is the container in bytes.
function sampleReader(kind, size, le) {
  if (kind === "alaw") return size === 1 ? (v, o) => ALAW[v.getUint8(o)] : null;
  if (kind === "ulaw") return size === 1 ? (v, o) => ULAW[v.getUint8(o)] : null;
  if (kind === "float") {
    if (size === 4) return (v, o) => v.getFloat32(o, le);
    if (size === 8) return (v, o) => v.getFloat64(o, le);
    return null;
  }
  if (kind === "uint") return size === 1 ? (v, o) => (v.getUint8(o) - 128) / 128 : null;
  if (kind !== "int") return null;
  if (size === 1) return (v, o) => v.getInt8(o) / 128;
  if (size === 2) return (v, o) => v.getInt16(o, le) / 32768;
  if (size === 3) {
    return le
      ? (v, o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608)
      : (v, o) => (((v.getInt8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2)) / 8388608);
  }
  if (size === 4) return (v, o) => v.getInt32(o, le) / 2147483648;
  return null;
}

// Interleaved frames from `start` (clipped to the bytes there are) -> planar channels.
function deinterleave(bytes, { start, length, channelCount, sampleRate, kind, size, le, block = channelCount * size }) {
  if (!(channelCount >= 1 && channelCount <= MAX_CHANNELS) || !(sampleRate > 0 && sampleRate <= MAX_RATE)) return null;
  const read = sampleReader(kind, size, le);
  if (!read || block < channelCount * size || start > bytes.length) return null;
  const frames = Math.floor(Math.min(length, bytes.length - start) / block);
  if (frames < 1) return null;
  const v = view(bytes);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let f = 0, at = start; f < frames; f++, at += block) {
    for (let c = 0; c < channelCount; c++) channels[c][f] = read(v, at + c * size);
  }
  return { sampleRate, channels };
}

// Where the chunk after `size` bytes at `body` starts. An odd size is followed
// by a zero pad byte; some writers leave it out, so a non-zero byte there
// already starts the next chunk.
const next = (bytes, body, size) => body + size + (size & 1 && bytes[body + size] === 0 ? 1 : 0);

/* ---- WAV, RF64, BW64 ---- */

const WAV_KINDS = { 1: "int", 3: "float", 6: "alaw", 7: "ulaw" };

// The fmt and data chunks, wherever they sit; RF64/BW64 keep the real data size in ds64.
function wavChunks(bytes) {
  const riff = ascii(bytes, 0, 4);
  if (bytes.length < 12 || !["RIFF", "RF64", "BW64"].includes(riff) || ascii(bytes, 8, 12) !== "WAVE") return null;
  const v = view(bytes);
  let fmt = null;
  let data = null;
  let ds64 = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(bytes, at, at + 4);
    let size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "ds64" && body + 16 <= bytes.length) ds64 = v.getUint32(body + 8, true) + v.getUint32(body + 12, true) * 2 ** 32;
    if (id === "fmt " && body + 16 <= bytes.length) {
      let tag = v.getUint16(body, true);
      const extensible = tag === 0xfffe;
      if (extensible && size >= 40 && body + 26 <= bytes.length) tag = v.getUint16(body + 24, true); // SubFormat GUID
      fmt = {
        tag,
        extensible,
        channelCount: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        block: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      };
    }
    if (id === "data") {
      if (size === 0xffffffff && ds64 !== null) size = ds64;
      // 0 or past the end: a writer that never finalized; the data runs to EOF.
      if (size === 0 || size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
      data = { start: body, length: size };
    }
    at = next(bytes, body, size);
  }
  return fmt && data ? { riff, fmt, data } : null;
}

/** True for the WAVs every browser decodes: plain RIFF with 8/16/24-bit PCM or 32-bit float. */
export function isPlainWav(bytes) {
  const wav = wavChunks(bytes);
  if (!wav || wav.riff !== "RIFF" || wav.fmt.extensible) return false;
  const { tag, bits, block, channelCount } = wav.fmt;
  const size = block / channelCount;
  return (tag === 1 && [8, 16, 24].includes(bits) && size === bits / 8) || (tag === 3 && bits === 32 && size === 4);
}

export function decodeWav(bytes) {
  const wav = wavChunks(bytes);
  if (!wav) return null;
  const { tag, channelCount, sampleRate, block, bits } = wav.fmt;
  const kind = WAV_KINDS[tag];
  if (!kind || !channelCount) return null;
  // The container per sample is the block's share; 8-bit PCM is unsigned in WAV.
  const size = block / channelCount;
  if (!Number.isInteger(size)) return null;
  return deinterleave(bytes, {
    ...wav.data,
    channelCount,
    sampleRate,
    kind: kind === "int" && bits <= 8 ? "uint" : kind,
    size,
    le: true,
    block,
  });
}

/* ---- AIFF, AIFF-C ---- */

// IEEE 754 80-bit extended, the way AIFF stores its sample rate.
export function extended(v, at) {
  const se = v.getUint16(at);
  const mantissa = v.getUint32(at + 2) * 2 ** 32 + v.getUint32(at + 6);
  if (!mantissa) return 0;
  return (se & 0x8000 ? -1 : 1) * mantissa * 2 ** ((se & 0x7fff) - 16383 - 63);
}

// AIFF-C compression type -> how its samples read (size null: from the bit depth).
const AIFC_KINDS = {
  NONE: { kind: "int", le: false },
  twos: { kind: "int", le: false },
  sowt: { kind: "int", le: true },
  in24: { kind: "int", le: false, size: 3 },
  in32: { kind: "int", le: false, size: 4 },
  fl32: { kind: "float", le: false, size: 4 },
  FL32: { kind: "float", le: false, size: 4 },
  fl64: { kind: "float", le: false, size: 8 },
  FL64: { kind: "float", le: false, size: 8 },
  alaw: { kind: "alaw", size: 1 },
  ALAW: { kind: "alaw", size: 1 },
  ulaw: { kind: "ulaw", size: 1 },
  ULAW: { kind: "ulaw", size: 1 },
  "raw ": { kind: "uint", size: 1 },
};

export function decodeAiff(bytes) {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "FORM") return null;
  const form = ascii(bytes, 8, 12);
  if (form !== "AIFF" && form !== "AIFC") return null;
  const v = view(bytes);
  let comm = null;
  let ssnd = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(bytes, at, at + 4);
    const size = v.getUint32(at + 4);
    const body = at + 8;
    if (id === "COMM" && body + 18 <= bytes.length) {
      comm = {
        channelCount: v.getInt16(body),
        frames: v.getUint32(body + 2),
        bits: v.getInt16(body + 6),
        sampleRate: extended(v, body + 8),
        compression: form === "AIFC" && body + 22 <= bytes.length ? ascii(bytes, body + 18, body + 22) : "NONE",
      };
    }
    if (id === "SSND" && body + 8 <= bytes.length) ssnd = { start: body + 8 + v.getUint32(body), end: Math.min(bytes.length, body + size) };
    at = next(bytes, body, size);
  }
  if (!comm || !ssnd) return null;
  const codec = AIFC_KINDS[comm.compression];
  if (!codec) return null;
  // Odd bit depths (12, 20) sit left-justified in whole bytes, so they read as the larger size.
  const size = codec.size ?? Math.ceil(comm.bits / 8);
  return deinterleave(bytes, {
    start: ssnd.start,
    length: Math.min(ssnd.end - ssnd.start, comm.frames * comm.channelCount * size),
    channelCount: comm.channelCount,
    sampleRate: comm.sampleRate,
    kind: codec.kind,
    size,
    le: codec.le,
  });
}

/* ---- CAF (Core Audio Format: Logic, GarageBand, Apple Loops) ---- */

export function decodeCaf(bytes) {
  if (bytes.length < 8 || ascii(bytes, 0, 4) !== "caff") return null;
  const v = view(bytes);
  let desc = null;
  let data = null;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const id = ascii(bytes, at, at + 4);
    const raw = Number(v.getBigInt64(at + 4));
    const body = at + 12;
    // -1: the data chunk runs to the end of the file.
    const size = raw < 0 ? bytes.length - body : raw;
    if (id === "desc" && body + 32 <= bytes.length) {
      desc = {
        sampleRate: v.getFloat64(body),
        format: ascii(bytes, body + 8, body + 12),
        flags: v.getUint32(body + 12),
        bytesPerPacket: v.getUint32(body + 16),
        channelCount: v.getUint32(body + 24),
        bits: v.getUint32(body + 28),
      };
    }
    if (id === "data") data = { start: body + 4, length: Math.min(size, bytes.length - body) - 4 }; // after the edit count
    at = body + size;
  }
  if (!desc || !data) return null;
  const { format, flags, channelCount, bytesPerPacket, bits } = desc;
  let codec;
  if (format === "lpcm") {
    codec = { kind: flags & 1 ? "float" : "int", le: Boolean(flags & 2), size: channelCount ? bytesPerPacket / channelCount : 0 };
    if (codec.size !== Math.ceil(bits / 8)) return null;
  } else if (format === "alaw" || format === "ulaw") codec = { kind: format, size: 1 };
  else return null;
  return deinterleave(bytes, { ...data, channelCount, sampleRate: desc.sampleRate, ...codec });
}

/* ---- Sun/NeXT .au / .snd ---- */

const AU_KINDS = {
  1: { kind: "ulaw", size: 1 },
  2: { kind: "int", size: 1 },
  3: { kind: "int", size: 2 },
  4: { kind: "int", size: 3 },
  5: { kind: "int", size: 4 },
  6: { kind: "float", size: 4 },
  7: { kind: "float", size: 8 },
  27: { kind: "alaw", size: 1 },
};

export function decodeAu(bytes) {
  if (bytes.length < 24 || ascii(bytes, 0, 4) !== ".snd") return null;
  const v = view(bytes);
  const start = v.getUint32(4);
  const size = v.getUint32(8);
  const codec = AU_KINDS[v.getUint32(12)];
  if (!codec) return null;
  return deinterleave(bytes, {
    start,
    length: size === 0xffffffff ? bytes.length - start : size,
    channelCount: v.getUint32(20),
    sampleRate: v.getUint32(16),
    le: false,
    ...codec,
  });
}

/** Whichever of the above the bytes are, or null. */
export const decodePcm = (bytes) => decodeWav(bytes) ?? decodeAiff(bytes) ?? decodeCaf(bytes) ?? decodeAu(bytes);
