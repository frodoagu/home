// DOM wiring. Holds the workspace (everything remembered, workspace.js) and
// the live selection, renders them, and forwards changes to the engine; all
// timing lives in the engine. Changes that must land on the grid (queued
// clicks, the autopilot, improvise variations) run in the engine's bar hook.
// Snapshots recall a saved mix (and the data it played) on the next bar line;
// a BPM change ramps there too, one slice per bar. The autopilot dresses each
// sound it brings in from the seed (dress.js) and writes new melodies.
// Switching language, importing a preset, opening a share link and resetting
// everything rebuild the app through remount(), carrying what is playing.
// The signed-in user's samples (samples.js) load as the sounds using them
// need them; until then those sounds play their own voice. The record button
// drives recorder.js, which outlives remounts like the engine.
import { SAMPLE_TEMPLATES, layerById } from "../catalog.js";
import { scaleRows } from "../audio/music.js";
import { baseOf, defOf, defaultData, eventsAt, isCopy, sampleDefaults } from "../audio/patterns.js";
import { BAR_STEPS, BPM_MAX, BPM_MIN, LOOP_STEPS, stepDuration } from "../audio/timing.js";
import { LEVEL } from "../audio/params.js";
import { MAX_SECONDS, createRecorder } from "../audio/recorder.js";
import { encodeWav } from "../audio/wav.js";
import {
  CHANGE_BARS,
  SECTION_IDS,
  STYLES,
  STYLE_IDS,
  advance,
  dequeue,
  enqueue,
  entering,
  fillMelodic,
  guessSection,
  isBare,
  joinPilot,
  mixOf,
  moveTo,
  rearrange,
  skip,
  startPilot,
} from "../autopilot.js";
import { dress } from "../dress.js";
import {
  IMPROV_DEFAULT,
  doubleSteps,
  euclidSteps,
  improvise,
  newPart,
  reversePart,
  seeded,
  styleOf,
  varyNotes,
  varySteps,
  withBuildUp,
} from "../editing.js";
import { DICTS, LANGS, detectLang, lang, setLang, t } from "../i18n/index.js";
import { langSwitch } from "./langSwitch.js";
import { BG_KICK_VARIANT, desiredLanes, isOn, laneKey, pressVariant } from "../selection.js";
import { hasCustomSounds, hashSeed, randomSeed, readFragment, shareFragment, unpackSounds } from "../share.js";
import { SNAP_MAX, capture, freshName, nextSnapId, partsOf, removePart } from "../snapshots.js";
import { browserStorage, loadState, saveState } from "../storage.js";
import { RAMP_BARS, addTap, clampBpm, rampAt, tapBpm } from "../tempo.js";
import {
  SNAP_PANEL,
  cleanSeed,
  copyId,
  importSnapshots,
  normalize,
  parsePreset,
  toPreset,
  toSnapshotFile,
} from "../workspace.js";
import { djCutoffs } from "../audio/insert.js";
import { amountSlider, checkbox, download, el, select, slider, slug } from "./dom.js";
import { mountAccount } from "./account.js";
import { BRUSH, EUCLID, createEditor } from "./editor.js";
import { createHelp } from "./help.js";
import { mountSamplesPanel } from "./samplesPanel.js";
import { createSnapshotEditor } from "./snapshotEditor.js";
import { sortable } from "./sortable.js";

const REPO = "https://github.com/frodoagu/home/tree/main/images/psy-sampler";

// Drag on a tile's 🔀 over the whole improvise range: the button is small.
const TILE_SLIDE_PX = 120;

const sameLanes = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
// 2026-10-09-2130, local time: takes sort by when they were made.
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// Everything tied to the old workspace, dropped when another one replaces it.
const fresh = () => ({ tempo: null, ramp: null, drafts: new Map(), applied: null, queuedSnap: null, armed: false });

