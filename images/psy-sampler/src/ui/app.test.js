// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext, FakeWorklet } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { defaultData } from "../audio/patterns.js";
import { stepDuration } from "../audio/timing.js";
import { STYLES } from "../autopilot.js";
import { GENRE, systemOf } from "../planner.js";
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

const newEngine = (c = new FakeAudioContext()) =>
  createEngine({
    createContext: () => c,
    createOffline: fakeOffline,
    createWorklet: (ctx, name, options) => new FakeWorklet(ctx, name, options),
  });
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
    expect([bpm.min, bpm.max, bpm.value]).toEqual(["60", "180", "145"]);
    expect($("#bgkick").checked).toBe(true);
    expect($("#quantize").checked).toBe(true);
    expect($("#delay").checked).toBe(true);
    expect($("#reverb").checked).toBe(true);
    expect($("button.stop").textContent).toBe("Parar");
    expect($("#seed").value).toMatch(/^[a-z2-9]{6}$/);
  });

  it("a sound that is off shows its volume as a bar that sets it before it plays", () => {
    const bar = $('[data-level="lead.arp"]');
    expect($('[data-level="fx.impact"]')).toBeNull();
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(saved().variants["lead.arp"].level).toBeCloseTo(1.05, 9);
    bar.getBoundingClientRect = () => ({ left: 0, width: 150 });
    bar.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 50 }));
    expect(saved().variants["lead.arp"].level).toBeCloseTo(0.5, 9);
    expect(bar.getAttribute("aria-valuetext")).toBe("50 %");
    immediate();
    click("lead.arp");
    expect(bar.hidden).toBe(true); // playing, the fill takes over
    expect(button("lead.arp").style.getPropertyValue("--level")).toBe("33.3%");
  });

  it("🎧 held solos a playing sound and dims the rest; idle, it does nothing", () => {
    const setSolo = vi.spyOn(engine, "setSolo");
    const solo = (id) => $(`[data-solo="${id}"]`);
    const down = (id) => solo(id).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    const up = (id) => solo(id).dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    expect($('[data-solo="fx.impact"]')).toBeNull(); // one-shots have none
    down("lead.arp");
    expect(setSolo).not.toHaveBeenCalled();
    immediate();
    click("lead.arp");
    click("bass.offbeat");
    flushFrame();
    expect(solo("lead.arp").classList.contains("is-idle")).toBe(false);
    down("lead.arp");
    expect(setSolo).toHaveBeenLastCalledWith("lead.arp");
    expect($(".layers").classList.contains("is-soloing")).toBe(true);
    expect(solo("lead.arp").closest(".tile").classList.contains("is-solo")).toBe(true);
    down("bass.offbeat"); // a second finger does not steal it
    expect(setSolo).toHaveBeenCalledTimes(1);
    up("bass.offbeat");
    expect(setSolo).toHaveBeenCalledTimes(1);
    up("lead.arp");
    expect(setSolo).toHaveBeenLastCalledWith(null);
    expect($(".layers").classList.contains("is-soloing")).toBe(false);
    solo("bass.offbeat").dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(setSolo).toHaveBeenLastCalledWith("bass.offbeat");
    solo("bass.offbeat").dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    expect(setSolo).toHaveBeenLastCalledWith(null);
  });

  it("ends with the credits and a link to the source", () => {
    const credits = $("footer.credits");
    expect(credits.querySelector("a").href).toBe("https://github.com/frodoagu/home/tree/main/images/psy-sampler");
    expect(credits.textContent).toContain("Hecho con ❤️ en 🌍 con Claude por Fr0D3");
  });

  it("opens the how-to page from the top bar, and closes it with ✕ or the backdrop", () => {
    const dialog = $("dialog.help");
    dialog.showModal = () => dialog.setAttribute("open", "");
    dialog.close = () => dialog.removeAttribute("open");
    expect($('.topbar [data-action="help"]')).not.toBeNull();
    $('[data-action="help"]').click();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("h3").textContent).toBe("Trucos");
    expect(dialog.textContent).toContain("Doble clic en un sonido");
    $(".help-close").click();
    expect(dialog.open).toBe(false);
    $('[data-action="help"]').click();
    dialog.querySelector("dd").click(); // inside the page: stays open
    expect(dialog.open).toBe(true);
    dialog.click();
    expect(dialog.open).toBe(false);
  });

  it("has one row per layer plus the snapshots, and a 16-cell bar with the 4 beats marked", () => {
    expect(root.querySelectorAll("section.layer")).toHaveLength(9);
    expect(root.querySelector("section.layer:last-of-type").dataset.layer).toBe("snap");
    expect(root.querySelectorAll(".cell")).toHaveLength(16);
    expect([...root.querySelectorAll(".cell.beat")].map((c) => c.textContent)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("layers", () => {
  beforeEach(immediate);

  it("stacks percussion and leads, but keeps one kick and one bass", () => {
    for (const v of ["perc.hat", "perc.clap", "lead.acid", "lead.arp", "kick.long", "kick.tok"]) click(v);
    expect(pressed().sort()).toEqual(["kick.tok", "lead.acid", "lead.arp", "perc.clap", "perc.hat"]);
    expect(button("lead.acid").classList.contains("is-active")).toBe(true);
    expect(engine.isRunning()).toBe(true);
  });

  it("Ctrl+click stacks basses (or kicks); a plain click leaves one again", () => {
    const ctrlClick = (v) => button(v).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 }));
    click("bass.offbeat");
    ctrlClick("bass.rolling");
    ctrlClick("kick.long");
    ctrlClick("kick.tok");
    expect(pressed().sort()).toEqual(["bass.offbeat", "bass.rolling", "kick.long", "kick.tok"]);
    expect(button("kick.punchy").classList.contains("is-background")).toBe(false);
    ctrlClick("bass.offbeat");
    expect(pressed().sort()).toEqual(["bass.rolling", "kick.long", "kick.tok"]);
    click("kick.dark");
    expect(pressed().sort()).toEqual(["bass.rolling", "kick.dark"]);
  });

  it("toggles variants across layers, one per layer", () => {
    click("bass.rolling");
    click("lead.acid");
    expect(pressed().sort()).toEqual(["bass.rolling", "lead.acid"]);
    click("bass.offbeat");
    expect(pressed().sort()).toEqual(["bass.offbeat", "lead.acid"]);
    click("lead.acid");
    expect(pressed()).toEqual(["bass.offbeat"]);
  });

  it("clicking the last active variant again stops", () => {
    click("pad.chord");
    click("pad.chord");
    expect(pressed()).toEqual([]);
    expect(engine.isRunning()).toBe(false);
  });
});

describe("on the beat (queued clicks)", () => {
  it("the first click starts at once; later ones wait for the next bar line", () => {
    click("kick.long");
    expect(pressed()).toEqual(["kick.long"]);
    advance(10);
    click("kick.tok");
    expect(pressed()).toEqual(["kick.long"]);
    expect(queued()).toEqual(["kick.tok"]);
    expect(button("kick.long").classList.contains("is-leaving")).toBe(true);
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["kick.tok"]);
    expect(queued()).toEqual([]);
  });

  it("a queued change enters exactly on the bar line", () => {
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
    click("lead.acid");
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
    expect(pressed()).toEqual(["kick.long", "bass.rolling"]);
    expect(queued()).toEqual([]);
  });

  it("a double click does not undo itself when clicks already apply at once", () => {
    immediate();
    click("kick.long");
    dblclick("bass.rolling");
    expect(pressed()).toEqual(["kick.long", "bass.rolling"]);
  });

  it("is remembered", () => {
    immediate();
    expect(saved().quantize).toBe(false);
  });
});

describe("arming the start", () => {
  const cue = () => $('[data-action="cue"]');

  it("armed, clicks queue in silence and ▶ starts them together", () => {
    expect(cue().textContent).toBe("⏺ Armar");
    cue().click();
    expect(cue().textContent).toBe("▶ Arrancar");
    click("kick.long");
    click("perc.shaker");
    click("bass.rolling");
    expect(engine.isRunning()).toBe(false);
    expect(pressed()).toEqual([]);
    expect(queued()).toEqual(["kick.long", "bass.rolling", "perc.shaker"]);
    cue().click();
    expect(engine.isRunning()).toBe(true);
    expect(pressed()).toEqual(["kick.long", "bass.rolling", "perc.shaker"]);
    expect(queued()).toEqual([]);
    expect(cue().hidden).toBe(true);
  });

  it("a second click takes a sound back out of the queue, a double click queues it once", () => {
    cue().click();
    click("lead.acid");
    click("lead.acid");
    dblclick("pad.chord");
    expect(queued()).toEqual(["pad.chord"]);
    expect(engine.isRunning()).toBe(false);
  });

  it("Parar leaves what played queued, and turns into ▶ to bring it back", () => {
    immediate();
    click("kick.long");
    click("perc.shaker");
    expect($(".stop").hidden).toBe(false);
    $(".stop").click();
    expect(engine.isRunning()).toBe(false);
    expect(pressed()).toEqual([]);
    expect(queued()).toEqual(["kick.long", "perc.shaker"]);
    expect($(".stop").hidden).toBe(true);
    expect(cue().hidden).toBe(false);
    expect(cue().textContent).toBe("▶ Arrancar");
    cue().click();
    expect(engine.isRunning()).toBe(true);
    expect(pressed()).toEqual(["kick.long", "perc.shaker"]);
    expect(queued()).toEqual([]);
  });

  it("stopped with nothing playing, the slot offers ⏺ Armar", () => {
    expect($(".stop").hidden).toBe(true);
    expect(cue().textContent).toBe("⏺ Armar");
  });

  it("FX still fire while armed", () => {
    cue().click();
    $('[data-variant="fx.crash"]').click();
    expect(ctx.sources().length).toBeGreaterThan(0);
    expect(engine.isRunning()).toBe(false);
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
    for (const id of ["#bgkick", "#quantize", "#delay", "#reverb"]) $(id).click();
    const bpm = $("#bpm");
    bpm.value = "150";
    bpm.dispatchEvent(new Event("input"));
    const again = document.createElement("div");
    mount(again, newEngine());
    const q = (sel) => again.querySelector(sel);
    expect([q("#bgkick"), q("#quantize"), q("#delay"), q("#reverb")].map((c) => c.checked)).toEqual([
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

  it("a part longer than a loop pages its piano roll; Largo trims it", () => {
    openEditor("classic.popcorn");
    const pages = () => [...editor("classic.popcorn").querySelectorAll(".roll-pages button")];
    const steps = () => [...editor("classic.popcorn").querySelectorAll(".roll [data-step]")].map((c) => Number(c.dataset.step));
    expect(pages().map((b) => b.textContent)).toEqual(["1-2", "3-4", "5-6", "7-8", "9-10", "11-12", "13-14", "15-16"]);
    expect(Math.max(...steps())).toBe(31);
    pages()[2].click();
    expect(Math.min(...steps())).toBe(64);
    expect(pages()[2].getAttribute("aria-pressed")).toBe("true");
    const loops = editor("classic.popcorn").querySelector('[data-control="loops"]');
    loops.value = "2";
    loops.dispatchEvent(new Event("change"));
    expect(pages().map((b) => b.textContent)).toEqual(["1-2", "3-4"]);
    expect(Math.min(...steps())).toBe(0);
  });

  it("Cerrar closes the panel", () => {
    openEditor("pad.chord");
    editor("pad.chord").querySelector('[data-action="close"]').click();
    expect(editor("pad.chord")).toBeNull();
  });

  it("floats like a context menu: a press elsewhere or Esc closes it, a press inside does not", () => {
    const down = (target) => target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    openEditor("lead.acid");
    down(editor("lead.acid"));
    expect(editor("lead.acid")).not.toBeNull();
    down($('[data-edit="lead.acid"]')); // its own toggle: the click that follows closes it
    expect(editor("lead.acid")).not.toBeNull();
    down($('[data-variant="bass.rolling"]'));
    expect(editor("lead.acid")).toBeNull();
    openEditor("lead.acid");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(editor("lead.acid")).toBeNull();
    expect(document.activeElement).toBe($('[data-edit="lead.acid"]'));
  });

  it("a piano-roll click adds a note and switches the variant on, without a preview over the loop", () => {
    const audition = vi.spyOn(engine, "audition");
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
    expect(audition).not.toHaveBeenCalled();
  });

  it("a playing tile's fill is its volume: ← → or a drag across it set it, and a drag does not toggle", () => {
    immediate();
    const tile = button("lead.acid");
    const detail = () => tile.querySelector(".variant-detail").textContent;
    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(saved()?.variants?.["lead.acid"]).toBeUndefined(); // silent, it is just a button
    click("lead.acid");
    expect(tile.style.getPropertyValue("--level")).toBe("66.7%");
    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(saved().variants["lead.acid"].level).toBe(1.05);
    expect(tile.style.getPropertyValue("--level")).toBe("70%");
    openEditor("lead.acid");
    const output = editor("lead.acid").querySelector('[data-param="level"]').nextElementSibling;
    tile.getBoundingClientRect = () => ({ left: 0, width: 300 });
    tile.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
    tile.dispatchEvent(new MouseEvent("pointermove", { clientX: 150, bubbles: true }));
    expect(detail()).toBe("Volumen 75 %");
    expect(output.textContent).toBe("75 %");
    tile.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, bubbles: true }));
    tile.dispatchEvent(new MouseEvent("pointerup", { clientX: 400, bubbles: true }));
    tile.click();
    expect(saved().variants["lead.acid"].level).toBe(1.5);
    expect(pressed()).toEqual(["lead.acid"]);
    expect(detail()).not.toMatch(/Volumen/);
    expect(tile.parentElement.classList.contains("is-dragging")).toBe(false);
    expect(button("fx.riser").classList.contains("has-level")).toBe(false);
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
    const reset = () => editor("perc.hat").querySelector('[data-action="reset"]');
    reset().click();
    expect(reset().getAttribute("aria-pressed")).toBe("true"); // it plays: waits for the bar line
    expect(saved().variants["perc.hat"]).toBeDefined();
    advanceSeconds(BAR);
    expect(saved().variants["perc.hat"]).toBeUndefined();
    expect(reset().getAttribute("aria-pressed")).toBe("false");
    expect(stepCell("perc.hat", 0).dataset.state).toBe("");
    expect(stepCell("perc.hat", 2).dataset.state).toBe("hit");
  });

  it("Restaurar notas brings back the factory part and keeps the sound", () => {
    openEditor("bass.offbeat");
    const bright = editor("bass.offbeat").querySelector('[data-param="bright"]');
    bright.value = "2";
    bright.dispatchEvent(new Event("input"));
    editor("bass.offbeat").querySelector(".editor-actions button:last-child").click(); // clear all
    expect(saved().variants["bass.offbeat"].notes).toEqual([]);
    editor("bass.offbeat").querySelector('[data-action="reset-part"]').click();
    advanceSeconds(BAR);
    const stored = saved().variants["bass.offbeat"];
    expect(stored.notes).toEqual(defaultData("bass.offbeat").notes);
    expect(stored.params.bright).toBe(2);
    expect(editor("bass.offbeat").querySelectorAll('[data-state="hit"], [data-state="accent"]').length).toBeGreaterThan(0);
  });

  it("Restaurar golpes on an edit that only touched the hits forgets the edit", () => {
    openEditor("perc.hat");
    expect(editor("perc.hat").querySelector('[data-action="reset-part"]').textContent).toBe("Restaurar golpes");
    stepCell("perc.hat", 0).click();
    editor("perc.hat").querySelector('[data-brush="p"]').click();
    editor("perc.hat").querySelector('[data-action="brush-all"]').click(); // the mods go with the hits
    expect(saved().variants["perc.hat"].mods.filter(Boolean)).toHaveLength(9);
    editor("perc.hat").querySelector('[data-action="reset-part"]').click();
    advanceSeconds(BAR);
    expect(saved().variants["perc.hat"]).toBeUndefined();
    expect(stepCell("perc.hat", 0).dataset.state).toBe("");
    expect(button("perc.hat").parentElement.classList.contains("is-edited")).toBe(false);
  });

  it("FX editors have no part to reset", () => {
    openEditor("fx.riser");
    expect(editor("fx.riser").querySelector('[data-action="reset-part"]')).toBeNull();
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

  it("a playing sound's tile flashes on its hits (not its layer), and the BPM on the beat", () => {
    const flashes = (node) => (node.classList.contains("hit-a") ? "a" : node.classList.contains("hit-b") ? "b" : "");
    click("kick.punchy");
    advance(4);
    flushFrame();
    const first = flashes(button("kick.punchy"));
    expect(first).not.toBe("");
    expect(flashes($('[data-layer="kick"]'))).toBe("");
    expect(flashes($(".bpm-value"))).not.toBe("");
    expect(flashes(button("kick.long"))).toBe("");
    advanceSeconds(BAR);
    flushFrame();
    expect(flashes(button("kick.punchy"))).not.toBe(first); // replayed on a later hit
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

  it("each layer has a volume over all its sounds, remembered", () => {
    const fader = $('[data-layer="lead"] .layer-volume input');
    expect(fader.getAttribute("aria-label")).toMatch(/^Volumen de /);
    fader.value = "0.5";
    fader.dispatchEvent(new Event("input"));
    expect(saved().volumes.lead).toBe(0.5);
    expect(saved().volumes.pad).toBe(1);
  });

  it("Ctrl+click repeats a step on every beat of its bar; with Shift, of both bars", () => {
    openEditor("perc.hat");
    const ctrlClick = (step, shiftKey = false) =>
      stepCell("perc.hat", step).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, shiftKey }));
    const on = () => saved().variants["perc.hat"].steps.flatMap((v, s) => (v ? [s] : []));
    $("[data-editor] .editor-actions button:last-child").click(); // clear all
    ctrlClick(1);
    expect(on()).toEqual([1, 5, 9, 13]);
    ctrlClick(19, true);
    expect(on()).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 19, 23, 27, 31]);
  });
});

