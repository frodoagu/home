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
// That loop is a drop (`dropping`): the UI rolls the kick on its first bar,
// takes kick and bass out on its second and sweeps a highpass up the mix
// across both. Every build ends in one, and one build in ten is a tease that
// lands in a breakdown instead (`odds`, one draw like any pick). The lead a
// breakdown plays is the track's theme: it stays through the build and the
// peak after it (`theme`), so the drop delivers the melody the breakdown
// taught. The last loop of every 8-bar phrase ends in a fill (`phraseEnd`),
// and the peak pumps (`PUMP`). Besides the faders it rides each sound's tone
// filters (`toneOf`): a muffled lead opens across a build, a pad steps out
// of the bass's way. And it decides which sounds improvise (`improvises`),
// from the seed per section and sound. None of it draws from `rng` beyond what the
// arrangement already drew, so a seed only plays differently from the first
// tease or the first breakdown on.
//
// A style narrows each layer to the variants that fit it (copies follow their
// base) and sets the BPM range and the scale new melodies use; a style with no pool
// for a layer leaves it out, and so does banning every sound of its pool
// (`unbanned`: the UI hands the pilot its lists without them). Every choice comes
// from `rng`, so a seeded rng replays the same track: pools are read in id
// order (never in the user's tile order). A run from silence starts an intro;
// over a playing mix it carries on from that mix. A style picked while the
// pilot plays waits for the next drop out of a breakdown (`styleOnDrop`): the
// sections up to it are queued and the old style plays them.
//
// It also rides the faders (`mixOf`): each section has its own balance, a
// build swells into the peak, stacked sounds share their layer's room and a
// pad steps back under a lead. The UI draws each loop's move as a straight
// line over the loop, so a section's volumes are one continuous curve. That
// needs no rng, so it never shifts a seed.
//
// A plan (planner.js: the ✨ AI's, or a share link's) can decide the section
// after this one: which, how long, and the variants of the layers it names.
// The pilot takes it before the section's last loop (`withPlan`), where it
// stands in for the pick of the next section; the queue still goes first.
// The ✨ AI may also lay out the form of the whole track (`withForm`): the
// sections to walk, in order, after whatever is queued by hand.
import { LAYERS, layerById, layerOfVariant } from "./catalog.js";
import { LEVEL } from "./audio/params.js";
import { HP_OPEN, LP_OPEN } from "./audio/insert.js";
import { baseOf } from "./audio/patterns.js";
import { laneKey } from "./selection.js";

export const SECTIONS = {
  intro: { loops: [4], next: ["groove"], shape: { kick: 1, bass: 0, perc: [1, 1], lead: 0, pad: 1, glitch: 0 } },
  groove: {
    loops: [4, 8],
    next: ["build"],
    shape: { kick: 1, bass: 1, perc: [1, 2], lead: [0, 1], pad: [0, 1], glitch: 1 },
  },
  build: {
    loops: [4],
    next: ["peak", "breakdown"],
    odds: [0.9, 0.1], // a tease now and then: the drop's cues, then a breakdown
    shape: { kick: 1, bass: 1, perc: [2, 2], lead: 1, pad: [0, 1], glitch: 1 },
  },
  peak: {
    loops: [8, 12],
    next: ["breakdown", "groove"],
    shape: { kick: 1, bass: 1, perc: [2, 3], lead: 1, pad: 1, glitch: 1 },
  },
  breakdown: {
    loops: [4, 8],
    next: ["build"],
    shape: { kick: 0, bass: 0, perc: [0, 1], lead: 1, pad: 1, glitch: [0, 1] },
  },
};
export const SECTION_IDS = Object.keys(SECTIONS);

