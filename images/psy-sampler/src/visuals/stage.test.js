import { describe, expect, it } from "vitest";
import { createStage, energyOf, layersOf } from "./stage.js";

const BEAT = 60000 / 150;

describe("stage", () => {
  it("keeps an event until its time comes", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "hit", layer: "kick", time: 100 });
    expect(stage.frame(50).env.kick).toBe(0);
    expect(stage.frame(100).env.kick).toBe(1);
  });

  it("decays each layer's envelope in beats, faster for the hats than the pads", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 0, bar: 0, bpm: 150 });
    stage.push({ kind: "hit", layer: "perc", time: 0 });
    stage.push({ kind: "hit", layer: "pad", time: 0 });
    const s = stage.frame(BEAT / 4);
    expect(s.env.perc).toBeLessThan(0.1);
    expect(s.env.pad).toBeGreaterThan(0.8);
  });

  it("counts beats and bars from the latest bar line, at its tempo", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 1000, bar: 3, bpm: 150 });
    const s = stage.frame(1000 + BEAT * 1.5);
    expect(s.beats).toBeCloseTo(13.5);
    expect(s.bar).toBe(3);
    expect(s.beat).toBeCloseTo(0.5);
    expect(s.barPhase).toBeCloseTo(1.5 / 4);
    expect(s.bpm).toBe(150);
  });

  it("applies events out of order by their time", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "lanes", time: 200, variants: ["pad.x"] });
    stage.push({ kind: "lanes", time: 100, variants: ["kick.a", "bass.b"] });
    expect([...stage.frame(150).layers]).toEqual(["kick", "bass"]);
    expect([...stage.frame(250).layers]).toEqual(["pad"]);
  });

  it("rises through a build, and the drop clears it and starts the count after it", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 0, bar: 0, bpm: 150 });
    stage.push({ kind: "build", time: 0, end: 1000 });
    expect(stage.frame(500).build).toBeCloseTo(0.5);
    stage.push({ kind: "drop", time: 1000 });
    const s = stage.frame(1000 + BEAT * 2);
    expect(s.build).toBe(0);
    expect(s.sinceDrop).toBeCloseTo(2);
    expect(s.drops).toBe(1);
  });

  it("goes wild through a set's frenzy, until it ends or the loop stops", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "frenzy", time: 1000, end: 3000 });
    expect(stage.frame(500).frenzy).toBe(0);
    expect(stage.frame(1000).frenzy).toBeGreaterThan(0);
    expect(stage.frame(2000).frenzy).toBeCloseTo(0.5, 5);
    expect(stage.frame(3000).frenzy).toBe(0);
    stage.push({ kind: "frenzy", time: 4000, end: 9000 });
    stage.push({ kind: "stop", time: 5000 });
    expect(stage.frame(4500).frenzy).toBeGreaterThan(0);
    expect(stage.frame(5000).frenzy).toBe(0);
  });

  it("slows with a vinyl brake, through the loop's stop, until the brake ends", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "brake", time: 1000, end: 2000 });
    stage.push({ kind: "stop", time: 1500 }); // the loop stops before the tail is out
    expect(stage.frame(900).brake).toBe(0);
    expect(stage.frame(1250).brake).toBeCloseTo(0.25, 5);
    expect(stage.frame(1750).brake).toBeCloseTo(0.75, 5);
    expect(stage.frame(2000).brake).toBe(0);
  });

  it("stops playing on a stop, and its energy falls back", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "lanes", time: 0, variants: ["kick.a", "bass.b", "perc.c", "lead.d"] });
    stage.push({ kind: "hit", layer: "kick", time: 0 });
    let s;
    for (let t = 0; t <= 10000; t += 16) s = stage.frame(t);
    expect(s.playing).toBe(true);
    const busy = s.energy;
    stage.push({ kind: "stop", time: 10000 });
    for (let t = 10000; t <= 20000; t += 16) s = stage.frame(t);
    expect(s.playing).toBe(false);
    expect(s.energy).toBeLessThan(busy - 0.3);
  });
});

describe("energyOf", () => {
  it("grows with the layers playing", () => {
    expect(energyOf(layersOf(["pad.a"]))).toBeLessThan(energyOf(layersOf(["kick.a", "bass.b"])));
    expect(energyOf(layersOf(["kick.a~2", "bass.b", "perc.c", "lead.d", "glitch.e"]), 1)).toBe(1);
  });
});

describe("rest", () => {
  it("keeps time on rest bars without counting them as music", () => {
    const stage = createStage({ now: 0 });
    stage.push({ kind: "bar", time: 0, bar: 2, bpm: 150, rest: true });
    const s = stage.frame(BEAT);
    expect(s.playing).toBe(false);
    expect(s.beats).toBeCloseTo(9);
  });
});