export function mountApp(root, engine, opts = {}) {
  const {
    storage = browserStorage(),
    languages = globalThis.navigator?.languages ?? [],
    location = globalThis.location,
    confirm = (message) => window.confirm(message),
    cloud = null, // cloud.js; survives remounts, like the engine
    samples = null, // samples.js; same
    stats = null, // stats.js; same
    mediaKeys = null, // mediaKeys.js; same
    recorder = createRecorder(engine),
    loadButton, // tests stand in for the Google sign-in script
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
    pending: resume?.pending ?? null, // a queued selection, applied on the next bar line (or on ▶ when armed)
    armed: resume?.armed ?? false, // stopped, queuing clicks for ▶ to start together
    auto: resume?.auto ?? false,
    pilot: resume?.pilot ?? null,
    rng: resume?.rng ?? null, // the autopilot's seeded PRNG
    varying: resume?.varying ?? new Map(), // variant -> the part improvise varies around
    buildUp: null, // { id, from }: a kick build-up, armed (from null) or playing the bar at `from`
    queuedSnap: resume?.queuedSnap ?? null, // a snapshot entering with `pending` on the next bar line
    applied: resume?.applied ?? null, // the snapshot last recalled: lit while its mix plays
    drafts: resume?.drafts ?? new Map(), // snapshot id -> its unsaved edits
    tempo: resume?.tempo ?? ws.bpm, // the exact BPM (a ramp passes fractions); ws.bpm keeps it rounded
    ramp: resume?.ramp ?? null, // { from, to, bars, done }: a BPM change on its way
    bare: 0, // bar lines in a row the autopilot's mix had no lead and no pad
    newParts: new Set(), // variants whose 🎲 New part waits for the next loop
    queued: new Map(), // variant -> editor actions (×2, the resets) waiting for the next bar line
    dj: resume?.dj ?? 0, // the DJ filter knob: a performance control, never stored
    brush: resume?.brush ?? { ...BRUSH }, // what a click on an editor's grid paints, shared by every editor
    euclid: resume?.euclid ?? { ...EUCLID }, // the drum editors' euclid(k, n, rot), shared like the brush
  };
  let open = null; // the one open editor: { layer, id, editor }
  const veil = el("div", { class: "editor-veil", hidden: "" }); // dims the page around the open editor
  const snapshot = () => ({ lang: lang(), ...ws });
  const persist = () => {
    const snap = snapshot();
    saveState(storage, snap);
    cloud?.changed(snap);
  };

  const allIds = () => Object.values(ws.lists).flat();
  const dataOf = (id) => ws.variants[id] ?? defOf(id).data;
  const factoryLabel = (id) => tx.variants[baseOf(id)][0];
  const labelOf = (id) => ws.names[id] ?? (isCopy(id) ? tx.tile.copyName(factoryLabel(id)) : factoryLabel(id));
  const detailOf = (id) => (isCopy(id) ? tx.tile.copyDetail(factoryLabel(id)) : tx.variants[id][1]);
  const layerOf = (id) => layerById(id.split(".")[0]);
  const snapById = (id) => ws.snapshots.find((s) => s.id === id);
  const improvOf = (id) => ws.improv[id] ?? IMPROV_DEFAULT;
  const owned = (id) => id in ws.variants && !ws.auto.includes(id);

  // What each variant plays apart from a build-up, which feed() lays on top.
  const fed = new Map();
  function feed(id, data, glide) {
    fed.set(id, data);
    const b = state.buildUp;
    const live = b?.id === id && b.from !== null ? withBuildUp(data, b.from) : data;
    engine.setData(id, live, glide);
  }
  const dataNow = (id) => fed.get(id) ?? dataOf(id);

  for (const id of allIds()) feed(id, dataOf(id));
  for (const [id, anchor] of state.varying) feed(id, varied(id, anchor));
  engine.setEffects(ws.effects);
  for (const [id, v] of Object.entries(ws.volumes)) engine.setLayerVolume(id, v);
  engine.setBpm(state.tempo);

  /* ---- header + transport ---- */
  const language = langSwitch(
    tx.tools.language,
    LANGS.map((id) => ({ id, name: DICTS[id].langName })),
    lang(),
    (value) => {
      setLang(value);
      persist();
      remount();
    },
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
  const tapBtn = el("button", { type: "button", class: "ghost tap", "data-action": "tap", text: tx.transport.tap });
  tapBtn.title = tx.transport.tapTitle;
  const bgKick = checkbox("bgkick", tx.transport.bgKick, ws.bgKick);
  const quantize = checkbox("quantize", tx.transport.quantize, ws.quantize);
  quantize.node.title = tx.transport.quantizeTitle;
  const djInput = el("input", { type: "range", id: "dj", min: "-1", max: "1", step: "0.02", value: String(state.dj) });
  const djOut = el("output", { for: "dj", class: "dj-value" });
  const djBox = el("label", { class: "dj", for: "dj" }, el("span", { text: tx.transport.djFilter }), djInput, djOut);
  djBox.title = tx.transport.djTitle;
  const delay = checkbox("delay", tx.transport.delay, ws.effects.delay);
  const reverb = checkbox("reverb", tx.transport.reverb, ws.effects.reverb);
  const stopBtn = el("button", { type: "button", class: "stop", text: tx.transport.stop });
  const cueBtn = el("button", { type: "button", class: "cue", "data-action": "cue" });
  const snapBtn = el("button", { type: "button", class: "snap-btn", "data-action": "snapshot", text: tx.transport.snapshot });
  snapBtn.title = tx.transport.snapshotTitle;
  const recBtn = el("button", { type: "button", class: "rec", "data-action": "record" });

  /* ---- BPM change: a ramp, bar by bar ---- */
  const rampTo = el("input", {
    type: "number",
    id: "ramp-to",
    class: "ramp-input",
    min: String(BPM_MIN),
    max: String(BPM_MAX),
    step: "1",
    inputmode: "numeric",
  });
  rampTo.value = String(state.ramp?.to ?? ws.bpm);
  const rampBars = select(
    tx.tempo.over,
    RAMP_BARS.map((n) => ({ value: n, label: tx.bars(n) })),
    ws.rampBars,
    (value) => {
      ws.rampBars = Number(value);
      persist();
    },
    "ramp-bars",
  );
  const rampBtn = el("button", { type: "button", class: "ghost", "data-action": "ramp" });
  rampBtn.title = tx.tempo.title;
  const rampBox = el(
    "div",
    { class: "ramp" },
    el("label", { class: "pick", for: "ramp-to" }, el("span", { text: tx.tempo.label }), rampTo),
    rampBars,
    rampBtn,
  );

  /* ---- autopilot + seed ---- */
  const autoBtn = el("button", {
    type: "button",
    class: "auto",
    "aria-pressed": String(state.auto),
    text: tx.transport.auto,
  });
  autoBtn.title = tx.transport.autoTitle;
  const sectionBadge = el("span", { class: "section-badge", "aria-live": "polite" });
  const sectionLeft = el("span", { class: "section-left" });
  const queueList = el("ol", { class: "section-queue", "aria-label": tx.pilot.queue });
  const nextBtn = el("button", { type: "button", class: "ghost", "data-action": "next-section", text: tx.pilot.next });
  nextBtn.title = tx.pilot.nextTitle;
  const phaseBtns = SECTION_IDS.map((id) => {
    const b = el("button", { type: "button", class: "ghost phase", "data-section": id, text: tx.sections[id] });
    b.title = tx.pilot.phasesTitle;
    b.addEventListener("click", () => forceSection(id));
    return b;
  });
  const style = select(
    tx.pilot.style,
    STYLE_IDS.map((id) => ({ value: id, label: tx.styles[id] })),
    ws.style,
    (value) => setStyle(value),
    "style",
  );
  style.title = tx.pilot.styleTitle;
  const changes = el("input", {
    type: "range",
    id: "changes",
    min: "0",
    max: String(CHANGE_BARS.length - 1),
    step: "1",
    value: String(CHANGE_BARS.indexOf(ws.changeBars)),
  });
  const changesOut = el("output", { for: "changes", text: tx.pilot.every(ws.changeBars) });
  const changesBox = el("label", { class: "changes", for: "changes" }, el("span", { text: tx.pilot.changes }), changes, changesOut);
  changesBox.title = tx.pilot.changesTitle;
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
  const resetBtn = el("button", { type: "button", class: "ghost danger", "data-action": "reset", text: tx.tools.resetSounds });
  const factoryCheck = checkbox("factory-reset", tx.tools.factory, false);
  factoryCheck.node.title = tx.tools.factoryTitle;
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
    const detailEl = el("span", { class: "variant-detail", text: detailOf(id) });
    const node = el("button", { type: "button", class: layer.oneShot ? "variant" : "variant has-level", "data-variant": id }, labelEl, detailEl);
    if (!layer.oneShot) node.setAttribute("aria-pressed", "false");
    // Playing, its fill is the sound's volume: a drag across it (or ← →)
    // sets it, 0-150 % over the tile's width. Ctrl (⌘) on a click stacks
    // another kick or bass instead of replacing the one playing.
    amountSlider(node, {
      steps: Math.round(LEVEL.max / LEVEL.step),
      sliding: () => !layer.oneShot && isOn(state.active, id),
      get: () => dataOf(id).level / LEVEL.max,
      set: (v) => setLevel(id, Math.round(v * LEVEL.max * 100) / 100),
      at: (e) => {
        const r = node.getBoundingClientRect();
        return (e.clientX - r.left) / r.width;
      },
      onClick: (e) => press(layer, id, e.detail, e.ctrlKey || e.metaKey),
      onSlide: (on) => {
        node.classList.toggle("is-sliding", on);
        detailEl.textContent = on ? tx.tile.level(LEVEL.fmt(dataOf(id).level)) : detailOf(id);
      },
    });
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
    let vary = null;
    if (!layer.oneShot) {
      vary = el("button", {
        type: "button",
        class: "vary-tile",
        "data-vary": id,
        "aria-pressed": String(state.varying.has(id)),
        "aria-label": tx.tile.vary(labelOf(id)),
        title: tx.tile.varyTitle,
        text: "🔀",
      });
      // Up and down it sets how much it varies, like the editor's ← →; while
      // it slides it shows the amount instead of 🔀.
      const shown = (v) => (vary.textContent = String(Math.round(v * 100)));
      amountSlider(vary, {
        axis: "y",
        get: () => improvOf(id),
        set: (v) => {
          setImprov(id, v);
          if (vary.classList.contains("is-sliding")) shown(v);
        },
        at: (e, start) => start.amount + (start.at - e.clientY) / TILE_SLIDE_PX,
        onClick: () => setVarying(id, !state.varying.has(id)),
        onSlide: (on) => {
          vary.classList.toggle("is-sliding", on);
          if (on) shown(improvOf(id));
          else vary.textContent = "🔀";
        },
      });
    }
    const solo = layer.oneShot ? null : soloButton(id);
    const levelBar = layer.oneShot ? null : levelSlider(id, node, detailEl);
    const side = vary ? el("div", { class: "tile-side" }, vary, solo, edit) : edit;
    const tile = el("div", { class: isCopy(id) ? "tile is-copy" : "tile", "data-key": id }, node, ...(levelBar ? [levelBar] : []), side);
    tiles.set(id, { layer, node, tile, edit, vary, solo, levelBar, labelEl, detailEl });
    return tile;
  }

  // A sound that is not playing shows its volume as a thin bar along its
  // bottom edge, set by a drag or a click on it (or ← →), so it can enter at
  // the right level. The tile itself still drags to reorder; once it plays,
  // its fill takes over.
  function levelSlider(id, node, detailEl) {
    const bar = el("div", {
      class: "level-bar",
      role: "slider",
      tabindex: "0",
      "data-level": id,
      "aria-label": tx.tile.levelBar(labelOf(id)),
      "aria-valuemin": "0",
      "aria-valuemax": String(Math.round(LEVEL.max * 100)),
      title: tx.tile.levelBarTitle,
    });
    const at = (e) => {
      const r = bar.getBoundingClientRect();
      return (e.clientX - r.left) / r.width;
    };
    const put = (v) => setLevel(id, Math.round(Math.min(1, Math.max(0, v)) * LEVEL.max * 100) / 100);
    amountSlider(bar, {
      steps: Math.round(LEVEL.max / LEVEL.step),
      get: () => dataOf(id).level / LEVEL.max,
      set: (v) => setLevel(id, Math.round(v * LEVEL.max * 100) / 100),
      at,
      onClick: (e) => {
        const v = at(e);
        if (e.detail && Number.isFinite(v)) put(v); // a pointer click, not Enter
      },
      onSlide: (on) => {
        node.classList.toggle("is-sliding", on);
        detailEl.textContent = on ? tx.tile.level(LEVEL.fmt(dataOf(id).level)) : detailOf(id);
      },
    });
    return bar;
  }

  // 🎧: while held (pointer, Space or Enter) only this sound is heard; the
  // rest keep playing silent underneath. It does nothing on a sound that is
  // not playing, which would only leave silence.
  let soloing = null;
  function soloButton(id) {
    const b = el("button", {
      type: "button",
      class: "solo-tile",
      "data-solo": id,
      "aria-label": tx.tile.solo(labelOf(id)),
      title: tx.tile.soloTitle,
      text: "🎧",
    });
    const hold = () => {
      if (soloing || !(isOn(state.active, id) || lanes.bgKick === id)) return false;
      soloing = id;
      engine.setSolo(id);
      b.classList.add("is-held");
      tiles.get(id).tile.classList.add("is-solo");
      layersMain.classList.add("is-soloing");
      return true;
    };
    const letGo = () => {
      if (soloing !== id) return;
      soloing = null;
      engine.setSolo(null);
      b.classList.remove("is-held");
      tiles.get(id)?.tile.classList.remove("is-solo");
      layersMain.classList.remove("is-soloing");
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // the pointer is the solo's, not a reorder's
      e.preventDefault(); // no focus ring, no text selection on a long press
      if (hold()) b.setPointerCapture?.(e.pointerId);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) b.addEventListener(type, letGo);
    b.addEventListener("keydown", (e) => {
      if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
      e.preventDefault();
      hold();
    });
    b.addEventListener("keyup", (e) => {
      if (e.key === " " || e.key === "Enter") letGo();
    });
    b.addEventListener("contextmenu", (e) => e.preventDefault()); // a long touch is a hold
    return b;
  }

  function renderTiles(layer) {
    for (const [id, t] of tiles) if (t.layer === layer) tiles.delete(id);
    sections.get(layer.id).group.replaceChildren(...ws.lists[layer.id].map((id) => makeTile(layer, id)));
    placeEditor();
  }

  // One row of the layer list: a layer's tiles, or the snapshots'.
  function makeSection(id, text, onDrop, ...extras) {
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
      { class: id === SNAP_PANEL ? "layer snapshots" : "layer", "data-layer": id },
      el(
        "div",
        { class: "layer-meta" },
        el("div", { class: "layer-title" }, grip, el("h2", { text: text.name })),
        el("p", { class: "hint", text: text.hint }),
        ...extras,
      ),
      group,
      slot,
    );
    sections.set(id, { node, group, slot });
    sorters.push(sortable(group, { item: ".tile", key: "key", onDrop }));
  }

  // The layer's fader: scales every sound in it, on top of each one's own volume.
  function layerVolume(id) {
    const knob = slider({ ...LEVEL, key: "layer-volume", label: tx.tile.volume }, ws.volumes[id], (v) => {
      ws.volumes[id] = v;
      engine.setLayerVolume(id, v);
      persist();
    });
    knob.classList.add("layer-volume");
    knob.querySelector("input").setAttribute("aria-label", tx.tile.layerVolume(tx.layers[id].name));
    knob.title = tx.tile.layerVolumeTitle;
    return knob;
  }

  /* ---- snapshot tiles ---- */
  const snapTiles = new Map(); // snapshot id -> { node, tile, edit, labelEl, detailEl }
  const snapDetail = (snap) => `${tx.sections[snap.section]} · ${tx.snap.count(partsOf(snap).length)}`;

  function makeSnapTile(snap) {
    const labelEl = el("span", { class: "variant-label", text: snap.name });
    const detailEl = el("span", { class: "variant-detail", text: snapDetail(snap) });
    const node = el(
      "button",
      { type: "button", class: "variant", "data-snap": snap.id, "aria-pressed": "false" },
      labelEl,
      detailEl,
    );
    node.addEventListener("click", (e) => recall(snapById(snap.id), { clicks: e.detail, toggle: true }));
    const edit = el("button", {
      type: "button",
      class: "edit",
      "data-edit-snap": snap.id,
      "aria-expanded": String(open?.id === snap.id),
      "aria-label": tx.tile.edit(snap.name),
      title: tx.tile.editTitle,
      text: "▾",
    });
    edit.addEventListener("click", () => (open?.id === snap.id ? closeEditor() : openSnapEditor(snap.id)));
    const tile = el("div", { class: "tile", "data-key": snap.id }, node, edit);
    snapTiles.set(snap.id, { node, tile, edit, labelEl, detailEl });
    return tile;
  }

  const snapExport = el("button", { type: "button", class: "ghost", "data-action": "export-snaps", text: tx.snap.export });
  snapExport.title = tx.snap.exportTitle;
  const snapImport = el("button", { type: "button", class: "ghost", "data-action": "import-snaps", text: tx.snap.import });
  snapImport.title = tx.snap.importTitle;
  const snapFile = el("input", { type: "file", accept: ".json,application/json", hidden: "", "data-input": "snaps" });

  function renderSnaps() {
    snapExport.disabled = !ws.snapshots.length;
    snapTiles.clear();
    sections.get(SNAP_PANEL).group.replaceChildren(...ws.snapshots.map(makeSnapTile));
    placeEditor();
  }

  for (const id of ws.order) {
    if (id === SNAP_PANEL) {
      makeSection(
        id,
        tx.snap,
        (ids) => {
          ws.snapshots = ids.map(snapById);
          persist();
        },
        el("div", { class: "snap-files" }, snapExport, snapImport, snapFile),
      );
      renderSnaps();
      continue;
    }
    const layer = layerById(id);
    makeSection(
      id,
      tx.layers[id],
      (ids) => {
        ws.lists[id] = ids;
        persist();
      },
      layerVolume(id),
    );
    renderTiles(layer);
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

  // Cloud save: a newer copy from the server replaces the workspace like an
  // imported preset does, keeping what plays.
  const { active: _factoryActive, ...factory } = normalize({});
  const account = cloud
    ? mountAccount({
        cloud,
        tx,
        lang: lang(),
        snapshot,
        pristine: () => JSON.stringify({ ...ws, seed: "" }) === JSON.stringify({ ...factory, seed: "" }),
        apply: (remote) => {
          if (Object.hasOwn(DICTS, remote?.lang)) setLang(remote.lang);
          state.varying = new Map();
          remount({ ws: normalize(remote), open: null, status: t().cloud.pulled });
        },
        confirm,
        status,
        ...(loadButton ? { loadButton } : {}),
      })
    : null;

  // Top bar: the way back to agu.com.ar, the transport buttons, the tempo, then
  // the how-to page, where the setup is saved (account.js) and the language.
  const help = createHelp(tx.help);
  const back = el("a", { class: "back", href: "https://agu.com.ar/", text: `← ${tx.topbar.back}` });
  back.title = tx.topbar.backTitle;
  const topbar = el(
    "nav",
    { class: "topbar" },
    back,
    el("div", { class: "topbar-transport" }, snapBtn, cueBtn, stopBtn, recBtn),
    el(
      "div",
      { class: "topbar-tempo" },
      el("label", { class: "bpm", for: "bpm" }, el("span", { text: tx.transport.bpm }), bpm, bpmOut),
      tapBtn,
      rampBox,
    ),
    el("div", { class: "topbar-end" }, help.button, ...(account ? [account.node] : []), language),
  );

  const samplesPanel = samples
    ? mountSamplesPanel({
        samples,
        cloud,
        tx,
        lang: lang(),
        confirm,
        status: (text) => status(text),
        onPreview: previewSample,
        onUse: addSampleSound,
        onRemove: forgetSample,
      })
    : null;

  root.replaceChildren(
    topbar,
    help.dialog,
    veil,
    el(
      "header",
      { class: "top" },
      el("h1", { text: "Psy Layers" }),
      el("p", { class: "synth-note", text: tx.synthNote }),
      el("p", { class: "lede", text: tx.lede }),
    ),
    el(
      "div",
      { class: "transport panel" },
      bgKick.node,
      quantize.node,
      delay.node,
      reverb.node,
      djBox,
    ),
    el(
      "div",
      { class: "tools panel" },
      el("div", { class: "tools-row pilot-row" }, autoBtn, sectionBadge, sectionLeft, queueList, nextBtn),
      el("div", { class: "tools-row" }, style, seedLabel, diceBtn, shareBtn),
      el(
        "div",
        { class: "tools-row" },
        el("div", { class: "phases", role: "group", "aria-label": tx.pilot.phases }, el("span", { text: tx.pilot.phases }), ...phaseBtns),
        changesBox,
      ),
      el("div", { class: "tools-row" }, wavBtn, exportBtn, importBtn, importFile, resetBtn, factoryCheck.node),
      statusLine,
    ),
    ...(samplesPanel ? [samplesPanel.node] : []),
    el("div", { class: "stepbar", "aria-hidden": "true" }, el("div", { class: "cells" }, ...cells), barLabel),
    layersMain,
    el(
      "footer",
      { class: "credits" },
      el("a", { href: REPO, text: tx.credits.repo }),
      el("span", { text: tx.credits.made }),
    ),
  );

  /* ---- rendering ---- */
  let lanes = {};
  const laneMap = () => desiredLanes(state.active, { bgKick: ws.bgKick && !state.auto });

  function renderButtons(playingFx = engine.activeFx()) {
    const target = state.pending ?? state.active;
    for (const [id, { layer, node, tile, vary, solo, levelBar }] of tiles) {
      const on = layer.oneShot ? playingFx.has(id) : isOn(state.active, id);
      const level = `${Math.round((dataOf(id).level / LEVEL.max) * 1000) / 10}%`;
      node.style.setProperty("--level", level);
      if (levelBar) {
        levelBar.hidden = on;
        node.classList.toggle("has-bar", !on);
        levelBar.style.setProperty("--level", level);
        levelBar.setAttribute("aria-valuenow", String(Math.round(dataOf(id).level * 100)));
        levelBar.setAttribute("aria-valuetext", LEVEL.fmt(dataOf(id).level));
      }
      node.title = on && !layer.oneShot ? tx.tile.levelTitle : id === BG_KICK_VARIANT ? tx.tile.bgKick : "";
      const next = !layer.oneShot && isOn(target, id);
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-queued", Boolean(state.pending) && next && !on);
      node.classList.toggle("is-leaving", Boolean(state.pending) && on && !next);
      node.classList.toggle("is-background", lanes.bgKick === id);
      tile.classList.toggle("is-edited", owned(id) && !isCopy(id));
      tile.classList.toggle("is-auto", ws.auto.includes(id));
      tile.classList.toggle("is-varying", state.varying.has(id));
      solo?.classList.toggle("is-idle", !on && lanes.bgKick !== id);
      if (vary) {
        vary.setAttribute("aria-pressed", String(state.varying.has(id)));
        vary.style.setProperty("--amount", `${Math.round(improvOf(id) * 100)}%`);
      }
      tile.classList.toggle("is-building", state.buildUp?.id === id);
      if (!layer.oneShot) node.setAttribute("aria-pressed", String(on));
    }
    for (const [id, { node, tile }] of snapTiles) {
      const on = state.applied === id && sameLanes(state.active, snapById(id).active);
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-queued", state.queuedSnap?.id === id);
      node.setAttribute("aria-pressed", String(on));
      tile.classList.toggle("is-dirty", state.drafts.has(id));
    }
    showCue();
  }

  // Running, the slot holds Parar; stopped, the cue button arms, and armed it
  // plays what was queued.
  function showCue() {
    mediaKeys?.setPlaying(engine.isRunning());
    stopBtn.hidden = !engine.isRunning();
    cueBtn.hidden = engine.isRunning();
    cueBtn.textContent = state.armed ? tx.transport.play : tx.transport.arm;
    cueBtn.title = state.armed ? tx.transport.playTitle : tx.transport.armTitle;
    cueBtn.classList.toggle("is-armed", state.armed);
  }

  // Now: the section and the bars it has left, then the queue (✕ drops one
  // before it plays). In its last loop the section coming next pulses.
  function showSection() {
    const p = state.auto ? state.pilot : null;
    autoBtn.setAttribute("aria-pressed", String(state.auto));
    sectionBadge.textContent = p ? tx.sections[p.section] : "";
    sectionBadge.hidden = !p;
    sectionLeft.textContent = p ? tx.pilot.left(p.left * 2) : "";
    const chips = (p?.queue ?? []).map((id, i) => {
      const drop = el("button", { type: "button", class: "unqueue", "aria-label": tx.pilot.unqueue(tx.sections[id]), text: "✕" });
      drop.addEventListener("click", () => {
        state.pilot = dequeue(state.pilot, i);
        showSection();
      });
      return el("li", { class: "queued", "data-queued": id }, el("span", { text: tx.sections[id] }), drop);
    });
    if (p && !p.queue.length && p.left === 1 && p.next) {
      chips.push(el("li", { class: "queued is-auto", "data-queued": p.next }, el("span", { text: tx.sections[p.next] })));
    }
    if (p?.left === 1) chips[0]?.classList.add("is-next");
    queueList.replaceChildren(...chips);
    queueList.hidden = !chips.length;
    nextBtn.disabled = !p || p.left === 1;
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

  // A short flash, replayed on every call: alternating between two identical
  // animations restarts it without forcing a reflow.
  function strike(node, accent = false) {
    const again = node.classList.contains("hit-a");
    node.classList.toggle("hit-a", !again);
    node.classList.toggle("hit-b", again);
    node.classList.toggle("hit-accent", accent);
  }

  // Each audible step flashes the tiles that play on it, brighter on an
  // accent, and the BPM on every beat. A hit its mod skips this loop does not.
  let struck = null;
  function strikeStep(step) {
    if (step === struck) return;
    struck = step;
    if (step === null) return;
    if (step % 4 === 0) strike(bpmOut, step % BAR_STEPS === 0);
    const loop = engine.visibleLoop() ?? 0;
    for (const id of Object.values(lanes)) {
      const events = eventsAt(id, step, false, dataNow(id), loop);
      const t = tiles.get(id);
      if (events.length && t) strike(t.node, events.some((ev) => ev.accent));
    }
  }

  // The bar follows the audio clock, not the timer: each frame asks the engine
  // which scheduled step is audible now. The loop parks itself when idle.
  let frame = 0;
  let fxShown = new Set();
  function draw() {
    frame = 0;
    const step = engine.visibleStep();
    paintStep(step);
    strikeStep(step);
    const fx = engine.activeFx();
    if ([...fx].sort().join() !== [...fxShown].sort().join()) {
      renderButtons(fx);
      for (const id of fx) {
        if (fxShown.has(id) || !tiles.has(id)) continue;
        strike(tiles.get(id).node, true);
      }
      fxShown = fx;
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
    fxShown = new Set(); // force a repaint (and a flash) so the button lights up this frame
    animate();
  }

  // A new selection: on the next bar line when "On the beat" is on and the
  // loop runs, on ▶ when armed, right away otherwise.
  function commit(next) {
    if ((ws.quantize && engine.isRunning()) || state.armed) {
      state.pending = sameLanes(next, state.active) ? null : next;
      if (!state.pending) state.queuedSnap = null;
      renderButtons();
      return;
    }
    state.pending = null;
    state.queuedSnap = null;
    state.active = next;
    sync();
  }

  // A double click (its second click, `clicks` 2) skips the bar line: the
  // first click's selection applies right away.
  let lastPress = null; // { id, from, add }: the selection a tile's click started from
  function press(layer, id, clicks = 1, add = false) {
    if (layer.oneShot) {
      fire(id);
      return;
    }
    if (state.armed && clicks === 2) return; // armed, a double click queues like a single one
    if (clicks === 2 && lastPress?.id === id) {
      state.pending = null;
      state.active = pressVariant(lastPress.from, layer, id, lastPress.add);
      lastPress = null;
      sync();
      return;
    }
    const from = state.pending ?? state.active;
    lastPress = { id, from, add };
    commit(pressVariant(from, layer, id, add));
  }

  /* ---- the bar hook: everything that must land on the grid ---- */
  engine.onBar((time, step, bar) => {
    const loopStart = step === 0 && bar > 0;
    if (loopStart) {
      for (const id of state.newParts) writeNewPart(id);
      state.newParts.clear();
      varyAll();
    }
    runQueued();
    rollBuildUp(step);
    stepRamp();
    let changed = false;
    if (state.pending) {
      if (state.queuedSnap) load(state.queuedSnap);
      state.queuedSnap = null;
      state.active = state.pending;
      state.pending = null;
      changed = true;
    } else if (state.auto && loopStart) {
      const move = advance(state.pilot, state.active, ws.lists, state.rng, {
        style: ws.style,
        changeBars: ws.changeBars,
      });
      state.pilot = move.pilot;
      dressIn([...entering(state.active, move.active), ...move.fx]);
      for (const id of move.rewrite) rewrite(id);
      for (const id of move.fx) fire(id, time);
      state.active = move.active;
      showSection();
      changed = true;
    }
    // Under the autopilot a mix with no lead and no pad lasts one bar at most.
    if (state.auto) {
      if (!isBare(state.active)) state.bare = 0;
      else if (state.bare++ >= 1) {
        const full = fillMelodic(state.active, ws.lists, Math.random, ws.style);
        dressIn(entering(state.active, full));
        state.active = full;
        state.bare = 0;
        changed = true;
      }
    }
    if (!changed) return undefined;
    if (state.auto) mixIn();
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
    feed(id, state.varying.has(id) ? varied(id, data) : data);
    persist();
    renderButtons();
  }

  // The autopilot writes a new part, in the style's scale, unless the user
  // owns this one. The rng runs either way, from the factory part, so a seed
  // plays the same whatever was edited locally.
  function rewrite(id) {
    const def = defOf(id);
    if (def.kind !== "notes") return;
    const scale = STYLES[ws.style].scale ?? def.data.scale;
    const notes = newPart(styleOf(id), def.data.notes, scaleRows(scale, def.low, def.high), state.rng);
    if (owned(id)) return;
    const was = dataOf(id);
    setVariant(id, { ...was, notes, scale }, { generated: true });
    if (open?.id !== id) return;
    if (was.scale === scale) open.editor.show(dataOf(id));
    else openEditor(open.layer, id);
  }

  // The seed's params and synth for each sound the autopilot brings in.
  function dressIn(ids) {
    for (const id of ids) {
      if (!tiles.has(id) || owned(id)) continue;
      const next = { ...dataOf(id), ...dress(id, ws.seed) };
      if (sameData(next, dataOf(id))) continue;
      setVariant(id, next, { generated: true });
      if (open?.id === id) openEditor(open.layer, id);
    }
  }

  // Improvise toggle: a fresh variation of the anchor on every loop.
  function varied(id, anchor) {
    const def = defOf(id);
    const amount = improvOf(id);
    if (def.kind === "drum") return { ...anchor, steps: varySteps(anchor.steps, Math.random, amount) };
    return { ...anchor, notes: varyNotes(anchor.notes, scaleRows(anchor.scale, def.low, def.high), Math.random, amount) };
  }

  function varyAll() {
    for (const [id, anchor] of state.varying) {
      const next = varied(id, anchor);
      feed(id, next);
      if (open?.id === id) open.editor.show(next);
    }
  }

  function setVarying(id, on) {
    if (on) {
      state.varying.set(id, dataOf(id));
      // The first variation waits for the next loop: nothing jumps on click.
    } else {
      state.varying.delete(id);
      feed(id, dataOf(id));
      if (open?.id === id) open.editor.show(dataOf(id));
    }
    if (open?.id === id) open.editor.showVarying(on);
    renderButtons();
  }

  // 🎲 New part: on the next loop while it runs (a second click cancels),
  // at once when it is stopped.
  function writeNewPart(id) {
    const def = defOf(id);
    const data = dataOf(id);
    setVariant(id, { ...data, notes: improvise(styleOf(id), scaleRows(data.scale, def.low, def.high)) });
    if (open?.id === id) {
      open.editor.show(dataNow(id));
      open.editor.showNewPart(false);
    }
  }

  function askNewPart(layer, id) {
    if (!engine.isRunning()) writeNewPart(id);
    else if (state.newParts.delete(id)) open?.editor.showNewPart(false);
    else {
      state.newParts.add(id);
      open?.editor.showNewPart(true);
    }
    const target = state.pending ?? state.active;
    if (!isOn(target, id)) press(layer, id);
  }

  // A part rewritten from what plays now (an improvised part included).
  function reshape(id, fn) {
    const data = dataNow(id);
    setVariant(id, { ...data, ...fn(data, defOf(id).kind) });
    if (open?.id === id) open.editor.show(dataNow(id));
  }

  // ×2, reverse, euclid and the resets: on the next bar line while it runs
  // (a second click cancels), at once when it is stopped.
  const edits = {
    double: (layer, id) => reshape(id, (data) => ({ steps: doubleSteps(data.steps) })),
    reverse: (layer, id) => reshape(id, reversePart),
    euclid: (layer, id) => reshape(id, () => euclidSteps(state.euclid.k, state.euclid.n, state.euclid.rot)),
    reset: (layer, id) => {
      if (isCopy(id)) ws.variants[id] = defaultData(id);
      else delete ws.variants[id];
      ws.auto = ws.auto.filter((x) => x !== id);
      delete ws.improv[id];
      state.newParts.delete(id);
      state.varying.delete(id); // back to the factory part, improvise off too
      feed(id, dataOf(id));
      persist();
      renderButtons();
      if (open?.id === id) openEditor(layer, id); // rebuild with the factory values
    },
    // Only the factory notes (or hits): the voice, the insert and the volume stay.
    "reset-part": (layer, id) => {
      const keys = [...(defOf(id).kind === "drum" ? ["steps", "mods"] : ["notes"]), "speed", "iter", "echo"];
      const factory = defaultData(id);
      state.newParts.delete(id);
      setVariant(id, { ...dataOf(id), ...Object.fromEntries(keys.map((k) => [k, structuredClone(factory[k])])) });
      if (!isCopy(id) && JSON.stringify(ws.variants[id]) === JSON.stringify(factory)) {
        delete ws.variants[id]; // nothing left that differs from factory
        persist();
        renderButtons();
      }
      if (open?.id === id) {
        open.editor.showNewPart(false);
        open.editor.show(dataNow(id));
      }
    },
  };

  function askEdit(layer, id, action) {
    const running = engine.isRunning();
    // Like any edit, rewriting the part of something silent switches it on.
    const target = state.pending ?? state.active;
    if (!action.startsWith("reset") && !layer.oneShot && !isOn(target, id)) press(layer, id);
    if (!running) return edits[action](layer, id);
    const actions = state.queued.get(id) ?? new Set();
    if (!actions.delete(action)) actions.add(action);
    if (actions.size) state.queued.set(id, actions);
    else state.queued.delete(id);
    if (open?.id === id) open.editor.showQueued(action, actions.has(action));
  }

  function runQueued() {
    const queued = state.queued;
    state.queued = new Map();
    for (const [id, actions] of queued) {
      for (const action of actions) {
        if (open?.id === id) open.editor.showQueued(action, false);
        edits[action](layerOf(id), id);
      }
    }
  }

  // The tile's fill: only the sound's volume changes, an improvised part
  // keeps its variation. By hand the sound becomes yours; the autopilot's
  // fader leaves a sound yours if it was, and moves over `glide` seconds,
  // the fill too.
  function setLevel(id, level, { pilot = false, glide } = {}) {
    if (pilot && !(id in ws.variants)) ws.auto.push(id);
    if (!pilot) ws.auto = ws.auto.filter((x) => x !== id);
    ws.variants[id] = { ...dataOf(id), level };
    if (state.varying.has(id)) state.varying.set(id, { ...state.varying.get(id), level });
    feed(id, { ...dataNow(id), level }, glide);
    const t = tiles.get(id);
    t.node.style.setProperty("--glide", `${glide ?? 0}s`);
    if (t.node.classList.contains("is-sliding")) t.detailEl.textContent = tx.tile.level(LEVEL.fmt(level));
    open?.id === id && open.editor.showLevel(level);
    if (pilot) return;
    persist();
    renderButtons();
  }

  // The autopilot's balance on every sound it plays, yours too: a level that
  // moves goes there in a straight line over the loop, one that enters
  // starts there.
  function mixIn(active = state.active) {
    let moved = false;
    for (const [id, level] of Object.entries(mixOf(state.pilot, active))) {
      if (!tiles.has(id) || dataOf(id).level === level) continue;
      setLevel(id, level, { pilot: true, glide: stepDuration(state.tempo) * LOOP_STEPS });
      moved = true;
    }
    if (moved) persist();
  }

  function setImprov(id, amount) {
    if (amount === IMPROV_DEFAULT) delete ws.improv[id];
    else ws.improv[id] = amount;
    persist();
    if (open?.id === id) open.editor.showAmount(amount);
    renderButtons();
  }

  /* ---- kick build-up: one bar, on the next bar line ---- */
  function setBuildUp(id, on) {
    const was = state.buildUp;
    state.buildUp = on ? { id, from: null } : null;
    if (was?.from != null) feed(was.id, fed.get(was.id));
    open?.editor.showBuildUp(state.buildUp?.id === open.id);
    renderButtons();
  }

  // From the bar hook: an armed build-up takes this bar, a playing one ends.
  function rollBuildUp(step) {
    const b = state.buildUp;
    if (!b) return;
    if (b.from === null) {
      b.from = step;
      feed(b.id, fed.get(b.id));
      return;
    }
    setBuildUp(b.id, false);
  }

  /* ---- BPM change: one slice per bar line ---- */
  function setTempo(value) {
    state.tempo = value;
    ws.bpm = Math.round(value);
    bpm.value = String(ws.bpm);
    engine.setBpm(value);
    persist();
  }

  function showRamp() {
    const r = state.ramp;
    rampBtn.textContent = r ? tx.tempo.cancel : tx.tempo.go;
    rampBtn.setAttribute("aria-pressed", String(Boolean(r)));
    bpmOut.textContent = r ? tx.tempo.ramping(ws.bpm, r.to) : String(ws.bpm);
  }

  // With the loop stopped there are no bar lines: the BPM just changes.
  function startRamp() {
    const to = clampBpm(Number(rampTo.value));
    rampTo.value = String(to);
    if (!engine.isRunning()) setTempo(to);
    else if (to !== state.tempo) state.ramp = { from: state.tempo, to, bars: ws.rampBars, done: 0 };
    showRamp();
  }

  function stepRamp() {
    const r = state.ramp;
    if (!r) return;
    r.done++;
    setTempo(rampAt(r, r.done));
    if (r.done >= r.bars) state.ramp = null;
    showRamp();
  }

  /* ---- snapshots ---- */
  function takeSnapshot() {
    if (!Object.keys(lanes).length) {
      status(tx.snap.nothing);
      return;
    }
    if (ws.snapshots.length >= SNAP_MAX) {
      status(tx.snap.full);
      return;
    }
    const parts = capture(lanes, dataNow);
    const section = state.auto && state.pilot ? state.pilot.section : guessSection(parts.active);
    const name = freshName(tx.sections[section], ws.snapshots.map((s) => s.name));
    const snap = { id: nextSnapId(ws.snapshots), name, section, ...parts };
    ws.snapshots = [...ws.snapshots, snap];
    state.applied = snap.id;
    persist();
    renderSnaps();
    renderButtons();
    openSnapEditor(snap.id, { focusName: true });
    status(tx.snap.saved(name));
  }

  // On the next bar line while the loop runs (clicking the queued one again
  // cancels it, a double click enters now), on ▶ when armed, at once when it
  // is stopped.
  function recall(snap, { clicks = 1, toggle = false } = {}) {
    if (state.armed && clicks === 2) return;
    const queued = state.queuedSnap?.id === snap.id;
    if (clicks === 2 && queued) snap = state.queuedSnap;
    else if (engine.isRunning() || state.armed) {
      if (toggle && queued) {
        state.queuedSnap = null;
        state.pending = null;
      } else {
        state.queuedSnap = snap;
        state.pending = { ...snap.active };
      }
      renderButtons();
      return;
    }
    load(snap);
    state.queuedSnap = null;
    state.pending = null;
    state.active = { ...snap.active };
    sync();
  }

  // A recalled snapshot's sounds go back to the data they played then, and
  // a running autopilot jumps to its section.
  function load(snap) {
    for (const [id, data] of Object.entries(snap.data)) {
      if (!tiles.has(id) || sameData(dataOf(id), data)) continue;
      setVariant(id, structuredClone(data));
      if (!isCopy(id) && sameData(data, defOf(id).data)) {
        delete ws.variants[id];
        persist();
      }
      if (open?.id === id) openEditor(open.layer, id);
    }
    state.applied = snap.id;
    if (state.auto) {
      state.pilot = moveTo(state.pilot, snap.section);
      showSection();
    }
  }

  function openSnapEditor(id, { focusName = false } = {}) {
    closeEditor();
    const saved = snapById(id);
    const editor = createSnapshotEditor({
      saved,
      draft: state.drafts.get(id) ?? saved,
      labelOf,
      pool: ws.lists,
      dataNow,
      capture: () => {
        if (Object.keys(lanes).length) return capture(lanes, dataNow);
        status(tx.snap.nothing);
        return null;
      },
      onDraft: (draft) => {
        if (draft) state.drafts.set(id, draft);
        else state.drafts.delete(id);
        renderButtons();
      },
      onSave: (draft) => {
        const snap = { ...draft, name: draft.name.trim().slice(0, 40) || tx.sections[draft.section] };
        ws.snapshots = ws.snapshots.map((s) => (s.id === id ? snap : s));
        state.drafts.delete(id);
        persist();
        const tile = snapTiles.get(id);
        tile.labelEl.textContent = snap.name;
        tile.detailEl.textContent = snapDetail(snap);
        tile.edit.setAttribute("aria-label", tx.tile.edit(snap.name));
        renderButtons();
        return snap;
      },
      onTry: (draft) => recall(draft),
      onRemove: () => removeSnapshot(id),
      onClose: closeEditor,
    });
    open = { layer: { id: SNAP_PANEL }, id, editor };
    showEditor(editor.node);
    if (focusName) editor.focusName();
  }

  function removeSnapshot(id) {
    if (!confirm(tx.snap.confirmRemove(snapById(id).name))) return;
    closeEditor();
    ws.snapshots = ws.snapshots.filter((s) => s.id !== id);
    state.drafts.delete(id);
    if (state.applied === id) state.applied = null;
    if (state.queuedSnap?.id === id) {
      state.queuedSnap = null;
      state.pending = null;
    }
    persist();
    renderSnaps();
    renderButtons();
  }

  /* ---- editors: one open at a time ---- */
  // The open editor floats over the page just under its tile, like a context
  // menu: the rows below stay put, and a click elsewhere or Esc closes it.
  function openTile() {
    return open ? (tiles.get(open.id) ?? snapTiles.get(open.id)) : null;
  }

  function placeEditor() {
    const anchor = openTile()?.tile;
    if (!anchor) return;
    const { node, slot } = sections.get(open.layer.id);
    const top = anchor.getBoundingClientRect().bottom - node.getBoundingClientRect().top - node.clientTop;
    slot.style.top = `${top + 6}px`;
    // Wider than its layer (min-width), it grows to the right: pull it back
    // left when that would leave the screen.
    slot.style.left = "";
    const over = slot.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
    if (over > 0) slot.style.left = `${-4 - over}px`;
  }

  function showEditor(node) {
    sections.get(open.layer.id).slot.replaceChildren(node);
    openTile().edit.setAttribute("aria-expanded", "true");
    openTile().tile.classList.add("is-editing");
    veil.hidden = false;
    placeEditor();
    node.scrollIntoView?.({ block: "nearest" });
  }

  const onOutside = (e) => {
    if (!open || !e.target.isConnected) return;
    if (sections.get(open.layer.id).slot.contains(e.target) || openTile()?.edit.contains(e.target)) return;
    closeEditor();
  };
  const onEscape = (e) => {
    if (e.key !== "Escape" || !open) return;
    const { edit } = openTile() ?? {};
    closeEditor();
    edit?.focus();
  };
  document.addEventListener("pointerdown", onOutside);
  document.addEventListener("keydown", onEscape);
  window.addEventListener("resize", placeEditor);

  function closeEditor() {
    if (!open) return;
    open.editor.destroy();
    sections.get(open.layer.id).slot.replaceChildren();
    openTile()?.edit.setAttribute("aria-expanded", "false");
    openTile()?.tile.classList.remove("is-editing");
    veil.hidden = true;
    open = null;
  }

  function openEditor(layer, id, { focusName = false } = {}) {
    closeEditor();
    const editor = createEditor({
      id,
      label: labelOf(id),
      data: dataOf(id),
      brush: state.brush,
      varying: state.varying.has(id),
      amount: improvOf(id),
      onAmount: (amount) => setImprov(id, amount),
      newPart: state.newParts.has(id),
      onNewPart: () => askNewPart(layer, id),
      onChange: (next) => {
        setVariant(id, next);
        // Editing something silent switches it on: what you edit is what you hear.
        const target = state.pending ?? state.active;
        if (!layer.oneShot && !isOn(target, id)) press(layer, id);
      },
      onAudition: (note) => {
        // A note off the grid while the loop runs only cuts into what plays.
        if (layer.oneShot || engine.isRunning()) return;
        engine.audition(id, note);
      },
      onDouble: () => askEdit(layer, id, "double"),
      onEdit: (action) => askEdit(layer, id, action),
      euclid: state.euclid,
      onReset: () => askEdit(layer, id, "reset"),
      onResetPart: () => askEdit(layer, id, "reset-part"),
      queued: state.queued.get(id) ?? new Set(),
      onClose: closeEditor,
      onTrigger: () => fire(id),
      onRename: (name) => rename(id, name),
      onDuplicate: () => duplicate(layer, id),
      onRemove: () => remove(layer, id),
      onWav: () => exportWav({ layer, id }),
      onVary: (on) => setVarying(id, on),
      samples: samples?.info.samples ?? [],
      onSample: (sampleId) => {
        engine.ensureContext(); // inside the change event: the first sound may be this one
        samples?.load(sampleId).then((buffer) => {
          if (buffer && open?.id === id && !engine.isRunning()) engine.audition(id, { midi: 57 });
        });
      },
      buildUp: state.buildUp?.id === id,
      onBuildUp: (on) => {
        setBuildUp(id, on);
        // Like an edit: arming a silent kick switches it on, so the build-up is heard.
        const target = state.pending ?? state.active;
        if (on && !isOn(target, id)) press(layer, id);
      },
    });
    open = { layer, id, editor };
    showEditor(editor.node);
    editor.paint(engine.visibleStep());
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
    tile.vary?.setAttribute("aria-label", tx.tile.vary(label));
    tile.solo?.setAttribute("aria-label", tx.tile.solo(label));
    tile.levelBar?.setAttribute("aria-label", tx.tile.levelBar(label));
    persist();
    return label;
  }

  // A new copy of `id` with `data`, at `at` in its layer, opened with its name selected.
  function addCopy(layer, id, data, name, at) {
    const copy = copyId(id, allIds());
    const list = ws.lists[layer.id];
    ws.lists[layer.id] = [...list.slice(0, at), copy, ...list.slice(at)];
    ws.variants[copy] = data;
    ws.names[copy] = name;
    feed(copy, data);
    persist();
    closeEditor();
    renderTiles(layer);
    renderButtons();
    openEditor(layer, copy, { focusName: true });
    return copy;
  }

  function duplicate(layer, id) {
    const at = ws.lists[layer.id].indexOf(id) + 1;
    const copy = copyId(id, allIds());
    if (id in ws.improv) ws.improv[copy] = ws.improv[id];
    addCopy(layer, id, structuredClone(dataOf(id)), tx.tile.copyName(labelOf(id)), at);
  }

  /* ---- samples ---- */
  // "+ Sound in…": the layer's template part, playing the sample.
  function addSampleSound(sample, layerId) {
    const layer = layerById(layerId);
    const { from, transpose = 0 } = SAMPLE_TEMPLATES[layerId];
    const data = { ...defaultData(from), sample: sampleDefaults(sample.id, sample.name) };
    if (defOf(from).kind === "notes") data.transpose = transpose;
    addCopy(layer, from, data, sample.name, ws.lists[layerId].length);
    samples.load(sample.id);
    status(tx.samples.created(sample.name, tx.layers[layerId].name));
  }

  // The panel's ▶: the AudioContext opens inside the click, the sound once loaded.
  function previewSample(sampleId) {
    engine.ensureContext();
    samples.load(sampleId).then((buffer) => buffer && engine.previewSample(sampleId));
  }

  // A deleted sample: the sounds using it go back to their own voice.
  function forgetSample(sampleId) {
    for (const id of allIds()) {
      if (dataOf(id).sample?.id === sampleId) setVariant(id, { ...dataOf(id), sample: null });
    }
    if (open && tiles.has(open.id)) openEditor(open.layer, open.id);
  }

  // Every sample the sounds and snapshots use, decoded ahead of playing.
  function preloadSamples() {
    const used = new Set();
    for (const data of [...Object.values(ws.variants), ...ws.snapshots.flatMap((s) => Object.values(s.data))]) {
      if (data.sample) used.add(data.sample.id);
    }
    for (const id of used) samples.load(id);
  }

  // Signed in: the library, then what the sounds need. Signed out: nothing.
  function syncSamples() {
    if (!samples) return;
    if (!cloud?.info.user) samples.clear();
    else if (!samples.info.ready) samples.refresh().then(preloadSamples);
    else preloadSamples();
  }
  const sampleOffs = [
    cloud?.on((event) => (event === "user" || event === "info") && syncSamples()),
    // A new upload or delete: an open editor offers the new list.
    samples?.on(() => {
      if (open && tiles.has(open.id) && !open.editor.node.contains(document.activeElement)) openEditor(open.layer, open.id);
    }),
  ];

  function remove(layer, id) {
    if (!confirm(tx.editor.confirmRemove(labelOf(id)))) return;
    closeEditor();
    ws.lists[layer.id] = ws.lists[layer.id].filter((x) => x !== id);
    delete ws.variants[id];
    delete ws.names[id];
    delete ws.improv[id];
    ws.auto = ws.auto.filter((x) => x !== id);
    state.varying.delete(id);
    state.newParts.delete(id);
    state.queued.delete(id);
    if (state.buildUp?.id === id) state.buildUp = null;
    const without = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== id));
    if (state.pending) state.pending = without(state.pending);
    state.active = without(state.active);
    if (state.pending && sameLanes(state.pending, state.active)) state.pending = null;
    // Snapshots lose the sound too; one left with nothing goes.
    const strip = (snap) => (id in snap.data ? removePart(snap, id) : snap);
    ws.snapshots = ws.snapshots.map(strip).filter((snap) => partsOf(snap).length);
    for (const [key, draft] of state.drafts) {
      if (snapById(key)) state.drafts.set(key, strip(draft));
      else state.drafts.delete(key);
    }
    if (state.queuedSnap) state.queuedSnap = state.pending ? strip(state.queuedSnap) : null;
    persist();
    renderTiles(layer);
    renderSnaps();
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
      stats?.count("renders");
      status(tx.tools.rendered(name));
    } catch {
      status(tx.tools.renderFailed);
    }
  }

  /* ---- recording ---- */
  let recTimer = 0;
  let recStopping = false;
  function showRec() {
    const now = recorder.state();
    recBtn.textContent =
      now === "recording" ? tx.rec.recording(clock(recorder.seconds())) : now === "waiting" ? tx.rec.waiting : tx.rec.idle;
    recBtn.title =
      now === "recording" ? tx.rec.recordingTitle(MAX_SECONDS / 60) : now === "waiting" ? tx.rec.waitingTitle : tx.rec.idleTitle;
    recBtn.classList.toggle("is-waiting", now === "waiting");
    recBtn.classList.toggle("is-recording", now === "recording");
    recBtn.setAttribute("aria-pressed", String(now !== "idle"));
    recBtn.disabled = recStopping;
    if (now === "idle") {
      clearInterval(recTimer);
      recTimer = 0;
    } else if (!recTimer) recTimer = setInterval(showRec, 250);
  }

  async function finishRecording(full = false) {
    recStopping = true;
    const take = recorder.stop();
    showRec();
    const done = await take;
    recStopping = false;
    showRec();
    if (!done) {
      status(tx.rec.empty);
      return;
    }
    const name = `psy-layers-${stamp()}.wav`;
    download(name, done.blob, "audio/wav");
    stats?.count("recordings");
    stats?.count("recorded", done.seconds);
    const saved = tx.rec.saved(name, clock(done.seconds));
    status(full ? `${tx.rec.full(MAX_SECONDS / 60)} ${saved}` : saved);
  }
  recorder.onFull(() => finishRecording(true));

  /* ---- remount: language, import, share links, reset ---- */
  function destroy() {
    if (soloing) engine.setSolo(null);
    closeEditor();
    clearInterval(recTimer);
    recorder.onFull(null);
    mediaKeys?.bind(null);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    engine.onBar(null);
    sorters.forEach((s) => s.destroy());
    account?.destroy();
    samplesPanel?.destroy();
    sampleOffs.forEach((off) => off?.());
    window.removeEventListener("hashchange", onHash);
    document.removeEventListener("pointerdown", onOutside);
    document.removeEventListener("keydown", onEscape);
    window.removeEventListener("resize", placeEditor);
  }

  function remount(changes = {}) {
    const { pending, armed, active, auto, pilot, rng, varying, queuedSnap, applied, drafts, tempo, ramp, dj, brush, euclid } = state;
    const carried = { pending, armed, active, auto, pilot, rng, varying, queuedSnap, applied, drafts, tempo, ramp, dj, brush, euclid };
    const next = { ws, ...carried, open: open?.id, ...changes };
    destroy();
    return mountApp(root, engine, { ...opts, recorder, resume: next });
  }

  async function loadShared({ seed, style: sharedStyle, bpm: sharedBpm, sounds }) {
    history.replaceState(null, "", location.pathname + location.search);
    let next = { ...ws, seed, style: sharedStyle ?? ws.style, bpm: sharedBpm ?? ws.bpm };
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
    remount({ ws: normalize(next), ...fresh(), pending: null, status: tx.share.loaded(seed), open: null });
  }

  const onHash = () => {
    const shared = readFragment(location?.hash);
    if (shared) loadShared(shared);
  };

  // Over a playing mix the autopilot takes it as it is and carries on from
  // there (in `section`, when one was asked for); the background kick becomes
  // a real kick so it does not drop out. From silence it starts an intro, or
  // `section`.
  function engageAuto(section = null) {
    if (!state.auto) stats?.count("autopilot"); // a new seed re-engages: not a start
    const playing = { ...(state.pending ?? state.active) };
    state.armed = false; // the autopilot takes what was queued and starts
    state.auto = true;
    state.bare = 0;
    state.rng = seeded(hashSeed(ws.seed));
    if (Object.keys(playing).length) {
      if (ws.bgKick && !playing.kick) playing.kick = BG_KICK_VARIANT;
      state.pilot = joinPilot(playing, section);
      dressIn(Object.values(playing).sort());
      mixIn(playing);
      commit(playing);
      showSection();
      return;
    }
    // Parts the autopilot wrote go back to factory, so a seed always replays
    // the same track.
    for (const id of ws.auto) {
      if (isCopy(id)) ws.variants[id] = defaultData(id);
      else delete ws.variants[id];
      feed(id, dataOf(id));
    }
    ws.auto = [];
    persist();
    state.queuedSnap = null;
    const start = startPilot(ws.lists, state.rng, ws.style, section ?? "intro");
    state.pilot = start.pilot;
    dressIn(Object.values(start.active).sort());
    for (const id of start.rewrite) rewrite(id);
    mixIn(start.active);
    commit(start.active);
    showSection();
  }

  // A phase button: queued while the autopilot runs, else it starts there.
  function forceSection(id) {
    if (!state.auto) engageAuto(id);
    else {
      state.pilot = enqueue(state.pilot, id);
      showSection();
    }
  }

  // A style narrows the autopilot's sounds and takes the BPM to its own.
  function setStyle(value) {
    ws.style = value;
    persist();
    const target = STYLES[value].bpm;
    if (target) {
      rampTo.value = String(target);
      startRamp();
    }
    if (state.auto && state.pilot) state.pilot = rearrange(state.pilot);
  }

  function setSeed(value) {
    ws.seed = cleanSeed(value) || randomSeed();
    seedInput.value = ws.seed;
    persist();
    if (state.auto) engageAuto();
  }

  /* ---- controls ---- */
  bpm.addEventListener("input", () => {
    state.ramp = null; // the hand on the slider wins
    setTempo(Number(bpm.value));
    showRamp();
  });
  // Tap tempo: on the press, not the release, so it follows the hand.
  let taps = [];
  const tap = () => {
    taps = addTap(taps, Date.now());
    const next = tapBpm(taps);
    if (next === null) return;
    state.ramp = null;
    setTempo(next);
    showRamp();
  };
  tapBtn.addEventListener("pointerdown", tap);
  tapBtn.addEventListener("click", (e) => {
    if (e.detail === 0) tap(); // Enter or Space
  });
  rampBtn.addEventListener("click", () => {
    if (!state.ramp) startRamp();
    else {
      state.ramp = null;
      showRamp();
    }
  });
  rampTo.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startRamp();
  });
  snapBtn.addEventListener("click", takeSnapshot);
  const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
  function setDj(value) {
    state.dj = Math.abs(value) < 0.02 ? 0 : value; // a detent at the centre
    djInput.value = String(state.dj);
    engine.setMasterFilter(state.dj);
    const { low, high } = djCutoffs(state.dj, 24000);
    djOut.textContent = state.dj < 0 ? tx.transport.djLow(hz(low)) : state.dj > 0 ? tx.transport.djHigh(hz(high)) : tx.transport.djOff;
  }
  djInput.addEventListener("input", () => setDj(Number(djInput.value)));
  djInput.addEventListener("dblclick", () => setDj(0));
  for (const [key, box] of [
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
  // What played stays queued for ▶, so it comes back together on the first step.
  stopBtn.addEventListener("click", () => {
    const playing = state.active;
    state.active = {};
    state.armed = Object.keys(playing).length > 0;
    state.pending = state.armed ? playing : null;
    state.auto = false;
    state.pilot = null;
    state.queuedSnap = null;
    state.ramp = null;
    state.newParts.clear();
    open?.editor.showNewPart(false);
    for (const action of state.queued.get(open?.id) ?? []) open.editor.showQueued(action, false);
    state.queued.clear();
    showRamp();
    if (state.buildUp) setBuildUp(state.buildUp.id, false);
    lanes = {};
    engine.stop();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    fxShown = new Set();
    renderButtons(new Set());
    paintStep(null);
    showSection();
  });
  // The keyboard's play/pause and stop keys press the same buttons.
  mediaKeys?.bind({ playing: engine.isRunning, play: () => cueBtn.click(), stop: () => stopBtn.click() });
  cueBtn.addEventListener("click", () => {
    if (!state.armed) {
      state.armed = true;
      renderButtons();
      return;
    }
    engine.ensureContext(); // inside the click: the queued mix starts now
    state.armed = false;
    if (state.queuedSnap) load(state.queuedSnap);
    if (state.pending) state.active = state.pending;
    state.pending = null;
    state.queuedSnap = null;
    sync();
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
  nextBtn.addEventListener("click", () => {
    if (!state.auto || !state.pilot) return;
    state.pilot = skip(state.pilot);
    showSection();
  });
  changes.addEventListener("input", () => {
    ws.changeBars = CHANGE_BARS[Number(changes.value)];
    changesOut.textContent = tx.pilot.every(ws.changeBars);
    persist();
  });
  diceBtn.addEventListener("click", () => setSeed(randomSeed()));
  shareBtn.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}${await shareFragment(ws)}`;
    stats?.count("shares");
    try {
      await navigator.clipboard.writeText(url);
      status(tx.share.copied);
    } catch {
      status(tx.share.manual(url));
    }
  });
  recBtn.addEventListener("click", async () => {
    if (recStopping) return;
    if (recorder.state() !== "idle") {
      finishRecording();
      return;
    }
    const starting = recorder.start(); // inside the click: it may create the AudioContext
    showRec();
    try {
      await starting;
    } catch {
      status(tx.rec.unsupported);
    }
    showRec();
  });
  wavBtn.addEventListener("click", () => exportWav(null));
  exportBtn.addEventListener("click", () => {
    const preset = toPreset({ ...ws, active: state.pending ?? state.active });
    download("psy-layers-preset.json", JSON.stringify(preset, null, 2), "application/json");
    stats?.count("presets");
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
    remount({ ws: preset, ...fresh(), active: preset.active, pending: null, open: null, status: tx.tools.imported });
  });
  snapExport.addEventListener("click", () => {
    download("psy-layers-snapshots.json", JSON.stringify(toSnapshotFile(ws), null, 2), "application/json");
    stats?.count("snapshots");
  });
  snapImport.addEventListener("click", () => snapFile.click());
  snapFile.addEventListener("change", async () => {
    const file = snapFile.files?.[0];
    snapFile.value = "";
    if (!file) return;
    let merged;
    try {
      merged = importSnapshots(ws, await file.text());
    } catch {
      status(tx.snap.importFailed);
      return;
    }
    remount({ ws: merged.ws, status: tx.snap.imported(merged.added, merged.left) });
  });
  factoryCheck.input.addEventListener("change", () => {
    resetBtn.textContent = factoryCheck.input.checked ? tx.tools.resetAll : tx.tools.resetSounds;
  });
  resetBtn.addEventListener("click", () => {
    if (!factoryCheck.input.checked) {
      // Every sound back to its factory data, the way each editor's Reset does, and none selected.
      if (!confirm(tx.tools.confirmSounds)) return;
      const variants = {};
      for (const id of allIds()) if (isCopy(id)) variants[id] = defaultData(id);
      engine.stop();
      remount({
        ws: { ...ws, variants, auto: [], improv: {} },
        active: {},
        pending: null,
        armed: false,
        auto: false,
        pilot: null,
        varying: new Map(),
        queuedSnap: null,
        applied: null,
        ramp: null,
        status: tx.tools.soundsReset,
      });
      return;
    }
    if (!confirm(tx.tools.confirmReset)) return;
    engine.stop();
    remount({
      ws: normalize({}),
      ...fresh(),
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
  showRec();
  showRamp();
  setDj(state.dj);
  syncSamples();
  if (resume) {
    persist();
    sync();
    if (resume.open && tiles.has(resume.open)) openEditor(layerOf(resume.open), resume.open);
    else if (resume.open && snapTiles.has(resume.open)) openSnapEditor(resume.open);
    if (resume.status) status(resume.status);
  } else {
    if (!stored.seed) persist();
    renderButtons(new Set());
    onHash();
  }
  return { ws, state, destroy };
}