describe("brush (mods)", () => {
  const pick = (variant, control, value) => {
    if (control === "brush") return editor(variant).querySelector(`[data-brush="${value}"]`).click();
    const sel = editor(variant).querySelector(`[data-control="${control}"]`);
    sel.value = String(value);
    sel.dispatchEvent(new Event("change"));
  };
  const mods = (variant) => saved().variants[variant].mods;

  it("paints a chance on a hit, shows it, and a second click takes it off", () => {
    openEditor("perc.hat"); // offbeats: 2, 6, 10…
    pick("perc.hat", "brush", "p");
    pick("perc.hat", "brush-p", 0.25);
    stepCell("perc.hat", 2).click();
    expect(mods("perc.hat")[2]).toEqual({ p: 0.25 });
    const cell = stepCell("perc.hat", 2);
    expect(cell.hasAttribute("data-chance")).toBe(true);
    expect(cell.dataset.mod).toBe("25");
    expect(cell.getAttribute("aria-label")).toBe("Paso 3: golpe, Rara vez · 25 %");
    stepCell("perc.hat", 2).click();
    expect(stepCell("perc.hat", 2).hasAttribute("data-chance")).toBe(false);
    expect(mods("perc.hat")[2]).toBeNull();
  });

  it("on an empty step it writes a hit carrying the brush; writing it away drops the mod", () => {
    openEditor("perc.hat");
    pick("perc.hat", "brush", "ply");
    pick("perc.hat", "brush-ply", 3);
    stepCell("perc.hat", 1).click();
    expect(saved().variants["perc.hat"].steps[1]).toBe(1);
    expect(mods("perc.hat")[1]).toEqual({ ply: 3 });
    expect(stepCell("perc.hat", 1).dataset.mod).toBe("×3");
    pick("perc.hat", "brush", "hit");
    stepCell("perc.hat", 1).click(); // accent
    stepCell("perc.hat", 1).click(); // empty
    expect(mods("perc.hat")[1]).toBeNull();
  });

  it("Aplicar a todo puts a condition on every hit, and again takes it off", () => {
    openEditor("perc.clap"); // beats 2 and 4
    pick("perc.clap", "brush", "cond");
    pick("perc.clap", "brush-cond", "!4:4");
    const all = editor("perc.clap").querySelector('[data-action="brush-all"]');
    expect(all.hidden).toBe(false);
    all.click();
    expect(mods("perc.clap").filter(Boolean)).toEqual(Array(4).fill({ cond: "!4:4" }));
    expect(stepCell("perc.clap", 4).dataset.mod).toBe("!4:4");
    all.click();
    expect(mods("perc.clap").every((m) => m === null)).toBe(true);
  });

  it("marks a note in the piano roll, and every editor shares the brush", () => {
    openEditor("lead.melodic"); // A4 (69) over steps 0-7
    pick("lead.melodic", "brush", "cond");
    pick("lead.melodic", "brush-cond", "1:4");
    rollCell("lead.melodic", 69, 3).click();
    expect(saved().variants["lead.melodic"].notes[0]).toMatchObject({ step: 0, midi: 69, len: 8, cond: "1:4" });
    expect(rollCell("lead.melodic", 69, 0).dataset.mod).toBe("1:4");
    expect(rollCell("lead.melodic", 69, 3).dataset.mod).toBeUndefined();
    openEditor("perc.hat");
    expect(editor("perc.hat").querySelector('[data-brush="cond"]').getAttribute("aria-pressed")).toBe("true");
    expect(editor("perc.hat").querySelector('[data-control="brush-cond"]').value).toBe("1:4");
  });

  it("↺ Restaurar shows once the brush moves and takes it back to Escribe", () => {
    openEditor("perc.hat");
    const reset = editor("perc.hat").querySelector('[data-action="brush-reset"]');
    expect(reset.hidden).toBe(true);
    expect(editor("perc.hat").querySelector('[data-brush="hit"]').getAttribute("aria-pressed")).toBe("true");
    pick("perc.hat", "brush", "ply");
    pick("perc.hat", "brush-ply", 4);
    expect(reset.hidden).toBe(false);
    reset.click();
    expect(reset.hidden).toBe(true);
    expect(editor("perc.hat").querySelector('[data-brush="hit"]').getAttribute("aria-pressed")).toBe("true");
    expect(editor("perc.hat").querySelector('[data-control="brush-ply"]').value).toBe("2");
    stepCell("perc.hat", 1).click();
    expect(saved().variants["perc.hat"].steps[1]).toBe(1);
    expect(mods("perc.hat")[1]).toBeNull();
  });

  it("Quitar modificadores shows while any exists and takes them all off", () => {
    openEditor("lead.melodic");
    const clear = editor("lead.melodic").querySelector('[data-action="brush-clear"]');
    expect(clear.hidden).toBe(true);
    pick("lead.melodic", "brush", "p");
    editor("lead.melodic").querySelector('[data-action="brush-all"]').click();
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(saved().variants["lead.melodic"].notes.every((n) => !("p" in n))).toBe(true);
    expect(clear.hidden).toBe(true);
  });

  it("a snapshot keeps the mods it was taken with", () => {
    openEditor("perc.hat");
    pick("perc.hat", "brush", "cond");
    pick("perc.hat", "brush-cond", "2:4");
    stepCell("perc.hat", 2).click();
    click("perc.hat");
    $('[data-action="snapshot"]').click();
    expect(saved().snapshots.at(-1).data["perc.hat"].mods[2]).toEqual({ cond: "2:4" });
  });
});

describe("pattern", () => {
  const pick = (variant, control, value) => {
    const sel = editor(variant).querySelector(`[data-control="${control}"]`);
    sel.value = String(value);
    sel.dispatchEvent(new Event("change"));
  };
  const hits = (variant) => saved().variants[variant].steps.flatMap((v, s) => (v ? [s] : []));

  it("speed, iter and echo are saved with the sound; the echo's pitch only shows for notes", () => {
    openEditor("lead.acid");
    pick("lead.acid", "speed", 2);
    pick("lead.acid", "iter", 4);
    const semis = editor("lead.acid").querySelector('[data-control="echo-semis"]').closest("label");
    expect(semis.hidden).toBe(true);
    pick("lead.acid", "echo", 3);
    expect(semis.hidden).toBe(false);
    pick("lead.acid", "echo-semis", 12);
    expect(saved().variants["lead.acid"]).toMatchObject({ speed: 2, iter: 4, echo: { steps: 3, semis: 12 } });
    openEditor("perc.hat");
    pick("perc.hat", "echo", 2);
    expect(editor("perc.hat").querySelector('[data-control="echo-semis"]').closest("label").hidden).toBe(true);
  });

  it("◀ ▶ move the part a 16th right away", () => {
    openEditor("perc.clap"); // 4, 12, 20, 28
    editor("perc.clap").querySelector('[data-action="rotate-right"]').click();
    expect(hits("perc.clap")).toEqual([5, 13, 21, 29]);
    expect(stepCell("perc.clap", 5).dataset.state).toBe("hit");
    editor("perc.clap").querySelector('[data-action="rotate-left"]').click();
    editor("perc.clap").querySelector('[data-action="rotate-left"]').click();
    expect(hits("perc.clap")).toEqual([3, 11, 19, 27]);
  });

  it("⇆ and the euclid land on the bar line while it plays, and switch the sound on", () => {
    openEditor("perc.rim"); // 3, 6, 11, 14 of each bar
    pick("perc.rim", "euclid-k", 5);
    pick("perc.rim", "euclid-n", 8);
    const apply = editor("perc.rim").querySelector('[data-action="euclid"]');
    click("lead.acid"); // start the loop with something else
    advanceSeconds(BAR / 2);
    apply.click();
    expect(apply.getAttribute("aria-pressed")).toBe("true");
    advanceSeconds(BAR);
    expect(apply.getAttribute("aria-pressed")).toBe("false");
    expect(hits("perc.rim").slice(0, 5)).toEqual([0, 2, 3, 5, 6]);
    expect(pressed()).toContain("perc.rim");
    editor("perc.rim").querySelector('[data-action="reverse"]').click();
    advanceSeconds(BAR);
    // 5 over 8 mirrored around step 0: 0, then 32 - 30, 32 - 29…
    expect(hits("perc.rim").slice(0, 4)).toEqual([0, 2, 3, 5]);
  });

  it("Restaurar golpes also puts speed, iter and echo back", () => {
    openEditor("perc.hat");
    pick("perc.hat", "speed", 0.5);
    editor("perc.hat").querySelector('[data-action="reset-part"]').click(); // playing: on the bar line
    advanceSeconds(BAR);
    expect(saved().variants["perc.hat"]).toBeUndefined();
  });
});

describe("groove and space", () => {
  const slide = (variant, key, value) => {
    const input = editor(variant).querySelector(`input[data-param="${key}"]`);
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };

  it("swing, nudge, duck and pan are saved with the sound; the autopan rate shows once it swings", () => {
    openEditor("bass.offbeat");
    slide("bass.offbeat", "swing", 0.16);
    slide("bass.offbeat", "nudge", -5);
    slide("bass.offbeat", "duck", 0.6);
    slide("bass.offbeat", "pan", 0.25);
    const rate = editor("bass.offbeat").querySelector('[data-control="pan-rate"]').closest("label");
    expect(rate.hidden).toBe(true);
    slide("bass.offbeat", "width", 0.5);
    expect(rate.hidden).toBe(false);
    expect(saved().variants["bass.offbeat"]).toMatchObject({ swing: 0.16, nudge: -5, duck: 0.6 });
    expect(saved().variants["bass.offbeat"].insert).toMatchObject({ pan: 0.25, width: 0.5 });
    expect(editor("bass.offbeat").querySelector('input[data-param="swing"]').closest("label").textContent).toMatch(/58 %/);
  });

  it("a kick has no duck and an FX no groove, only pan", () => {
    openEditor("kick.punchy");
    expect(editor("kick.punchy").querySelector('input[data-param="duck"]')).toBeNull();
    expect(editor("kick.punchy").querySelector('input[data-param="swing"]')).not.toBeNull();
    openEditor("fx.riser");
    expect(editor("fx.riser").querySelector('input[data-param="swing"]')).toBeNull();
    expect(editor("fx.riser").querySelector('input[data-param="pan"]')).not.toBeNull();
  });
});

