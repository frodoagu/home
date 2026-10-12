// The autopilot's ✨ AI option: a language model (ai.js: Chrome's built-in
// one, or an LM Studio endpoint) plans the sections ahead of the one playing,
// one ask each, AHEAD of them: which section, how long, which sounds each
// layer plays, how they are dressed (dress.js restyle) and the melodic parts,
// as degrees the pilot develops (editing.js writePart). Pure: this builds the
// prompt and the JSON
// Schema the answer must follow, and normalizePlan() is the gate every plan
// goes through (the model's, or one from a share link) before the pilot takes
// it (autopilot.js withPlan). FX and the swaps inside a section still come
// from the seed.
import { LAYERS, layerById, layerOfVariant } from "./catalog.js";
import { SECTIONS, SECTION_IDS, STYLES, THEME_PATH, countRange, leftOut, poolOf } from "./autopilot.js";
import { SYNTHS } from "./audio/params.js";
import { baseOf, defOf, isCopy } from "./audio/patterns.js";
import { MACROS, MACRO_MAX, moves, synthsFor } from "./dress.js";
import { DEGREES, PART_LENGTHS, REST } from "./editing.js";
import { laneKey } from "./selection.js";
import en from "./i18n/en.js";

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot && !l.manual);
// An intro opens a track; a plan always picks what follows one.
export const PLAN_SECTIONS = SECTION_IDS.filter((id) => id !== "intro");
// Plans a share link carries at most: one per section, about 6 h of track.
export const PLAN_MAX = 256;
// Sections the ✨ AI keeps planned past the one playing.
export const AHEAD = 3;
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
const counts = (section, range = countRange) =>
  LOOP_LAYERS.map((l) => {
    const [lo, hi] = range(section, l.id);
    return `${l.id} ${lo === hi ? lo : `${lo}-${hi}`}`;
  }).join(", ");

// What an opening may play and last, past the pilot's shape for its section:
// an intro may state a lead, stack pads, bring a glitch or hold the kick
// back, and breathe for 16 bars. SECTIONS stays as it is, so seeds replay.
export const OPENING = {
  intro: { kick: [0, 1], bass: [0, 1], perc: [0, 2], lead: [0, 1], pad: [0, 2], glitch: [0, 1] },
};
export const OPENING_BARS = { intro: [8, 16] };
// The hits an opening may fire on its first beat.
export const OPENING_FX = ["fx.impact", "fx.crash", "fx.sweep", "fx.siren", "fx.reverse"];
const openRange = (section, layerId) => OPENING[section]?.[layerId] ?? countRange(section, layerId);
const openBars = (section) => OPENING_BARS[section] ?? barsOf(section);

// "peak", or "peak; now and then breakdown" where the pilot rarely goes.
function follows(section) {
  const { next, odds } = SECTIONS[section];
  const usual = next.filter((_, i) => !odds || odds[i] >= 0.5);
  const rare = next.filter((id) => !usual.includes(id));
  return `${usual.join(" or ")}${rare.length ? `; now and then ${rare.join(" or ")}` : ""}`;
}

const UNITS = Array.from({ length: MACRO_MAX * 2 + 1 }, (_, i) => i - MACRO_MAX);
const PART_LAYERS = Object.keys(PART_LENGTHS);

