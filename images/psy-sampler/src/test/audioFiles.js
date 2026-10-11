// Builders for the files the importers read: tiny WAV/AIFF/CAF/AU, SoundFonts,
// zips and gzips, written byte by byte from their specs. The decoders were
// also checked bit-exact against ffmpeg's output for every variant here.

const enc = new TextEncoder();
const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function bytesOf(...parts) {
  const arrays = parts.map((p) => (typeof p === "string" ? latin(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

function le(size, value) {
  const v = new DataView(new ArrayBuffer(size));
  if (size === 2) v.setUint16(0, value, true);
  else if (size === 4) v.setUint32(0, value, true);
  else v.setBigUint64(0, BigInt(value), true);
  return new Uint8Array(v.buffer);
}

function be(size, value) {
  const v = new DataView(new ArrayBuffer(size));
  if (size === 2) v.setUint16(0, value);
  else if (size === 4) v.setUint32(0, value);
  else v.setBigInt64(0, BigInt(value));
  return new Uint8Array(v.buffer);
}

const chunkLE = (id, body) => bytesOf(id, le(4, body.length), body, body.length & 1 ? [0] : []);
const chunkBE = (id, body) => bytesOf(id, be(4, body.length), body, body.length & 1 ? [0] : []);

// Interleaved sample bytes for `frames` (planar arrays of ints in the target range).
function interleave(frames, size, write) {
  const n = frames[0].length;
  const out = new DataView(new ArrayBuffer(n * frames.length * size));
  let at = 0;
  for (let i = 0; i < n; i++) {
    for (const ch of frames) {
      write(out, at, ch[i]);
      at += size;
    }
  }
  return new Uint8Array(out.buffer);
}

const int24 = (bigEndian) => (v, at, x) => {
  const u = x & 0xffffff;
  const b = [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff];
  (bigEndian ? b.reverse() : b).forEach((byte, i) => v.setUint8(at + i, byte));
};

/** A RIFF WAV. `tag` 1 PCM / 3 float / 6 A-law / 7 μ-law; `raw`: the data bytes. */
export function wav({ rate = 48000, channels = 1, bits = 16, tag = 1, raw, riff = "RIFF", extensible = false, extra = [] }) {
  const block = channels * (bits / 8);
  const fmtBody = extensible
    ? bytesOf(le(2, 0xfffe), le(2, channels), le(4, rate), le(4, rate * block), le(2, block), le(2, bits), le(2, 22), le(2, bits), le(4, 0), le(2, tag), new Uint8Array(14))
    : bytesOf(le(2, tag), le(2, channels), le(4, rate), le(4, rate * block), le(2, block), le(2, bits));
  const chunks = [chunkLE("fmt ", fmtBody), ...extra];
  if (riff === "RIFF") chunks.push(chunkLE("data", raw));
  else {
    // RF64/BW64: the sizes live in ds64; the header and data chunk say 0xFFFFFFFF.
    chunks.unshift(chunkLE("ds64", bytesOf(le(8, 0), le(8, raw.length), le(8, 0), le(4, 0))));
    chunks.push(bytesOf("data", le(4, 0xffffffff), raw));
  }
  const body = bytesOf("WAVE", ...chunks);
  return bytesOf(riff, le(4, riff === "RIFF" ? body.length : 0xffffffff), body);
}

/** 16-bit PCM WAV of planar int16 arrays. */
export const wav16 = (frames, rate = 48000) =>
  wav({ rate, channels: frames.length, bits: 16, raw: interleave(frames, 2, (v, at, x) => v.setInt16(at, x, true)) });

export const wav24 = (frames, rate = 48000, opts = {}) =>
  wav({ rate, channels: frames.length, bits: 24, raw: interleave(frames, 3, int24(false)), ...opts });

export const wavFloat = (frames, rate = 48000, bits = 32) =>
  wav({ rate, channels: frames.length, bits, tag: 3, raw: interleave(frames, bits / 8, (v, at, x) => (bits === 32 ? v.setFloat32(at, x, true) : v.setFloat64(at, x, true))) });

// 80-bit extended for AIFF's sample rate (integer rates).
function extended(rate) {
  const exp = Math.floor(Math.log2(rate));
  const mantissa = BigInt(rate) << BigInt(63 - exp);
  const v = new DataView(new ArrayBuffer(10));
  v.setUint16(0, 16383 + exp);
  v.setBigUint64(2, mantissa);
  return new Uint8Array(v.buffer);
}

/** AIFF (16-bit big-endian) or AIFF-C with `compression` and its raw bytes. */
export function aiff(frames, { rate = 44100, bits = 16, compression = null, raw } = {}) {
  const n = frames[0].length;
  const data = raw ?? interleave(frames, bits / 8, bits === 24 ? int24(true) : (v, at, x) => v.setInt16(at, x));
  const comm = bytesOf(be(2, frames.length), be(4, n), be(2, bits), extended(rate), compression ? bytesOf(compression, [0, 0]) : []);
  const body = bytesOf(compression ? "AIFC" : "AIFF", chunkBE("COMM", comm), chunkBE("SSND", bytesOf(be(4, 0), be(4, 0), data)));
  return bytesOf("FORM", be(4, body.length), body);
}

/** CAF with linear PCM. */
export function caf(frames, { rate = 44100, bits = 16, float = false, little = true } = {}) {
  const size = bits / 8;
  const raw = interleave(frames, size, (v, at, x) => {
    if (float) v.setFloat32(at, x, little);
    else if (size === 2) v.setInt16(at, x, little);
    else int24(!little)(v, at, x);
  });
  const desc = new DataView(new ArrayBuffer(32));
  desc.setFloat64(0, rate);
  latin("lpcm").forEach((b, i) => desc.setUint8(8 + i, b));
  desc.setUint32(12, (float ? 1 : 0) | (little ? 2 : 0));
  desc.setUint32(16, size * frames.length);
  desc.setUint32(20, 1);
  desc.setUint32(24, frames.length);
  desc.setUint32(28, bits);
  return bytesOf("caff", be(2, 1), be(2, 0), "desc", be(8, 32), new Uint8Array(desc.buffer), "data", be(8, raw.length + 4), be(4, 0), raw);
}

/** Sun .au with an encoding and its raw bytes. */
export const au = ({ rate = 8000, channels = 1, encoding, raw }) =>
  bytesOf(".snd", be(4, 24), be(4, raw.length), be(4, encoding), be(4, rate), be(4, channels), raw);

/**
 * A SoundFont: samples = [{ name, data: Int16Array, rate, type, link, ogg? }].
 * `ogg` (SF3): raw bytes stored as is, start/end in bytes.
 */
export function soundfont(samples, { sm24 = null, pad = true } = {}) {
  const parts = [];
  const headers = [];
  let at = 0;
  for (const s of samples) {
    const bytes = s.ogg ?? new Uint8Array(s.data.buffer);
    const start = s.ogg ? at : at / 2;
    parts.push(bytes);
    at += bytes.length;
    const end = s.ogg ? at : at / 2;
    // 46 zero frames between samples, as the spec asks (16-bit only).
    if (!s.ogg) {
      parts.push(new Uint8Array(92));
      at += 92;
    }
    const h = new DataView(new ArrayBuffer(46));
    latin(s.name.slice(0, 19)).forEach((b, i) => h.setUint8(i, b));
    h.setUint32(20, start, true);
    h.setUint32(24, end, true);
    h.setUint32(36, s.rate ?? 44100, true);
    h.setUint8(40, 60);
    h.setUint16(42, s.link ?? 0, true);
    h.setUint16(44, s.type ?? 1, true);
    headers.push(new Uint8Array(h.buffer));
  }
  headers.push(bytesOf("EOS", new Uint8Array(43)));
  const smpl = bytesOf(...parts);
  // Odd-sized smpl without its pad byte, like MuseScore's SF3 writer.
  const smplChunk = pad ? chunkLE("smpl", smpl) : bytesOf("smpl", le(4, smpl.length), smpl);
  const list = (type, ...chunks) => {
    const body = bytesOf(type, ...chunks);
    return bytesOf("LIST", le(4, body.length), body);
  };
  const body = bytesOf(
    "sfbk",
    list("INFO", chunkLE("ifil", bytesOf(le(2, 2), le(2, 1)))),
    list("sdta", smplChunk, ...(sm24 ? [chunkLE("sm24", sm24)] : [])),
    list("pdta", chunkLE("phdr", new Uint8Array(38)), chunkLE("shdr", bytesOf(...headers))),
  );
  return bytesOf("RIFF", le(4, body.length), body);
}

// Through CompressionStream (jsdom's Blob has no stream()).
async function compress(bytes, format) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(new CompressionStream(format))).arrayBuffer());
}

const deflateRaw = (bytes) => compress(bytes, "deflate-raw");
export const gzip = (bytes) => compress(typeof bytes === "string" ? enc.encode(bytes) : bytes, "gzip");

/** A zip of [{ name, data, deflate?, encrypted?, utf8?, rawName? }]. */
export async function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const packed = f.deflate ? await deflateRaw(data) : data;
    const name = f.rawName ?? enc.encode(f.name);
    const flags = (f.encrypted ? 1 : 0) | (f.utf8 ? 0x800 : 0);
    const method = f.method ?? (f.deflate ? 8 : 0);
    const common = bytesOf(le(2, 20), le(2, flags), le(2, method), le(4, 0), le(4, 0), le(4, packed.length), le(4, data.length), le(2, name.length), le(2, 0));
    const local = bytesOf(le(4, 0x04034b50), common, name, packed);
    centrals.push(bytesOf(le(4, 0x02014b50), le(2, 20), common, le(2, 0), le(2, 0), le(2, 0), le(4, 0), le(4, offset), name));
    locals.push(local);
    offset += local.length;
  }
  const dir = bytesOf(...centrals);
  const eocd = bytesOf(le(4, 0x06054b50), le(2, 0), le(2, 0), le(2, files.length), le(2, files.length), le(4, dir.length), le(4, offset), le(2, 0));
  return bytesOf(...locals, dir, eocd);
}

/** A ramp of `n` int16 values across [-a, a]. */
export const ramp = (n, a = 16000) => Array.from({ length: n }, (_, i) => Math.round(-a + (2 * a * i) / Math.max(1, n - 1)));

/** A File, as a picker hands it over (path: webkitRelativePath-like). */
export const fileOf = (bytes, name) => new File([bytes], name);
