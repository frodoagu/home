import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext, FakeWorklet } from "../test/fakeAudio.js";
import { createEngine } from "./engine.js";
import { trimOf } from "./loudness.js";
import { defaultData, sampleDefaults } from "./patterns.js";
import { stepDuration, TICK_MS } from "./timing.js";

// A factory sound's lane level: its layer's times its own by ear.
const levelOf = (id, layer) => layer * trimOf(id, defaultData(id));
const ARP = levelOf("lead.arp", 0.3);
const BASS = levelOf("bass.offbeat", 0.45);

let ctx;
let createContext;
let engine;

beforeEach(() => {
  vi.useFakeTimers();
  ctx = new FakeAudioContext();
  createContext = vi.fn(() => ctx);
  engine = createEngine({ createContext, createWorklet: (c, name, options) => new FakeWorklet(c, name, options) });
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

// master -> DJ lowpass -> DJ highpass -> sweep -> mastering; the master is
// the first gain into the DJ filter (the effect returns join it there too).
// The mastering chain's input is the one gain held to stereo.
const masteringInput = () => ctx.nodes.find((n) => n.kind === "gain" && n.channelCountMode === "explicit");
const sweepFilter = () => ctx.nodes.find((n) => n.kind === "filter" && n.outputs[0] === masteringInput());
function masterGain() {
  const high = ctx.nodes.find((n) => n.kind === "filter" && n.outputs[0] === sweepFilter());
  const low = ctx.nodes.find((n) => n.kind === "filter" && n.outputs[0] === high);
  return ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0] === low);
}

