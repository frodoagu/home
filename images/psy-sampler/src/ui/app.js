// DOM wiring. Holds the selection state, renders it, and forwards changes to
// the engine; all timing lives in the engine.
import { LAYERS } from "../catalog.js";
import { BG_KICK_VARIANT, desiredLanes, pressVariant } from "../selection.js";
import { BAR_STEPS, BPM_DEFAULT, BPM_MAX, BPM_MIN } from "../audio/timing.js";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function checkbox(id, label, checked) {
  const input = el("input", { type: "checkbox", id });
  input.checked = checked;
  return { input, node: el("label", { class: "check", for: id }, input, el("span", { text: label })) };
}

export function mountApp(root, engine) {
  const state = { active: {}, combine: false, bgKick: true };

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
  const stopBtn = el("button", { type: "button", class: "stop", text: "Parar" });

  /* ---- step bar: 16 cells, one 4/4 bar; the loop is 2 bars ---- */
  const cells = Array.from({ length: BAR_STEPS }, (_, i) =>
    el("div", { class: i % 4 === 0 ? "cell beat" : "cell" }, i % 4 === 0 ? String(i / 4 + 1) : ""),
  );
  const barLabel = el("span", { class: "bar-label", text: "Compás –" });

  /* ---- layer rows ---- */
  const buttons = []; // { layer, variant, node }
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
      group.append(node);
      buttons.push({ layer, variant, node });
    }
    return el(
      "section",
      { class: "layer", "data-layer": layer.id },
      el("div", { class: "layer-meta" }, el("h2", { text: layer.name }), el("p", { class: "hint", text: layer.hint })),
      group,
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
          "Un clic reemplaza lo que suena; con «Combinar capas» las vas sumando.",
      }),
    ),
    el(
      "div",
      { class: "transport" },
      el("label", { class: "bpm", for: "bpm" }, el("span", { text: "BPM" }), bpm, bpmOut),
      combine.node,
      bgKick.node,
      stopBtn,
    ),
    el("div", { class: "stepbar", "aria-hidden": "true" }, el("div", { class: "cells" }, ...cells), barLabel),
    el("main", { class: "layers" }, ...rows),
  );

  /* ---- rendering ---- */
  let lanes = {};

  function renderButtons(playingFx = new Set()) {
    for (const { layer, variant, node } of buttons) {
      const on = layer.oneShot ? playingFx.has(variant.id) : state.active[layer.id] === variant.id;
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-background", lanes.bgKick === variant.id);
      if (!layer.oneShot) node.setAttribute("aria-pressed", String(on));
    }
  }

  let shownStep = null;
  function paintStep(step) {
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

  function press(layer, variant) {
    if (layer.oneShot) {
      engine.triggerFx(variant.id);
      fxShown = ""; // force a repaint so the button lights up this frame
      animate();
      return;
    }
    state.active = pressVariant(state.active, layer.id, variant.id, state.combine);
    sync();
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

  return { state };
}