describe("foldable sections", () => {
  const fold = (variant, key) => editor(variant).querySelector(`[data-fold="${key}"]`);
  const flagged = (variant, key) => !fold(variant, key).querySelector(".fold-on").hidden;
  const toggleFold = (variant, key) => {
    fold(variant, key).querySelector("summary").click();
    vi.advanceTimersByTime(1); // <details> fires its toggle as a task
  };

  it("the sections under the sliders start folded; the header, sliders and grid never fold", () => {
    openEditor("kick.punchy");
    const folds = [...editor("kick.punchy").querySelectorAll("details")];
    expect(folds.map((d) => d.dataset.fold)).toEqual(["insert", "modulation", "space", "pattern"]);
    expect(folds.some((d) => d.open)).toBe(false);
    for (const sel of ['[data-action="name"]', '[data-control="source"]', 'input[data-param="level"]', ".brush", ".grid"]) {
      expect(editor("kick.punchy").querySelector(sel).closest("details"), sel).toBeNull();
    }
    openEditor("fx.riser");
    expect([...editor("fx.riser").querySelectorAll("details")].map((d) => d.dataset.fold)).toEqual(["insert", "modulation", "space"]);
  });

  it("an opened section stays open in every editor and on the next visit, apart from the workspace", () => {
    openEditor("kick.punchy");
    toggleFold("kick.punchy", "pattern");
    expect(JSON.parse(localStorage.getItem("psy-sampler:folds"))).toEqual({
      insert: false,
      modulation: false,
      space: false,
      pattern: true,
    });
    expect(saved()?.folds).toBeUndefined();
    openEditor("lead.acid");
    expect(fold("lead.acid", "pattern").open).toBe(true);
    expect(fold("lead.acid", "insert").open).toBe(false);
    toggleFold("lead.acid", "pattern");
    openEditor("kick.punchy");
    expect(fold("kick.punchy", "pattern").open).toBe(false);

    toggleFold("kick.punchy", "space");
    root = document.createElement("div");
    document.body.replaceChildren(root);
    mount(root, newEngine());
    openEditor("bass.offbeat");
    expect(fold("bass.offbeat", "space").open).toBe(true);
  });

  it("a section flags that it still changes the sound, folded or not", () => {
    openEditor("perc.hat");
    expect(["insert", "modulation", "space", "pattern"].filter((k) => flagged("perc.hat", k))).toEqual([]);
    const filter = editor("perc.hat").querySelector('[data-control="filter"]');
    filter.value = "lowpass";
    filter.dispatchEvent(new Event("change"));
    expect(flagged("perc.hat", "insert")).toBe(true);
    filter.value = "off";
    filter.dispatchEvent(new Event("change"));
    expect(flagged("perc.hat", "insert")).toBe(false);
    const speed = editor("perc.hat").querySelector('[data-control="speed"]');
    speed.value = "2";
    speed.dispatchEvent(new Event("change"));
    expect(flagged("perc.hat", "pattern")).toBe(true);
    expect(fold("perc.hat", "pattern").querySelector(".fold-on").textContent).toBe("activo");
    // A factory sound that ships with a filter has it on.
    openEditor("lead.bits");
    expect(flagged("lead.bits", "insert")).toBe(true);
  });
});

describe("insert extras", () => {
  const pick = (variant, control, value) => {
    const sel = editor(variant).querySelector(`[data-control="${control}"]`);
    sel.value = String(value);
    sel.dispatchEvent(new Event("change"));
  };
  const slide = (variant, key, value) => {
    const input = editor(variant).querySelector(`input[data-param="${key}"]`);
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };
  const shown = (variant, sel) => !editor(variant).querySelector(sel).closest("label").hidden;

  it("a vowel filter swaps the cutoff for a vowel picker; the envelope's decay shows once it moves", () => {
    openEditor("lead.acid");
    pick("lead.acid", "filter", "vowel");
    expect(shown("lead.acid", '[data-control="vowel"]')).toBe(true);
    expect(shown("lead.acid", 'input[data-param="cutoff"]')).toBe(false);
    expect(shown("lead.acid", '[data-control="lfo-shape"]')).toBe(true);
    pick("lead.acid", "vowel", "i");
    pick("lead.acid", "lfo-shape", "random");
    expect(shown("lead.acid", 'input[data-param="envDecay"]')).toBe(false);
    slide("lead.acid", "env", 0.5);
    expect(shown("lead.acid", 'input[data-param="envDecay"]')).toBe(true);
    expect(saved().variants["lead.acid"].insert).toMatchObject({ filter: "vowel", vowel: "i", shape: "random", env: 0.5 });
  });

  it("phaser and tremolo show their rate once they are on", () => {
    openEditor("pad.chord");
    expect(shown("pad.chord", '[data-control="trem-rate"]')).toBe(false);
    slide("pad.chord", "trem", 0.5);
    expect(shown("pad.chord", '[data-control="trem-rate"]')).toBe(true);
    pick("pad.chord", "trem-rate", 1);
    slide("pad.chord", "phaser", 0.4);
    expect(saved().variants["pad.chord"].insert).toMatchObject({ trem: 0.5, tremRate: 1, phaser: 0.4 });
  });
});