// Read off SECTIONS, so the model learns the same forms the pilot keeps.
export const SYSTEM = [
  "You arrange a live electronic dance track (psytrance, techno) made of 2-bar loops grouped in sections.",
  "Sections, their lengths in bars and how many sounds each layer usually plays in them:",
  ...SECTION_IDS.map((s) => `- ${s}: ${barsOf(s).join(" or ")} bars; ${counts(s)}`),
  "The usual flow is intro, groove, build, peak, then breakdown or groove, then build again; now and then a build teases into a breakdown instead. A peak lands after a build; a breakdown drops the kick and the bass and lets a lead and a pad breathe.",
  "The lead a breakdown plays is the track's theme: it stays through the build and the peak after it.",
  "Every section plays a lead or a pad. With no wishes from the listener, keep some of the sounds of the section before it and change a layer or two at each section: continuity first, contrast from the section's form.",
  "You plan one section, the one after the one playing now or, when some are already planned, after the last of them (or, when asked, the opening the track starts with): which section, its length in bars (one of the lengths that section has) and the sounds of every layer, using only the ids listed for each layer. An empty list leaves that layer out.",
  "Each sound comes with its name, how it is made and its character in a few words: match the listener's words to those.",
  "The listener's wishes come first, before the usual counts and continuity. Leave out every layer that does not fit them (minimal: no pad, little percussion, no glitch; ambient or deep: no kick, long pads; full or euphoric: every layer at its most) and pick the sounds, the section and the length that match their words. A wish they just made, follow boldly, so the change is clearly heard; a standing one already shapes the track: keep to it while the sections still rise and fall.",
  `You may also dress the sounds you plan, in dress: four macros from -${MACRO_MAX} to ${MACRO_MAX}, 0 leaving the sound as it is: tone (dark to bright), length (short to long; drums and glitches), drive (clean to distorted), motion (still to a sweeping filter and phaser; never on kick or bass). A melodic sound may also switch synth within its group ("" keeps it). Dress only the sounds the wish or the section asks for; leave the others out of dress.`,
  `And you may write the melodic parts, in parts, in scale degrees of the key: "1" the root, "8" the octave up, up to "${DEGREES.at(-1)}"; "${REST}" a rest. lead: ${PART_LENGTHS.lead} sixteenths, an 8-step motif and its answer, played motif, motif, motif, answer over the 2 bars (a lead made of chords walks them onto the degrees). pad: the degree of each bar's chord, ${PART_LENGTHS.pad} of them ("1", "6": i to VI). bass: the ${PART_LENGTHS.bass} sixteenths of one beat, repeated under every beat; the first lands on the kick, so "${REST}", "1", "1", "1" rolls between the kicks. A part goes to the sound you plan in that layer; an empty list leaves it as it is, and the theme's always stays.`,
  "Start the answer with why: one short sentence on what you picked and the reason.",
].join("\n");

// "kick.dark (Dark tok: 250→62 Hz…; dark, sharp, minimal)", with a copy's
// own name when it has one.
function describe(id, names, synths) {
  const [name, detail] = en.variants[baseOf(id)] ?? [id, ""];
  const what = isCopy(id) ? `${names[id] ? `${JSON.stringify(names[id])}, ` : ""}a copy of ${name}` : name;
  const character = CHARACTER[baseOf(id)];
  const synth = synths[id] ? `; synth ${synths[id]}` : "";
  return `${id} (${what}${detail ? `: ${detail}` : ""}${character ? `; ${character}` : ""}${synth})`;
}

// "lead.acid tone -1, drive 2, synth acid"
const dressLine = ({ id, synth, ...macros }) =>
  [id, ...MACROS.filter((k) => macros[k]).map((k) => `${k} ${macros[k]}`), ...(synth ? [`synth ${synth}`] : [])].join(" ");

// "- groove, 16 bars: kick.long, bass.rolling; no pad", the layers it leaves
// to the pilot unsaid.
function plannedLine({ section, bars, layers }) {
  const ids = Object.values(layers).flat();
  const out = Object.keys(layers).filter((id) => !layers[id].length);
  const what = [ids.join(", "), ...out.map((id) => `no ${id}`)].filter(Boolean).join("; ");
  return `- ${section}${bars ? `, ${bars} bars` : ""}${what ? `: ${what}` : ""}`;
}

// The synth groups the style's melodic sounds can move within.
function synthGroups(lists, style) {
  const groups = new Map();
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    for (const id of poolOf(lists, layer.id, style)) {
      const ids = synthsFor(id);
      if (ids.length < 2) continue;
      groups.set(SYNTHS.find((s) => s.id === ids[0]).group, ids);
    }
  }
  return groups;
}

// Every sound the style lets the model use, by layer, and the synths the
// melodic ones can switch to.
function soundLines(lists, style, names, synths) {
  const lines = ["Sounds you can use, by layer:"];
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    lines.push(`${layer.id}: ${poolOf(lists, layer.id, style).map((id) => describe(id, names, synths)).join("; ")}`);
  }
  const groups = synthGroups(lists, style);
  if (groups.size) {
    lines.push("Synths a melodic sound can switch to, by group:");
    for (const [group, ids] of groups) {
      lines.push(`${group}: ${ids.map((id) => `${id} (${en.synths[id].join(": ")})`).join("; ")}`);
    }
  }
  return lines;
}

const keyLine = (style, bpm) => {
  const scale = STYLES[style]?.scale;
  return `Style: ${en.styles[style] ?? style}, ${Math.round(bpm)} BPM. Key: ${scale ? en.scales[scale] : "A, each sound in its own scale (most in A minor)"}.`;
};

