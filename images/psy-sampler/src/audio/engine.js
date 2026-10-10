// Audio engine: owns the AudioContext, the output chain, the lookahead
// scheduler and one gain "lane" per playing variant.
//
//   notes ─> lane input ─> insert ─> lane gain ─┬─> master (0.7) ─> DJ filter ─> compressor ─> limiter ─> trim ─> destination
//                                   fx gain  ───┤                      ▲
//                                               ├─ delay send ─> delay 3/16 ─> return ─┤
//                                               └─ reverb send ─> convolver ─> return ─┘
//
// The insert is the variant's own filter + distortion (insert.js); FX shots
// and auditions get one too. A variant using a sample plays it through
// `sampleBuffer(id)`, or its own voice while that returns nothing.
//
// Lanes are what make changes click-free: a variant change or a stop never
// touches individual notes, it fades the whole lane out over FADE and opens a
// fresh one, so notes already queued for the old variant die inside the fade.
// Variant changes crossfade on the next step boundary (the old lane plays up
// to the exact step where the new one enters); a stop fades right away.
//
// Changes can also land exactly on a bar line: onBar() registers a callback
// the scheduler asks right before it queues the first step of every bar, and
// whatever lanes it returns open on that step (no backfill, no early entry).
//
// What a variant plays is data (patterns.js) the UI can edit at any time:
// setData() swaps it and the scheduler reads it on the next step.
import {
  collectSteps,
  nextBeatTime,
  stepDuration,
  BAR_STEPS,
  BPM_DEFAULT,
  LOOKAHEAD,
  LOOP_STEPS,
  SAFETY,
  TICK_MS,
} from "./timing.js";
import { DJ_Q, INSERT_DEFAULT, buildInsert, djCutoffs, kindOf } from "./insert.js";
import { auditionEvent, baseOf, defOf, eventsAt, sampleDefaults } from "./patterns.js";
import { FX, VOICES, sample } from "./voices.js";
import { trimTail } from "./wav.js";

const MASTER_GAIN = 0.7;
const OUTPUT_TRIM = 0.8;
const FADE = 0.03;
const START_DELAY = 0.06; // first step after start(): room for the first tick to land
const LAYER_LEVEL = { kick: 0.9, bass: 0.6, perc: 0.6, lead: 0.3, pad: 0.35, glitch: 0.45, fx: 0.6 };
const BG_KICK_LEVEL = 0.6;
// Sends per layer, after the lane gain (so they follow its fades). Kick and
// bass stay dry: tails under them only muddy the low end.
const SENDS = {
  perc: { delay: 0, reverb: 0.12 },
  lead: { delay: 0.3, reverb: 0.25 },
  pad: { delay: 0, reverb: 0.4 },
  glitch: { delay: 0.25, reverb: 0.15 },
  fx: { delay: 0.2, reverb: 0.35 },
};
const DELAY_STEPS = 3; // dotted 8th: the classic psy lead echo
const DELAY_FEEDBACK = 0.38;
// Returns feed the compressor directly, so they already carry the master level.
const RETURN_LEVEL = MASTER_GAIN;
const REVERB_SECONDS = 2.4;
const AUDITION_SECONDS = 1.5;
const RENDER_RATE = 48000;
// Longest FX (4 bars at the slowest BPM is 7.4 s) plus its reverb tail; the
// silence after the sound is trimmed off.
const FX_RENDER_SECONDS = 12;

const layerOf = (variant) => variant.split(".")[0];

// Synthetic room: stereo noise with a cubic decay.
function impulse(ctx, seconds) {
  const length = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buf;
}

// Output chain: master -> DJ filter -> compressor -> limiter -> trim ->
// destination, plus the shared delay and reverb buses (their returns go
// through the DJ filter too). Built once per context, live or offline.
function buildChain(ctx, bpm, effects, djValue = 0) {
  // Gentle settings: it only catches peaks when layers stack up. The
  // defaults (-24 dB, 12:1) would flatten exactly the dynamics a solo
  // layer is meant to let you hear.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 6;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  // Safety net for big stacks: every layer + FX + tails peaks ~+1.5 dBFS
  // through the compressor alone. Both compressors add automatic makeup
  // gain (Chrome), so the trim takes ~2 dB back: measured, a solo layer
  // peaks around -3 dBFS and the full stack stays under -1.5 dBFS.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const trim = ctx.createGain();
  trim.gain.value = OUTPUT_TRIM;
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  const dj = { low: ctx.createBiquadFilter(), high: ctx.createBiquadFilter() };
  dj.low.type = "lowpass";
  dj.high.type = "highpass";
  const { low, high } = djCutoffs(djValue, ctx.sampleRate / 2);
  dj.low.frequency.value = low;
  dj.high.frequency.value = high;
  dj.low.Q.value = DJ_Q;
  dj.high.Q.value = DJ_Q;
  master.connect(dj.low).connect(dj.high).connect(comp).connect(limiter).connect(trim).connect(ctx.destination);
  return { master, dj, bus: buildBus(ctx, dj.low, bpm, effects) };
}