// Lane gains are the ones wired straight into the master gain.
function laneGains() {
  const master = masterGain();
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

  it("builds master gain -> DJ filter -> sweep -> mastering -> brake -> out -> volume -> destination once, and resumes a suspended context", () => {
    ctx.state = "suspended";
    const resume = vi.spyOn(ctx, "resume");
    engine.setLanes({ bass: "bass.offbeat" });
    engine.setLanes({ bass: "bass.rolling" });
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalled();
    const master = masterGain();
    expect(master.gain.value).toBe(0.7);
    const [low] = master.outputs;
    const [high] = low.outputs;
    expect([low.type, low.frequency.value, high.type, high.frequency.value]).toEqual(["lowpass", 24000, "highpass", 0]);
    const [sweep] = high.outputs;
    expect([sweep.type, sweep.frequency.value, sweep.Q.value]).toEqual(["highpass", 0, 0]); // an identity until a drop
    expect(sweep.outputs[0]).toBe(masteringInput());
    const ceiling = ctx.nodes.find((n) => n.kind === "waveshaper" && n.outputs[0]?.outputs[0]?.kind === "delay");
    const [line] = ceiling.outputs[0].outputs;
    expect([line.kind, line.delayTime.value]).toEqual(["delay", 0]); // the vinyl brake, still until a set's end
    const [brakeGain] = line.outputs;
    expect(brakeGain.gain.value).toBe(1);
    const out = brakeGain.outputs[0];
    expect(out.gain.value).toBe(1);
    const [volume] = out.outputs;
    expect(volume.gain.value).toBe(1);
    expect(volume.outputs[0]).toBe(ctx.destination);
  });

  it("counts the seconds the loop runs, across runs, by the audio clock", () => {
    expect(engine.playedSeconds()).toBe(0);
    engine.setLanes({ bass: "bass.offbeat" });
    run(2);
    expect(engine.playedSeconds()).toBeCloseTo(2, 5);
    engine.setLanes({});
    ctx.currentTime += 10; // silence between runs does not count
    engine.triggerFx("fx.impact"); // nor does an FX shot on its own
    engine.setLanes({ kick: "kick.punchy" });
    run(1);
    engine.stop();
    expect(engine.playedSeconds()).toBeCloseTo(3, 5);
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

  it("in a hidden tab, queues enough to outlast a throttled second-long tick", () => {
    let hidden = false;
    engine = createEngine({ createContext, hidden: () => hidden });
    engine.setLanes({ perc: "perc.shaker" });
    run(0.1);
    hidden = true;
    run(0.025);
    const ahead = Math.max(...startTimes("buffer")) - ctx.currentTime;
    expect(ahead).toBeGreaterThan(1.3);
    expect(ahead).toBeLessThan(1.5 + 1e-9);
  });

  it("the worker clock keeps ticking when the page's timer does not, and stops with the loop", () => {
    const clock = { fn: null, stopped: false };
    engine = createEngine({
      createContext,
      createClock: (ms, fn) => {
        clock.fn = fn;
        return () => (clock.stopped = true);
      },
    });
    engine.setLanes({ perc: "perc.shaker" });
    const before = startTimes("buffer").length;
    ctx.currentTime += 0.5; // the page's timer held back, as in a background tab
    clock.fn();
    const after = startTimes("buffer");
    expect(after.length).toBeGreaterThan(before);
    expect(Math.max(...after)).toBeGreaterThan(ctx.currentTime);
    engine.stop();
    expect(clock.stopped).toBe(true);
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

  it("ratchets a note inside its step and skips it on the loops its condition leaves out", () => {
    const data = defaultData("bass.offbeat");
    data.notes = [{ step: 2, midi: 33, len: 1, accent: false, ply: 2, cond: "1:2" }];
    engine.setData("bass.offbeat", data);
    engine.setLanes({ bass: "bass.offbeat" });
    const step = stepDuration(145);
    const loop = 32 * step;
    run(3 * loop);
    const t0 = 0.06 + 2 * step;
    // Loops 0 and 2 play two halves of step 2; loop 1 is silent.
    const want = [0, 2].flatMap((l) => [t0 + l * loop, t0 + l * loop + step / 2]);
    const times = startTimes("oscillator");
    expect(times).toHaveLength(want.length);
    times.forEach((t, i) => expect(t).toBeCloseTo(want[i], 9));
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
      ["set", ARP, at],
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

describe("bar hook", () => {
  const step = stepDuration(145);

  it("is asked on every bar line, with its time, step and count", () => {
    const calls = [];
    engine.onBar((time, s, bar) => {
      calls.push([time, s, bar]);
    });
    engine.setLanes({ kick: "kick.punchy" });
    run(16 * 3 * step);
    expect(calls.map(([, s, bar]) => [s, bar]).slice(0, 3)).toEqual([[0, 0], [16, 1], [0, 2]]);
    calls.forEach(([time], i) => expect(time).toBeCloseTo(0.06 + i * 16 * step, 9));
  });

  it("the lanes it returns enter exactly on the bar line, without backfill", () => {
    let next = null;
    engine.onBar(() => next);
    engine.setLanes({ lead: "lead.arp" });
    run(0.3);
    const [oldLane] = laneGains();
    const before = ctx.sources().length;
    next = { lead: "lead.acid" };
    run(16 * step);
    const bar = 0.06 + 16 * step;
    const entered = ctx.sources().slice(before).filter((s) => s.startTime >= bar - 1e-9);
    expect(Math.min(...entered.map((s) => s.startTime))).toBeCloseTo(bar, 9);
    expect(oldLane.gain.events[0][0]).toBe("cancel");
    expect(oldLane.gain.events[0][1]).toBeCloseTo(bar, 9);
  });

  it("an empty map fades everything on the bar line and then stops", () => {
    let next = null;
    engine.onBar(() => next);
    engine.setLanes({ bass: "bass.rolling" });
    run(0.3);
    next = {};
    run(16 * step);
    expect(engine.isRunning()).toBe(false);
    const count = ctx.sources().length;
    run(1);
    expect(ctx.sources()).toHaveLength(count);
  });
});

describe("tap sync", () => {
  const step = stepDuration(145);
  // The perc.shaker hits every step: its start times are the grid itself.
  // Only the sources made from here on, so notes the old grid had queued (and
  // its lane fades) stay out.
  const hitsFrom = (n) =>
    ctx
      .sources()
      .slice(n)
      .filter((src) => src.kind === "buffer")
      .map((src) => src.startTime);

  it("restart() plays the 1 right away and runs the grid from the tap, fading what the old grid queued", () => {
    const calls = [];
    engine.onBar((time, s, bar) => {
      calls.push([time, s, bar]);
    });
    engine.setLanes({ perc: "perc.shaker" });
    run(0.5);
    const [oldLane] = laneGains();
    const n = ctx.sources().length;
    const now = ctx.currentTime;
    engine.restart(performance.now() - 20); // the tap was 20 ms ago
    const zero = now - 0.02;
    const at = now + 0.015; // SAFETY: the 1 is due already
    expect(oldLane.gain.events[0]).toEqual(["cancel", at]);
    expect(calls.at(-1)).toEqual([at, 0, 0]);
    run(1);
    const [first, ...rest] = hitsFrom(n);
    expect(first).toBeCloseTo(at, 9);
    rest.forEach((t, i) => expect(t).toBeCloseTo(zero + (i + 1) * step, 9));
    expect(rest.length).toBeGreaterThan(8);
  });

  it("restart() reads the output clock when the browser pairs it, latency included", () => {
    engine.setLanes({ perc: "perc.shaker" });
    run(0.5);
    // The speakers are 40 ms behind the audio clock.
    ctx.getOutputTimestamp = () => ({ contextTime: ctx.currentTime - 0.04, performanceTime: performance.now() });
    const n = ctx.sources().length;
    const now = ctx.currentTime;
    engine.restart(performance.now() - 100); // heard 100 ms ago: audio time now - 0.14
    run(1);
    // Step 1 (at -0.04) has passed and is skipped; step 2 is on the grid.
    expect(hitsFrom(n)[1]).toBeCloseTo(now - 0.14 + 2 * step, 9);
  });

  it("restart() does nothing with the loop stopped", () => {
    engine.restart(performance.now());
    expect(engine.isRunning()).toBe(false);
  });

  // The flow the app drives: restart on the first tap, then BPM + align.
  function tapped(bpm, drift) {
    engine.setLanes({ perc: "perc.shaker" });
    run(0.5);
    const tap0 = performance.now();
    const fresh = ctx.sources().length;
    engine.restart(tap0);
    run(60 / bpm); // one tapped beat later, the second tap
    engine.setBpm(bpm);
    const n = ctx.sources().length;
    const seam = Math.max(...hitsFrom(fresh));
    engine.align(tap0 + drift * 1000); // the fit puts the 1 `drift` s off the first tap
    run(1.5);
    const zero = 0.5 + drift;
    return { fresh, n, seam, zero };
  }

  for (const [label, bpm] of [
    ["a small correction", 150],
    ["a big jump down", 110],
  ]) {
    it(`align() puts every step after the seam on the tapped grid, never doubling one (${label})`, () => {
      const { fresh, n, seam, zero } = tapped(bpm, 0.012);
      const d = stepDuration(bpm);
      const all = hitsFrom(fresh).sort((a, b) => a - b);
      const gaps = all.slice(1).map((t, i) => t - all[i]);
      expect(Math.min(...gaps)).toBeGreaterThan(d / 2 - 1e-9);
      const moved = hitsFrom(n).filter((t) => t > seam + 1e-9);
      expect(moved.length).toBeGreaterThan(6);
      for (const t of moved) {
        const k = Math.round((t - zero) / d);
        expect(t).toBeCloseTo(zero + k * d, 9);
      }
    });
  }
});

describe("render", () => {
  let offline;
  const renderer = () => {
    offline = new FakeAudioContext();
    return createEngine({
      createContext,
      createOffline: (channels, length) => {
        offline.length = length;
        offline.startRendering = async () => {
          const data = Array.from({ length: channels }, () => new Float32Array(length).fill(0.1));
          data.forEach((d) => (d[length - 1] = 0.5));
          return { numberOfChannels: channels, getChannelData: (c) => data[c] };
        };
        return offline;
      },
    });
  };

  it("a loop renders twice and keeps the second pass", async () => {
    const r = renderer();
    const out = await r.render({ lanes: { bass: "bass.offbeat" } });
    const loop = Math.round(32 * stepDuration(145) * 48000);
    expect(offline.length).toBe(2 * loop);
    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(loop);
    expect(out.channels[0].at(-1)).toBe(0.5);
    // 8 offbeat notes per pass, each a saw pluck oscillator.
    const starts = offline.sources().filter((s) => s.kind === "oscillator").map((s) => s.startTime);
    expect(starts.length).toBeGreaterThanOrEqual(16);
    expect(Math.max(...starts)).toBeLessThan((2 * loop) / 48000);
    expect(createContext).not.toHaveBeenCalled();
  });

  it("a held solo never reaches a render", async () => {
    const r = renderer();
    r.setSolo("lead.arp");
    await r.render({ lanes: { bass: "bass.offbeat" } });
    expect(offline.nodes.some((n) => n.kind === "gain" && Math.abs(n.gain.value - BASS) < 1e-9)).toBe(true);
  });

  it("an FX renders once the mastering has settled, from there, and is trimmed at its tail", async () => {
    const r = renderer();
    const out = await r.render({ fx: "fx.impact" });
    expect(Math.min(...offline.sources().map((s) => s.startTime))).toBe(0.2);
    expect(out.channels[0].length).toBe(offline.length - 0.2 * 48000);
  });

  it("a shape cuts and fades every rendered hit", async () => {
    const r = renderer();
    r.setData("kick.punchy", { ...defaultData("kick.punchy"), shape: { length: 0.5, fadeIn: 0, fadeOut: 0.5 } });
    await r.render({ lanes: { kick: "kick.punchy" } });
    const shapes = offline.nodes.filter((n) => n.kind === "gain" && n.gain.events.at(-1)?.[0] === "linear" && n.gain.events.length === 3);
    expect(shapes.length).toBeGreaterThanOrEqual(16); // a hit a beat, two passes
  });

  it("sketches one hit of a voice as long as it rings, before any shape", async () => {
    const r = renderer();
    const flat = await r.sketch("kick.punchy");
    expect(flat.whole).toBe(false);
    expect(flat.sampleRate).toBe(22050);
    expect(flat.data.length).toBeGreaterThan(0);
    expect(flat.data.length).toBeLessThan(22050); // a kick, not the whole render
    r.setData("kick.punchy", { ...defaultData("kick.punchy"), shape: { length: 0.1, fadeIn: 0, fadeOut: 0 } });
    expect((await r.sketch("kick.punchy")).data.length).toBe(flat.data.length);
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

  it("lands at the time it is given", () => {
    engine.setLanes({ kick: "kick.punchy" });
    run(0.2);
    expect(engine.triggerFx("fx.crash", 0.9).start).toBe(0.9);
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

describe("edits (setData)", () => {
  const STEP = stepDuration(145);

  it("new notes play from the next scheduled step, without restarting the lane", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.5);
    const lanesBefore = laneGains().length;
    const edited = { ...defaultData("bass.offbeat"), notes: [...Array(32).keys()].map((step) => ({ step, midi: 33, len: 1, accent: false })) };
    const now = ctx.currentTime;
    engine.setData("bass.offbeat", edited);
    run(0.5);
    expect(laneGains()).toHaveLength(lanesBefore);
    const later = startTimes("oscillator").filter((t) => t > now + 0.12);
    later.slice(1).forEach((t, i) => expect(t - later[i]).toBeCloseTo(STEP, 9));
  });

  it("a synth change applies to the following notes", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.3);
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), synth: "sub" });
    run(1);
    expect(ctx.sources().some((s) => s.type === "triangle")).toBe(true);
  });

  it("a volume change glides the playing lane instead of jumping", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.2);
    const [lane] = laneGains();
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), level: 0.5 });
    expect(lane.gain.events.at(-1)).toEqual(["target", BASS * 0.5, ctx.currentTime, 0.02]);
    // Same level again: nothing new is automated.
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), level: 0.5 });
    expect(lane.gain.events).toHaveLength(1);
  });

  it("a ramped volume change draws a straight line, and anything after it cuts the line where it is", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.2);
    const [lane] = laneGains();
    const t0 = ctx.currentTime;
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), level: 0.5 }, 2);
    expect(lane.gain.events).toEqual([
      ["cancel", t0],
      ["set", lane.gain.value, t0],
      ["linear", BASS * 0.5, t0 + 2],
    ]);
    const from = lane.gain.value;
    ctx.currentTime = t0 + 1; // halfway
    engine.setLayerVolume("bass", 0.5);
    expect(lane.gain.events.slice(3, 5)).toEqual([
      ["cancel", t0 + 1],
      ["set", from + (BASS * 0.5 - from) / 2, t0 + 1],
    ]);
    expect(lane.gain.events.at(-1)).toEqual(["target", BASS * 0.5 * 0.5, t0 + 1, 0.02]);
  });

  it("a lane leaving mid-ramp fades from where the line is", () => {
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.2);
    const [lane] = laneGains();
    const t0 = ctx.currentTime;
    const from = lane.gain.value;
    const line = (t) => from + ((BASS * 0.5 - from) * (t - t0)) / 2;
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), level: 0.5 }, 2);
    ctx.currentTime = t0 + 0.5;
    engine.setLanes({});
    const [cancel, hold, ...rest] = lane.gain.events.slice(3);
    expect(cancel).toEqual(["cancel", t0 + 0.5]);
    expect(hold[0]).toBe("set");
    expect(hold[1]).toBeCloseTo(line(t0 + 0.5), 9);
    const fade = rest.pop();
    expect(fade[0]).toBe("linear");
    expect(fade[1]).toBe(0);
    for (const [kind, value, t] of rest) {
      expect(kind).toBe("linear");
      expect(value).toBeCloseTo(line(t), 9);
    }
  });

  it("a new lane opens at its edited volume", () => {
    engine.setData("lead.arp", { ...defaultData("lead.arp"), level: 1.5 });
    engine.setLanes({ "lead.arp": "lead.arp" });
    expect(laneGains()[0].gain.value).toBeCloseTo(ARP * 1.5, 9);
  });

  it("a layer's volume scales every lane of that layer, FX shots and new lanes", () => {
    engine.setLanes({ bass: "bass.offbeat", "lead.arp": "lead.arp" });
    run(0.2);
    const [bass, lead] = laneGains();
    engine.setLayerVolume("lead", 0.5);
    expect(lead.gain.events.at(-1)).toEqual(["target", ARP * 0.5, ctx.currentTime, 0.02]);
    expect(bass.gain.events).toHaveLength(0);
    engine.setLanes({ bass: "bass.offbeat", "lead.arp": "lead.arp", "lead.acid": "lead.acid" });
    expect(laneGains().at(-1).gain.value).toBeCloseTo(levelOf("lead.acid", 0.3) * 0.5, 9);
    engine.triggerFx("fx.impact");
    const shot = laneGains().at(-1);
    engine.setLayerVolume("fx", 0);
    expect(shot.gain.events.at(-1)).toEqual(["target", 0, ctx.currentTime, 0.02]);
  });

  it("a solo silences every other lane and FX shot, new ones too, and gives them back", () => {
    engine.setLanes({ bass: "bass.offbeat", "lead.arp": "lead.arp" });
    run(0.2);
    const [bass, lead] = laneGains();
    engine.setSolo("lead.arp");
    expect(bass.gain.events.at(-1)).toEqual(["target", 0, ctx.currentTime, 0.01]);
    expect(lead.gain.events.at(-1)[1]).toBeCloseTo(ARP, 9);
    engine.triggerFx("fx.impact");
    expect(laneGains().at(-1).gain.value).toBe(0);
    engine.setLanes({ bass: "bass.offbeat", "lead.arp": "lead.arp", pad: "pad.chord" });
    expect(laneGains().at(-1).gain.value).toBe(0);
    engine.setSolo(null);
    expect(bass.gain.events.at(-1)[1]).toBeCloseTo(BASS, 9);
    expect(lead.gain.events.at(-1)[1]).toBeCloseTo(ARP, 9);
  });

  it("FX read their sliders: a 4-bar sweep lasts 4 bars", () => {
    engine.setData("fx.sweep", { ...defaultData("fx.sweep"), params: { bars: 4, top: 6000 } });
    const { start, end } = engine.triggerFx("fx.sweep");
    expect(end - start).toBeCloseTo(64 * STEP, 9);
  });
});

