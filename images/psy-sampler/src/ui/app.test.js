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
  localStorage.clear();
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
const advance = (ticks) => {
  for (let i = 0; i < ticks; i++) {
    ctx.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
};
const openEditor = (variant) => root.querySelector(`[data-edit="${variant}"]`).click();
const editor = (variant) => root.querySelector(`[data-editor="${variant}"]`);
const rollCell = (variant, midi, step) => editor(variant).querySelector(`[data-midi="${midi}"][data-step="${step}"]`);
const stepCell = (variant, step) => editor(variant).querySelector(`[data-step="${step}"]`);
const saved = () => JSON.parse(localStorage.getItem("psy-sampler:v2"));

describe("layout", () => {
  it("renders the controls with their defaults", () => {
    const bpm = root.querySelector("#bpm");
    expect([bpm.min, bpm.max, bpm.value]).toEqual(["130", "180", "145"]);
    expect(root.querySelector("#combine").checked).toBe(false);
    expect(root.querySelector("#bgkick").checked).toBe(true);
    expect(root.querySelector("#delay").checked).toBe(true);
    expect(root.querySelector("#reverb").checked).toBe(true);
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
  it("stacks percussion and leads, but keeps one kick and one bass", () => {
    root.querySelector("#combine").click();
    for (const v of ["perc.hat", "perc.clap", "lead.acid", "lead.arp", "kick.long", "kick.tok"]) click(v);
    expect(pressed().sort()).toEqual(["kick.tok", "lead.acid", "lead.arp", "perc.clap", "perc.hat"]);
  });

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

describe("editors", () => {
  it("every variant has an editor toggle, and a layer shows one editor at a time", () => {
    expect(root.querySelectorAll("[data-edit]")).toHaveLength(root.querySelectorAll("[data-variant]").length);
    openEditor("lead.acid");
    expect(root.querySelector('[data-edit="lead.acid"]').getAttribute("aria-expanded")).toBe("true");
    openEditor("lead.arp");
    expect(editor("lead.acid")).toBeNull();
    expect(editor("lead.arp")).not.toBeNull();
    expect(root.querySelector('[data-edit="lead.acid"]').getAttribute("aria-expanded")).toBe("false");
    openEditor("bass.rolling"); // another layer: both stay open
    expect(editor("lead.arp")).not.toBeNull();
    openEditor("lead.arp"); // toggle closes
    expect(editor("lead.arp")).toBeNull();
    expect(root.querySelectorAll(".stepbar .cell")).toHaveLength(16);
  });

  it("Cerrar closes the panel", () => {
    openEditor("pad.chord");
    editor("pad.chord").querySelector('[data-action="close"]').click();
    expect(editor("pad.chord")).toBeNull();
  });

  it("a piano-roll click adds a note, switches the variant on and previews it", () => {
    openEditor("lead.melodic");
    const cell = rollCell("lead.melodic", 64, 2);
    expect(cell.dataset.state).toBe("");
    cell.click();
    expect(rollCell("lead.melodic", 64, 2).dataset.state).toBe("hit");
    expect(pressed()).toEqual(["lead.melodic"]);
    expect(engine.isRunning()).toBe(true);
    // Default note length for this variant is 8 steps.
    expect(rollCell("lead.melodic", 64, 3).dataset.state).toBe("hit");
    expect(rollCell("lead.melodic", 64, 9).classList.contains("tail")).toBe(true);
    rollCell("lead.melodic", 64, 5).click();
    expect(rollCell("lead.melodic", 64, 2).dataset.state).toBe("accent");
    rollCell("lead.melodic", 64, 5).click();
    expect(rollCell("lead.melodic", 64, 2).dataset.state).toBe("");
  });

  it("a drum-grid click cycles the step and the loop plays the edit", () => {
    openEditor("perc.clap");
    stepCell("perc.clap", 1).click();
    expect(stepCell("perc.clap", 1).dataset.state).toBe("hit");
    stepCell("perc.clap", 1).click();
    expect(stepCell("perc.clap", 1).dataset.state).toBe("accent");
    expect(stepCell("perc.clap", 1).getAttribute("aria-label")).toBe("Paso 2: acento");
    expect(pressed()).toEqual(["perc.clap"]);
  });

  it("sliders, synth and scale edit the variant and are remembered", () => {
    openEditor("bass.offbeat");
    const synth = editor("bass.offbeat").querySelector('[data-control="synth"]');
    synth.value = "fmBass";
    synth.dispatchEvent(new Event("change"));
    expect(editor("bass.offbeat").querySelector(".synth-detail").textContent).toMatch(/Operator/);
    const bright = editor("bass.offbeat").querySelector('[data-param="bright"]');
    bright.value = "2";
    bright.dispatchEvent(new Event("input"));
    const scale = editor("bass.offbeat").querySelector('[data-control="scale"]');
    scale.value = "phrygian";
    scale.dispatchEvent(new Event("change"));
    expect(rollCell("bass.offbeat", 46, 0)).not.toBeNull(); // B♭2 row appears

    const stored = saved().variants["bass.offbeat"];
    expect(stored).toMatchObject({ synth: "fmBass", scale: "phrygian", params: { bright: 2 } });
    expect(root.querySelector('[data-variant="bass.offbeat"]').parentElement.classList.contains("is-edited")).toBe(true);
  });

  it("Restaurar brings back the factory data and forgets the edit", () => {
    openEditor("perc.hat");
    stepCell("perc.hat", 0).click();
    expect(saved().variants["perc.hat"]).toBeDefined();
    editor("perc.hat").querySelector('[data-action="reset"]').click();
    expect(saved().variants["perc.hat"]).toBeUndefined();
    expect(stepCell("perc.hat", 0).dataset.state).toBe("");
    expect(stepCell("perc.hat", 2).dataset.state).toBe("hit");
  });

  it("edits survive a reload", () => {
    openEditor("lead.arp");
    rollCell("lead.arp", 81, 0).click();
    engine.stop();
    const again = document.createElement("div");
    mountApp(again, createEngine({ createContext: () => new FakeAudioContext() }));
    again.querySelector('[data-edit="lead.arp"]').click();
    const cell = again.querySelector('[data-editor="lead.arp"] [data-midi="81"][data-step="0"]');
    expect(cell.dataset.state).toBe("hit");
  });

  it("broken storage falls back to the defaults", () => {
    localStorage.setItem("psy-sampler:v2", "{not json");
    const again = document.createElement("div");
    mountApp(again, createEngine({ createContext: () => new FakeAudioContext() }));
    expect(again.querySelectorAll(".is-edited")).toHaveLength(0);
  });

  it("Improvisar writes a new part in the chosen scale", () => {
    openEditor("lead.acid");
    const before = saved();
    editor("lead.acid").querySelector(".action").click();
    expect(before).toBeNull();
    expect(saved().variants["lead.acid"].notes.length).toBeGreaterThan(0);
  });

  it("the open editor follows the playhead", () => {
    openEditor("kick.punchy");
    click("kick.punchy");
    advance(8);
    flushFrame();
    expect(editor("kick.punchy").querySelectorAll(".step.is-current")).toHaveLength(1);
    root.querySelector("button.stop").click();
    expect(editor("kick.punchy").querySelectorAll(".step.is-current")).toHaveLength(0);
  });

  it("FX editors have sliders and a fire button", () => {
    openEditor("fx.riser");
    const bars = editor("fx.riser").querySelector('[data-param="bars"]');
    bars.value = "4";
    bars.dispatchEvent(new Event("input"));
    expect(bars.nextElementSibling.textContent).toBe("4 compases");
    editor("fx.riser").querySelector(".action").click();
    flushFrame();
    expect(button("fx.riser").classList.contains("is-active")).toBe(true);
    expect(pressed()).toEqual([]);
  });

  it("the effect switches are remembered", () => {
    root.querySelector("#reverb").click();
    expect(saved().effects).toEqual({ delay: true, reverb: false });
  });
});