/**
 * What to ask for the section after the one playing, or after the `planned`
 * ones (normalized plans, in order) when there are some. `sections` are the ones
 * walked so far (the last one plays now, `bars` long) and `sounds`, beside
 * them, what each one opened with; `vibe` is the listener's own words, `fresh`
 * when no plan has followed them yet; `next`, a section queued by hand, is the
 * one to plan; `theme`, the lead the pilot will hold if what comes is the
 * step after the last section (themeAfter). `dressed` are the plans'
 * dress entries in force (the playing ones are recalled) and `synths` each
 * melodic sound's synth now.
 */
export function planPrompt({
  style,
  bpm,
  lists,
  active,
  sections,
  sounds = [],
  dressed = [],
  synths = {},
  bars,
  vibe = "",
  fresh = false,
  names = {},
  next = null,
  theme = [],
  planned = [],
}) {
  const now = sections.at(-1);
  const last = planned.at(-1)?.section ?? now;
  const playing = [...new Set(Object.values(active))].sort();
  const lines = [
    keyLine(style, bpm),
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
  const worn = dressed.filter((d) => playing.includes(d.id));
  if (worn.length) lines.push(`How you dressed them: ${worn.map(dressLine).join("; ")}.`);
  if (planned.length) lines.push("Already planned to follow it, in order:", ...planned.map(plannedLine));
  const into = THEME_PATH[last];
  if (theme.length && into && (!next || next === into)) {
    lines.push(`If you plan a ${into}, its lead is the theme, ${theme.join(", ")}: the pilot keeps it there whatever you pick.`);
  }
  lines.push(...soundLines(lists, style, names, synths));
  if (vibe && fresh) {
    lines.push(`The listener just asked for: ${JSON.stringify(vibe)}. That comes first: shape this section to it boldly, so the change is clearly heard, and leave out the layers that do not fit.`);
  } else if (vibe) {
    lines.push(`The listener's standing wish: ${JSON.stringify(vibe)}. That comes first: keep the track true to it and leave out the layers that do not fit, while the sections still rise and fall.`);
  }
  if (next) lines.push(`The listener queued ${next} ${planned.length ? `after the planned ${last}` : "next"}: plan that section.`);
  else if (planned.length) lines.push(`After the planned ${last}, the usual next is ${follows(last)}. Plan the section after it.`);
  else lines.push(`After the ${now}, the usual next is ${follows(now)}. Plan the next section.`);
  return lines.join("\n");
}

/**
 * What to ask for the opening: the section the track starts with, from
 * silence (`section`), asked before any plan ahead. It is the show's first
 * impression, so it gets more room than the pilot's intro (OPENING) and a
 * hit on the 1; the UI lays it over the seed's draw (openWith). `active` is
 * that draw, `vibe` the listener's words; `synths` and `names` as in
 * planPrompt().
 */
export function openingPrompt({ style, bpm, lists, section, active = {}, vibe = "", names = {}, synths = {} }) {
  const drawn = [...new Set(Object.values(active))].sort();
  const lines = [
    keyLine(style, bpm),
    "This is the opening of the track and of the show: the first thing the audience hears, out of silence. Make it count: powerful, or beautiful, or both, so it grabs them from the first beat.",
    `Plan the ${section} it opens with: ${openBars(section).join(" or ")} bars; ${counts(section, openRange)}.`,
  ];
  if (section === "intro") {
    lines.push(
      "An intro grows into the groove after it. It may open beautiful, on a pad and a lead stating the track's first motif with the kick held back, or powerful, on the kick with a glitch and a hit on the 1; the bass usually waits for the groove, so the groove lands. Its pads and percussion start muffled and open across it.",
    );
  }
  lines.push(`The seed drew: ${drawn.length ? drawn.join(", ") : "nothing"}. Keep what serves the opening, change the rest.`);
  lines.push(...soundLines(lists, style, names, synths));
  lines.push(
    `fx: one hit on the very first beat, or "" for none: ${OPENING_FX.map((id) => `${id} (${en.variants[id].join(": ")})`).join("; ")}.`,
    "Write the parts of the melodic sounds you pick: the lead's motif is the first melody they hear, make it one they remember; dress the sounds to the opening's mood.",
  );
  if (vibe) lines.push(`The listener asked for: ${JSON.stringify(vibe)}. That comes first: open the track on it boldly, and leave out the layers that do not fit.`);
  lines.push(`Plan the opening ${section}.`);
  return lines.join("\n");
}

/**
 * The JSON Schema of an answer: a sentence on why, then the section, its
 * bars, each layer's ids, how to dress them and the melodic parts, all as
 * enums, so a model that decodes against it cannot name what is not there
 * (`next`, queued by hand, is the only section it may name). Engines differ in how much of a schema they enforce:
 * normalizePlan() checks it all again, and keeps no `why`.
 */
export function planSchema({ lists, style, next = null }) {
  const sections = PLAN_SECTIONS.includes(next) ? [next] : PLAN_SECTIONS;
  const bars = [...new Set(PLAN_SECTIONS.flatMap(barsOf))].sort((a, b) => a - b);
  return schemaOf({ lists, style, sections, bars, range: countRange, most: PLAN_SECTIONS });
}

/**
 * The JSON Schema of an opening: a plan for `section` alone, with the room
 * OPENING gives it, its lengths and a hit for its first beat ("" for none).
 */
export function openingSchema({ lists, style, section }) {
  const schema = schemaOf({ lists, style, sections: [section], bars: openBars(section), range: openRange, most: [section] });
  schema.properties.fx = { type: "string", enum: ["", ...OPENING_FX] };
  schema.required.push("fx");
  return schema;
}

function schemaOf({ lists, style, sections, bars, range, most: over }) {
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue;
    const pool = poolOf(lists, layer.id, style);
    if (!pool.length) continue;
    const most = Math.max(...over.map((s) => range(s, layer.id)[1]));
    layers[layer.id] = { type: "array", items: { type: "string", enum: pool }, maxItems: most };
  }
  const ids = Object.values(layers).flatMap((l) => l.items.enum);
  const synths = [...new Set(ids.flatMap(synthsFor))];
  const unit = { type: "integer", enum: UNITS };
  const dress = {
    type: "array",
    maxItems: Object.values(layers).reduce((sum, l) => sum + l.maxItems, 0),
    items: {
      type: "object",
      properties: {
        id: { type: "string", enum: ids },
        ...Object.fromEntries(MACROS.map((k) => [k, unit])),
        synth: { type: "string", enum: ["", ...synths] },
      },
      required: ["id", ...MACROS, "synth"],
      additionalProperties: false,
    },
  };
  const parts = {};
  for (const layer of PART_LAYERS) {
    if (!layers[layer]) continue;
    parts[layer] = { type: "array", items: { type: "string", enum: DEGREES }, maxItems: PART_LENGTHS[layer] };
  }
  return {
    type: "object",
    properties: {
      why: { type: "string", maxLength: WHY_MAX },
      section: { type: "string", enum: sections },
      bars: { type: "integer", enum: bars },
      layers: { type: "object", properties: layers, required: Object.keys(layers), additionalProperties: false },
      dress,
      parts: { type: "object", properties: parts, required: Object.keys(parts), additionalProperties: false },
    },
    required: ["why", "section", "bars", "layers", "dress", "parts"],
    additionalProperties: false,
  };
}

