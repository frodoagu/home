import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext, FakeWorklet } from "../test/fakeAudio.js";
import { createEngine } from "./engine.js";
import { defaultData, sampleDefaults } from "./patterns.js";
import { stepDuration, TICK_MS } from "./timing.js";

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

// master -> DJ lowpass -> DJ highpass -> compressor; the master is the first
// gain into the DJ filter (the effect returns join it there too).
function masterGain() {
  const comp = ctx.nodes.find((n) => n.kind === "compressor");
  const high = ctx.nodes.find((n) => n.kind === "filter" && n.outputs[0] === comp);
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

  it("builds master gain -> DJ filter -> compressor -> limiter -> trim -> destination once, and resumes a suspended context", () => {
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
    const comp = high.outputs[0];
    expect(comp.kind).toBe("compressor");
    const limiter = comp.outputs[0];
    expect(limiter.kind).toBe("compressor");
    expect([limiter.threshold.value, limiter.ratio.value]).toEqual([-1.5, 20]);
    const trim = limiter.outputs[0];
    expect(trim.gain.value).toBe(0.8);
    expect(trim.outputs[0]).toBe(ctx.destination);
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

  it("an FX renders from time 0 and is trimmed at its tail", async () => {
    const r = renderer();
    const out = await r.render({ fx: "fx.impact" });
    expect(Math.min(...offline.sources().map((s) => s.startTime))).toBe(0);
    expect(out.channels[0].length).toBe(offline.length);
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
    expect(lane.gain.events.at(-1)).toEqual(["target", 0.3, ctx.currentTime, 0.02]);
    // Same level again: nothing new is automated.
    engine.setData("bass.offbeat", { ...defaultData("bass.offbeat"), level: 0.5 });
    expect(lane.gain.events).toHaveLength(1);
  });

  it("a new lane opens at its edited volume", () => {
    engine.setData("lead.arp", { ...defaultData("lead.arp"), level: 1.5 });
    engine.setLanes({ "lead.arp": "lead.arp" });
    expect(laneGains()[0].gain.value).toBeCloseTo(0.45, 9);
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
});

describe("insert", () => {
  const insertOf = (lane) => {
    // lane gain <- chain output <- post <- shaper <- pre <- filter <- chain input <- lane input
    const output = ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(lane));
    const input = ctx.nodes.find((n) => n.kind === "gain" && n.outputs[0]?.kind === "filter" && n.outputs[0].outputs[0]?.outputs[0]?.kind === "waveshaper"
      && n.outputs[0].outputs[0].outputs[0].outputs[0].outputs[0] === output);
    return { output, input, filter: input.outputs[0] };
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
    const fresh = ctx.nodes.filter((n) => n.kind === "gain" && n.outputs.includes(lane) && n !== old.output);
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

describe("tap", () => {
  const trim = () => ctx.nodes.find((n) => n.kind === "gain" && n.outputs.includes(ctx.destination));

  it("hands out what goes to the speakers until untapped", async () => {
    const blocks = [];
    const untap = await engine.tap((b) => blocks.push(b));
    const node = ctx.nodes.find((n) => n.kind === "worklet");
    expect(ctx.modules).toHaveLength(1);
    expect(node.name).toBe("psy-tap");
    expect(node.options).toMatchObject({ channelCount: 2, channelCountMode: "explicit" });
    expect(trim().outputs).toContain(node);

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
    expect(trim().outputs).not.toContain(node);
    expect(node.disconnected).toBe(true);
  });

  it("loads the processor once per context", async () => {
    await engine.tap(() => {});
    await engine.tap(() => {});
    expect(ctx.modules).toHaveLength(1);
  });
});
