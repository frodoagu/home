import { describe, expect, it } from "vitest";
import { RATES, stepsFor } from "./sims.js";

describe("simulation steps", () => {
  const rate = { perSecond: 100, max: 5 };

  it("takes the same steps per second whatever the frame rate", () => {
    const count = (fps) => {
      let carry = 0;
      let total = 0;
      for (let i = 0; i < fps; i++) {
        const r = stepsFor(rate, 1 / fps, carry);
        total += r.steps;
        carry = r.carry;
      }
      return total;
    };
    expect(count(30)).toBeGreaterThanOrEqual(99);
    expect(count(60)).toBeGreaterThanOrEqual(99);
    expect(count(30)).toBeLessThanOrEqual(100);
  });

  it("caps a slow frame and drops what it could not take", () => {
    expect(stepsFor(rate, 1)).toEqual({ steps: 5, carry: 1 });
    expect(stepsFor(rate, -1).steps).toBe(0);
  });

  it("has a rate per simulated scene", () => {
    expect(Object.keys(RATES).sort()).toEqual(["physarum", "turing"]);
  });
});