export const STYLES = {
  techno: {
    bpm: [125, 135],
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
    bpm: [132, 140],
    pool: {
      kick: ["kick.prog", "kick.long"],
      bass: ["bass.prog", "bass.gallop", "bass.offbeat"],
      perc: ["perc.hat", "perc.shaker", "perc.clap", "perc.ride"],
      lead: ["lead.arp3", "lead.bell", "lead.melodic", "lead.soaring", "lead.grid"],
      pad: ["pad.epic", "pad.sus", "pad.chord", "pad.air"],
      glitch: ["glitch.crackle", "glitch.metal", "glitch.rise"],
    },
    entryFx: { groove: [null, null, "fx.sweep"] },
  },
  psytrance: {
    bpm: [140, 148],
    pool: {
      kick: ["kick.punchy", "kick.fullon"],
      bass: ["bass.rolling", "bass.rollingOct", "bass.gallop"],
      perc: ["perc.hat", "perc.chat", "perc.clap", "perc.snare", "perc.ride"],
      lead: ["lead.acid", "lead.arp", "lead.melodic", "lead.stabs", "lead.soaring", "lead.grid", "lead.vowel"],
      pad: ["pad.chord", "pad.prog", "pad.supersaw"],
      glitch: ["glitch.zips", "glitch.stutter", "glitch.rise", "glitch.metal"],
    },
  },
  psytech: {
    bpm: [138, 146],
    scale: "phrygian",
    pool: {
      kick: ["kick.psytech", "kick.punchy"],
      bass: ["bass.fm", "bass.rolling"],
      perc: ["perc.chat", "perc.clap", "perc.rim", "perc.hat"],
      lead: ["lead.acidPhryg", "lead.arp", "lead.zap", "lead.bits", "lead.vowel", "lead.rubber"],
      pad: ["pad.dark", "pad.drone", "pad.prog"],
      glitch: ["glitch.zips", "glitch.blips", "glitch.stutter", "glitch.ring", "glitch.lasers"],
    },
    entryFx: { groove: [null, null, "fx.stutter"] },
  },
  hitech: {
    bpm: [170, 195],
    scale: "phrygian",
    pool: {
      kick: ["kick.tok", "kick.dark"],
      bass: ["bass.hitech", "bass.fm"],
      perc: ["perc.chat", "perc.hat16", "perc.snare", "perc.rim"],
      lead: ["lead.zap", "lead.acidPhryg", "lead.arp", "lead.bits", "lead.chirp", "lead.rubber"],
      pad: ["pad.dark", "pad.air", "pad.drone"],
      glitch: [
        "glitch.zips", "glitch.blips", "glitch.stutter", "glitch.rise", "glitch.tape", "glitch.metal", "glitch.crush",
        "glitch.lasers",
      ],
    },
    entryFx: { groove: [null, "fx.stutter", "fx.siren"], breakdown: ["fx.down", "fx.tapeStop"] },
  },
  goa: {
    bpm: [140, 150],
    scale: "harmonic",
    pool: {
      kick: ["kick.long", "kick.fullon"],
      bass: ["bass.rolling", "bass.rollingOct"],
      perc: ["perc.hat", "perc.shaker", "perc.toms", "perc.snare"],
      lead: ["lead.acid", "lead.melodic", "lead.arp"],
      pad: ["pad.prog", "pad.chord", "pad.fifths"],
      glitch: ["glitch.zips", "glitch.ring", "glitch.rise", "glitch.blips", "glitch.lasers"],
    },
    entryFx: { groove: [null, "fx.siren", "fx.siren"] },
  },
  darkpsy: {
    bpm: [148, 165],
    scale: "phrygian",
    pool: {
      kick: ["kick.dark", "kick.tok"],
      bass: ["bass.phrygian", "bass.fm", "bass.hitech"],
      perc: ["perc.chat", "perc.hat16", "perc.rim", "perc.toms", "perc.snare"],
      lead: ["lead.acidPhryg", "lead.zap", "lead.bell", "lead.chirp", "lead.vowel", "lead.rubber"],
      pad: ["pad.dark", "pad.drone", "pad.air"],
      glitch: ["glitch.crackle", "glitch.ring", "glitch.metal", "glitch.crush", "glitch.tape"],
    },
    entryFx: { breakdown: ["fx.down", "fx.tapeStop"] },
  },
  all: { bpm: null, pool: null }, // every sound, at any BPM
};
export const STYLE_IDS = Object.keys(STYLES);
export const STYLE_DEFAULT = "psytrance";

/** The BPM nearest `bpm` within `style`'s range (any, for a style without one). */
export function bpmFor(style, bpm) {
  const range = STYLES[style]?.bpm;
  return range ? Math.min(range[1], Math.max(range[0], Math.round(bpm))) : bpm;
}

// How often a section swaps one variant, in bars.
export const CHANGE_BARS = [2, 4, 8, 16, 32];
export const CHANGE_DEFAULT = 8;

