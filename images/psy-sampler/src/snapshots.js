// Snapshots: a moment of the track saved as a scene. Each one freezes the
// selection that was sounding AND the data its variants played then, so
// recalling it later sounds the same even after the sounds were edited. It
// also carries the section it belongs to (intro, break…), which the autopilot
// jumps to when a snapshot is recalled while it runs. Pure: the UI owns the
// list (ws.snapshots) and the unsaved drafts.
//
//   { id: "snap-3", name, section, active: { lane key: variant }, data: { variant: data } }
//
// The snapshot autopilot (a "tour") plays them one after another, in the
// panel's order and round again, with no rng: the same list plays the same
// way every time.
//
//   { id: playing snapshot, at: its index then, bars: bar lines since it came in
//     (null until the first one), phase, skip?: ⏭ asked to move on }
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

/* ---- the snapshot autopilot ---- */

/** A tour playing `id`: it starts counting on the bar line `step` (0 or 16), or on the next one when null. */
export function startTour(list, id, step = null) {
  const tour = { id, at: list.findIndex((s) => s.id === id), bars: null, phase: 0 };
  return step === null ? tour : countBar(tour, step);
}

// `phase` makes (bars + phase) even on a loop start (step 0), wherever the
// snapshot came in: a click enters on any bar line, the tour only moves on
// a loop start.
export function countBar(tour, step) {
  const bars = tour.bars === null ? 0 : tour.bars + 1;
  return { ...tour, bars, phase: (bars + (step ? 1 : 0)) % 2 };
}

export const skipTour = (tour) => ({ ...tour, skip: true });

/** It moves on at this bar line: a loop start once it played `changeBars` bars, or after ⏭. */
export const tourDue = (tour, step, changeBars) =>
  step === 0 && tour.bars > 0 && (tour.skip || tour.bars >= changeBars);

/** Bars from the last bar line to the one where it moves on. */
export function tourLeft(tour, changeBars) {
  if (tour.bars === null) return changeBars;
  let end = Math.max(tour.skip ? 1 : changeBars, tour.bars + 1);
  if ((end + tour.phase) % 2) end++;
  return end - tour.bars;
}

/**
 * The snapshot after the tour's, in panel order and round again. When that
 * one is gone, the one that took its place; null with none left.
 */
export function nextSnapshot(list, { id, at }) {
  if (!list.length) return null;
  const i = list.findIndex((s) => s.id === id);
  return list[i >= 0 ? (i + 1) % list.length : Math.max(0, at) % list.length];
}
