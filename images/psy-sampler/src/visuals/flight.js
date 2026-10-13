// The flight through the fractal reef (shaders.js CORAL): a path of straight
// legs and the eye flying down it, rounding each corner within ROUND of it.
// Each kick (each bar where there is none) turns the path at a new corner
// LEAD ahead of the eye: TURN degrees off the heading, the way hashed from
// the turn's count, trying CANDIDATES such ways in order and taking the
// first with OPEN free ahead (else the freest). The reef is the shader's,
// measured here with reefAt(), so the eye steers through its gaps; when the
// way ahead closes in to DANGER before a beat turns it, it turns off the
// beat, and so it climbs out of the shell when it comes in inside it. Only what still comes within reach is bored away by the shader's
// cone, BORE wide at the eye and narrowing to a point REACH ahead: a last
// resort, never a tunnel opened in the distance.

import { hash } from "./director.js";

export const BORE = 0.1; // the cone the shader bores, this wide at the eye
export const REACH = 0.3; // and this far ahead
export const ROUND = 0.05; // the eye cuts each corner this far before and after it
export const TURN = [10, 30]; // degrees off the heading, per turn on the beat
export const WIDE = [30, 70]; // the later candidates, when the near ways are shut
export const MAX_PITCH = 40; // degrees: the heading never climbs or dives steeper
export const CANDIDATES = 12; // half of them TURN, half WIDE
export const OPEN = 1; // free ahead, enough to take a way at once
export const DANGER = 0.3; // free ahead, below which the flight turns off the beat
const MARGIN = BORE; // how near the reef counts as hitting it
const LEAD = 0.15; // a turn's corner, this far ahead of the eye
const LEG = 0.15; // the shortest leg between two corners: a kick sooner flies on
const LOOK_AHEAD = 0.3; // the eye looks down the path from this far on, so it turns on the beat
const LOOK_MS = 250;
const SPEED = [0.12, 0.1]; // per second of show time: at rest, and more at full energy
const THROWN = 0.12; // per unit of the motion's push
const CORNERS = 4;

const RAD = Math.PI / 180;
const add = (a, b, k = 1) => a.map((v, i) => v + b[i] * k);
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return a.map((v) => v / l);
};

/**
 * The reef's distance estimate at `p` for a coral look's `vars`: shaders.js
 * CORAL's reef() before the bore. Keep the two in step.
 */
export function reefAt(p, vars) {
  const C = [0.92436 + 0.06 * (vars[0] - 0.5), 0.90756, 0.92436 + 0.05 * (vars[2] - 0.5)];
  let q = p.map((v, i) => {
    const m = 4 * C[i];
    return ((((v + 2 * C[i]) % m) + m) % m) - 2 * C[i];
  });
  let k = 1;
  for (let i = 0; i < 8; i++) {
    q = q.map((v, j) => 2 * Math.min(C[j], Math.max(-C[j], v)) - v);
    const s = Math.max(1 / (q[0] ** 2 + q[1] ** 2 + q[2] ** 2), 1);
    q = q.map((v) => v * s);
    k *= s;
  }
  const rxy = Math.hypot(q[0], q[1]);
  return (0.5 * Math.max(rxy - 0.92784, Math.abs(rxy * q[2]) / Math.hypot(...q))) / k;
}

/** How far from `from` along `dir` the reef stays MARGIN away, up to `max`. */
export function freeAhead(from, dir, vars, max = 2 * OPEN) {
  let t = 0;
  for (let i = 0; i < 64 && t < max; i++) {
    const d = reefAt(add(from, dir, t), vars);
    if (d < MARGIN) return t;
    t += Math.max(d - MARGIN / 2, 0.005);
  }
  return Math.min(t, max);
}

/** The `k`-th way the `n`-th turn may take from `dir`, never steeper than MAX_PITCH. */
export function turnOf(dir, n, k = 0) {
  const [lo, hi] = k < CANDIDATES / 2 ? TURN : WIDE;
  const angle = (lo + (hi - lo) * hash(`turn:${n}:${k}:a`)) * RAD;
  const way = hash(`turn:${n}:${k}:b`) * 2 * Math.PI;
  const pitch = Math.asin(Math.min(1, Math.max(-1, dir[1])));
  const yaw = Math.atan2(dir[0], dir[2]);
  let up = angle * Math.sin(way);
  if (Math.abs(pitch + up) > MAX_PITCH * RAD) up = -up;
  const p = Math.max(-MAX_PITCH * RAD, Math.min(MAX_PITCH * RAD, pitch + up));
  const y = yaw + (angle * Math.cos(way)) / Math.cos(pitch);
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}

/**
 * step(frame, seconds, push, vars) once per stage frame, with the show time
 * it advanced, the motion's push and the coral look's vars (null while the
 * reef is off screen: nothing to steer by). Returns { eye, ahead, reach },
 * the uniforms the reef flies by. `turns: false` flies straight on.
 */
export function createFlight({ turns = true } = {}) {
  let corners = [{ at: [0, 0, -1], s: -1, dir: [0, 0, 1] }];
  let s = 0; // how far the eye has flown along the path
  let ahead = [0, 0, 1];
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

  function turn(vars) {
    const last = tip();
    const cs = s + LEAD;
    const corner = add(last.at, last.dir, cs - last.s);
    let dir = turnOf(last.dir, count, 0);
    if (vars) {
      // Shut every way (the eye in the reef's shell): the one the reef falls away from.
      const score = (way) => freeAhead(corner, way, vars) || reefAt(add(corner, way, LEG), vars) / MARGIN - 1;
      let best = -Infinity;
      for (let k = 0; k < CANDIDATES; k++) {
        const way = turnOf(last.dir, count, k);
        const free = score(way);
        if (free > best) [best, dir] = [free, way];
        if (free >= OPEN) break;
      }
    }
    count++;
    corners = [...corners, { at: corner, s: cs, dir }].slice(-CORNERS);
  }

  return function step(f, seconds, push, vars = null) {
    const dt = at === null ? 0 : Math.min(100, Math.max(0, f.time - at));
    at = f.time;
    s += Math.max(0, seconds) * (SPEED[0] + SPEED[1] * f.energy) + THROWN * Math.max(0, push - (pushed ?? push));
    pushed = push;

    const barLine = bar !== null && f.bar !== bar;
    bar = f.bar;
    const room = s + LEAD >= tip().s + LEG;
    const beat = f.playing && (f.hits.some((h) => h.layer === "kick") || (barLine && !f.layers.has("kick")));
    // Off the beat only to dodge.
    const dodge = () => freeAhead(s < tip().s ? tip().at : eyeAt(s), tip().dir, vars, DANGER) < DANGER;
    if (turns && room && (beat || (vars && dodge()))) turn(vars);

    ahead = norm(add(ahead, add(dirAt(s + LOOK_AHEAD), ahead, -1), 1 - Math.exp(-dt / LOOK_MS)));
    return { eye: eyeAt(s), ahead, reach: eyeAt(s + REACH) };
  };
}
