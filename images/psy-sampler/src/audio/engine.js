// Audio engine: owns the AudioContext, the output chain, the lookahead
// scheduler and one gain "lane" per playing variant.
//
//   lane gain ─┬──────────────────────> master (0.7) ─> compressor ─> limiter ─> trim ─> destination
//   fx gain  ──┤                                         ▲
//              ├─ delay send ─> delay 3/16 ─> return ────┤
//              └─ reverb send ─> convolver ─> return ────┘
//
// Lanes are what make changes click-free: a variant change or a stop never
// touches individual notes, it fades the whole lane out over FADE and opens a
// fresh one, so notes already queued for the old variant die inside the fade.
// Variant changes crossfade on the next step boundary (the old lane plays up
// to the exact step where the new one enters); a stop fades right away.
//
// What a variant plays is data (patterns.js) the UI can edit at any time:
// setData() swaps it and the scheduler reads it on the next step.
import { collectSteps, nextBeatTime, stepDuration, BPM_DEFAULT, LOOKAHEAD, SAFETY, TICK_MS } from "./timing.js";
import { DEFAULTS, auditionEvent, eventsAt } from "./patterns.js";
import { FX, VOICES } from "./voices.js";

const MASTER_GAIN = 0.7;
const OUTPUT_TRIM = 0.8;
const FADE = 0.03;
const START_DELAY = 0.06; // first step after start(): room for the first tick to land
const LAYER_LEVEL = { kick: 0.9, bass: 0.6, perc: 0.6, lead: 0.3, pad: 0.35, fx: 0.6 };
const BG_KICK_LEVEL = 0.6;
// Sends per layer, after the lane gain (so they follow its fades). Kick and
// bass stay dry: tails under them only muddy the low end.
const SENDS = {
  perc: { delay: 0, reverb: 0.12 },
  lead: { delay: 0.3, reverb: 0.25 },
  pad: { delay: 0, reverb: 0.4 },
  fx: { delay: 0.2, reverb: 0.35 },
};
const DELAY_STEPS = 3; // dotted 8th: the classic psy lead echo
const DELAY_FEEDBACK = 0.38;
// Returns feed the compressor directly, so they already carry the master level.
const RETURN_LEVEL = MASTER_GAIN;
const REVERB_SECONDS = 2.4;
const AUDITION_SECONDS = 1.5;

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

