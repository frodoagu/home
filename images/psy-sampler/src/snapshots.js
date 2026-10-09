// Snapshots: a moment of the track saved as a scene. Each one freezes the
// selection that was sounding AND the data its variants played then, so
// recalling it later sounds the same even after the sounds were edited. It
// also carries the section it belongs to (intro, break…), which the autopilot
// jumps to when a snapshot is recalled while it runs. Pure: the UI owns the
// list (ws.snapshots) and the unsaved drafts.
//
//   { id: "snap-3", name, section, active: { lane key: variant }, data: { variant: data } }
import { LAYERS, layerById, layerOfVariant } from "./catalog.js";
import { BG_KICK_VARIANT, laneKey } from "./selection.js";

export const SNAP_MAX = 64;

/**
 * What sounds, as a snapshot's parts. `lanes` are the engine's lanes: the
 * background kick becomes the kick it is, so the snapshot plays the same
 * whatever the "Kick de fondo" switch says later.
 */
export function capture(lanes, dataOf) {
  const active = {};
  for (const [key, id] of Object.entries(lanes)) {
    if (key === "bgKick") active.kick = BG_KICK_VARIANT;
    else active[key] = id;
  }
  const data = {};
  for (const id of Object.values(active)) data[id] = structuredClone(dataOf(id));
  return { active, data };
}

export const nextSnapId = (list) => `snap-${1 + Math.max(0, ...list.map((s) => Number(s.id.slice(5)) || 0))}`;

// "Pico", then "Pico 2", "Pico 3"… among the names already taken.
export function freshName(base, taken) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** `snap` with `id` playing `data`; on an exclusive layer it replaces the variant there. */
export function addPart(snap, id, data) {
  const key = laneKey(layerById(layerOfVariant(id)), id);
  const { [snap.active[key]]: _gone, ...rest } = snap.data;
  return { ...snap, active: { ...snap.active, [key]: id }, data: { ...rest, [id]: structuredClone(data) } };
}

export function removePart(snap, id) {
  const active = Object.fromEntries(Object.entries(snap.active).filter(([, v]) => v !== id));
  const { [id]: _gone, ...data } = snap.data;
  return { ...snap, active, data };
}

/** The variants a snapshot plays, in layer order. */
export function partsOf(snap) {
  const rank = (id) => LAYERS.findIndex((l) => l.id === layerOfVariant(id));
  return Object.values(snap.active).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const fields = ({ name, section, active, data }) => JSON.stringify([name, section, active, data]);
export const sameSnapshot = (a, b) => fields(a) === fields(b);
