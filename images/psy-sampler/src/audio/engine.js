// Audio engine: owns the AudioContext, the output chain, the lookahead
// scheduler and one gain "lane" per playing variant.
//
//   notes ─> lane input ─> insert ─> lane gain ─┬─> master (0.7) ─> DJ filter ─> sweep ─> mastering ─> brake ─> out ─> volume ─> destination
//                                   fx gain  ───┤                      ▲
//                                               ├─ delay send ─> delay 3/16 ─> return ─┤
//                                               └─ reverb send ─> convolver ─> return ─┘
//
// The insert is the variant's own filter + distortion + pan (insert.js); FX
// shots and auditions get one too. Between the insert and the lane gain sits
// a ducker: every kick lane also feeds a sidechain whose envelope pulls the
// ducker's gain down on each kick, by the variant's `duck`. A variant using a sample plays it through
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
// setData() swaps it and the scheduler reads it on the next step. setKey()
// moves every note to the mix's tonic the same way: notes already sounding
// ring out in the old key.
//
// Tap sync: restart() takes the loop back to its first step at a tap, and
// align() moves the grid onto the beat the taps lay down (tempo.js).
//
// tap() hands out what `out` sends to the volume, for recording: the
// listener's volume knob (setVolume) never reaches a take or the visuals.
// It taps a microphone the same way, for a sample.
//
// listen() reports what the scheduler queues, with its audio time, for the
// visuals: every lane's hits per step, bar lines, lane changes, FX shots, the
// build's sweep and the drop. Hits are reported as they are queued, so they
// arrive up to LOOKAHEAD (LOOKAHEAD_HIDDEN in a hidden tab) early; perfTimeOf() turns their time into the
// performance.now() moment they leave the speakers.
//
// The arrangement has two moves of its own, never stored: sweep() runs a
// highpass up the whole mix into a drop and sweepOff() snaps it open on the
// drop; setPump() gives every lane of a layer at least that much sidechain.
import {
  alignCursor,
  collectSteps,
  nextBeatTime,
  stepDuration,
  BAR_STEPS,
  BPM_DEFAULT,
  BPM_MIN,
  LOOKAHEAD,
  LOOKAHEAD_HIDDEN,
  LOOP_STEPS,
  SAFETY,
  TICK_MS,
} from "./timing.js";
import { DJ_Q, INSERT_DEFAULT, buildInsert, djCutoffs, kindOf } from "./insert.js";
import { trimOf } from "./loudness.js";
import { buildMaster } from "./master.js";
import { KEY_DEFAULT, keyShift } from "./music.js";
import { auditionEvent, baseOf, defOf, eventsAt, partSteps, sampleDefaults } from "./patterns.js";
import { fadesOnly, ringing, shaped } from "./shape.js";
import { FX, VOICES, sample } from "./voices.js";
import { trimTail } from "./wav.js";
import TAP_URL from "./tap.worklet.js?url&no-inline";

const MASTER_GAIN = 0.7;
const FADE = 0.03;
const START_DELAY = 0.06; // first step after start(): room for the first tick to land
const LAYER_LEVEL = { kick: 0.9, bass: 0.45, perc: 0.85, lead: 0.3, pad: 0.35, glitch: 0.3, classic: 0.4, fx: 0.6 };
const BG_KICK_LEVEL = 0.6;
// Sends per layer, after the lane gain (so they follow its fades). Kick and
// bass stay dry: tails under them only muddy the low end.
const SENDS = {
  perc: { delay: 0, reverb: 0.12 },
  lead: { delay: 0.3, reverb: 0.25 },
  pad: { delay: 0, reverb: 0.4 },
  glitch: { delay: 0.25, reverb: 0.15 },
  classic: { delay: 0.3, reverb: 0.25 },
  fx: { delay: 0.2, reverb: 0.35 },
};
const DELAY_STEPS = 3; // dotted 8th: the classic psy lead echo
const DELAY_FEEDBACK = 0.38;
// Returns join after the master gain (into the DJ filter), so they carry its level.
const RETURN_LEVEL = MASTER_GAIN;
const REVERB_SECONDS = 2.4;
const AUDITION_SECONDS = 1.5;
const RENDER_RATE = 48000;
// Longest FX (4 bars, params.js `length`, at the slowest BPM: 16 s at 60) plus
// its tail (impact, delay and reverb); the silence after the sound is trimmed off.
const FX_MAX_BARS = 4;
const FX_TAIL_SECONDS = 4.6;
const FX_RENDER_SECONDS = Math.ceil(FX_MAX_BARS * BAR_STEPS * stepDuration(BPM_MIN) + FX_TAIL_SECONDS);
// The mastering compressors start as if out of a full-scale signal and settle
// in ~150 ms (measured in Chrome), so an FX render plays that late and drops
// the wait. A loop render keeps its second pass anyway.
const RENDER_SETTLE = 0.2;
// The editor's waveform only has to look right.
const SKETCH_RATE = 22050;
// Sidechain: the kick, rectified and clipped to 0..1 (DUCK_DRIVE: its body
// already reads as full), then smoothed into an envelope by a lowpass this
// slow, which sets the pump's attack and release.
const DUCK_DRIVE = 8;
const DUCK_HZ = 8;
const DUCK_CURVE = Float32Array.from({ length: 1025 }, (_, i) => Math.min(1, DUCK_DRIVE * Math.abs(i / 512 - 1)));
// The drop's sweep: a highpass after the DJ filter, an identity at 0 Hz like
// the DJ's. It rises exponentially from SWEEP_FROM (an exponential ramp can't
// start at 0) to SWEEP_TO, the low end draining out of the mix, and on the
// drop glides back to SWEEP_FROM over SWEEP_SNAP before the identity: a jump
// in a biquad's coefficients under a full mix can click. Q is in dB for a
// highpass: 0 dB is a linear Q of 1, a ~1.25 dB bump that rides up with the
// cutoff (the sweep you hear) and passes the kick's fundamental early on, so
// no more than that, or the limiter eats the roll.
const SWEEP_FROM = 30;
const SWEEP_TO = 900;
const SWEEP_Q = 0;
const SWEEP_SNAP = 0.015;
// The vinyl brake: at most this long (s; 8 bars down to 80 BPM), its delay
// line half as long; the level holds for the first BRAKE_HOLD of it, then
// falls with the platter.
const BRAKE_MAX = 24;
const BRAKE_HOLD = 0.7;
const BRAKE_POINTS = 64;

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

