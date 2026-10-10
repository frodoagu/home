// Autopilot: an arranger that walks the sections of a track and decides, on
// every loop boundary (2 bars), which variants play. Pure: the UI calls it
// from the engine's bar hook and applies the result on that bar line.
//
//   intro -> groove -> build -> peak -> breakdown | groove -> build -> ...
//
// Each section has a shape (how many variants per layer) and a few possible
// lengths. Every section plays a lead or a pad: kick, bass and percussion
// alone sound like the start or the end of a track. Changes favour
// continuity: a playing variant usually survives a section change, and inside
// a section one variant is swapped every `changeBars` bars. Sections queued by
// hand play next, in order, instead of the natural one. The loop before a peak
// fires a 2-bar riser so it lands on it; entering a section can fire an FX and
// ask for parts to be rewritten (every lead that comes in gets a new melody).
//
// A style narrows each layer to the variants that fit it (copies follow their
// base) and sets the BPM and the scale new melodies use; a style with no pool
// for a layer leaves it out (only some styles glitch). Every choice comes
// from `rng`, so a seeded rng replays the same track: pools are read in id
// order (never in the user's tile order). A run from silence starts an intro;
// over a playing mix it carries on from that mix.
import { LAYERS, layerById, layerOfVariant } from "./catalog.js";
import { baseOf } from "./audio/patterns.js";
import { laneKey } from "./selection.js";

export const SECTIONS = {
  intro: { loops: [4], next: ["groove"], shape: { kick: 1, bass: 0, perc: [1, 1], lead: 0, pad: 1, glitch: 0 } },
  groove: {
    loops: [4, 8],
    next: ["build"],
    shape: { kick: 1, bass: 1, perc: [1, 2], lead: [0, 1], pad: [0, 1], glitch: [0, 1] },
  },
  build: { loops: [4], next: ["peak"], shape: { kick: 1, bass: 1, perc: [2, 2], lead: 1, pad: [0, 1], glitch: [0, 1] } },
  peak: {
    loops: [8, 12],
    next: ["breakdown", "groove"],
    shape: { kick: 1, bass: 1, perc: [2, 3], lead: 1, pad: 1, glitch: 1 },
  },
  breakdown: { loops: [4, 8], next: ["build"], shape: { kick: 0, bass: 0, perc: [0, 1], lead: 1, pad: 1, glitch: 0 } },
};
export const SECTION_IDS = Object.keys(SECTIONS);

export const STYLES = {
  techno: {
    bpm: 132,
    pool: {
      kick: ["kick.techno", "kick.rumble"],
      bass: ["bass.techno", "bass.offbeat"],
      perc: ["perc.hat", "perc.hat16", "perc.clap", "perc.rim", "perc.ride"],
      lead: ["lead.techno", "lead.stabs", "lead.acid"],
      pad: ["pad.drone", "pad.fifths", "pad.air"],
      glitch: ["glitch.metal", "glitch.crush", "glitch.stutter"],
    },
    entryFx: { groove: [null, null, "fx.sweep", "fx.reverse"] },
  },
  progressive: {
    bpm: 138,
    pool: {
      kick: ["kick.prog", "kick.long"],
      bass: ["bass.prog", "bass.gallop", "bass.offbeat"],
      perc: ["perc.hat", "perc.shaker", "perc.clap", "perc.ride"],
      lead: ["lead.arp3", "lead.bell", "lead.melodic"],
      pad: ["pad.epic", "pad.sus", "pad.chord", "pad.air"],
    },
    entryFx: { groove: [null, null, "fx.sweep"] },
  },
  psytrance: {
    bpm: 145,
    pool: {
      kick: ["kick.punchy", "kick.fullon"],
      bass: ["bass.rolling", "bass.rollingOct", "bass.gallop"],
      perc: ["perc.hat", "perc.chat", "perc.clap", "perc.snare", "perc.ride"],
      lead: ["lead.acid", "lead.arp", "lead.melodic", "lead.stabs"],
      pad: ["pad.chord", "pad.prog", "pad.supersaw"],
    },
  },
  psytech: {
    bpm: 142,
    scale: "phrygian",
    pool: {
      kick: ["kick.psytech", "kick.punchy"],
      bass: ["bass.fm", "bass.rolling"],
      perc: ["perc.chat", "perc.clap", "perc.rim", "perc.hat"],
      lead: ["lead.acidPhryg", "lead.arp", "lead.zap", "lead.bits"],
      pad: ["pad.dark", "pad.drone", "pad.prog"],
      glitch: ["glitch.zips", "glitch.blips", "glitch.stutter", "glitch.ring"],
    },
    entryFx: { groove: [null, null, "fx.stutter", "fx.zap"] },
  },
  hitech: {
    bpm: 180,
    scale: "phrygian",
    pool: {
      kick: ["kick.tok", "kick.dark"],
      bass: ["bass.hitech", "bass.fm"],
      perc: ["perc.chat", "perc.hat16", "perc.snare", "perc.rim"],
      lead: ["lead.zap", "lead.acidPhryg", "lead.arp", "lead.bits", "lead.chirp"],
      pad: ["pad.dark", "pad.air", "pad.drone"],
      glitch: [
        "glitch.zips", "glitch.blips", "glitch.stutter", "glitch.rise", "glitch.tape", "glitch.metal", "glitch.crush",
      ],
    },
    entryFx: { groove: [null, "fx.zap", "fx.stutter", "fx.siren"], breakdown: ["fx.down", "fx.tapeStop"] },
  },
  goa: {
    bpm: 145,
    scale: "harmonic",
    pool: {
      kick: ["kick.long", "kick.fullon"],
      bass: ["bass.rolling", "bass.rollingOct"],
      perc: ["perc.hat", "perc.shaker", "perc.toms", "perc.snare"],
      lead: ["lead.acid", "lead.melodic", "lead.arp"],
      pad: ["pad.prog", "pad.chord", "pad.fifths"],
    },
    entryFx: { groove: [null, "fx.siren", "fx.siren", "fx.zap"] },
  },
  darkpsy: {
    bpm: 155,
    scale: "phrygian",
    pool: {
      kick: ["kick.dark", "kick.tok"],
      bass: ["bass.phrygian", "bass.fm", "bass.hitech"],
      perc: ["perc.chat", "perc.hat16", "perc.rim", "perc.toms", "perc.snare"],
      lead: ["lead.acidPhryg", "lead.zap", "lead.bell", "lead.chirp"],
      pad: ["pad.dark", "pad.drone", "pad.air"],
      glitch: ["glitch.crackle", "glitch.ring", "glitch.metal", "glitch.crush", "glitch.tape"],
    },
    entryFx: { breakdown: ["fx.down", "fx.tapeStop"] },
  },
  all: { bpm: null, pool: null }, // every sound, at any BPM
};
export const STYLE_IDS = Object.keys(STYLES);
export const STYLE_DEFAULT = "psytrance";