/**
 * The lead the pilot will hold through the step after the `planned` sections
 * (autopilot.js themeOf), as far as the plans say: `pilot` plays `active` now.
 * A planned breakdown's theme is the lead it names, or none.
 */
export function themeAfter(pilot, active, planned = []) {
  let at = pilot.section;
  let held = at === "breakdown" ? Object.values(active).filter((id) => layerOfVariant(id) === "lead") : at === "build" ? (pilot.theme ?? []) : [];
  for (const { section, layers } of planned) {
    const carried = THEME_PATH[at] === section;
    at = section;
    held = at === "breakdown" ? (layers.lead ?? []) : at === "build" && carried ? held : [];
  }
  return held;
}

/**
 * How many of the plans ahead (`{ plan, queued }`, in order) still hold after
 * the queue changed: the queued sections must be theirs, and past the queue
 * only plans the model picked freely stay (one asked for a section since
 * taken off the queue goes, and everything after it).
 */
export function keptAhead(ahead, queue) {
  const i = ahead.findIndex((e, i) => (i < queue.length ? e.plan.section !== queue[i] : e.queued));
  return i < 0 ? ahead.length : i;
}

/** The model's sentence on its plan, one line and short, or "". */
export const whyOf = (raw) =>
  typeof raw?.why === "string" ? raw.why.replace(/\s+/g, " ").trim().slice(0, WHY_MAX) : "";

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// The dress entries for sounds the plan names, each with only the macros it
// moves (a synth of the sound's group, whole units within range), in id order.
function cleanDress(raw, layers) {
  if (!Array.isArray(raw)) return [];
  const named = new Set(Object.values(layers).flat());
  const out = new Map();
  for (const d of raw) {
    if (!isObject(d) || typeof d.id !== "string" || !named.has(d.id) || out.has(d.id)) continue;
    const entry = { id: d.id };
    for (const k of MACROS) {
      if (Number.isInteger(d[k]) && d[k] && Math.abs(d[k]) <= MACRO_MAX && moves(d.id, k)) entry[k] = d[k];
    }
    if (typeof d.synth === "string" && synthsFor(d.id).includes(d.synth)) entry.synth = d.synth;
    if (Object.keys(entry).length > 1) out.set(d.id, entry);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// A part per melodic layer the plan names a sound in, its degrees repeated
// to the style's length; one with no note is no part.
function cleanParts(raw, layers) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const layer of PART_LAYERS) {
    const given = Object.hasOwn(raw, layer) ? raw[layer] : null;
    const id = layers[layer]?.[0];
    if (!Array.isArray(given) || !id || defOf(id)?.kind !== "notes") continue;
    const degrees = given.filter((d) => DEGREES.includes(d)).slice(0, PART_LENGTHS[layer]);
    if (!degrees.some((d) => d !== REST)) continue;
    out[layer] = Array.from({ length: PART_LENGTHS[layer] }, (_, i) => degrees[i % degrees.length]);
  }
  return out;
}

