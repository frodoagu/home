// A ZIP reader over a Blob: sample packs, and the formats that are a zip
// inside (Bitwig .multisample, Renoise .xrni/.xrns, Decent Sampler
// .dslibrary…). Only the central directory is read up front; each entry is
// sliced and inflated when asked for, so a pack of several GB costs what the
// chosen files weigh. ZIP64 (packs over 4 GB) included; stored and deflate
// only (what macOS, Windows and every DAW write), no encryption.

import { TooBig, inflate, readBlob, view } from "./bytes.js";

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_DIRECTORY = 64 * 2 ** 20;

// IBM PC code page 437, the encoding ZIP names default to (bytes 0x80-0xFF).
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

// Flag bit 11 says UTF-8; macOS writes UTF-8 without it, so try that before CP437.
function decodeName(bytes, utf8) {
  try {
    return new TextDecoder("utf-8", { fatal: !utf8 }).decode(bytes);
  } catch {
    return String.fromCharCode(...bytes).replace(/[\x80-\xff]/g, (c) => CP437[c.charCodeAt(0) - 0x80]);
  }
}

const u64 = (v, at) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;

/** true when the bytes start like a zip (an empty one included). */
export const isZip = (head) => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && [3, 5].includes(head[2]);

/**
 * The files in a zip: [{ name, size, read(max) -> Uint8Array, problem? }].
 * `problem` (encrypted | method) marks entries that can't be read. Throws on a
 * blob that isn't a zip.
 */
export async function zipEntries(blob) {
  const tailFrom = Math.max(0, blob.size - (22 + 0xffff + 20));
  const tail = await readBlob(blob, tailFrom);
  const tv = view(tail);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tv.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  let count = tv.getUint16(eocd + 10, true);
  let dirSize = tv.getUint32(eocd + 12, true);
  let dirOffset = tv.getUint32(eocd + 16, true);
  if ((count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) && eocd >= 20 && tv.getUint32(eocd - 20, true) === LOCATOR64) {
    const record = await readBlob(blob, u64(tv, eocd - 20 + 8), u64(tv, eocd - 20 + 8) + 56);
    const rv = view(record);
    if (record.length < 56 || rv.getUint32(0, true) !== EOCD64) throw new Error("bad zip64");
    count = u64(rv, 32);
    dirSize = u64(rv, 40);
    dirOffset = u64(rv, 48);
  }
  if (dirSize > MAX_DIRECTORY || dirOffset + dirSize > blob.size) throw new Error("bad directory");

  const dir = await readBlob(blob, dirOffset, dirOffset + dirSize);
  const dv = view(dir);
  const entries = [];
  for (let at = 0, i = 0; i < count && at + 46 <= dir.length && dv.getUint32(at, true) === CENTRAL; i++) {
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    let packed = dv.getUint32(at + 20, true);
    let size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    let offset = dv.getUint32(at + 42, true);
    const name = decodeName(dir.subarray(at + 46, at + 46 + nameLength), flags & 0x800);
    // ZIP64 extra field: only the fields that overflowed are there, in this order.
    for (let x = at + 46 + nameLength, end = x + extraLength; x + 4 <= end; ) {
      const id = dv.getUint16(x, true);
      const len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let f = x + 4;
        const next = () => {
          f += 8;
          return u64(dv, f - 8);
        };
        if (size === 0xffffffff) size = next();
        if (packed === 0xffffffff) packed = next();
        if (offset === 0xffffffff) offset = next();
      }
      x += 4 + len;
    }
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    const problem = flags & 1 ? "encrypted" : method !== 0 && method !== 8 ? "method" : null;
    entries.push({
      name,
      size,
      ...(problem ? { problem } : {}),
      async read(max = Infinity) {
        if (problem) throw new Error(problem);
        if (size > max) throw new TooBig();
        const local = await readBlob(blob, offset, offset + 30);
        const lv = view(local);
        if (local.length < 30 || lv.getUint32(0, true) !== LOCAL) throw new Error("bad entry");
        const start = offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
        const data = await readBlob(blob, start, start + packed);
        return method === 0 ? data : inflate(data, "deflate-raw", Math.min(max, size));
      },
    });
  }
  return entries;
}
