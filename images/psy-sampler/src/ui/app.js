// DOM wiring. Holds the selection and the edits, renders them, and forwards
// changes to the engine; all timing lives in the engine.
import { LAYERS } from "../catalog.js";
import { DEFAULTS, defaultData, sanitize } from "../audio/patterns.js";
import { BG_KICK_VARIANT, desiredLanes, laneKey, pressVariant } from "../selection.js";
import { BAR_STEPS, BPM_DEFAULT, BPM_MAX, BPM_MIN } from "../audio/timing.js";
import { browserStorage, loadState, saveState } from "../storage.js";
import { checkbox, el } from "./dom.js";
import { createEditor } from "./editor.js";

export function mountApp(root, engine, { storage = browserStorage() } = {}) {
  const saved = loadState(storage);
  const state = {
    active: {},
    combine: false,
    bgKick: true,
    effects: { delay: saved.effects?.delay !== false, reverb: saved.effects?.reverb !== false },
  };
  // Only variants that differ from the factory data; that is all that is stored.
  const edits = {};
  for (const [id, data] of Object.entries(saved.variants ?? {})) {
    if (!DEFAULTS[id]) continue;
    edits[id] = sanitize(id, data);
    engine.setData(id, edits[id]);
  }
  engine.setEffects(state.effects);
  const dataOf = (id) => edits[id] ?? DEFAULTS[id].data;
  const persist = () => saveState(storage, { effects: state.effects, variants: edits });

  /* ---- transport ---- */
  const bpm = el("input", {
    type: "range",
    id: "bpm",
    min: String(BPM_MIN),
    max: String(BPM_MAX),
    step: "1",
    value: String(BPM_DEFAULT),
  });
  const bpmOut = el("output", { for: "bpm", class: "bpm-value", text: String(BPM_DEFAULT) });
  const combine = checkbox("combine", "Combinar capas", state.combine);
  const bgKick = checkbox("bgkick", "Kick de fondo", state.bgKick);
  const delay = checkbox("delay", "Delay 3/16", state.effects.delay);
  const reverb = checkbox("reverb", "Reverb", state.effects.reverb);
  const stopBtn = el("button", { type: "button", class: "stop", text: "Parar" });

  /* ---- step bar: 16 cells, one 4/4 bar; the loop is 2 bars ---- */
  const cells = Array.from({ length: BAR_STEPS }, (_, i) =>
    el("div", { class: i % 4 === 0 ? "cell beat" : "cell" }, i % 4 === 0 ? String(i / 4 + 1) : ""),
  );
  const barLabel = el("span", { class: "bar-label", text: "Compás –" });

  /* ---- layer rows ---- */
  const tiles = []; // { layer, variant, node, tile, edit }
  const slots = new Map(); // layer id -> { node, editor, variant }
  const rows = LAYERS.map((layer) => {
    const group = el("div", { class: "variants", role: "group", "aria-label": layer.name });
    for (const variant of layer.variants) {
      const node = el(
        "button",
        { type: "button", class: "variant", "data-variant": variant.id },
        el("span", { class: "variant-label", text: variant.label }),
        el("span", { class: "variant-detail", text: variant.detail }),
      );
      if (!layer.oneShot) node.setAttribute("aria-pressed", "false");
      if (variant.id === BG_KICK_VARIANT) node.title = "Borde punteado: suena como kick de fondo";
      node.addEventListener("click", () => press(layer, variant));
      const edit = el("button", {
        type: "button",
        class: "edit",
        "data-edit": variant.id,
        "aria-expanded": "false",
        "aria-label": `Editar ${variant.label}`,
        title: "Editar",
        text: "▾",
      });
      edit.addEventListener("click", () => toggleEditor(layer, variant));
      const tile = el("div", { class: "tile" }, node, edit);
      group.append(tile);
      tiles.push({ layer, variant, node, tile, edit });
    }
    const slot = el("div", { class: "editor-slot" });
    slots.set(layer.id, { node: slot, editor: null, variant: null });
    return el(
      "section",
      { class: "layer", "data-layer": layer.id },
      el("div", { class: "layer-meta" }, el("h2", { text: layer.name }), el("p", { class: "hint", text: layer.hint })),
      group,
      slot,
    );
  });

  root.replaceChildren(
    el(
      "header",
      { class: "top" },
      el("h1", { text: "Psy Layers" }),
      el("p", {
        class: "lede",
        text:
          "Entrenamiento de oído: escuchá en loop cada capa de un groove de psytrance. " +
          "Un clic reemplaza lo que suena; con «Combinar capas» las vas sumando. " +
          "Cada botón tiene su editor (▾): notas, pasos, sinte y perillas.",
      }),
    ),
    el(
      "div",
      { class: "transport" },
      el("label", { class: "bpm", for: "bpm" }, el("span", { text: "BPM" }), bpm, bpmOut),
      combine.node,
      bgKick.node,
      delay.node,
      reverb.node,
      stopBtn,
    ),
    el("div", { class: "stepbar", "aria-hidden": "true" }, el("div", { class: "cells" }, ...cells), barLabel),
    el("main", { class: "layers" }, ...rows),
  );

  /* ---- rendering ---- */
  let lanes = {};
  const isOn = (layer, variant) => state.active[laneKey(layer, variant.id)] === variant.id;

  function renderButtons(playingFx = new Set()) {
    for (const { layer, variant, node, tile } of tiles) {
      const on = layer.oneShot ? playingFx.has(variant.id) : isOn(layer, variant);
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-background", lanes.bgKick === variant.id);
      tile.classList.toggle("is-edited", variant.id in edits);
      if (!layer.oneShot) node.setAttribute("aria-pressed", String(on));
    }
  }

  let shownStep = null;
  function paintStep(step) {
    for (const slot of slots.values()) slot.editor?.paint(step);
    if (step === shownStep) return;
    if (shownStep !== null) cells[shownStep % BAR_STEPS].classList.remove("is-current");
    if (step !== null) cells[step % BAR_STEPS].classList.add("is-current");
    barLabel.textContent = step === null ? "Compás –" : `Compás ${step < BAR_STEPS ? 1 : 2} de 2`;
    shownStep = step;
  }

  // The bar follows the audio clock, not the timer: each frame asks the engine
  // which scheduled step is audible now. The loop parks itself when idle.
  let frame = 0;
  let fxShown = "";
  function draw() {
    frame = 0;
    paintStep(engine.visibleStep());
    const fx = engine.activeFx();
    const key = [...fx].sort().join();
    if (key !== fxShown) {
      renderButtons(fx);
      fxShown = key;
    }
    if (engine.isRunning() || fx.size > 0) frame = requestAnimationFrame(draw);
  }
  const animate = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  function sync() {
    lanes = desiredLanes(state.active, { bgKick: state.bgKick });
    engine.setLanes(lanes);
    renderButtons(engine.activeFx());
    if (engine.isRunning()) animate();
    else paintStep(null);
  }

  function fire(id) {
    engine.triggerFx(id);
    fxShown = ""; // force a repaint so the button lights up this frame
    animate();
  }

  function press(layer, variant) {
    if (layer.oneShot) {
      fire(variant.id);
      return;
    }
    state.active = pressVariant(state.active, laneKey(layer, variant.id), variant.id, state.combine);
    sync();
  }

  /* ---- editors: one open per layer ---- */
  function closeEditor(layerId) {
    const slot = slots.get(layerId);
    if (!slot.editor) return;
    slot.editor.destroy();
    slot.node.replaceChildren();
    tiles.find((t) => t.variant.id === slot.variant)?.edit.setAttribute("aria-expanded", "false");
    slot.editor = null;
    slot.variant = null;
  }

  function openEditor(layer, variant) {
    closeEditor(layer.id);
    const slot = slots.get(layer.id);
    const id = variant.id;
    const editor = createEditor({
      id,
      label: variant.label,
      data: dataOf(id),
      onChange: (next) => {
        edits[id] = next;
        engine.setData(id, next);
        persist();
        // Editing something silent switches it on: what you edit is what you hear.
        if (!layer.oneShot && !isOn(layer, variant)) press(layer, variant);
        else renderButtons(engine.activeFx());
      },
      onAudition: (note) => {
        // A drum hit off the grid while the loop runs only sounds like a mistake.
        if (layer.oneShot || (DEFAULTS[id].kind === "drum" && engine.isRunning())) return;
        engine.audition(id, note);
      },
      onReset: () => {
        delete edits[id];
        engine.setData(id, defaultData(id));
        persist();
        renderButtons(engine.activeFx());
        openEditor(layer, variant); // rebuild with the factory values
      },
      onClose: () => closeEditor(layer.id),
      onTrigger: () => fire(id),
    });
    slot.editor = editor;
    slot.variant = id;
    slot.node.replaceChildren(editor.node);
    tiles.find((t) => t.variant.id === id).edit.setAttribute("aria-expanded", "true");
    editor.paint(engine.visibleStep());
  }

  function toggleEditor(layer, variant) {
    if (slots.get(layer.id).variant === variant.id) closeEditor(layer.id);
    else openEditor(layer, variant);
  }

  /* ---- controls ---- */
  bpm.addEventListener("input", () => {
    const value = Number(bpm.value);
    bpmOut.textContent = String(value);
    engine.setBpm(value);
  });
  combine.input.addEventListener("change", () => {
    state.combine = combine.input.checked;
  });
  bgKick.input.addEventListener("change", () => {
    state.bgKick = bgKick.input.checked;
    sync();
  });
  for (const [key, box] of [["delay", delay], ["reverb", reverb]]) {
    box.input.addEventListener("change", () => {
      state.effects = { ...state.effects, [key]: box.input.checked };
      engine.setEffects(state.effects);
      persist();
    });
  }
  stopBtn.addEventListener("click", () => {
    state.active = {};
    lanes = {};
    engine.stop();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    fxShown = "";
    renderButtons();
    paintStep(null);
  });

  renderButtons();
  return { state, edits };
}