function buildBus(ctx, into, bpm, effects) {
  const delay = ctx.createDelay(2);
  delay.delayTime.value = DELAY_STEPS * stepDuration(bpm);
  // Repeats go through a lowpass on their way back in, so each one is darker.
  const damp = ctx.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = 2500;
  const feedback = ctx.createGain();
  feedback.gain.value = DELAY_FEEDBACK;
  const delaySend = ctx.createGain();
  delaySend.connect(delay).connect(damp).connect(feedback).connect(delay);
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = effects.delay ? RETURN_LEVEL : 0;
  damp.connect(delayReturn).connect(into);

  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(ctx, REVERB_SECONDS);
  const reverbSend = ctx.createGain();
  reverbSend.connect(convolver);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = effects.reverb ? RETURN_LEVEL : 0;
  convolver.connect(reverbReturn).connect(into);
  return { delay, delaySend, delayReturn, reverbSend, reverbReturn };
}

// A lane or FX gain into the master, with its layer's effect sends.
function connectGain(ctx, { master, bus }, level, layer) {
  const gain = ctx.createGain();
  gain.gain.value = level;
  gain.connect(master);
  gain.sends = [];
  const sends = SENDS[layer];
  if (sends) {
    for (const [dest, amount] of [[bus.delaySend, sends.delay], [bus.reverbSend, sends.reverb]]) {
      if (!amount) continue;
      const send = ctx.createGain();
      send.gain.value = amount;
      gain.connect(send).connect(dest);
      gain.sends.push(send);
    }
  }
  return gain;
}

// Notes connect to `input`; its insert chain feeds `gain`. Used by lanes,
// FX shots and auditions alike.
function withInsert(ctx, gain, insert, stepDur, at) {
  const input = ctx.createGain();
  const chain = buildInsert(ctx, insert, { stepDur, at });
  input.connect(chain.input);
  chain.output.connect(gain);
  return { gain, input, chain };
}