const ENTRY_FX = { peak: ["fx.crash", "fx.impact"], breakdown: ["fx.down"], groove: [null, null, "fx.siren"] };
const BUILD_FX = ["fx.riser", "fx.riserImpact", "fx.reverse"];
const REWRITE = { build: ["lead", 0.5], breakdown: ["lead", 0.6], groove: ["bass", 0.25] };
const KEEP = 0.75; // a playing variant survives a section change
const MELODIC = ["lead", "pad"]; // every section plays at least one
const BEAT = ["kick", "bass", "perc"];

// A sound's volume per section and layer (1 when absent): [as the section
// starts, as it ends], or one value that holds.
export const MIX = {
  intro: { kick: 0.85, perc: 0.8, pad: 1.1 },
  groove: {},
  build: { perc: [0.9, 1.15], lead: [0.8, 1.15], pad: [1, 0.8], glitch: [0.8, 1.1] },
  peak: { lead: 1.1, pad: 0.95 },
  breakdown: { perc: 0.75, lead: [0.9, 1.1], pad: 1.3, glitch: 0.8 },
};
// The tone each layer gets per section, in Hz (insert.js hp / lp): [as the
// section starts, as it ends] or one value; absent is open. It moves in
// exponential lines, so a lowpass opens evenly in octaves. Kick and bass
// are never touched: they are the groove.
export const TONE = {
  intro: { perc: { lp: [3000, 9000] }, pad: { lp: [900, 3000] } },
  groove: { lead: { lp: 5000 }, pad: { hp: 180 } },
  build: { lead: { lp: [1500, LP_OPEN] }, pad: { hp: [180, 600] } },
  peak: { pad: { hp: 220 } },
  breakdown: { lead: { lp: [1200, 6000] }, perc: { lp: 2500 }, glitch: { lp: 3000 } },
};
export const TONE_LAYERS = ["perc", "lead", "pad", "glitch"];

// An intro the ✨ AI opened (planner.js OPENING, `pilot.opening`) rides its
// own curves, the way a track's intro builds: the atmosphere first, then the
// kick comes in muffled from 40 % of the way and the bass from halfway,
// quiet and filtered, both opening up as they go; its last loop drops into
// what follows (`dropping`). [from, to, start]: `from` holds until `start`
// of the way, then it moves. Kick and bass reach the groove open
// (OPENING_OPEN), which is the explosion.
export const OPENING_MIX = {
  kick: [0, 0.85, 0.4],
  bass: [0, 0.8, 0.5],
  perc: [0.3, 0.8, 0.2],
  lead: [0.5, 0.95],
  pad: [0.8, 1.1],
  glitch: [0.4, 0.85],
};
export const OPENING_TONE = {
  kick: { lp: [150, 2500, 0.4] },
  bass: { lp: [120, 1500, 0.5] },
  perc: { lp: [1500, 9000] },
  lead: { lp: [700, 4000] },
  pad: { lp: [700, 3000] },
  glitch: { lp: [1200, 6000] },
};
// The layers an opening filters that no section rides: they open when it ends.
export const OPENING_OPEN = ["kick", "bass"];

// The chance a sound improvises (🔀) in each section, per layer, drawn per
// seed, section and sound (dress.js coin), never from rng. None in the
// intro, the most in the build; the breakdown lays its theme out as written.
export const IMPROVISE = {
  intro: {},
  groove: { perc: 0.3, lead: 0.3, glitch: 0.5 },
  build: { perc: 0.6, lead: 0.5, glitch: 0.7 },
  peak: { bass: 0.25, perc: 0.5, lead: 0.4, glitch: 0.7 },
  breakdown: { glitch: 0.3 },
};

/** Whether `id` improvises in `section`, for its coin in [0, 1). */
export const improvises = (section, id, coin) => coin < (IMPROVISE[section]?.[layerOfVariant(id)] ?? 0);

const STACK = 0.3; // n sounds in a layer play at n^-STACK each
const DUCK = 0.85; // a pad under a lead

// The sidechain a section asks for on top of each sound's own duck (the
// engine takes the deeper of the two): the peak pumps its pads and leads.
export const PUMP = { peak: { pad: 0.6, lead: 0.35 } };

// A phrase is 8 bars: 4 loops. Sections are 4, 8 or 12 loops, so phrases
// line up with them.
export const PHRASE_LOOPS = 4;

