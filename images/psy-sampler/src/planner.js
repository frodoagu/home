// The autopilot's ✨ AI option: a language model (ai.js: Chrome's built-in
// one, or an LM Studio endpoint) plans the section after the one playing:
// which section, how long, and which sounds each layer plays. Pure: this
// builds the prompt and the JSON Schema the answer must follow, and
// normalizePlan() is the gate every plan goes through (the model's, or one
// from a share link) before the pilot takes it (autopilot.js withPlan). The
// model only arranges: melodies, how each sound is dressed, FX and the swaps
// inside a section still come from the seed.
import { LAYERS } from "./catalog.js";
import { SECTIONS, SECTION_IDS, THEME_PATH, countRange, leftOut, poolOf } from "./autopilot.js";
import { baseOf, isCopy } from "./audio/patterns.js";
import en from "./i18n/en.js";

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot);
// An intro opens a track; a plan always picks what follows one.
export const PLAN_SECTIONS = SECTION_IDS.filter((id) => id !== "intro");
// Plans a share link carries at most: one per section, about 6 h of track.
export const PLAN_MAX = 256;
const HISTORY = 8; // sections the prompt recalls
const RECALLED = 3; // of those, the ones it lists the sounds of
const WHY_MAX = 200;

// What each sound sounds like, in the words a listener asks with: the
// i18n names say how a sound is made, not whether it is dark or euphoric.
export const CHARACTER = {
  "kick.punchy": "tight, driving",
  "kick.long": "deep, warm, heavy",
  "kick.tok": "short, clicky, hi-tech",
  "kick.fullon": "fat, driving, energetic",
  "kick.techno": "hard, booming",
  "kick.rumble": "dark, rumbling, heavy",
  "kick.prog": "soft, smooth, deep",
  "kick.psytech": "dry, tight, minimal",
  "kick.dark": "dark, sharp, minimal",
  "bass.offbeat": "sparse, minimal, bouncy",
  "bass.rolling": "driving, busy, full-on",
  "bass.rollingOct": "bright, busy, energetic",
  "bass.gallop": "bouncy, driving",
  "bass.fm": "gritty, driving",
  "bass.prog": "deep, smooth, sparse",
  "bass.techno": "dark, gritty, hypnotic",
  "bass.hitech": "fast, busy, twisted",
  "bass.phrygian": "dark, driving, exotic",
  "perc.hat": "airy, sparse",
  "perc.chat": "tight, minimal",
  "perc.shaker": "busy, groovy",
  "perc.clap": "punchy, sparse",
  "perc.snare": "energetic, building",
  "perc.ride": "metallic, driving",
  "perc.toms": "tribal, busy",
  "perc.hat16": "busy, driving",
  "perc.rim": "dry, minimal, groovy",
  "perc.keys": "metallic, quirky, sparse",
  "lead.acid": "squelchy, hypnotic, driving",
  "lead.arp": "bright, hypnotic",
  "lead.arp3": "hypnotic, rolling, light",
  "lead.melodic": "melodic, emotional, smooth",
  "lead.stabs": "bright, euphoric, punchy",
  "lead.zap": "trippy, energetic",
  "lead.bell": "bright, light, melodic",
  "lead.acidPhryg": "dark, squelchy, twisted",
  "lead.techno": "dark, dubby, minimal",
  "lead.bits": "lo-fi, quirky",
  "lead.chirp": "trippy, playful",
  "lead.soaring": "euphoric, uplifting, melodic",
  "lead.grid": "melodic, hypnotic, deep",
  "lead.vowel": "trippy, dark, weird",
  "lead.rubber": "funky, playful, trippy",
  "pad.chord": "warm, melancholic",
  "pad.prog": "dark, exotic, tense",
  "pad.drone": "dark, deep, ambient",
  "pad.air": "airy, ambient, minimal",
  "pad.sus": "uplifting, hopeful",
  "pad.dark": "dark, tense, ominous",
  "pad.epic": "euphoric, epic, uplifting",
  "pad.supersaw": "euphoric, big, bright",
  "pad.fifths": "open, hollow, hypnotic",
  "glitch.stutter": "tense, busy",
  "glitch.blips": "playful, sparse",
  "glitch.zips": "energetic, punchy",
  "glitch.crush": "lo-fi, dark",
  "glitch.metal": "metallic, harsh",
  "glitch.ring": "weird, robotic, dark",
  "glitch.crackle": "subtle, textural, minimal",
  "glitch.rise": "rising, energetic",
  "glitch.tape": "dramatic, sparse",
  "glitch.lasers": "trippy, intense, busy",
};

