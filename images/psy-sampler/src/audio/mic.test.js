import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSTRAINTS, THRESHOLD, createMicMonitor, createMicRecorder, micAvailable } from "./mic.js";

// A microphone the test plays by hand through `feed`.
let feed;
let tapped;
let untapped;
let engine;
let media;
let tracks;
let live;
beforeEach(() => {
  live = null;
  feed = null;
  tapped = null;
  untapped = 0;
  tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  engine = {
    ensureContext: vi.fn(() => ({ sampleRate: 1000, createMediaStreamSource: (s) => ({ kind: "mic", stream: s }) })),
    monitor: vi.fn(async (source, fx) => {
      live = { source, fx, set: vi.fn(), stop: vi.fn() };
      return live;
    }),
    tap: vi.fn(async (onAudio, source) => {
      feed = onAudio;
      tapped = source;
      return async () => {
        untapped++;
      };
    }),
  };
  media = { getUserMedia: vi.fn(async () => stream) };
});

const block = (n, v = 0) => [new Float32Array(n).fill(v), new Float32Array(n).fill(v)];

describe("createMicRecorder", () => {
  it("opens the microphone without voice processing and taps it", async () => {
    const mic = createMicRecorder(engine, { media });
    const opening = mic.start();
    expect(engine.ensureContext).toHaveBeenCalled(); // inside the click
    expect(mic.state()).toBe("opening");
    await opening;
    expect(media.getUserMedia).toHaveBeenCalledWith(CONSTRAINTS);
    expect(tapped.kind).toBe("mic");
    expect(mic.state()).toBe("waiting");
  });

  it("starts over the noise, records mono and closes the microphone on stop", async () => {
    const mic = createMicRecorder(engine, { media });
    await mic.start();
    feed(block(500, THRESHOLD / 2)); // the room
    expect(mic.state()).toBe("waiting");
    expect(mic.level()).toBeCloseTo(THRESHOLD / 2);
    feed(block(1000, 0.5));
    expect(mic.state()).toBe("recording");
    // The 20 ms preroll + the sound.
    expect(mic.seconds()).toBeCloseTo(1.02);

    const { blob, seconds } = await mic.stop();
    expect(seconds).toBeCloseTo(1.02);
    expect(blob.size).toBe(44 + 1020 * 3);
    expect(untapped).toBe(1);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(mic.state()).toBe("idle");
  });

  it("gives nothing back when nothing went over the noise", async () => {
    const mic = createMicRecorder(engine, { media });
    await mic.start();
    feed(block(500, THRESHOLD / 2));
    expect(await mic.stop()).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("calls onFull once at the maximum length, and stops listening there", async () => {
    const mic = createMicRecorder(engine, { media, maxSeconds: 1 });
    const full = vi.fn();
    mic.onFull(full);
    await mic.start();
    feed(block(600, 0.5));
    feed(block(600, 0.5));
    feed(block(600, 0.5));
    expect(full).toHaveBeenCalledTimes(1);
    expect((await mic.stop()).seconds).toBe(1);
  });

  it("goes back to idle when the microphone is refused", async () => {
    media.getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    });
    const mic = createMicRecorder(engine, { media });
    await expect(mic.start()).rejects.toThrow("no");
    expect(mic.state()).toBe("idle");
    expect(engine.tap).not.toHaveBeenCalled();
  });

  it("asks once however many times start is pressed", async () => {
    const mic = createMicRecorder(engine, { media });
    mic.start();
    await mic.start();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("knows when the browser has no microphone API", () => {
    expect(micAvailable(media)).toBe(true);
    expect(micAvailable(undefined)).toBe(false);
    expect(micAvailable({})).toBe(false);
  });
});

describe("createMicMonitor", () => {
  it("plays the microphone through the effects until stopped", async () => {
    const mon = createMicMonitor(engine, { media });
    expect(mon.state()).toBe("idle");
    const opening = mon.start({ robot: 1 });
    expect(mon.state()).toBe("opening");
    await opening;
    expect(mon.state()).toBe("live");
    expect(media.getUserMedia).toHaveBeenCalledWith(CONSTRAINTS);
    expect(live.source.kind).toBe("mic");
    expect(live.fx).toEqual({ robot: 1 });
    mon.set({ pitch: -4 });
    expect(live.set).toHaveBeenCalledWith({ pitch: -4 });

    mon.stop();
    expect(mon.state()).toBe("idle");
    expect(live.stop).toHaveBeenCalled();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("stopped while the microphone opens, it closes it again", async () => {
    const mon = createMicMonitor(engine, { media });
    const opening = mon.start({});
    mon.stop();
    await opening;
    expect(mon.state()).toBe("idle");
    expect(engine.monitor).not.toHaveBeenCalled();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it("starts with the settings set while it was opening", async () => {
    const mon = createMicMonitor(engine, { media });
    const opening = mon.start({ robot: 1 });
    mon.set({ chorus: 1 });
    await opening;
    expect(live.fx).toEqual({ chorus: 1 });
  });

  it("goes back to idle when the microphone is refused", async () => {
    media.getUserMedia = async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    };
    const mon = createMicMonitor(engine, { media });
    await expect(mon.start({})).rejects.toThrow();
    expect(mon.state()).toBe("idle");
  });
});
