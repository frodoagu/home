// Byte helpers shared by the importers: ASCII tags, random access into a
// Blob (a 2 GB sample pack is never read whole), and inflating with the
// browser's own DecompressionStream, capped so a zip bomb stops at `max`.

export const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

export const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Bytes [from, to) of a Blob/File. */
export async function readBlob(blob, from = 0, to = blob.size) {
  return new Uint8Array(await blob.slice(from, to).arrayBuffer());
}

export function concat(parts, total = parts.reduce((n, p) => n + p.length, 0)) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export class TooBig extends Error {}

/** "gzip" | "deflate-raw" -> the inflated bytes; throws TooBig past `max`. */
export async function inflate(bytes, format, max) {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooBig();
    }
    parts.push(value);
  }
  return concat(parts, total);
}

// "Samples/Imported/Kick 909.wav" -> "Kick 909.wav"; backslashes too (Windows paths).
export const baseName = (path) => String(path).split(/[\\/]/).pop();

// "Kick 909.wav" -> "wav"
export const extOf = (path) => (/\.([^./\\]+)$/.exec(baseName(path))?.[1] ?? "").toLowerCase();

// "Kick 909.wav" -> "Kick 909"
export const stem = (path) => baseName(path).replace(/\.[^.]+$/, "");
