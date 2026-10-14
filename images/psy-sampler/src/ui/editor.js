// The panel a tile's ▾ opens under its layer. One shape per variant kind:
//   drum   one row of 32 steps + the voice's sliders
//   notes  piano roll + synth, brightness, scale, octave, note length
//   fx     just the sliders
// Every kind also picks its source (its own voice or one of the user's
// samples, which swaps the voice's sliders for the sample's) and has a
// filter + distortion section (the insert).
// The sections under the sliders (insert, modulation, space, pattern) fold;
// the header, the source, the sliders and the grid never do.
// Every change goes out through onChange(next) as fresh data; the editor
// never talks to the engine itself. The header names the variant (editable)
// and carries the per-sound actions: duplicate, WAV, reset (the part alone,
// or the whole sound), delete (copies).
import { DRIVE_TYPES, FILTER_TYPES, LFO_RATES, LFO_SHAPES, TREM_RATES, VOWELS } from "../audio/insert.js";
import { GROOVE_PARAMS, INSERT_PARAMS, LEVEL, SAMPLE_PARAMS, SYNTHS } from "../audio/params.js";
import {
  CHANCES,
  COND_EVERY,
  ECHO_SEMIS,
  ECHO_STEPS,
  ITERS,
  NOTE_LENGTHS,
  PART_LOOPS,
  PLIES,
  SPEEDS,
  TRANSPOSE,
  cleanMod,
  defOf,
  isCopy,
  paramSpecs,
  partSteps,
  sampleDefaults,
} from "../audio/patterns.js";
import { SCALES, inScale, isRoot, noteName, scaleRows } from "../audio/music.js";
import { LOOP_STEPS } from "../audio/timing.js";
import {
  brushAllNotes,
  brushAllSteps,
  brushNote,
  brushStep,
  cycleNote,
  cycleNoteEcho,
  cycleStep,
  cycleStepEcho,
  placeNote,
  pruneMods,
  rotatePart,
} from "../editing.js";
import { foldActive } from "../folds.js";
import { t } from "../i18n/index.js";
import { amountSlider, checkbox, el, nextId, select, slider } from "./dom.js";

const localized = (spec) => ({ ...spec, label: t().params[spec.label] });

// What a click on a grid does: "hit" writes hits and notes (the plain
// click), the others put that mod key, at its value here, on them.
const BRUSHES = ["hit", "p", "cond", "ply"];
export const BRUSH = { kind: "hit", p: 0.5, cond: "1:2", ply: 2 };
const isDefaultBrush = (b) => BRUSHES.every((k) => b[k] === BRUSH[k]) && b.kind === BRUSH.kind;

// The drum editors' euclidean rhythm: k hits over n steps, started rot in.
export const EUCLID = { k: 3, n: 8, rot: 0 };
const EUCLID_N = [...Array.from({ length: 14 }, (_, i) => i + 3), 32];