describe("delay + reverb", () => {
  const bus = () => {
    const delay = ctx.nodes.find((n) => n.kind === "delay");
    const damp = delay.outputs[0];
    const convolver = ctx.nodes.find((n) => n.kind === "convolver");
    return { delay, delayReturn: damp.outputs[1], feedback: damp.outputs[0], reverbReturn: convolver.outputs[0] };
  };

  it("is a 3/16 delay with damped feedback and a convolver, both on by default", () => {
    engine.setLanes({ lead: "lead.arp" });
    const { delay, feedback, delayReturn, reverbReturn } = bus();
    expect(delay.delayTime.value).toBeCloseTo(3 * stepDuration(145), 9);
    expect(feedback.outputs[0]).toBe(delay);
    expect(delayReturn.gain.value).toBe(0.7);
    expect(reverbReturn.gain.value).toBe(0.7);
    expect(ctx.nodes.find((n) => n.kind === "convolver").buffer.numberOfChannels).toBe(2);
  });

  it("leads send to both, bass stays dry", () => {
    engine.setLanes({ bass: "bass.offbeat", "lead.arp": "lead.arp" });
    const [bassLane, leadLane] = laneGains();
    expect(bassLane.outputs).toHaveLength(1);
    expect(leadLane.outputs).toHaveLength(3);
  });

  it("switching an effect fades its return", () => {
    engine.setLanes({ lead: "lead.arp" });
    engine.setEffects({ delay: false });
    const { delayReturn, reverbReturn } = bus();
    expect(delayReturn.gain.events.at(-1)).toEqual(["target", 0, ctx.currentTime, 0.03]);
    expect(reverbReturn.gain.events.at(-1)).toEqual(["target", 0.7, ctx.currentTime, 0.03]);
  });

  it("effects chosen before the first click start in that state", () => {
    engine.setEffects({ reverb: false });
    engine.setLanes({ lead: "lead.arp" });
    expect(bus().reverbReturn.gain.value).toBe(0);
  });

  it("the echo follows the BPM", () => {
    engine.setLanes({ lead: "lead.arp" });
    engine.setBpm(180);
    expect(bus().delay.delayTime.events.at(-1)).toEqual(["target", 3 * stepDuration(180), ctx.currentTime, 0.05]);
  });

  it("stop also disconnects a lane's sends", () => {
    engine.setLanes({ "lead.arp": "lead.arp" });
    run(0.2);
    const [lane] = laneGains();
    const sends = lane.outputs.slice(1);
    engine.stop();
    vi.runOnlyPendingTimers();
    expect(sends.every((g) => g.disconnected)).toBe(true);
  });
});