export function createEngine({ createContext = () => new AudioContext() } = {}) {
  let ctx = null;
  let master = null;
  let bus = null; // { delay, delaySend, delayReturn, reverbSend, reverbReturn }
  let bpm = BPM_DEFAULT;
  let timer = null;
  let cursor = null; // { step, time } of the next step to schedule; null when stopped
  let queued = []; // steps already scheduled, oldest first: step bar + lane backfill
  let effects = { delay: true, reverb: true };
  const lanes = new Map(); // lane key -> { variant, gain, level, entered }
  const fxPlaying = new Map(); // fx id -> { gain, end }
  const data = new Map(); // variant id -> edited data (factory data otherwise)

  const dataOf = (id) => data.get(id) ?? DEFAULTS[id].data;
  const laneLevel = (key, variant) =>
    (key === "bgKick" ? BG_KICK_LEVEL : LAYER_LEVEL[layerOf(variant)]) * dataOf(variant).level;

  // Must run synchronously inside a click handler: browsers only let an
  // AudioContext start (or resume) from a user gesture.
  function ensureContext() {
    if (!ctx) {
      ctx = createContext();
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
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(comp).connect(limiter).connect(trim).connect(ctx.destination);
      bus = buildBus(comp);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function buildBus(comp) {
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
    damp.connect(delayReturn).connect(comp);

    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx, REVERB_SECONDS);
    const reverbSend = ctx.createGain();
    reverbSend.connect(convolver);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = effects.reverb ? RETURN_LEVEL : 0;
    convolver.connect(reverbReturn).connect(comp);
    return { delay, delaySend, delayReturn, reverbSend, reverbReturn };
  }

  function scheduleLane(lane, step, time, stepDur) {
    for (const ev of eventsAt(lane.variant, step, !lane.entered, dataOf(lane.variant))) {
      VOICES[ev.voice](ctx, lane.gain, time, ev, stepDur);
    }
    lane.entered = true;
  }

  function tick() {
    const stepDur = stepDuration(bpm); // read every tick: the BPM slider applies live
    const { due, cursor: next } = collectSteps(cursor, ctx.currentTime, LOOKAHEAD, stepDur);
    cursor = next;
    for (const s of due) {
      for (const lane of lanes.values()) scheduleLane(lane, s.step, s.time, stepDur);
      queued.push(s);
    }
    const horizon = ctx.currentTime - 1;
    while (queued.length && queued[0].time < horizon) queued.shift();
  }

  function openGain(level, layer) {
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

  function openLane(key, variant) {
    const level = laneLevel(key, variant);
    const lane = { variant, level, gain: openGain(level, layerOf(variant)), entered: false };
    // Steps inside the lookahead window were queued before this lane existed.
    // Backfill them so the new variant enters on the very next step instead of
    // leaving a hole up to LOOKAHEAD long; steps closer than SAFETY are skipped
    // because they could start mid-envelope.
    if (cursor) {
      const stepDur = stepDuration(bpm);
      const earliest = ctx.currentTime + SAFETY;
      for (const s of queued) if (s.time >= earliest) scheduleLane(lane, s.step, s.time, stepDur);
    }
    return lane;
  }

  // Linear fade to 0 starting at `at`. Notes still queued on this gain play
  // into silence and stop themselves; the timeout only disconnects the node
  // for GC, it never times audio.
  function fadeOut(gain, at = ctx.currentTime) {
    gain.gain.cancelScheduledValues(at);
    gain.gain.setValueAtTime(gain.gain.value, at);
    gain.gain.linearRampToValueAtTime(0, at + FADE);
    setTimeout(() => {
      gain.disconnect();
      for (const send of gain.sends) send.disconnect();
    }, (at - ctx.currentTime + FADE + 0.05) * 1000);
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
    tick();
    timer = setInterval(tick, TICK_MS);
  }

  function stopLoop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    cursor = null;
    queued = [];
    for (const lane of lanes.values()) fadeOut(lane.gain);
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
    const at = cursor ? switchTime() : ctx.currentTime;
    for (const [key, lane] of lanes) {
      if (desired[key] !== lane.variant) {
        fadeOut(lane.gain, at);
        lanes.delete(key);
      }
    }
    for (const [key, variant] of wanted) {
      if (!lanes.has(key)) lanes.set(key, openLane(key, variant));
    }
    if (timer === null) start();
  }

  /**
   * Swap the data a variant plays. Notes and params apply from the next
   * scheduled step; a volume change glides the lanes playing it (20 ms) so
   * the slider never zips.
   */
  function setData(id, next) {
    data.set(id, next);
    if (!ctx) return;
    for (const [key, lane] of lanes) {
      if (lane.variant !== id) continue;
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
    if (bus) bus.delay.delayTime.setTargetAtTime(DELAY_STEPS * stepDuration(bpm), ctx.currentTime, 0.05);
  }

  // One-shot FX: on the next beat while the loop runs, right away otherwise.
  // Retriggering an FX that is still sounding fades the previous instance.
  function triggerFx(id) {
    ensureContext();
    const stepDur = stepDuration(bpm);
    const t = cursor ? nextBeatTime(cursor, stepDur) : ctx.currentTime + START_DELAY;
    const prev = fxPlaying.get(id);
    if (prev) fadeOut(prev.gain);
    const { params, level } = dataOf(id);
    const gain = openGain(LAYER_LEVEL.fx * level, "fx");
    const end = FX[id](ctx, gain, t, stepDur, params);
    fxPlaying.set(id, { gain, end });
    return { start: t, end };
  }

  // Preview of one note or hit from the editor, right now and off the grid.
  function audition(id, note) {
    ensureContext();
    const ev = auditionEvent(id, dataOf(id), note);
    if (!ev) return;
    const layer = layerOf(id);
    const gain = openGain(LAYER_LEVEL[layer] * dataOf(id).level, layer);
    const t = ctx.currentTime + SAFETY;
    VOICES[ev.voice](ctx, gain, t, ev, stepDuration(bpm));
    fadeOut(gain, t + AUDITION_SECONDS);
  }

  // Ids of FX still sounding; finished ones are released here.
  function activeFx() {
    const ids = new Set();
    if (!ctx) return ids;
    for (const [id, fx] of fxPlaying) {
      if (fx.end > ctx.currentTime) ids.add(id);
      else {
        fx.gain.disconnect();
        for (const send of fx.gain.sends) send.disconnect();
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

  function stop() {
    stopLoop();
    if (!ctx) return;
    for (const fx of fxPlaying.values()) fadeOut(fx.gain);
    fxPlaying.clear();
  }

  return {
    ensureContext,
    setLanes,
    setData,
    setEffects,
    setBpm,
    triggerFx,
    audition,
    activeFx,
    visibleStep,
    stop,
    isRunning: () => timer !== null,
  };
}
