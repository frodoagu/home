// A ZIP writer over Blobs, for downloads of several files (⏺ stems). Entries
// are stored, not deflated: audio barely shrinks, and the zip is then a Blob
// of the files' own Blobs, never all in memory. Each file is still read once
// for its CRC-32. No ZIP64, so the whole zip stays under 4 GB. The reader is
// import/zip.js.
import { readBlob } from "./import/bytes.js";

const CHUNK = 8 << 20;
const MAX = 2 ** 32 - 1;
const UTF8 = 1 << 11;

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export async function crc32(blob) {
  let crc = ~0;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const bytes = await readBlob(blob, at, Math.min(blob.size, at + CHUNK));
    for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

// MS-DOS time and date, local time, to the even second.
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// The fields a local header and a central directory entry share, from "version needed" on.
function common(v, at, { crc, size, name }, { time, date }) {
  v.setUint16(at, 20, true);
  v.setUint16(at + 2, UTF8, true);
  v.setUint16(at + 4, 0, true); // stored
  v.setUint16(at + 6, time, true);
  v.setUint16(at + 8, date, true);
  v.setUint32(at + 10, crc, true);
  v.setUint32(at + 14, size, true);
  v.setUint32(at + 18, size, true);
  v.setUint16(at + 22, name.length, true);
}

/** [{ name, blob }] -> a .zip Blob of them, in order. Throws past 4 GB. */
export async function zipBlob(files, when = new Date()) {
  const stamp = dosTime(when);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, blob } of files) {
    const entry = { name: new TextEncoder().encode(name), size: blob.size, crc: await crc32(blob) };
    const local = new Uint8Array(30 + entry.name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    common(v, 4, entry, stamp);
    v.setUint16(28, 0, true);
    local.set(entry.name, 30);

    const dir = new Uint8Array(46 + entry.name.length);
    const d = new DataView(dir.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true); // made by: MS-DOS, 2.0
    common(d, 6, entry, stamp);
    d.setUint32(42, offset, true);
    dir.set(entry.name, 46);

    parts.push(local, blob);
    central.push(dir);
    offset += local.length + blob.size;
    if (offset > MAX) throw new RangeError("zip over 4 GB");
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
