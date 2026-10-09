// Everything the sampler remembers, as one plain object: what localStorage
// keeps between visits and what an exported preset carries. normalize() is
// the single gate both pass through, so a stale, hand-edited or foreign
// object always comes out playable.
import { LAYERS, LAYER_IDS, layerOfVariant } from "./catalog.js";
import { COPY_MARK, baseOf, isCopy, isVariant, sanitize } from "./audio/patterns.js";
import { BPM_DEFAULT, BPM_MAX, BPM_MIN } from "./audio/timing.js";
import { SECTIONS } from "./autopilot.js";
import { laneKey } from "./selection.js";
import { SNAP_MAX } from "./snapshots.js";
import { RAMP_BARS, RAMP_DEFAULT } from "./tempo.js";

export const PRESET_APP = "psy-sampler";
export const PRESET_VERSION = 1;
const NAME_MAX = 40;
export const SEED_MAX = 32;
export const SNAP_PANEL = "snap"; // the snapshots panel, sorted among the layers
const PANELS = [...LAYER_IDS, SNAP_PANEL];

export const cleanSeed = (s) => (typeof s === "string" ? s.trim().slice(0, SEED_MAX) : "");

export { layerOfVariant };

/**
 * {
 *   bpm, combine, bgKick, quantize, effects: { delay, reverb },
 *   seed:     the autopilot's seed ("" until the app draws one)
 *   rampBars: how many bars a BPM change takes
 *   order:    layer ids and SNAP_PANEL, top to bottom
 *   lists:    { layer: variant ids in tile order, factory + copies }
 *   names:    { variant: the name the user gave it }
 *   variants: { variant: edited data } (copies always have an entry)
 *   auto:     variants whose notes the autopilot wrote (it may rewrite them)
 *   snapshots: [{ id, name, section, active, data }] in tile order (snapshots.js)
 *   active:   { lane key: variant } (presets only: a page load starts silent)
 * }
 */
export function normalize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const bool = (v, def) => (typeof v === "boolean" ? v : def);

  const order = unique((Array.isArray(src.order) ? src.order : []).filter((id) => PANELS.includes(id)));
  for (const id of PANELS) if (!order.includes(id)) order.push(id);

  const lists = {};
  for (const layer of LAYERS) {
    const saved = Array.isArray(src.lists?.[layer.id]) ? src.lists[layer.id] : [];
    const list = unique(saved.filter((id) => isVariant(id) && layerOfVariant(id) === layer.id));
    for (const id of layer.variants) if (!list.includes(id)) list.push(id);
    lists[layer.id] = list;
  }
  const known = new Set(Object.values(lists).flat());

  const names = {};
  for (const [id, name] of Object.entries(src.names ?? {})) {
    const clean = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
    if (known.has(id) && clean) names[id] = clean;
  }
  const variants = {};
  for (const [id, data] of Object.entries(src.variants ?? {})) {
    if (known.has(id)) variants[id] = sanitize(id, data);
  }
  for (const id of known) if (isCopy(id) && !variants[id]) variants[id] = sanitize(id, null);

  const auto = unique((Array.isArray(src.auto) ? src.auto : []).filter((id) => id in variants));

  const active = cleanActive(src.active, known);
  const snapshots = [];
  for (const snap of Array.isArray(src.snapshots) ? src.snapshots : []) {
    const id = typeof snap?.id === "string" && /^snap-[1-9]\d{0,5}$/.test(snap.id) ? snap.id : null;
    const parts = cleanActive(snap?.active, known);
    if (!id || snapshots.some((s) => s.id === id) || !Object.keys(parts).length) continue;
    const name = typeof snap.name === "string" ? snap.name.trim().slice(0, NAME_MAX) : "";
    const data = {};
    for (const v of Object.values(parts)) data[v] = sanitize(v, snap.data?.[v]);
    const section = snap.section in SECTIONS ? snap.section : "groove";
    snapshots.push({ id, name: name || id, section, active: parts, data });
    if (snapshots.length === SNAP_MAX) break;
  }

  const bpm = Number.isFinite(src.bpm) ? Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, src.bpm))) : BPM_DEFAULT;
  return {
    bpm,
    combine: bool(src.combine, false),
    bgKick: bool(src.bgKick, true),
    quantize: bool(src.quantize, true),
    effects: { delay: bool(src.effects?.delay, true), reverb: bool(src.effects?.reverb, true) },
    rampBars: RAMP_BARS.includes(src.rampBars) ? src.rampBars : RAMP_DEFAULT,
    seed: cleanSeed(src.seed),
    order,
    lists,
    names,
    variants,
    auto,
    snapshots,
    active,
  };
}

// { lane key: variant } keeping only known loop variants on their own lane.
function cleanActive(raw, known) {
  const active = {};
  for (const [key, id] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const layer = LAYERS.find((l) => l.id === (typeof id === "string" && layerOfVariant(id)));
    if (layer && !layer.oneShot && known.has(id) && laneKey(layer, id) === key) active[key] = id;
  }
  return active;
}

export const toPreset = (ws) => ({ app: PRESET_APP, version: PRESET_VERSION, ...ws });

// A preset file's text -> workspace. Throws on anything that is not ours.
export function parsePreset(text) {
  const raw = JSON.parse(text);
  if (!raw || raw.app !== PRESET_APP) throw new Error("not a psy-sampler preset");
  return normalize(raw);
}

// First free "<base>~n" id for a copy of `id` (a copy of a copy shares the base).
export function copyId(id, taken) {
  const base = baseOf(id);
  let n = 1;
  while (taken.includes(`${base}${COPY_MARK}${n}`)) n++;
  return `${base}${COPY_MARK}${n}`;
}

// `list` with `item` moved to index `to` (clamped).
export function moveItem(list, item, to) {
  const rest = list.filter((x) => x !== item);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

function unique(list) {
  return [...new Set(list)];
}
