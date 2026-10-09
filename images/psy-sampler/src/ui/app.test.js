// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { mountApp } from "./app.js";

let ctx;
let engine;
let root;
let frames;

beforeEach(() => {
  vi.useFakeTimers();
  // Drive animation frames by hand.
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  ctx = new FakeAudioContext();
  engine = createEngine({ createContext: () => ctx });
  root = document.createElement("div");
  document.body.replaceChildren(root);
  mountApp(root, engine);
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = (variant) => root.querySelector(`[data-variant="${variant}"]`);
const pressed = () => [...root.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.variant);
const click = (variant) => button(variant).click();
const flushFrame = () => frames.splice(0).forEach((cb) => cb());

describe("layout", () => {
  it("renders the controls with their defaults", () => {
    const bpm = root.querySelector("#bpm");
    expect([bpm.min, bpm.max, bpm.value]).toEqual(["130", "180", "145"]);
    expect(root.querySelector("#combine").checked).toBe(false);
    expect(root.querySelector("#bgkick").checked).toBe(true);
    expect(root.querySelector("button.stop").textContent).toBe("Parar");
  });

  it("has one row per layer and a 16-cell bar with the 4 beats marked", () => {
    expect(root.querySelectorAll("section.layer")).toHaveLength(6);
    expect(root.querySelectorAll(".cell")).toHaveLength(16);
    expect([...root.querySelectorAll(".cell.beat")].map((c) => c.textContent)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("solo mode (default)", () => {
  it("a click replaces what was active", () => {
    click("bass.rolling");
    expect(pressed()).toEqual(["bass.rolling"]);
    click("lead.acid");
    expect(pressed()).toEqual(["lead.acid"]);
    expect(button("lead.acid").classList.contains("is-active")).toBe(true);
    expect(engine.isRunning()).toBe(true);
  });

  it("clicking the active variant again stops", () => {
    click("pad.chord");
    click("pad.chord");
    expect(pressed()).toEqual([]);
    expect(engine.isRunning()).toBe(false);
  });
});

describe("combine mode", () => {
  it("toggles variants across layers, one per layer", () => {
    root.querySelector("#combine").click();
    click("bass.rolling");
    click("lead.acid");
    expect(pressed().sort()).toEqual(["bass.rolling", "lead.acid"]);
    click("bass.offbeat");
    expect(pressed().sort()).toEqual(["bass.offbeat", "lead.acid"]);
    click("lead.acid");
    expect(pressed()).toEqual(["bass.offbeat"]);
  });
});

describe("step bar", () => {
  it("highlights the audible step and clears on Parar", () => {
    click("kick.punchy");
    for (let i = 0; i < 8; i++) {
      ctx.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
    flushFrame();
    expect(root.querySelectorAll(".cell.is-current")).toHaveLength(1);

    root.querySelector("button.stop").click();
    expect(root.querySelectorAll(".cell.is-current")).toHaveLength(0);
    expect(pressed()).toEqual([]);
    expect(engine.isRunning()).toBe(false);
  });
});

describe("FX", () => {
  it("fire as one-shots without touching the loop selection", () => {
    click("bass.offbeat");
    click("fx.impact");
    expect(pressed()).toEqual(["bass.offbeat"]);
    flushFrame();
    expect(button("fx.impact").classList.contains("is-active")).toBe(true);
    expect(button("fx.impact").hasAttribute("aria-pressed")).toBe(false);
  });
});

describe("controls", () => {
  it("the BPM slider updates its readout", () => {
    const bpm = root.querySelector("#bpm");
    bpm.value = "170";
    bpm.dispatchEvent(new Event("input"));
    expect(root.querySelector(".bpm-value").textContent).toBe("170");
  });

  it("marks the punchy kick while it plays as background", () => {
    click("bass.offbeat");
    expect(button("kick.punchy").classList.contains("is-background")).toBe(true);
    expect(button("kick.punchy").getAttribute("aria-pressed")).toBe("false");
    click("kick.long");
    expect(button("kick.punchy").classList.contains("is-background")).toBe(false);
    root.querySelector("button.stop").click();
    expect(root.querySelectorAll(".is-background")).toHaveLength(0);
  });

  it("unchecking 'Kick de fondo' drops the background kick lane live", () => {
    click("bass.offbeat");
    const kicksBefore = () => ctx.sources().filter((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 170);
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
    const n = kicksBefore().length;
    expect(n).toBeGreaterThan(0);
    root.querySelector("#bgkick").click();
    for (let i = 0; i < 20; i++) {
      ctx.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
    expect(kicksBefore().length).toBe(n);
  });
});
