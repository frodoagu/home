import { describe, expect, it, vi } from "vitest";
import { createFeed, fromWall, toWall } from "./feed.js";
import { channelSource } from "./sources.js";

// One browser's BroadcastChannel: a message reaches every other window.
function fakeChannel() {
  const windows = new Set();
  return class {
    constructor() {
      this.onmessage = null;
      windows.add(this);
    }
    postMessage(data) {
      for (const w of windows) if (w !== this) queueMicrotask(() => w.onmessage?.({ data: structuredClone(data) }));
    }
    close() {
      windows.delete(this);
    }
  };
}

function fakeEngine() {
  const listeners = new Set();
  return {
    listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: (e) => listeners.forEach((fn) => fn(e)),
    perfTimeOf: (t) => t * 1000,
    levels: () => null,
    isRunning: () => true,
    bpm: () => 145,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("wall clock", () => {
  it("moves audio times to wall ms and back onto another page's clock", () => {
    const wall = toWall({ kind: "build", time: 2, end: 3, bar: 2 }, (t) => t * 1000, 1e12);
    expect(wall).toEqual({ kind: "build", time: 1e12 + 2000, end: 1e12 + 3000, bar: 2 });
    expect(fromWall(wall, 1e12 + 500)).toEqual({ kind: "build", time: 1500, end: 2500, bar: 2 });
  });
});

describe("feed -> channelSource", () => {
  it("posts nothing until a window says hello, then what plays and every event after", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const Channel = fakeChannel();
    const engine = fakeEngine();
    const feed = createFeed(engine, { Channel, origin: 0 });
    engine.emit({ kind: "lanes", time: 1, variants: ["kick.a"] });
    engine.emit({ kind: "hit", layer: "kick", time: 1 }); // no one listening: dropped
    const source = channelSource({ Channel, origin: 0 });
    await tick();
    await tick();
    expect(source.poll()).toEqual([{ kind: "lanes", time: 1000, variants: ["kick.a"] }]);
    expect(source.live()).toBe(true);
    expect(source.quiet()).toBe(false);
    engine.emit({ kind: "hit", layer: "kick", time: 2 });
    engine.emit({ kind: "bar", time: 2, bar: 4, bpm: 145 });
    await tick();
    await tick();
    expect(source.poll()).toEqual([
      { kind: "hit", layer: "kick", time: 2000 },
      { kind: "bar", time: 2000, bar: 4, bpm: 145 },
    ]);
    engine.emit({ kind: "stop", time: 3 });
    await tick();
    await tick();
    source.poll();
    expect(source.quiet()).toBe(true);
    source.stop();
    feed.stop();
    vi.useRealTimers();
  });
});
