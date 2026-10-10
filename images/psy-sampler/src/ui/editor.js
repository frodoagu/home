// The panel a tile's ▾ opens under its layer. One shape per variant kind:
//   drum   one row of 32 steps + the voice's sliders
//   notes  piano roll + synth, brightness, scale, octave, note length
//   fx     just the sliders
// Every kind also picks its source (its own voice or one of the user's
// samples, which swaps the voice's sliders for the sample's) and has a
// filter + distortion section (the insert).
// Every change goes out through onChange(next) as fresh data; the editor
// never talks to the engine itself. The header names the variant (editable)
// and carries the per-sound actions: duplicate, WAV, reset, delete (copies).
import { DRIVE_TYPES, FILTER_TYPES, LFO_RATES } from "../audio/insert.js";
import { INSERT_PARAMS, LEVEL, SAMPLE_PARAMS, SYNTHS } from "../audio/params.js";
import { NOTE_LENGTHS, TRANSPOSE, defOf, isCopy, paramSpecs, sampleDefaults } from "../audio/patterns.js";
import { SCALES, inScale, isRoot, noteName, scaleRows } from "../audio/music.js";
import { LOOP_STEPS } from "../audio/timing.js";
import { cycleNote, cycleStep, doubleSteps, placeNote } from "../editing.js";
import { t } from "../i18n/index.js";
import { checkbox, el, nextId, select, slider } from "./dom.js";

const localized = (spec) => ({ ...spec, label: t().params[spec.label] });