// How often a section swaps one variant, in bars.
export const CHANGE_BARS = [2, 4, 8, 16, 32];
export const CHANGE_DEFAULT = 8;

const ENTRY_FX = { peak: ["fx.crash", "fx.impact"], breakdown: ["fx.down"], groove: [null, null, "fx.zap", "fx.siren"] };
const BUILD_FX = ["fx.riser", "fx.riserImpact", "fx.reverse"];
const REWRITE = { build: ["lead", 0.5], breakdown: ["lead", 0.6], groove: ["bass", 0.25] };
const KEEP = 0.75; // a playing variant survives a section change
const MELODIC = ["lead", "pad"]; // every section plays at least one
const BEAT = ["kick", "bass", "perc"];

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot);
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const playingOf = (active, layerId) =>
  Object.values(active)
    .filter((id) => layerOfVariant(id) === layerId)
    .sort();
const range = (spec) => (Array.isArray(spec) ? spec : [spec, spec]);
const leftOut = (style, layerId) => Boolean(STYLES[style]?.pool) && !STYLES[style].pool[layerId];

/** A layer's variants under `style`, in id order; copies follow their base. */
export function poolOf(lists, layerId, style = STYLE_DEFAULT) {
  const allowed = STYLES[style]?.pool?.[layerId];
  const list = allowed ? lists[layerId].filter((id) => allowed.includes(baseOf(id))) : lists[layerId];
  return [...(list.length ? list : lists[layerId])].sort();
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The variants a section plays, built from what plays now. */
export function arrange(section, active, lists, rng, style = STYLE_DEFAULT) {
  const { shape } = SECTIONS[section];
  const wants = {};
  for (const layer of LOOP_LAYERS) {
    const [lo, hi] = range(shape[layer.id]);
    wants[layer.id] = leftOut(style, layer.id) ? 0 : lo + Math.floor(rng() * (hi - lo + 1));
  }
  if (MELODIC.every((id) => !wants[id])) {
    const open = MELODIC.filter((id) => range(shape[id])[1] > 0);
    const playing = open.filter((id) => playingOf(active, id).length);
    wants[pick(playing.length ? playing : open, rng)] = 1;
  }
  const out = {};
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue; // draws nothing: older layers replay as before
    const pool = poolOf(lists, layer.id, style);
    const playing = playingOf(active, layer.id).filter((id) => pool.includes(id));
    const kept = shuffle(playing, rng).filter(() => rng() < KEEP);
    const fresh = shuffle(pool.filter((id) => !playing.includes(id)), rng);
    const chosen = [...kept, ...fresh, ...playing.filter((id) => !kept.includes(id))].slice(0, wants[layer.id]);
    for (const id of chosen) out[laneKey(layer, id)] = id;
  }
  return out;
}

// One swap: a playing variant (never the kick) for one of its layer's others.
function vary(active, lists, rng, style) {
  const layers = LOOP_LAYERS.filter((l) => l.id !== "kick" && playingOf(active, l.id).length);
  if (!layers.length) return active;
  const layer = pick(layers, rng);
  const playing = playingOf(active, layer.id);
  const pool = poolOf(lists, layer.id, style).filter((id) => !playing.includes(id));
  if (!pool.length) return active;
  const out = pick(playing, rng);
  const next = { ...active };
  delete next[laneKey(layer, out)];
  const id = pick(pool, rng);
  next[laneKey(layer, id)] = id;
  return next;
}

