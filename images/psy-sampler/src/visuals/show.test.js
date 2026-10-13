import { describe, expect, it } from "vitest";
import { adapt, scaleOf } from "./renderer.js";
import { DICTS } from "../i18n/index.js";
import { SCENES } from "./director.js";
import { SCENES as SHADERS } from "./shaders.js";
import { actionOf, loadSettings, TRAILS } from "./show.js";

const memory = (value) => ({ getItem: () => value, setItem() {} });

describe("keys", () => {
  it("maps keys to actions, digits to scenes", () => {
    expect(actionOf(" ")).toBe("next");
    expect(actionOf("ArrowLeft")).toBe("prev");
    expect(actionOf("L")).toBe("lock");
    expect(actionOf("3")).toEqual({ pick: 2 });
    expect(actionOf("9")).toEqual({ pick: 8 });
    expect(actionOf("0")).toEqual({ pick: 9 });
    expect(actionOf("0", 9)).toBe(null);
    expect(actionOf("5", 4)).toBe(null);
    expect(actionOf("q")).toBe(null);
  });
});

describe("scenes", () => {
  it("each has a shader, a trail and a name", () => {
    const ids = SCENES.map((s) => s.id).sort();
    expect(Object.keys(SHADERS).sort()).toEqual(ids);
    expect(Object.keys(TRAILS).sort()).toEqual(ids);
    expect(Object.keys(DICTS.es.visuals.scenes).sort()).toEqual(ids);
  });
});

describe("settings", () => {
  it("starts at full strobe and keeps what was stored, clamped", () => {
    expect(loadSettings(null)).toEqual({ strobe: 1, warned: false });
    expect(loadSettings(memory('{"strobe":0.5,"warned":true}'))).toEqual({ strobe: 0.5, warned: true });
    expect(loadSettings(memory('{"strobe":7}')).strobe).toBe(1);
    expect(loadSettings(memory("not json"))).toEqual({ strobe: 1, warned: false });
  });
});

describe("adaptive quality", () => {
  const run = (dt, frames, level = 0.75) => {
    let q = { level, ema: 16, fastFor: 0 };
    for (let i = 0; i < frames; i++) q = adapt(q, dt);
    return q.level;
  };

  it("drops on slow frames and climbs back slowly on fast ones", () => {
    expect(run(50, 60)).toBe(0);
    expect(run(16.7, 60)).toBe(0.75); // fast, but not for long enough yet
    expect(run(16.7, 600)).toBeGreaterThan(0.75);
    expect(run(20, 600)).toBe(0.75); // in between: stays
  });

  it("renders a share of the screen that grows with the level", () => {
    expect(scaleOf(0)).toBeCloseTo(0.3);
    expect(scaleOf(1)).toBeCloseTo(1);
  });
});
