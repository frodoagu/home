// Users' audio samples: what an upload may be. The page decodes a file
// before sending it, but the server trusts nothing it is sent, so the bytes
// must start like one of these formats; the stored type is the sniffed one,
// never the client's.

/** The audio type `bytes` start like, or null. */
export function sniffAudio(bytes) {
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 12) return null;
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12))) return "audio/aiff";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  // Frame sync: 11 set bits. Layer bits 00 is AAC in ADTS, anything else MPEG audio.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return (bytes[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  return null;
}

const NAME_MAX = 60;

/** A display name: printable, trimmed, capped; "sample" when nothing is left. */
export function cleanName(raw) {
  const name = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  return name || "sample";
}

/** 16 random bytes, base64url: unguessable, and what the page's SAMPLE_ID accepts. */
export function sampleId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString("base64url");
}

export const SAMPLE_PATH = /^\/api\/samples\/([A-Za-z0-9_-]{16,32})$/;