// Output chain: master -> DJ filter -> sweep -> mastering (master.js) ->
// brake -> out -> volume -> destination, plus the shared delay and reverb buses (their
// returns go through the DJ filter, the sweep and the mastering too). Built once per
// context, live or offline; a render keeps the sweep open and never brakes.
// The brake is a delay line at 0 and a gain at 1 until brake() slows the
// whole mix down like a vinyl.
function buildChain(ctx, bpm, effects, djValue = 0) {
  const mastering = buildMaster(ctx);
  const out = ctx.createGain();
  const volume = ctx.createGain();
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
  const sweep = ctx.createBiquadFilter();
  sweep.type = "highpass";
  sweep.frequency.value = 0;
  sweep.Q.value = SWEEP_Q;
  const bus = buildBus(ctx, dj.low, bpm, effects);
  const brake = { line: ctx.createDelay(BRAKE_MAX / 2 + 0.1), gain: ctx.createGain() };
  master.connect(dj.low).connect(dj.high).connect(sweep).connect(mastering.input);
  mastering.output.connect(brake.line).connect(brake.gain).connect(out).connect(volume).connect(ctx.destination);
  return { master, dj, sweep, brake, out, volume, bus, side: buildSidechain(ctx) };
}

// The kick lanes' sum in `input`, its envelope out of `env` (never heard).
function buildSidechain(ctx) {
  const input = ctx.createGain();
  const rectify = ctx.createWaveShaper();
  rectify.curve = DUCK_CURVE;
  const env = ctx.createBiquadFilter();
  env.type = "lowpass";
  env.frequency.value = DUCK_HZ;
  env.Q.value = 0.5; // no overshoot: the envelope stays inside 0..1
  input.connect(rectify).connect(env);
  return { input, env };
}

