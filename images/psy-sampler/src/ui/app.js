// DOM wiring. Holds the workspace (everything remembered, workspace.js) and
// the live selection, renders them, and forwards changes to the engine; all
// timing lives in the engine. Changes that must land on the grid (queued
// clicks, the autopilot, improvise variations) run in the engine's bar hook.
// Switching language, importing a preset, opening a share link and resetting
// everything rebuild the app through remount(), carrying what is playing.
import { layerById } from "../catalog.js";
import { scaleRows } from "../audio/music.js";
import { baseOf, defOf, defaultData, isCopy } from "../audio/patterns.js";
import { BAR_STEPS, BPM_MAX, BPM_MIN } from "../audio/timing.js";
import { encodeWav } from "../audio/wav.js";
import { advance, startPilot } from "../autopilot.js";
import { improvise, seeded, styleOf, varyNotes, varySteps } from "../editing.js";
import { DICTS, LANGS, detectLang, lang, setLang, t } from "../i18n/index.js";
import { BG_KICK_VARIANT, desiredLanes, laneKey, pressVariant } from "../selection.js";
import { hasCustomSounds, hashSeed, randomSeed, readFragment, shareFragment, unpackSounds } from "../share.js";
import { browserStorage, loadState, saveState } from "../storage.js";
import { cleanSeed, copyId, normalize, parsePreset, toPreset } from "../workspace.js";
import { checkbox, download, el, select, slug } from "./dom.js";
import { createEditor } from "./editor.js";
import { sortable } from "./sortable.js";

