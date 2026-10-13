import { describe, expect, it } from "vitest";
import { BORE, CANDIDATES, MAX_PITCH, TURN, WIDE, createFlight, freeAhead, reefAt, turnOf } from "./flight.js";

const FRAME = 1000 / 60;
const BEAT = 60000 / 145;
const VARS = [0.5, 0.5, 0.5, 0];

const frame = (time, extra = {}) => ({ time, bar: Math.floor(time / (4 * BEAT)), beatMs: BEAT, energy: 0.7, playing: true, layers: new Set(["kick", "bass"]), hits: [], ...extra });

// `ms` of a kick on every beat (or none, or a breakdown, or rest), with `push` thrown on each kick: the flight's steps.
function fly(flight, { ms = 20000, push = 1, mode = "kicks", vars = null } = {}) {
  const out = [];
  let thrown = 0;
  let next = 0;
  for (let t = 0; t < ms; t += FRAME) {
    const hits = [];
    if (mode === "kicks" && t >= next) {
      hits.push({ layer: "kick", time: t });
      thrown += push;
      next += BEAT;
    }
    const extra = mode === "kicks" ? { hits } : mode === "breakdown" ? { layers: new Set(["pad"]) } : { playing: false, layers: new Set() };
    out.push({ t, ...flight(frame(t, extra), (FRAME / 1000) * 1.2, thrown, vars) });
  }
  return out;
}

const angle = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

// Whether the reef reaches into the shader's cone: what it bores away.
function bites(step, vars) {
  for (let u = 0; u <= 1; u += 0.1) {
    const p = step.eye.map((v, i) => v + (step.reach[i] - v) * u);
    if (reefAt(p, vars) < BORE * (1 - u)) return true;
  }
  return false;
}

describe("turnOf", () => {
  it("turns TURN degrees off the heading first, WIDE after, never steeper than MAX_PITCH", () => {
    let dir = [0, 0, 1];
    for (let n = 0; n < 300; n++) {
      for (let k = 0; k < CANDIDATES; k++) {
        const [lo, hi] = k < CANDIDATES / 2 ? TURN : WIDE;
        const next = turnOf(dir, n, k);
        expect(Math.hypot(...next)).toBeCloseTo(1, 9);
        expect(angle(dir, next)).toBeGreaterThan(lo * 0.6);
        expect(angle(dir, next)).toBeLessThan(hi * 1.6);
        expect(Math.abs((Math.asin(next[1]) * 180) / Math.PI)).toBeLessThanOrEqual(MAX_PITCH + 1e-6);
      }
      dir = turnOf(dir, n);
    }
  });
});

describe("freeAhead", () => {
  it("stops where the reef comes within BORE", () => {
    const from = [0.3, 0.2, 0];
    const dir = [0, 0, 1];
    const free = freeAhead(from, dir, VARS, 3);
    if (free < 3) expect(reefAt([0.3, 0.2, free], VARS)).toBeLessThan(BORE);
    for (let t = 0; t < free - 0.01; t += 0.01) expect(reefAt([0.3, 0.2, t], VARS)).toBeGreaterThan(BORE * 0.4);
  });
});

describe("flight", () => {
  it("flies straight with no beat", () => {
    const end = fly(createFlight(), { mode: "rest" }).at(-1);
    expect(end.eye[0]).toBeCloseTo(0, 9);
    expect(end.eye[1]).toBeCloseTo(0, 9);
    expect(end.eye[2]).toBeGreaterThan(1);
  });

  it("turns on the kicks, and the eye follows", () => {
    const end = fly(createFlight(), { ms: 4000 }).at(-1);
    expect(angle(end.ahead, [0, 0, 1])).toBeGreaterThan(5);
  });

  it("turns on the bar lines when there is no kick", () => {
    const steps = fly(createFlight(), { ms: 3 * 4 * BEAT, mode: "breakdown" });
    const first = steps.find((s) => angle([0, 0, 1], s.ahead) > 0.5).t;
    expect(first).toBeGreaterThanOrEqual(4 * BEAT);
    expect(first).toBeLessThan(5 * BEAT);
  });

  it("flies straight with turns off, whatever plays", () => {
    const end = fly(createFlight({ turns: false }), { vars: VARS }).at(-1);
    expect(end.ahead).toEqual([0, 0, 1]);
  });

  it("steers through the reef's gaps, so the cone bores only as a last resort", () => {
    for (const vars of [VARS, [0.13, 0.7, 0.88, 0.2], [0.91, 0.2, 0.05, 0.6]]) {
      for (const push of [0.3, 1, 3]) {
        const steps = fly(createFlight(), { ms: 30000, push, vars }).filter((s) => s.t > 3000);
        expect(steps.filter((s) => bites(s, vars)).length).toBe(0);
      }
    }
  });

  it("dodges off the beat, in a breakdown and at rest", () => {
    for (const mode of ["breakdown", "rest"]) {
      const steered = fly(createFlight(), { ms: 30000, mode, vars: VARS }).filter((s) => s.t > 3000);
      const blind = fly(createFlight(), { ms: 30000, mode }).filter((s) => s.t > 3000);
      const share = (steps) => steps.filter((s) => bites(s, VARS)).length / steps.length;
      expect(share(steered)).toBeLessThan(0.05);
      expect(share(blind)).toBeGreaterThan(0.2);
    }
  });

  it("flies the same way every time", () => {
    const a = fly(createFlight(), { ms: 5000, vars: VARS }).at(-1);
    const b = fly(createFlight(), { ms: 5000, vars: VARS }).at(-1);
    expect(a.eye).toEqual(b.eye);
    expect(a.ahead).toEqual(b.ahead);
  });
});
