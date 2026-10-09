// Autopilot: an arranger that walks the sections of a psytrance track and
// decides, on every loop boundary (2 bars), which variants play. Pure: the UI
// calls it from the engine's bar hook and applies the result on that bar line.
//
//   intro -> groove -> build -> peak -> breakdown | groove -> build -> ...
//
// Each section has a shape (how many variants per layer). Changes favour
// continuity: a playing variant usually survives a section change, and inside
// a section only one small swap happens now and then. The build's last loop
// fires a 2-bar riser so it lands on the peak; entering a section can fire an
// FX and ask for a part to be rewritten (a new lead or bass line).
//
// Every choice comes from `rng`, so a seeded rng replays the same track:
// pools are read in id order (never in the user's tile order) and a run
// always starts from silence.
import { LAYERS } from "./catalog.js";
import { laneKey } from "./selection.js";
import { layerOfVariant } from "./workspace.js";

export const SECTIONS = {
  intro: { loops: 2, next: ["groove"], shape: { kick: 1, bass: 0, perc: [1, 1], lead: 0, pad: 0 } },
  groove: { loops: 4, next: ["build"], shape: { kick: 1, bass: 1, perc: [1, 2], lead: 0, pad: 0 } },
  build: { loops: 2, next: ["peak"], shape: { kick: 1, bass: 1, perc: [2, 2], lead: 1, pad: 0 } },
  peak: { loops: 4, next: ["breakdown", "groove"], shape: { kick: 1, bass: 1, perc: [2, 3], lead: 1, pad: 1 } },
  breakdown: { loops: 2, next: ["build"], shape: { kick: 0, bass: 0, perc: [0, 1], lead: 1, pad: 1 } },
};

const ENTRY_FX = { peak: ["fx.crash", "fx.impact"], breakdown: ["fx.down"], groove: [null, null, "fx.zap", "fx.siren"] };
const BUILD_FX = ["fx.riser", "fx.riserImpact"];
const REWRITE = { build: ["lead", 0.5], breakdown: ["lead", 0.6], groove: ["bass", 0.25] };
const KEEP = 0.75; // a playing variant survives a section change
const VARY = 0.3; // one swap on a loop inside a section

const LOOP_LAYERS = LAYERS.filter((l) => !l.oneShot);
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const playingOf = (active, layerId) =>
  Object.values(active)
    .filter((id) => layerOfVariant(id) === layerId)
    .sort();
const poolOf = (lists, layerId) => [...lists[layerId]].sort();

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The variants a section plays, built from what plays now. */
export function arrange(section, active, lists, rng) {
  const out = {};
  for (const layer of LOOP_LAYERS) {
    const spec = SECTIONS[section].shape[layer.id];
    const want = Array.isArray(spec) ? spec[0] + Math.floor(rng() * (spec[1] - spec[0] + 1)) : spec;
    const playing = playingOf(active, layer.id);
    const kept = shuffle(playing, rng).filter(() => rng() < KEEP);
    const fresh = shuffle(poolOf(lists, layer.id).filter((id) => !playing.includes(id)), rng);
    const chosen = [...kept, ...fresh, ...playing.filter((id) => !kept.includes(id))].slice(0, want);
    for (const id of chosen) out[laneKey(layer, id)] = id;
  }
  return out;
}

// One swap: a playing variant (never the kick) for one of its layer's others.
function vary(active, lists, rng) {
  const layers = LOOP_LAYERS.filter((l) => l.id !== "kick" && playingOf(active, l.id).length);
  if (!layers.length) return active;
  const layer = pick(layers, rng);
  const playing = playingOf(active, layer.id);
  const pool = poolOf(lists, layer.id).filter((id) => !playing.includes(id));
  if (!pool.length) return active;
  const out = pick(playing, rng);
  const next = { ...active };
  delete next[laneKey(layer, out)];
  const id = pick(pool, rng);
  next[laneKey(layer, id)] = id;
  return next;
}

/** Engaging: an intro, from silence. */
export function startPilot(lists, rng) {
  return { pilot: { section: "intro", left: SECTIONS.intro.loops }, active: arrange("intro", {}, lists, rng) };
}

/**
 * The next loop: { pilot, active, fx: [fx ids], rewrite: [variant ids] }.
 * `fx` fire on the boundary; `rewrite` are parts to improvise anew.
 */
export function advance(pilot, active, lists, rng) {
  if (pilot.left > 1) {
    const left = pilot.left - 1;
    const fx = pilot.section === "build" && left === 1 ? [pick(BUILD_FX, rng)] : [];
    const next = rng() < VARY ? vary(active, lists, rng) : active;
    return { pilot: { section: pilot.section, left }, active: next, fx, rewrite: [] };
  }
  const section = pick(SECTIONS[pilot.section].next, rng);
  const next = arrange(section, active, lists, rng);
  const entry = ENTRY_FX[section] ? pick(ENTRY_FX[section], rng) : null;
  const rewrite = [];
  const [layerId, chance] = REWRITE[section] ?? [];
  if (layerId && rng() < chance) rewrite.push(...playingOf(next, layerId).slice(0, 1));
  return {
    pilot: { section, left: SECTIONS[section].loops },
    active: next,
    fx: entry ? [entry] : [],
    rewrite,
  };
}
