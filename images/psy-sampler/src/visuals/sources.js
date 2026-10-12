// Where the show hears the music from. Each source hands over stage events
// (stage.js) on this page's performance.now() clock: poll(now) once a frame
// returns what came in since the last one. quiet() says nothing plays there
// right now, and withIdle() fills those stretches with the idle metronome.
//
//   engineSource   the sampler in this same tab, straight off its engine
//   channelSource  the sampler in another window (feed.js)
//   micSource      the room, through the microphone (listen.js)
//   idleSource     nothing: a metronome so the show still moves

import { CHANNEL, HELLO_MS, fromWall } from "./feed.js";
import { bandsOf, createListener } from "./listen.js";
import { IDLE_BPM } from "./stage.js";

const SILENT_MS = 4000; // the other window counts as gone after this long without a word

export function engineSource(engine) {
  let inbox = [];
  const unlisten = engine.listen((e) => {
    const out = { ...e, time: engine.perfTimeOf(e.time) };
    if (typeof e.end === "number") out.end = engine.perfTimeOf(e.end);
    inbox.push(out);
  });
  let freq = null;
  return {
    kind: "sampler",
    poll() {
      const out = inbox;
      inbox = [];
      const analyser = engine.levels();
      if (analyser) {
        freq ??= new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freq);
        out.push({ kind: "levels", ...bandsOf(freq, analyser.context.sampleRate) });
      }
      return out;
    },
    live: () => true,
    quiet: () => !engine.isRunning(),
    stop: unlisten,
  };
}

export function channelSource({ Channel = globalThis.BroadcastChannel, origin = performance.timeOrigin } = {}) {
  if (!Channel) return null;
  const channel = new Channel(CHANNEL);
  let inbox = [];
  let heard = -Infinity;
  let playing = false;
  channel.onmessage = ({ data }) => {
    heard = performance.now();
    if (data?.type === "events" && Array.isArray(data.events)) {
      if (typeof data.playing === "boolean") playing = data.playing;
      for (const e of data.events) {
        if (e?.kind === "hit" || e?.kind === "bar") playing = true;
        if (e?.kind === "stop") playing = false;
        inbox.push(fromWall(e, origin));
      }
    } else if (data?.type === "levels") {
      inbox.push({ kind: "levels", low: +data.low || 0, mid: +data.mid || 0, high: +data.high || 0 });
    }
  };
  const hello = () => channel.postMessage("hello");
  hello();
  const timer = setInterval(hello, HELLO_MS);
  return {
    kind: "window",
    poll() {
      const out = inbox;
      inbox = [];
      return out;
    },
    live: () => performance.now() - heard < SILENT_MS,
    quiet: () => !playing || performance.now() - heard >= SILENT_MS,
    stop() {
      clearInterval(timer);
      channel.close();
    },
  };
}

/** Resolves to a source, or rejects when the microphone is refused. */
export async function micSource({ media = navigator.mediaDevices, createContext = () => new AudioContext() } = {}) {
  const stream = await media.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = createContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const freq = new Uint8Array(analyser.frequencyBinCount);
  const hear = createListener();
  return {
    kind: "mic",
    poll(now) {
      analyser.getByteFrequencyData(freq);
      return hear(now, bandsOf(freq, ctx.sampleRate));
    },
    live: () => true,
    stop() {
      for (const track of stream.getTracks()) track.stop();
      ctx.close();
    },
  };
}

// A pad every two bars and a lead on the offbeats at IDLE_BPM, so the show
// breathes while nothing plays: calm, no kick, no drops.
export function idleSource({ bpm = IDLE_BPM, now = performance.now() } = {}) {
  const beatMs = 60000 / bpm;
  let next = 0; // next beat to send
  const start = now;
  const sent = [{ kind: "lanes", time: now, variants: ["pad", "lead"] }];
  return {
    kind: "idle",
    poll(t) {
      const out = sent.splice(0);
      while (start + next * beatMs <= t + 100) {
        const time = start + next * beatMs;
        if (next % 4 === 0) out.push({ kind: "bar", time, bar: next / 4, bpm });
        if (next % 8 === 0) out.push({ kind: "hit", layer: "pad", time });
        out.push({ kind: "hit", layer: "lead", time: time + beatMs / 2 });
        next++;
      }
      return out;
    },
    live: () => true,
    stop() {},
  };
}

/** `source`, with the idle metronome playing whenever it is quiet. */
export function withIdle(source) {
  let idle = null;
  return {
    ...source,
    poll(now) {
      const out = source.poll(now);
      if (!source.quiet?.()) idle = null;
      else {
        idle ??= idleSource({ now });
        out.push(...idle.poll(now));
      }
      return out;
    },
  };
}