// Variants in `next` that were not playing in `prev`, in id order.
export const entering = (prev, next) => {
  const was = new Set(Object.values(prev));
  return Object.values(next)
    .filter((id) => !was.has(id))
    .sort();
};
const newLeads = (prev, next) => entering(prev, next).filter((id) => layerOfVariant(id) === "lead");

const lengthOf = (section, rng) => pick(SECTIONS[section].loops, rng);
const fresh = (section, length, queue = []) => ({ section, left: length, length, queue });

/** Engaging from silence: `section` (an intro unless one was asked for). */
export function startPilot(lists, rng, style = STYLE_DEFAULT, section = "intro") {
  const pilot = fresh(section, lengthOf(section, rng));
  const active = arrange(section, {}, lists, rng, style);
  return { pilot, active, rewrite: newLeads({}, active) };
}

/** A best guess of the section a mix belongs to, read off the shapes. */
export function guessSection(active) {
  const has = (layerId) => Object.values(active).some((id) => layerOfVariant(id) === layerId);
  if (!has("kick") && (has("lead") || has("pad"))) return "breakdown";
  if (has("kick") && has("pad")) return "peak";
  if (has("kick") && has("lead")) return "build";
  if (has("bass")) return "groove";
  return "intro";
}

/**
 * Engaging over a playing mix: it carries on, in the section the mix looks
 * like, or in `section` when one was asked for (rearranged on the next loop).
 */
export function joinPilot(active, section = null) {
  const at = section ?? guessSection(active);
  return { ...fresh(at, SECTIONS[at].loops[0]), ...(section ? { rearrange: true } : {}) };
}

/** Jumps the pilot to `section` (a recalled snapshot's), keeping the queue. */
export const moveTo = (pilot, section) => ({ ...fresh(section, SECTIONS[section].loops[0], pilot.queue) });

/* ---- by hand: the queue, "next", a new style ---- */

export const enqueue = (pilot, section) => ({ ...pilot, queue: [...pilot.queue, section] });
export const dequeue = (pilot, index) => ({ ...pilot, queue: pilot.queue.filter((_, i) => i !== index) });
// The current loop is the section's last: the next one moves on.
export const skip = (pilot) => ({ ...pilot, left: 1, next: undefined });
// The next loop rearranges the section with the new style's sounds.
export const rearrange = (pilot) => ({ ...pilot, rearrange: true });

/** Kick, bass or percussion with no lead and no pad. */
export function isBare(active) {
  const layers = Object.values(active).map(layerOfVariant);
  return layers.some((l) => BEAT.includes(l)) && !layers.some((l) => MELODIC.includes(l));
}

/** A bare mix with a lead or a pad added. */
export function fillMelodic(active, lists, rng, style = STYLE_DEFAULT) {
  const layer = layerById(pick(MELODIC, rng));
  const id = pick(poolOf(lists, layer.id, style), rng);
  return { ...active, [laneKey(layer, id)]: id };
}

/**
 * The next loop: { pilot, active, fx: [fx ids], rewrite: [variant ids] }.
 * `fx` fire on the boundary; `rewrite` are parts to write anew.
 */
export function advance(pilot, active, lists, rng, { style = STYLE_DEFAULT, changeBars = CHANGE_DEFAULT } = {}) {
  const queue = pilot.queue ?? [];
  if (pilot.left > 1) {
    const left = pilot.left - 1;
    const done = pilot.length - left;
    let next = active;
    if (pilot.rearrange) next = arrange(pilot.section, active, lists, rng, style);
    else if ((done * 2) % changeBars === 0) next = vary(active, lists, rng, style);
    const fx = [];
    let upcoming;
    if (left === 1) {
      upcoming = queue[0] ?? pick(SECTIONS[pilot.section].next, rng);
      if (upcoming === "peak") fx.push(pick(BUILD_FX, rng));
    }
    return {
      pilot: { section: pilot.section, left, length: pilot.length, queue, ...(upcoming ? { next: upcoming } : {}) },
      active: next,
      fx,
      rewrite: newLeads(active, next),
    };
  }
  const section = queue[0] ?? pilot.next ?? pick(SECTIONS[pilot.section].next, rng);
  const next = arrange(section, active, lists, rng, style);
  const entryFx = { ...ENTRY_FX, ...STYLES[style]?.entryFx }[section];
  const entry = entryFx ? pick(entryFx, rng) : null;
  const rewrite = new Set(newLeads(active, next));
  const [layerId, chance] = REWRITE[section] ?? [];
  if (layerId && rng() < chance) playingOf(next, layerId).slice(0, 1).forEach((id) => rewrite.add(id));
  return {
    pilot: fresh(section, lengthOf(section, rng), queue[0] ? queue.slice(1) : queue),
    active: next,
    fx: entry ? [entry] : [],
    rewrite: [...rewrite].sort(),
  };
}