export function createEditor({
  id,
  label,
  data,
  brush = { ...BRUSH }, // the app's, mutated here so every editor shares it
  euclid = { ...EUCLID }, // the same for the euclid picker
  folds = {}, // which foldable sections are open (folds.js), the app's and shared the same way
  onFold = () => {}, // one was opened or folded
  onEdit = () => {}, // a part edit that lands on the bar line: "reverse", "euclid"
  onChange,
  onAudition,
  onReset,
  onResetPart,
  onDouble,
  queued = new Set(), // the actions among ×2 and the resets waiting for the bar line
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
  let refreshPages = () => {}; // the piano roll's page tabs, after a length change
  let paintRoll = null; // the piano roll's playhead, which pages
  let showBrush = () => {};
  let buildUpBtn = null;
  let varyBtn = null;
  let paintAmount = () => {};
  let newPartBtn = null;
  let tone = null; // { hp, lp }: the tone sliders, once the insert box is built
  const cleanups = [];
  const foldMarks = []; // repaint each section's "on" flag

  function set(patch) {
    current = { ...current, ...patch };
    onChange(current);
    showBrush();
    paintFolds();
  }

  /* ---- a foldable section: a <details> whose summary flags it while it
     still changes the sound, so folding never hides a filter that is on ---- */
  function fold(key, title, ...children) {
    const on = el("span", { class: "fold-on", text: tx.foldOn });
    const box = el(
      "details",
      { class: `fold ${key}`, "data-fold": key },
      el("summary", {}, el("span", { text: title }), on),
      el("div", { class: "fold-body" }, ...children),
    );
    box.open = Boolean(folds[key]);
    box.addEventListener("toggle", () => {
      if (folds[key] === box.open) return; // the initial open above fires one too
      folds[key] = box.open;
      onFold(key, box.open);
    });
    const paint = () => {
      on.hidden = !foldActive(key, current);
    };
    foldMarks.push(paint);
    paint();
    return box;
  }
  const paintFolds = () => foldMarks.forEach((paint) => paint());

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
    paintAmount = () => {
      const pct = Math.round(amount * 100);
      b.style.setProperty("--amount", `${pct}%`);
      text.textContent = tx.improviseAmount(pct);
    };
    amountSlider(b, {
      get: () => amount,
      set: (v) => {
        amount = v;
        paintAmount();
        onAmount(amount);
      },
      at: (e) => {
        const r = b.getBoundingClientRect();
        return (e.clientX - r.left) / r.width;
      },
      onClick: () => {
        varying = !varying;
        b.setAttribute("aria-pressed", String(varying));
        onVary(varying);
      },
    });
    paintAmount();
    return b;
  }

  /* ---- the brush: what a click on the grid does ---- */
  // `legendText` is the grid's own help, shown while a click writes;
  // `applyAll` puts the brush's value on every hit or note, `clearAll`
  // takes every mod off.
  function brushControls(legendText, applyAll, clearAll) {
    const help = legend("");
    const value = (key, options) =>
      select(tx.brushValue, options, brush[key], (v) => {
        brush[key] = key === "cond" ? v : Number(v);
        show();
      }, `brush-${key}`);
    const values = {
      p: value("p", CHANCES.filter((p) => p < 1).map((p) => ({ value: p, label: tx.chances[p] }))),
      cond: value(
        "cond",
        COND_EVERY.flatMap((b) => {
          const conds = Array.from({ length: b }, (_, i) => `${i + 1}:${b}`);
          return [...conds, ...conds.map((c) => `!${c}`)].map((c) => ({ value: c, label: tx.cond(c), group: tx.condEvery(b) }));
        }),
      ),
      ply: value("ply", PLIES.filter((n) => n > 1).map((n) => ({ value: n, label: tx.ply(n) }))),
    };
    const modes = BRUSHES.map((k) => {
      const b = el("button", { type: "button", class: "seg", "data-brush": k, text: tx.brushes[k] });
      b.title = tx.brushTitles[k];
      b.addEventListener("click", () => {
        brush.kind = k;
        show();
      });
      return b;
    });
    const action = (name, text, title, fn) => {
      const b = el("button", { type: "button", class: "ghost", "data-action": name, text });
      b.title = title;
      b.addEventListener("click", () => {
        fn();
        refreshGrid();
        show();
      });
      return b;
    };
    const all = action("brush-all", tx.applyAll, tx.applyAllTitle, () => applyAll(brush.kind, brush[brush.kind]));
    const clear = action("brush-clear", tx.clearMods, tx.clearModsTitle, clearAll);
    const reset = action("brush-reset", tx.brushReset, tx.brushResetTitle, () => {
      Object.assign(brush, BRUSH);
      for (const [key, node] of Object.entries(values)) node.querySelector("select").value = String(brush[key]);
    });
    function show() {
      for (const b of modes) b.setAttribute("aria-pressed", String(b.dataset.brush === brush.kind));
      for (const [key, node] of Object.entries(values)) node.hidden = key !== brush.kind;
      all.hidden = brush.kind === "hit";
      clear.hidden = !hasMods();
      reset.hidden = isDefaultBrush(brush);
      help.textContent = brush.kind === "hit" ? legendText : tx.modLegend;
    }
    showBrush = show;
    show();
    const group = el(
      "div",
      { class: "segmented", role: "group", "aria-label": tx.brush },
      el("span", { class: "seg-label", text: tx.brush }),
      ...modes,
    );
    return [el("div", { class: "pickers brush" }, group, ...Object.values(values), all, clear, reset), help];
  }

  const hasMods = () =>
    def.kind === "drum" ? current.mods.some((m, s) => m && current.steps[s]) : current.notes.some((n) => cleanMod(n));

  /* ---- pattern: how the part is read, and edits of the whole part ---- */
  // Speed, iter and echo change how the loop reads the part (Strudel's
  // fast/slow, iter, off) without rewriting it; the buttons rewrite it.
  function patternControls() {
    const speed = select(
      tx.speed,
      SPEEDS.map((v) => ({ value: v, label: tx.speeds[v] })),
      current.speed,
      (v) => set({ speed: Number(v) }),
      "speed",
    );
    const iter = select(
      tx.iter,
      ITERS.map((v) => ({ value: v, label: tx.iters[v] })),
      current.iter,
      (v) => set({ iter: Number(v) }),
      "iter",
    );
    const semis = select(
      tx.echoSemis,
      ECHO_SEMIS.map((v) => ({ value: v, label: tx.semis[v] })),
      current.echo?.semis ?? 0,
      (v) => set({ echo: { ...current.echo, semis: Number(v) } }),
      "echo-semis",
    );
    const echo = select(
      tx.echo,
      [0, ...ECHO_STEPS].map((v) => ({ value: v, label: tx.echoes[v] })),
      current.echo?.steps ?? 0,
      (v) => {
        const steps = Number(v);
        set({ echo: steps ? { steps, semis: current.echo?.semis ?? 0 } : null });
        showSemis();
      },
      "echo",
    );
    const showSemis = () => {
      semis.hidden = def.kind === "drum" || !current.echo;
    };
    showSemis();
    const button = (name, text, title, fn) => {
      const b = el("button", { type: "button", class: "ghost", "data-action": name, text });
      b.title = title;
      b.addEventListener("click", fn);
      return b;
    };
    // One 16th either way, right away, like a click on the grid.
    const rotate = (by) => () => {
      set(rotatePart(current, def.kind, by));
      refreshGrid();
    };
    const tools = [
      button("rotate-left", tx.rotateLeft, tx.rotateTitle, rotate(-1)),
      button("rotate-right", tx.rotateRight, tx.rotateTitle, rotate(1)),
      waits(button("reverse", tx.retro, tx.retroTitle, () => onEdit("reverse"))),
    ];
    const rows = [el("div", { class: "pickers" }, speed, iter, echo, semis), el("div", { class: "editor-actions" }, ...tools)];
    if (def.kind === "drum") rows.push(euclidControls(button));
    return fold("pattern", tx.pattern, ...rows, legend(tx.patternLegend));
  }

  function euclidControls(button) {
    const pick = (key, label, options) =>
      select(label, options.map((v) => ({ value: v, label: String(v) })), euclid[key], (v) => {
        euclid[key] = Number(v);
        fit();
      }, `euclid-${key}`);
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const k = pick("k", tx.euclidHits, range(1, 32));
    const n = pick("n", tx.euclidOver, EUCLID_N);
    const rot = pick("rot", tx.euclidRot, range(0, 31));
    // k and rot only go as far as n.
    const fit = () => {
      euclid.k = Math.min(euclid.k, euclid.n);
      euclid.rot = Math.min(euclid.rot, euclid.n - 1);
      for (const [node, max, key] of [[k, euclid.n, "k"], [rot, euclid.n - 1, "rot"]]) {
        const sel = node.querySelector("select");
        for (const o of sel.options) o.hidden = Number(o.value) > max;
        sel.value = String(euclid[key]);
      }
    };
    fit();
    const apply = waits(button("euclid", tx.euclidApply, tx.euclidTitle, () => onEdit("euclid")));
    return el("div", { class: "pickers euclid" }, el("span", { class: "seg-label", text: tx.euclid }), k, n, rot, apply);
  }

  // A hit's or note's mod on its cell: stripes when it may not play, and a
  // short tag (condition, else ratchet, else chance); the title says it all.
  function markMod(cell, mod, tag = true) {
    const m = cleanMod(mod);
    cell.toggleAttribute("data-chance", Boolean(m?.p));
    const short = m && tag ? (m.cond ?? (m.ply ? `×${m.ply}` : m.p ? String(Math.round(m.p * 100)) : "")) : "";
    if (short) cell.dataset.mod = short;
    else delete cell.dataset.mod;
    cell.title = m ? modParts(m).join(" · ") : "";
    return m ? tx.modText(modParts(m)) : "";
  }
  const modParts = (m) => [m.p && tx.chances[m.p], m.cond && tx.cond(m.cond), m.ply && tx.ply(m.ply)].filter(Boolean);

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
    ...(def.kind === "fx"
      ? []
      : [[button("reset-part", def.kind === "drum" ? tx.resetHits : tx.resetNotes, tx.resetPartTitle), onResetPart]]),
    [button("reset", tx.reset, tx.resetTitle), onReset],
    ...(isCopy(id) ? [[button("remove", tx.remove), onRemove]] : []),
    [button("close", tx.close), onClose],
  ];
  for (const [b, fn] of actions) b.addEventListener("click", () => fn());
  const waits = (b) => {
    b.setAttribute("aria-pressed", String(queued.has(b.dataset.action)));
    return b;
  };
  for (const [b] of actions) if (["reset", "reset-part"].includes(b.dataset.action)) waits(b);
  const head = el(
    "div",
    { class: "editor-head" },
    el("label", { class: "name-field" }, el("span", { text: tx.name }), name),
    el("div", { class: "editor-tools" }, ...actions.map(([b]) => b)),
  );

  /* ---- sliders: the voice's params (or the sample's) + volume ---- */
  const voiceKnobs = el("div", { class: "knob-group" });
  const level = slider(localized(LEVEL), current.level, (v) => set({ level: v }));
  const knobs = el("div", { class: "knobs" }, voiceKnobs, level);
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
    const knob = (key, after = () => {}) => {
      const spec = INSERT_PARAMS.find((p) => p.key === key);
      return slider(localized(spec), ins()[key], (v) => {
        setInsert({ [key]: v });
        after();
      });
    };
    const pick = (label, list, key, labels, name, after = () => {}) =>
      select(
        label,
        list.map((v) => ({ value: v, label: labels[v] })),
        ins()[key],
        (v) => {
          setInsert({ [key]: typeof list[0] === "number" ? Number(v) : v });
          after();
        },
        name,
      );
    const cutoff = knob("cutoff");
    const filterKnobs = [knob("res"), knob("lfo"), knob("env", () => show())];
    const envDecay = knob("envDecay");
    const rate = pick(tx.lfoRate, LFO_RATES, "rate", tx.lfoRates, "lfo-rate");
    const shape = pick(tx.lfoShape, LFO_SHAPES, "shape", tx.lfoShapes, "lfo-shape");
    const vowel = pick(tx.vowel, Object.keys(VOWELS), "vowel", Object.fromEntries(Object.keys(VOWELS).map((v) => [v, v.toUpperCase()])), "vowel");
    const drive = knob("amount");
    // The tone: the sound's own highpass and lowpass, always there (open at
    // either end). The autopilot rides them too, like the volume.
    const hp = knob("hp");
    const lp = knob("lp");
    tone = { hp, lp };
    const show = () => {
      const off = ins().filter === "off";
      for (const n of [...filterKnobs, rate, shape]) n.hidden = off;
      cutoff.hidden = off || ins().filter === "vowel";
      vowel.hidden = ins().filter !== "vowel";
      envDecay.hidden = off || !ins().env;
      drive.hidden = ins().drive === "off";
    };
    const filterType = pick(tx.filter, FILTER_TYPES, "filter", tx.filterTypes, "filter", () => show());
    const driveType = pick(tx.drive, DRIVE_TYPES, "drive", tx.driveTypes, "drive", () => show());
    show();
    return fold(
      "insert",
      tx.insert,
      el("div", { class: "pickers" }, filterType, vowel, rate, shape, driveType),
      el("div", { class: "knobs" }, cutoff, ...filterKnobs, envDecay, drive, hp, lp),
    );
  }

  /* ---- modulation: phaser and tremolo, in time ---- */
  function modulationControls() {
    const setInsert = (patch) => set({ insert: { ...current.insert, ...patch } });
    const pair = (key, rateKey, rates, labels) => {
      const spec = INSERT_PARAMS.find((p) => p.key === key);
      const rate = select(
        tx.every,
        rates.map((n) => ({ value: n, label: labels[n] })),
        current.insert[rateKey],
        (v) => setInsert({ [rateKey]: Number(v) }),
        `${key}-rate`,
      );
      const amount = slider(localized(spec), current.insert[key], (v) => {
        setInsert({ [key]: v });
        rate.hidden = !v;
      });
      rate.hidden = !current.insert[key];
      return el("div", { class: "mod-pair" }, amount, rate);
    };
    // A mix and the knobs it opens: they only show while the mix is up.
    const group = (key, rest) => {
      const knob = (k, after = () => {}) => {
        const spec = INSERT_PARAMS.find((p) => p.key === k);
        return slider(localized(spec), current.insert[k], (v) => {
          setInsert({ [k]: v });
          after(v);
        });
      };
      const opened = rest.map((k) =>
        k === "combRate"
          ? select(
              tx.every,
              LFO_RATES.map((n) => ({ value: n, label: tx.lfoRates[n] })),
              current.insert.combRate,
              (v) => setInsert({ combRate: Number(v) }),
              "comb-rate",
            )
          : knob(k),
      );
      const show = (v) => opened.forEach((n) => (n.hidden = !v));
      show(current.insert[key]);
      return el("div", { class: "mod-pair" }, knob(key, show), ...opened);
    };
    return fold(
      "modulation",
      tx.modulation,
      el(
        "div",
        { class: "knobs" },
        pair("phaser", "phaserRate", LFO_RATES, tx.lfoRates),
        pair("trem", "tremRate", TREM_RATES, tx.tremRates),
        group("comb", ["combHz", "combFb", "combMod", "combRate"]),
        group("shift", ["shiftHz"]),
      ),
      legend(tx.modulationLegend),
    );
  }

  /* ---- groove and space: swing, nudge, duck; pan and autopan ---- */
  function spaceControls() {
    const setInsert = (patch) => set({ insert: { ...current.insert, ...patch } });
    const panKnob = (key) => {
      const spec = INSERT_PARAMS.find((p) => p.key === key);
      return slider(localized(spec), current.insert[key], (v) => {
        setInsert({ [key]: v });
        showRate();
      });
    };
    const panRate = select(
      tx.panRate,
      LFO_RATES.map((n) => ({ value: n, label: tx.lfoRates[n] })),
      current.insert.panRate,
      (v) => setInsert({ panRate: Number(v) }),
      "pan-rate",
    );
    const showRate = () => {
      panRate.hidden = !current.insert.width;
    };
    showRate();
    // FX are one-shots: no grid to swing, nothing for the kick to duck.
    const groove =
      def.kind === "fx"
        ? []
        : GROOVE_PARAMS.filter((p) => !(p.key === "duck" && def.voice === "kick")).map((spec) =>
            slider(localized(spec), current[spec.key], (v) => set({ [spec.key]: v })),
          );
    return fold(
      "space",
      def.kind === "fx" ? tx.spaceFx : tx.space,
      el("div", { class: "knobs" }, ...groove, panKnob("pan"), panKnob("width")),
      el("div", { class: "pickers" }, panRate),
      legend(def.kind === "fx" ? tx.spaceFxLegend : tx.spaceLegend),
    );
  }

  const node = el("div", { class: "editor", role: "region", "aria-label": tx.region(label), "data-editor": id }, head);
  const source = el("div", { class: "pickers source" }, ...sourcePicker());

  if (def.kind === "fx") {
    const fire = el("button", { type: "button", class: "action", text: tx.fire });
    fire.addEventListener("click", onTrigger);
    node.append(source, knobs, insertControls(), modulationControls(), spaceControls(), el("div", { class: "editor-actions" }, fire));
  } else if (def.kind === "drum") {
    node.append(source, knobs, insertControls(), modulationControls(), spaceControls(), ...drumGrid());
  } else {
    node.append(...noteControls(), knobs, insertControls(), modulationControls(), spaceControls(), ...pianoRoll());
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
      if (brush.kind === "hit") {
        const steps = echoing(e) ? cycleStepEcho(current.steps, s, e.shiftKey) : cycleStep(current.steps, s);
        set({ steps, mods: pruneMods(steps, current.mods) });
      } else {
        set(brushStep(current, s, brush.kind, brush[brush.kind], { echo: echoing(e), bothBars: e.shiftKey }));
      }
      refreshGrid();
      if (current.steps[s]) onAudition({ accent: current.steps[s] === 2 });
    });
    refreshGrid = () => {
      cells.forEach((cell, s) => {
        const v = current.steps[s];
        cell.dataset.state = ["", "hit", "accent"][v];
        const mod = markMod(cell, v ? current.mods[s] : null);
        cell.setAttribute("aria-label", tx.step(s + 1, tx.states[v]) + mod);
      });
    };
    paintGrid = paintColumns(cells.map((c) => [c]));
    refreshGrid();
    const double = waits(el("button", { type: "button", class: "ghost", "data-action": "double", text: tx.doubleHits }));
    double.title = tx.doubleHitsTitle;
    double.addEventListener("click", () => onDouble());
    const clear = el("button", { type: "button", class: "ghost", text: tx.clearAll });
    clear.addEventListener("click", () => {
      set({ steps: current.steps.map(() => 0), mods: current.mods.map(() => null) });
      refreshGrid();
    });
    const tools = [varyToggle(), ...(def.voice === "kick" ? [buildUpToggle()] : []), double, clear];
    const brushRow = brushControls(
      tx.drumLegend,
      (key, value) => set(brushAllSteps(current, key, value)),
      () => set({ mods: current.mods.map(() => null) }),
    );
    return [...brushRow, wrap(grid), el("div", { class: "editor-actions" }, ...tools), patternControls()];
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
    // A shorter part drops what no longer fits in it.
    const loops = select(
      tx.partLength,
      PART_LOOPS.map((n) => ({ value: n, label: tx.partLengths(n * 2) })),
      current.loops ?? 1,
      (v) => {
        const size = Number(v) * LOOP_STEPS;
        const notes = current.notes
          .filter((n) => n.step < size)
          .map((n) => (n.step + n.len > size ? { ...n, len: size - n.step } : n));
        set({ loops: Number(v), notes });
        refreshPages();
        refreshGrid();
      },
      "loops",
    );
    synthOnly.push(synth, synthDetail);
    return [el("div", { class: "pickers" }, ...sourcePicker(), synth, scale, octave, len, loops), synthDetail];
  }

  /* ---- notes: piano roll ---- */
  function pianoRoll() {
    const grid = el("div", { class: "grid roll", role: "group", "aria-label": tx.pianoRoll });
    let rowsKey = "";
    let cellsByKey = new Map(); // "midi:step" -> cell
    let columns = [];
    let drag = null; // { midi, start, end } while painting a long note
    // A part longer than a loop shows one loop (2 bars) at a time: `page`.
    // Cells carry the part step, so every edit sees the whole part.
    let page = 0;
    const off = () => page * LOOP_STEPS;
    const size = () => partSteps(current);
    const pages = el("div", { class: "seg roll-pages", role: "group", "aria-label": tx.rollPages });

    const rows = () => scaleRows(current.scale, def.low, def.high, current.notes.map((n) => n.midi));
    const key = () => `${rows().join()}|${current.transpose}|${page}`;

    refreshPages = () => {
      const count = current.loops ?? 1;
      if (page >= count) page = 0;
      pages.hidden = count === 1;
      pages.replaceChildren(
        ...Array.from({ length: count }, (_, i) => {
          const b = el("button", { type: "button", class: "ghost", text: `${i * 2 + 1}-${i * 2 + 2}` });
          b.setAttribute("aria-pressed", String(i === page));
          b.addEventListener("click", () => {
            page = i;
            refreshPages();
            refreshGrid();
          });
          return b;
        }),
      );
    };

    function build() {
      const list = rows();
      rowsKey = key();
      cellsByKey = new Map();
      columns = Array.from({ length: LOOP_STEPS }, () => []);
      grid.replaceChildren(...gridHeader(tx, page));
      for (const midi of list) {
        const name = noteName(midi + current.transpose, t().noteNames);
        const rowClass = ["row-label", isRoot(midi) && "root", !inScale(midi, current.scale) && "outside"].filter(Boolean);
        grid.append(el("span", { class: rowClass.join(" "), text: name }));
        for (let s = 0; s < LOOP_STEPS; s++) {
          const cell = el("button", {
            type: "button",
            class: cellClass(s) + (isRoot(midi) ? " root" : ""),
            "data-step": String(off() + s),
            "data-midi": String(midi),
          });
          cell.dataset.name = name;
          cellsByKey.set(`${midi}:${off() + s}`, cell);
          columns[s].push(cell);
          grid.append(cell);
        }
      }
      paintGrid = paintColumns(columns);
    }

    refreshGrid = () => {
      if (key() !== rowsKey) build();
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
        const mod = markMod(cell, n, n?.step === s);
        const what = n ? (n.accent ? tx.accentNote : tx.note) : tx.empty;
        cell.setAttribute("aria-label", tx.cell(cell.dataset.name, s + 1, what) + mod);
      }
    };

    const at = (target) => {
      const cell = target.closest?.("[data-midi]");
      return cell ? { cell, midi: Number(cell.dataset.midi), step: Number(cell.dataset.step) } : null;
    };

    grid.addEventListener("click", (e) => {
      const hit = at(e.target);
      if (!hit) return; // a drag that ended on another cell clicks the grid, not a cell
      const echo = { echo: echoing(e), bothBars: e.shiftKey };
      const notes =
        brush.kind !== "hit"
          ? brushNote(current.notes, hit.step, hit.midi, current.len, brush.kind, brush[brush.kind], { ...echo, size: size() })
          : echo.echo
            ? cycleNoteEcho(current.notes, hit.step, hit.midi, current.len, e.shiftKey, size())
            : cycleNote(current.notes, hit.step, hit.midi, current.len, size());
      set({ notes });
      refreshGrid();
      const now = notes.find((n) => n.midi === hit.midi && n.step <= hit.step && n.step + n.len > hit.step);
      if (now) onAudition({ midi: hit.midi, accent: now.accent });
    });

    // Mouse drag along a row paints one long note. Touch keeps its scroll:
    // a tap is a click, so it adds a note of the "Nota nueva" length.
    grid.addEventListener("pointerdown", (e) => {
      const hit = at(e.target);
      if (!hit || e.pointerType === "touch" || hit.cell.dataset.state || brush.kind !== "hit") return;
      drag = { midi: hit.midi, start: hit.step, end: hit.step };
    });
    grid.addEventListener("pointerover", (e) => {
      const hit = drag && at(e.target);
      if (!hit || hit.midi !== drag.midi || hit.step < drag.start) return;
      drag.end = hit.step;
      for (let s = off(); s < off() + LOOP_STEPS; s++) {
        cellsByKey.get(`${drag.midi}:${s}`)?.classList.toggle("preview", s >= drag.start && s <= drag.end);
      }
    });
    const endDrag = () => {
      if (!drag) return;
      const { midi, start, end } = drag;
      drag = null;
      for (const cell of cellsByKey.values()) cell.classList.remove("preview");
      if (end === start) return; // the click handler adds it
      set({ notes: placeNote(current.notes, start, midi, end - start + 1, size()) });
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
    refreshPages();
    refreshGrid();
    // The playhead: `step` is the part step playing, on whichever page it is.
    paintRoll = (step) => paintGrid(step === null || Math.floor(step / LOOP_STEPS) !== page ? null : step % LOOP_STEPS);
    return [
      ...brushControls(
        tx.rollLegend,
        (key, value) => set({ notes: brushAllNotes(current.notes, key, value) }),
        () => set({ notes: current.notes.map(({ step, midi, len, accent }) => ({ step, midi, len, accent })) }),
      ),
      pages,
      wrap(grid),
      el("div", { class: "editor-actions" }, varyToggle(), newPartBtn, clear),
      patternControls(),
    ];
  }

  return {
    node,
    id,
    focusName: () => {
      name.focus();
      name.select();
    },
    paint: (step) => (paintRoll ? paintRoll(step) : paintGrid(step)),
    // New data from outside (a variation): redraw without reporting a change.
    show: (data) => {
      current = data;
      refreshPages();
      refreshGrid();
      showBrush();
      paintFolds();
    },
    // The volume, set from the tile's fill.
    showLevel: (v) => {
      current = { ...current, level: v };
      level.querySelector("input").value = String(v);
      level.querySelector("output").textContent = LEVEL.fmt(v);
    },
    // The tone filters, ridden by the autopilot.
    showTone: (insert) => {
      current = { ...current, insert: { ...current.insert, hp: insert.hp, lp: insert.lp } };
      for (const key of ["hp", "lp"]) tone?.[key].setValue(insert[key]);
      paintFolds();
    },
    // Where a ride is now, on its way to the tone showTone() set: the knobs only.
    showToneAt: (at) => {
      for (const key of ["hp", "lp"]) tone?.[key].setValue(Math.round(at[key]));
    },
    showBuildUp: (on) => buildUpBtn?.setAttribute("aria-pressed", String(on)),
    showNewPart: (on) => newPartBtn?.setAttribute("aria-pressed", String(on)),
    showQueued: (action, on) => node.querySelector(`[data-action="${action}"]`)?.setAttribute("aria-pressed", String(on)),
    showAmount: (v) => {
      amount = v;
      paintAmount();
    },
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

// Two header rows over the 32 columns: the bars (of `page`), then the beats in each.
function gridHeader(tx, page = 0) {
  const corner = () => el("span", { class: "row-label head-label" });
  const bars = [0, 1].map((b) =>
    el("span", { class: `bar-head${b ? " bar" : ""}`, style: "grid-column: span 16", text: tx.barN(page * 2 + b + 1) }),
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

// Ctrl+click (⌘ on a Mac, where Ctrl+click is a right click) repeats the
// change on every beat of the bar; with Shift, of both bars.
const echoing = (e) => e.ctrlKey || e.metaKey;

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