const barsOf = (section) => SECTIONS[section].loops.map((n) => n * 2);
const counts = (section) =>
  LOOP_LAYERS.map((l) => {
    const [lo, hi] = countRange(section, l.id);
    return `${l.id} ${lo === hi ? lo : `${lo}-${hi}`}`;
  }).join(", ");

// "peak", or "peak; now and then breakdown" where the pilot rarely goes.
function follows(section) {
  const { next, odds } = SECTIONS[section];
  const usual = next.filter((_, i) => !odds || odds[i] >= 0.5);
  const rare = next.filter((id) => !usual.includes(id));
  return `${usual.join(" or ")}${rare.length ? `; now and then ${rare.join(" or ")}` : ""}`;
}

// Read off SECTIONS, so the model learns the same forms the pilot keeps.
export const SYSTEM = [
  "You arrange a live electronic dance track (psytrance, techno) made of 2-bar loops grouped in sections.",
  "Sections, their lengths in bars and how many sounds each layer usually plays in them:",
  ...SECTION_IDS.map((s) => `- ${s}: ${barsOf(s).join(" or ")} bars; ${counts(s)}`),
  "The usual flow is intro, groove, build, peak, then breakdown or groove, then build again; now and then a build teases into a breakdown instead. A peak lands after a build; a breakdown drops the kick and the bass and lets a lead and a pad breathe.",
  "The lead a breakdown plays is the track's theme: it stays through the build and the peak after it.",
  "Every section plays a lead or a pad. With no wishes from the listener, keep some of the sounds playing now and change a layer or two at each section: continuity first, contrast from the section's form.",
  "You plan the section after the one playing now: which section, its length in bars (one of the lengths that section has) and the sounds of every layer, using only the ids listed for each layer. An empty list leaves that layer out.",
  "Each sound comes with its name, how it is made and its character in a few words: match the listener's words to those.",
  "The listener's wishes come first, before the usual counts and continuity. Leave out every layer that does not fit them (minimal: no pad, little percussion, no glitch; ambient or deep: no kick, long pads; full or euphoric: every layer at its most) and pick the sounds, the section and the length that match their words. A wish they just made, follow boldly, so the change is clearly heard; a standing one already shapes the track: keep to it while the sections still rise and fall.",
  "Start the answer with why: one short sentence on what you picked and the reason.",
].join("\n");

// "kick.dark (Dark tok: 250→62 Hz…; dark, sharp, minimal)", with a copy's
// own name when it has one.
function describe(id, names) {
  const [name, detail] = en.variants[baseOf(id)] ?? [id, ""];
  const what = isCopy(id) ? `${names[id] ? `${JSON.stringify(names[id])}, ` : ""}a copy of ${name}` : name;
  const character = CHARACTER[baseOf(id)];
  return `${id} (${what}${detail ? `: ${detail}` : ""}${character ? `; ${character}` : ""})`;
}

/**
 * What to ask for the section after the one playing. `sections` are the ones
 * walked so far (the last one plays now, `bars` long) and `sounds`, beside
 * them, what each one opened with; `vibe` is the listener's own words, `fresh`
 * when no plan has followed them yet; `next`, a section queued by hand, is the
 * one to plan; `theme`, the lead the pilot will hold if what comes is the
 * step after this section (autopilot.js THEME_PATH).
 */
