import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { createEngine } from "./engine.js";
import { stepDuration, TICK_MS } from "./timing.js";

let ctx;
let createContext;
let engine;

beforeEach(() => {
  vi.useFakeTimers();
  ctx = new FakeAudioContext();
  createContext = vi.fn(() => ctx);
  engine = createEngine({ createContext });
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
});

// Advance the audio clock and the scheduler timer together.
function run(seconds) {
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  for (let i = 0; i < ticks; i++) {
    ctx.currentTime += TICK_MS / 1000;
    vi.advanceTimersByTime(TICK_MS);
  }
}

// Lane gains are the ones wired straight into the master gain.
function laneGains() {
  const comp = ctx.nodes.find((n) => n.kind === "compressor");
  const master = ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0] === comp);
  return ctx.nodes.filter((n) => n.kind === "gain" && n.outputs[0] === master);
}
const startTimes = (kind) =>
  ctx
    .sources()
    .filter((s) => s.kind === kind)
    .map((s) => s.startTime)
    .sort((a, b) => a - b);

describe("context lifecycle", () => {
  it("creates no AudioContext until something is played", () => {
    expect(createContext).not.toHaveBeenCalled();
    engine.setLanes({});
    expect(createContext).not.toHaveBeenCalled();
    expect(engine.isRunning()).toBe(false);
  });

  it("builds master gain -> compressor -> destination once, and resumes a suspended context", () => {
    ctx.state = "suspended";
    const resume = vi.spyOn(ctx, "resume");
    engine.setLanes({ bass: "bass.offbeat" });
    engine.setLanes({ bass: "bass.rolling" });
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalled();
    const comp = ctx.nodes.find((n) => n.kind === "compressor");
    const master = ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0] === comp);
    expect(master.gain.value).toBe(0.7);
    expect(comp.outputs[0]).toBe(ctx.destination);
  });
});

describe("scheduler", () => {
  it("never schedules further ahead than the lookahead", () => {
    engine.setLanes({ perc: "perc.shaker" });
    for (let i = 0; i < 40; i++) {
      run(0.025);
      expect(Math.max(...startTimes("buffer"))).toBeLessThan(ctx.currentTime + 0.12 + 1e-9);
    }
  });

  it("plays the offbeat bass on steps 2, 6, 10... of the grid", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(1.5);
    const step = stepDuration(145);
    const times = startTimes("oscillator");
    const t0 = 0.06; // START_DELAY: step 0
    expect(times.length).toBeGreaterThan(2);
    times.forEach((t, i) => expect(t).toBeCloseTo(t0 + (2 + 4 * i) * step, 9));
  });

  it("applies a BPM change live without gaps, overlaps or grid shifts", () => {
    engine.setLanes({ perc: "perc.shaker" }); // one hit per step = the grid itself
    run(0.6);
    engine.setBpm(180);
    run(0.6);
    const times = startTimes("buffer");
    const diffs = times.slice(1).map((t, i) => t - times[i]);
    const slow = stepDuration(145);
    const fast = stepDuration(180);
    const switchAt = diffs.findIndex((d) => Math.abs(d - fast) < 1e-9);
    expect(switchAt).toBeGreaterThan(0);
    diffs.slice(0, switchAt).forEach((d) => expect(d).toBeCloseTo(slow, 9));
    diffs.slice(switchAt).forEach((d) => expect(d).toBeCloseTo(fast, 9));
  });
});

