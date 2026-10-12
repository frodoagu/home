// The autopilot's ✨ AI option: a language model (ai.js: Chrome's built-in
// one, or an LM Studio endpoint) plans the section after the one playing:
// which section, how long, and which sounds each layer plays. Pure: this
// builds the prompt and the JSON Schema the answer must follow, and
// normalizePlan() is the gate every plan goes through (the model's, or one
// from a share link) before the pilot takes it (autopilot.js withPlan). The
// model only arranges: melodies, how each sound is dressed, FX and the swaps
// inside a section still come from the seed.
import { LAYERS } from "./catalog.js";
import { SECTIONS, SECTION_IDS, countRange, leftOut, poolOf } from "./autopilot.js";
import { baseOf, isCopy } from "./audio/patterns.js";
import en from "./i18n/en.js";

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot);
// An intro opens a track; a plan always picks what follows one.
export const PLAN_SECTIONS = SECTION_IDS.filter((id) => id !== "intro");
// Plans a share link carries at most: one per section, about 6 h of track.
export const PLAN_MAX = 256;
const HISTORY = 8; // sections the prompt recalls

const barsOf = (section) => SECTIONS[section].loops.map((n) => n * 2);
const counts = (section) =>
  LOOP_LAYERS.map((l) => {
    const [lo, hi] = countRange(section, l.id);
    return `${l.id} ${lo === hi ? lo : `${lo}-${hi}`}`;
  }).join(", ");

// Read off SECTIONS, so the model learns the same forms the pilot keeps.
export const SYSTEM = [
  "You arrange a live electronic dance track (psytrance, techno) made of 2-bar loops grouped in sections.",
  "Sections, their lengths in bars and how many sounds each layer plays in them:",
  ...SECTION_IDS.map((s) => `- ${s}: ${barsOf(s).join(" or ")} bars; ${counts(s)}`),
  "The usual flow is intro, groove, build, peak, then breakdown or groove, then build again; now and then a build teases into a breakdown instead. A peak lands after a build; a breakdown drops the kick and the bass and lets a lead and a pad breathe.",
  "The lead a breakdown plays is the track's theme: it stays through the build and the peak after it.",
  "Every section plays a lead or a pad. Keep some of the sounds playing now and change a layer or two at each section: continuity first, contrast from the section's form.",
  "You plan the section after the one playing now: which section, its length in bars and the sounds of every layer, using only the ids listed for each layer. Follow the listener's wishes when there are any.",
].join("\n");

// "kick.dark (Dark tok: 250→62 Hz…)", with a copy's own name when it has one.
function describe(id, names) {
  const [name, detail] = en.variants[baseOf(id)] ?? [id, ""];
  const what = isCopy(id) ? `${names[id] ? `${JSON.stringify(names[id])}, ` : ""}a copy of ${name}` : name;
  return `${id} (${what}${detail ? `: ${detail}` : ""})`;
}

/**
 * What to ask for the section after the one playing. `sections` are the ones
 * walked so far (the last one plays now, `bars` long); `vibe` is the
 * listener's own words; `next`, a section queued by hand, is the one to plan;
 * `theme`, the lead the pilot will hold through it.
 */
export function planPrompt({ style, bpm, lists, active, sections, bars, vibe = "", names = {}, next = null, theme = [] }) {
  const playing = [...new Set(Object.values(active))].sort();
  const lines = [
    `Style: ${en.styles[style] ?? style}, ${Math.round(bpm)} BPM.`,
    `Sections so far: ${sections.slice(-HISTORY).join(", ")}. Now playing: ${sections.at(-1)}, ${bars} bars.`,
    `Sounds playing now: ${playing.length ? playing.join(", ") : "none"}.`,
  ];
  if (theme.length) lines.push(`The theme, which stays in the lead layer: ${theme.join(", ")}.`);
  if (vibe) lines.push(`The listener asks for: ${JSON.stringify(vibe)}.`);
  lines.push("Sounds you can use, by layer:");
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    lines.push(`${layer.id}: ${poolOf(lists, layer.id, style).map((id) => describe(id, names)).join("; ")}`);
  }
  lines.push(next ? `The listener queued ${next} next: plan that section.` : "Plan the next section.");
  return lines.join("\n");
}

/**
 * The JSON Schema of an answer: the section, its bars and each layer's ids
 * as enums, so a model that decodes against it cannot name what is not
 * there (`next`, queued by hand, is the only section it may name). Engines
 * differ in how much of a schema they enforce: normalizePlan() checks it all
 * again.
 */
export function planSchema({ lists, style, next = null }) {
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    const pool = poolOf(lists, layer.id, style);
    if (!pool.length) continue;
    const most = Math.max(...PLAN_SECTIONS.map((s) => countRange(s, layer.id)[1]));
    layers[layer.id] = { type: "array", items: { type: "string", enum: pool }, maxItems: most };
  }
  const bars = [...new Set(PLAN_SECTIONS.flatMap(barsOf))].sort((a, b) => a - b);
  return {
    type: "object",
    properties: {
      section: { type: "string", enum: PLAN_SECTIONS.includes(next) ? [next] : PLAN_SECTIONS },
      bars: { type: "integer", enum: bars },
      layers: { type: "object", properties: layers, required: Object.keys(layers), additionalProperties: false },
    },
    required: ["section", "bars", "layers"],
    additionalProperties: false,
  };
}

/**
 * Anyone's answer -> { section, bars, layers } or null. The section must be
 * one a plan may pick; `bars` that the section cannot last turn null (the
 * pilot draws a length); a layer keeps only ids in its pool, at most as many
 * as the section plays, and drops out (the pilot draws it) when that leaves
 * fewer than the section needs. Idempotent: a normalized plan comes back the
 * same, which is what lets a share link replay one.
 */
export function normalizePlan(raw, { lists, style }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const section = PLAN_SECTIONS.find((id) => id === raw.section);
  if (!section) return null;
  const bars = barsOf(section).includes(raw.bars) ? raw.bars : null;
  const given = raw.layers && typeof raw.layers === "object" && !Array.isArray(raw.layers) ? raw.layers : {};
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id) || !Object.hasOwn(given, layer.id) || !Array.isArray(given[layer.id])) continue;
    const pool = poolOf(lists, layer.id, style);
    const [lo, hi] = countRange(section, layer.id);
    const ids = [...new Set(given[layer.id].filter((id) => typeof id === "string" && pool.includes(id)))].slice(0, hi);
    if (ids.length >= lo) layers[layer.id] = ids;
  }
  return { section, bars, layers };
}

/**
 * A share link's plans: one entry per section of the run (null where the
 * section had none), at most PLAN_MAX. Each entry still goes through
 * normalizePlan() when its section comes.
 */
export function readPlans(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, PLAN_MAX).map((p) => (p && typeof p === "object" && !Array.isArray(p) ? p : null));
}