export function planPrompt({
  style,
  bpm,
  lists,
  active,
  sections,
  sounds = [],
  bars,
  vibe = "",
  fresh = false,
  names = {},
  next = null,
  theme = [],
}) {
  const now = sections.at(-1);
  const playing = [...new Set(Object.values(active))].sort();
  const lines = [
    `Style: ${en.styles[style] ?? style}, ${Math.round(bpm)} BPM.`,
    `Sections so far: ${sections.slice(-HISTORY).join(", ")}. Now playing: ${now}, ${bars} bars.`,
  ];
  const recalled = sections
    .map((section, i) => ({ section, ids: sounds[i] }))
    .slice(0, -1)
    .slice(-RECALLED)
    .filter(({ ids }) => Array.isArray(ids) && ids.length);
  if (recalled.length) {
    lines.push("What the sections before it opened with:", ...recalled.map(({ section, ids }) => `- ${section}: ${ids.join(", ")}`));
  }
  lines.push(`Sounds playing now: ${playing.length ? playing.join(", ") : "none"}.`);
  const into = THEME_PATH[now];
  if (theme.length && into && (!next || next === into)) {
    lines.push(`If you plan a ${into}, its lead is the theme, ${theme.join(", ")}: the pilot keeps it there whatever you pick.`);
  }
  lines.push("Sounds you can use, by layer:");
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    lines.push(`${layer.id}: ${poolOf(lists, layer.id, style).map((id) => describe(id, names)).join("; ")}`);
  }
  if (vibe && fresh) {
    lines.push(`The listener just asked for: ${JSON.stringify(vibe)}. That comes first: shape this section to it boldly, so the change is clearly heard, and leave out the layers that do not fit.`);
  } else if (vibe) {
    lines.push(`The listener's standing wish: ${JSON.stringify(vibe)}. That comes first: keep the track true to it and leave out the layers that do not fit, while the sections still rise and fall.`);
  }
  if (next) lines.push(`The listener queued ${next} next: plan that section.`);
  else lines.push(`After the ${now}, the usual next is ${follows(now)}. Plan the next section.`);
  return lines.join("\n");
}

/**
 * The JSON Schema of an answer: a sentence on why, then the section, its
 * bars and each layer's ids as enums, so a model that decodes against it
 * cannot name what is not there (`next`, queued by hand, is the only section
 * it may name). Engines differ in how much of a schema they enforce:
 * normalizePlan() checks it all again, and keeps no `why`.
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
      why: { type: "string", maxLength: WHY_MAX },
      section: { type: "string", enum: PLAN_SECTIONS.includes(next) ? [next] : PLAN_SECTIONS },
      bars: { type: "integer", enum: bars },
      layers: { type: "object", properties: layers, required: Object.keys(layers), additionalProperties: false },
    },
    required: ["why", "section", "bars", "layers"],
    additionalProperties: false,
  };
}

/** The model's sentence on its plan, one line and short, or "". */
export const whyOf = (raw) =>
  typeof raw?.why === "string" ? raw.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";

/**
 * Anyone's answer -> { section, bars, layers } or null. The section must be
 * one a plan may pick; `bars` that the section cannot last turn null (the
 * pilot draws a length); a layer keeps only ids in its pool, at most as many
 * as the section plays. Fewer than the section usually plays is the plan's
 * call, down to none: that is how a vibe leaves a layer out (the pilot still
 * plays a lead or a pad). A layer named with nothing usable left (ids that
 * are all foreign) drops out and the pilot draws it. Idempotent: a normalized
 * plan comes back the same, which is what lets a share link replay one.
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
    const hi = countRange(section, layer.id)[1];
    const ids = [...new Set(given[layer.id].filter((id) => typeof id === "string" && pool.includes(id)))].slice(0, hi);
    if (ids.length || !given[layer.id].length) layers[layer.id] = ids;
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