/**
 * Anyone's answer -> { section, bars, layers, dress?, parts? } or null. The section must be
 * one a plan may pick; `bars` that the section cannot last turn null (the
 * pilot draws a length); a layer keeps only ids in its pool, at most as many
 * as the section plays. Fewer than the section usually plays is the plan's
 * call, down to none: that is how a vibe leaves a layer out (the pilot still
 * plays a lead or a pad). A layer named with nothing usable left (ids that
 * are all foreign) drops out and the pilot draws it. `dress` and `parts` only
 * reach the sounds the plan names (cleanDress, cleanParts). Idempotent: a normalized
 * plan comes back the same, which is what lets a share link replay one.
 */
export function normalizePlan(raw, { lists, style }) {
  if (!isObject(raw)) return null;
  const section = PLAN_SECTIONS.find((id) => id === raw.section);
  if (!section) return null;
  return cleanPlan(raw, { lists, style }, section, barsOf(section), countRange);
}

/**
 * Anyone's opening -> { section, bars, layers, dress?, parts?, fx? } or
 * null: normalizePlan() for `section` only, the section the track starts
 * with, within OPENING, plus a hit of OPENING_FX. Idempotent too.
 */
export function normalizeOpening(raw, { lists, style, section }) {
  if (!isObject(raw) || raw.section !== section || !SECTIONS[section]) return null;
  const plan = cleanPlan(raw, { lists, style }, section, openBars(section), openRange);
  return OPENING_FX.includes(raw.fx) ? { ...plan, fx: raw.fx } : plan;
}

/**
 * The mix an opening (normalizeOpening) starts with: the seed's draw
 * (`active`), with each layer the opening names set to its sounds still in
 * the pool. Draws nothing, so a link replays it. A lead or a pad always
 * plays: one the opening left out comes back from the draw.
 */
export function openWith(active, opening, lists, style) {
  const out = {};
  for (const [lane, id] of Object.entries(active)) {
    if (!Object.hasOwn(opening.layers, layerOfVariant(id))) out[lane] = id;
  }
  for (const [layerId, ids] of Object.entries(opening.layers)) {
    const pool = poolOf(lists, layerId, style);
    for (const id of ids) if (pool.includes(id)) out[laneKey(layerById(layerId), id)] = id;
  }
  const melodic = (mix) => Object.values(mix).some((id) => ["lead", "pad"].includes(layerOfVariant(id)));
  if (melodic(out)) return out;
  for (const [lane, id] of Object.entries(active)) if (["lead", "pad"].includes(layerOfVariant(id))) out[lane] = id;
  return out;
}

function cleanPlan(raw, { lists, style }, section, lengths, range) {
  const bars = lengths.includes(raw.bars) ? raw.bars : null;
  const given = raw.layers && typeof raw.layers === "object" && !Array.isArray(raw.layers) ? raw.layers : {};
  const layers = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id) || !Object.hasOwn(given, layer.id) || !Array.isArray(given[layer.id])) continue;
    const pool = poolOf(lists, layer.id, style);
    const hi = range(section, layer.id)[1];
    const ids = [...new Set(given[layer.id].filter((id) => typeof id === "string" && pool.includes(id)))].slice(0, hi);
    if (ids.length || !given[layer.id].length) layers[layer.id] = ids;
  }
  const dress = cleanDress(raw.dress, layers);
  const parts = cleanParts(raw.parts, layers);
  return {
    section,
    bars,
    layers,
    ...(dress.length ? { dress } : {}),
    ...(Object.keys(parts).length ? { parts } : {}),
  };
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