describe("audition", () => {
  it("plays one note through the variant's synth right away, then fades", () => {
    engine.setData("lead.arp", { ...defaultData("lead.arp"), synth: "fmBell" });
    engine.audition("lead.arp", { midi: 69 });
    const [carrier, mod] = ctx.sources();
    expect(carrier.frequency.value).toBe(440);
    expect(mod.frequency.value).toBe(440 * 3.5);
    expect(carrier.startTime).toBeCloseTo(0.015, 9);
    expect(engine.isRunning()).toBe(false);
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays notes in the mix's key, the shortest way from A, and leaves the drums alone", () => {
    engine.setData("lead.arp", { ...defaultData("lead.arp"), synth: "fmBell" });
    const heard = (key) => {
      engine.setKey(key);
      const before = ctx.sources().length;
      engine.audition("lead.arp", { midi: 69 });
      return ctx.sources()[before].frequency.value;
    };
    expect(heard(0)).toBeCloseTo(440 * 2 ** (3 / 12), 9); // C: up a minor third
    expect(heard(4)).toBeCloseTo(440 * 2 ** (-5 / 12), 9); // E: down a fourth
    expect(heard(9)).toBe(440);
    engine.setKey(0);
    const before = ctx.sources().length;
    engine.audition("kick.punchy", {});
    expect(ctx.sources()[before].frequency.events[0][1]).toBe(defaultData("kick.punchy").params.f0);
  });
});

