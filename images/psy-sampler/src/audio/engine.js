// Audio engine: owns the AudioContext, the output chain, the lookahead
// scheduler and one gain "lane" per playing layer.
//
//   lane gain ─┐
//   lane gain ─┼─> master (0.7) ─> compressor ─> destination
//   fx gain  ──┘
//
// Lanes are what make changes click-free: a variant change or a stop never
// touches individual notes, it fades the whole lane out over FADE and opens a
// fresh one, so notes already queued for the old variant die inside the fade.
// Variant changes crossfade on the next step boundary (the old lane plays up
// to the exact step where the new one enters); a stop fades right away.
import { collectSteps, nextBeatTime, stepDuration, BPM_DEFAULT, LOOKAHEAD, SAFETY, TICK_MS } from "./timing.js";
import { notesAt } from "./patterns.js";
import { FX, VOICES } from "./voices.js";

const MASTER_GAIN = 0.7;
const FADE = 0.03;
const START_DELAY = 0.06; // first step after start(): room for the first tick to land
const FX_LEVEL = 0.6;
const LANE_LEVEL = { kick: 0.9, bgKick: 0.6, bass: 0.6, perc: 0.6, lead: 0.3, pad: 0.35 };

export function createEngine({ createContext = () => new AudioContext() } = {}) {
  let ctx = null;
  let master = null;
  let bpm = BPM_DEFAULT;
  let timer = null;
  let cursor = null; // { step, time } of the next step to schedule; null when stopped
  let queued = []; // steps already scheduled, oldest first: step bar + lane backfill
  const lanes = new Map(); // lane key -> { variant, gain }
  const fxPlaying = new Map(); // fx id -> { gain, end }

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
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function scheduleLane(lane, step, time, stepDur) {
    for (const ev of notesAt(lane.variant, step, !lane.entered)) VOICES[ev.voice](ctx, lane.gain, time, ev, stepDur);
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

  function openGain(level) {
    const gain = ctx.createGain();
    gain.gain.value = level;
    gain.connect(master);
    return gain;
  }

  function openLane(key, variant) {
    const lane = { variant, gain: openGain(LANE_LEVEL[key]), entered: false };
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
    setTimeout(() => gain.disconnect(), (at - ctx.currentTime + FADE + 0.05) * 1000);
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

  // One-shot FX: on the next beat while the loop runs, right away otherwise.
  // Retriggering an FX that is still sounding fades the previous instance.
  function triggerFx(id) {
    ensureContext();
    const stepDur = stepDuration(bpm);
    const t = cursor ? nextBeatTime(cursor, stepDur) : ctx.currentTime + START_DELAY;
    const prev = fxPlaying.get(id);
    if (prev) fadeOut(prev.gain);
    const gain = openGain(FX_LEVEL);
    const end = FX[id](ctx, gain, t, stepDur);
    fxPlaying.set(id, { gain, end });
    return { start: t, end };
  }

  // Ids of FX still sounding; finished ones are released here.
  function activeFx() {
    const ids = new Set();
    if (!ctx) return ids;
    for (const [id, fx] of fxPlaying) {
      if (fx.end > ctx.currentTime) ids.add(id);
      else {
        fx.gain.disconnect();
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
    triggerFx,
    activeFx,
    visibleStep,
    stop,
    setBpm: (value) => {
      bpm = value;
    },
    isRunning: () => timer !== null,
  };
}
