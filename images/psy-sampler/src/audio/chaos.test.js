import { describe, expect, it } from "vitest";
import { BETA, RHO, SIGMA, lorenz, rk4 } from "./chaos.js";

describe("Lorenz attractor", () => {
  it("uses the classic chaotic parameters", () => {
    expect([SIGMA, RHO, BETA]).toEqual([10, 28, 8 / 3]);
  });

  it("RK4 is 4th order: halving the step cuts the error about 16 times", () => {
    const run = (dt, n) => {
      let p = [1, 1, 1];
      for (let i = 0; i < n; i++) p = rk4(p, dt);
      return p;
    };
    const exact = run(0.0001, 1000); // t = 0.1
    const err = (p) => Math.hypot(...p.map((v, i) => v - exact[i]));
    const ratio = err(run(0.01, 10)) / err(run(0.005, 20));
    expect(ratio).toBeGreaterThan(12);
    expect(ratio).toBeLessThan(20);
  });

  it("draws the same orbit every time, centred in -1..1 on every axis", () => {
    const a = lorenz(5000, 0.005);
    expect(lorenz(5000, 0.005)).toEqual(a);
    for (const axis of [a.x, a.y, a.z]) {
      expect(Math.min(...axis)).toBeCloseTo(-1, 6);
      expect(Math.max(...axis)).toBeCloseTo(1, 6);
    }
  });

  it("jumps between its two lobes at irregular intervals: never periodic", () => {
    const { x } = lorenz(40000, 0.005);
    const flips = [];
    for (let i = 1; i < x.length; i++) if (Math.sign(x[i]) !== Math.sign(x[i - 1])) flips.push(i);
    expect(flips.length).toBeGreaterThan(10);
    const gaps = flips.slice(1).map((f, i) => f - flips[i]);
    expect(new Set(gaps.map((g) => Math.round(g / 50))).size).toBeGreaterThan(3);
  });
});
