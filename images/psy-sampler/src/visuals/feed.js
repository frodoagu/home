// The sampler's side of the visuals in another window: the engine's events
// over a BroadcastChannel. Times travel as wall-clock ms (timeOrigin + the
// performance.now() time they are heard), since each window's
// performance.now() starts at its own zero.
//
// The window says hello every HELLO_MS while it is open; the feed only posts
// while one did lately, and answers each hello with what is playing, so a
// window opened mid-song picks up the lanes, the bar grid and a build.

export const CHANNEL = "psy-sampler:visuals";
export const HELLO_MS = 1500;
const LISTENING_MS = 4000; // a hello keeps the feed posting this long
const LEVELS_MS = 33;
const TIMED = ["time", "end"];

/** `event` with its audio times as wall-clock ms, through `perfTimeOf`. */
export function toWall(event, perfTimeOf, origin) {
  const out = { ...event };
  for (const key of TIMED) if (typeof out[key] === "number") out[key] = origin + perfTimeOf(out[key]);
  return out;
}

/** `event` with its wall-clock ms on this page's performance.now(). */
export function fromWall(event, origin) {
  const out = { ...event };
  for (const key of TIMED) if (typeof out[key] === "number") out[key] -= origin;
  return out;
}

export function createFeed(engine, { Channel = globalThis.BroadcastChannel, origin = performance.timeOrigin, bandsOf } = {}) {
  if (!Channel) return { stop() {} };
  const channel = new Channel(CHANNEL);
  let until = 0; // posting while performance.now() is before this
  let batch = [];
  let held = { lanes: null, bar: null, build: null }; // the latest of each, in wall ms
  let levelsTimer = null;
  let freq = null;

  const listening = () => performance.now() < until;
  const flush = () => {
    if (batch.length) channel.postMessage({ type: "events", events: batch });
    batch = [];
  };

  const unlisten = engine.listen((event) => {
    const wall = toWall(event, engine.perfTimeOf, origin);
    if (event.kind === "lanes" || event.kind === "bar" || event.kind === "build") held[event.kind] = wall;
    if (event.kind === "drop" || event.kind === "stop") held.build = null;
    if (event.kind === "stop") held = { lanes: null, bar: null, build: null };
    if (!listening()) return;
    if (!batch.length) queueMicrotask(flush);
    batch.push(wall);
  });

  function postLevels() {
    if (!listening()) {
      clearInterval(levelsTimer);
      levelsTimer = null;
      return;
    }
    const analyser = engine.levels();
    if (!analyser || !bandsOf) return;
    freq ??= new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freq);
    channel.postMessage({ type: "levels", ...bandsOf(freq, analyser.context.sampleRate) });
  }

  channel.onmessage = ({ data }) => {
    if (data !== "hello") return;
    until = performance.now() + LISTENING_MS;
    const now = Object.values(held).filter(Boolean);
    channel.postMessage({ type: "events", events: now, playing: engine.isRunning(), bpm: engine.bpm() });
    if (!levelsTimer) levelsTimer = setInterval(postLevels, LEVELS_MS);
  };

  return {
    stop() {
      unlisten();
      clearInterval(levelsTimer);
      channel.close();
    },
  };
}
