import { describe, expect, it } from "vitest";
import { collectSteps, LOOP_STEPS, nextBeatTime, SAFETY, stepDuration } from "./timing.js";

describe("stepDuration", () => {
  it("is a 16th note", () => {
    expect(stepDuration(150)).toBeCloseTo(0.1, 12);
    expect(stepDuration(145)).toBeCloseTo(60 / 145 / 4, 12);
  });
});

describe("collectSteps", () => {
  it("returns only the steps that start inside the lookahead window", () => {
    const { due, cursor } = collectSteps({ step: 0, time: 0.06 }, 0, 0.12, 0.1);
    expect(due).toEqual([{ step: 0, time: 0.06 }]);
    expect(cursor.step).toBe(1);
    expect(cursor.time).toBeCloseTo(0.16, 12);
  });

  it("wraps the 32-step loop", () => {
    const { due, cursor } = collectSteps({ step: 31, time: 1 }, 0.95, 0.12, 0.05);
    expect(due.map((s) => s.step)).toEqual([31, 0]);
    expect(cursor.step).toBe(1);
    expect(LOOP_STEPS).toBe(32);
  });

  it("applies a new step duration from the cursor on, without moving queued steps", () => {
    const first = collectSteps({ step: 0, time: 0.06 }, 0, 0.3, 0.1);
    const second = collectSteps(first.cursor, 0.2, 0.3, 0.08);
    // The first new step starts exactly where the old grid said it would...
    expect(second.due[0].time).toBeCloseTo(first.cursor.time, 12);
    expect(second.due[0].step).toBe(first.cursor.step);
    // ...and only the spacing after it changes.
    expect(second.due[1].time - second.due[0].time).toBeCloseTo(0.08, 12);
  });

  it("skips a throttled backlog instead of firing it, keeping the grid phase", () => {
    const { due } = collectSteps({ step: 4, time: 1 }, 2, 0.12, 0.1);
    expect(due.length).toBeGreaterThan(0);
    for (const s of due) {
      expect(s.time).toBeGreaterThanOrEqual(2 + SAFETY);
      // Still on the original grid: whole steps from the old cursor.
      const k = Math.round((s.time - 1) / 0.1);
      expect(s.time - 1).toBeCloseTo(k * 0.1, 9);
      expect(s.step).toBe((4 + k) % LOOP_STEPS);
    }
  });
});

describe("nextBeatTime", () => {
  it("rounds the cursor up to the next quarter note", () => {
    expect(nextBeatTime({ step: 5, time: 1 }, 0.1)).toBeCloseTo(1.3, 12);
    expect(nextBeatTime({ step: 8, time: 1 }, 0.1)).toBe(1);
    expect(nextBeatTime({ step: 31, time: 2 }, 0.1)).toBeCloseTo(2.1, 12);
  });
});
