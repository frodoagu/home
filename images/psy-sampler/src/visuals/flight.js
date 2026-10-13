// The flight through the fractal reef (shaders.js CORAL): a tunnel bored
// BORE wide along a path of straight legs, and the eye flying down it. Each
// kick (each bar where there is none) turns the path: a new corner LEAD
// ahead of the eye, leaving TURN degrees off the heading, the way hashed
// from the turn's count. The tunnel past that corner swings to the new
// heading over BEND_BEATS, and has always finished before the eye gets
// there; the eye rounds each corner within ROUND of it, so the walls never
// come nearer than BORE - ROUND.

import { hash } from "./director.js";

export const BORE = 0.12; // shaders.js CORAL bores this far around the path
export const CORNERS = 6; // the newest corners, what the shader gets
export const ROUND = 0.05; // the eye cuts each corner this far before and after it
export const TURN = [10, 30]; // degrees off the heading, per turn
export const MAX_PITCH = 40; // degrees: the heading never climbs or dives steeper
const LEAD = 0.15; // a turn's corner, this far ahead of the eye
const LEG = 0.15; // the shortest leg between two corners: a kick sooner flies on
const BEND_BEATS = 0.4;
const LOOK_AHEAD = 0.3; // the eye looks down the path from this far on, so it turns on the beat
const LOOK_MS = 250;
const SPEED = [0.12, 0.1]; // per second of show time: at rest, and more at full energy
const THROWN = 0.12; // per unit of the motion's push

const RAD = Math.PI / 180;
const add = (a, b, k = 1) => a.map((v, i) => v + b[i] * k);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return a.map((v) => v / l);
};
const smooth = (k) => k * k * (3 - 2 * k);

/** The heading the `n`-th turn takes from `dir`: TURN degrees off it, never steeper than MAX_PITCH. */
export function turnOf(dir, n) {
  const angle = (TURN[0] + (TURN[1] - TURN[0]) * hash(`turn:${n}:a`)) * RAD;
  const way = hash(`turn:${n}:b`) * 2 * Math.PI;
  const pitch = Math.asin(Math.min(1, Math.max(-1, dir[1])));
  const yaw = Math.atan2(dir[0], dir[2]);
  let up = angle * Math.sin(way);
  if (Math.abs(pitch + up) > MAX_PITCH * RAD) up = -up;
  const p = pitch + up;
  const y = yaw + (angle * Math.cos(way)) / Math.cos(pitch);
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}

// From p to the segment a-b, or to the ray from a along d when b is null.
function apart(p, a, b, d) {
  const pa = add(p, a, -1);
  if (b === null) return Math.hypot(...add(pa, d, -Math.max(0, dot(pa, d))));
  const ba = add(b, a, -1);
  const h = Math.min(1, Math.max(0, dot(pa, ba) / Math.max(dot(ba, ba), 1e-6)));
  return Math.hypot(...add(pa, ba, -h));
}

/** How far `p` is from the path a step returned: the shader's flight(). */
export function distanceTo(p, { path, from, to, bend }) {
  const at = (i) => [path[i * 4], path[i * 4 + 1], path[i * 4 + 2]];
  let d = Infinity;
  for (let i = 0; i < CORNERS - 1; i++) d = Math.min(d, apart(p, at(i), at(i + 1)));
  const tip = at(CORNERS - 1);
  return Math.min(d, apart(p, tip, null, from) * (1 - bend) + apart(p, tip, null, to) * bend);
}

/**
 * step(frame, seconds, push) once per stage frame, with the show time it
 * advanced and the motion's push: { eye, ahead, path, from, to, bend }, the
 * uniforms the reef flies by. `turns: false` flies straight on.
 */
export function createFlight({ turns = true } = {}) {
  let corners = [{ at: [0, 0, -1], s: -1, dir: [0, 0, 1] }];
  let s = 0; // how far the eye has flown along the path
  let ahead = [0, 0, 1];
  let bend = null; // { from, time, ms, s0, s1 } while the tunnel swings
  let count = 0;
  let pushed = null;
  let bar = null;
  let at = null;

  const tip = () => corners[corners.length - 1];

  function eyeAt(x) {
    for (let j = corners.length - 1; j >= 0; j--) {
      const c = corners[j];
      if (j > 0 && Math.abs(x - c.s) < ROUND) {
        const a = add(c.at, corners[j - 1].dir, -ROUND);
        const b = add(c.at, c.dir, ROUND);
        const u = (x - c.s + ROUND) / (2 * ROUND);
        return a.map((v, i) => (1 - u) ** 2 * v + 2 * u * (1 - u) * c.at[i] + u * u * b[i]);
      }
      if (c.s <= x || j === 0) return add(c.at, c.dir, x - c.s);
    }
  }

  const dirAt = (x) => (corners.findLast((c) => c.s <= x) ?? corners[0]).dir;

  function turn(time, beatMs) {
    const last = tip();
    const cs = s + LEAD;
    corners = [...corners, { at: add(last.at, last.dir, cs - last.s), s: cs, dir: turnOf(last.dir, count++) }].slice(-CORNERS);
    bend = { from: last.dir, time, ms: BEND_BEATS * beatMs, s0: s, s1: cs - ROUND };
  }

  return function step(f, seconds, push) {
    const dt = at === null ? 0 : Math.min(100, Math.max(0, f.time - at));
    at = f.time;
    s += Math.max(0, seconds) * (SPEED[0] + SPEED[1] * f.energy) + THROWN * Math.max(0, push - (pushed ?? push));
    pushed = push;

    // The swing is done in its time, or by the time the eye reaches the corner, whichever comes first.
    let k = 1;
    if (bend) {
      k = Math.max((f.time - bend.time) / bend.ms, (s - bend.s0) / (bend.s1 - bend.s0));
      if (k >= 1) bend = null;
    }
    const barLine = bar !== null && f.bar !== bar;
    bar = f.bar;
    const kicked = f.hits.some((h) => h.layer === "kick");
    const room = s + LEAD >= tip().s + LEG;
    if (turns && !bend && room && f.playing && (kicked || (barLine && !f.layers.has("kick")))) {
      turn(f.time, f.beatMs);
      k = 0;
    }

    ahead = norm(add(ahead, add(dirAt(s + LOOK_AHEAD), ahead, -1), 1 - Math.exp(-dt / LOOK_MS)));
    const path = new Float32Array(CORNERS * 4);
    corners.forEach((c, i) => path.set(c.at, (CORNERS - corners.length + i) * 4));
    for (let i = 0; i < CORNERS - corners.length; i++) path.set(corners[0].at, i * 4);
    return {
      eye: eyeAt(s),
      ahead,
      path,
      from: bend ? bend.from : tip().dir,
      to: tip().dir,
      bend: smooth(Math.min(1, k)),
    };
  };
}
