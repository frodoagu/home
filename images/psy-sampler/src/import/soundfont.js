// SoundFont 2 (.sf2) and MuseScore's SF3: every sample in the bank, loaded
// one by one. The headers (shdr) are read up front; the audio is sliced out
// of the smpl chunk only for the samples asked for, so a 500 MB piano doesn't
// load whole. SF2 samples are 16-bit (plus sm24's low byte in a 24-bit bank),
// and a stereo pair (a left sample linked to its right) comes out as one
// stereo sample. An SF3 sample is an Ogg Vorbis stream (type flag 0x10, start
// and end in bytes) left to the browser to decode, each half of a pair on its
// own. ROM samples (the sound card's, not in the file) are skipped.

import { ascii, readBlob, view } from "./bytes.js";

const SHDR_SIZE = 46;
const LEFT = 4;
const RIGHT = 2;
const ROM = 0x8000;
const COMPRESSED = 0x10;

/** true when the bytes start like a SoundFont. */
export const isSoundfont = (head) => head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "sfbk";

// Top-level chunks of a RIFF, or the sub-chunks of a LIST, without reading their bodies.
// An odd-sized chunk should be followed by a zero pad byte; some writers
// (MuseScore's SF3) leave it out, so a non-zero byte there starts the next chunk.
async function chunks(blob, from, to) {
  const out = [];
  for (let at = from; at + 8 <= to; ) {
    const head = await readBlob(blob, at, at + 12);
    const size = view(head).getUint32(4, true);
    out.push({ id: ascii(head, 0, 4), list: head.length >= 12 ? ascii(head, 8, 12) : "", body: at + 8, size });
    at += 8 + size;
    if (size & 1 && (await readBlob(blob, at, at + 1))[0] === 0) at++;
  }
  return out;
}

const cName = (bytes) => ascii(bytes, 0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).trim();

// "Piano C4 L" + "Piano C4 R" -> "Piano C4"
function pairName(left, right) {
  let i = 0;
  while (i < left.length && left[i] === right[i]) i++;
  return left.slice(0, i).replace(/[\s_\-([]+$/, "") || left;
}

/** [{ name, sampleRate, channelCount, frames, load() -> { pcm: { sampleRate, channels } } | { bytes } }] */
export async function soundfontSamples(blob) {
  const top = await readBlob(blob, 0, 12);
  if (!isSoundfont(top)) throw new Error("not a soundfont");
  const end = Math.min(blob.size, 8 + view(top).getUint32(4, true));
  let smpl = null;
  let sm24 = null;
  let shdr = null;
  for (const list of await chunks(blob, 12, end)) {
    if (list.id !== "LIST") continue;
    for (const c of await chunks(blob, list.body + 4, Math.min(end, list.body + list.size))) {
      if (list.list === "sdta" && c.id === "smpl") smpl = c;
      if (list.list === "sdta" && c.id === "sm24") sm24 = c;
      if (list.list === "pdta" && c.id === "shdr") shdr = c;
    }
  }
  if (!smpl || !shdr) throw new Error("no samples");
  const table = await readBlob(blob, shdr.body, shdr.body + shdr.size);
  const tv = view(table);
  const headers = [];
  // The last record is the "EOS" terminator.
  for (let at = 0; at + SHDR_SIZE * 2 <= table.length; at += SHDR_SIZE) {
    headers.push({
      name: cName(table.subarray(at, at + 20)),
      start: tv.getUint32(at + 20, true),
      end: tv.getUint32(at + 24, true),
      sampleRate: tv.getUint32(at + 36, true),
      link: tv.getUint16(at + 42, true),
      type: tv.getUint16(at + 44, true),
    });
  }
  const frames = smpl.size / 2;
  const compressed = (h) => Boolean(h.type & COMPRESSED);
  const valid = (h) => h && !(h.type & ROM) && h.end > h.start && h.end <= (compressed(h) ? smpl.size : frames) && h.sampleRate > 0;
  const hasSm24 = sm24 && sm24.size >= frames;

  async function channel(h) {
    const lo16 = await readBlob(blob, smpl.body + h.start * 2, smpl.body + h.end * 2);
    const lo8 = hasSm24 ? await readBlob(blob, sm24.body + h.start, sm24.body + h.end) : null;
    const v = view(lo16);
    const out = new Float32Array(lo16.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = lo8 ? (v.getInt16(i * 2, true) * 256 + lo8[i]) / 8388608 : v.getInt16(i * 2, true) / 32768;
    }
    return out;
  }

  const out = [];
  const paired = new Set();
  headers.forEach((h, i) => {
    if (!valid(h) || paired.has(i)) return;
    if (compressed(h)) {
      out.push({
        name: h.name,
        sampleRate: h.sampleRate,
        channelCount: 1,
        frames: h.end - h.start, // bytes, really: an estimate of the size
        load: async () => ({ bytes: await readBlob(blob, smpl.body + h.start, smpl.body + h.end) }),
      });
      return;
    }
    const partner = headers[h.link];
    const linked = valid(partner) && !compressed(partner) && partner.link === i;
    const stereo = linked && h.type & LEFT && partner.type & RIGHT;
    if (stereo) paired.add(h.link);
    // A right sample whose left comes later is picked up by that left.
    if (linked && h.type & RIGHT && partner.type & LEFT) return;
    const parts = stereo ? [h, partner] : [h];
    out.push({
      name: stereo ? pairName(h.name, partner.name) : h.name,
      sampleRate: h.sampleRate,
      channelCount: parts.length,
      frames: Math.min(...parts.map((p) => p.end - p.start)),
      async load() {
        const channels = await Promise.all(parts.map(channel));
        const length = Math.min(...channels.map((c) => c.length));
        return { pcm: { sampleRate: h.sampleRate, channels: channels.map((c) => c.subarray(0, length)) } };
      },
    });
  });
  return out;
}
