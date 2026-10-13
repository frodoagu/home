import { describe, expect, it } from "vitest";
import { SHAKE_MAX, createMotion, throwOf } from "./motion.js";
import { createStage } from "./stage.js";

const BEAT = 60000 / 150;
const FRAME = 1000 / 60;

// Runs `motion` over a stage from `from` to `to` ms, frame by frame.
function run(stage, motion, from, to) {
  const out = [];
  for (let t = from; t <= to; t += FRAME) out.push({ t, ...motion(stage.frame(t)) });
  return out;
}

function kicked({ accent = false, low = 0.5, drop = false } = {}) {
  const stage = createStage({ now: 0 });
  stage.push({ kind: "bar", time: 0, bar: 0, bpm: 150 });
  stage.push({ kind: "levels", low, mid: 0, high: 0 });
  if (drop) stage.push({ kind: "drop", time: 100 });
  stage.push({ kind: "hit", layer: "kick", time: 100, accent });
  return stage;
}

describe("motion", () => {
  it("stays put with nothing hitting", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 0, bar: 0, bpm: 150, rest: true });
    const frames = run(stage, createMotion(), 0, 3000);
    expect(frames.every((f) => f.push === 0 && f.surge === 0)).toBe(true);
  });

  it("throws the picture forward on a kick, never back", () => {
    const frames = run(kicked(), createMotion(), 0, 3000);
    for (let i = 1; i < frames.length; i++) expect(frames[i].push).toBeGreaterThanOrEqual(frames[i - 1].push);
    expect(frames.at(-1).push).toBeGreaterThan(0.5);
  });

  it("eases in: no frame jumps, even on the hit", () => {
    const frames = run(kicked({ accent: true, low: 1 }), createMotion(), 0, 3000);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].push - frames[i - 1].push).toBeLessThan(0.06);
      expect(Math.abs(frames[i].surge - frames[i - 1].surge)).toBeLessThan(0.5);
    }
  });

  it("brakes by friction once the beat is over", () => {
    const frames = run(kicked(), createMotion(), 0, 3000);
    const peak = Math.max(...frames.map((f) => f.surge));
    const at = (t) => frames.find((f) => f.t >= t);
    expect(at(1600).surge).toBeLessThan(peak * 0.05);
    // One kick travels about its throw, almost all of it within a second.
    const total = frames.at(-1).push;
    expect(at(1100).push).toBeGreaterThan(total * 0.9);
  });

  it("throws further the deeper the beat", () => {
    const soft = run(kicked({ low: 0.1 }), createMotion(), 0, 3000).at(-1).push;
    const deep = run(kicked({ low: 0.9 }), createMotion(), 0, 3000).at(-1).push;
    const accent = run(kicked({ low: 0.9, accent: true }), createMotion(), 0, 3000).at(-1).push;
    expect(deep).toBeGreaterThan(soft * 1.5);
    expect(accent).toBeGreaterThan(deep);
    const s = createStage({ now: 0 }).frame(0);
    expect(throwOf("bass", s)).toBeLessThan(throwOf("kick", s));
  });

  it("adds up kick after kick: a steady beat keeps it moving", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 0, bar: 0, bpm: 150 });
    for (let b = 0; b < 16; b++) stage.push({ kind: "hit", layer: "kick", time: b * BEAT });
    const frames = run(stage, createMotion(), 0, 16 * BEAT);
    const late = frames.filter((f) => f.t > 8 * BEAT);
    expect(Math.min(...late.map((f) => f.surge))).toBeGreaterThan(0.1);
  });

  it("shakes on a drop's kick, barely on any other, and settles", () => {
    const max = (frames) => Math.max(...frames.map((f) => Math.hypot(f.shake[0], f.shake[1])));
    const drop = run(kicked({ drop: true }), createMotion(), 0, 3000);
    const plain = run(kicked(), createMotion(), 0, 3000);
    expect(max(drop)).toBeGreaterThan(SHAKE_MAX * 0.3);
    expect(max(drop)).toBeLessThanOrEqual(SHAKE_MAX * 1.01);
    expect(max(plain)).toBeLessThan(max(drop) * 0.2);
    expect(max(drop.slice(-30))).toBeLessThan(SHAKE_MAX * 0.01);
    for (let i = 1; i < drop.length; i++) {
      expect(Math.abs(drop[i].shake[0] - drop[i - 1].shake[0])).toBeLessThan(SHAKE_MAX * 0.6);
    }
  });

  it("does not shake when told not to (reduced motion)", () => {
    const frames = run(kicked({ drop: true }), createMotion({ shake: false }), 0, 3000);
    expect(frames.every((f) => f.shake.every((v) => v === 0))).toBe(true);
    expect(frames.at(-1).push).toBeGreaterThan(0);
  });
});