// A manual layer (the classics) is the listener's: the pilot never draws for
// it and keeps whatever of it plays.
const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot && !l.manual);
const byHand = (active) =>
  Object.fromEntries(Object.entries(active).filter(([, id]) => layerById(layerOfVariant(id))?.manual));
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
// The section after `section`: one draw, like pick(), whatever its odds, so
// odds only change the seeds that land on them.
function nextOf(section, rng) {
  const { next, odds } = SECTIONS[section];
  if (!odds) return pick(next, rng);
  let r = rng();
  return next.find((_, i) => (r -= odds[i]) < 0) ?? next.at(-1);
}
const playingOf = (active, layerId) =>
  Object.values(active)
    .filter((id) => layerOfVariant(id) === layerId)
    .sort();
const range = (spec) => (Array.isArray(spec) ? spec : [spec, spec]);
/** Whether `style` has no pool for a layer, so the pilot leaves it out. */
export const leftOut = (style, layerId) => Boolean(STYLES[style]?.pool) && !STYLES[style].pool[layerId];
/** [fewest, most] variants a section plays in a layer. */
export const countRange = (section, layerId) => range(SECTIONS[section].shape[layerId]);

/** A layer's variants under `style`, in id order; copies follow their base. */
export function poolOf(lists, layerId, style = STYLE_DEFAULT) {
  const allowed = STYLES[style]?.pool?.[layerId];
  const list = allowed ? lists[layerId].filter((id) => allowed.includes(baseOf(id))) : lists[layerId];
  return [...list].sort();
}

/**
 * `lists` without the sounds the user banned from the pilot: what every
 * pick reads. A layer whose style sounds are all banned sits out.
 */
export const unbanned = (lists, banned) =>
  banned.length ? Object.fromEntries(Object.entries(lists).map(([l, ids]) => [l, ids.filter((id) => !banned.includes(id))])) : lists;

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// A plan's variants for a layer that are still in its pool (the style may
// have changed since), or null when the plan leaves the layer to the rng:
// it does not name it, or none of the sounds it names are left. An empty
// list is the plan's own: the layer sits out.
function planned(fixed, layerId, lists, style) {
  if (!Object.hasOwn(fixed, layerId)) return null;
  const pool = poolOf(lists, layerId, style);
  const ids = fixed[layerId].filter((id) => pool.includes(id));
  return ids.length || !fixed[layerId].length ? ids : null;
}

/**
 * The variants a section plays, built from what plays now. A playing variant
 * in `hold` (the theme) is always kept, after the same draws as any other.
 * `fixed` (a plan's layers) sets a layer outright, at most as many as the
 * section plays and as few as none; the other layers draw as usual, and with
 * no plan every draw is the same as ever.
 */
export function arrange(section, active, lists, rng, style = STYLE_DEFAULT, hold = [], fixed = {}) {
  const { shape } = SECTIONS[section];
  const wants = {};
  const own = {};
  for (const layer of LOOP_LAYERS) {
    const [lo, hi] = range(shape[layer.id]);
    let given = leftOut(style, layer.id) ? null : planned(fixed, layer.id, lists, style);
    if (given) {
      // The theme stays even where a plan names the layer: the drop delivers
      // the melody the breakdown taught.
      const pool = poolOf(lists, layer.id, style);
      const held = playingOf(active, layer.id).filter((id) => hold.includes(id) && pool.includes(id) && !given.includes(id));
      given = [...held, ...given].slice(0, hi);
    }
    if (leftOut(style, layer.id)) wants[layer.id] = 0;
    else if (given) {
      own[layer.id] = given;
      wants[layer.id] = given.length;
    } else wants[layer.id] = lo + Math.floor(rng() * (hi - lo + 1));
  }
  if (MELODIC.every((id) => !wants[id])) {
    const open = MELODIC.filter((id) => range(shape[id])[1] > 0);
    const playing = open.filter((id) => playingOf(active, id).length);
    const layerId = pick(playing.length ? playing : open, rng);
    wants[layerId] = 1;
    delete own[layerId]; // a plan with no lead and no pad still gets one
  }
  const out = byHand(active);
  for (const layer of LOOP_LAYERS) {
    if (leftOut(style, layer.id)) continue; // draws nothing: older layers replay as before
    if (own[layer.id]) {
      for (const id of own[layer.id]) out[laneKey(layer, id)] = id;
      continue;
    }
    const pool = poolOf(lists, layer.id, style);
    const playing = playingOf(active, layer.id).filter((id) => pool.includes(id));
    const kept = shuffle(playing, rng)
      .filter((id) => rng() < KEEP || hold.includes(id))
      .sort((a, b) => hold.includes(b) - hold.includes(a));
    const fresh = shuffle(pool.filter((id) => !playing.includes(id)), rng);
    const chosen = [...kept, ...fresh, ...playing.filter((id) => !kept.includes(id))].slice(0, wants[layer.id]);
    for (const id of chosen) out[laneKey(layer, id)] = id;
  }
  return out;
}

