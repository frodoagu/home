// Seeds and share links. A seed is a short string; hashSeed() turns it into
// the 32-bit state of the PRNG (editing.js seeded) behind the autopilot, so
// the same seed plays the same track anywhere. A share link carries the seed
// and the BPM in the URL fragment, plus the sounds when they differ from the
// factory ones (a deflated preset), since the track is only the same with
// the same sounds.
import { cleanSeed, parsePreset, toPreset } from "./workspace.js";

export { cleanSeed };

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
export function randomSeed(rng = Math.random, length = 6) {
  return Array.from({ length }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join("");
}

// FNV-1a over the UTF-16 code units.
export function hashSeed(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/* ---- the sounds part: preset JSON -> deflate-raw -> base64url ---- */

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function packSounds(ws) {
  const { lists, names, variants, auto } = ws;
  const json = JSON.stringify(toPreset({ lists, names, variants, auto }));
  return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw")));
}

export async function unpackSounds(text) {
  const bytes = await pipe(fromBase64Url(text), new DecompressionStream("deflate-raw"));
  const { lists, names, variants, auto } = parsePreset(new TextDecoder().decode(bytes));
  return { lists, names, variants, auto };
}

// The sounds are worth sending only when they are not the factory ones.
export const hasCustomSounds = (ws) =>
  Object.keys(ws.variants).length > 0 || Object.keys(ws.names).length > 0;

/** "#seed=…&bpm=…[&s=…]" for `ws` (async: compressing the sounds). */
export async function shareFragment(ws) {
  const params = new URLSearchParams({ seed: ws.seed, bpm: String(ws.bpm) });
  if (hasCustomSounds(ws)) params.set("s", await packSounds(ws));
  return `#${params}`;
}

/** The fragment of a share link -> { seed, bpm, sounds? } or null. */
export function readFragment(hash) {
  const params = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const seed = cleanSeed(params.get("seed"));
  if (!seed) return null;
  const bpm = Number(params.get("bpm"));
  return { seed, bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null, sounds: params.get("s") };
}