describe("editor focus", () => {
  it("dims the page around the open editor and marks its tile", () => {
    const veil = $(".editor-veil");
    expect(veil.hidden).toBe(true);
    openEditor("perc.hat");
    expect(veil.hidden).toBe(false);
    expect(button("perc.hat").closest(".tile").classList.contains("is-editing")).toBe(true);
    openEditor("perc.clap");
    expect(button("perc.hat").closest(".tile").classList.contains("is-editing")).toBe(false);
    expect(button("perc.clap").closest(".tile").classList.contains("is-editing")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(veil.hidden).toBe(true);
    expect(root.querySelector(".is-editing")).toBeNull();
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

  it("the tile's 🔀 slides too: up and down set the amount without the editor, and a drag does not toggle", () => {
    const tile = $('[data-vary="perc.clap"]');
    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(saved().improv).toEqual({ "perc.clap": 0.55 });
    expect(tile.style.getPropertyValue("--amount")).toBe("55%");
    tile.dispatchEvent(new MouseEvent("pointerdown", { clientY: 200, bubbles: true }));
    tile.dispatchEvent(new MouseEvent("pointermove", { clientY: 140, bubbles: true }));
    expect(tile.textContent).toBe("100");
    expect(tile.classList.contains("is-sliding")).toBe(true);
    tile.dispatchEvent(new MouseEvent("pointermove", { clientY: 230, bubbles: true }));
    tile.dispatchEvent(new MouseEvent("pointerup", { clientY: 230, bubbles: true }));
    tile.click();
    expect(saved().improv).toEqual({ "perc.clap": 0.3 });
    expect(tile.textContent).toBe("🔀");
    expect(tile.getAttribute("aria-pressed")).toBe("false");
    expect(button("perc.clap").parentElement.classList.contains("is-dragging")).toBe(false);
    openEditor("perc.clap");
    const inEditor = editor("perc.clap").querySelector('[data-action="vary"]');
    expect(inEditor.textContent).toContain("30 %");
    tile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(inEditor.textContent).toContain("25 %");
    tile.click();
    expect(inEditor.getAttribute("aria-pressed")).toBe("true");
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
    advanceSeconds(BAR);
    expect(hits("kick.long")).toHaveLength(16);
    double.click();
    advanceSeconds(BAR);
    expect(hits("kick.long")).toHaveLength(32);
    expect(saved().variants["kick.long"].steps.every(Boolean)).toBe(true);
  });

  it("×2 waits for the bar line while it plays; a second click cancels it", () => {
    click("perc.clap");
    advanceSeconds(BAR / 2);
    openEditor("perc.clap");
    const double = () => editor("perc.clap").querySelector('[data-action="double"]');
    const before = hits("perc.clap").length;
    double().click();
    expect(double().getAttribute("aria-pressed")).toBe("true");
    expect(hits("perc.clap")).toHaveLength(before);
    double().click();
    expect(double().getAttribute("aria-pressed")).toBe("false");
    advanceSeconds(BAR);
    expect(hits("perc.clap")).toHaveLength(before);
    double().click();
    advanceSeconds(BAR); // any bar line, not only the loop's start
    expect(hits("perc.clap")).toHaveLength(before * 2);
    expect(double().getAttribute("aria-pressed")).toBe("false");
  });

  it("×2 applies at once while stopped", () => {
    openEditor("perc.clap");
    const before = hits("perc.clap").length;
    expect(engine.isRunning()).toBe(false);
    editor("perc.clap").querySelector('[data-action="double"]').click();
    expect(hits("perc.clap")).toHaveLength(before * 2);
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

describe("💥 drop", () => {
  const dropBtn = () => $('[data-action="drop"]');
  const sd = stepDuration(145);
  const at = (step) => 0.06 + step * sd;
  const stepsOf = (pick) =>
    ctx
      .sources()
      .filter(pick)
      .map((s) => Math.round((s.startTime - 0.06) / sd));
  const kick = (s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 170;
  const saw = (s) => s.kind === "oscillator" && s.type === "sawtooth";
  const within = (list, from, to) => list.filter((x) => x >= from && x < to);

  it("needs the loop running", () => {
    expect(dropBtn().disabled).toBe(true);
    immediate();
    click("kick.punchy");
    expect(dropBtn().disabled).toBe(false);
    dropBtn().click();
    expect(dropBtn().getAttribute("aria-pressed")).toBe("true");
    dropBtn().click(); // a second click before the bar line takes it back
    expect(dropBtn().getAttribute("aria-pressed")).toBe("false");
    $("button.stop").click();
    expect(dropBtn().disabled).toBe(true);
  });

  it("by hand: a kick roll and a rising sweep, a bar without kick and bass, then everything on the 1 with an impact", () => {
    const sweep = vi.spyOn(engine, "sweep");
    const sweepOff = vi.spyOn(engine, "sweepOff");
    const fx = vi.spyOn(engine, "triggerFx");
    immediate();
    click("kick.punchy");
    click("bass.offbeat");
    dropBtn().click(); // armed: the next bar line (step 16) starts it
    advanceSeconds(4 * BAR);
    const kicks = stepsOf(kick);
    expect(within(kicks, 0, 16)).toEqual([0, 4, 8, 12]);
    expect(within(kicks, 16, 32)).toEqual([16, 20, 24, 26, 28, 29, 30, 31]); // the roll
    expect(within(kicks, 32, 48)).toEqual([]); // the gap
    expect(within(kicks, 48, 64)).toEqual([48, 52, 56, 60]); // the drop
    const bass = stepsOf(saw);
    expect(within(bass, 16, 32)).toEqual([18, 22, 26, 30]);
    expect(within(bass, 32, 48)).toEqual([]);
    expect(within(bass, 48, 64)).toEqual([50, 54, 58, 62]);
    expect(sweep).toHaveBeenCalledTimes(1);
    const [from, to] = sweep.mock.calls[0];
    expect(from).toBeCloseTo(at(16), 9);
    expect(to).toBeCloseTo(at(48), 9);
    expect(sweepOff.mock.calls[0][0]).toBeCloseTo(at(48), 9);
    expect(fx.mock.calls.map(([id, t]) => [id, Math.round((t - 0.06) / sd)])).toEqual([
      ["fx.riser", 16],
      ["fx.impact", 48],
    ]);
    expect(dropBtn().getAttribute("aria-pressed")).toBe("false");
    expect(saved()?.variants?.["kick.punchy"]).toBeUndefined(); // the roll and the gap are never stored
    expect(saved()?.variants?.["bass.offbeat"]).toBeUndefined();
  });

  it("Parar in the middle drops it and opens the sweep", () => {
    const pump = vi.spyOn(engine, "setPump");
    immediate();
    click("kick.punchy");
    dropBtn().click();
    advanceSeconds(1.5 * BAR); // in the roll
    const comp = ctx.nodes.find((n) => n.kind === "compressor");
    const sweep = ctx.nodes.find((n) => n.kind === "filter" && n.outputs[0] === comp);
    expect(sweep.frequency.events.at(-1)[0]).toBe("exp"); // on its way up
    $("button.stop").click();
    expect(sweep.frequency.events.at(-1)).toEqual(["set", 0, expect.closeTo(ctx.currentTime + 0.03, 9)]);
    expect(pump).toHaveBeenLastCalledWith({});
    expect(dropBtn().getAttribute("aria-pressed")).toBe("false");
    $("button.cue").click(); // ▶ again: a plain loop, no drop left halfway
    const fx = vi.spyOn(engine, "triggerFx");
    advanceSeconds(4 * BAR);
    expect(fx).not.toHaveBeenCalled();
  });

  it("under the autopilot: the next loop is its drop, a Peak after it, which pumps", () => {
    const sweep = vi.spyOn(engine, "sweep");
    const pump = vi.spyOn(engine, "setPump");
    $("button.auto").click();
    expect($(".section-badge").textContent).toBe("Intro");
    dropBtn().click();
    expect(dropBtn().getAttribute("aria-pressed")).toBe("true");
    expect([...root.querySelectorAll(".section-queue [data-queued]")].map((n) => n.dataset.queued)).toEqual(["peak"]);
    advanceSeconds(2 * BAR); // the next loop: the drop
    expect(sweep).toHaveBeenCalledTimes(1);
    expect($(".section-badge").textContent).toBe("Intro");
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Pico");
    expect(pump).toHaveBeenLastCalledWith({ pad: 0.6, lead: 0.35 }, expect.any(Number));
    expect(dropBtn().getAttribute("aria-pressed")).toBe("false");
  });
});

describe("autopilot: fills, filters and improvise", () => {
  const OFF = 0;
  const run = (loops, each) => {
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    $("button.auto").click();
    for (let i = 0; i < loops; i++) {
      advanceSeconds(2 * BAR);
      each?.($(".section-badge").textContent);
    }
  };

  it("phrase ends get fills: a kick break or a percussion roll, never stored", () => {
    const setData = vi.spyOn(engine, "setData");
    run(48);
    const kicks = setData.mock.calls.filter(([id]) => id.startsWith("kick."));
    const percs = setData.mock.calls.filter(([id]) => id.startsWith("perc."));
    const broke = kicks.some(([, d]) => d.steps.slice(24, 32).every((v) => v === OFF) && d.steps.slice(16, 24).some((v) => v !== OFF));
    const rolled = percs.some(([, d]) => d.steps && d.steps.slice(24, 32).join() === "1,0,1,0,1,1,2,2");
    expect(broke || rolled).toBe(true);
    for (const data of Object.values(saved().variants)) {
      if (data.steps) expect(data.steps.slice(24, 32).join()).not.toBe("1,0,1,0,1,1,2,2");
    }
  });

  it("rides the leads' and pads' filters, never the kick's or the bass's", () => {
    const lps = [];
    run(40, (section) => {
      const ws = saved();
      for (const id of pressed()) {
        const ins = ws.variants[id]?.insert;
        if (/^(kick|bass)\./.test(id)) expect(ins ? [ins.hp, ins.lp] : [20, 20000]).toEqual([20, 20000]);
        if (id.startsWith("lead.") && section === "Subida") lps.push(ins.lp);
      }
    });
    expect(lps.length).toBeGreaterThan(0);
    expect(Math.min(...lps)).toBeLessThan(20000); // a muffled lead opening up across the build
  });

  it("decides which sounds improvise: none in the intro, never a kick, the breakdown's leads as written", () => {
    const varying = () => [...root.querySelectorAll('[data-vary][aria-pressed="true"]')].map((b) => b.dataset.vary);
    let any = false;
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    $("button.auto").click();
    expect(varying()).toEqual([]);
    for (let i = 0; i < 60; i++) {
      advanceSeconds(2 * BAR);
      const section = $(".section-badge").textContent;
      const on = varying();
      if (on.length) any = true;
      expect(on.filter((id) => id.startsWith("kick."))).toEqual([]);
      if (section === "Intro") expect(on).toEqual([]);
      if (section === "Break") expect(on.filter((id) => id.startsWith("lead."))).toEqual([]);
    }
    expect(any).toBe(true);
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
    click("kick.long");
    advanceSeconds(BAR);
    snapTile().click();
    snapTile().click();
    expect(snapTile().classList.contains("is-queued")).toBe(false);
    advanceSeconds(BAR);
    expect(pressed()).toEqual(["pad.air"]);
    for (const detail of [1, 2]) snapTile().dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
    expect(pressed()).toEqual(["kick.long"]);
  });

  it("Parar stops with the snapshot editor open", () => {
    click("kick.long");
    snapBtn().click();
    expect(snapEditor()).not.toBeNull();
    $("button.stop").click();
    expect(engine.isRunning()).toBe(false);
    expect(pressed()).toEqual([]);
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

  describe("snapshot autopilot", () => {
    const tourBtn = () => $("button.tour");
    const badge = () => ($(".section-badge").hidden ? "" : $(".section-badge").textContent);
    // Intro (a kick), Groove (kick + bass) and Break (a pad, taken with no background kick).
    function three() {
      immediate();
      click("kick.long");
      snapBtn().click();
      click("bass.gallop");
      snapBtn().click();
      click("pad.air");
      click("kick.long");
      click("bass.gallop");
      $("#bgkick").click();
      snapBtn().click();
      $("#bgkick").click();
      expect(saved().snapshots.map((x) => x.name)).toEqual(["Intro", "Groove", "Break"]);
    }
    // [audio time, badge] each time the badge changes, over `bars` bars.
    function watch(bars) {
      const seen = [];
      let last = badge();
      for (let i = 0; i < Math.ceil((bars * BAR) / 0.025); i++) {
        advance(1);
        if (badge() !== last) seen.push([ctx.currentTime, (last = badge())]);
      }
      return seen;
    }

    it("needs two snapshots", () => {
      expect(tourBtn().disabled).toBe(true);
      immediate();
      click("kick.long");
      snapBtn().click();
      expect(tourBtn().disabled).toBe(true);
      click("bass.gallop");
      snapBtn().click();
      expect(tourBtn().disabled).toBe(false);
    });

    it("plays them in the panel's order, each for the Cambios bars, and starts over", () => {
      three();
      const changes = $("#changes");
      changes.value = "0"; // every 2 bars
      changes.dispatchEvent(new Event("input"));
      expect(button("kick.punchy").classList.contains("is-background")).toBe(true); // under the pad
      tourBtn().click();
      expect(tourBtn().getAttribute("aria-pressed")).toBe("true");
      expect(badge()).toBe("Break"); // it carries on from the one playing
      expect([...root.querySelectorAll(".section-queue [data-queued]")].map((li) => li.textContent)).toEqual(["Intro"]);
      advanceSeconds(BAR);
      expect(root.querySelectorAll(".is-background")).toHaveLength(0); // a pilot: no background kick

      const seen = watch(8);
      expect(seen.slice(0, 3).map(([, name]) => name)).toEqual(["Intro", "Groove", "Break"]);
      for (let i = 1; i < seen.length; i++) expect(seen[i][0] - seen[i - 1][0]).toBeCloseTo(2 * BAR, 1);
      expect(pressed()).toEqual(["pad.air"]);
      expect(saved().snapshots).toHaveLength(3); // untouched
    });

    it("pulses the one coming next in the last loop, ⏭ moves on early and a click carries on from there", () => {
      three();
      tourBtn().click();
      const tile = (id) => $(`[data-snap="${id}"]`);
      advanceSeconds(BAR);
      expect(tile("snap-1").classList.contains("is-next")).toBe(false); // every 8 bars: still early
      expect($('[data-action="next-section"]').disabled).toBe(false);
      $('[data-action="next-section"]').click();
      expect($('[data-action="next-section"]').disabled).toBe(true);
      expect(tile("snap-1").classList.contains("is-next")).toBe(true);
      expect(watch(3).map(([, name]) => name)).toEqual(["Intro"]);
      expect(pressed()).toEqual(["kick.long"]);

      tile("snap-3").click(); // by hand, on the next bar line
      advanceSeconds(BAR);
      expect(badge()).toBe("Break");
      expect([...root.querySelectorAll(".section-queue [data-queued]")].map((li) => li.textContent)).toEqual(["Intro"]);
    });

    it("🤖, Parar and its own button turn it off", () => {
      three();
      tourBtn().click();
      $("button.auto").click();
      expect(tourBtn().getAttribute("aria-pressed")).toBe("false");
      expect($("button.auto").getAttribute("aria-pressed")).toBe("true");
      tourBtn().click();
      expect($("button.auto").getAttribute("aria-pressed")).toBe("false");
      $("button.stop").click();
      expect(tourBtn().getAttribute("aria-pressed")).toBe("false");
      expect(badge()).toBe("");

      $("button.cue").click(); // ▶ brings the mix back, without the tour
      tourBtn().click();
      tourBtn().click();
      expect(tourBtn().getAttribute("aria-pressed")).toBe("false");
      expect(root.querySelectorAll(".is-next")).toHaveLength(0);
    });

    it("from silence it starts with the first one; armed, with what is queued", () => {
      three();
      click("pad.air");
      expect(engine.isRunning()).toBe(false);
      tourBtn().click();
      expect(engine.isRunning()).toBe(true);
      expect(badge()).toBe("Intro");
      expect(pressed()).toEqual(["kick.long"]);

      $("button.stop").click();
      $('[data-snap="snap-2"]').click(); // armed: queued for ▶
      tourBtn().click();
      expect(engine.isRunning()).toBe(true);
      expect(badge()).toBe("Groove");
      expect(pressed()).toEqual(["kick.long", "bass.gallop"]);
    });

    it("keeps going after removing the one playing, and stops with none left", () => {
      const remove = (id) => {
        if (!snapEditor(id)) $(`[data-edit-snap="${id}"]`).click();
        act(id, "remove").click();
      };
      three();
      tourBtn().click();
      remove("snap-3");
      expect(badge()).toBe("");
      expect([...root.querySelectorAll(".section-queue [data-queued]")].map((li) => li.textContent)).toEqual(["Intro"]);
      $('[data-action="next-section"]').click();
      advanceSeconds(3 * BAR);
      expect(badge()).toBe("Intro");
      remove("snap-1");
      remove("snap-2");
      expect(tourBtn().getAttribute("aria-pressed")).toBe("false");
      expect(tourBtn().disabled).toBe(true);
    });
  });

  it("survive a reload, travel in presets and lose a deleted copy", async () => {
    immediate();
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

  it("Exportar downloads them alone; Importar adds a file's to the ones there", async () => {
    expect($('[data-action="export-snaps"]').disabled).toBe(true);
    immediate();
    openEditor("lead.arp");
    editor("lead.arp").querySelector('[data-action="duplicate"]').click();
    click("lead.arp~1");
    snapBtn().click();
    $('[data-action="export-snaps"]').click();
    const blob = downloads.at(-1);
    expect(blob.fileName).toBe("psy-layers-snapshots.json");
    const text = await blob.text();
    expect(JSON.parse(text)).toMatchObject({ kind: "snapshots", snapshots: [{ id: "snap-1" }] });

    // Into a fresh workspace: the copy the snapshot plays comes along.
    $("#factory-reset").click();
    $('[data-action="reset"]').click();
    expect(button("lead.arp~1")).toBeNull();
    const input = $('[data-input="snaps"]');
    Object.defineProperty(input, "files", { value: [new File([text], "s.json")], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect($('[data-snap="snap-1"]')).not.toBeNull();
    expect(button("lead.arp~1")).not.toBeNull();
    expect($(".status").textContent).toBe("1 snapshot importado.");
    expect(saved().snapshots).toHaveLength(1);

    const again = $('[data-input="snaps"]');
    Object.defineProperty(again, "files", { value: [new File([text], "s.json")] });
    again.dispatchEvent(new Event("change"));
    await flushPromises();
    expect($(".status").textContent).toBe("Ya tenías esos snapshots.");
    expect(saved().snapshots).toHaveLength(1);
  });

  it("Importar refuses a file without snapshots", async () => {
    const input = $('[data-input="snaps"]');
    Object.defineProperty(input, "files", { value: [new File(['{"app":"psy-sampler"}'], "x.json")] });
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect($(".status").textContent).toMatch(/no tiene snapshots/);
  });

  it("Compartir copies a link to that snapshot alone; opening it adds it after yours", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.stubGlobal("Blob", NodeBlob); // jsdom's has no stream(), and the link is deflated
    vi.useRealTimers(); // nor do (de)compression streams settle on fake ones
    const until = (node, text) => vi.waitFor(() => expect(node.querySelector(".status").textContent).toBe(text));
    const snaps = (node) => [...node.querySelectorAll("[data-snap] .variant-label")].map((l) => l.textContent);
    // Opening a link is a page load: a fresh mount over what this browser saved.
    const engines = [];
    const visit = (path) => {
      engines.forEach((e) => e.stop());
      history.replaceState(null, "", path);
      const node = document.createElement("div");
      document.body.replaceChildren(node);
      engines.push(newEngine());
      mount(node, engines.at(-1));
      return node;
    };
    immediate();
    openEditor("lead.arp");
    editor("lead.arp").querySelector('[data-action="duplicate"]').click();
    click("lead.arp~1");
    snapBtn().click();
    typeName("Mi pico"); // unsaved: the link takes what the panel shows
    act("snap-1", "share-snap").click();
    await until(root, "Link a «Mi pico» copiado: quien lo abra lo suma a sus snapshots.");
    const link = writeText.mock.calls[0][0].slice(location.origin.length);
    expect(link).toMatch(/^\/#snap=[\w-]+$/);

    // Where it already is (same moment, sounds and data), it adds nothing.
    let page = visit(link);
    await until(page, "Ya tenías ese snapshot.");
    expect(location.hash).toBe("");
    expect(snaps(page)).toHaveLength(1);

    // In another browser, after the snapshots there, with the copy it plays.
    localStorage.clear();
    page = visit("/");
    page.querySelector("#quantize").click();
    page.querySelector('[data-variant="pad.air"]').click();
    page.querySelector('[data-action="snapshot"]').click();
    page = visit(link);
    await until(page, "Snapshot «Mi pico» agregado: tocalo para escucharlo.");
    expect(snaps(page)).toEqual(["Pico", "Mi pico"]);
    expect(page.querySelector('[data-variant="lead.arp~1"]')).not.toBeNull();
    expect(saved().snapshots[1]).toMatchObject({ id: "snap-2", name: "Mi pico", active: { "lead.arp~1": "lead.arp~1" } });

    page = visit("/#snap=nope");
    await until(page, "El link está roto: no se pudo leer el snapshot.");
    expect(snaps(page)).toHaveLength(2);
    engines.forEach((e) => e.stop());
  });

  it("Compartir is off for a draft with no sounds", () => {
    click("kick.long");
    snapBtn().click();
    snapEditor().querySelector('[data-part="kick.long"]').click();
    expect(act("snap-1", "share-snap").disabled).toBe(true);
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

  it("Tap sets the BPM from the beat you tap, and cuts a ramp short", () => {
    immediate();
    click("kick.long");
    advance(10);
    rampTo(170, 8);
    const tap = $('[data-action="tap"]');
    for (let i = 0; i < 4; i++) {
      tap.click();
      vi.advanceTimersByTime(i < 3 ? 400 : 0);
    }
    expect($("#bpm").value).toBe("150");
    expect(saved().bpm).toBe(150);
    expect($('[data-action="ramp"]').getAttribute("aria-pressed")).toBe("false");
    expect($(".bpm-value").textContent).toBe("150");
  });

  describe("Tap sync", () => {
    const tapBtn = () => $('[data-action="tap"]');
    const press = () => tapBtn().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    // The audio clock and performance.now() move together here, 1 s = 1000 ms.
    const offset = () => performance.now() - ctx.currentTime * 1000;
    const advanceTo = (ms) => {
      for (let left = ms - performance.now(); left > 1e-6; left = ms - performance.now()) {
        const dt = Math.min(25, left);
        ctx.currentTime += dt / 1000;
        vi.advanceTimersByTime(dt);
      }
    };
    const kicksFrom = (n) =>
      ctx
        .sources()
        .slice(n)
        .filter((s) => s.kind === "oscillator" && s.frequency.events[0]?.[1] === 120)
        .map((s) => s.startTime);

    it("sits left of the BPM slider", () => {
      const tempo = $(".topbar-tempo");
      expect(tempo.firstElementChild).toBe(tapBtn());
      expect(tempo.children[1].querySelector("#bpm")).not.toBeNull();
    });

    it("the first tap takes the loop back to its 1, right there", () => {
      immediate();
      click("kick.long");
      advanceSeconds(1.1); // well into the bar: the next kick on the old grid is some way off
      const n = ctx.sources().length;
      const now = ctx.currentTime;
      press();
      expect(kicksFrom(n)[0]).toBeCloseTo(now + 0.015, 6);
      expect($("#bpm").value).toBe("145"); // one tap: no tempo yet
      advance(1);
      expect([engine.visibleStep(), engine.visibleLoop()]).toEqual([0, 0]);
    });

    it("locks the loop onto a beat it is tapped along to: tempo and phase", () => {
      immediate();
      click("kick.long"); // a kick on every beat, at 145
      advanceSeconds(0.73);
      // The other tab: 150 BPM, its beat 137 ms after an arbitrary moment.
      const beat = 400;
      const ref = performance.now() + 137;
      const jitter = [6, -4, 3, -7, 5, -2, 4, -5];
      jitter.forEach((j, k) => {
        advanceTo(ref + k * beat + j);
        press();
      });
      expect($("#bpm").value).toBe("150");
      const n = ctx.sources().length;
      advanceSeconds(4 * BAR);
      const kicks = kicksFrom(n);
      expect(kicks.length).toBeGreaterThan(10);
      const zero = (ref - offset()) / 1000; // the other tab's beat, on this tab's audio clock
      for (const t of kicks) {
        const k = Math.round((t - zero) / 0.4);
        expect(Math.abs(t - (zero + k * 0.4))).toBeLessThan(0.003);
      }
      // ...and its bars: the first tap was the 1, so every 4th beat from it starts one.
      const bar = Math.ceil((performance.now() - ref) / beat / 4) * 4 + 4; // a tapped beat 4k ahead
      advanceTo(ref + bar * beat + 5);
      expect(engine.visibleStep() % 16).toBe(0);
      advanceTo(ref + (bar + 1) * beat + 5);
      expect(engine.visibleStep() % 16).toBe(4);
    });

    it("Space and Enter tap on the press, once, not again on the click they cause", () => {
      immediate();
      click("kick.long");
      advance(10);
      const start = performance.now() + 100;
      [" ", "Enter", " "].forEach((key, k) => {
        advanceTo(start + k * 400);
        tapBtn().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        advanceTo(start + k * 400 + 150);
        tapBtn().click(); // the key's own click (Space sends it on the release), past the bounce window
      });
      expect($("#bpm").value).toBe("150");
    });

    it("a bounce right after a tap is not a beat", () => {
      immediate();
      click("kick.long");
      advance(10);
      for (const t of [0, 400, 430, 800, 1200]) {
        advanceTo(10_000 + t);
        press();
      }
      expect($("#bpm").value).toBe("150");
    });
  });

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

  it("⊘ bans a sound: a playing one leaves on the next bar and the pilot never plays it again", () => {
    const ban = (id) => $(`[data-ban="${id}"]`);
    expect(ban("fx.impact")).not.toBeNull(); // one-shots too: the pilot fires them
    expect(ban("classic.popcorn")).toBeNull(); // the pilot never plays a manual layer
    autoBtn().click();
    const id = pressed().find((v) => v.startsWith("kick."));
    ban(id).click();
    expect(saved().banned).toEqual([id]);
    expect(ban(id).getAttribute("aria-pressed")).toBe("true");
    expect(ban(id).closest(".tile").classList.contains("is-banned")).toBe(true);
    expect(pressed()).toContain(id); // until the bar line
    for (let i = 0; i < 40; i++) {
      advanceSeconds(BAR);
      expect(pressed()).not.toContain(id);
    }
    $("button.stop").click();
    click(id);
    expect(queued()).toContain(id); // by hand it still plays
    ban(id).click();
    expect(saved().banned).toEqual([]);
  });

  it("Parar turns it off", () => {
    autoBtn().click();
    $("button.stop").click();
    expect(autoBtn().getAttribute("aria-pressed")).toBe("false");
    expect($(".section-badge").hidden).toBe(true);
  });

  const layers = () => pressed().map((v) => v.split(".")[0]);

  it("never leaves kick, bass and percussion alone for more than a bar", () => {
    $("#seed").value = "goa"; // a seed whose bar 60 has a kick
    $("#seed").dispatchEvent(new Event("change"));
    autoBtn().click();
    for (let i = 0; i < 60; i++) {
      advanceSeconds(BAR);
      expect(layers().some((l) => l === "lead" || l === "pad")).toBe(true);
    }
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

  it("rides the volume of every sound it plays, yours too, over the loop, and leaves the rest of your edit", () => {
    click("bass.rolling");
    advanceSeconds(BAR);
    openEditor("bass.rolling");
    const bright = editor("bass.rolling").querySelector('[data-param="bright"]');
    bright.value = "2";
    bright.dispatchEvent(new Event("input"));
    button("bass.rolling").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(saved().variants["bass.rolling"].level).toBeLessThan(1);
    const glide = () => parseFloat(button("bass.rolling").style.getPropertyValue("--glide"));
    expect(glide()).toBe(0); // by hand: at once
    autoBtn().click(); // a groove: one bass at full level, reached over the loop
    expect(glide()).toBeCloseTo(2 * BAR, 6);
    expect(saved().variants["bass.rolling"]).toMatchObject({ level: 1, params: { bright: 2 } });
    expect(saved().auto).not.toContain("bass.rolling");
    expect(button("bass.rolling").parentElement.classList.contains("is-edited")).toBe(true);
  });

  it("a style picks its sounds and takes the BPM into its range", () => {
    const style = $('[data-control="style"]');
    style.value = "techno";
    style.dispatchEvent(new Event("change"));
    expect($("#bpm").value).toBe("135"); // 145 down to the top of techno's range
    expect(saved().style).toBe("techno");
    autoBtn().click();
    const techno = {
      kick: ["kick.techno", "kick.rumble"],
      bass: ["bass.techno", "bass.offbeat"],
      perc: ["perc.hat", "perc.hat16", "perc.clap", "perc.rim", "perc.ride"],
      lead: ["lead.techno", "lead.stabs", "lead.acid"],
      pad: ["pad.drone", "pad.fifths", "pad.air"],
      glitch: ["glitch.metal", "glitch.crush", "glitch.stutter"],
    };
    for (let i = 0; i < 20; i++) {
      for (const v of pressed()) expect(techno[v.split(".")[0]]).toContain(v);
      advanceSeconds(2 * BAR);
    }
  });

  it("a style picked while it plays comes in on the drop after a break; the BPM rides the break", () => {
    autoBtn().click();
    advanceSeconds(2 * BAR);
    const style = $('[data-control="style"]');
    style.value = "hitech";
    style.dispatchEvent(new Event("change"));
    expect(saved().style).toBe("psytrance");
    expect($("#bpm").value).toBe("145");
    const queue = () => [...root.querySelectorAll(".section-queue [data-queued]")].map((li) => li.dataset.queued);
    expect(queue()).toEqual(["breakdown", "build", "peak"]);
    expect($('.section-queue [data-queued="peak"] .restyle').textContent).toBe("→ Hi-tech");
    const hitech = (id) => STYLES.hitech.pool[id.split(".")[0]].includes(id);
    const badge = () => $(".section-badge").textContent;
    const seen = [];
    for (let i = 0; i < 4000 && badge() !== "Pico"; i++) {
      if (badge() !== seen.at(-1)) {
        seen.push(badge());
        if (badge() === "Break") expect(Number($("#bpm").value)).toBeLessThan(150); // it ramps from here
      }
      expect(saved().style).toBe("psytrance");
      advanceSeconds(0.1);
    }
    expect(seen.slice(-2)).toEqual(["Break", "Subida"]);
    expect($("#bpm").value).toBe("170"); // there by the drop: the bottom of hi-tech's range
    expect(saved().style).toBe("hitech");
    expect(style.value).toBe("hitech");
    expect(pressed().filter((id) => !id.startsWith("fx.")).every(hitech)).toBe(true);
  });

  it("the playing style picked again calls the handoff off, and its ramp with it", () => {
    $('[data-section="breakdown"]').click();
    advanceSeconds(BAR);
    const style = $('[data-control="style"]');
    const pick = (value) => {
      style.value = value;
      style.dispatchEvent(new Event("change"));
    };
    pick("hitech");
    pick("psytrance"); // at once: the BPM is already where it goes back to
    advanceSeconds(4 * BAR);
    expect($("#bpm").value).toBe("145");
    pick("hitech");
    expect($("#ramp-to").value).toBe("170"); // inside the breakdown: it rides this one
    advanceSeconds(6 * BAR);
    pick("psytrance");
    const bpm = Number($("#bpm").value);
    expect(bpm).toBeGreaterThan(145);
    advanceSeconds(16 * BAR);
    expect(Number($("#bpm").value)).toBe(Math.min(bpm, 148)); // back inside psytrance's range, no further
    expect(saved().style).toBe("psytrance");
    expect($(".section-queue .restyle")).toBeNull();
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

describe("✨ AI", () => {
  const RealURL = globalThis.URL;
  // The models ai.js would hand over; `answers` are what the model plans, in
  // turn (a function gets the ask's opts, schema and prompt). Asks for the
  // opening (their schema has fx) go to `openings` and get `opening`; asks for
  // the form of the track (their schema has sections) go to `formAsks` and get
  // `forms`, in turn (none by default).
  function fakeAi({ chrome = "available", answers = [], opening = null, forms = [], fail = false, models = ["gemma-3-4b", "qwen"] } = {}) {
    const asks = [];
    const openings = [];
    const formAsks = [];
    const engine = (name) => ({
      supported: () => true,
      known: vi.fn(() => (name === "lmstudio" || name === "openai" ? models : undefined)),
      availability: vi.fn(async () => chrome),
      start: vi.fn(async () => name),
      plan: vi.fn((prompt, schema, opts) => {
        if (schema.properties.sections) {
          formAsks.push({ name, prompt, schema, opts });
          if (fail) return Promise.reject(new Error("no"));
          const answer = forms[Math.min(formAsks.length - 1, forms.length - 1)] ?? { why: "", sections: [] };
          return typeof answer === "function" ? answer(opts, schema, prompt) : Promise.resolve(answer);
        }
        if (fail) return Promise.reject(new Error("no"));
        if (schema.properties.fx) {
          openings.push({ name, prompt, schema, opts });
          return typeof opening === "function" ? opening(opts, schema, prompt) : Promise.resolve(opening);
        }
        asks.push({ name, prompt, schema, opts });
        const answer = answers[Math.min(asks.length - 1, answers.length - 1)];
        return typeof answer === "function" ? answer(opts, schema, prompt) : Promise.resolve(answer);
      }),
    });
    const ai = { asks, openings, formAsks };
    for (const name of ["chrome", "lmstudio", "openai", "anthropic", "gemini"]) ai[name] = engine(name);
    return ai;
  }
  const aiBtn = (node = root) => node.querySelector("button.ai");
  const engines = (node = root) => [...node.querySelectorAll("#ai-engine option")].map((o) => o.value);
  const queue = (node = root) => [...node.querySelectorAll(".section-queue [data-queued]")].map((li) => li.dataset.queued);
  const remountWith = async (ai) => {
    root = document.createElement("div");
    document.body.replaceChildren(root);
    mount(root, engine, { ai });
    await flushPromises();
    return ai;
  };
  const BREAK = { why: "a dark break", section: "breakdown", bars: 16, layers: { lead: ["lead.acid"], pad: ["pad.chord"] } };
  const BUILD = { why: "rising", section: "build", bars: 8, layers: {} };
  const PEAK = { section: "peak", bars: 16, layers: {} };
  const GROOVE = { section: "groove", bars: 16, layers: {} };
  // The queued section when there is one, else `free`.
  const queuedOr = (free) => (opts, schema) => {
    const [only, more] = schema.properties.section.enum;
    return Promise.resolve(more ? free : { section: only, bars: 16, layers: {} });
  };
  const vibe = (value) => {
    $("#ai-vibe").value = value;
    $("#ai-vibe").dispatchEvent(new Event("change"));
  };
  const apply = (value) => {
    if (value !== undefined) vibe(value);
    $(".ai-apply").click();
  };
  const cue = () => $('[data-action="cue"]');
  // A mix playing: ✨ has no silence to arm the autopilot in.
  const playing = () => {
    immediate();
    click("kick.long");
  };

  it("has no button without models", () => {
    expect(aiBtn().hidden).toBe(true);
  });

  it("offers Chrome's model where it runs and LM Studio always; the settings show while it is on", async () => {
    await remountWith(fakeAi());
    playing();
    expect(aiBtn().hidden).toBe(false);
    expect($(".ai-panel").hidden).toBe(true);
    aiBtn().click();
    expect(aiBtn().getAttribute("aria-pressed")).toBe("true");
    expect($(".ai-panel").hidden).toBe(false);
    expect($(".ai-panel").open).toBe(true);
    expect(engines()).toEqual(["chrome", "lmstudio", "openai", "anthropic", "gemini"]);
    expect($("#ai-engine").value).toBe("chrome");
    expect($("#ai-endpoint").closest("label").hidden).toBe(true);
    await flushPromises();
    expect($(".status").textContent).toMatch(/Chrome \(Gemini Nano\) listo/);
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai"))).toMatchObject({ on: true });

    await remountWith(fakeAi({ chrome: "unavailable" }));
    expect(aiBtn().getAttribute("aria-pressed")).toBe("true"); // remembered
    expect(engines()).toEqual(["lmstudio", "openai", "anthropic", "gemini"]);
    expect($("#ai-endpoint").closest("label").hidden).toBe(false);
    expect($("#ai-endpoint").value).toBe("http://localhost:1234/v1");
  });

  it("its settings fold away, say what they hold in the summary, and stay folded", async () => {
    await remountWith(fakeAi({ chrome: "unavailable" }));
    aiBtn().click();
    await flushPromises();
    const panel = $("details.ai-panel");
    expect(panel.open).toBe(true);
    $("#ai-model").value = "qwen";
    $("#ai-model").dispatchEvent(new Event("change"));
    $("#ai-vibe").value = "dark";
    $("#ai-vibe").dispatchEvent(new Event("change"));
    expect($(".ai-summary").textContent).toBe("LM Studio (qwen) · «dark»");
    expect($(".status").textContent).toBe("Onda «dark» guardada: la IA la usa en la próxima fase que planee.");
    panel.open = false;
    panel.dispatchEvent(new Event("toggle"));
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai")).open).toBe(false);
    await remountWith(fakeAi({ chrome: "unavailable" }));
    expect($("details.ai-panel").open).toBe(false);
    expect($("details.ai-panel").hidden).toBe(false); // still on: folded, not gone
    aiBtn().click(); // off: the panel goes
    expect($("details.ai-panel").hidden).toBe(true);
  });

  it("LM Studio: a new endpoint is cleaned, remembered and tried; a bad one is refused", async () => {
    vi.stubGlobal("URL", RealURL); // the downloads' stand-in is no constructor
    const ai = await remountWith(fakeAi({ chrome: "unavailable" }));
    aiBtn().click();
    const endpoint = $("#ai-endpoint");
    endpoint.value = "http://pc.lan:1234";
    endpoint.dispatchEvent(new Event("change"));
    expect(endpoint.value).toBe("http://pc.lan:1234/v1");
    expect(ai.lmstudio.start).toHaveBeenLastCalledWith({ endpoint: "http://pc.lan:1234/v1", model: "" });
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai")).endpoint).toBe("http://pc.lan:1234/v1");
    endpoint.value = "nope";
    endpoint.dispatchEvent(new Event("change"));
    expect($(".status").textContent).toMatch(/URL http\(s\) válida/);
    expect(endpoint.value).toBe("http://pc.lan:1234/v1");
    await flushPromises();
    ai.lmstudio.start.mockRejectedValueOnce(new Error("refused"));
    $("#ai-model").value = "qwen";
    $("#ai-model").dispatchEvent(new Event("change"));
    await flushPromises();
    expect(ai.lmstudio.start).toHaveBeenLastCalledWith({ endpoint: "http://pc.lan:1234/v1", model: "qwen" });
    expect($(".status").textContent).toMatch(/LM Studio no responde en http:\/\/pc.lan:1234\/v1/);
  });

  it("LM Studio: the model is picked from what the server lists, read again with ↻", async () => {
    const models = ["gemma-3-4b", "qwen"];
    const ai = await remountWith(fakeAi({ chrome: "unavailable", models }));
    playing();
    const options = () => [...root.querySelectorAll("#ai-model option")].map((o) => [o.value, o.textContent]);
    aiBtn().click();
    await flushPromises();
    expect($("#ai-model").tagName).toBe("SELECT");
    expect(options()).toEqual([["", "Automático (el primero)"], ["gemma-3-4b", "gemma-3-4b"], ["qwen", "qwen"]]);
    $("#ai-model").value = "qwen";
    $("#ai-model").dispatchEvent(new Event("change"));
    expect(ai.lmstudio.start).toHaveBeenLastCalledWith({ endpoint: "http://localhost:1234/v1", model: "qwen" });
    await flushPromises();
    expect($(".status").textContent).toMatch(/LM Studio listo/);
    models.splice(1, 1, "mistral-nemo"); // qwen deleted, another downloaded
    $(".ai-models").click();
    expect(ai.lmstudio.start).toHaveBeenCalledTimes(3);
    await flushPromises();
    expect(options()).toEqual([
      ["", "Automático (el primero)"],
      ["gemma-3-4b", "gemma-3-4b"],
      ["mistral-nemo", "mistral-nemo"],
      ["qwen", "qwen (no está en LM Studio)"],
    ]);
    expect($("#ai-model").value).toBe("qwen");
    expect($(".status").textContent).toBe("LM Studio no tiene «qwen»: bajalo o elegí otro modelo.");
  });

  it("links an account with its API key, picks its model, and unlinks it", async () => {
    const ai = await remountWith(fakeAi());
    playing();
    aiBtn().click();
    await flushPromises();
    expect($("#ai-key").closest("label").hidden).toBe(true);
    $("#ai-engine").value = "openai";
    $("#ai-engine").dispatchEvent(new Event("change"));
    expect($("#ai-key").closest("label").hidden).toBe(false);
    expect($("#ai-key").type).toBe("password");
    expect($("#ai-endpoint").closest("label").hidden).toBe(true);
    expect($(".ai-getkey").href).toBe("https://platform.openai.com/api-keys");
    expect($(".ai-unlink").hidden).toBe(true);
    expect(ai.openai.start).not.toHaveBeenCalled(); // nothing to ask without a key
    expect($(".status").textContent).toBe("Pegá tu clave API de OpenAI para vincular tu cuenta.");
    expect($(".ai-summary").textContent).toBe("OpenAI (sin vincular)");

    $("#ai-key").value = "not a key";
    $("#ai-key").dispatchEvent(new Event("change"));
    expect($(".status").textContent).toBe("Eso no parece una clave API.");
    expect($("#ai-key").value).toBe("");

    $("#ai-key").value = "  sk-proj-abc12345 ";
    $("#ai-key").dispatchEvent(new Event("change"));
    expect(ai.openai.start).toHaveBeenLastCalledWith({ key: "sk-proj-abc12345", model: "" });
    await flushPromises();
    expect($(".status").textContent).toMatch(/OpenAI listo/);
    expect($(".ai-unlink").hidden).toBe(false);
    expect([...root.querySelectorAll("#ai-model option")].map((o) => o.textContent)).toEqual(["Automático (uno rápido)", "gemma-3-4b", "qwen"]);
    $("#ai-model").value = "qwen";
    $("#ai-model").dispatchEvent(new Event("change"));
    expect(ai.openai.start).toHaveBeenLastCalledWith({ key: "sk-proj-abc12345", model: "qwen" });
    const stored = JSON.parse(localStorage.getItem("psy-sampler:ai"));
    expect(stored).toMatchObject({ engine: "openai", keys: { openai: "sk-proj-abc12345" }, models: { openai: "qwen" }, model: "" });
    expect($(".ai-summary").textContent).toBe("OpenAI (qwen)");

    ai.anthropic.start.mockRejectedValueOnce(Object.assign(new Error("HTTP 401"), { status: 401 }));
    $("#ai-engine").value = "anthropic";
    $("#ai-engine").dispatchEvent(new Event("change"));
    $("#ai-key").value = "sk-ant-wrong123";
    $("#ai-key").dispatchEvent(new Event("change"));
    await flushPromises();
    expect($(".status").textContent).toBe("Anthropic (Claude) rechazó la clave: revisala o creá otra.");

    $("#ai-engine").value = "openai";
    $("#ai-engine").dispatchEvent(new Event("change"));
    $(".ai-unlink").click();
    expect($(".status").textContent).toBe("OpenAI desvinculado: su clave se borró de este navegador.");
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai")).keys).toEqual({ openai: "", anthropic: "sk-ant-wrong123", gemini: "" });
    expect($("#ai-key").value).toBe("");
    expect($(".ai-unlink").hidden).toBe(true);
  });

  it("a linked account plans the sections with its key", async () => {
    localStorage.setItem("psy-sampler:ai", JSON.stringify({ on: true, engine: "gemini", keys: { gemini: "AIzaTestKey123" } }));
    const ai = await remountWith(fakeAi({ answers: [BREAK] }));
    $("button.auto").click();
    await flushPromises();
    expect(ai.asks[0]).toMatchObject({ name: "gemini", opts: { key: "AIzaTestKey123", model: "" } });
    expect(ai.asks[0].opts).not.toHaveProperty("endpoint");
  });

  it("plans three sections ahead, one ask after another, and the pilot plays them", async () => {
    const ai = await remountWith(fakeAi({ answers: [BREAK, BUILD, PEAK, GROOVE] }));
    aiBtn().click();
    vibe("  oscuro  y largo ");
    $("button.auto").click();
    expect(aiBtn().classList.contains("is-thinking")).toBe(true);
    expect($(".section-queue .is-thinking").textContent).toBe("✨ pensando…");
    await flushPromises();
    expect(aiBtn().classList.contains("is-thinking")).toBe(false);
    expect($(".section-queue .is-thinking")).toBeNull();
    expect(ai.asks).toHaveLength(3); // and no more: three are planned
    const [ask, second, third] = ai.asks;
    expect(ask.name).toBe("chrome");
    expect(ask.prompt).toContain("Now playing: intro, 8 bars.");
    expect(ask.prompt).toContain('The listener just asked for: "oscuro y largo".');
    expect(ask.opts.system).toBe(systemOf({ style: "psytrance", bpm: 145, vibe: "oscuro y largo" }));
    expect(ask.opts.system.startsWith(`You arrange ${GENRE.psytrance}.`)).toBe(true);
    expect(ask.prompt).not.toContain("Already planned");
    expect(ask.schema.properties.section.enum).toContain("breakdown");
    expect(second.prompt).toContain("Already planned to follow it, in order:\n- breakdown, 16 bars: lead.acid, pad.chord\n");
    expect(second.prompt).toContain("After the planned breakdown, the usual next is build. Plan the section after it.");
    expect(second.prompt).toContain("The listener's wish comes first: keep the track true to it"); // a plan followed it
    expect(second.opts.system).toContain('The listener\'s wish for the track: "oscuro y largo".');
    expect(third.prompt).toContain("- breakdown, 16 bars: lead.acid, pad.chord\n- build, 8 bars\n");
    expect(queue()).toEqual(["breakdown", "build", "peak"]);
    expect([...root.querySelectorAll(".section-queue .is-ai")].map((li) => li.textContent)).toEqual(["✨ Break", "✨ Subida", "✨ Pico"]);
    expect($(".section-queue .is-ai").title).toBe("Lo eligió la IA: a dark break");
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
    expect($(".section-left").textContent).toBe("16 compases");
    expect(pressed()).toEqual(expect.arrayContaining(["lead.acid", "pad.chord"]));
    expect(ai.asks).toHaveLength(4); // one in, one more asked for
    expect(ai.asks[3].prompt).toContain("Sections so far: intro, breakdown.");
    expect(ai.asks[3].prompt).toMatch(/What the sections before it opened with:\n- intro: kick\./);
    expect(ai.asks[3].prompt).toContain("Already planned to follow it, in order:\n- build, 8 bars\n- peak, 16 bars\n");
    await flushPromises();
    expect(queue()).toEqual(["build", "peak", "groove"]);
    expect(ai.asks).toHaveLength(4);
  });

  it("dresses the sounds and writes the parts its plan says, when the section comes", async () => {
    const plan = {
      ...BREAK,
      dress: [{ id: "lead.acid", tone: 0, length: 0, drive: 2, motion: 0, synth: "supersaw" }],
      parts: { lead: ["1", "-", "3", "-", "5", "-", "-", "-"], pad: ["1", "6"], bass: [] },
    };
    const ai = await remountWith(fakeAi({ answers: [plan] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    expect(saved().variants["lead.acid"]?.synth).not.toBe("supersaw"); // not before its section
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
    const lead = saved().variants["lead.acid"];
    expect(lead.synth).toBe("supersaw");
    expect(lead.insert).toMatchObject({ drive: "hard", amount: 0.75 });
    expect(lead.notes.filter((n) => n.step < 8).map((n) => n.step)).toEqual([0, 2, 4]);
    const pad = saved().variants["pad.chord"];
    expect(pad.notes.filter((n) => n.step === 16)).toHaveLength(3);
    expect(saved().auto).toEqual(expect.arrayContaining(["lead.acid", "pad.chord"])); // the pilot's: a new run resets them
    expect(ai.asks.at(-1).prompt).toContain("How you dressed them: lead.acid drive 2 synth supersaw.");
  });

  it("a plan at Alta builds the sound: its filter, sweep and echo land with the section", async () => {
    localStorage.setItem("psy-sampler:ai", JSON.stringify({ level: "high" }));
    const empty = { tone: 0, length: 0, drive: 0, motion: 0, synth: "", cutoff: 0, res: 0, shape: "", env: 0, distortion: "", trem: "", autopan: "" };
    const plan = { ...BREAK, dress: [{ id: "lead.acid", ...empty, filter: "vowel o", sweep: "2 bars", echo: "dotted 1/8" }] };
    const ai = await remountWith(fakeAi({ answers: [plan] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
    const lead = saved().variants["lead.acid"];
    expect(lead.insert).toMatchObject({ filter: "vowel", vowel: "o", lfo: 0.4, rate: 32 });
    expect(lead.echo).toEqual({ steps: 3, semis: 0 });
    expect(ai.asks.at(-1).prompt).toContain("How you dressed them: lead.acid filter vowel o sweep 2 bars echo dotted 1/8.");
  });

  it("an answer that comes after the section's last loop started is dropped", async () => {
    let answer;
    const ai = await remountWith(fakeAi({ answers: [() => new Promise((resolve) => (answer = resolve))] }));
    aiBtn().click();
    $("button.auto").click();
    cue().click(); // not waiting for the plans
    await flushPromises(); // the form is in: the first section's plan is on its way
    advanceSeconds(6 * BAR + 0.05); // into the intro's last loop
    expect(ai.asks[0].opts.signal.aborted).toBe(true);
    answer(BREAK);
    await flushPromises();
    expect(queue()).not.toContain("breakdown");
    apply("calm"); // the next section is decided: only the form is asked again
    expect($(".status").textContent).toBe("✨ Onda «calm»: la IA vuelve a planear lo que viene…");
    expect(ai.formAsks).toHaveLength(2);
    await flushPromises();
    expect(ai.asks).toHaveLength(1);
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Groove"); // the pilot's own pick
    expect(ai.asks).toHaveLength(2);
    expect(ai.asks[1].prompt).toContain('The listener just asked for: "calm".');
  });

  it("an answer still on its way when its section becomes the next one goes to the pilot", async () => {
    let answer;
    const ai = await remountWith(fakeAi({ answers: [BREAK, () => new Promise((resolve) => (answer = resolve)), GROOVE] }));
    aiBtn().click();
    $("button.auto").click();
    $("button.auto").click(); // armed, 🤖 again starts it with the plans it has
    expect(engine.isRunning()).toBe(true);
    await flushPromises();
    expect(ai.asks).toHaveLength(2); // the one after the breakdown, on its way
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
    expect(ai.asks[1].opts.signal.aborted).toBe(false);
    answer(PEAK); // not where the pilot goes after a breakdown
    await flushPromises();
    expect(queue()).toEqual(["peak", "groove", "groove"]);
    advanceSeconds(16 * BAR);
    expect($(".section-badge").textContent).toBe("Pico");
  });

  it("a queued section is the one it plans in its place; the plans for sections no longer coming go", async () => {
    const ai = await remountWith(fakeAi({ answers: [queuedOr(BREAK)] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    expect(queue()).toEqual(["breakdown", "breakdown", "breakdown"]);
    $('[data-section="peak"]').click(); // not what was planned: everything goes
    expect(ai.asks).toHaveLength(4);
    expect(ai.asks[3].schema.properties.section.enum).toEqual(["peak"]);
    expect(ai.asks[3].prompt).toContain("The listener queued peak next: plan that section.");
    expect($('.section-queue [data-queued="peak"]').classList.contains("is-thinking")).toBe(true);
    await flushPromises();
    expect($(".section-queue .is-thinking")).toBeNull();
    expect(queue()).toEqual(["peak", "breakdown", "breakdown"]);
    $('[data-section="groove"]').click(); // behind peak: the peak's plan stays
    expect(ai.asks).toHaveLength(7);
    expect(ai.asks[6].schema.properties.section.enum).toEqual(["groove"]);
    expect(ai.asks[6].prompt).toContain("The listener queued groove after the planned peak: plan that section.");
    expect($('.section-queue [data-queued="groove"]').classList.contains("is-thinking")).toBe(true);
    await flushPromises();
    expect(queue()).toEqual(["peak", "groove", "breakdown"]);
    root.querySelector('.section-queue [data-queued="peak"] .unqueue').click();
    expect(ai.asks.at(-1).schema.properties.section.enum).toEqual(["groove"]);
    await flushPromises();
    expect(queue()).toEqual(["groove", "breakdown", "breakdown"]);
    const asked = ai.asks.length;
    root.querySelector('.section-queue [data-queued="groove"] .unqueue').click(); // its plan was the queue's
    expect(ai.asks).toHaveLength(asked + 1);
    expect(ai.asks.at(-1).schema.properties.section.enum).toContain("breakdown");
    await flushPromises();
    expect(queue()).toEqual(["breakdown", "breakdown", "breakdown"]);
  });

  it("a new style while it plays: the plans up to its drop stay in the old style, the drop's is asked in the new one", async () => {
    const ai = await remountWith(fakeAi({ answers: [queuedOr(GROOVE)] }));
    playing();
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    const before = ai.asks.length;
    const style = $('[data-control="style"]');
    style.value = "techno";
    style.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(queue()).toEqual(["breakdown", "build", "peak"]);
    const asked = (section) => ai.asks.slice(before).find((a) => a.schema.properties.section.enum.join() === section);
    expect(asked("breakdown").opts.system).toBe(systemOf({ style: "psytrance", bpm: 145 }));
    expect(asked("build").opts.system).toBe(systemOf({ style: "psytrance", bpm: 145 }));
    expect(asked("peak").opts.system).toBe(systemOf({ style: "techno", bpm: 135 }));
    expect(asked("breakdown").prompt).toContain("lead.melodic");
    expect(asked("peak").prompt).not.toContain("lead.melodic"); // psytrance's, not techno's
  });

  it("Aplicar plans again with the vibe, keeping the next section's plan as a buffer", async () => {
    // The model follows the vibe its instructions hold: a full peak, or a break.
    const follows = (opts) => Promise.resolve(opts.system.includes("full peak") ? PEAK : BREAK);
    const ai = await remountWith(fakeAi({ answers: [follows] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    expect(engine.isRunning()).toBe(true);
    expect(queue()).toEqual(["breakdown", "breakdown", "breakdown"]);
    vibe("a full peak"); // typed: kept for the next asks, nothing dropped
    expect(ai.asks).toHaveLength(3);
    expect($(".status").textContent).toBe("Onda «a full peak» guardada: la IA la usa en la próxima fase que planee.");
    apply();
    expect(queue()).toEqual(["breakdown"]);
    expect($(".section-queue .is-thinking").textContent).toBe("✨ pensando…"); // the form, first
    expect($(".status").textContent).toBe("✨ Onda «a full peak»: Break queda como estaba y la IA vuelve a planear lo que sigue…");
    expect(ai.formAsks[1].prompt).toContain("Shape the form to the listener's wish");
    expect(ai.formAsks[1].opts.system).toContain('The listener\'s wish for the track: "a full peak".');
    expect(ai.formAsks[1].prompt).toContain("Already coming after it, in order: breakdown.");
    await flushPromises();
    expect(ai.asks[3].prompt).toContain('The listener just asked for: "a full peak".');
    expect(ai.asks[3].prompt).toContain("Already planned to follow it, in order:\n- breakdown, 16 bars");
    expect(queue()).toEqual(["breakdown", "peak", "peak"]);
    expect($(".status").textContent).toBe("✨ Onda «a full peak» aplicada desde Pico.");
    expect(ai.asks[4].prompt).toContain("The listener's wish comes first: keep the track true to it");
    apply(" a full  peak "); // the same words: asked again all the same
    await flushPromises();
    expect(ai.asks).toHaveLength(7);
    expect(ai.asks[5].prompt).toContain('The listener just asked for: "a full peak".');
    apply("dark"); // the ask on its way is dropped
    apply("darker");
    expect(ai.formAsks.at(-2).opts.signal.aborted).toBe(true);
    await flushPromises();
    expect(ai.asks[7].prompt).toContain('The listener just asked for: "darker".');
    expect(queue()).toEqual(["breakdown", "breakdown", "breakdown"]);
    advanceSeconds(6 * BAR + 0.05); // the last loop: what comes next is decided
    $("#ai-vibe").value = "a full peak";
    $("#ai-vibe").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); // Enter applies too
    expect($(".status").textContent).toBe("✨ Onda «a full peak»: Break queda como estaba y la IA vuelve a planear lo que sigue…");
    expect(queue()).toEqual(["breakdown"]);
    await flushPromises();
    expect(queue()).toEqual(["breakdown", "peak", "peak"]);
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
  });

  it("✨ in silence arms the autopilot and plans the first sections before ▶", async () => {
    const ai = await remountWith(fakeAi({ answers: [BREAK, BUILD, PEAK] }));
    aiBtn().click();
    await flushPromises();
    expect(ai.asks).toHaveLength(3);
    expect(ai.asks[0].prompt).toContain("Now playing: intro, 8 bars.");
    expect(ai.asks[0].prompt).not.toContain("Sounds playing now: none.");
    expect(engine.isRunning()).toBe(false);
    expect($("button.auto").getAttribute("aria-pressed")).toBe("true");
    expect($(".section-badge").textContent).toBe("Intro");
    expect(queue()).toEqual(["breakdown", "build", "peak"]);
    expect($(".status").textContent).toBe("✨ Las primeras 3 fases están planeadas: ▶ para arrancar.");
    expect(cue().textContent).toBe("▶ Arrancar");
    expect($(".stop").hidden).toBe(false);
    cue().click();
    expect(engine.isRunning()).toBe(true);
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Break");
    expect(pressed()).toEqual(expect.arrayContaining(["lead.acid", "pad.chord"]));
  });

  it("✨ in silence plans the opening first: a long intro that fades the bass in and drops into what follows", async () => {
    const opening = {
      why: "a floating opener, the bass creeping in",
      section: "intro",
      bars: 16,
      layers: { kick: ["kick.punchy"], bass: ["bass.rolling"], lead: ["lead.soaring"], pad: ["pad.supersaw"] },
      dress: [{ id: "pad.supersaw", tone: 2, length: 0, drive: 0, motion: 2, synth: "" }],
      parts: { lead: ["8", "-", "5", "-", "3", "-", "1", "-"] },
      fx: "fx.sweep",
    };
    const ai = await remountWith(fakeAi({ answers: [BUILD], opening }));
    const fx = vi.spyOn(engine, "triggerFx");
    vibe("volado");
    aiBtn().click();
    await flushPromises();
    expect(ai.openings).toHaveLength(1);
    const [ask] = ai.openings;
    expect(ask.prompt).toContain("This is the opening of the track and of the show");
    expect(ask.prompt).toContain("Plan the intro it opens with: 16 or 24 or 32 bars;");
    expect(ask.prompt).toContain('The listener asked for: "volado".');
    expect(ask.schema.properties.section.enum).toEqual(["intro"]);
    expect(ai.asks[0].prompt).toContain("Now playing: intro, 16 bars.");
    expect(ai.asks[0].prompt).toMatch(/Sounds playing now: .*lead\.soaring/);
    expect(ai.asks[0].prompt).toContain("The listener's wish comes first"); // the opening followed it
    expect(ai.asks[0].opts.system).toContain('wish for the track: "volado"');
    expect(engine.isRunning()).toBe(false);
    expect($(".section-left").textContent).toBe("16 compases");
    expect($(".section-badge").title).toBe("Lo eligió la IA: a floating opener, the bass creeping in");
    expect($(".status").textContent).toBe("✨ Las primeras 4 fases están planeadas: ▶ para arrancar.");
    const motif = saved().variants["lead.soaring"].notes.filter((n) => n.step < 8).map((n) => n.midi);
    expect(motif).toEqual([69, 64, 60]); // its part: 8, 5, 3 walking down A minor
    expect(saved().variants["pad.supersaw"].insert.lp).toBeLessThan(3000); // dressed, and muffled by the opening's ride
    const bass = () => saved().variants["bass.rolling"];
    const kick = () => saved().variants["kick.punchy"];
    expect([kick().level, bass().level]).toEqual([0, 0]); // not yet: atmosphere first
    expect(bass().insert.lp).toBe(120);
    cue().click();
    expect(pressed()).toEqual(expect.arrayContaining(["kick.punchy", "bass.rolling", "lead.soaring", "pad.supersaw"]));
    advanceSeconds(0.05);
    expect(fx).toHaveBeenCalledWith("fx.sweep", expect.any(Number));
    expect(fx).toHaveBeenCalledTimes(1);
    advanceSeconds(6 * BAR); // the 4th loop: the kick is in, the bass still out
    expect(kick().level).toBeGreaterThan(0);
    expect(bass().level).toBe(0);
    advanceSeconds(4 * BAR); // the 6th: the bass creeps in, filtered
    expect(bass().level).toBeGreaterThan(0);
    expect(bass().level).toBeLessThan(0.8);
    expect(bass().insert.lp).toBeGreaterThan(120);
    expect(bass().insert.lp).toBeLessThan(1500);
    expect(fx).toHaveBeenCalledTimes(1);
    advanceSeconds(4 * BAR); // the last loop: a drop, with a riser
    expect($(".section-badge").textContent).toBe("Intro"); // 16 bars, not 8
    expect($('[data-action="drop"]').getAttribute("aria-pressed")).toBe("true");
    expect(fx).toHaveBeenCalledTimes(2);
    advanceSeconds(2 * BAR);
    expect($(".section-badge").textContent).toBe("Subida");
    expect(fx).toHaveBeenCalledWith("fx.impact", expect.any(Number)); // the explosion
    expect(bass().insert).toMatchObject({ hp: 20, lp: 20000 }); // wide open
    expect(kick().insert).toMatchObject({ hp: 20, lp: 20000 });
  });

  it("an opening that comes after ▶ is dropped, and the sections ahead are asked for", async () => {
    let answer;
    const ai = await remountWith(fakeAi({ answers: [BREAK], opening: () => new Promise((resolve) => (answer = resolve)) }));
    aiBtn().click();
    await flushPromises();
    expect(ai.asks).toHaveLength(0);
    cue().click();
    expect(ai.openings[0].opts.signal.aborted).toBe(true);
    answer({ section: "intro", bars: 16, layers: { lead: ["lead.soaring"] } });
    await flushPromises();
    expect(ai.asks.length).toBeGreaterThan(0);
    expect(pressed()).not.toContain("lead.soaring");
    expect($(".section-left").textContent).toBe("8 compases");
  });

  it("✨ lays out the form of the track first: the plans fill it in, the pilot walks it, ✕ drops a section", async () => {
    const form = ["groove", "build", "peak", "breakdown", "build", "peak", "groove", "build", "peak", "breakdown"];
    const ai = await remountWith(fakeAi({ forms: [{ why: "a long journey", sections: form }], answers: [queuedOr(BREAK)] }));
    aiBtn().click();
    await flushPromises();
    expect(ai.formAsks).toHaveLength(1);
    expect(ai.formAsks[0].prompt).toContain("Now playing: intro.");
    expect(ai.formAsks[0].prompt).toContain("the next 20 sections, in order, after the intro.");
    expect(ai.asks).toHaveLength(3);
    expect(ai.asks.map((a) => a.schema.properties.section.enum)).toEqual([["groove"], ["build"], ["peak"]]);
    expect(ai.asks[0].prompt).toContain("Your form of the track has groove next: plan that section.");
    expect(ai.asks[0].prompt).toContain("After it, the track goes on with: build, peak, breakdown");
    expect(queue()).toEqual(form.slice(0, 8));
    expect($(".section-queue .is-ai").title).toBe("Secuencia de la IA: a long journey");
    const more = [...root.querySelectorAll(".section-queue .is-ai")].at(-1);
    expect(more.textContent).toBe("+2");
    expect(more.title).toBe("Pico → Break");
    cue().click();
    advanceSeconds(8 * BAR);
    expect($(".section-badge").textContent).toBe("Groove");
    expect(queue()).toEqual(form.slice(1, 9));
    root.querySelector('.section-queue [data-queued="peak"] .unqueue').click(); // the first peak
    expect(queue()).toEqual(["build", "breakdown", "build", "peak", "groove", "build", "peak", "breakdown"]);
    await flushPromises();
    expect(ai.asks.slice(-2).map((a) => a.schema.properties.section.enum)).toEqual([["breakdown"], ["build"]]); // what follows it now
    $('[data-section="peak"]').click(); // by hand: before the form
    expect(queue().slice(0, 3)).toEqual(["peak", "build", "breakdown"]);
    expect(ai.formAsks).toHaveLength(1); // once per run
  });

  it("the complexity: Baja asks no form and in few words, Alta for the whole sound; remembered", async () => {
    const ai = await remountWith(fakeAi({ answers: [queuedOr(BREAK)] }));
    aiBtn().click();
    expect($("#ai-level").value).toBe("mid");
    expect([...root.querySelectorAll("#ai-level option")].map((o) => o.textContent)).toEqual(["Baja", "Media", "Alta"]);
    $("#ai-level").value = "low";
    $("#ai-level").dispatchEvent(new Event("change"));
    const low = systemOf({ level: "low", style: "psytrance", bpm: 145 });
    expect(ai.chrome.start).toHaveBeenLastCalledWith(expect.any(Function), low); // its own base session
    await flushPromises();
    expect(ai.formAsks).toHaveLength(0);
    expect(ai.asks.length).toBeGreaterThan(0);
    for (const ask of [...ai.openings, ...ai.asks]) {
      expect(ask.opts.system).toBe(low);
      expect(ask.schema.properties).not.toHaveProperty("dress");
    }
    expect($(".ai-summary").textContent).toBe("Chrome (Gemini Nano) · Complejidad baja");
    expect($("#ai-level").closest("label").title).toMatch(/Baja: Solo las fases y sus sonidos/);
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai")).level).toBe("low");

    const high = await remountWith(fakeAi({ answers: [queuedOr(BREAK)] }));
    expect($("#ai-level").value).toBe("low"); // remembered
    $("#ai-level").value = "high";
    $("#ai-level").dispatchEvent(new Event("change"));
    aiBtn().click(); // off, and on again: armed in silence
    aiBtn().click();
    await flushPromises();
    expect(high.formAsks).toHaveLength(1);
    expect(high.asks.at(-1).opts.system).toBe(systemOf({ level: "high", style: "psytrance", bpm: 145 }));
    expect(high.asks.at(-1).schema.properties.dress.items.required).toContain("filter");
  });

  it("an empty vibe is no message: the AI sees the sounds by id, and the note under it says so", async () => {
    const ai = await remountWith(fakeAi({ answers: [queuedOr(BREAK)] }));
    aiBtn().click();
    await flushPromises();
    expect($(".ai-vibe-note").textContent).toMatch(/no hay mensaje para la IA/);
    expect(ai.asks.length).toBeGreaterThan(0);
    for (const ask of ai.asks) expect(ask.prompt).not.toMatch(/squelchy|hypnotic, driving/);
    const vibe = $("#ai-vibe");
    vibe.value = "oscuro";
    vibe.dispatchEvent(new Event("input"));
    expect($(".ai-vibe-note").textContent).toMatch(/cómo suena cada sonido/);
    vibe.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(ai.asks.at(-1).opts.system).toMatch(/oscuro/);
    expect(ai.asks.at(-1).prompt).toMatch(/squelchy|hypnotic, driving/);
  });

  it("■ lets go of the armed autopilot", async () => {
    await remountWith(fakeAi({ answers: [BREAK] }));
    aiBtn().click();
    await flushPromises();
    $(".stop").click();
    expect($("button.auto").getAttribute("aria-pressed")).toBe("false");
    expect($(".stop").hidden).toBe(true);
    expect(cue().textContent).toBe("⏺ Armar");
    expect(queue()).toEqual([]);
  });

  it("🤖 with ✨ on waits for the first sections' plans, then plays", async () => {
    localStorage.setItem("psy-sampler:ai", JSON.stringify({ on: true }));
    let answer;
    const ai = await remountWith(fakeAi({ answers: [BREAK, () => new Promise((resolve) => (answer = resolve)), PEAK] }));
    $("button.auto").click();
    expect(engine.isRunning()).toBe(false);
    expect($(".status").textContent).toBe("✨ Planeando la fase 1 de 4 antes de arrancar… ▶ para arrancar ya.");
    await flushPromises();
    expect($(".status").textContent).toBe("✨ Planeando la fase 3 de 4 antes de arrancar… ▶ para arrancar ya.");
    expect(engine.isRunning()).toBe(false);
    answer(BUILD);
    await flushPromises();
    expect(ai.asks).toHaveLength(3);
    expect(engine.isRunning()).toBe(true);
    expect(queue()).toEqual(["breakdown", "build", "peak"]);
  });

  it("🤖 with ✨ on plays at once when the model fails", async () => {
    localStorage.setItem("psy-sampler:ai", JSON.stringify({ on: true }));
    await remountWith(fakeAi({ fail: true }));
    $("button.auto").click();
    await flushPromises();
    expect(engine.isRunning()).toBe(true);
    expect($(".status").textContent).toMatch(/La IA no respondió/);
  });

  it("when the model fails it says so once, and the pilot carries on alone", async () => {
    await remountWith(fakeAi({ fail: true }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    expect($(".status").textContent).toMatch(/La IA no respondió/);
    $(".status").textContent = "";
    for (let i = 0; i < 12; i++) {
      advanceSeconds(2 * BAR);
      await flushPromises();
    }
    expect($(".status").textContent).toBe("");
    expect($(".section-badge").textContent).not.toBe("Intro");
  });

  it("🔗 carries the plans it took: the link replays the same track in a browser with no AI", async () => {
    const plans = [
      { section: "groove", bars: 8, layers: { bass: ["bass.gallop"], lead: ["lead.arp"] } },
      {
        section: "breakdown",
        bars: 8,
        layers: { pad: ["pad.supersaw"], lead: ["lead.vowel"] },
        dress: [{ id: "lead.vowel", tone: -1, length: 0, drive: 1, motion: 1, synth: "" }],
        parts: { lead: ["1", "3", "5", "-", "8", "-", "5", "-"], pad: ["1", "4"] },
      },
      { section: "build", bars: 8, layers: {} },
      { section: "peak", bars: 16, layers: { perc: ["perc.ride", "perc.snare"] } },
    ];
    const record = async (node, c) => {
      const log = [];
      node.querySelector("button.auto").click();
      for (let i = 0; i < 20; i++) {
        await flushPromises();
        for (let k = 0; k < Math.ceil((2 * BAR) / 0.025); k++) {
          c.currentTime += 0.025;
          vi.advanceTimersByTime(25);
        }
        const on = [...node.querySelectorAll('[aria-pressed="true"][data-variant]')].map((b) => b.dataset.variant);
        log.push(`${node.querySelector(".section-badge").textContent} ${on.join()}`);
      }
      node.querySelector("button.stop").click();
      return log;
    };
    const opening = {
      section: "intro",
      bars: 16,
      layers: { kick: [], lead: ["lead.soaring"] },
      parts: { lead: ["8", "-", "5", "-", "3", "-", "1", "-"] },
      fx: "fx.crash",
    };
    const ai = await remountWith(fakeAi({ answers: plans, opening }));
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    aiBtn().click();
    const first = await record(root, ctx);
    expect(first.some((l) => l.startsWith("Break "))).toBe(true);
    expect(first[0]).toMatch(/^Intro .*lead\.soaring/);
    const written = ["lead.vowel", "pad.supersaw"].map((id) => saved().variants[id]);
    expect(written[0].insert.drive).toBe("soft");
    expect(ai.asks.length).toBeGreaterThanOrEqual(4);

    vi.stubGlobal("Blob", NodeBlob); // jsdom's has no stream(), and the link is deflated
    vi.useRealTimers(); // nor do (de)compression streams settle on fake ones
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    $('[data-action="share"]').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const link = writeText.mock.calls[0][0];
    const hash = link.slice(link.indexOf("#"));
    expect(hash).toMatch(/&ai=/);
    expect(hash).toMatch(/&open=/);

    localStorage.clear();
    history.replaceState(null, "", `/${hash}`);
    const c2 = new FakeAudioContext();
    const other = document.createElement("div");
    document.body.replaceChildren(other);
    mount(other, newEngine(c2)); // no models at all
    await vi.waitFor(() => expect(other.querySelector(".status").textContent).toMatch(/goa/));
    vi.useFakeTimers();
    expect(await record(other, c2)).toEqual(first);
    expect(["lead.vowel", "pad.supersaw"].map((id) => saved().variants[id])).toEqual(written); // dressed and written the same
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

  it("switches from the ES/EN/PT pill and marks the active one", () => {
    expect([...document.querySelectorAll(".lang-buttons button")].map((b) => b.textContent)).toEqual(["ES", "EN", "PT"]);
    $('[data-lang="en"]').click();
    expect($("button.stop").textContent).toBe("Stop");
    expect($('[data-lang="en"]').getAttribute("aria-pressed")).toBe("true");
    expect($('[data-lang="es"]').getAttribute("aria-pressed")).toBe("false");
    expect($('[data-control="lang"]').value).toBe("en");
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

  describe("recording", () => {
    const rec = () => $('[data-action="record"]');
    const tap = () => ctx.nodes.filter((n) => n.kind === "worklet").at(-1);
    const play = (seconds, level = 0.5) => {
      const n = 48000 * seconds;
      tap().port.onmessage({ data: [new Float32Array(n).fill(level), new Float32Array(n).fill(level)] });
    };
    // The worklet answers the flush with what it held, then null.
    const stopRec = async () => {
      rec().click();
      await flushPromises();
      tap().port.onmessage({ data: null });
      await flushPromises();
    };

    it("waits for the first sound, shows the time, and downloads a WAV on stop", async () => {
      expect(rec().textContent).toBe("● Grabar");
      rec().click();
      await flushPromises();
      expect(rec().textContent).toBe("● Esperando sonido…");
      expect(rec().classList.contains("is-waiting")).toBe(true);
      play(1, 0);
      vi.advanceTimersByTime(250);
      expect(rec().textContent).toBe("● Esperando sonido…");
      play(2);
      vi.advanceTimersByTime(250);
      expect(rec().textContent).toBe("■ 0:02");
      expect(rec().classList.contains("is-recording")).toBe(true);

      await stopRec();
      expect(downloads.at(-1).fileName).toMatch(/^psy-layers-\d{4}-\d\d-\d\d-\d{4}\.wav$/);
      expect(downloads.at(-1).type).toBe("audio/wav");
      expect(downloads.at(-1).size).toBe(44 + 2 * 48000 * 6);
      expect($(".status").textContent).toMatch(/Grabación guardada: .* \(0:02\)/);
      expect(rec().textContent).toBe("● Grabar");
    });

    it("downloads nothing when nothing sounded", async () => {
      rec().click();
      await flushPromises();
      play(1, 0);
      const before = downloads.length;
      await stopRec();
      expect(downloads).toHaveLength(before);
      expect($(".status").textContent).toMatch(/No sonó nada/);
    });

    it("counts a saved take and its seconds for the usage numbers", async () => {
      const stats = { count: vi.fn() };
      root = document.createElement("div");
      document.body.replaceChildren(root);
      mount(root, engine, { stats });
      rec().click();
      await flushPromises();
      play(2);
      await stopRec();
      expect(stats.count.mock.calls).toEqual([["recordings"], ["recorded", 2]]);
    });

    it("keeps recording through a language change", async () => {
      rec().click();
      await flushPromises();
      play(1);
      const lang = $('[data-control="lang"]');
      lang.value = "en";
      lang.dispatchEvent(new Event("change"));
      play(1);
      vi.advanceTimersByTime(250);
      expect(rec().textContent).toBe("■ 0:02");
      await stopRec();
      expect($(".status").textContent).toMatch(/Recording saved: .* \(0:02\)/);
    });

    it("says so where the browser can't record", async () => {
      ctx.audioWorklet = undefined;
      rec().click();
      await flushPromises();
      expect($(".status").textContent).toMatch(/no puede grabar/);
      expect(rec().textContent).toBe("● Grabar");
    });
  });

  it("Restaurar sonidos takes the sounds back to factory, deselects them all and keeps the rest", () => {
    immediate();
    openEditor("perc.hat");
    stepCell("perc.hat", 0).click();
    editor("perc.hat").querySelector('[data-action="duplicate"]').click();
    stepCell("perc.hat~1", 1).click();
    $('[data-action="snapshot"]').click();
    $('[data-layer="kick"] .grip').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect($('[data-action="reset"]').textContent).toBe("Restaurar sonidos");
    $('[data-action="reset"]').click();
    expect(root.querySelectorAll(".is-edited")).toHaveLength(0);
    expect(saved().variants).toEqual({ "perc.hat~1": defaultData("perc.hat~1") });
    expect(button("perc.hat~1")).not.toBeNull();
    expect(saved().snapshots).toHaveLength(1);
    expect($("section.layer").dataset.layer).not.toBe("kick");
    expect(pressed()).toEqual([]);
    expect(queued()).toEqual([]);
    expect(engine.isRunning()).toBe(false);
    expect($(".status").textContent).toBe("Sonidos de fábrica.");
  });

  it("Restaurar todo, with De fábrica ticked, goes back to factory", () => {
    openEditor("perc.hat");
    stepCell("perc.hat", 0).click();
    editor("perc.hat").querySelector('[data-action="duplicate"]').click();
    $('[data-layer="kick"] .grip').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    $("#factory-reset").click();
    expect($('[data-action="reset"]').textContent).toBe("Restaurar todo");
    $('[data-action="reset"]').click();
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

describe("filter, distortion and the DJ filter", () => {
  const editorSelect = (variant, name) => editor(variant).querySelector(`[data-control="${name}"]`);
  const choose = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new Event("change"));
  };
  const knob = (variant, key) => editor(variant).querySelector(`[data-param="${key}"]`);

  it("every editor has a filter and a distortion; their knobs show once one is on", () => {
    openEditor("perc.hat");
    const cutoff = knob("perc.hat", "cutoff").closest(".knob");
    const drive = knob("perc.hat", "amount").closest(".knob");
    expect([cutoff.hidden, drive.hidden]).toEqual([true, true]);
    choose(editorSelect("perc.hat", "filter"), "lowpass");
    choose(editorSelect("perc.hat", "drive"), "fold");
    expect([cutoff.hidden, drive.hidden]).toEqual([false, false]);
    expect(saved().variants["perc.hat"].insert).toMatchObject({ filter: "lowpass", drive: "fold" });
  });

  it("the cutoff slider moves in octaves", () => {
    openEditor("lead.acid");
    choose(editorSelect("lead.acid", "filter"), "highpass");
    const input = knob("lead.acid", "cutoff");
    input.value = "200"; // half way between 40 Hz and 16 kHz, on a log scale
    input.dispatchEvent(new Event("input"));
    expect(saved().variants["lead.acid"].insert.cutoff).toBe(Math.round(40 * Math.sqrt(16000 / 40)));
    expect(input.closest(".knob").querySelector("output").textContent).toBe("800 Hz");
  });

  it("every sound has a high-pass and a low-pass of its own, open at the ends, always shown", () => {
    openEditor("pad.chord");
    const hp = knob("pad.chord", "hp");
    const lp = knob("pad.chord", "lp");
    expect([hp.closest(".knob").hidden, lp.closest(".knob").hidden]).toEqual([false, false]); // filter "off" or not
    expect([hp.value, lp.value]).toEqual(["0", "400"]);
    expect([hp, lp].map((n) => n.closest(".knob").querySelector("output").textContent)).toEqual(["–", "–"]);
    lp.value = "200"; // half way on a log scale: 20 Hz · √1000 ≈ 632 Hz
    lp.dispatchEvent(new Event("input"));
    expect(saved().variants["pad.chord"].insert).toMatchObject({ lp: 632, hp: 20, filter: "off" });
    expect(lp.closest(".knob").querySelector("output").textContent).toBe("632 Hz");
  });

  it("the autopilot's filter ride shows in an open editor", () => {
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    $("button.auto").click(); // an intro: its pad starts with a muffled low-pass
    const pad = pressed().find((v) => v.startsWith("pad."));
    openEditor(pad);
    advanceSeconds(2 * BAR);
    const lp = saved().variants[pad].insert.lp;
    expect(lp).toBeLessThan(20000);
    const shown = knob(pad, "lp").closest(".knob").querySelector("output").textContent;
    expect(shown).toBe(lp >= 1000 ? `${(lp / 1000).toFixed(1)} kHz` : `${lp} Hz`);
    expect(editor(pad).querySelector('[data-fold="insert"] .fold-on').hidden).toBe(false);
  });

  it("the autopilot's filter ride shows on the tile, a band that follows it frame by frame", () => {
    $("#seed").value = "goa";
    $("#seed").dispatchEvent(new Event("change"));
    $("button.auto").click();
    const pad = pressed().find((v) => v.startsWith("pad."));
    const tile = $(`[data-variant="${pad}"]`);
    const lpAt = () => parseFloat(tile.querySelector(".tone-band").style.getPropertyValue("--lp"));
    openEditor(pad);
    const shown = () => knob(pad, "lp").value;
    advanceSeconds(2 * BAR);
    const to = saved().variants[pad].insert.lp;
    flushFrame();
    const first = [lpAt(), shown()];
    advanceSeconds(BAR);
    flushFrame();
    expect(tile.classList.contains("is-toned")).toBe(true);
    expect(lpAt()).toBeLessThan(100);
    expect(lpAt()).not.toBe(first[0]); // it moves between frames
    expect(shown()).not.toBe(first[1]); // and so does the open editor's knob
    expect(to).toBeLessThan(20000);
    const kick = pressed().find((v) => v.startsWith("kick."));
    expect(kick && $(`[data-variant="${kick}"]`).classList.contains("is-toned")).toBe(false);
  });

  it("the DJ knob filters the master, reads out its cutoff and recentres on a double click", () => {
    const spy = vi.spyOn(engine, "setMasterFilter");
    const dj = $("#dj");
    dj.value = "-1";
    dj.dispatchEvent(new Event("input"));
    expect(spy).toHaveBeenLastCalledWith(-1);
    expect($(".dj-value").textContent).toBe("LP 150 Hz");
    dj.value = "1";
    dj.dispatchEvent(new Event("input"));
    expect($(".dj-value").textContent).toBe("HP 6.0 kHz");
    dj.dispatchEvent(new Event("dblclick"));
    expect(spy).toHaveBeenLastCalledWith(0);
    expect($(".dj-value").textContent).toBe("abierto");
    expect(saved()).not.toHaveProperty("dj"); // a performance control, never stored
  });
});

describe("usage counts", () => {
  it("counts exports, shares and autopilot starts, not a new seed under the autopilot", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async () => {} } });
    const stats = { count: vi.fn() };
    root = document.createElement("div");
    document.body.replaceChildren(root);
    mount(root, engine, { stats });
    const counted = () => stats.count.mock.calls.map(([event]) => event);

    $('[data-action="export"]').click();
    $('[data-action="share"]').click();
    await flushPromises();
    $("button.auto").click();
    $("#seed").value = "otra";
    $("#seed").dispatchEvent(new Event("change"));
    $('[data-action="wav-mix"]').click();
    await flushPromises();
    $('[data-action="snapshot"]').click();
    $('[data-action="export-snaps"]').click();
    expect(counted()).toEqual(["presets", "shares", "autopilot", "renders", "snapshots"]);
  });
});