export function createEditor({
  id,
  label,
  data,
  onChange,
  onAudition,
  onReset,
  onClose,
  onTrigger,
  onRename,
  onDuplicate,
  onRemove,
  onWav,
  varying = false,
  onVary,
  newPart = false,
  onNewPart,
  amount = 0.5,
  onAmount,
  buildUp = false,
  onBuildUp,
  samples = [], // the user's samples: [{ id, name }]
  onSample = () => {}, // a sample was picked: load it (and let it be heard)
}) {
  const def = defOf(id);
  const tx = t().editor;
  let current = data;
  let paintGrid = () => {};
  let refreshGrid = () => {};
  let buildUpBtn = null;
  let varyBtn = null;
  let newPartBtn = null;
  const cleanups = [];

  function set(patch) {
    current = { ...current, ...patch };
    onChange(current);
  }

  // Improvise: a toggle and a slider in one. A click turns it on or off (the
  // app varies the part on every loop while it is on); dragging across it,
  // or ← →, sets how much each variation changes, and the fill shows it.
  function varyToggle() {
    const text = el("span", { class: "vary-amount" });
    varyBtn = el(
      "button",
      { type: "button", class: "action toggle vary", "data-action": "vary", "aria-pressed": String(varying) },
      el("span", { text: tx.improvise }),
      text,
    );
    const b = varyBtn;
    b.title = tx.improviseTitle;
    const paint = () => {
      const pct = Math.round(amount * 100);
      b.style.setProperty("--amount", `${pct}%`);
      text.textContent = tx.improviseAmount(pct);
    };
    const setAmount = (v) => {
      amount = Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;
      paint();
      onAmount(amount);
    };
    let drag = null; // { x, moved } while a pointer is down
    let swallow = false;
    b.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, moved: false };
      b.setPointerCapture?.(e.pointerId);
    });
    b.addEventListener("pointermove", (e) => {
      if (!drag || (!drag.moved && Math.abs(e.clientX - drag.x) < 6)) return;
      drag.moved = true;
      const r = b.getBoundingClientRect();
      if (r.width) setAmount((e.clientX - r.left) / r.width);
    });
    const release = () => {
      if (drag?.moved) swallow = true;
      drag = null;
    };
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("click", () => {
      if (swallow) {
        swallow = false;
        return;
      }
      varying = !varying;
      b.setAttribute("aria-pressed", String(varying));
      onVary(varying);
    });
    b.addEventListener("keydown", (e) => {
      const delta = { ArrowLeft: -0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowUp: 0.05 }[e.key];
      if (delta === undefined) return;
      e.preventDefault();
      setAmount(amount + delta);
    });
    paint();
    return b;
  }

  /* ---- header: name + actions ---- */
  const name = el("input", { type: "text", class: "name-input", "data-action": "name", maxlength: "40", value: label });
  name.value = label;
  name.addEventListener("input", () => onRename(name.value));
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") name.blur();
  });
  name.addEventListener("blur", () => {
    if (!name.value.trim()) name.value = onRename("");
  });
  const button = (action, text, title) => {
    const b = el("button", { type: "button", class: "ghost", "data-action": action, text });
    if (title) b.title = title;
    return b;
  };
  const actions = [
    [button("duplicate", tx.duplicate), onDuplicate],
    [button("wav", tx.wav, tx.wavTitle), onWav],
    [button("reset", tx.reset), onReset],
    ...(isCopy(id) ? [[button("remove", tx.remove), onRemove]] : []),
    [button("close", tx.close), onClose],
  ];
  for (const [b, fn] of actions) b.addEventListener("click", () => fn());
  const head = el(
    "div",
    { class: "editor-head" },
    el("label", { class: "name-field" }, el("span", { text: tx.name }), name),
    el("div", { class: "editor-tools" }, ...actions.map(([b]) => b)),
  );

  /* ---- sliders: the voice's params (or the sample's) + volume ---- */
  const voiceKnobs = el("div", { class: "knob-group" });
  const knobs = el("div", { class: "knobs" }, voiceKnobs, slider(localized(LEVEL), current.level, (v) => set({ level: v })));
  const synthOnly = []; // controls that mean nothing while a sample plays

  function renderVoiceKnobs() {
    const s = current.sample;
    if (!s) {
      voiceKnobs.replaceChildren(
        ...paramSpecs(id).map((spec) =>
          slider(localized(spec), current.params[spec.key], (v) => set({ params: { ...current.params, [spec.key]: v } })),
        ),
      );
    } else {
      const setSample = (patch) => set({ sample: { ...current.sample, ...patch } });
      const reverse = checkbox(nextId("reverse"), tx.reverse, s.reverse);
      reverse.input.dataset.param = "reverse";
      reverse.input.addEventListener("change", () => setSample({ reverse: reverse.input.checked }));
      voiceKnobs.replaceChildren(
        ...SAMPLE_PARAMS.map((spec) => slider(localized(spec), s[spec.key], (v) => setSample({ [spec.key]: v }))),
        reverse.node,
      );
    }
    for (const n of synthOnly) n.hidden = Boolean(s);
  }

  /* ---- source: the voice, or one of the user's samples ---- */
  function sourcePicker() {
    const options = [{ value: "", label: tx.synthesized }, ...samples.map((s) => ({ value: s.id, label: s.name }))];
    const s = current.sample;
    if (s && !samples.some((x) => x.id === s.id)) options.push({ value: s.id, label: tx.sampleMissing(s.name) });
    const picker = select(
      tx.source,
      options,
      s?.id ?? "",
      (value) => {
        if (!value) set({ sample: null });
        else {
          set({ sample: sampleDefaults(value, samples.find((x) => x.id === value)?.name ?? current.sample?.name) });
          onSample(value);
        }
        renderVoiceKnobs();
      },
      "source",
    );
    const hint = el("p", { class: "legend", text: tx.sampleHint });
    hint.hidden = samples.length > 0;
    return [picker, hint];
  }

  /* ---- insert: filter (+ LFO) and distortion ---- */
  function insertControls() {
    const ins = () => current.insert;
    const setInsert = (patch) => set({ insert: { ...current.insert, ...patch } });
    const knob = (key) => {
      const spec = INSERT_PARAMS.find((p) => p.key === key);
      return slider(localized(spec), ins()[key], (v) => setInsert({ [key]: v }));
    };
    const filterKnobs = [knob("cutoff"), knob("res"), knob("lfo")];
    const rate = select(
      tx.lfoRate,
      LFO_RATES.map((n) => ({ value: n, label: tx.lfoRates[n] })),
      ins().rate,
      (v) => setInsert({ rate: Number(v) }),
      "lfo-rate",
    );
    const drive = knob("amount");
    const show = () => {
      for (const n of [...filterKnobs, rate]) n.hidden = ins().filter === "off";
      drive.hidden = ins().drive === "off";
    };
    const filterType = select(
      tx.filter,
      FILTER_TYPES.map((v) => ({ value: v, label: tx.filterTypes[v] })),
      ins().filter,
      (v) => {
        setInsert({ filter: v });
        show();
      },
      "filter",
    );
    const driveType = select(
      tx.drive,
      DRIVE_TYPES.map((v) => ({ value: v, label: tx.driveTypes[v] })),
      ins().drive,
      (v) => {
        setInsert({ drive: v });
        show();
      },
      "drive",
    );
    show();
    return el(
      "fieldset",
      { class: "insert" },
      el("legend", { text: tx.insert }),
      el("div", { class: "pickers" }, filterType, rate, driveType),
      el("div", { class: "knobs" }, ...filterKnobs, drive),
    );
  }

  const node = el("div", { class: "editor", role: "region", "aria-label": tx.region(label), "data-editor": id }, head);
  const source = el("div", { class: "pickers source" }, ...sourcePicker());

  if (def.kind === "fx") {
    const fire = el("button", { type: "button", class: "action", text: tx.fire });
    fire.addEventListener("click", onTrigger);
    node.append(source, knobs, insertControls(), el("div", { class: "editor-actions" }, fire));
  } else if (def.kind === "drum") {
    node.append(source, knobs, insertControls(), ...drumGrid());
  } else {
    node.append(...noteControls(), knobs, insertControls(), ...pianoRoll());
  }
  renderVoiceKnobs();

  /* ---- drums: one row ---- */
  function drumGrid() {
    const cells = [];
    const grid = el(
      "div",
      { class: "grid", role: "group", "aria-label": tx.steps },
      ...gridHeader(tx),
      el("span", { class: "row-label", text: tx.hits }),
    );
    for (let s = 0; s < LOOP_STEPS; s++) {
      const cell = el("button", { type: "button", class: cellClass(s), "data-step": String(s) });
      cells.push(cell);
      grid.append(cell);
    }
    grid.addEventListener("click", (e) => {
      const cell = e.target.closest("[data-step]");
      if (!cell) return;
      const s = Number(cell.dataset.step);
      const steps = cycleStep(current.steps, s);
      set({ steps });
      refreshGrid();
      if (steps[s]) onAudition({ accent: steps[s] === 2 });
    });
    refreshGrid = () => {
      cells.forEach((cell, s) => {
        const v = current.steps[s];
        cell.dataset.state = ["", "hit", "accent"][v];
        cell.setAttribute("aria-label", tx.step(s + 1, tx.states[v]));
      });
    };
    paintGrid = paintColumns(cells.map((c) => [c]));
    refreshGrid();
    const double = el("button", { type: "button", class: "ghost", "data-action": "double", text: tx.doubleHits });
    double.title = tx.doubleHitsTitle;
    double.addEventListener("click", () => {
      set({ steps: doubleSteps(current.steps) });
      refreshGrid();
    });
    const clear = el("button", { type: "button", class: "ghost", text: tx.clearAll });
    clear.addEventListener("click", () => {
      set({ steps: current.steps.map(() => 0) });
      refreshGrid();
    });
    const tools = [varyToggle(), ...(def.voice === "kick" ? [buildUpToggle()] : []), double, clear];
    return [legend(tx.drumLegend), wrap(grid), el("div", { class: "editor-actions" }, ...tools)];
  }

  // Kicks: a build-up on the next bar line. Pressed while armed or playing;
  // the app releases it when the bar is over.
  function buildUpToggle() {
    buildUpBtn = el("button", {
      type: "button",
      class: "action toggle",
      "data-action": "build-up",
      "aria-pressed": String(buildUp),
      text: tx.buildUp,
    });
    buildUpBtn.title = tx.buildUpTitle;
    buildUpBtn.addEventListener("click", () => onBuildUp(buildUpBtn.getAttribute("aria-pressed") !== "true"));
    return buildUpBtn;
  }

  /* ---- notes: synth + view controls ---- */
  function noteControls() {
    const synthDetail = el("p", { class: "synth-detail" });
    const showDetail = () => {
      synthDetail.textContent = t().synths[current.synth]?.[1] ?? "";
    };
    showDetail();
    const synth = select(
      tx.synth,
      SYNTHS.map((s) => ({ value: s.id, label: t().synths[s.id][0], group: t().synthGroups[s.group] })),
      current.synth,
      (v) => {
        set({ synth: v });
        showDetail();
      },
      "synth",
    );
    const scale = select(
      tx.scale,
      Object.keys(SCALES).map((value) => ({ value, label: t().scales[value] })),
      current.scale,
      (v) => {
        set({ scale: v });
        refreshGrid();
      },
      "scale",
    );
    const octave = select(
      tx.octave,
      TRANSPOSE.map((t) => ({ value: t, label: t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t) / 12}` })),
      current.transpose,
      (v) => {
        set({ transpose: Number(v) });
        refreshGrid();
      },
      "octave",
    );
    const len = select(
      tx.newNote,
      NOTE_LENGTHS.map((n) => ({ value: n, label: tx.lengths[n] })),
      current.len,
      (v) => set({ len: Number(v) }),
      "len",
    );
    synthOnly.push(synth, synthDetail);
    return [el("div", { class: "pickers" }, ...sourcePicker(), synth, scale, octave, len), synthDetail];
  }

  /* ---- notes: piano roll ---- */
  function pianoRoll() {
    const grid = el("div", { class: "grid roll", role: "group", "aria-label": tx.pianoRoll });
    let rowsKey = "";
    let cellsByKey = new Map(); // "midi:step" -> cell
    let columns = [];
    let drag = null; // { midi, start, end } while painting a long note

    const rows = () => scaleRows(current.scale, def.low, def.high, current.notes.map((n) => n.midi));

    function build() {
      const list = rows();
      rowsKey = `${list.join()}|${current.transpose}`;
      cellsByKey = new Map();
      columns = Array.from({ length: LOOP_STEPS }, () => []);
      grid.replaceChildren(...gridHeader(tx));
      for (const midi of list) {
        const name = noteName(midi + current.transpose, t().noteNames);
        const rowClass = ["row-label", isRoot(midi) && "root", !inScale(midi, current.scale) && "outside"].filter(Boolean);
        grid.append(el("span", { class: rowClass.join(" "), text: name }));
        for (let s = 0; s < LOOP_STEPS; s++) {
          const cell = el("button", {
            type: "button",
            class: cellClass(s) + (isRoot(midi) ? " root" : ""),
            "data-step": String(s),
            "data-midi": String(midi),
          });
          cell.dataset.name = name;
          cellsByKey.set(`${midi}:${s}`, cell);
          columns[s].push(cell);
          grid.append(cell);
        }
      }
      paintGrid = paintColumns(columns);
    }

    refreshGrid = () => {
      if (`${rows().join()}|${current.transpose}` !== rowsKey) build();
      const covered = new Map();
      for (const n of current.notes) {
        for (let s = n.step; s < n.step + n.len; s++) covered.set(`${n.midi}:${s}`, n);
      }
      for (const [key, cell] of cellsByKey) {
        const n = covered.get(key);
        const s = Number(cell.dataset.step);
        cell.dataset.state = n ? (n.accent ? "accent" : "hit") : "";
        cell.classList.toggle("head", Boolean(n) && n.step === s);
        cell.classList.toggle("tail", Boolean(n) && n.step + n.len - 1 === s);
        const what = n ? (n.accent ? tx.accentNote : tx.note) : tx.empty;
        cell.setAttribute("aria-label", tx.cell(cell.dataset.name, s + 1, what));
      }
    };

    const at = (target) => {
      const cell = target.closest?.("[data-midi]");
      return cell ? { cell, midi: Number(cell.dataset.midi), step: Number(cell.dataset.step) } : null;
    };

    grid.addEventListener("click", (e) => {
      const hit = at(e.target);
      if (!hit) return; // a drag that ended on another cell clicks the grid, not a cell
      const notes = cycleNote(current.notes, hit.step, hit.midi, current.len);
      set({ notes });
      refreshGrid();
      const now = notes.find((n) => n.midi === hit.midi && n.step <= hit.step && n.step + n.len > hit.step);
      if (now) onAudition({ midi: hit.midi, accent: now.accent });
    });

    // Mouse drag along a row paints one long note. Touch keeps its scroll:
    // a tap is a click, so it adds a note of the "Nota nueva" length.
    grid.addEventListener("pointerdown", (e) => {
      const hit = at(e.target);
      if (!hit || e.pointerType === "touch" || hit.cell.dataset.state) return;
      drag = { midi: hit.midi, start: hit.step, end: hit.step };
    });
    grid.addEventListener("pointerover", (e) => {
      const hit = drag && at(e.target);
      if (!hit || hit.midi !== drag.midi || hit.step < drag.start) return;
      drag.end = hit.step;
      for (let s = 0; s < LOOP_STEPS; s++) {
        cellsByKey.get(`${drag.midi}:${s}`)?.classList.toggle("preview", s >= drag.start && s <= drag.end);
      }
    });
    const endDrag = () => {
      if (!drag) return;
      const { midi, start, end } = drag;
      drag = null;
      for (const cell of cellsByKey.values()) cell.classList.remove("preview");
      if (end === start) return; // the click handler adds it
      set({ notes: placeNote(current.notes, start, midi, end - start + 1) });
      refreshGrid();
      onAudition({ midi, accent: false });
    };
    window.addEventListener("pointerup", endDrag);
    cleanups.push(() => window.removeEventListener("pointerup", endDrag));
    grid.addEventListener("pointercancel", () => {
      drag = null;
    });

    // The app writes it on the next loop (pressed while it waits), or now.
    newPartBtn = el("button", {
      type: "button",
      class: "ghost",
      "data-action": "new-part",
      "aria-pressed": String(newPart),
      text: tx.newPart,
    });
    newPartBtn.title = tx.newPartTitle;
    newPartBtn.addEventListener("click", () => onNewPart());
    const clear = el("button", { type: "button", class: "ghost", text: tx.clearAll });
    clear.addEventListener("click", () => {
      set({ notes: [] });
      refreshGrid();
    });
    refreshGrid();
    return [
      legend(tx.rollLegend),
      wrap(grid),
      el("div", { class: "editor-actions" }, varyToggle(), newPartBtn, clear),
    ];
  }

  return {
    node,
    id,
    focusName: () => {
      name.focus();
      name.select();
    },
    paint: (step) => paintGrid(step),
    // New data from outside (a variation): redraw without reporting a change.
    show: (data) => {
      current = data;
      refreshGrid();
    },
    showBuildUp: (on) => buildUpBtn?.setAttribute("aria-pressed", String(on)),
    showNewPart: (on) => newPartBtn?.setAttribute("aria-pressed", String(on)),
    showVarying: (on) => {
      varying = on;
      varyBtn?.setAttribute("aria-pressed", String(on));
    },
    destroy: () => cleanups.forEach((fn) => fn()),
  };
}

// beat: first 16th of a beat; alt: beats 2 and 4 of each bar, shaded so the
// beats read as blocks; bar: the line between the two bars.
const cellClass = (s) =>
  `step${s % 4 === 0 ? " beat" : ""}${Math.floor(s / 4) % 2 ? " alt" : ""}${s === 16 ? " bar" : ""}`;

// Two header rows over the 32 columns: the bars, then the beats in each.
function gridHeader(tx) {
  const corner = () => el("span", { class: "row-label head-label" });
  const bars = [0, 1].map((b) =>
    el("span", { class: `bar-head${b ? " bar" : ""}`, style: "grid-column: span 16", text: tx.barN(b + 1) }),
  );
  const beats = Array.from({ length: 8 }, (_, i) =>
    el("span", {
      class: `beat-head${i % 2 ? " alt" : ""}${i === 4 ? " bar" : ""}`,
      style: "grid-column: span 4",
      text: String((i % 4) + 1),
    }),
  );
  return [corner(), ...bars, corner(), ...beats];
}

const legend = (text) => el("p", { class: "legend", text });

// Horizontal scroll lives on this wrapper, never on the page.
const wrap = (grid) => el("div", { class: "grid-wrap" }, grid);

// Playhead: highlights one column of cells, null clears it.
function paintColumns(columns) {
  let shown = null;
  return (step) => {
    if (step === shown) return;
    if (shown !== null) for (const c of columns[shown]) c.classList.remove("is-current");
    if (step !== null) for (const c of columns[step]) c.classList.add("is-current");
    shown = step;
  };
}