export function createEngine({
  createContext = () => new AudioContext(),
  createOffline = (channels, length, rate) => new OfflineAudioContext(channels, length, rate),
  sampleBuffer = () => null, // sample id -> decoded AudioBuffer, or null while it is not there
} = {}) {
  let ctx = null;
  let master = null;
  let dj = null; // { low, high }: the DJ filter's two biquads
  let djValue = 0;
  let bus = null; // { delay, delaySend, delayReturn, reverbSend, reverbReturn }
  let bpm = BPM_DEFAULT;
  let timer = null;
  let cursor = null; // { step, time } of the next step to schedule; null when stopped
  let queued = []; // steps already scheduled, oldest first: step bar + lane backfill
  let effects = { delay: true, reverb: true };
  let barHook = null; // (time, step, bar) -> desired lanes | undefined
  let bars = 0; // bar lines queued since start(); the first one is 0
  let stopAt = null; // a bar-line stop: the timer ends once this time passes
  const lanes = new Map(); // lane key -> { variant, gain, input, chain, level, entered }
  const fxPlaying = new Map(); // fx id -> { gain, input, chain, end }
  const data = new Map(); // variant id -> edited data (factory data otherwise)

  const dataOf = (id) => data.get(id) ?? defOf(id).data;
  const laneLevel = (key, variant) =>
    (key === "bgKick" ? BG_KICK_LEVEL : LAYER_LEVEL[layerOf(variant)]) * dataOf(variant).level;

  // Must run synchronously inside a click handler: browsers only let an
  // AudioContext start (or resume) from a user gesture.
  function ensureContext() {
    if (!ctx) {
      ctx = createContext();
      ({ master, dj, bus } = buildChain(ctx, bpm, effects, djValue));
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One event on any context. A sample plays only once it is decoded.
  function voice(c, out, t, ev, stepDur) {
    if (ev.voice !== "sample") return VOICES[ev.voice](c, out, t, ev, stepDur);
    const buffer = sampleBuffer(ev.sample.id);
    return buffer ? sample(c, out, t, { ...ev, buffer }, stepDur) : VOICES[ev.fallback](c, out, t, ev, stepDur);
  }

  // An FX shot: its sample if it has one and it is loaded, else its synth.
  function fxVoice(c, out, t, stepDur, id) {
    const { params, sample: s } = dataOf(id);
    const buffer = s && sampleBuffer(s.id);
    return buffer ? sample(c, out, t, { sample: s, buffer }, stepDur) : FX[baseOf(id)](c, out, t, stepDur, params);
  }

  function scheduleLane(lane, step, time, stepDur) {
    for (const ev of eventsAt(lane.variant, step, !lane.entered, dataOf(lane.variant))) {
      voice(ctx, lane.input, time, ev, stepDur);
    }
    lane.entered = true;
  }

  function tick() {
    const stepDur = stepDuration(bpm); // read every tick: the BPM slider applies live
    const { due, cursor: next } = collectSteps(cursor, ctx.currentTime, LOOKAHEAD, stepDur);
    cursor = next;
    for (const s of due) {
      if (s.step % BAR_STEPS === 0) atBar(s);
      for (const lane of lanes.values()) scheduleLane(lane, s.step, s.time, stepDur);
      queued.push(s);
    }
    const horizon = ctx.currentTime - 1;
    while (queued.length && queued[0].time < horizon) queued.shift();
    if (stopAt !== null && ctx.currentTime >= stopAt + FADE) stopLoop();
  }

  // A bar line is about to be queued: the hook's lanes enter right on it. An
  // empty map fades everything there and lets the timer run out.
  function atBar(s) {
    const desired = barHook?.(s.time, s.step, bars++);
    if (!desired) return;
    reconcile(desired, s.time, false);
    stopAt = lanes.size === 0 ? s.time : null;
  }

  const openGain = (level, layer) => connectGain(ctx, { master, bus }, level, layer);

  // Gain + input + insert, the insert's LFO starting at `at`.
  const openVoice = (level, layer, insert, at) =>
    withInsert(ctx, openGain(level, layer), insert, stepDuration(bpm), at);

  function openLane(key, variant, backfill, at) {
    const level = laneLevel(key, variant);
    const lane = { variant, level, ...openVoice(level, layerOf(variant), dataOf(variant).insert, at), entered: false };
    // Steps inside the lookahead window were queued before this lane existed.
    // Backfill them so the new variant enters on the very next step instead of
    // leaving a hole up to LOOKAHEAD long; steps closer than SAFETY are skipped
    // because they could start mid-envelope.
    if (cursor && backfill) {
      const stepDur = stepDuration(bpm);
      const earliest = ctx.currentTime + SAFETY;
      for (const s of queued) if (s.time >= earliest) scheduleLane(lane, s.step, s.time, stepDur);
    }
    return lane;
  }

  // Linear fade to 0 starting at `at`. Notes still queued on this gain play
  // into silence and stop themselves; the timeout only disconnects the nodes
  // for GC, it never times audio.
  function fadeOut(holder, at = ctx.currentTime) {
    const { gain } = holder;
    gain.gain.cancelScheduledValues(at);
    gain.gain.setValueAtTime(gain.gain.value, at);
    gain.gain.linearRampToValueAtTime(0, at + FADE);
    holder.chain.stop(at + FADE);
    setTimeout(() => release(holder), (at - ctx.currentTime + FADE + 0.05) * 1000);
  }

  function release({ gain, input, chain }) {
    gain.disconnect();
    for (const send of gain.sends) send.disconnect();
    input.disconnect();
    chain.output.disconnect();
  }

  // A filter or distortion type changed: a fresh chain crossfades in.
  function swapInsert(lane, insert) {
    const now = ctx.currentTime;
    const old = lane.chain;
    const next = buildInsert(ctx, insert, { stepDur: stepDuration(bpm), at: now });
    next.output.gain.setValueAtTime(0, now);
    next.output.gain.linearRampToValueAtTime(1, now + FADE);
    lane.input.connect(next.input);
    next.output.connect(lane.gain);
    old.output.gain.setValueAtTime(1, now);
    old.output.gain.linearRampToValueAtTime(0, now + FADE);
    old.stop(now + FADE);
    setTimeout(() => {
      try {
        lane.input.disconnect(old.input);
      } catch {
        // The lane was released first: nothing left to unplug.
      }
      old.output.disconnect();
    }, (FADE + 0.05) * 1000);
    lane.chain = next;
  }

  // First step boundary that can still be scheduled safely: where a lane
  // change takes effect. Same rule as the backfill in openLane().
  function switchTime() {
    const earliest = ctx.currentTime + SAFETY;
    const next = queued.find((s) => s.time >= earliest);
    return next ? next.time : cursor.time;
  }

  function start() {
    cursor = { step: 0, time: ctx.currentTime + START_DELAY };
    queued = [];
    bars = 0;
    stopAt = null;
    tick();
    timer = setInterval(tick, TICK_MS);
  }

  function stopLoop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    cursor = null;
    queued = [];
    stopAt = null;
    for (const lane of lanes.values()) fadeOut(lane);
    lanes.clear();
  }

  /**
   * Reconcile the playing lanes with `desired` ({ laneKey: variantId }):
   * changed or removed lanes fade out, new ones open. An empty map stops the
   * loop, so nothing sounds without an active layer.
   */
  function setLanes(desired) {
    const wanted = Object.entries(desired);
    if (wanted.length === 0) {
      stopLoop();
      return;
    }
    ensureContext();
    reconcile(desired, cursor ? switchTime() : ctx.currentTime, true);
    stopAt = null;
    if (timer === null) start();
  }

  function reconcile(desired, at, backfill) {
    for (const [key, lane] of lanes) {
      if (desired[key] !== lane.variant) {
        fadeOut(lane, at);
        lanes.delete(key);
      }
    }
    for (const [key, variant] of Object.entries(desired)) {
      if (!lanes.has(key)) lanes.set(key, openLane(key, variant, backfill, at));
    }
  }

  /**
   * Swap the data a variant plays. Notes and params apply from the next
   * scheduled step; a volume change glides the lanes playing it (20 ms) so
   * the slider never zips, and so do the insert's knobs.
   */
  function setData(id, next) {
    data.set(id, next);
    if (!ctx) return;
    for (const [key, lane] of lanes) {
      if (lane.variant !== id) continue;
      if (kindOf(next.insert) === lane.chain.kind) lane.chain.update(next.insert, ctx.currentTime);
      else swapInsert(lane, next.insert);
      const level = laneLevel(key, id);
      if (level === lane.level) continue;
      lane.level = level;
      lane.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.02);
    }
  }

  function setEffects(next) {
    effects = { ...effects, ...next };
    if (!bus) return;
    bus.delayReturn.gain.setTargetAtTime(effects.delay ? RETURN_LEVEL : 0, ctx.currentTime, 0.03);
    bus.reverbReturn.gain.setTargetAtTime(effects.reverb ? RETURN_LEVEL : 0, ctx.currentTime, 0.03);
  }

  function setBpm(value) {
    bpm = value;
    // The echo stays on the grid; the short glide bends the tail a little
    // instead of jumping (a jump in delay time clicks).
    if (!bus) return;
    bus.delay.delayTime.setTargetAtTime(DELAY_STEPS * stepDuration(bpm), ctx.currentTime, 0.05);
    for (const lane of lanes.values()) lane.chain.setStepDur(stepDuration(bpm), ctx.currentTime);
  }

  // The DJ filter knob, -1 (lowpass closed) .. 0 (open) .. 1 (highpass up).
  function setMasterFilter(value) {
    djValue = value;
    if (!dj) return;
    const { low, high } = djCutoffs(value, ctx.sampleRate / 2);
    dj.low.frequency.setTargetAtTime(low, ctx.currentTime, 0.03);
    dj.high.frequency.setTargetAtTime(high, ctx.currentTime, 0.03);
  }

  // One-shot FX: at `at` if given (a bar hook passes its bar line), else on
  // the next beat while the loop runs, right away otherwise. Retriggering an
  // FX that is still sounding fades the previous instance.
  function triggerFx(id, at) {
    ensureContext();
    const stepDur = stepDuration(bpm);
    const t = at ?? (cursor ? nextBeatTime(cursor, stepDur) : ctx.currentTime + START_DELAY);
    const prev = fxPlaying.get(id);
    if (prev) fadeOut(prev);
    const { level, insert } = dataOf(id);
    const shot = openVoice(LAYER_LEVEL.fx * level, "fx", insert, t);
    const end = fxVoice(ctx, shot.input, t, stepDur, id);
    shot.chain.stop(end + FADE);
    fxPlaying.set(id, { ...shot, end });
    return { start: t, end };
  }

  // Preview of one note or hit from the editor, right now and off the grid.
  function audition(id, note) {
    ensureContext();
    const ev = auditionEvent(id, dataOf(id), note);
    if (!ev) return;
    const layer = layerOf(id);
    const t = ctx.currentTime + SAFETY;
    const shot = openVoice(LAYER_LEVEL[layer] * dataOf(id).level, layer, dataOf(id).insert, t);
    voice(ctx, shot.input, t, ev, stepDuration(bpm));
    fadeOut(shot, t + AUDITION_SECONDS);
  }

  // A sample from the library as recorded, right now. False until it is loaded.
  function previewSample(id) {
    ensureContext();
    const buffer = sampleBuffer(id);
    if (!buffer) return false;
    const t = ctx.currentTime + SAFETY;
    const shot = openVoice(LAYER_LEVEL.fx, "fx", INSERT_DEFAULT, t);
    const end = sample(ctx, shot.input, t, { sample: sampleDefaults(id), buffer }, stepDuration(bpm));
    fadeOut(shot, end);
    return true;
  }

  // Ids of FX still sounding; finished ones are released here.
  function activeFx() {
    const ids = new Set();
    if (!ctx) return ids;
    for (const [id, fx] of fxPlaying) {
      if (fx.end > ctx.currentTime) ids.add(id);
      else {
        release(fx);
        fxPlaying.delete(id);
      }
    }
    return ids;
  }

  // Step currently audible (0..31), or null. Scheduled time + output latency
  // is when a step actually leaves the speakers.
  function visibleStep() {
    if (!ctx || !cursor) return null;
    const heard = ctx.currentTime - (ctx.outputLatency || 0);
    let current = null;
    for (const s of queued) {
      if (s.time > heard) break;
      current = s.step;
    }
    return current;
  }

  /**
   * Renders offline what the engine would play, with the current data, BPM,
   * effects and DJ filter: `lanes` (a lane map, as setLanes takes) or one `fx`. A loop
   * render plays the loop twice and keeps the second pass, so the tails at
   * its end are already wrapped into its start and the file loops without a
   * seam. An FX render is the one-shot and its tail, trimmed at silence.
   * Resolves to { sampleRate, channels: [Float32Array, ...] }.
   */
  async function render({ lanes: desired = {}, fx = null }) {
    const stepDur = stepDuration(bpm);
    const loop = Math.round(LOOP_STEPS * stepDur * RENDER_RATE);
    const length = fx ? FX_RENDER_SECONDS * RENDER_RATE : 2 * loop;
    const off = createOffline(2, length, RENDER_RATE);
    const chain = buildChain(off, bpm, effects, djValue);
    const into = (level, layer, insert) => withInsert(off, connectGain(off, chain, level, layer), insert, stepDur, 0).input;
    if (fx) {
      const { level, insert } = dataOf(fx);
      fxVoice(off, into(LAYER_LEVEL.fx * level, "fx", insert), 0, stepDur, fx);
    } else {
      for (const [key, variant] of Object.entries(desired)) {
        const d = dataOf(variant);
        const input = into(laneLevel(key, variant), layerOf(variant), d.insert);
        for (let i = 0; i < 2 * LOOP_STEPS; i++) {
          for (const ev of eventsAt(variant, i % LOOP_STEPS, i === 0, d)) voice(off, input, i * stepDur, ev, stepDur);
        }
      }
    }
    const buffer = await off.startRendering();
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return {
      sampleRate: RENDER_RATE,
      channels: fx ? trimTail(channels, RENDER_RATE) : channels.map((d) => d.slice(loop, 2 * loop)),
    };
  }

  function stop() {
    stopLoop();
    if (!ctx) return;
    for (const fx of fxPlaying.values()) fadeOut(fx);
    fxPlaying.clear();
  }

  return {
    ensureContext,
    setLanes,
    setData,
    setEffects,
    setBpm,
    setMasterFilter,
    triggerFx,
    audition,
    previewSample,
    activeFx,
    visibleStep,
    stop,
    render,
    onBar: (fn) => {
      barHook = fn;
    },
    isRunning: () => timer !== null,
  };
}
