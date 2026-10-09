// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { stepDuration } from "../audio/timing.js";
import { mountApp } from "./app.js";

let ctx;
let engine;
let root;
let frames;
let downloads;

const BAR = 16 * stepDuration(145);

// Offline renders come back as silence of the right length.
function fakeOffline(channels, length) {
  const off = new FakeAudioContext();
  off.startRendering = async () => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, getChannelData: (c) => data[c] };
  };
  return off;
}

const newEngine = (c = new FakeAudioContext()) => createEngine({ createContext: () => c, createOffline: fakeOffline });
const mount = (node, eng = engine, opts = {}) =>
  mountApp(node, eng, { languages: ["es-AR"], confirm: () => true, ...opts });

beforeEach(() => {
  vi.useFakeTimers();
  // Drive animation frames by hand.
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  downloads = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob) => {
      downloads.push(blob);
      return "blob:x";
    },
    revokeObjectURL: () => {},
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    downloads.at(-1).fileName = this.download;
  });
  ctx = new FakeAudioContext();
  engine = newEngine(ctx);
  localStorage.clear();
  history.replaceState(null, "", "/");
  root = document.createElement("div");
  document.body.replaceChildren(root);
  mount(root);
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const $ = (sel) => root.querySelector(sel);
const button = (variant) => $(`[data-variant="${variant}"]`);
const pressed = () => [...root.querySelectorAll('[aria-pressed="true"][data-variant]')].map((b) => b.dataset.variant);
const queued = () => [...root.querySelectorAll(".is-queued")].map((b) => b.dataset.variant);
const click = (variant) => button(variant).click();
// A real double click: two clicks counting up in `detail`, then dblclick.
const dblclick = (variant) => {
  for (const detail of [1, 2]) button(variant).dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
};
const flushFrame = () => frames.splice(0).forEach((cb) => cb());
const advance = (ticks) => {
  for (let i = 0; i < ticks; i++) {
    ctx.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
};
const advanceSeconds = (s) => advance(Math.ceil(s / 0.025));
const openEditor = (variant) => $(`[data-edit="${variant}"]`).click();
const editor = (variant) => $(`[data-editor="${variant}"]`);
const rollCell = (variant, midi, step) => editor(variant).querySelector(`[data-midi="${midi}"][data-step="${step}"]`);
const stepCell = (variant, step) => editor(variant).querySelector(`[data-step="${step}"]`);
const saved = () => JSON.parse(localStorage.getItem("psy-sampler:v2"));
const immediate = () => $("#quantize").click(); // clicks apply at once
const flushPromises = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("layout", () => {
  it("renders the controls with their defaults", () => {
    const bpm = $("#bpm");
    expect([bpm.min, bpm.max, bpm.value]).toEqual(["130", "180", "145"]);
    expect($("#combine").checked).toBe(false);
    expect($("#bgkick").checked).toBe(true);
    expect($("#quantize").checked).toBe(true);
    expect($("#delay").checked).toBe(true);
    expect($("#reverb").checked).toBe(true);
    expect($("button.stop").textContent).toBe("Parar");
    expect($("#seed").value).toMatch(/^[a-z2-9]{6}$/);
  });

  it("has one row per layer plus the snapshots, and a 16-cell bar with the 4 beats marked", () => {
    expect(root.querySelectorAll("section.layer")).toHaveLength(7);
    expect(root.querySelector("section.layer:last-of-type").dataset.layer).toBe("snap");
    expect(root.querySelectorAll(".cell")).toHaveLength(16);
    expect([...root.querySelectorAll(".cell.beat")].map((c) => c.textContent)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("solo mode (default)", () => {
  beforeEach(immediate);

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
  beforeEach(immediate);

  it("stacks percussion and leads, but keeps one kick and one bass", () => {
    $("#combine").click();
    for (const v of ["perc.hat", "perc.clap", "lead.acid", "lead.arp", "kick.long", "kick.tok"]) click(v);
    expect(pressed().sort()).toEqual(["kick.tok", "lead.acid", "lead.arp", "perc.clap", "perc.hat"]);
  });

  it("toggles variants across layers, one per layer", () => {
    $("#combine").click();
    click("bass.rolling");
    click("lead.acid");
    expect(pressed().sort()).toEqual(["bass.rolling", "lead.acid"]);
    click("bass.offbeat");
    expect(pressed().sort()).toEqual(["bass.offbeat", "lead.acid"]);
    click("lead.acid");
    expect(pressed()).toEqual(["bass.offbeat"]);
  });
});

describe("on the beat (queued clicks)", () => {
  it("the first click starts at once; later ones wait for the next bar line", () => {
    click("kick.long");
    expect(pressed()).toEqual(["kick.long"]);
    advance(10);
    click("bass.rolling");
    expect(pressed()).toEqual(["kick.long"]);
    expect(queued()).toEqual(["bass.rolling"]);
    expect(button("kick.long").classList.contains("is-leaving")).toBe(true);
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["bass.rolling"]);
    expect(queued()).toEqual([]);
  });

  it("a queued change enters exactly on the bar line", () => {
    $("#combine").click();
    click("kick.long");
    advance(10);
    const before = ctx.sources().length;
    click("perc.shaker"); // a hit on every step
    advanceSeconds(BAR);
    const starts = ctx
      .sources()
      .slice(before)
      .filter((s) => s.kind === "buffer")
      .map((s) => s.startTime);
    expect(Math.min(...starts)).toBeCloseTo(0.06 + BAR, 6);
  });

  it("clicking back before the bar cancels the queue; removing the last layer stops on the bar", () => {
    click("pad.chord");
    advance(10);
    click("lead.acid");
    click("pad.chord");
    expect(queued()).toEqual([]);
    click("pad.chord");
    expect(engine.isRunning()).toBe(true);
    advanceSeconds(BAR + 0.2);
    expect(engine.isRunning()).toBe(false);
    expect(pressed()).toEqual([]);
  });

  it("a double click enters at once instead of waiting for the bar", () => {
    click("kick.long");
    advance(10);
    dblclick("bass.rolling");
    expect(pressed()).toEqual(["bass.rolling"]);
    expect(queued()).toEqual([]);
  });

  it("a double click does not undo itself when clicks already apply at once", () => {
    immediate();
    click("kick.long");
    dblclick("bass.rolling");
    expect(pressed()).toEqual(["bass.rolling"]);
  });

  it("is remembered", () => {
    immediate();
    expect(saved().quantize).toBe(false);
  });
});

describe("step bar", () => {
  it("highlights the audible step and clears on Parar", () => {
    click("kick.punchy");
    advance(8);
    flushFrame();
    expect(root.querySelectorAll(".cell.is-current")).toHaveLength(1);

    $("button.stop").click();
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
  it("the BPM slider updates its readout and is remembered", () => {
    const bpm = $("#bpm");
    bpm.value = "170";
    bpm.dispatchEvent(new Event("input"));
    expect($(".bpm-value").textContent).toBe("170");
    expect(saved().bpm).toBe(170);
  });

  it("marks the punchy kick while it plays as background", () => {
    immediate();
    click("bass.offbeat");
    expect(button("kick.punchy").classList.contains("is-background")).toBe(true);
    expect(button("kick.punchy").getAttribute("aria-pressed")).toBe("false");
    click("kick.long");
    expect(button("kick.punchy").classList.contains("is-background")).toBe(false);
    $("button.stop").click();
    expect(root.querySelectorAll(".is-background")).toHaveLength(0);
  });

  it("unchecking 'Kick de fondo' drops the background kick lane live", () => {
    click("bass.offbeat");
    const kicks = () => ctx.sources().filter((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 170);
    advance(20);
    const n = kicks().length;
    expect(n).toBeGreaterThan(0);
    $("#bgkick").click();
    advance(20);
    expect(kicks().length).toBe(n);
  });

  it("every switch and the BPM survive a reload", () => {
    for (const id of ["#combine", "#bgkick", "#quantize", "#delay", "#reverb"]) $(id).click();
    const bpm = $("#bpm");
    bpm.value = "150";
    bpm.dispatchEvent(new Event("input"));
    const again = document.createElement("div");
    mount(again, newEngine());
    const q = (sel) => again.querySelector(sel);
    expect([q("#combine"), q("#bgkick"), q("#quantize"), q("#delay"), q("#reverb")].map((c) => c.checked)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(q("#bpm").value).toBe("150");
    expect(q("#seed").value).toBe($("#seed").value);
  });
});

describe("editors", () => {
  it("every variant has an editor toggle, and only one editor is open at a time", () => {
    expect(root.querySelectorAll("[data-edit]")).toHaveLength(root.querySelectorAll("[data-variant]").length);
    openEditor("lead.acid");
    expect($('[data-edit="lead.acid"]').getAttribute("aria-expanded")).toBe("true");
    openEditor("lead.arp");
    expect(editor("lead.acid")).toBeNull();
    expect(editor("lead.arp")).not.toBeNull();
    expect($('[data-edit="lead.acid"]').getAttribute("aria-expanded")).toBe("false");
    openEditor("bass.rolling"); // another layer: the lead editor folds too
    expect(editor("lead.arp")).toBeNull();
    expect(root.querySelectorAll("[data-editor]")).toHaveLength(1);
    openEditor("bass.rolling"); // toggle closes
    expect(editor("bass.rolling")).toBeNull();
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

  it("grids label both bars and their beats", () => {
    openEditor("kick.long");
    const grid = editor("kick.long");
    expect([...grid.querySelectorAll(".bar-head")].map((h) => h.textContent)).toEqual(["Compás 1", "Compás 2"]);
    expect([...grid.querySelectorAll(".beat-head")].map((h) => h.textContent).join("")).toBe("12341234");
    expect(stepCell("kick.long", 16).classList.contains("bar")).toBe(true);
    expect(stepCell("kick.long", 4).classList.contains("alt")).toBe(true);
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
    expect(button("bass.offbeat").parentElement.classList.contains("is-edited")).toBe(true);
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
    mount(again, newEngine());
    again.querySelector('[data-edit="lead.arp"]').click();
    const cell = again.querySelector('[data-editor="lead.arp"] [data-midi="81"][data-step="0"]');
    expect(cell.dataset.state).toBe("hit");
  });

  it("broken storage falls back to the defaults", () => {
    localStorage.setItem("psy-sampler:v2", "{not json");
    const again = document.createElement("div");
    mount(again, newEngine());
    expect(again.querySelectorAll(".is-edited")).toHaveLength(0);
  });

  it("Nueva parte writes a new part in the chosen scale", () => {
    openEditor("lead.acid");
    expect(saved().variants["lead.acid"]).toBeUndefined();
    editor("lead.acid").querySelector('[data-action="new-part"]').click();
    expect(saved().variants["lead.acid"].notes.length).toBeGreaterThan(0);
  });

  it("Nueva parte waits for the next loop while it plays; a second click cancels it", () => {
    click("lead.acid");
    advanceSeconds(BAR / 2);
    openEditor("lead.acid");
    const btn = () => editor("lead.acid").querySelector('[data-action="new-part"]');
    btn().click();
    expect(btn().getAttribute("aria-pressed")).toBe("true");
    expect(saved()?.variants?.["lead.acid"]).toBeUndefined();
    btn().click();
    expect(btn().getAttribute("aria-pressed")).toBe("false");
    btn().click();
    advanceSeconds(BAR);
    expect(saved()?.variants?.["lead.acid"]).toBeUndefined(); // a bar line, not the loop's start
    advanceSeconds(BAR);
    expect(saved().variants["lead.acid"].notes.length).toBeGreaterThan(0);
    expect(btn().getAttribute("aria-pressed")).toBe("false");
  });

  it("the open editor follows the playhead", () => {
    openEditor("kick.punchy");
    click("kick.punchy");
    advance(8);
    flushFrame();
    expect(editor("kick.punchy").querySelectorAll(".step.is-current")).toHaveLength(1);
    $("button.stop").click();
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
    $("#reverb").click();
    expect(saved().effects).toEqual({ delay: true, reverb: false });
  });
});

describe("improvise toggle", () => {
  const notesOf = (variant) =>
    [...editor(variant).querySelectorAll('[data-midi][data-state="hit"], [data-midi][data-state="accent"]')]
      .map((c) => `${c.dataset.midi}:${c.dataset.step}:${c.dataset.state}`)
      .join();

  it("varies the part on every loop around what was written, and restores it when off", () => {
    openEditor("lead.melodic");
    click("lead.melodic");
    const written = notesOf("lead.melodic");
    const toggle = editor("lead.melodic").querySelector('[data-action="vary"]');
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(button("lead.melodic").parentElement.classList.contains("is-varying")).toBe(true);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      advanceSeconds(2 * BAR);
      seen.add(notesOf("lead.melodic"));
    }
    expect([...seen].some((n) => n !== written)).toBe(true);
    expect(saved()?.variants?.["lead.melodic"]).toBeUndefined(); // variations are never stored
    toggle.click();
    expect(notesOf("lead.melodic")).toBe(written);
    expect(button("lead.melodic").parentElement.classList.contains("is-varying")).toBe(false);
  });

  it("Restaurar turns it off along with the edits", () => {
    openEditor("perc.clap");
    editor("perc.clap").querySelector('[data-action="vary"]').click();
    editor("perc.clap").querySelector('[data-action="reset"]').click();
    expect(editor("perc.clap").querySelector('[data-action="vary"]').getAttribute("aria-pressed")).toBe("false");
    expect(button("perc.clap").parentElement.classList.contains("is-varying")).toBe(false);
  });

  it("each tile has its own 🔀: it shows and switches improvise without the editor", () => {
    const toggle = () => $('[data-vary="perc.clap"]');
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    toggle().click();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(button("perc.clap").parentElement.classList.contains("is-varying")).toBe(true);
    openEditor("perc.clap");
    const inEditor = editor("perc.clap").querySelector('[data-action="vary"]');
    expect(inEditor.getAttribute("aria-pressed")).toBe("true");
    toggle().click();
    expect(inEditor.getAttribute("aria-pressed")).toBe("false");
    inEditor.click();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect($('[data-vary="fx.riser"]')).toBeNull(); // one-shots do not loop
  });

  it("is a slider too: ← → or a drag set how much it varies, and a drag does not toggle", () => {
    openEditor("perc.clap");
    const vary = editor("perc.clap").querySelector('[data-action="vary"]');
    expect(vary.style.getPropertyValue("--amount")).toBe("50%");
    vary.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    vary.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(vary.style.getPropertyValue("--amount")).toBe("60%");
    expect(vary.textContent).toContain("60 %");
    expect(saved().improv).toEqual({ "perc.clap": 0.6 });
    expect($('[data-vary="perc.clap"]').style.getPropertyValue("--amount")).toBe("60%");
    vary.dispatchEvent(new MouseEvent("pointerdown", { clientX: 0, bubbles: true }));
    vary.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, bubbles: true }));
    vary.dispatchEvent(new MouseEvent("pointerup", { clientX: 30, bubbles: true }));
    vary.click();
    expect(vary.getAttribute("aria-pressed")).toBe("false");
    vary.click();
    expect(vary.getAttribute("aria-pressed")).toBe("true");
    editor("perc.clap").querySelector('[data-action="reset"]').click();
    expect(saved().improv).toEqual({});
  });

  it("keeps going with the editor closed, and shows its state when reopened", () => {
    openEditor("perc.clap");
    editor("perc.clap").querySelector('[data-action="vary"]').click();
    editor("perc.clap").querySelector('[data-action="close"]').click();
    openEditor("perc.clap");
    expect(editor("perc.clap").querySelector('[data-action="vary"]').getAttribute("aria-pressed")).toBe("true");
  });
});

describe("drum tools", () => {
  const hits = (variant) =>
    [...editor(variant).querySelectorAll("[data-step]")].filter((c) => c.dataset.state).map((c) => Number(c.dataset.step));

  it("×2 doubles the marked hits: quarters -> 8ths -> 16ths", () => {
    openEditor("kick.long");
    const double = editor("kick.long").querySelector('[data-action="double"]');
    expect(hits("kick.long")).toHaveLength(8);
    double.click();
    expect(hits("kick.long")).toHaveLength(16);
    double.click();
    expect(hits("kick.long")).toHaveLength(32);
    expect(saved().variants["kick.long"].steps.every(Boolean)).toBe(true);
  });

  it("only kicks have a build-up", () => {
    openEditor("perc.hat");
    expect(editor("perc.hat").querySelector('[data-action="build-up"]')).toBeNull();
  });

  it("a build-up plays the next bar as a doubling roll, then the kick goes back to its part", () => {
    const sd = stepDuration(145);
    const kickSteps = (from, to) =>
      ctx
        .sources()
        .filter((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 170)
        .map((s) => Math.round((s.startTime - 0.06) / sd))
        .filter((s) => s >= from && s < to);
    openEditor("kick.punchy");
    const toggle = editor("kick.punchy").querySelector('[data-action="build-up"]');
    toggle.click(); // a silent kick: arming it switches it on
    expect(pressed()).toEqual(["kick.punchy"]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(button("kick.punchy").parentElement.classList.contains("is-building")).toBe(true);
    advanceSeconds(BAR); // started right away: the first bar is the build-up
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click(); // armed again: bar 2 is already queued, so it takes bar 3
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    advanceSeconds(3 * BAR);
    expect(kickSteps(0, 16)).toEqual([0, 4, 8, 10, 12, 13, 14, 15]);
    expect(kickSteps(32, 48)).toEqual([32, 36, 40, 42, 44, 45, 46, 47]);
    expect(kickSteps(48, 64)).toEqual([48, 52, 56, 60]);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(button("kick.punchy").parentElement.classList.contains("is-building")).toBe(false);
    expect(saved()?.variants?.["kick.punchy"]).toBeUndefined(); // never stored
  });
});

describe("duplicating and renaming", () => {
  it("Duplicar adds a copy right after the original, opens it and focuses its name", () => {
    openEditor("kick.punchy");
    editor("kick.punchy").querySelector('[data-action="duplicate"]').click();
    const tiles = [...root.querySelectorAll('[data-layer="kick"] .tile')].map((t) => t.dataset.key);
    expect(tiles.slice(0, 2)).toEqual(["kick.punchy", "kick.punchy~1"]);
    expect(button("kick.punchy~1").querySelector(".variant-label").textContent).toBe("Punchy corto (copia)");
    expect(editor("kick.punchy~1")).not.toBeNull();
    expect(document.activeElement).toBe(editor("kick.punchy~1").querySelector('[data-action="name"]'));
    expect(saved().lists.kick).toContain("kick.punchy~1");
  });

  it("a renamed copy keeps its own data, plays on its own and survives a reload", () => {
    immediate();
    openEditor("kick.punchy");
    editor("kick.punchy").querySelector('[data-action="duplicate"]').click();
    const name = editor("kick.punchy~1").querySelector('[data-action="name"]');
    name.value = "Mi kick";
    name.dispatchEvent(new Event("input"));
    expect(button("kick.punchy~1").querySelector(".variant-label").textContent).toBe("Mi kick");
    const f0 = editor("kick.punchy~1").querySelector('[data-param="f0"]');
    f0.value = "200";
    f0.dispatchEvent(new Event("input"));
    expect(pressed()).toEqual(["kick.punchy~1"]);
    advance(10);
    expect(ctx.sources().some((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 200)).toBe(true);

    const again = document.createElement("div");
    mount(again, newEngine());
    expect(again.querySelector('[data-variant="kick.punchy~1"] .variant-label').textContent).toBe("Mi kick");
    again.querySelector('[data-edit="kick.punchy~1"]').click();
    expect(again.querySelector('[data-editor="kick.punchy~1"] [data-param="f0"]').value).toBe("200");
  });

  it("renaming a factory sound works too; an empty name brings the default back", () => {
    openEditor("perc.hat");
    const name = editor("perc.hat").querySelector('[data-action="name"]');
    name.value = "Hat abierto";
    name.dispatchEvent(new Event("input"));
    expect(saved().names["perc.hat"]).toBe("Hat abierto");
    name.value = " ";
    name.dispatchEvent(new Event("input"));
    name.dispatchEvent(new Event("blur"));
    expect(name.value).toBe("Hi-hat abierto");
    expect(saved().names["perc.hat"]).toBeUndefined();
  });

  it("only copies can be deleted, and deleting one stops it", () => {
    immediate();
    openEditor("lead.arp");
    expect(editor("lead.arp").querySelector('[data-action="remove"]')).toBeNull();
    editor("lead.arp").querySelector('[data-action="duplicate"]').click();
    click("lead.arp~1");
    editor("lead.arp~1").querySelector('[data-action="remove"]').click();
    expect(button("lead.arp~1")).toBeNull();
    expect(engine.isRunning()).toBe(false);
    expect(saved().lists.lead).not.toContain("lead.arp~1");
    expect(saved().variants["lead.arp~1"]).toBeUndefined();
  });
});

describe("snapshots", () => {
  const snapBtn = () => $('[data-action="snapshot"]');
  const snapTile = (id = "snap-1") => $(`[data-snap="${id}"]`);
  const snapEditor = (id = "snap-1") => $(`[data-editor="${id}"]`);
  const act = (id, action) => snapEditor(id).querySelector(`[data-action="${action}"]`);
  const setLevel = (variant, value) => {
    openEditor(variant);
    const input = editor(variant).querySelector('[data-param="level"]');
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };
  const typeName = (text) => {
    const name = act("snap-1", "name");
    name.value = text;
    name.dispatchEvent(new Event("input"));
  };

  it("needs something playing", () => {
    snapBtn().click();
    expect($(".status").textContent).toMatch(/No suena nada/);
    expect(snapTile()).toBeNull();
  });

  it("captures the mix and how it sounded; a click brings it back on the next bar line", () => {
    immediate();
    $("#combine").click();
    click("kick.long");
    click("bass.gallop");
    setLevel("bass.gallop", 0.5);
    snapBtn().click();
    expect(snapTile().querySelector(".variant-label").textContent).toBe("Groove");
    expect(snapTile().querySelector(".variant-detail").textContent).toBe("Groove · 2 sonidos");
    expect(snapTile().getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(act("snap-1", "name")); // ready to be named
    expect(saved().snapshots[0]).toMatchObject({ id: "snap-1", section: "groove", active: { kick: "kick.long", bass: "bass.gallop" } });

    setLevel("bass.gallop", 1);
    click("lead.acid");
    advance(10);
    snapTile().click(); // waits for the bar even with "Entrar a tiempo" off
    expect(snapTile().classList.contains("is-queued")).toBe(true);
    expect(pressed()).toContain("lead.acid");
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["kick.long", "bass.gallop"]);
    expect(saved().variants["bass.gallop"].level).toBe(0.5);
    expect(snapTile().getAttribute("aria-pressed")).toBe("true");
    expect(snapTile().classList.contains("is-queued")).toBe(false);
  });

  it("the background kick is captured as the kick it is", () => {
    immediate();
    click("bass.offbeat");
    snapBtn().click();
    expect(saved().snapshots[0].active).toEqual({ bass: "bass.offbeat", kick: "kick.punchy" });
  });

  it("a second click cancels the queue, a double click enters now", () => {
    click("kick.long");
    snapBtn().click();
    click("pad.air");
    advanceSeconds(BAR);
    snapTile().click();
    snapTile().click();
    expect(snapTile().classList.contains("is-queued")).toBe(false);
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["pad.air"]);
    for (const detail of [1, 2]) snapTile().dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
    expect(pressed()).toEqual(["kick.long"]);
  });

  it("the editor works on a draft: Guardar keeps it, Descartar goes back", () => {
    immediate();
    click("kick.long");
    snapBtn().click();
    expect(act("snap-1", "save").disabled).toBe(true);
    typeName("Mi pico");
    expect(act("snap-1", "save").disabled).toBe(false);
    expect(snapTile().parentElement.classList.contains("is-dirty")).toBe(true);
    act("snap-1", "restore").click();
    expect(act("snap-1", "name").value).toBe("Intro");
    expect(snapTile().parentElement.classList.contains("is-dirty")).toBe(false);

    typeName("Mi pico");
    const section = snapEditor().querySelector('[data-control="section"]');
    section.value = "peak";
    section.dispatchEvent(new Event("change"));
    const add = snapEditor().querySelector('[data-control="add-part"]');
    add.value = "pad.air";
    add.dispatchEvent(new Event("change"));
    expect([...snapEditor().querySelectorAll("[data-part]")].map((b) => b.dataset.part)).toEqual(["kick.long", "pad.air"]);
    expect(saved().snapshots[0].name).toBe("Intro"); // nothing saved yet

    // Folding the panel keeps the draft.
    act("snap-1", "close").click();
    $('[data-edit-snap="snap-1"]').click();
    expect(act("snap-1", "name").value).toBe("Mi pico");

    act("snap-1", "save").click();
    expect(saved().snapshots[0]).toMatchObject({ name: "Mi pico", section: "peak", active: { kick: "kick.long", "pad.air": "pad.air" } });
    expect(snapTile().querySelector(".variant-label").textContent).toBe("Mi pico");
    expect(snapTile().querySelector(".variant-detail").textContent).toBe("Pico · 2 sonidos");
    expect(act("snap-1", "save").disabled).toBe(true);
  });

  it("parts can be dropped and recaptured; an empty name falls back to the section", () => {
    immediate();
    $("#combine").click();
    click("kick.long");
    click("lead.acid");
    snapBtn().click();
    snapEditor().querySelector('[data-part="kick.long"]').click();
    expect(snapEditor().querySelectorAll("[data-part]")).toHaveLength(1);
    snapEditor().querySelector('[data-part="lead.acid"]').click();
    expect(act("snap-1", "save").disabled).toBe(true); // nothing to save without sounds
    click("pad.drone");
    act("snap-1", "recapture").click();
    typeName("");
    act("snap-1", "save").click();
    expect(saved().snapshots[0].active).toEqual({ kick: "kick.long", "lead.acid": "lead.acid", "pad.drone": "pad.drone" });
    expect(saved().snapshots[0].name).toBe("Subida");
  });

  it("Probar plays the unsaved draft; Borrar removes the snapshot", () => {
    immediate();
    click("kick.long");
    snapBtn().click();
    const add = snapEditor().querySelector('[data-control="add-part"]');
    add.value = "perc.clap";
    add.dispatchEvent(new Event("change"));
    act("snap-1", "try").click();
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["kick.long", "perc.clap"]);
    expect(saved().snapshots[0].active).toEqual({ kick: "kick.long" });
    act("snap-1", "remove").click();
    expect(snapTile()).toBeNull();
    expect(saved().snapshots).toEqual([]);
  });

  it("recalled under the autopilot, it moves the track to its section", () => {
    $("button.auto").click();
    snapBtn().click();
    expect(snapTile().querySelector(".variant-label").textContent).toBe("Intro");
    const section = snapEditor().querySelector('[data-control="section"]');
    section.value = "breakdown";
    section.dispatchEvent(new Event("change"));
    act("snap-1", "save").click();
    snapTile().click();
    advanceSeconds(BAR);
    expect($(".section-badge").textContent).toBe("Break");
  });

  it("survive a reload, travel in presets and lose a deleted copy", async () => {
    immediate();
    $("#combine").click();
    openEditor("lead.arp");
    editor("lead.arp").querySelector('[data-action="duplicate"]').click();
    click("kick.long");
    click("lead.arp~1");
    snapBtn().click();
    click("pad.air");
    snapBtn().click();

    const again = document.createElement("div");
    mount(again, newEngine());
    expect([...again.querySelectorAll("[data-snap]")].map((b) => b.dataset.snap)).toEqual(["snap-1", "snap-2"]);

    $('[data-action="export"]').click();
    const preset = JSON.parse(await downloads.at(-1).text());
    expect(preset.snapshots).toHaveLength(2);

    openEditor("lead.arp~1");
    editor("lead.arp~1").querySelector('[data-action="remove"]').click();
    expect(saved().snapshots[0].active).toEqual({ kick: "kick.long" });
    expect(saved().snapshots[1].active).toEqual({ kick: "kick.long", "pad.air": "pad.air" });
  });
});

describe("BPM change", () => {
  const rampTo = (bpm, bars) => {
    $("#ramp-to").value = String(bpm);
    if (bars) {
      const sel = $('[data-control="ramp-bars"]');
      sel.value = String(bars);
      sel.dispatchEvent(new Event("change"));
    }
    $('[data-action="ramp"]').click();
  };

  it("with the loop stopped, it just sets the BPM", () => {
    rampTo(160);
    expect($("#bpm").value).toBe("160");
    expect(saved().bpm).toBe(160);
  });

  it("while playing, it moves one slice per bar line and lands on the target", () => {
    immediate();
    click("kick.long");
    advance(10);
    rampTo(149, 4);
    expect($("#bpm").value).toBe("145");
    expect($('[data-action="ramp"]').getAttribute("aria-pressed")).toBe("true");
    advanceSeconds(BAR);
    expect($("#bpm").value).toBe("146");
    expect($(".bpm-value").textContent).toBe("146 → 149");
    advanceSeconds(3 * BAR + 0.5);
    expect($("#bpm").value).toBe("149");
    expect($(".bpm-value").textContent).toBe("149");
    expect($('[data-action="ramp"]').getAttribute("aria-pressed")).toBe("false");
    expect(saved().bpm).toBe(149);
    expect(saved().rampBars).toBe(4);
    const kicks = ctx
      .sources()
      .filter((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 120)
      .map((s) => s.startTime);
    expect(kicks.at(-1) - kicks.at(-2)).toBeCloseTo(60 / 149, 6);
  });

  it("the slider, Parar or the button itself cut it", () => {
    immediate();
    click("kick.long");
    rampTo(170, 8);
    $('[data-action="ramp"]').click();
    expect($('[data-action="ramp"]').getAttribute("aria-pressed")).toBe("false");
    rampTo(170, 8);
    const bpm = $("#bpm");
    bpm.value = "150";
    bpm.dispatchEvent(new Event("input"));
    advanceSeconds(2 * BAR);
    expect(bpm.value).toBe("150");
    rampTo(170, 8);
    $("button.stop").click();
    expect($('[data-action="ramp"]').getAttribute("aria-pressed")).toBe("false");
  });
});

describe("reordering", () => {
  it("a layer's grip moves it with the arrow keys, and the order is remembered", () => {
    const grip = $('[data-layer="kick"] .grip');
    grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const order = [...root.querySelectorAll("section.layer")].map((s) => s.dataset.layer);
    expect(order.slice(0, 2)).toEqual(["bass", "kick"]);
    expect(saved().order.slice(0, 2)).toEqual(["bass", "kick"]);
    const again = document.createElement("div");
    mount(again, newEngine());
    expect(again.querySelector("section.layer").dataset.layer).toBe("bass");
  });

  it("Alt + arrows move a tile inside its layer", () => {
    button("pad.chord").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
    expect(saved().lists.pad.slice(0, 2)).toEqual(["pad.prog", "pad.chord"]);
  });
});

describe("autopilot", () => {
  const autoBtn = () => $("button.auto");

  it("starts an intro from silence and keeps arranging on every loop", () => {
    autoBtn().click();
    expect(autoBtn().getAttribute("aria-pressed")).toBe("true");
    expect($(".section-badge").textContent).toBe("Intro");
    expect(engine.isRunning()).toBe(true);
    expect(pressed().some((v) => v.startsWith("kick."))).toBe(true);
    const sections = new Set();
    for (let i = 0; i < 20; i++) {
      advanceSeconds(2 * BAR);
      sections.add($(".section-badge").textContent);
    }
    expect(sections.size).toBeGreaterThanOrEqual(3);
  });

  it("over a playing mix it carries on from there instead of starting over", () => {
    click("bass.rolling");
    advanceSeconds(BAR);
    autoBtn().click();
    expect($(".section-badge").textContent).toBe("Groove");
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Groove");
    expect(pressed()).toEqual(expect.arrayContaining(["bass.rolling", "kick.punchy"]));
  });

  it("the same seed plays the same track", () => {
    const record = (node, c) => {
      const log = [];
      node.querySelector("button.auto").click();
      for (let i = 0; i < 12; i++) {
        for (let k = 0; k < Math.ceil((2 * BAR) / 0.025); k++) {
          c.currentTime += 0.025;
          vi.advanceTimersByTime(25);
        }
        log.push([...node.querySelectorAll('[aria-pressed="true"][data-variant]')].map((b) => b.dataset.variant).join());
      }
      return log;
    };
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    const first = record(root, ctx);
    $("button.stop").click();

    localStorage.clear();
    const c2 = new FakeAudioContext();
    const other = document.createElement("div");
    mount(other, newEngine(c2));
    other.querySelector("#seed").value = "goa";
    other.querySelector("#seed").dispatchEvent(new Event("change"));
    expect(record(other, c2)).toEqual(first);
  });

  it("Parar turns it off", () => {
    autoBtn().click();
    $("button.stop").click();
    expect(autoBtn().getAttribute("aria-pressed")).toBe("false");
    expect($(".section-badge").hidden).toBe(true);
  });

  const layers = () => pressed().map((v) => v.split(".")[0]);

  it("never leaves kick, bass and percussion alone for more than a bar", () => {
    autoBtn().click();
    for (let i = 0; i < 60; i++) {
      advanceSeconds(BAR);
      expect(layers().some((l) => l === "lead" || l === "pad")).toBe(true);
    }
    $("#combine").click();
    for (const id of pressed().filter((v) => /^(lead|pad)\./.test(v))) click(id);
    advanceSeconds(BAR);
    expect(layers().some((l) => l === "lead" || l === "pad")).toBe(false); // the user's own bare bar
    expect(layers()).toContain("kick");
    let bareBars = 0;
    for (let i = 0; i < 4; i++) {
      advanceSeconds(BAR);
      if (!layers().some((l) => l === "lead" || l === "pad")) bareBars++;
    }
    expect(bareBars).toBeLessThanOrEqual(1);
  });

  it("the seed dresses every sound it brings in, the same way every time", () => {
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    autoBtn().click();
    advanceSeconds(8 * BAR);
    const kick = pressed().find((v) => v.startsWith("kick."));
    const ws = saved();
    expect(ws.auto).toContain(kick);
    expect(button(kick).parentElement.classList.contains("is-auto")).toBe(true);
    expect(button(kick).parentElement.classList.contains("is-edited")).toBe(false);
    $("button.stop").click();
    autoBtn().click(); // from silence again: same seed, same sounds
    advanceSeconds(8 * BAR);
    expect(saved().variants[kick]).toEqual(ws.variants[kick]);
  });

  it("a style picks its sounds and takes the BPM to its own", () => {
    const style = $('[data-control="style"]');
    style.value = "techno";
    style.dispatchEvent(new Event("change"));
    expect($("#bpm").value).toBe("132");
    expect(saved().style).toBe("techno");
    autoBtn().click();
    const techno = {
      kick: ["kick.techno", "kick.rumble"],
      bass: ["bass.techno", "bass.offbeat"],
      perc: ["perc.hat", "perc.hat16", "perc.clap", "perc.rim", "perc.ride"],
      lead: ["lead.techno", "lead.stabs", "lead.acid"],
      pad: ["pad.drone", "pad.fifths", "pad.air"],
    };
    for (let i = 0; i < 20; i++) {
      for (const v of pressed()) expect(techno[v.split(".")[0]]).toContain(v);
      advanceSeconds(2 * BAR);
    }
  });

  it("phases: a click starts there, later ones queue up and ✕ drops one before it plays", () => {
    $('[data-section="peak"]').click();
    expect(autoBtn().getAttribute("aria-pressed")).toBe("true");
    expect($(".section-badge").textContent).toBe("Pico");
    $('[data-section="breakdown"]').click();
    $('[data-section="groove"]').click();
    const queue = () => [...root.querySelectorAll(".section-queue [data-queued]")].map((li) => li.dataset.queued);
    expect(queue()).toEqual(["breakdown", "groove"]);
    root.querySelector('.section-queue [data-queued="breakdown"] .unqueue').click();
    expect(queue()).toEqual(["groove"]);
    $('[data-action="next-section"]').click();
    expect($('[data-action="next-section"]').disabled).toBe(true);
    expect(root.querySelector(".section-queue .is-next").dataset.queued).toBe("groove");
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Groove");
    expect(queue()).toEqual([]);
  });

  it("the changes slider sets how often a section swaps a sound, and is remembered", () => {
    const changes = $("#changes");
    changes.value = "0";
    changes.dispatchEvent(new Event("input"));
    expect($('output[for="changes"]').textContent).toBe("cada 2 compases");
    expect(saved().changeBars).toBe(2);
  });
});

describe("language", () => {
  it("switches every text, keeps what plays and is remembered", () => {
    click("bass.rolling");
    const lang = $('[data-control="lang"]');
    lang.value = "en";
    lang.dispatchEvent(new Event("change"));
    expect($("button.stop").textContent).toBe("Stop");
    expect(button("kick.punchy").querySelector(".variant-label").textContent).toBe("Short punchy");
    expect(pressed()).toEqual(["bass.rolling"]);
    expect(document.documentElement.lang).toBe("en");
    expect(saved().lang).toBe("en");

    const again = document.createElement("div");
    mountApp(again, newEngine(), { languages: ["es"] });
    expect(again.querySelector("button.stop").textContent).toBe("Stop");
  });

  it("speaks Portuguese too", () => {
    const lang = $('[data-control="lang"]');
    lang.value = "pt";
    lang.dispatchEvent(new Event("change"));
    expect($('[data-layer="bass"] h2').textContent).toBe("Baixo");
  });
});

describe("export, import, reset", () => {
  it("Exportar preset downloads the workspace with the current mix", async () => {
    immediate();
    click("lead.acid");
    $('[data-action="export"]').click();
    const blob = downloads.at(-1);
    expect(blob.fileName).toBe("psy-layers-preset.json");
    const preset = JSON.parse(await blob.text());
    expect(preset).toMatchObject({ app: "psy-sampler", bpm: 145, active: { "lead.acid": "lead.acid" } });
  });

  it("Importar preset loads it and plays its mix", async () => {
    const input = $('input[type="file"]');
    const preset = { app: "psy-sampler", bpm: 160, names: { "perc.hat": "Hat" }, active: { bass: "bass.gallop" } };
    Object.defineProperty(input, "files", { value: [new File([JSON.stringify(preset)], "p.json")] });
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect($("#bpm").value).toBe("160");
    expect(button("perc.hat").querySelector(".variant-label").textContent).toBe("Hat");
    expect(pressed()).toEqual(["bass.gallop"]);
    expect($(".status").textContent).toBe("Preset cargado.");
  });

  it("a foreign file is refused", async () => {
    const input = $('input[type="file"]');
    Object.defineProperty(input, "files", { value: [new File(["{}"], "x.json")] });
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect($(".status").textContent).toMatch(/no es un preset/);
  });

  it("Audio del mix downloads a WAV loop of what plays; each editor exports its sound", async () => {
    $('[data-action="wav-mix"]').click();
    expect($(".status").textContent).toMatch(/Prendé alguna capa/);
    click("bass.offbeat");
    $('[data-action="wav-mix"]').click();
    await flushPromises();
    expect(downloads.at(-1).fileName).toBe("psy-layers-145bpm.wav");
    expect(downloads.at(-1).type).toBe("audio/wav");
    openEditor("fx.crash");
    editor("fx.crash").querySelector('[data-action="wav"]').click();
    await flushPromises();
    expect(downloads.at(-1).fileName).toBe("crash-145bpm.wav");
  });

  it("Restaurar todo goes back to factory", () => {
    openEditor("perc.hat");
    stepCell("perc.hat", 0).click();
    editor("perc.hat").querySelector('[data-action="duplicate"]').click();
    $('[data-layer="kick"] .grip').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    $('[data-action="reset-all"]').click();
    expect(root.querySelectorAll(".is-edited, .is-copy")).toHaveLength(0);
    expect($("section.layer").dataset.layer).toBe("kick");
    expect(saved().variants).toEqual({});
    expect(engine.isRunning()).toBe(false);
  });
});

describe("share links", () => {
  it("Compartir copies a link with the seed, the style and the BPM", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    $("#seed").value = "trance";
    $("#seed").dispatchEvent(new Event("change"));
    $('[data-action="share"]').click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/#seed=trance&style=psytrance&bpm=145`);
    expect($(".status").textContent).toMatch(/Link copiado/);
  });

  it("opening a link loads its seed, style and BPM, then clears the fragment", async () => {
    history.replaceState(null, "", "/#seed=goa42&style=goa&bpm=160");
    const node = document.createElement("div");
    mount(node, newEngine());
    await flushPromises();
    expect(node.querySelector("#seed").value).toBe("goa42");
    expect(node.querySelector('[data-control="style"]').value).toBe("goa");
    expect(node.querySelector("#bpm").value).toBe("160");
    expect(node.querySelector(".status").textContent).toMatch(/goa42/);
    expect(location.hash).toBe("");
  });
});