describe("insert", () => {
  const duckerOf = (lane) => ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(lane));
  const insertOf = (lane) => {
    // lane gain <- ducker <- chain output <- tone lp <- tone hp <- post <- shaper <- pre <- filter <- chain input <- lane input
    // (an unpanned sound has no panner)
    const ducker = duckerOf(lane);
    const output = ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(ducker));
    const hops = (n, k) => (k ? hops(n?.outputs[0], k - 1) : n);
    const input = ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0]?.kind === "filter" && hops(n, 3)?.kind === "waveshaper"
      && hops(n, 7) === output);
    return { ducker, output, input, filter: input.outputs[0] };
  };

  it("every lane plays its notes through its own filter + distortion", () => {
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), insert: { ...defaultData("bass.offbeat").insert, filter: "highpass", cutoff: 300 } });
    engine.setLanes({ bass: "bass.offbeat" });
    run(0.5);
    const [lane] = laneGains();
    const { filter } = insertOf(lane);
    expect([filter.type, filter.frequency.value]).toEqual(["highpass", 300]);
    // A note's envelope ends in the lane input, which feeds the insert.
    const laneInput = ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0] === insertOf(lane).input);
    const saw = ctx.sources().find((src) => src.type === "sawtooth");
    let node = saw;
    while (node.outputs[0] && node !== laneInput) node = node.outputs[0];
    expect(node).toBe(laneInput);
  });

  it("knob moves glide; a new filter type crossfades a fresh chain in", () => {
    const base = defaultData("lead.arp");
    engine.setLanes({ lead: "lead.arp" });
    run(0.3);
    const [lane] = laneGains();
    const old = insertOf(lane);
    const lp = { ...base, insert: { ...base.insert, cutoff: 500 } };
    engine.setData("lead.arp", lp); // still "off": same chain
    expect(insertOf(lane).output).toBe(old.output);
    engine.setData("lead.arp", { ...base, insert: { ...base.insert, filter: "lowpass", cutoff: 500 } });
    const fresh = ctx.nodes.filter((n) => n.kind === "gain" && n.outputs.includes(old.ducker) && n !== old.output);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].gain.events).toEqual([["set", 0, ctx.currentTime], ["linear", 1, ctx.currentTime + 0.03]]);
    expect(old.output.gain.events.at(-1)).toEqual(["linear", 0, ctx.currentTime + 0.03]);
    vi.runOnlyPendingTimers();
    expect(old.output.outputs).toEqual([]);
    engine.setData("lead.arp", { ...base, insert: { ...base.insert, filter: "lowpass", cutoff: 900 } });
    const filter = fresh[0].outputs.length && ctx.nodes.find((n) => n.kind === "filter" && n.type === "lowpass" && n.frequency.events.length);
    expect(filter.frequency.events.at(-1)).toEqual(["target", 900, ctx.currentTime, 0.02]);
  });

  it("a filter's LFO follows the BPM and stops with its lane", () => {
    const base = defaultData("lead.arp");
    engine.setData("lead.arp", { ...base, insert: { ...base.insert, filter: "lowpass", lfo: 0.5, rate: 16 } });
    engine.setLanes({ lead: "lead.arp" });
    const lfo = ctx.sources().find((src) => src.kind === "oscillator" && src.outputs[0].outputs[0]?.constructor.name === "FakeParam");
    expect(lfo.frequency.value).toBeCloseTo(145 / 60 / 4, 9);
    engine.setBpm(180);
    expect(lfo.frequency.events.at(-1)[1]).toBeCloseTo(180 / 60 / 4, 9);
    engine.stop();
    expect(lfo.stopTime).toBeCloseTo(ctx.currentTime + 0.03, 9);
  });
});