// The sidechain envelope into `holder`'s ducker, at -amount. A kick never
// ducks itself: kick -> sidechain -> kick would be a cycle without a delay.
function duckWith(ctx, holder, side, amount, now = null) {
  if (!holder.depth) {
    if (!amount) return;
    holder.depth = ctx.createGain();
    holder.depth.gain.value = now === null ? -amount : 0;
    side.env.connect(holder.depth).connect(holder.ducker.gain);
    holder.side = side;
  }
  if (now !== null) holder.depth.gain.setTargetAtTime(-amount, now, 0.02);
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

// A lane or FX gain into the master, with its layer's effect sends. A kick
// also feeds the sidechain.
function connectGain(ctx, { master, bus, side }, level, layer) {
  const gain = ctx.createGain();
  gain.gain.value = level;
  gain.connect(master);
  if (layer === "kick") gain.connect(side.input);
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

// Notes connect to `input`; its insert chain feeds `gain` through the
// ducker. Used by lanes, FX shots and auditions alike.
function withInsert(ctx, gain, insert, stepDur, at) {
  const input = ctx.createGain();
  const chain = buildInsert(ctx, insert, { stepDur, at });
  const ducker = ctx.createGain();
  input.connect(chain.input);
  chain.output.connect(ducker).connect(gain);
  return { gain, input, chain, ducker, depth: null };
}

// A buffer's channels averaged into one, back to front when `reverse`.
function mono(buffer, reverse) {
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return reverse ? out.reverse() : out;
}

// Calls `fn` every `ms` from a worker, whose timers a background tab does not
// throttle; returns its stop(), or null where there are no workers.
function workerClock(ms, fn) {
  if (typeof Worker === "undefined") return null;
  const worker = new Worker(new URL("./clock.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = fn;
  worker.postMessage(ms);
  return () => worker.terminate();
}

export function createEngine({
  createContext = () => new AudioContext(),
  createOffline = (channels, length, rate) => new OfflineAudioContext(channels, length, rate),
  createWorklet = (c, name, options) => new AudioWorkletNode(c, name, options),
  sampleBuffer = () => null, // sample id -> decoded AudioBuffer, or null while it is not there
  createClock = workerClock,
  hidden = () => globalThis.document?.hidden ?? false,
} = {}) {
  let ctx = null;
  let master = null;
  let out = null; // the mix before the listener's volume
  let volumeGain = null;
  let volumeValue = 1;
  let tapModule = null; // addModule()'s promise, once per context
  let dj = null; // { low, high }: the DJ filter's two biquads
  let djValue = 0;
  let sweepFilter = null; // the drop's highpass
  let brakeNodes = null; // { line, gain }: the vinyl brake (buildChain)
  let sweepLine = null; // { start, end, to }: the sweep on its way up, or holding at `to`
  let pump = {}; // layer -> the least duck its lanes get (the arrangement's sidechain)
  let bus = null; // { delay, delaySend, delayReturn, reverbSend, reverbReturn }
  let side = null; // the kick sidechain: { input, env }
  let bpm = BPM_DEFAULT;
  let keyRatio = 1; // what the tonic (setKey) does to every note's frequency
  let timer = null;
  let stopClock = null; // the worker clock's, next to the page's own timer
  let cursor = null; // { step, time, loop } of the next step to schedule; null when stopped
  let queued = []; // steps already scheduled, oldest first: step bar + lane backfill
  let effects = { delay: true, reverb: true };
  let barHook = null; // (time, step, bar) -> desired lanes | undefined
  let bars = 0; // bar lines queued since start(); the first one is 0
  let stopAt = null; // a bar-line stop: the timer ends once this time passes
  let played = 0; // seconds the loop ran in earlier runs, by the audio clock
  let runFrom = 0; // audio time the current run started
  const lanes = new Map(); // lane key -> { variant, gain, input, chain, level, entered, from }
  const fxPlaying = new Map(); // fx id -> { gain, input, chain, end }
  const data = new Map(); // variant id -> edited data (factory data otherwise)
  const volumes = new Map(); // layer id -> its fader over every sound in it (1 otherwise)
  let solo = null; // the variant heard alone while its 🎧 is held
  const listeners = new Set(); // listen()'s callbacks
  let analyser = null; // levels for the visuals, off `out`; made on first ask

  const emit = (event) => {
    for (const fn of listeners) fn(event);
  };

  const dataOf = (id) => data.get(id) ?? defOf(id).data;
  // A note in the mix's key. Hits carry no `freq`: a drum stays where it is.
  const keyed = (ev) => (ev.freq && keyRatio !== 1 ? { ...ev, freq: ev.freq * keyRatio } : ev);
  const volumeOf = (layer) => volumes.get(layer) ?? 1;
  // The layer's level, the sound's own by ear (loudness.js), its layer fader and its volume.
  const laneLevel = (key, variant) =>
    (key === "bgKick" ? BG_KICK_LEVEL : LAYER_LEVEL[layerOf(variant)]) *
    trimOf(variant, dataOf(variant)) *
    volumeOf(layerOf(variant)) *
    dataOf(variant).level;
  const shotLevel = (id) => LAYER_LEVEL[layerOf(id)] * trimOf(id, dataOf(id)) * volumeOf(layerOf(id)) * dataOf(id).level;
  // What the speakers get: a solo silences everything else. Renders skip it.
  const heard = (id, level) => (solo === null || solo === id ? level : 0);
  const liveLane = (key, variant) => heard(variant, laneLevel(key, variant));
  const liveShot = (id) => heard(id, shotLevel(id));

  // Must run synchronously inside a click handler: browsers only let an
  // AudioContext start (or resume) from a user gesture.
  function ensureContext() {
    if (!ctx) {
      ctx = createContext();
      ({ master, dj, sweep: sweepFilter, brake: brakeNodes, out, volume: volumeGain, bus, side } = buildChain(ctx, bpm, effects, djValue));
      volumeGain.gain.value = volumeValue ** 2;
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One event on any context, through its sound's `shape` (shape.js). A
  // sample plays only once it is decoded.
  function voice(c, out, t, ev, stepDur, shape) {
    if (ev.voice !== "sample") return shaped(c, out, t, shape, (into, cx) => VOICES[ev.voice](cx, into, t, ev, stepDur));
    const buffer = sampleBuffer(ev.sample.id);
    return buffer
      ? shaped(c, out, t, fadesOnly(shape), (into, cx) => sample(cx, into, t, { ...ev, buffer }, stepDur))
      : shaped(c, out, t, shape, (into, cx) => VOICES[ev.fallback](cx, into, t, ev, stepDur));
  }

  // An FX shot: its sample if it has one and it is loaded, else its synth.
  function fxVoice(c, out, t, stepDur, id, shape = dataOf(id).shape) {
    const { params, sample: s } = dataOf(id);
    const buffer = s && sampleBuffer(s.id);
    return buffer
      ? shaped(c, out, t, fadesOnly(shape), (into, cx) => sample(cx, into, t, { sample: s, buffer }, stepDur))
      : shaped(c, out, t, shape, (into, cx) => FX[baseOf(id)](cx, into, t, stepDur, params));
  }

  // A ratchet's repeats (and a swung 16th) land `offset` steps after their
  // step; a nudge moves them all, but never closer than SAFETY.
  // A lane's `from` is the bar it came in on (absolute steps from ▶), where
  // a part longer than a loop starts.
  function scheduleLane(lane, { step, time, loop }, stepDur) {
    const d = dataOf(lane.variant);
    const nudge = (d.nudge ?? 0) / 1000;
    const earliest = ctx.currentTime + SAFETY;
    lane.from ??= Math.floor((loop * LOOP_STEPS + step) / BAR_STEPS) * BAR_STEPS;
    let first = null;
    let accent = false;
    let count = 0;
    for (const ev of eventsAt(lane.variant, step, !lane.entered, d, loop, lane.from)) {
      const t = Math.max(earliest, time + (ev.offset ?? 0) * stepDur + nudge);
      lane.chain.trigger(t);
      voice(ctx, lane.input, t, keyed(ev), stepDur, d.shape);
      first = first === null ? t : Math.min(first, t);
      accent ||= Boolean(ev.accent);
      count++;
    }
    lane.entered = true;
    if (count && listeners.size) {
      emit({ kind: "hit", layer: layerOf(lane.variant), variant: lane.variant, time: first, accent, count, level: lane.level });
    }
  }

  function queueStep(s, stepDur) {
    if (s.step % BAR_STEPS === 0) {
      atBar(s);
      emit({ kind: "bar", time: s.time, bar: (s.loop * LOOP_STEPS + s.step) / BAR_STEPS, bpm });
    }
    for (const lane of lanes.values()) scheduleLane(lane, s, stepDur);
    queued.push(s);
  }

  function tick() {
    const stepDur = stepDuration(bpm); // read every tick: the BPM slider applies live
    const ahead = hidden() ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
    const { due, cursor: next } = collectSteps(cursor, ctx.currentTime, ahead, stepDur);
    cursor = next;
    for (const s of due) queueStep(s, stepDur);
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

  const openGain = (level, layer) => connectGain(ctx, { master, bus, side }, level, layer);
  const duckOf = (variant) =>
    layerOf(variant) === "kick" ? 0 : Math.max(dataOf(variant).duck ?? 0, pump[layerOf(variant)] ?? 0);

  // Gain + input + insert, the insert's LFO starting at `at`.
  const openVoice = (level, layer, insert, at) =>
    withInsert(ctx, openGain(level, layer), insert, stepDuration(bpm), at);

  function openLane(key, variant, backfill, at) {
    const level = liveLane(key, variant);
    const lane = { variant, level, ...openVoice(level, layerOf(variant), dataOf(variant).insert, at), entered: false };
    duckWith(ctx, lane, side, duckOf(variant));
    // Steps inside the lookahead window were queued before this lane existed.
    // Backfill them so the new variant enters on the very next step instead of
    // leaving a hole up to LOOKAHEAD long; steps closer than SAFETY are skipped
    // because they could start mid-envelope.
    if (cursor && backfill) {
      const stepDur = stepDuration(bpm);
      const earliest = ctx.currentTime + SAFETY;
      for (const s of queued) if (s.time >= earliest) scheduleLane(lane, s, stepDur);
    }
    return lane;
  }

  // Linear fade to 0 starting at `at`. Notes still queued on this gain play
  // into silence and stop themselves; the timeout only disconnects the nodes
  // for GC, it never times audio.
  function fadeOut(holder, at = ctx.currentTime) {
    const { gain } = holder;
    pin(holder, at);
    gain.gain.linearRampToValueAtTime(0, at + FADE);
    holder.chain.stop(at + FADE);
    setTimeout(() => release(holder), (at - ctx.currentTime + FADE + 0.05) * 1000);
  }

  // Clears a gain's automation from `at` on and holds the value it has then;
  // returns it. A volume line still running is cut where it is, not undone.
  function pin(holder, at) {
    const param = holder.gain.gain;
    const line = holder.line;
    holder.line = null;
    const now = ctx.currentTime;
    if (!line || line.end <= now) {
      param.cancelScheduledValues(at);
      param.setValueAtTime(param.value, at);
      return param.value;
    }
    const valueAt = (t) => line.from + ((line.to - line.from) * Math.min(1, (t - line.start) / (line.end - line.start)));
    param.cancelScheduledValues(now);
    param.setValueAtTime(valueAt(now), now);
    if (at > now) param.linearRampToValueAtTime(valueAt(at), at);
    return valueAt(Math.max(at, now));
  }

  // A lane's gain to `value`: a quick glide (time constant `tau`), or a
  // straight line over `ramp` seconds.
  function moveGain(lane, value, tau, ramp = 0) {
    const now = ctx.currentTime;
    if (!ramp) {
      if (lane.line) pin(lane, now);
      lane.gain.gain.setTargetAtTime(value, now, tau);
      return;
    }
    const from = pin(lane, now);
    lane.gain.gain.linearRampToValueAtTime(value, now + ramp);
    lane.line = { from, to: value, start: now, end: now + ramp };
  }

  function release({ gain, input, chain, ducker, depth, side: from }) {
    gain.disconnect();
    for (const send of gain.sends) send.disconnect();
    input.disconnect();
    chain.output.disconnect();
    ducker.disconnect();
    if (depth) {
      from.env.disconnect(depth);
      depth.disconnect();
    }
  }

  // A filter or distortion type changed: a fresh chain crossfades in at `now`.
  function swapInsert(lane, insert, now = ctx.currentTime) {
    const old = lane.chain;
    const next = buildInsert(ctx, insert, { stepDur: stepDuration(bpm), at: now });
    next.output.gain.value = 0;
    next.output.gain.setValueAtTime(0, now);
    next.output.gain.linearRampToValueAtTime(1, now + FADE);
    lane.input.connect(next.input);
    next.output.connect(lane.ducker);
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
    }, (now - ctx.currentTime + FADE + 0.05) * 1000);
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
    unbrake();
    runFrom = ctx.currentTime;
    cursor = { step: 0, time: ctx.currentTime + START_DELAY, loop: 0 };
    queued = [];
    bars = 0;
    stopAt = null;
    tick();
    // Both clocks drive the same tick, which only queues what is due: the
    // page's covers the worker's start-up, the worker's a background tab.
    timer = setInterval(tick, TICK_MS);
    stopClock = createClock(TICK_MS, () => cursor && tick());
  }

  // The audio time of what leaves the speakers at `heard`, a performance.now()
  // time such as an input event's timeStamp. getOutputTimestamp() pairs the two
  // clocks and counts the output latency; without it, the latency the context
  // reports.
  function audioTimeAt(heard) {
    const out = ctx.getOutputTimestamp?.();
    if (out?.performanceTime > 0) return out.contextTime + (heard - out.performanceTime) / 1000;
    return ctx.currentTime - (ctx.outputLatency || 0) + (heard - performance.now()) / 1000;
  }

  /**
   * Tap sync: the loop starts over from its first step, the 1 heard at `heard`
   * (ms, performance.now()), as a fresh ▶ would. That moment has passed by the
   * time the tap gets here, so the 1 plays as soon as it safely can and the
   * steps after it fall on the grid that starts at the tap. Every lane fades
   * and reopens there, so what the old grid had queued does not flam on top.
   */
  function restart(heard) {
    if (!cursor || lanes.size === 0) return;
    const zero = audioTimeAt(heard);
    const at = Math.max(zero, ctx.currentTime + SAFETY);
    const playing = Object.fromEntries([...lanes].map(([key, lane]) => [key, lane.variant]));
    for (const lane of lanes.values()) fadeOut(lane, at);
    lanes.clear();
    reconcile(playing, at, false);
    queued = queued.filter((s) => s.time < at);
    bars = 0;
    stopAt = null;
    const stepDur = stepDuration(bpm);
    queueStep({ step: 0, time: at, loop: 0 }, stepDur);
    cursor = { step: 1, time: zero + stepDur, loop: 0 };
  }

  /**
   * Tap sync: from the next step on, the loop runs on the grid whose step 0
   * was heard at `heard` (ms, performance.now()), at the current BPM. Notes
   * already queued keep their time, so the seam is at most half a step off.
   */
  function align(heard) {
    if (cursor) cursor = alignCursor(cursor, audioTimeAt(heard), stepDuration(bpm));
  }

  function stopLoop() {
    if (timer !== null) {
      clearInterval(timer);
      stopClock?.();
      played += ctx.currentTime - runFrom;
    }
    timer = null;
    stopClock = null;
    cursor = null;
    queued = [];
    stopAt = null;
    for (const lane of lanes.values()) fadeOut(lane);
    lanes.clear();
    if (!ctx) return;
    sweepOff(ctx.currentTime + FADE); // open again as the lanes fade
    emit({ kind: "stop", time: ctx.currentTime });
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
    emit({ kind: "lanes", time: at, variants: [...lanes.values()].map((l) => l.variant) });
  }

  /**
   * Swap the data a variant plays. Notes and params apply from the next
   * scheduled step; a volume change glides the lanes playing it (20 ms, or
   * in a straight line over `ramp` seconds) so the slider never zips, and so
   * do the insert's knobs (its tone filters in an exponential line over
   * `ramp`). The insert changes at audio time `at` when one is given (a bar
   * line the scheduler is queuing), else now.
   */
  function setData(id, next, ramp = 0, at = 0) {
    data.set(id, next);
    if (!ctx) return;
    const when = Math.max(at, ctx.currentTime);
    for (const [key, lane] of lanes) {
      if (lane.variant !== id) continue;
      if (kindOf(next.insert) === lane.chain.kind) lane.chain.update(next.insert, when, ramp);
      else swapInsert(lane, next.insert, when);
      duckWith(ctx, lane, side, duckOf(id), ctx.currentTime);
      const level = liveLane(key, id);
      if (level === lane.level) continue;
      lane.level = level;
      moveGain(lane, level, 0.02, ramp);
    }
  }

  // A layer's fader: the lanes and FX shots of that layer glide to it (20 ms).
  function setLayerVolume(layer, value) {
    volumes.set(layer, value);
    if (!ctx) return;
    for (const [key, lane] of lanes) {
      if (layerOf(lane.variant) !== layer) continue;
      lane.level = liveLane(key, lane.variant);
      moveGain(lane, lane.level, 0.02);
    }
    if (layer !== "fx") return;
    for (const [id, fx] of fxPlaying) {
      if (fx.end > ctx.currentTime) fx.gain.gain.setTargetAtTime(liveShot(id), ctx.currentTime, 0.02);
    }
  }

  // Hear one variant alone (null: everything again). Every other lane and FX
  // shot glides to silence and back (10 ms) and keeps playing underneath, so
  // letting go drops back in on the grid. Its echoes and reverb tails ring out.
  function setSolo(id) {
    solo = id;
    if (!ctx) return;
    for (const [key, lane] of lanes) {
      lane.level = liveLane(key, lane.variant);
      moveGain(lane, lane.level, 0.01);
    }
    for (const [fxId, fx] of fxPlaying) {
      if (fx.end > ctx.currentTime) fx.gain.gain.setTargetAtTime(liveShot(fxId), ctx.currentTime, 0.01);
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

  // The mix's tonic, a pitch class (music.js KEYS). Takes on the next note.
  function setKey(key = KEY_DEFAULT) {
    keyRatio = 2 ** (keyShift(key) / 12);
  }

  // The DJ filter knob, -1 (lowpass closed) .. 0 (open) .. 1 (highpass up).
  function setMasterFilter(value) {
    djValue = value;
    if (!dj) return;
    const { low, high } = djCutoffs(value, ctx.sampleRate / 2);
    dj.low.frequency.setTargetAtTime(low, ctx.currentTime, 0.03);
    dj.high.frequency.setTargetAtTime(high, ctx.currentTime, 0.03);
  }

  // The master volume, 0..1: squared into the gain, so the knob's travel
  // follows loudness. Only the speakers hear it.
  function setVolume(value) {
    volumeValue = value;
    if (volumeGain) volumeGain.gain.setTargetAtTime(value ** 2, ctx.currentTime, 0.02);
  }

  /**
   * The drop's sweep: from `at` the whole mix goes through a highpass rising
   * exponentially to `to` Hz at `end`, where it holds until sweepOff(). Only
   * while the loop runs: a render never has it.
   */
  function sweep(at, end, to = SWEEP_TO) {
    if (!ctx) return;
    const f = sweepFilter.frequency;
    const start = Math.max(at, ctx.currentTime);
    if (sweepLine) sweepOff(start); // one still up comes down first, landing where this one starts
    else f.cancelScheduledValues(start);
    f.setValueAtTime(SWEEP_FROM, start);
    f.exponentialRampToValueAtTime(to, Math.max(end, start + SWEEP_SNAP));
    sweepLine = { start, end: Math.max(end, start + SWEEP_SNAP), to };
    emit({ kind: "build", time: start, end: sweepLine.end });
  }

  /**
   * The drop: the sweep glides from wherever it is down to SWEEP_FROM, landing
   * on `at`, and opens to an identity there. A drop that comes early (a BPM
   * ramp) cuts the rise where it is, the way pin() cuts a volume line.
   */
  function sweepOff(at) {
    const line = sweepLine;
    sweepLine = null;
    if (!ctx || !line) return;
    const f = sweepFilter.frequency;
    const now = ctx.currentTime;
    const t = Math.max(at ?? now, now);
    f.cancelScheduledValues(now);
    if (now < line.start) {
      f.setValueAtTime(0, now); // it had not started rising: nothing to glide
      return;
    }
    const valueAt = (x) => SWEEP_FROM * (line.to / SWEEP_FROM) ** Math.min(1, (x - line.start) / (line.end - line.start));
    f.setValueAtTime(valueAt(now), now);
    const glide = t - SWEEP_SNAP;
    if (glide > now) f.exponentialRampToValueAtTime(valueAt(glide), glide);
    f.exponentialRampToValueAtTime(SWEEP_FROM, t);
    f.setValueAtTime(0, t);
  }

  // The drop as the arrangement calls it: the visuals hear about it, a
  // re-sweep or a stop lowering the sweep does not.
  function drop(at) {
    if (sweepLine && timer !== null) emit({ kind: "drop", time: Math.max(at ?? ctx.currentTime, ctx.currentTime) });
    sweepOff(at);
  }

  /**
   * A vinyl brake on everything that plays, from `at` over `seconds`: the
   * platter slows to a stop, so the pitch and the tempo fall to nothing. A
   * delay line stretches under the mix (its delay grows as t²/2T: its slope,
   * one minus the speed, climbs from 0 to 1) and the level goes with it.
   * Longer than BRAKE_MAX, it starts late, so it still stops at the end.
   * Held until unbrake() or the next start().
   */
  function brake(at, seconds) {
    if (!ctx || !brakeNodes) return;
    const span = Math.min(BRAKE_MAX, Math.max(0.05, seconds));
    const t0 = Math.max(at + seconds - span, ctx.currentTime);
    const curve = Float32Array.from({ length: BRAKE_POINTS }, (_, i) => {
      const t = (i / (BRAKE_POINTS - 1)) * span;
      return (t * t) / (2 * span);
    });
    const { line, gain } = brakeNodes;
    line.delayTime.cancelScheduledValues(t0);
    line.delayTime.setValueAtTime(0, t0);
    line.delayTime.setValueCurveAtTime(curve, t0, span);
    gain.gain.cancelScheduledValues(t0);
    gain.gain.setValueAtTime(1, t0 + span * BRAKE_HOLD);
    gain.gain.linearRampToValueAtTime(0, t0 + span);
    emit({ kind: "brake", time: t0, end: t0 + span });
  }

  /** The brake let go of: the mix plays at its speed and level again, now. */
  function unbrake() {
    if (!ctx || !brakeNodes) return;
    const now = ctx.currentTime;
    for (const param of [brakeNodes.line.delayTime, brakeNodes.gain.gain]) param.cancelScheduledValues(now);
    brakeNodes.line.delayTime.setValueAtTime(0, now);
    brakeNodes.gain.gain.setValueAtTime(1, now);
  }

  /** The end of a set going wild from `at` to `end`: only the visuals hear it. */
  function frenzy(at, end) {
    if (ctx && timer !== null) emit({ kind: "frenzy", time: Math.max(at, ctx.currentTime), end });
  }

  /**
   * The arrangement's pump: per layer, the least duck every lane of it gets
   * from `at` on (its own duck when that is deeper). Kicks never duck. Renders
   * use it too, like any duck.
   */
  function setPump(next, at) {
    pump = { ...next };
    if (!ctx) return;
    const t = Math.max(at ?? ctx.currentTime, ctx.currentTime);
    for (const lane of lanes.values()) duckWith(ctx, lane, side, duckOf(lane.variant), t);
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
    const shot = openVoice(liveShot(id), "fx", dataOf(id).insert, t);
    shot.chain.trigger(t);
    const end = fxVoice(ctx, shot.input, t, stepDur, id);
    shot.chain.stop(end + FADE);
    fxPlaying.set(id, { ...shot, end });
    emit({ kind: "fx", id, time: t, end });
    return { start: t, end };
  }

  // Preview of one note or hit from the editor, right now and off the grid.
  function audition(id, note) {
    ensureContext();
    const ev = auditionEvent(id, dataOf(id), note);
    if (!ev) return;
    const layer = layerOf(id);
    const t = ctx.currentTime + SAFETY;
    const shot = openVoice(shotLevel(id), layer, dataOf(id).insert, t);
    shot.chain.trigger(t);
    voice(ctx, shot.input, t, keyed(ev), stepDuration(bpm), dataOf(id).shape);
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

  // The queued step audible now, or null. Scheduled time + output latency
  // is when a step actually leaves the speakers.
  function visible() {
    if (!ctx || !cursor) return null;
    const heard = ctx.currentTime - (ctx.outputLatency || 0);
    let current = null;
    for (const s of queued) {
      if (s.time > heard) break;
      current = s;
    }
    return current;
  }

  /**
   * Renders offline what the engine would play, with the current data, BPM,
   * effects and DJ filter: `lanes` (a lane map, as setLanes takes) or one `fx`. A loop
   * render (as long as its longest part: a loop, or a whole melody several loops
   * long) plays twice and keeps the second pass, so the tails at
   * its end are already wrapped into its start and the file loops without a
   * seam. An FX render is the one-shot and its tail, trimmed at silence.
   * Resolves to { sampleRate, channels: [Float32Array, ...] }.
   */
  async function render({ lanes: desired = {}, fx = null }) {
    const stepDur = stepDuration(bpm);
    const long = Object.values(desired).map(dataOf).filter((d) => (d.loops ?? 1) > 1);
    const span = Math.max(LOOP_STEPS, ...long.map((d) => partSteps(d) / (d.speed ?? 1)));
    const loop = Math.round(span * stepDur * RENDER_RATE);
    const settle = fx ? Math.round(RENDER_SETTLE * RENDER_RATE) : 0;
    const length = fx ? FX_RENDER_SECONDS * RENDER_RATE + settle : 2 * loop;
    const off = createOffline(2, length, RENDER_RATE);
    const chain = buildChain(off, bpm, effects, djValue);
    const into = (level, layer, insert, duck = 0, at = 0) => {
      const holder = withInsert(off, connectGain(off, chain, level, layer), insert, stepDur, at);
      duckWith(off, holder, chain.side, duck);
      return holder;
    };
    if (fx) {
      const at = settle / RENDER_RATE;
      const shot = into(shotLevel(fx), "fx", dataOf(fx).insert, 0, at);
      shot.chain.trigger(at);
      fxVoice(off, shot.input, at, stepDur, fx);
    } else {
      for (const [key, variant] of Object.entries(desired)) {
        const d = dataOf(variant);
        const { input, chain: insert } = into(laneLevel(key, variant), layerOf(variant), d.insert, duckOf(variant));
        const nudge = (d.nudge ?? 0) / 1000;
        // The kept pass starts on loop 0, so mods sound as on the first loop after ▶.
        for (let i = 0; i < 2 * span; i++) {
          const loop = Math.floor((i - span) / LOOP_STEPS);
          for (const ev of eventsAt(variant, i % LOOP_STEPS, i === 0, d, loop)) {
            const t = Math.max(0, (i + (ev.offset ?? 0)) * stepDur + nudge);
            insert.trigger(t);
            voice(off, input, t, keyed(ev), stepDur, d.shape);
          }
        }
      }
    }
    const buffer = await off.startRendering();
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    return {
      sampleRate: RENDER_RATE,
      channels: fx ? trimTail(channels.map((d) => d.slice(settle)), RENDER_RATE) : channels.map((d) => d.slice(loop, 2 * loop)),
    };
  }

  /**
   * One event of `id` for the editor's waveform: { sampleRate, data, whole }.
   * With its sample decoded, the whole sample (mono, reversed when it plays
   * reversed), so the editor marks its start and end on it (`whole`); else
   * one hit, note (the part's first) or FX shot of its voice, dry (no insert,
   * no shape), for as long as it rings.
   */
  async function sketch(id) {
    const d = dataOf(id);
    const buffer = d.sample && sampleBuffer(d.sample.id);
    if (buffer) return { sampleRate: buffer.sampleRate, data: mono(buffer, d.sample.reverse), whole: true };
    const stepDur = stepDuration(bpm);
    const length = FX_RENDER_SECONDS * SKETCH_RATE;
    const off = createOffline(1, length, SKETCH_RATE);
    const first = d.notes?.[0];
    const end = ringing(off, 0, (c) => {
      if (defOf(id).kind === "fx") return fxVoice(c, off.destination, 0, stepDur, id, null);
      const ev = auditionEvent(id, { ...d, sample: null }, { midi: first?.midi ?? 57 });
      return voice(c, off.destination, 0, keyed(first ? { ...ev, steps: first.len } : ev), stepDur, null);
    });
    const rendered = await off.startRendering();
    const frames = Math.min(length, Math.ceil(end * SKETCH_RATE));
    return { sampleRate: SKETCH_RATE, data: rendered.getChannelData(0).slice(0, frames), whole: false };
  }

  /**
   * Feeds `onAudio([left, right])` with blocks of the output from now on,
   * or of `source` (a node of ensureContext()'s, like a microphone).
   * Resolves to untap(), which delivers the block in flight and then
   * resolves; rejects where the browser has no AudioWorklet.
   */
  async function tap(onAudio, source) {
    ensureContext();
    tapModule ??= ctx.audioWorklet.addModule(TAP_URL);
    await tapModule;
    // Explicit stereo: a mono signal comes in on both channels.
    const node = createWorklet(ctx, "psy-tap", { channelCount: 2, channelCountMode: "explicit", numberOfOutputs: 1 });
    // Its output is silence; into the destination it keeps the node pulled.
    node.connect(ctx.destination);
    const from = source ?? out;
    from.connect(node);
    let closed = null;
    node.port.onmessage = ({ data }) => {
      if (data) onAudio(data);
      else closed?.();
    };
    return () =>
      new Promise((resolve) => {
        closed = () => {
          from.disconnect(node);
          node.disconnect();
          resolve();
        };
        node.port.postMessage("flush");
      });
  }

  // performance.now() time at which audio time `t` leaves the speakers: the
  // inverse of audioTimeAt().
  function perfTimeOf(t) {
    const out = ctx.getOutputTimestamp?.();
    if (out?.performanceTime > 0) return out.performanceTime + (t - out.contextTime) * 1000;
    return performance.now() + (t - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
  }

  /**
   * An AnalyserNode on what `out` sends to the volume, for the visuals'
   * levels; null until the context exists.
   */
  function levels() {
    if (!ctx) return null;
    if (!analyser) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      out.connect(analyser);
    }
    return analyser;
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
    setLayerVolume,
    setSolo,
    setEffects,
    setBpm,
    setKey,
    restart,
    align,
    setMasterFilter,
    setVolume,
    sweep,
    sweepOff: drop,
    frenzy,
    brake,
    unbrake,
    setPump,
    triggerFx,
    audition,
    previewSample,
    activeFx,
    // Step (0..31) and loop audible now, or null.
    visibleStep: () => visible()?.step ?? null,
    visibleLoop: () => visible()?.loop ?? null,
    /** The bar (absolute step) the lane playing `variant` came in on, or 0. */
    fromOf: (variant) => [...lanes.values()].find((l) => l.variant === variant)?.from ?? 0,
    stop,
    render,
    sketch,
    tap,
    onBar: (fn) => {
      barHook = fn;
    },
    /** fn(event) for every hit, bar line, lane change, FX, build, drop, frenzy, brake and stop; returns the unsubscribe. */
    listen: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    perfTimeOf,
    levels,
    bpm: () => bpm,
    isRunning: () => timer !== null,
    /** Seconds the loop has run since the engine was created (FX shots and previews aside). */
    playedSeconds: () => played + (timer !== null ? ctx.currentTime - runFrom : 0),
  };
}
