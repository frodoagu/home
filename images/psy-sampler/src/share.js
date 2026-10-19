// Seeds and share links. A seed is a short string; hashSeed() turns it into
// the 32-bit state of the PRNG (editing.js seeded) behind the autopilot, so
// the same seed plays the same track anywhere. A share link carries the seed,
// the style, the BPM and the key in the URL fragment, plus the user's own sounds (a
// deflated preset), since the track is only the same with the same sounds
// (and the same banned ones: they leave the pilot's pools).
// What the autopilot wrote is left out: the seed writes it again. A track the
// ✨ AI planned also carries the plans the pilot took and the opening it
// started with (planner.js), since no seed can bring a model's answers back:
// any browser replays them, with a model or without. A snapshot travels on its own link: a one-snapshot file,
// deflated the same way.
import { KEYS, KEY_DEFAULT } from "./audio/music.js";
import { PLAN_MAX, readPlans } from "./planner.js";
import { cleanSeed, parsePreset, toPreset, toSnapshotFile } from "./workspace.js";

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

// A link is anyone's input, and deflate expands up to ~1000x: a 2 MB URL
// would inflate to gigabytes, so reading stops past `max` bytes.
export const SOUNDS_MAX = 1024 * 1024;

async function inflate(bytes, max) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("shared sounds too big");
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
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

// The user's sounds: edits and copies, not what the autopilot wrote.
const ownVariants = (ws) => Object.fromEntries(Object.entries(ws.variants).filter(([id]) => !ws.auto.includes(id)));

const pack = async (value) =>
  toBase64Url(await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("deflate-raw")));

const unpack = async (text, max) => new TextDecoder().decode(await inflate(fromBase64Url(text), max));

export async function packSounds(ws) {
  const { lists, names, descriptions, banned } = ws;
  return pack(toPreset({ lists, names, descriptions, variants: ownVariants(ws), auto: [], banned }));
}

export async function unpackSounds(text, max = SOUNDS_MAX) {
  const { lists, names, descriptions, variants, auto, banned } = parsePreset(await unpack(text, max));
  return { lists, names, descriptions, variants, auto, banned };
}

// The sounds are worth sending only when they are not the factory ones.
export const hasCustomSounds = (ws) =>
  Object.keys(ownVariants(ws)).length > 0 ||
  Object.keys(ws.names).length > 0 ||
  Object.keys(ws.descriptions).length > 0 ||
  ws.banned.length > 0;

/**
 * "#seed=…&style=…&bpm=…[&key=…][&s=…][&ai=…][&open=…]" for `ws` (async:
 * compressing). `plans` are the run's, one per section (holes where it had
 * none); `opening`, the one it started with (planner.js normalizeOpening).
 */
export async function shareFragment(ws, plans = [], opening = null) {
  const params = new URLSearchParams({ seed: ws.seed, style: ws.style, bpm: String(ws.bpm) });
  if (ws.key !== KEY_DEFAULT) params.set("key", String(ws.key));
  if (hasCustomSounds(ws)) params.set("s", await packSounds(ws));
  if (plans.some(Boolean)) params.set("ai", await pack(Array.from(plans.slice(0, PLAN_MAX), (p) => p ?? null)));
  if (opening) params.set("open", await pack(opening));
  return `#${params}`;
}

/** A link's packed plans -> readPlans()'s list; throws on a broken one. */
export async function unpackPlans(text, max = SOUNDS_MAX) {
  const plans = readPlans(JSON.parse(await unpack(text, max)));
  if (!plans) throw new Error("not a list of plans");
  return plans;
}

/** A link's packed opening -> its raw object (normalizeOpening() is the gate); throws on a broken one. */
export async function unpackOpening(text, max = SOUNDS_MAX) {
  const opening = JSON.parse(await unpack(text, max));
  if (!opening || typeof opening !== "object" || Array.isArray(opening)) throw new Error("not an opening");
  return opening;
}

/** "#snap=…": `snap` alone, as a snapshots file with the names of the copies it plays. */
export async function snapFragment(ws, snap) {
  const { names, descriptions } = ws;
  return `#${new URLSearchParams({ snap: await pack(toSnapshotFile({ names, descriptions, snapshots: [snap] })) })}`;
}

/** The fragment of a snapshot link -> its packed file, or null. */
export const readSnapFragment = (hash) => new URLSearchParams(String(hash ?? "").replace(/^#/, "")).get("snap") || null;

/** A packed snapshot -> the file's text, for importSnapshots() (the gate). */
export const unpackSnap = (text, max = SOUNDS_MAX) => unpack(text, max);

/**
 * The fragment of a share link -> { seed, style, bpm, key, sounds?, plans?,
 * opening? } or null. A link without a key plays in A, as every link did
 * before there was one.
 */
export function readFragment(hash) {
  const params = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const seed = cleanSeed(params.get("seed"));
  if (!seed) return null;
  const bpm = Number(params.get("bpm"));
  const key = /^\d+$/.test(params.get("key") ?? "") ? Number(params.get("key")) : KEY_DEFAULT;
  return {
    seed,
    style: params.get("style"),
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    key: KEYS.includes(key) ? key : KEY_DEFAULT,
    sounds: params.get("s"),
    plans: params.get("ai"),
    opening: params.get("open"),
  };
}
