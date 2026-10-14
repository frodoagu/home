// What the show knows about the music at a given moment, from the events a
// source hands it (the sampler's engine, the sampler in another window, the
// microphone or the idle metronome). Free of the DOM and of WebGL so it can be
// unit-tested.
//
// Events carry their time in ms on this page's performance.now() clock: when
// they leave the speakers. Hits come in up to a lookahead early, so push()
// keeps them until frame() reaches their time.
//
//   { kind: "hit", layer, time, accent }      one lane's notes on one step
//   { kind: "bar", time, bar, bpm, rest }     a bar line (bar counts from ▶);
//                                             `rest` keeps time with no music
//   { kind: "lanes", time, variants }         what plays from `time` on
//   { kind: "build", time, end }              the sweep up into a drop
//   { kind: "drop", time }                    the drop
//   { kind: "frenzy", time, end }             the end of a set going wild (🌅)
//   { kind: "brake", time, end }              the mix slowing to a stop, like a vinyl
//   { kind: "fx", id, time, end }             a one-shot FX
//   { kind: "stop", time }                    the loop stops
//   { kind: "levels", low, mid, high }        what the speakers get now, 0..1

export const IDLE_BPM = 140;
const LAYERS = ["kick", "bass", "perc", "lead", "pad", "glitch", "classic", "fx"];
// How long each layer's flash lasts, in beats: the e-folding time of its envelope.
const DECAY = { kick: 0.22, bass: 0.35, perc: 0.1, lead: 0.5, pad: 1.5, glitch: 0.15, classic: 0.5, fx: 1.5 };
const ENERGY_TAU = 1800; // ms: how fast the energy follows the mix
const LEVEL_TAU = 60; // ms: smoothing of the levels

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** The layers a lane set plays: "kick.a~2" -> "kick". */
export const layersOf = (variants) => new Set(variants.map((v) => String(v).split(".")[0]));

/** How busy a mix is, 0..1, from the layers playing and the level heard. */
export function energyOf(layers, level = 0) {
  if (!layers.size) return 0.1 + 0.4 * level;
  let e = 0.2;
  if (layers.has("kick")) e += 0.25;
  if (layers.has("bass")) e += 0.15;
  if (layers.has("perc")) e += 0.1;
  if (layers.has("lead") || layers.has("classic")) e += 0.1;
  if (layers.has("glitch")) e += 0.05;
  return clamp01(e + 0.25 * level);
}

export function createStage({ now = 0, bpm = IDLE_BPM } = {}) {
  let pending = []; // events not reached yet, by time
  const last = Object.fromEntries(LAYERS.map((l) => [l, { time: -Infinity, accent: false }]));
  let bar = { time: now, bar: 0, bpm }; // the latest bar line reached
  let layers = new Set();
  let variants = [];
  let build = null; // { time, end } while a sweep is up
  let drop = { time: -Infinity, count: 0 };
  let frenzy = null; // { time, end } while a set goes wild
  let brake = null; // { time, end }: a vinyl stop, kept past the loop's stop (its tail plays on)
  let playing = false;
  let levels = { low: 0, mid: 0, high: 0 };
  let heard = { low: 0, mid: 0, high: 0 }; // smoothed
  let energy = 0.15;
  let lastFrame = now;

  function apply(e) {
    switch (e.kind) {
      case "hit":
        if (Object.hasOwn(last, e.layer)) last[e.layer] = { time: e.time, accent: Boolean(e.accent) };
        playing = true;
        break;
      case "bar":
        bar = { time: e.time, bar: e.bar, bpm: e.bpm > 0 ? e.bpm : bar.bpm };
        if (!e.rest) playing = true;
        break;
      case "lanes":
        variants = [...e.variants];
        layers = layersOf(variants);
        break;
      case "build":
        build = { time: e.time, end: e.end };
        break;
      case "drop":
        build = null;
        drop = { time: e.time, count: drop.count + 1 };
        break;
      case "frenzy":
        frenzy = { time: e.time, end: e.end };
        break;
      case "brake":
        brake = { time: e.time, end: e.end };
        break;
      case "fx":
        last.fx = { time: e.time, accent: false };
        break;
      case "stop":
        playing = false;
        build = null;
        frenzy = null;
        layers = new Set();
        variants = [];
        break;
    }
  }

  function push(e) {
    if (e.kind === "levels") {
      levels = { low: e.low, mid: e.mid, high: e.high };
      return;
    }
    // Lane changes and stops apply when they are heard, like the hits.
    let i = pending.length;
    while (i > 0 && pending[i - 1].time > e.time) i--;
    pending.splice(i, 0, e);
  }

  /** Everything the renderer needs at `t` (ms). Advances the stage: call once per frame. */
  function frame(t) {
    let n = 0;
    const hits = []; // every hit reached this frame, so a slow frame loses none
    while (n < pending.length && pending[n].time <= t) {
      const e = pending[n++];
      apply(e);
      if (e.kind === "hit") hits.push({ layer: e.layer, time: e.time, accent: Boolean(e.accent) });
    }
    if (n) pending = pending.slice(n);

    const dt = Math.max(0, t - lastFrame);
    lastFrame = t;
    const k = 1 - Math.exp(-dt / LEVEL_TAU);
    for (const band of ["low", "mid", "high"]) heard[band] += (levels[band] - heard[band]) * k;
    const level = (heard.low + heard.mid + heard.high) / 3;
    const target = playing ? energyOf(layers, level) : 0.12 + 0.3 * level;
    energy += (target - energy) * (1 - Math.exp(-dt / ENERGY_TAU));

    const beatMs = 60000 / bar.bpm;
    const beats = bar.bar * 4 + (t - bar.time) / beatMs;
    const env = {};
    for (const l of LAYERS) {
      const since = (t - last[l].time) / beatMs;
      env[l] = since < 0 ? 0 : Math.exp(-since / DECAY[l]);
    }
    const sinceDrop = (t - drop.time) / beatMs; // beats
    const building = build && t >= build.time ? clamp01((t - build.time) / Math.max(1, build.end - build.time)) : 0;
    // How far the vinyl has slowed, 0..1 (1: stopped, until it ends).
    const braked = brake && t >= brake.time && t < brake.end ? (t - brake.time) / Math.max(1, brake.end - brake.time) : 0;
    // How far into the frenzy, 0..1 while it lasts (just past 0 as it starts), else 0.
    const wild = frenzy && t >= frenzy.time && t < frenzy.end ? Math.max(1e-3, (t - frenzy.time) / Math.max(1, frenzy.end - frenzy.time)) : 0;
    // A set's last stretch: its fade and its brake, from the frenzy's end to the stop.
    const ending = Boolean(frenzy && t >= frenzy.end) || braked > 0;

    return {
      time: t,
      bpm: bar.bpm,
      beatMs,
      beats,
      beat: beats - Math.floor(beats),
      barPhase: beats / 4 - Math.floor(beats / 4),
      bar: Math.floor(beats / 4),
      env,
      hits,
      accent: last.kick.accent,
      levels: { ...heard },
      energy,
      layers,
      variants,
      playing,
      build: building,
      frenzy: wild,
      brake: braked,
      ending,
      sinceDrop,
      drops: drop.count,
    };
  }

  return { push, frame };
}