const sameLanes = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export function mountApp(root, engine, opts = {}) {
  const {
    storage = browserStorage(),
    languages = globalThis.navigator?.languages ?? [],
    location = globalThis.location,
    confirm = (message) => window.confirm(message),
    resume = null,
  } = opts;
  const stored = loadState(storage);
  setLang(resume ? lang() : detectLang(stored.lang, languages));
  document.documentElement.lang = lang();
  const tx = t();

  const { active: _active, ...ws } = resume?.ws ?? normalize(stored);
  if (!ws.seed) ws.seed = randomSeed();
  const state = {
    active: resume?.active ?? {}, // lane key -> variant: what plays
    pending: resume?.pending ?? null, // a queued selection, applied on the next bar line
    auto: resume?.auto ?? false,
    pilot: resume?.pilot ?? null,
    rng: resume?.rng ?? null, // the autopilot's seeded PRNG
    varying: resume?.varying ?? new Map(), // variant -> the part improvise varies around
  };
  let open = null; // the one open editor: { layer, id, editor }
  const persist = () => saveState(storage, { lang: lang(), ...ws });

  const allIds = () => Object.values(ws.lists).flat();
  const dataOf = (id) => ws.variants[id] ?? defOf(id).data;
  const factoryLabel = (id) => tx.variants[baseOf(id)][0];
  const labelOf = (id) => ws.names[id] ?? (isCopy(id) ? tx.tile.copyName(factoryLabel(id)) : factoryLabel(id));
  const detailOf = (id) => (isCopy(id) ? tx.tile.copyDetail(factoryLabel(id)) : tx.variants[id][1]);
  const layerOf = (id) => layerById(id.split(".")[0]);

  for (const id of allIds()) engine.setData(id, dataOf(id));
  for (const [id, anchor] of state.varying) engine.setData(id, varied(id, anchor));
  engine.setEffects(ws.effects);
  engine.setBpm(ws.bpm);

  /* ---- header + transport ---- */
  const language = select(
    tx.tools.language,
    LANGS.map((id) => ({ value: id, label: DICTS[id].langName })),
    lang(),
    (value) => {
      setLang(value);
      persist();
      remount();
    },
    "lang",
  );

  const bpm = el("input", {
    type: "range",
    id: "bpm",
    min: String(BPM_MIN),
    max: String(BPM_MAX),
    step: "1",
    value: String(ws.bpm),
  });
  const bpmOut = el("output", { for: "bpm", class: "bpm-value", text: String(ws.bpm) });
  const combine = checkbox("combine", tx.transport.combine, ws.combine);
  const bgKick = checkbox("bgkick", tx.transport.bgKick, ws.bgKick);
  const quantize = checkbox("quantize", tx.transport.quantize, ws.quantize);
  quantize.node.title = tx.transport.quantizeTitle;
  const delay = checkbox("delay", tx.transport.delay, ws.effects.delay);
  const reverb = checkbox("reverb", tx.transport.reverb, ws.effects.reverb);
  const stopBtn = el("button", { type: "button", class: "stop", text: tx.transport.stop });

  /* ---- autopilot + seed ---- */
  const autoBtn = el("button", {
    type: "button",
    class: "auto",
    "aria-pressed": String(state.auto),
    text: tx.transport.auto,
  });
  autoBtn.title = tx.transport.autoTitle;
  const sectionBadge = el("span", { class: "section-badge", "aria-live": "polite" });
  const seedInput = el("input", {
    type: "text",
    id: "seed",
    class: "seed-input",
    maxlength: "32",
    spellcheck: "false",
    autocomplete: "off",
  });
  seedInput.value = ws.seed;
  const seedLabel = el("label", { class: "seed", for: "seed" }, el("span", { text: tx.share.seed }), seedInput);
  seedLabel.title = tx.share.seedTitle;
  const diceBtn = el("button", { type: "button", class: "ghost icon", "aria-label": tx.share.newSeed, text: "🎲" });
  diceBtn.title = tx.share.newSeed;
  const shareBtn = el("button", { type: "button", class: "ghost", "data-action": "share", text: tx.share.share });
  shareBtn.title = tx.share.shareTitle;

  /* ---- tools ---- */
  const wavBtn = el("button", { type: "button", class: "ghost", "data-action": "wav-mix", text: tx.tools.wav });
  wavBtn.title = tx.tools.wavTitle;
  const exportBtn = el("button", { type: "button", class: "ghost", "data-action": "export", text: tx.tools.exportPreset });
  const importBtn = el("button", { type: "button", class: "ghost", "data-action": "import", text: tx.tools.importPreset });
  const importFile = el("input", { type: "file", accept: ".json,application/json", hidden: "" });
  const resetBtn = el("button", { type: "button", class: "ghost danger", "data-action": "reset-all", text: tx.tools.resetAll });
  const statusLine = el("p", { class: "status", role: "status" });
  const status = (text) => {
    statusLine.textContent = text;
  };

  /* ---- step bar: 16 cells, one 4/4 bar; the loop is 2 bars ---- */
  const cells = Array.from({ length: BAR_STEPS }, (_, i) =>
    el("div", { class: i % 4 === 0 ? "cell beat" : "cell" }, i % 4 === 0 ? String(i / 4 + 1) : ""),
  );
  const barLabel = el("span", { class: "bar-label", text: tx.transport.barIdle });

  /* ---- layer rows, in the user's order ---- */
  const tiles = new Map(); // variant -> { layer, node, tile, edit, labelEl }
  const sections = new Map(); // layer id -> { node, group, slot }
  const sorters = [];

  function makeTile(layer, id) {
    const labelEl = el("span", { class: "variant-label", text: labelOf(id) });
    const node = el(
      "button",
      { type: "button", class: "variant", "data-variant": id },
      labelEl,
      el("span", { class: "variant-detail", text: detailOf(id) }),
    );
    if (!layer.oneShot) node.setAttribute("aria-pressed", "false");
    if (id === BG_KICK_VARIANT) node.title = tx.tile.bgKick;
    node.addEventListener("click", () => press(layer, id));
    const edit = el("button", {
      type: "button",
      class: "edit",
      "data-edit": id,
      "aria-expanded": String(open?.id === id),
      "aria-label": tx.tile.edit(labelOf(id)),
      title: tx.tile.editTitle,
      text: "▾",
    });
    edit.addEventListener("click", () => toggleEditor(layer, id));
    const tile = el("div", { class: isCopy(id) ? "tile is-copy" : "tile", "data-key": id }, node, edit);
    tiles.set(id, { layer, node, tile, edit, labelEl });
    return tile;
  }

  function renderTiles(layer) {
    for (const [id, t] of tiles) if (t.layer === layer) tiles.delete(id);
    sections.get(layer.id).group.replaceChildren(...ws.lists[layer.id].map((id) => makeTile(layer, id)));
  }

  for (const layerId of ws.order) {
    const layer = layerById(layerId);
    const text = tx.layers[layer.id];
    const group = el("div", { class: "variants", role: "group", "aria-label": text.name });
    const slot = el("div", { class: "editor-slot" });
    const grip = el("button", {
      type: "button",
      class: "grip",
      "aria-label": tx.tile.moveLayer(text.name),
      title: tx.tile.moveHint,
      text: "⠿",
    });
    const node = el(
      "section",
      { class: "layer", "data-layer": layer.id },
      el(
        "div",
        { class: "layer-meta" },
        el("div", { class: "layer-title" }, grip, el("h2", { text: text.name })),
        el("p", { class: "hint", text: text.hint }),
      ),
      group,
      slot,
    );
    sections.set(layer.id, { node, group, slot });
    renderTiles(layer);
    sorters.push(
      sortable(group, {
        item: ".tile",
        key: "key",
        onDrop: (ids) => {
          ws.lists[layer.id] = ids;
          persist();
        },
      }),
    );
  }
  const layersMain = el("main", { class: "layers" }, ...ws.order.map((id) => sections.get(id).node));
  sorters.push(
    sortable(layersMain, {
      item: ".layer",
      handle: ".grip",
      key: "layer",
      onDrop: (ids) => {
        ws.order = ids;
        persist();
      },
    }),
  );

  root.replaceChildren(
    el(
      "header",
      { class: "top" },
      el("div", { class: "title-row" }, el("h1", { text: "Psy Layers" }), language),
      el("p", { class: "lede", text: tx.lede }),
    ),
    el(
      "div",
      { class: "transport panel" },
      el("label", { class: "bpm", for: "bpm" }, el("span", { text: tx.transport.bpm }), bpm, bpmOut),
      combine.node,
      bgKick.node,
      quantize.node,
      delay.node,
      reverb.node,
      stopBtn,
    ),
    el(
      "div",
      { class: "tools panel" },
      el("div", { class: "tools-row" }, autoBtn, sectionBadge, seedLabel, diceBtn, shareBtn),
      el("div", { class: "tools-row" }, wavBtn, exportBtn, importBtn, importFile, resetBtn),
      statusLine,
    ),
    el("div", { class: "stepbar", "aria-hidden": "true" }, el("div", { class: "cells" }, ...cells), barLabel),
    layersMain,
  );

  /* ---- rendering ---- */
  let lanes = {};
  const laneMap = () => desiredLanes(state.active, { bgKick: ws.bgKick && !state.auto });

  function renderButtons(playingFx = engine.activeFx()) {
    const target = state.pending ?? state.active;
    for (const [id, { layer, node, tile }] of tiles) {
      const key = laneKey(layer, id);
      const on = layer.oneShot ? playingFx.has(id) : state.active[key] === id;
      const next = !layer.oneShot && target[key] === id;
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-queued", Boolean(state.pending) && next && !on);
      node.classList.toggle("is-leaving", Boolean(state.pending) && on && !next);
      node.classList.toggle("is-background", lanes.bgKick === id);
      tile.classList.toggle("is-edited", id in ws.variants && !isCopy(id));
      tile.classList.toggle("is-varying", state.varying.has(id));
      if (!layer.oneShot) node.setAttribute("aria-pressed", String(on));
    }
  }

  function showSection() {
    autoBtn.setAttribute("aria-pressed", String(state.auto));
    sectionBadge.textContent = state.auto && state.pilot ? tx.sections[state.pilot.section] : "";
    sectionBadge.hidden = !state.auto;
  }

  let shownStep = null;
  function paintStep(step) {
    open?.editor.paint(step);
    if (step === shownStep) return;
    if (shownStep !== null) cells[shownStep % BAR_STEPS].classList.remove("is-current");
    if (step !== null) cells[step % BAR_STEPS].classList.add("is-current");
    barLabel.textContent = step === null ? tx.transport.barIdle : tx.transport.bar(step < BAR_STEPS ? 1 : 2);
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
    lanes = laneMap();
    engine.setLanes(lanes);
    renderButtons();
    if (engine.isRunning()) animate();
    else paintStep(null);
  }

  function fire(id, at) {
    engine.triggerFx(id, at);
    fxShown = ""; // force a repaint so the button lights up this frame
    animate();
  }

  // A new selection: on the next bar line when "On the beat" is on and the
  // loop runs, right away otherwise.
  function commit(next) {
    if (ws.quantize && engine.isRunning()) {
      state.pending = sameLanes(next, state.active) ? null : next;
      renderButtons();
      return;
    }
    state.pending = null;
    state.active = next;
    sync();
  }

  function press(layer, id) {
    if (layer.oneShot) {
      fire(id);
      return;
    }
    commit(pressVariant(state.pending ?? state.active, laneKey(layer, id), id, ws.combine));
  }

  /* ---- the bar hook: everything that must land on the grid ---- */
  engine.onBar((time, step, bar) => {
    const loopStart = step === 0 && bar > 0;
    if (loopStart) varyAll();
    let changed = false;
    if (state.pending) {
      state.active = state.pending;
      state.pending = null;
      changed = true;
    } else if (state.auto && loopStart) {
      const move = advance(state.pilot, state.active, ws.lists, state.rng);
      state.pilot = move.pilot;
      for (const id of move.rewrite) rewrite(id);
      for (const id of move.fx) fire(id, time);
      state.active = move.active;
      showSection();
      changed = true;
    }
    if (!changed) return undefined;
    lanes = laneMap();
    renderButtons();
    return lanes;
  });

  /* ---- variant data ---- */
  function setVariant(id, data, { generated = false } = {}) {
    ws.variants[id] = data;
    ws.auto = ws.auto.filter((x) => x !== id);
    if (generated) ws.auto.push(id);
    if (state.varying.has(id)) state.varying.set(id, data);
    engine.setData(id, state.varying.has(id) ? varied(id, data) : data);
    persist();
    renderButtons();
  }

  // The autopilot writes a new part, unless the user owns this one. The rng
  // runs either way, so a seed plays the same whatever was edited locally.
  function rewrite(id) {
    const def = defOf(id);
    if (def.kind !== "notes") return;
    const data = dataOf(id);
    const notes = improvise(styleOf(id), scaleRows(data.scale, def.low, def.high), state.rng);
    if (id in ws.variants && !ws.auto.includes(id)) return;
    setVariant(id, { ...data, notes }, { generated: true });
    if (open?.id === id) open.editor.show(dataOf(id));
  }

  // Improvise toggle: a fresh variation of the anchor on every loop.
  function varied(id, anchor) {
    const def = defOf(id);
    if (def.kind === "drum") return { ...anchor, steps: varySteps(anchor.steps) };
    return { ...anchor, notes: varyNotes(anchor.notes, scaleRows(anchor.scale, def.low, def.high)) };
  }

  function varyAll() {
    for (const [id, anchor] of state.varying) {
      const next = varied(id, anchor);
      engine.setData(id, next);
      if (open?.id === id) open.editor.show(next);
    }
  }

  function setVarying(id, on) {
    if (on) {
      state.varying.set(id, dataOf(id));
      // The first variation waits for the next loop: nothing jumps on click.
    } else {
      state.varying.delete(id);
      engine.setData(id, dataOf(id));
      if (open?.id === id) open.editor.show(dataOf(id));
    }
    renderButtons();
  }

  /* ---- editors: one open at a time ---- */
  function closeEditor() {
    if (!open) return;
    open.editor.destroy();
    sections.get(open.layer.id).slot.replaceChildren();
    tiles.get(open.id)?.edit.setAttribute("aria-expanded", "false");
    open = null;
  }

  function openEditor(layer, id, { focusName = false } = {}) {
    closeEditor();
    const editor = createEditor({
      id,
      label: labelOf(id),
      data: dataOf(id),
      varying: state.varying.has(id),
      onChange: (next) => {
        setVariant(id, next);
        // Editing something silent switches it on: what you edit is what you hear.
        const target = state.pending ?? state.active;
        if (!layer.oneShot && target[laneKey(layer, id)] !== id) press(layer, id);
      },
      onAudition: (note) => {
        // A drum hit off the grid while the loop runs only sounds like a mistake.
        if (layer.oneShot || (defOf(id).kind === "drum" && engine.isRunning())) return;
        engine.audition(id, note);
      },
      onReset: () => {
        if (isCopy(id)) ws.variants[id] = defaultData(id);
        else delete ws.variants[id];
        ws.auto = ws.auto.filter((x) => x !== id);
        if (state.varying.has(id)) state.varying.set(id, dataOf(id));
        engine.setData(id, dataOf(id));
        persist();
        renderButtons();
        openEditor(layer, id); // rebuild with the factory values
      },
      onClose: closeEditor,
      onTrigger: () => fire(id),
      onRename: (name) => rename(id, name),
      onDuplicate: () => duplicate(layer, id),
      onRemove: () => remove(layer, id),
      onWav: () => exportWav({ layer, id }),
      onVary: (on) => setVarying(id, on),
    });
    open = { layer, id, editor };
    sections.get(layer.id).slot.replaceChildren(editor.node);
    tiles.get(id).edit.setAttribute("aria-expanded", "true");
    editor.paint(engine.visibleStep());
    editor.node.scrollIntoView?.({ block: "nearest" });
    if (focusName) editor.focusName();
  }

  function toggleEditor(layer, id) {
    if (open?.id === id) closeEditor();
    else openEditor(layer, id);
  }

  // Returns the name now shown: an emptied name falls back to the default.
  function rename(id, name) {
    const clean = name.trim().slice(0, 40);
    if (clean) ws.names[id] = clean;
    else delete ws.names[id];
    const label = labelOf(id);
    const tile = tiles.get(id);
    tile.labelEl.textContent = label;
    tile.edit.setAttribute("aria-label", tx.tile.edit(label));
    persist();
    return label;
  }

  function duplicate(layer, id) {
    const copy = copyId(id, allIds());
    const list = ws.lists[layer.id];
    const at = list.indexOf(id) + 1;
    ws.lists[layer.id] = [...list.slice(0, at), copy, ...list.slice(at)];
    ws.variants[copy] = structuredClone(dataOf(id));
    ws.names[copy] = tx.tile.copyName(labelOf(id));
    engine.setData(copy, ws.variants[copy]);
    persist();
    closeEditor();
    renderTiles(layer);
    renderButtons();
    openEditor(layer, copy, { focusName: true });
  }

  function remove(layer, id) {
    if (!confirm(tx.editor.confirmRemove(labelOf(id)))) return;
    closeEditor();
    ws.lists[layer.id] = ws.lists[layer.id].filter((x) => x !== id);
    delete ws.variants[id];
    delete ws.names[id];
    ws.auto = ws.auto.filter((x) => x !== id);
    state.varying.delete(id);
    const without = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== id));
    if (state.pending) state.pending = without(state.pending);
    state.active = without(state.active);
    if (state.pending && sameLanes(state.pending, state.active)) state.pending = null;
    persist();
    renderTiles(layer);
    sync();
  }

  /* ---- export: WAV, preset ---- */
  async function exportWav(what) {
    let job;
    let name;
    if (what) {
      const { layer, id } = what;
      job = layer.oneShot ? { fx: id } : { lanes: { [laneKey(layer, id)]: id } };
      name = `${slug(labelOf(id))}-${ws.bpm}bpm.wav`;
    } else {
      if (!Object.keys(lanes).length) {
        status(tx.tools.nothingPlaying);
        return;
      }
      job = { lanes };
      name = `psy-layers-${ws.bpm}bpm.wav`;
    }
    status(tx.tools.rendering);
    try {
      const audio = await engine.render(job);
      download(name, encodeWav(audio), "audio/wav");
      status(tx.tools.rendered(name));
    } catch {
      status(tx.tools.renderFailed);
    }
  }

  /* ---- remount: language, import, share links, reset ---- */
  function destroy() {
    closeEditor();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    engine.onBar(null);
    sorters.forEach((s) => s.destroy());
    window.removeEventListener("hashchange", onHash);
  }

  function remount(changes = {}) {
    const { pending, active, auto, pilot, rng, varying } = state;
    const next = { ws, pending, active, auto, pilot, rng, varying, open: open?.id, ...changes };
    destroy();
    return mountApp(root, engine, { ...opts, resume: next });
  }

  async function loadShared({ seed, bpm: sharedBpm, sounds }) {
    history.replaceState(null, "", location.pathname + location.search);
    let next = { ...ws, seed, bpm: sharedBpm ?? ws.bpm };
    if (sounds) {
      try {
        const shared = await unpackSounds(sounds);
        if (!hasCustomSounds(ws) || confirm(tx.share.confirmSounds)) next = { ...next, ...shared };
      } catch {
        status(tx.share.badLink);
        return;
      }
    }
    state.auto = false;
    state.varying = new Map();
    remount({ ws: normalize(next), status: tx.share.loaded(seed), open: null });
  }

  const onHash = () => {
    const shared = readFragment(location?.hash);
    if (shared) loadShared(shared);
  };

  function engageAuto() {
    // Parts the autopilot wrote go back to factory, so a seed always replays
    // the same track.
    for (const id of ws.auto) {
      if (isCopy(id)) ws.variants[id] = defaultData(id);
      else delete ws.variants[id];
      engine.setData(id, dataOf(id));
    }
    ws.auto = [];
    persist();
    state.auto = true;
    state.rng = seeded(hashSeed(ws.seed));
    const start = startPilot(ws.lists, state.rng);
    state.pilot = start.pilot;
    commit(start.active);
    showSection();
  }

  function setSeed(value) {
    ws.seed = cleanSeed(value) || randomSeed();
    seedInput.value = ws.seed;
    persist();
    if (state.auto) engageAuto();
  }

  /* ---- controls ---- */
  bpm.addEventListener("input", () => {
    ws.bpm = Number(bpm.value);
    bpmOut.textContent = String(ws.bpm);
    engine.setBpm(ws.bpm);
    persist();
  });
  for (const [key, box] of [
    ["combine", combine],
    ["bgKick", bgKick],
    ["quantize", quantize],
  ]) {
    box.input.addEventListener("change", () => {
      ws[key] = box.input.checked;
      persist();
      if (key === "bgKick") sync();
    });
  }
  for (const [key, box] of [
    ["delay", delay],
    ["reverb", reverb],
  ]) {
    box.input.addEventListener("change", () => {
      ws.effects = { ...ws.effects, [key]: box.input.checked };
      engine.setEffects(ws.effects);
      persist();
    });
  }
  stopBtn.addEventListener("click", () => {
    state.active = {};
    state.pending = null;
    state.auto = false;
    state.pilot = null;
    lanes = {};
    engine.stop();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    fxShown = "";
    renderButtons(new Set());
    paintStep(null);
    showSection();
  });
  autoBtn.addEventListener("click", () => {
    if (!state.auto) {
      engageAuto();
      return;
    }
    state.auto = false;
    state.pilot = null;
    sync(); // the background kick may come back
    showSection();
  });
  seedInput.addEventListener("change", () => setSeed(seedInput.value));
  diceBtn.addEventListener("click", () => setSeed(randomSeed()));
  shareBtn.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}${await shareFragment(ws)}`;
    try {
      await navigator.clipboard.writeText(url);
      status(tx.share.copied);
    } catch {
      status(tx.share.manual(url));
    }
  });
  wavBtn.addEventListener("click", () => exportWav(null));
  exportBtn.addEventListener("click", () => {
    const preset = toPreset({ ...ws, active: state.pending ?? state.active });
    download("psy-layers-preset.json", JSON.stringify(preset, null, 2), "application/json");
  });
  importBtn.addEventListener("click", () => {
    engine.ensureContext(); // inside the click: the imported mix may start playing
    importFile.click();
  });
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = "";
    if (!file) return;
    let preset;
    try {
      preset = parsePreset(await file.text());
    } catch {
      status(tx.tools.importFailed);
      return;
    }
    state.auto = false;
    state.varying = new Map();
    remount({ ws: preset, active: preset.active, pending: null, open: null, status: tx.tools.imported });
  });
  resetBtn.addEventListener("click", () => {
    if (!confirm(tx.tools.confirmReset)) return;
    engine.stop();
    remount({
      ws: normalize({}),
      active: {},
      pending: null,
      auto: false,
      pilot: null,
      varying: new Map(),
      open: null,
    });
  });
  window.addEventListener("hashchange", onHash);

  /* ---- first paint ---- */
  showSection();
  if (resume) {
    persist();
    sync();
    if (resume.open && tiles.has(resume.open)) openEditor(layerOf(resume.open), resume.open);
    if (resume.status) status(resume.status);
  } else {
    if (!stored.seed) persist();
    renderButtons(new Set());
    onHash();
  }
  return { ws, state, destroy };
}