describe("samples", () => {
  const ID = "abcdefghijklmnopqrstuv";
  let buffer;
  beforeEach(() => {
    buffer = null;
    engine = createEngine({ createContext, sampleBuffer: (id) => (id === ID ? buffer : null) });
  });
  const withSample = (variant) => ({ ...defaultData(variant), sample: sampleDefaults(ID, "x") });

  it("plays the sound's own voice until the sample is loaded, then the sample", () => {
    engine.setData("perc.hat", withSample("perc.hat"));
    engine.setLanes({ "perc.hat": "perc.hat" });
    run(0.6);
    const before = ctx.sources().filter((s) => s.kind === "buffer");
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => s.buffer !== null && s.buffer.length === 96000)).toBe(true); // the noise
    buffer = ctx.createBuffer(1, 4800, 48000);
    run(0.6);
    expect(ctx.sources().some((s) => s.buffer === buffer)).toBe(true);
  });

  it("an FX with a loaded sample fires the sample and reports its end", () => {
    buffer = ctx.createBuffer(1, 24000, 48000);
    engine.setData("fx.impact", withSample("fx.impact"));
    const { start, end } = engine.triggerFx("fx.impact");
    expect(end).toBeCloseTo(start + 0.5, 9);
    expect(ctx.sources().map((s) => s.buffer)).toEqual([buffer]);
  });

  it("a sample takes the shape's fades but cuts with its own length", () => {
    buffer = ctx.createBuffer(1, 24000, 48000);
    engine.setData("fx.impact", { ...withSample("fx.impact"), shape: { length: 0.1, fadeIn: 0, fadeOut: 0.5 } });
    const { start, end } = engine.triggerFx("fx.impact");
    expect(end).toBeCloseTo(start + 0.5, 9);
    const fades = ctx.sources()[0].outputs[0].outputs[0];
    expect(fades.gain.events.at(-1)).toEqual(["linear", 0, end]);
  });

  it("sketches the whole sample, mixed to one channel and reversed as it plays", async () => {
    buffer = ctx.createBuffer(2, 4, 48000);
    buffer.getChannelData(0).set([1, 0, 0, 0]);
    buffer.getChannelData(1).set([0, 0, 0, 1]);
    engine.setData("perc.hat", { ...withSample("perc.hat"), sample: { ...sampleDefaults(ID, "x"), reverse: true } });
    const out = await engine.sketch("perc.hat");
    expect(out).toEqual({ sampleRate: 48000, data: new Float32Array([0.5, 0, 0, 0.5]), whole: true });
  });

  it("previews a library sample, once it is there", () => {
    expect(engine.previewSample(ID)).toBe(false);
    buffer = ctx.createBuffer(1, 4800, 48000);
    expect(engine.previewSample(ID)).toBe(true);
    expect(ctx.sources().at(-1).buffer).toBe(buffer);
  });
});

describe("DJ filter", () => {
  it("glides the master lowpass down or the highpass up, and renders with it", async () => {
    engine.setMasterFilter(-1);
    engine.setLanes({ kick: "kick.punchy" });
    const low = masterGain().outputs[0];
    expect(low.frequency.value).toBeCloseTo(150, 6);
    engine.setMasterFilter(1);
    const high = low.outputs[0];
    expect(low.frequency.events.at(-1)).toEqual(["target", 24000, ctx.currentTime, 0.03]);
    expect(high.frequency.events.at(-1)[1]).toBeCloseTo(6000, 6);
  });
});

describe("master volume", () => {
  const volume = () => ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(ctx.destination));

  it("starts the context at the knob's level and glides it squared, after the output the takes and visuals read", () => {
    engine.setVolume(0.5);
    engine.setLanes({ kick: "kick.punchy" });
    expect(volume().gain.value).toBe(0.25);
    engine.setVolume(0);
    expect(volume().gain.events.at(-1)).toEqual(["target", 0, ctx.currentTime, 0.02]);
    const out = ctx.nodes.find((n) => n.outputs.includes(volume()));
    expect(engine.levels()).toBe(out.outputs.at(-1));
  });
});

describe("the vinyl brake", () => {
  const brakeLine = () => ctx.nodes.filter((n) => n.kind === "delay").at(-1);

  it("stretches a delay line under the whole mix as t²/2T, so pitch and tempo fall to zero, and the level goes with it", () => {
    const heard = [];
    engine.listen((e) => heard.push(e));
    engine.setLanes({ kick: "kick.punchy" });
    const line = brakeLine();
    const [gain] = line.outputs;
    engine.brake(2, 1.6);
    const [, curve, at, span] = line.delayTime.events.find(([kind]) => kind === "curve");
    expect([at, span]).toEqual([2, 1.6]);
    expect(curve[0]).toBe(0);
    expect(curve.at(-1)).toBeCloseTo(0.8, 6); // T/2: the platter has stopped
    // Its slope is 1 - speed: 0 at the start, 1 (standing still) at the end.
    const slope = (i) => (curve[i + 1] - curve[i]) / (1.6 / (curve.length - 1));
    expect(slope(0)).toBeLessThan(0.05);
    expect(slope(curve.length - 2)).toBeGreaterThan(0.95);
    expect(gain.gain.events.slice(-2)).toEqual([["set", 1, 2 + 1.6 * 0.7], ["linear", 0, 3.6]]);
    expect(heard.filter((e) => e.kind === "brake")).toEqual([{ kind: "brake", time: 2, end: 3.6 }]);
  });

  it("takes 8 bars when asked; past its longest it starts late, so it still stops at the end", () => {
    engine.setLanes({ kick: "kick.punchy" });
    const line = brakeLine();
    engine.brake(1, 13); // 8 bars at 145 BPM
    expect(line.delayTime.events.at(-1).slice(2)).toEqual([1, 13]);
    expect(line.delayTime.events.at(-1)[1].at(-1)).toBeCloseTo(6.5, 6);
    engine.brake(1, 30);
    expect(line.delayTime.events.at(-1).slice(2)).toEqual([7, 24]); // ends at 31 all the same
  });

  it("lets go on unbrake() and on the next start", () => {
    engine.setLanes({ kick: "kick.punchy" });
    const line = brakeLine();
    engine.brake(1, 1);
    engine.unbrake();
    expect(line.delayTime.events.slice(-1)).toEqual([["set", 0, ctx.currentTime]]);
    expect(line.outputs[0].gain.events.slice(-1)).toEqual([["set", 1, ctx.currentTime]]);
    engine.brake(1, 1);
    engine.stop();
    engine.setLanes({ kick: "kick.punchy" });
    expect(line.delayTime.events.slice(-1)).toEqual([["set", 0, ctx.currentTime]]);
  });
});

