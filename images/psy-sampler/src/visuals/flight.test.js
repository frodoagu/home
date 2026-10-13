import { describe, expect, it } from "vitest";
import { BORE, MAX_PITCH, ROUND, TURN, createFlight, distanceTo, turnOf } from "./flight.js";

const FRAME = 1000 / 60;
const BEAT = 60000 / 145;

const frame = (time, extra = {}) => ({ time, bar: Math.floor(time / (4 * BEAT)), beatMs: BEAT, energy: 0.7, playing: true, layers: new Set(["kick", "bass"]), hits: [], ...extra });

// A kick on every beat for `ms`, with `push` thrown on each: the flight's steps.
function fly(flight, { ms = 20000, push = 1, kicks = true, from = 0 } = {}) {
  const out = [];
  let thrown = 0;
  let next = from;
  for (let t = from; t < from + ms; t += FRAME) {
    const hits = [];
    if (kicks && t >= next) {
      hits.push({ layer: "kick", time: t });
      thrown += push;
      next += BEAT;
    }
    out.push(flight(frame(t, { hits }), (FRAME / 1000) * 1.2, thrown));
  }
  return out;
}

const angle = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

describe("turnOf", () => {
  it("turns TURN degrees off the heading, never steeper than MAX_PITCH", () => {
    let dir = [0, 0, 1];
    for (let n = 0; n < 500; n++) {
      const next = turnOf(dir, n);
      expect(Math.hypot(...next)).toBeCloseTo(1, 9);
      expect(angle(dir, next)).toBeGreaterThan(TURN[0] * 0.6);
      expect(angle(dir, next)).toBeLessThan(TURN[1] * 1.6);
      expect(Math.abs((Math.asin(next[1]) * 180) / Math.PI)).toBeLessThanOrEqual(MAX_PITCH + 1e-6);
      dir = next;
    }
  });
});

describe("flight", () => {
  it("flies straight with no beat", () => {
    const steps = fly(createFlight(), { kicks: false });
    expect(steps.at(-1).eye[0]).toBeCloseTo(0, 9);
    expect(steps.at(-1).eye[1]).toBeCloseTo(0, 9);
    expect(steps.at(-1).eye[2]).toBeGreaterThan(1);
  });

  it("turns on the kicks, and the eye follows", () => {
    const steps = fly(createFlight(), { ms: 4000 });
    const to = steps.at(-1).to;
    expect(angle([0, 0, 1], to)).toBeGreaterThan(TURN[0]);
    expect(angle(steps.at(-1).ahead, [0, 0, 1])).toBeGreaterThan(5);
  });

  it("turns on the bar lines when there is no kick", () => {
    const flight = createFlight();
    let first = null;
    for (let t = 0; t < 3 * 4 * BEAT; t += FRAME) {
      const f = flight(frame(t, { layers: new Set(["pad"]) }), FRAME / 1000, 0);
      if (!first && angle([0, 0, 1], f.to) > 1) first = t;
    }
    expect(first).toBeGreaterThanOrEqual(4 * BEAT);
    expect(first).toBeLessThan(4 * BEAT + 2 * FRAME);
  });

  it("goes straight at rest and with turns off", () => {
    const rest = createFlight();
    const off = createFlight({ turns: false });
    for (let t = 0; t < 8000; t += FRAME) {
      const hits = [{ layer: "kick", time: t }];
      expect(rest(frame(t, { hits, playing: false }), 0.02, t / 500).to).toEqual([0, 0, 1]);
      expect(off(frame(t, { hits }), 0.02, t / 500).to).toEqual([0, 0, 1]);
    }
  });

  it("never brings the eye near the walls, however fast it flies", () => {
    for (const push of [0, 0.5, 1, 3, 10]) {
      for (const step of fly(createFlight(), { ms: 30000, push })) {
        expect(distanceTo(step.eye, step)).toBeLessThanOrEqual(ROUND + 1e-6);
        expect(BORE - distanceTo(step.eye, step)).toBeGreaterThan(0.06);
      }
    }
  });

  it("flies the same way every time", () => {
    const a = fly(createFlight(), { ms: 5000 }).at(-1);
    const b = fly(createFlight(), { ms: 5000 }).at(-1);
    expect(a.eye).toEqual(b.eye);
    expect(a.to).toEqual(b.to);
  });
});
