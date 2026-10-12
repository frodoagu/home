import { describe, expect, it } from "vitest";
import { idleSource, withIdle } from "./sources.js";

describe("idleSource", () => {
  it("sends rest bar lines and no hits, so nothing pulses", () => {
    const events = idleSource({ bpm: 120, now: 0 }).poll(10000);
    expect(events.length).toBeGreaterThan(4);
    expect(events.every((e) => e.kind === "bar" && e.rest)).toBe(true);
    expect(events[1].time - events[0].time).toBe(2000);
  });
});

describe("withIdle", () => {
  it("plays the idle clock only while the source is quiet", () => {
    let quiet = true;
    const source = withIdle({ kind: "sampler", poll: () => [], quiet: () => quiet, stop() {} });
    expect(source.poll(0).length).toBeGreaterThan(0);
    quiet = false;
    expect(source.poll(5000)).toEqual([]);
  });
});