// One swap: a playing variant (never the kick) for one of its layer's others.
// A held one (the theme) stays, after the same draws.
function vary(active, lists, rng, style, hold = []) {
  const layers = LOOP_LAYERS.filter((l) => l.id !== "kick" && playingOf(active, l.id).length);
  if (!layers.length) return active;
  const layer = pick(layers, rng);
  const playing = playingOf(active, layer.id);
  const pool = poolOf(lists, layer.id, style).filter((id) => !playing.includes(id));
  if (!pool.length) return active;
  const out = pick(playing, rng);
  const next = { ...active };
  const lane = Object.keys(active).find((k) => active[k] === out);
  delete next[lane];
  const id = pick(pool, rng);
  if (hold.includes(out)) return active;
  next[lane === out ? id : laneKey(layer, id)] = id; // a stacked kick or bass keeps its own lane
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
const fresh = (section, length, queue = [], form = []) => ({
  section,
  left: length,
  length,
  queue,
  ...(form.length ? { form } : {}),
});

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
export const moveTo = (pilot, section) => ({
  ...fresh(section, SECTIONS[section].loops[0], pilot.queue, pilot.form),
  ...handedOn(pilot.handoff, section),
});

/**
 * Hands the pilot a plan (planner.js normalizePlan) for the section after
 * this one. Only before the section's last loop: that loop announces what
 * comes next and fires the riser into a peak, so a later plan would change a
 * decision already made. Too late, the pilot comes back unchanged.
 */
export const withPlan = (pilot, plan) => (pilot && plan && pilot.left > 1 ? { ...pilot, plan } : pilot);

/** The pilot walks `form` (section ids) after the queue, in place of its own picks. */
export function withForm(pilot, form) {
  const { form: _old, ...rest } = pilot;
  return form.length ? { ...rest, form } : rest;
}

/** The sections coming after this one, as far as the queue and the form say. */
export const sequence = (pilot) => [...pilot.queue, ...(pilot.form ?? [])];

/* ---- by hand: the queue, "next", a new style ---- */

export const enqueue = (pilot, section) => ({ ...pilot, queue: [...pilot.queue, section] });
export const dequeue = (pilot, index) => ({ ...pilot, queue: pilot.queue.filter((_, i) => i !== index) });
export const unform = (pilot, index) => withForm(pilot, (pilot.form ?? []).filter((_, i) => i !== index));
// The current loop is the section's last: the next one moves on.
export const skip = (pilot) => ({ ...pilot, left: 1, next: undefined });
// The next loop rearranges the section with the new style's sounds.
export const rearrange = (pilot) => ({ ...pilot, rearrange: true });

/* ---- a new style: in on the next drop out of a breakdown ---- */

// The sections settled after this one: the one its last loop announced.
const settled = (pilot) => (pilot.left === 1 && pilot.next !== undefined ? [pilot.queue[0] ?? pilot.next] : []);

/**
 * A style picked while the pilot plays (`playing` is the one it plays): it
 * comes in on the next drop out of a breakdown, so the track changes over a
 * break instead of on the next loop. The sections still missing up to that
 * drop (a breakdown, a build, a peak) are queued ahead of the rest, after
 * the one already announced. One on its way is only retargeted, and picking
 * the playing style again calls it off (what it queued stays: ✕ drops it).
 */
export function styleOnDrop(pilot, style, playing) {
  if (pilot.handoff) {
    if (style === playing) {
      const { handoff: _off, ...rest } = pilot;
      return rest;
    }
    return { ...pilot, handoff: { ...pilot.handoff, style } };
  }
  if (style === playing) return pilot;
  const ahead = settled(pilot);
  let broke = pilot.section === "breakdown";
  for (const section of ahead) broke ||= section === "breakdown";
  const last = ahead.at(-1) ?? pilot.section;
  const route = !broke ? ["breakdown", "build", "peak"] : last === "breakdown" ? ["build", "peak"] : ["peak"];
  let { queue } = pilot;
  let form = pilot.form ?? [];
  if (!ahead.length) queue = [...route, ...queue];
  else if (queue.length) queue = [queue[0], ...route, ...queue.slice(1)];
  else {
    // The announced section moves to the queue, which goes before it.
    if (form[0] === ahead[0]) form = form.slice(1);
    queue = [ahead[0], ...route];
  }
  return { ...withForm({ ...pilot, queue }, form), handoff: { style, broke: pilot.section === "breakdown" } };
}

// A new style still on its way as `section` starts: a breakdown is the break it waits for.
const handedOn = (handoff, section) =>
  handoff ? { handoff: { ...handoff, broke: handoff.broke || section === "breakdown" } } : {};

// Whether a new style comes in as `section` starts: a peak, after a breakdown.
const lands = (handoff, section) => Boolean(handoff) && section === "peak" && handoff.broke;

/**
 * The style the section `slot` places after this one (in sequence()) plays:
 * the new one from the peak it lands on.
 */
export function styleAt(pilot, slot, playing) {
  const handoff = pilot.handoff;
  if (!handoff) return playing;
  let broke = handoff.broke;
  for (const section of sequence(pilot).slice(0, slot + 1)) {
    if (section === "peak" && broke) return handoff.style;
    broke ||= section === "breakdown";
  }
  return playing;
}

/** By hand: a drop on the next loop. The section ends there and a peak comes in after it. */
export function dropNext(pilot) {
  if (dropping(pilot)) return pilot;
  const queue = pilot.queue[0] === "peak" ? pilot.queue : ["peak", ...pilot.queue];
  return { ...pilot, left: 2, next: undefined, queue };
}

/**
 * This loop leads into a drop: the last of a build, or of anything going
 * into a peak. Only advance() sets `next`, so a section cut short by ⏭
 * moves on without one.
 */
export const dropping = (pilot) =>
  Boolean(pilot) &&
  pilot.left === 1 &&
  pilot.next !== undefined &&
  (pilot.next === "peak" || pilot.section === "build" || Boolean(pilot.opening));

/** This loop's number in its section (from 1) when it ends a phrase and is not a drop; else 0. */
export function phraseEnd(pilot) {
  if (!pilot || dropping(pilot)) return 0;
  const at = pilot.length - pilot.left + 1;
  return at % PHRASE_LOOPS === 0 ? at : 0;
}

/** Kick, bass or percussion with no lead and no pad. */
export function isBare(active) {
  const layers = Object.values(active).map(layerOfVariant);
  return layers.some((l) => BEAT.includes(l)) && !layers.some((l) => MELODIC.includes(l));
}

/** A bare mix with a lead or a pad added (as it is when both pools are empty). */
export function fillMelodic(active, lists, rng, style = STYLE_DEFAULT) {
  const open = MELODIC.filter((id) => poolOf(lists, id, style).length);
  if (!open.length) return active;
  const layer = layerById(pick(open, rng));
  const id = pick(poolOf(lists, layer.id, style), rng);
  return { ...active, [laneKey(layer, id)]: id };
}

/**
 * The next loop: { pilot, active, fx: [fx ids], rewrite: [variant ids] }.
 * `fx` fire on the boundary; `rewrite` are parts to write anew; `style`, a
 * new style that came in with this section (the pilot played it).
 */
export function advance(pilot, active, lists, rng, { style = STYLE_DEFAULT, changeBars = CHANGE_DEFAULT } = {}) {
  const queue = pilot.queue ?? [];
  const form = pilot.form ?? [];
  const hold = pilot.theme ?? [];
  const plan = pilot.plan ?? null;
  if (pilot.left > 1) {
    const left = pilot.left - 1;
    const done = pilot.length - left;
    let next = active;
    if (pilot.rearrange) next = arrange(pilot.section, active, lists, rng, style, hold);
    // An opening holds the bass it chose to fade in.
    else if ((done * 2) % changeBars === 0)
      next = vary(active, lists, rng, style, pilot.opening ? [...hold, ...playingOf(active, "bass")] : hold);
    const fx = [];
    let upcoming;
    if (left === 1) {
      upcoming = queue[0] ?? form[0] ?? plan?.section ?? nextOf(pilot.section, rng);
      if (upcoming === "peak" || pilot.section === "build" || pilot.opening) fx.push(pick(BUILD_FX, rng));
    }
    return {
      pilot: {
        section: pilot.section,
        left,
        length: pilot.length,
        queue,
        ...(form.length ? { form } : {}),
        ...(upcoming ? { next: upcoming } : {}),
        ...(pilot.theme ? { theme: pilot.theme } : {}),
        ...(plan ? { plan } : {}),
        ...(pilot.opening ? { opening: true } : {}),
        ...(pilot.handoff ? { handoff: pilot.handoff } : {}),
      },
      active: next,
      fx,
      rewrite: newLeads(active, next),
    };
  }
  const section = queue[0] ?? pilot.next ?? form[0] ?? plan?.section ?? nextOf(pilot.section, rng);
  const own = plan?.section === section ? plan : null; // a queued section beats the plan's
  // A new style lands with its own lead: the theme was the old style's.
  const landed = lands(pilot.handoff, section) ? pilot.handoff.style : null;
  const now = landed ?? style;
  const theme = landed ? [] : themeOf(pilot, section, active);
  const next = arrange(section, active, lists, rng, now, theme, own?.layers);
  const entryFx = { ...ENTRY_FX, ...STYLES[now]?.entryFx }[section];
  const entry = entryFx ? pick(entryFx, rng) : null;
  const rewrite = new Set(newLeads(active, next));
  const [layerId, chance] = REWRITE[section] ?? [];
  if (layerId && rng() < chance) {
    playingOf(next, layerId)
      .slice(0, 1)
      .filter((id) => !theme.includes(id))
      .forEach((id) => rewrite.add(id));
  }
  return {
    pilot: {
      ...fresh(
        section,
        own?.bars ? own.bars / 2 : lengthOf(section, rng),
        queue[0] ? queue.slice(1) : queue,
        !queue[0] && form[0] === section ? form.slice(1) : form,
      ),
      ...(theme.length ? { theme } : {}),
      ...(landed ? {} : handedOn(pilot.handoff, section)),
    },
    active: next,
    fx: entry ? [entry] : [],
    rewrite: [...rewrite].sort(),
    ...(landed ? { style: landed } : {}),
  };
}

// The theme: the lead a breakdown plays, held through the build after it
// and the peak after that. Each step it is held across, by where it starts.
export const THEME_PATH = { breakdown: "build", build: "peak" };

function themeOf(pilot, section, active) {
  if (THEME_PATH[pilot.section] !== section) return [];
  return pilot.section === "breakdown" ? playingOf(active, "lead") : (pilot.theme ?? []);
}

/** { variant id: volume } for every sound in `active`, as the pilot's current loop ends. */
export function mixOf(pilot, active) {
  const at = (pilot.length - pilot.left + 1) / pilot.length;
  const ids = [...new Set(Object.values(active))];
  const count = {};
  for (const id of ids) count[layerOfVariant(id)] = (count[layerOfVariant(id)] ?? 0) + 1;
  const out = {};
  for (const id of ids) {
    const layer = layerOfVariant(id);
    const [from, to, t] = span((pilot.opening ? OPENING_MIX : MIX[pilot.section])[layer] ?? 1, at);
    let level = (from + (to - from) * t) * count[layer] ** -STACK;
    if (layer === "pad" && count.lead) level *= DUCK;
    out[id] = Number(Math.min(LEVEL.max, Math.round(level / LEVEL.step) * LEVEL.step).toFixed(2));
  }
  return out;
}

// [from, to, how far between them] at `at` of the way: a spec's `start`
// holds `from` until then.
function span(spec, at) {
  const [from, to, start = 0] = range(spec);
  return [from, to, Math.max(0, (at - start) / (1 - start))];
}

// [from, to] at `at` of the way, in ratios (octaves).
const along = (spec, open, at) => {
  const [from, to, t] = span(spec ?? open, at);
  return Math.round(from * (to / from) ** t);
};

/** { variant id: { hp, lp } } for the sounds whose tone the pilot rides, as its current loop ends. */
export function toneOf(pilot, active) {
  const at = (pilot.length - pilot.left + 1) / pilot.length;
  const out = {};
  for (const id of new Set(Object.values(active))) {
    const layer = layerOfVariant(id);
    const tones = pilot.opening ? OPENING_TONE : TONE[pilot.section];
    if (!(pilot.opening ? Object.hasOwn(OPENING_TONE, layer) : TONE_LAYERS.includes(layer))) continue;
    const spec = tones[layer] ?? {};
    out[id] = { hp: along(spec.hp, HP_OPEN, at), lp: along(spec.lp, LP_OPEN, at) };
  }
  return out;
}
