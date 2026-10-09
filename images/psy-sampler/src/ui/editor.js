// The panel a tile's ▾ opens under its layer. One shape per variant kind:
//   drum   one row of 32 steps + the voice's sliders
//   notes  piano roll + synth, brightness, scale, octave, note length
//   fx     just the sliders
// Every change goes out through onChange(next) as fresh data; the editor
// never talks to the engine itself.
import { LEVEL, SYNTHS } from "../audio/params.js";
import { DEFAULTS, NOTE_LENGTHS, TRANSPOSE, paramSpecs } from "../audio/patterns.js";
import { SCALES, inScale, isRoot, noteName, scaleRows } from "../audio/music.js";
import { LOOP_STEPS } from "../audio/timing.js";
import { cycleNote, cycleStep, improvise, placeNote } from "../editing.js";
import { el, select, slider } from "./dom.js";

const LENGTH_LABELS = { 1: "1/16", 2: "1/8", 4: "1/4", 8: "1/2", 16: "1 compás", 32: "2 compases" };
const STATE_NAMES = ["vacío", "golpe", "acento"];

export function createEditor({ id, label, data, onChange, onAudition, onReset, onClose, onTrigger }) {
  const def = DEFAULTS[id];
  let current = data;
  let paintGrid = () => {};
  let refreshGrid = () => {};
  const cleanups = [];

  function set(patch) {
    current = { ...current, ...patch };
    onChange(current);
  }

  /* ---- header ---- */
  const head = el(
    "div",
    { class: "editor-head" },
    el("h3", { text: `Editar: ${label}` }),
    el("button", { type: "button", class: "ghost", "data-action": "reset", text: "Restaurar" }),
    el("button", { type: "button", class: "ghost", "data-action": "close", text: "Cerrar ▴" }),
  );
  head.querySelector('[data-action="reset"]').addEventListener("click", onReset);
  head.querySelector('[data-action="close"]').addEventListener("click", onClose);

  /* ---- sliders: the voice's params + volume ---- */
  const knobs = el("div", { class: "knobs" });
  for (const spec of paramSpecs(id)) {
    knobs.append(slider(spec, current.params[spec.key], (v) => set({ params: { ...current.params, [spec.key]: v } })));
  }
  knobs.append(slider(LEVEL, current.level, (v) => set({ level: v })));

  const node = el("div", { class: "editor", role: "region", "aria-label": `Editor de ${label}`, "data-editor": id }, head);

  if (def.kind === "fx") {
    const fire = el("button", { type: "button", class: "action", text: "▶ Disparar" });
    fire.addEventListener("click", onTrigger);
    node.append(knobs, el("div", { class: "editor-actions" }, fire));
  } else if (def.kind === "drum") {
    node.append(knobs, ...drumGrid());
  } else {
    node.append(...noteControls(), knobs, ...pianoRoll());
  }

  /* ---- drums: one row ---- */
  function drumGrid() {
    const cells = [];
    const grid = el("div", { class: "grid", role: "group", "aria-label": "Pasos" }, el("span", { class: "row-label", text: "Golpes" }));
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
        cell.setAttribute("aria-label", `Paso ${s + 1}: ${STATE_NAMES[v]}`);
      });
    };
    paintGrid = paintColumns(cells.map((c) => [c]));
    refreshGrid();
    const clear = el("button", { type: "button", class: "ghost", text: "Borrar todo" });
    clear.addEventListener("click", () => {
      set({ steps: current.steps.map(() => 0) });
      refreshGrid();
    });
    return [legend("Clic: golpe → acento → vacío."), wrap(grid), el("div", { class: "editor-actions" }, clear)];
  }

  /* ---- notes: synth + view controls ---- */
  function noteControls() {
    const synthDetail = el("p", { class: "synth-detail" });
    const showDetail = () => {
      synthDetail.textContent = SYNTHS.find((s) => s.id === current.synth)?.detail ?? "";
    };
    showDetail();
    const synth = select(
      "Sinte",
      SYNTHS.map((s) => ({ value: s.id, label: s.label, group: s.group })),
      current.synth,
      (v) => {
        set({ synth: v });
        showDetail();
      },
      "synth",
    );
    const scale = select(
      "Escala",
      Object.entries(SCALES).map(([value, s]) => ({ value, label: s.label })),
      current.scale,
      (v) => {
        set({ scale: v });
        refreshGrid();
      },
      "scale",
    );
    const octave = select(
      "Octava",
      TRANSPOSE.map((t) => ({ value: t, label: t === 0 ? "0" : `${t > 0 ? "+" : "−"}${Math.abs(t) / 12}` })),
      current.transpose,
      (v) => {
        set({ transpose: Number(v) });
        refreshGrid();
      },
      "octave",
    );
    const len = select(
      "Nota nueva",
      NOTE_LENGTHS.map((n) => ({ value: n, label: LENGTH_LABELS[n] })),
      current.len,
      (v) => set({ len: Number(v) }),
      "len",
    );
    return [el("div", { class: "pickers" }, synth, scale, octave, len), synthDetail];
  }

  /* ---- notes: piano roll ---- */
  function pianoRoll() {
    const grid = el("div", { class: "grid roll", role: "group", "aria-label": "Piano roll" });
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
      grid.replaceChildren();
      for (const midi of list) {
        const name = noteName(midi + current.transpose);
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
        const what = n ? (n.accent ? "nota con acento" : "nota") : "vacío";
        cell.setAttribute("aria-label", `${cell.dataset.name}, paso ${s + 1}: ${what}`);
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

    const improv = el("button", { type: "button", class: "action", text: "🎲 Improvisar" });
    improv.addEventListener("click", () => {
      const style = id.startsWith("perc.") ? "perc" : id.split(".")[0];
      set({ notes: improvise(style, scaleRows(current.scale, def.low, def.high)) });
      refreshGrid();
    });
    const clear = el("button", { type: "button", class: "ghost", text: "Borrar todo" });
    clear.addEventListener("click", () => {
      set({ notes: [] });
      refreshGrid();
    });
    refreshGrid();
    return [
      legend("Clic: nota → acento → borrar. Arrastrá a lo largo de una fila para una nota larga."),
      wrap(grid),
      el("div", { class: "editor-actions" }, improv, clear),
    ];
  }

  return {
    node,
    id,
    paint: (step) => paintGrid(step),
    destroy: () => cleanups.forEach((fn) => fn()),
  };
}

const cellClass = (s) => `step${s % 4 === 0 ? " beat" : ""}${s === 16 ? " bar" : ""}`;

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