describe("lanes", () => {
  it("a variant change crossfades on the step where the new variant enters", () => {
    engine.setLanes({ lead: "lead.arp" }); // a note on every step
    run(0.5);
    const [oldLane] = laneGains();
    const now = ctx.currentTime;
    const before = ctx.sources().length;

    engine.setLanes({ lead: "lead.acid" });

    // The new lane is backfilled from the first safe queued step...
    const entered = ctx.sources().slice(before);
    expect(entered.length).toBeGreaterThan(0);
    const at = Math.min(...entered.map((s) => s.startTime));
    expect(at).toBeGreaterThanOrEqual(now + 0.015);
    expect(at).toBeLessThan(now + 0.12);
    // ...and the old one holds until exactly then, fading out over 30 ms.
    expect(oldLane.gain.events).toEqual([
      ["cancel", at],
      ["set", 0.3, at],
      ["linear", 0, at + 0.03],
    ]);
  });

  it("backfilled notes never start closer than the safety margin", () => {
    engine.setLanes({ bass: "bass.rolling" });
    run(0.3);
    const now = ctx.currentTime;
    const before = ctx.sources().length;
    engine.setLanes({ bass: "bass.rolling", perc: "perc.shaker" });
    for (const s of ctx.sources().slice(before)) expect(s.startTime).toBeGreaterThanOrEqual(now + 0.015);
  });

  it("a pad switched on mid-phrase sounds on the next step, not 16 steps later", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.5); // past step 0: the pad's own retrigger (step 16) is ~1.2 s away
    const now = ctx.currentTime;
    engine.setLanes({ bass: "bass.offbeat", pad: "pad.chord" });
    // Pad oscillators are the ones feeding its LP 1.4 kHz filter.
    const pad = ctx.sources().filter((s) => s.outputs[0]?.kind === "filter" && s.outputs[0].frequency.value === 1400);
    expect(pad).toHaveLength(6);
    for (const s of pad) expect(s.startTime).toBeLessThan(now + 0.12);
  });

  it("an empty selection stops the loop: nothing plays without a layer", () => {
    engine.setLanes({ lead: "lead.arp" });
    run(0.3);
    engine.setLanes({});
    expect(engine.isRunning()).toBe(false);
    const count = ctx.sources().length;
    run(1);
    expect(ctx.sources()).toHaveLength(count);
  });
});

describe("stop", () => {
  it("clears the scheduler, fades every lane and the step position", () => {
    engine.setLanes({ bass: "bass.rolling", pad: "pad.chord" });
    run(0.4);
    expect(engine.visibleStep()).not.toBeNull();
    const lanes = laneGains();
    engine.stop();
    expect(engine.isRunning()).toBe(false);
    expect(engine.visibleStep()).toBeNull();
    for (const g of lanes) {
      // Stop is immediate, not on the grid.
      expect(g.gain.events[0]).toEqual(["cancel", ctx.currentTime]);
      expect(g.gain.events.at(-1)[1]).toBe(0);
    }
    vi.runOnlyPendingTimers(); // the post-fade disconnects
    expect(vi.getTimerCount()).toBe(0);
    for (const g of lanes) expect(g.disconnected).toBe(true);
  });
});

describe("FX", () => {
  it("fires right away when stopped, without starting the loop", () => {
    const { start } = engine.triggerFx("fx.impact");
    expect(start).toBeCloseTo(0.06, 9);
    expect(engine.isRunning()).toBe(false);
    expect(engine.activeFx()).toEqual(new Set(["fx.impact"]));
  });

  it("lands on the next beat while the loop runs", () => {
    engine.setLanes({ kick: "kick.punchy" });
    run(0.37);
    const { start } = engine.triggerFx("fx.riser");
    const beats = (start - 0.06) / (4 * stepDuration(145));
    expect(beats).toBeCloseTo(Math.round(beats), 9);
    expect(start).toBeGreaterThan(ctx.currentTime);
  });

  it("is reported active until its sound ends", () => {
    const { end } = engine.triggerFx("fx.impact");
    ctx.currentTime = end - 0.01;
    expect(engine.activeFx().has("fx.impact")).toBe(true);
    ctx.currentTime = end + 0.01;
    expect(engine.activeFx().size).toBe(0);
  });
});

describe("visibleStep", () => {
  it("tracks the audible step, delayed by the output latency", () => {
    ctx.outputLatency = 0.05;
    engine.setLanes({ kick: "kick.punchy" });
    expect(engine.visibleStep()).toBeNull();
    run(0.1); // step 0 is at 0.06, audible at 0.11
    expect(engine.visibleStep()).toBeNull();
    run(0.025);
    expect(engine.visibleStep()).toBe(0);
  });
});