describe("the drop's sweep", () => {
  it("rises exponentially from `at` and holds; sweepOff glides down onto the drop and opens there", () => {
    engine.setLanes({ lead: "lead.acid" });
    const f = sweepFilter().frequency;
    engine.sweep(1, 4);
    expect(f.events).toEqual([
      ["cancel", 1],
      ["set", 30, 1],
      ["exp", 900, 4],
    ]);
    ctx.currentTime = 4.5; // up and holding: the drop lands on 5
    f.events = [];
    engine.sweepOff(5);
    expect(f.events).toEqual([
      ["cancel", 4.5],
      ["set", 900, 4.5],
      ["exp", 900, 5 - 0.015],
      ["exp", 30, 5],
      ["set", 0, 5],
    ]);
  });

  it("an early drop cuts the rise where it is", () => {
    engine.setLanes({ lead: "lead.acid" });
    const f = sweepFilter().frequency;
    engine.sweep(0, 4, 480);
    ctx.currentTime = 2; // halfway: sqrt(30 * 480) = 120 Hz
    f.events = [];
    engine.sweepOff(3);
    const [, [, now, at]] = f.events;
    expect([now, at]).toEqual([expect.closeTo(120, 6), 2]);
    expect(f.events.at(-1)).toEqual(["set", 0, 3]);
  });

  it("a sweep that had not started just clears; Stop opens it as the lanes fade", async () => {
    engine.setLanes({ lead: "lead.acid" });
    const f = sweepFilter().frequency;
    engine.sweep(2, 4);
    f.events = [];
    engine.sweepOff(4);
    expect(f.events).toEqual([["cancel", 0], ["set", 0, 0]]);
    engine.sweep(0, 4);
    ctx.currentTime = 1;
    engine.stop();
    expect(f.events.at(-1)).toEqual(["set", 0, 1.03]);
    engine.sweepOff(9); // nothing up: nothing to do
    expect(f.events.at(-1)).toEqual(["set", 0, 1.03]);
  });
});

describe("pump", () => {
  const sidechain = () => {
    const shaper = ctx.nodes.find((n) => n.kind === "waveshaper" && n.curve?.length === 1025);
    return { env: shaper.outputs[0] };
  };

  it("gives a layer's lanes at least that duck from the bar line, never the kick, and back to their own", () => {
    engine.setData("lead.acid", { ...defaultData("lead.acid"), duck: 0.5 });
    engine.setLanes({ kick: "kick.punchy", pad: "pad.chord", lead: "lead.acid" });
    run(0.2);
    const { env } = sidechain();
    expect(env.outputs).toHaveLength(1); // only the lead ducks
    engine.setPump({ pad: 0.6, lead: 0.3, kick: 1 }, 1);
    expect(env.outputs).toHaveLength(2); // the pad joins; the kick never ducks
    const [lead, pad] = env.outputs;
    expect(pad.gain.events.at(-1)).toEqual(["target", -0.6, 1, 0.02]);
    expect(lead.gain.events.at(-1)).toEqual(["target", -0.5, 1, 0.02]); // its own is deeper
    engine.setPump({}, 2);
    expect(pad.gain.events.at(-1)).toEqual(["target", -0, 2, 0.02]);
  });

  it("a lane that opens under it ducks too", () => {
    engine.setPump({ pad: 0.6 });
    engine.setLanes({ kick: "kick.punchy", pad: "pad.chord" });
    run(0.2);
    const [depth] = sidechain().env.outputs;
    expect(depth.gain.value).toBe(-0.6);
  });
});

describe("tap", () => {
  const volume = () => ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(ctx.destination));
  const out = () => ctx.nodes.find((n) => n.outputs.includes(volume()));

  it("hands out what goes to the speakers until untapped", async () => {
    const blocks = [];
    const untap = await engine.tap((b) => blocks.push(b));
    const node = ctx.nodes.find((n) => n.kind === "worklet");
    expect(ctx.modules).toHaveLength(1);
    expect(node.name).toBe("psy-tap");
    expect(node.options).toMatchObject({ channelCount: 2, channelCountMode: "explicit" });
    expect(out().outputs).toContain(node);

    const block = [new Float32Array(4), new Float32Array(4)];
    node.port.onmessage({ data: block });
    expect(blocks).toEqual([block]);

    const closing = untap();
    expect(node.port.sent).toEqual(["flush"]);
    const last = [new Float32Array(2), new Float32Array(2)];
    node.port.onmessage({ data: last });
    node.port.onmessage({ data: null });
    await closing;
    expect(blocks).toEqual([block, last]);
    expect(out().outputs).not.toContain(node);
    expect(node.disconnected).toBe(true);
  });

  it("loads the processor once per context", async () => {
    await engine.tap(() => {});
    await engine.tap(() => {});
    expect(ctx.modules).toHaveLength(1);
  });
});

describe("groove: sidechain and nudge", () => {
  const sidechain = () => {
    const shaper = ctx.nodes.find((n) => n.kind === "waveshaper" && n.curve?.length === 1025);
    return { input: ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0] === shaper), env: shaper.outputs[0] };
  };

  it("kick lanes feed the sidechain; a lane with duck gets its envelope at -duck on its ducker", () => {
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), duck: 0.7 });
    engine.setLanes({ kick: "kick.punchy", bass: "bass.offbeat" });
    run(0.2);
    const { input, env } = sidechain();
    expect(env.type).toBe("lowpass");
    const kickGain = laneGains().find((g) => g.outputs.includes(input));
    expect(kickGain).toBeDefined();
    const [depth] = env.outputs;
    expect(env.outputs).toHaveLength(1); // the kick does not duck itself
    expect(depth.gain.value).toBe(-0.7);
    expect(depth.outputs[0].constructor.name).toBe("FakeParam");
  });

  it("an edit glides the depth, and switching duck on mid-play wires it", () => {
    engine.setLanes({ kick: "kick.punchy", pad: "pad.chord" });
    run(0.2);
    const { env } = sidechain();
    expect(env.outputs).toHaveLength(0);
    engine.setData("pad.chord", { ...defaultData("pad.chord"), duck: 0.5 });
    const [depth] = env.outputs;
    expect(depth.gain.events.at(-1)).toEqual(["target", -0.5, ctx.currentTime, 0.02]);
  });

  it("a nudge moves every hit by its ms", () => {
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), nudge: 10 });
    engine.setLanes({ bass: "bass.offbeat" });
    run(1);
    const step = stepDuration(145);
    startTimes("oscillator").forEach((t, i) => expect(t).toBeCloseTo(0.06 + (2 + 4 * i) * step + 0.01, 9));
  });
});

describe("filter envelope", () => {
  it("every note the lane plays triggers its insert's envelope at the note's time", () => {
    const base = defaultData("bass.offbeat");
    engine.setData("bass.offbeat", { ...base, insert: { ...base.insert, filter: "lowpass", env: 0.5 } });
    engine.setLanes({ bass: "bass.offbeat" });
    run(1);
    const filter = ctx.nodes.find((n) => n.kind === "filter" && n.detune.events.length);
    const opens = filter.detune.events.filter((e) => e[1] !== 0).map((e) => e[2]);
    const notes = ctx.sources().filter((src) => src.type === "sawtooth").map((src) => src.startTime).sort((a, b) => a - b);
    expect(opens.length).toBeGreaterThan(2);
    opens.forEach((t, i) => expect(t).toBeCloseTo(notes[i], 9));
  });
});

describe("listen", () => {
  it("reports each lane's hits with their layer and audio time, and the bar lines", () => {
    const events = [];
    engine.listen((e) => events.push(e));
    engine.setLanes({ kick: "kick.punchy" });
    run(stepDuration(145) * 20);
    const kicks = events.filter((e) => e.kind === "hit");
    expect(kicks.length).toBeGreaterThan(3);
    expect(kicks.every((e) => e.layer === "kick" && e.variant === "kick.punchy")).toBe(true);
    // Four on the floor: one kick every four steps.
    expect(kicks[1].time - kicks[0].time).toBeCloseTo(stepDuration(145) * 4, 6);
    const bars = events.filter((e) => e.kind === "bar");
    expect(bars.map((e) => e.bar)).toEqual([0, 1]);
    expect(bars[0]).toMatchObject({ bpm: 145, time: kicks[0].time });
    expect(events.find((e) => e.kind === "lanes")).toMatchObject({ variants: ["kick.punchy"] });
  });

  it("reports the build's sweep and the drop, but not a sweep lowered by a stop", () => {
    const events = [];
    engine.listen((e) => events.push(e));
    engine.setLanes({ kick: "kick.punchy" });
    engine.sweep(1, 3);
    engine.sweepOff(3);
    engine.sweep(4, 5);
    engine.stop();
    const kinds = events.map((e) => e.kind).filter((k) => k !== "hit" && k !== "bar" && k !== "lanes");
    expect(kinds).toEqual(["build", "drop", "build", "stop"]);
    expect(events.find((e) => e.kind === "build")).toMatchObject({ time: 1, end: 3 });
    expect(events.find((e) => e.kind === "drop")).toMatchObject({ time: 3 });
  });

  it("stops reporting once unsubscribed, and hands out one analyser off the output", () => {
    const fn = vi.fn();
    const off = engine.listen(fn);
    expect(engine.levels()).toBe(null); // no context yet
    off();
    engine.setLanes({ kick: "kick.punchy" });
    run(0.5);
    expect(fn).not.toHaveBeenCalled();
    const analyser = engine.levels();
    expect(analyser.kind).toBe("analyser");
    expect(engine.levels()).toBe(analyser);
  });

  it("maps an audio time to the moment it leaves the speakers", () => {
    engine.setLanes({ kick: "kick.punchy" });
    ctx.getOutputTimestamp = () => ({ contextTime: 2, performanceTime: 5000 });
    expect(engine.perfTimeOf(2.5)).toBe(5500);
  });
});
