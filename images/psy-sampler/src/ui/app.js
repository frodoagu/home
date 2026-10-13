// DOM wiring. Holds the workspace (everything remembered, workspace.js) and
// the live selection, renders them, and forwards changes to the engine; all
// timing lives in the engine. Changes that must land on the grid (queued
// clicks, the autopilot, improvise variations) run in the engine's bar hook.
// Snapshots recall a saved mix (and the data it played) on the next bar line;
// a BPM change ramps there too, one slice per bar. The autopilot dresses each
// sound it brings in from the seed (dress.js) and writes new melodies; it
// also rides each sound's volume and tone filters, decides which sounds
// improvise, and drops into its peaks (a kick roll, a bar without kick and
// bass under a sweep, then everything). 💥 does that drop by hand. The
// snapshot autopilot plays the snapshots one after another instead.
// Switching language, importing a preset, opening a share link and resetting
// everything rebuild the app through remount(), carrying what is playing.
// The ✨ AI (planner.js, ai.js) first asks a model for the form of the track
// (the order of its next FORM sections), then for the sections ahead, one after
// another until AHEAD of them are planned; the pilot takes the next one's plan
// before the playing section's last loop. From silence it plans before ▶: the
// opening first (the section the track starts with, laid over the seed's
// draw), then the first AHEAD, while the autopilot waits armed. A share
// link's opening and plans stand in for it section by section. A style picked
// while the pilot plays comes in on its next drop out of a breakdown; the BPM
// rides that break into the style's range, and the plans from the drop on are
// asked in the new style.
// The signed-in user's samples (samples.js) load as the sounds using them
// need them; until then those sounds play their own voice. The record button
// drives recorder.js, which outlives remounts like the engine.
import { CLOUDS, CLOUD_IDS, LMSTUDIO_URL, cleanEndpoint, cleanKey, isCloud, loadPrefs, savePrefs } from "../ai.js";
import { SAMPLE_TEMPLATES, layerById } from "../catalog.js";
import { scaleRows } from "../audio/music.js";
import { baseOf, defOf, defaultData, eventsAt, isCopy, positionAt, sampleDefaults } from "../audio/patterns.js";
import { BAR_STEPS, BPM_MAX, BPM_MIN, LOOP_STEPS, stepDuration } from "../audio/timing.js";
import { LEVEL } from "../audio/params.js";
import { MAX_SECONDS, createRecorder } from "../audio/recorder.js";
import { encodeWav } from "../audio/wav.js";
import {
  CHANGE_BARS,
  CLOSE_SECONDS,
  OPENING_OPEN,
  OUTRO,
  PUMP,
  SECTIONS,
  SECTION_IDS,
  STYLES,
  STYLE_IDS,
  advance,
  announced,
  bpmFor,
  braking,
  closeSet,
  closeWith,
  closingOpen,
  dequeue,
  dropNext,
  dropping,
  enqueue,
  entering,
  fillMelodic,
  frenzy,
  guessSection,
  improvises,
  isBare,
  joinPilot,
  mixOf,
  moveTo,
  phraseEnd,
  rearrange,
  routeRoom,
  skip,
  startPilot,
  styleAt,
  styleOnDrop,
  toneOf,
  sequence,
  unbanned,
  uncloseSet,
  unform,
  withForm,
  withPlan,
} from "../autopilot.js";
import { coin, fillOf, restyle } from "../dress.js";
import { cleanFolds } from "../folds.js";
import {
  IMPROV_DEFAULT,
  doubleSteps,
  euclidSteps,
  improvise,
  newPart,
  reversePart,
  seeded,
  silenced,
  styleOf,
  varyNotes,
  varySteps,
  withBreak,
  withBuildUp,
  withRoll,
  writePart,
} from "../editing.js";
import { DICTS, LANGS, detectLang, lang, setLang, t } from "../i18n/index.js";
import { langSwitch } from "./langSwitch.js";
import {
  AHEAD,
  LEVELS,
  LEVEL_DEFAULT,
  PLAN_SECTIONS,
  SET_LENGTHS,
  asksForm,
  closingPrompt,
  closingSchema,
  formPrompt,
  formSchema,
  keptAhead,
  normalizeClosing,
  normalizeForm,
  normalizeOpening,
  normalizeOutro,
  normalizePlan,
  openWith,
  openingPrompt,
  openingSchema,
  planPrompt,
  planSchema,
  systemOf,
  themeAfter,
  whyOf,
} from "../planner.js";
import { BG_KICK_VARIANT, desiredLanes, isOn, laneKey, pressVariant } from "../selection.js";
import {
  hasCustomSounds,
  hashSeed,
  randomSeed,
  readFragment,
  readSnapFragment,
  shareFragment,
  snapFragment,
  unpackOpening,
  unpackPlans,
  unpackSnap,
  unpackSounds,
} from "../share.js";
import {
  SNAP_MAX,
  capture,
  countBar,
  freshName,
  nextSnapId,
  nextSnapshot,
  partsOf,
  removePart,
  skipTour,
  startTour,
  tourDue,
  tourLeft,
} from "../snapshots.js";
import { browserStorage, loadFolds, loadState, loadVolume, saveFolds, saveState, saveVolume } from "../storage.js";
import { RAMP_BARS, addTap, clampBpm, rampAt, tapBeat } from "../tempo.js";
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
import { HP_OPEN, LP_OPEN, djCutoffs } from "../audio/insert.js";
import { amountSlider, checkbox, download, el, select, slider, slug } from "./dom.js";
import { mountAccount } from "./account.js";
import { BRUSH, EUCLID, createEditor } from "./editor.js";
import { createHelp } from "./help.js";
import { mountSamplesPanel } from "./samplesPanel.js";
import { createSnapshotEditor } from "./snapshotEditor.js";
import { sortable } from "./sortable.js";
import { visualsButton } from "../visuals/launch.js";

const REPO = "https://github.com/frodoagu/home/tree/main/images/psy-sampler";

// Drag on a tile's 🔀 over the whole improvise range: the button is small.
const TILE_SLIDE_PX = 120;
// The drop by hand: the riser into it, the hit on it, and the layers its
// second bar takes out.
const DROP_RISER = "fx.riser";
const DROP_HIT = "fx.impact";
const GAP_LAYERS = ["kick", "bass"];

const sameLanes = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
const sameData = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
// 2026-10-09-2130, local time: takes sort by when they were made.
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// An autopilot run: the sections walked, what each opened with, the plan each
// one took for the next (🔗 carries them), each sound's last dress, and the
// ✨ AI's plans for the sections ahead ({ plan, why, queued }, in order; the
// first is the one the pilot holds). From silence it also gets `opening`
// (planner.js normalizeOpening; null once asked for in vain) and its `why`.
const newRun = () => ({ sections: [], sounds: [], plans: [], dress: {}, ahead: [], formed: false, formWhy: "", closeWhy: "" });
// Form chips the queue shows before folding the rest into "+n".
const FORM_SHOWN = 8;
// An ask the model has not answered by then is cut off, and a failed one is
// tried again after RETRY_MS: neither may hold the ✨ AI up until a reload.
const ASK_TIMEOUT_MS = 120_000;
const RETRY_MS = 15_000;

// Everything tied to the old workspace, dropped when another one replaces it.
const fresh = () => ({
  tempo: null,
  ramp: null,
  drafts: new Map(),
  applied: null,
  queuedSnap: null,
  armed: false,
  tour: null,
  replay: null,
  replayOpening: null,
});

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
    ai = null, // ai.js: the ✨ AI's models; same
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
    tour: resume?.tour ?? null, // the snapshot autopilot (snapshots.js), never on with `auto`
    run: resume?.run ?? null, // newRun(): the sections the pilot walked since it started, the plans it took and those ahead
    replay: resume?.replay ?? null, // a share link's plans, one per section, taken again from silence
    replayOpening: resume?.replayOpening ?? null, // a share link's opening, laid over the intro from silence
    aiPrefs: resume?.aiPrefs ?? loadPrefs(storage), // ✨ AI: on, engine, endpoint, model, vibe, open (ai.js)
    chrome: resume?.chrome ?? "unavailable", // what Chrome's built-in model said it can do here
    varying: resume?.varying ?? new Map(), // variant -> the part improvise varies around
    openFx: null, // the ✨ AI opening's swell, fired on the first bar line ▶ plays
    buildUp: null, // { id, from }: a kick build-up, armed (from null) or playing the bar at `from`
    drop: resume?.drop ?? null, // { phase: "armed" | "roll" | "gap", hand }: a drop on its way (see stepDrop)
    bar: resume?.bar ?? null, // { from, kinds: { variant: "gap" | "break" | "roll" } }: this bar's overlays
    autoVary: resume?.autoVary ?? new Set(), // sounds whose 🔀 the autopilot switched on
    queuedSnap: resume?.queuedSnap ?? null, // a snapshot entering with `pending` on the next bar line
    applied: resume?.applied ?? null, // the snapshot last recalled: lit while its mix plays
    drafts: resume?.drafts ?? new Map(), // snapshot id -> its unsaved edits
    tempo: resume?.tempo ?? ws.bpm, // the exact BPM (a ramp passes fractions); ws.bpm keeps it rounded
    ramp: resume?.ramp ?? null, // { from, to, bars, done }: a BPM change on its way
    bare: 0, // bar lines in a row the autopilot's mix had no lead and no pad
    newParts: new Set(), // variants whose 🎲 New part waits for the next loop
    reseed: false, // a new seed the playing pilot takes on the next loop
    setSeconds: 0, // played under the autopilot since ▶: where the set is
    leaving: new Set(), // sounds just banned that the autopilot takes out on the next bar line
    queued: new Map(), // variant -> editor actions (×2, the resets) waiting for the next bar line
    dj: resume?.dj ?? 0, // the DJ filter knob: a performance control, never stored
    brush: resume?.brush ?? { ...BRUSH }, // what a click on an editor's grid paints, shared by every editor
    euclid: resume?.euclid ?? { ...EUCLID }, // the drum editors' euclid(k, n, rot), shared like the brush
    folds: resume?.folds ?? cleanFolds(loadFolds(storage)), // the editors' open sections, per browser
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
  const pilotLists = () => unbanned(ws.lists, ws.banned); // what the autopilot and the ✨ AI pick from
  const loopSeconds = (bpm = state.tempo) => stepDuration(bpm) * LOOP_STEPS;

  // What each variant plays apart from what a bar lays on top of it: a
  // build-up, or the bar's overlay (a drop's gap, a phrase-end fill), which
  // feed() lays on. `live` is what the engine got, for the tiles' flashes.
  const fed = new Map();
  const live = new Map();
  const OVERLAYS = { gap: silenced, break: withBreak, roll: withRoll, build: withBuildUp };
  function feed(id, data, glide) {
    fed.set(id, data);
    const b = state.buildUp;
    const kind = state.bar?.kinds[id];
    let next = data;
    if (b?.id === id && b.from !== null) next = withBuildUp(data, b.from);
    else if (kind) next = OVERLAYS[kind](data, state.bar.from);
    live.set(id, next);
    engine.setData(id, next, glide);
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
  const volumeInput = el("input", { type: "range", id: "volume", min: "0", max: "1", step: "0.01", value: String(loadVolume(storage)) });
  const volumeOut = el("output", { for: "volume", class: "volume-value" });
  const volumeBox = el("label", { class: "dj", for: "volume" }, el("span", { text: tx.transport.volume }), volumeInput, volumeOut);
  const delay = checkbox("delay", tx.transport.delay, ws.effects.delay);
  const reverb = checkbox("reverb", tx.transport.reverb, ws.effects.reverb);
  const stopBtn = el("button", { type: "button", class: "stop", text: tx.transport.stop });
  const cueBtn = el("button", { type: "button", class: "cue", "data-action": "cue" });
  const snapBtn = el("button", { type: "button", class: "snap-btn", "data-action": "snapshot", text: tx.transport.snapshot });
  snapBtn.title = tx.transport.snapshotTitle;
  const recBtn = el("button", { type: "button", class: "rec", "data-action": "record" });
  const dropBtn = el("button", { type: "button", class: "drop-btn", "data-action": "drop", "aria-pressed": "false", text: tx.transport.drop });
  dropBtn.title = tx.transport.dropTitle;

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
  const tourBtn = el("button", { type: "button", class: "tour", "aria-pressed": "false", text: tx.transport.tour });
  tourBtn.title = tx.transport.tourTitle;
  const sectionBadge = el("span", { class: "section-badge", "aria-live": "polite" });
  const sectionLeft = el("span", { class: "section-left" });
  const queueList = el("ol", { class: "section-queue", "aria-label": tx.pilot.queue });
  const nextBtn = el("button", { type: "button", class: "ghost", "data-action": "next-section", text: tx.pilot.next });
  nextBtn.title = tx.pilot.nextTitle;
  const closeBtn = el("button", { type: "button", class: "ghost close-set", "data-action": "close-set", "aria-pressed": "false", text: tx.pilot.close });
  closeBtn.title = tx.pilot.closeTitle;
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

  /* ---- ✨ AI: a model plans each next section (planner.js, ai.js) ---- */
  const aiBtn = el("button", { type: "button", class: "ai", "data-action": "ai", text: tx.ai.button });
  aiBtn.title = tx.ai.title;
  aiBtn.hidden = !ai;
  const clouds = CLOUD_IDS.filter((id) => ai?.[id]); // the accounts a listener can link
  const field = (id, label, input, title) => {
    const box = el("label", { class: "ai-field", for: id }, el("span", { text: label }), input);
    box.title = title;
    return box;
  };
  const engineInput = el("select", { id: "ai-engine", "data-control": "ai-engine" });
  const engineBox = field("ai-engine", tx.ai.engine, engineInput, tx.ai.engineTitle);
  // How much it asks (planner.js LEVELS), each option saying what it decides.
  const levelInput = el(
    "select",
    { id: "ai-level", "data-control": "ai-level" },
    ...LEVELS.map((id) => {
      const [name, what] = tx.ai.levels[id];
      const option = el("option", { value: id, text: name });
      option.title = what;
      return option;
    }),
  );
  const levelBox = field("ai-level", tx.ai.level, levelInput, tx.ai.levelTitle);
  // About how long the set lasts: the ✨ AI paces the night to it.
  const setInput = el(
    "select",
    { id: "ai-set", "data-control": "ai-set" },
    ...SET_LENGTHS.map((minutes) => el("option", { value: String(minutes), text: tx.ai.sets[minutes] })),
  );
  const setBox = field("ai-set", tx.ai.set, setInput, tx.ai.setTitle);
  const endpointInput = el("input", {
    type: "url",
    id: "ai-endpoint",
    class: "ai-input",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: LMSTUDIO_URL,
  });
  const endpointBox = field("ai-endpoint", tx.ai.endpoint, endpointInput, tx.ai.endpointTitle);
  // A linked account: its API key, kept in this browser only (ai.js prefs).
  const keyInput = el("input", {
    type: "password",
    id: "ai-key",
    class: "ai-input",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: tx.ai.keyPlaceholder,
  });
  const unlinkBtn = el("button", { type: "button", class: "ghost ai-unlink", text: tx.ai.unlink });
  const keyLink = el("a", { class: "ai-getkey", target: "_blank", rel: "noopener noreferrer", text: tx.ai.getKey });
  const keyBox = field("ai-key", tx.ai.key, el("span", { class: "ai-model-pick" }, keyInput, unlinkBtn, keyLink), "");
  // The models LM Studio or the account lists (ai.js known), read again on every start or ↻.
  const modelInput = el("select", { id: "ai-model", "data-control": "ai-model" });
  const modelsBtn = el("button", { type: "button", class: "ghost ai-models", text: "↻" });
  const modelBox = field("ai-model", tx.ai.model, el("span", { class: "ai-model-pick" }, modelInput, modelsBtn), tx.ai.modelTitle);
  const vibeInput = el("input", {
    type: "text",
    id: "ai-vibe",
    class: "ai-input vibe",
    maxlength: "200",
    autocomplete: "off",
    placeholder: tx.ai.vibePlaceholder,
  });
  const vibeBtn = el("button", { type: "button", class: "ghost ai-apply", text: tx.ai.apply });
  vibeBtn.title = tx.ai.applyTitle;
  const vibeBox = field("ai-vibe", tx.ai.vibe, el("span", { class: "ai-model-pick" }, vibeInput, vibeBtn), tx.ai.vibeTitle);
  // What an empty vibe means, said under it as it's typed.
  const vibeNote = el("p", { class: "hint ai-vibe-note" });
  const noteVibe = () => (vibeNote.textContent = vibeInput.value.trim() ? tx.ai.vibeSaid : tx.ai.vibeEmpty);
  // Its settings fold away (remembered), with what they say in the summary.
  const aiSummary = el("span", { class: "ai-summary" });
  const aiPanel = el(
    "details",
    { class: "ai-panel" },
    el("summary", {}, el("span", { class: "ai-title", text: tx.ai.settings }), aiSummary),
    el("div", { class: "tools-row ai-row" }, engineBox, endpointBox, keyBox, modelBox, levelBox, setBox, vibeBox),
    vibeNote,
  );

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
  const rides = new Map(); // variant -> its tone ride in flight, { from, to, t0, ms } (setTone)
  const sections = new Map(); // layer id -> { node, group, slot }
  const sorters = [];

  function makeTile(layer, id) {
    const labelEl = el("span", { class: "variant-label", text: labelOf(id) });
    const detailEl = el("span", { class: "variant-detail", text: detailOf(id) });
    // A loop sound's tone filters, as the band they let through (paintTone).
    const toneEl = layer.oneShot ? null : el("span", { class: "tone-band", "aria-hidden": "true" });
    const node = el(
      "button",
      { type: "button", class: layer.oneShot ? "variant" : "variant has-level", "data-variant": id },
      labelEl,
      detailEl,
      ...(toneEl ? [toneEl] : []),
    );
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
    const ban = layer.manual ? null : el("button", {
      type: "button",
      class: "ban-tile",
      "data-ban": id,
      "aria-pressed": String(ws.banned.includes(id)),
      "aria-label": tx.tile.ban(labelOf(id)),
      title: tx.tile.banTitle,
      text: "⊘",
    });
    ban?.addEventListener("pointerdown", (e) => e.stopPropagation()); // a click, not a reorder
    ban?.addEventListener("click", () => setBanned(layer, id, !ws.banned.includes(id)));
    const tile = el("div", { class: isCopy(id) ? "tile is-copy" : "tile", "data-key": id }, node, ...(levelBar ? [levelBar] : []), side, ...(ban ? [ban] : []));
    tiles.set(id, { layer, node, tile, edit, vary, solo, ban, levelBar, labelEl, detailEl, toneEl });
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
  // An emptied name falls back to the snapshot's section.
  const named = (draft) => ({ ...draft, name: draft.name.trim().slice(0, 40) || tx.sections[draft.section] });

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
    showSection();
  }

  for (const id of ws.order) {
    if (id === SNAP_PANEL) {
      makeSection(
        id,
        tx.snap,
        (ids) => {
          ws.snapshots = ids.map(snapById);
          persist();
          showSection(); // the tour's next one follows the order
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
    el("div", { class: "topbar-transport" }, snapBtn, dropBtn, cueBtn, stopBtn, recBtn),
    el(
      "div",
      { class: "topbar-tempo" },
      tapBtn,
      el("label", { class: "bpm", for: "bpm" }, el("span", { text: tx.transport.bpm }), bpm, bpmOut),
      rampBox,
    ),
    el("div", { class: "topbar-end" }, visualsButton(engine, tx.visuals), help.button, ...(account ? [account.node] : []), language),
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
        onAudition: auditionSample,
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
      el("h1", { text: "Psy Layers DAW" }),
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
      volumeBox,
    ),
    el(
      "div",
      { class: "tools panel" },
      el("div", { class: "tools-row pilot-row" }, autoBtn, aiBtn, tourBtn, sectionBadge, sectionLeft, queueList, nextBtn, closeBtn),
      aiPanel,
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
  const laneMap = () => desiredLanes(state.active, { bgKick: ws.bgKick && !state.auto && !state.tour });

  function renderButtons(playingFx = engine.activeFx()) {
    const target = state.pending ?? state.active;
    diceBtn.classList.toggle("is-queued", state.auto && state.reseed);
    for (const [id, { layer, node, tile, vary, solo, ban, levelBar }] of tiles) {
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
      if (!rides.has(id)) paintTone(id, dataOf(id)?.insert);
      node.title =
        on && !layer.oneShot
          ? tx.tile.levelTitle
          : id === BG_KICK_VARIANT
            ? tx.tile.bgKick
            : layer.exclusive
              ? tx.tile.stackTitle
              : "";
      const next = !layer.oneShot && isOn(target, id);
      node.classList.toggle("is-active", on);
      node.classList.toggle("is-queued", Boolean(state.pending) && next && !on);
      node.classList.toggle("is-leaving", Boolean(state.pending) && on && !next);
      node.classList.toggle("is-background", lanes.bgKick === id);
      tile.classList.toggle("is-edited", owned(id) && !isCopy(id));
      tile.classList.toggle("is-auto", ws.auto.includes(id));
      tile.classList.toggle("is-varying", state.varying.has(id));
      tile.classList.toggle("is-banned", ws.banned.includes(id));
      ban?.setAttribute("aria-pressed", String(ws.banned.includes(id)));
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
    showDrop();
  }

  // Running, the slot holds Parar; stopped, the cue button arms, and armed it
  // plays what was queued.
  function showCue() {
    mediaKeys?.setPlaying(engine.isRunning());
    stopBtn.hidden = !engine.isRunning() && !(state.auto && state.armed); // ■ also lets go of an armed autopilot
    cueBtn.hidden = engine.isRunning();
    cueBtn.textContent = state.armed ? tx.transport.play : tx.transport.arm;
    cueBtn.title = state.armed ? tx.transport.playTitle : tx.transport.armTitle;
    cueBtn.classList.toggle("is-armed", state.armed);
  }

  // The ✨ AI's answer for section number `at` of the run, or for the form
  // (`form` set, no `at`), on its way ({ at, abort, form }). Up here because
  // showSection() shows it.
  let planning = null;
  let vibeFresh = false; // the vibe changed and no plan has followed it yet
  let cueWhenPlanned = false; // the armed autopilot plays once the ✨ AI stops asking

  // Now: the section and the bars it has left, then the queue (✕ drops one
  // before it plays) and the sections the ✨ AI planned past it. In its last
  // loop the section coming next pulses; while the ✨ AI thinks, so does the
  // section it arranges, or a chip saying so.
  function showSection() {
    const p = state.auto ? state.pilot : null;
    autoBtn.setAttribute("aria-pressed", String(state.auto));
    tourBtn.setAttribute("aria-pressed", String(Boolean(state.tour)));
    tourBtn.disabled = !state.tour && ws.snapshots.length < 2;
    if (state.tour) {
      showTour(state.tour);
      return;
    }
    for (const { node } of snapTiles.values()) node.classList.remove("is-next");
    sectionBadge.textContent = p ? tx.sections[p.section] : "";
    sectionBadge.hidden = !p;
    const opened = Boolean(p && state.run?.opening) && sectionNo() === 0; // the ✨ AI's opening plays
    sectionBadge.title = !opened ? "" : state.run.why ? `${tx.ai.planned}: ${state.run.why}` : tx.ai.planned;
    sectionLeft.textContent = !p ? "" : p.closing ? tx.pilot.closingLeft(p.left * 2, clock(p.closing.left * loopSeconds())) : tx.pilot.left(p.left * 2);
    // ✕ on a section coming: none on the one the last loop already announced
    // (its riser is on its way), so every ✕ shown does what it says.
    // Nor on the outro: a closing is called off with 🌅.
    const settled = (slot) => slot === 0 && p.left === 1 && p.next !== undefined;
    const unqueue = (id, slot, drop) => {
      if (settled(slot) || id === OUTRO) return [];
      const btn = el("button", { type: "button", class: "unqueue", "aria-label": tx.pilot.unqueue(tx.sections[id]), text: "✕" });
      btn.addEventListener("click", () => {
        drop();
        showSection();
      });
      return [btn];
    };
    const ahead = p ? (state.run?.ahead ?? []) : [];
    const form = p?.form ?? [];
    const coming = p ? sequence(p) : [];
    const why = (i, fallback) => {
      const e = ahead[i];
      const said = e && (i >= coming.length || e.plan.section === coming[i]) ? e.why : "";
      return said ? `${tx.ai.planned}: ${said}` : fallback;
    };
    const chips = (p?.queue ?? []).map((id, i) => {
      const drop = unqueue(id, i, () => {
        state.pilot = dequeue(state.pilot, i);
        requeue();
      });
      const li = el("li", { class: "queued", "data-queued": id }, el("span", { text: id === OUTRO ? `🌅 ${tx.sections[id]}` : tx.sections[id] }), ...drop);
      if (p.closing) li.title = why(i, state.run?.closeWhy ? `${tx.ai.closed}: ${state.run.closeWhy}` : tx.pilot.closingChip);
      return li;
    });
    // What comes after the queue: the ✨ AI's form of the track (✕ drops a
    // section of it too), then the plans past it as soon as there are some,
    // else the pilot's pick in its last loop.
    form.slice(0, FORM_SHOWN).forEach((id, i) => {
      const drop = unqueue(id, p.queue.length + i, () => {
        state.pilot = unform(state.pilot, i);
        requeue();
      });
      const formWhy = state.run?.formWhy;
      const li = el("li", { class: "queued is-ai", "data-queued": id }, el("span", { text: `✨ ${tx.sections[id]}` }), ...drop);
      li.title = why(p.queue.length + i, formWhy ? `${tx.ai.formed}: ${formWhy}` : tx.ai.formed);
      chips.push(li);
    });
    if (form.length > FORM_SHOWN) {
      const rest = form.slice(FORM_SHOWN);
      const li = el("li", { class: "queued is-auto is-ai" }, el("span", { text: `+${rest.length}` }));
      li.title = rest.map((id) => tx.sections[id]).join(" → ");
      chips.push(li);
    }
    const shown = (p?.queue.length ?? 0) + form.length;
    // A plan past them goes with the ones after it (they followed from it),
    // and the ✨ AI plans that section again.
    ahead.slice(shown).forEach(({ plan }, i) => {
      const drop = unqueue(plan.section, shown + i, () => {
        dropAhead(shown + i);
        planAhead();
      });
      const li = el("li", { class: "queued is-auto is-ai", "data-queued": plan.section }, el("span", { text: `✨ ${tx.sections[plan.section]}` }), ...drop);
      li.title = why(shown + i, tx.ai.planned);
      chips.push(li);
    });
    if (p && !chips.length && p.left === 1 && p.next) {
      chips.push(el("li", { class: "queued is-auto", "data-queued": p.next }, el("span", { text: tx.sections[p.next] })));
    }
    // The section a new style comes in on.
    if (p?.handoff) {
      const chip = chips[coming.findIndex((_, i) => styleAt(p, i, ws.style) !== ws.style)];
      const name = tx.styles[p.handoff.style];
      chip?.firstChild.after(el("span", { class: "restyle", text: `→ ${name}` }));
      if (chip) chip.title = tx.pilot.styleOn(name);
    }
    if (p && planning) {
      const slot = planning.form ? chips.length : planning.at - sectionNo() - 1;
      const chip = chips[slot] ?? chips[chips.push(el("li", { class: "queued is-auto is-ai" }, el("span", { text: tx.ai.thinking }))) - 1];
      chip.classList.add("is-thinking");
      chip.title = planning.closing ? tx.ai.closingTitle : planning.form ? tx.ai.formingTitle : tx.ai.thinkingTitle;
    }
    if (p?.left === 1) chips[0]?.classList.add("is-next");
    queueList.replaceChildren(...chips);
    queueList.hidden = !chips.length;
    nextBtn.disabled = !p || p.left === 1;
    showDrop();
  }

  // 💥 is lit while a drop is on its way: armed, rolling, in its gap, or the
  // pilot's next loop. 🌅 closes what plays; again, it calls the closing off
  // until the outro is announced.
  function showDrop() {
    const p = state.auto ? state.pilot : null;
    closeBtn.setAttribute("aria-pressed", String(Boolean(p?.closing)));
    closeBtn.disabled = !engine.isRunning() || state.armed || Boolean(p?.closing && !closingOpen(p));
    for (const b of phaseBtns) b.disabled = Boolean(p?.closing); // nothing plays after the outro
    for (const c of [bpm, rampTo, rampBtn, tapBtn]) c.disabled = braking(p); // a vinyl stopping keeps its tempo
    const coming = Boolean(state.drop) || Boolean(p && (dropping(p) || (sequence(p)[0] === "peak" && p.left <= 2)));
    dropBtn.setAttribute("aria-pressed", String(coming));
    dropBtn.disabled = !engine.isRunning() || Boolean(p?.closing && !closingOpen(p)); // the outro has its own drop
  }

  // The same row under the snapshot autopilot: the snapshot playing, its bars
  // left and the one coming next, which pulses (its tile too) in the last loop.
  function showTour(tour) {
    const now = snapById(tour.id);
    const left = tourLeft(tour, ws.changeBars);
    const next = nextSnapshot(ws.snapshots, tour);
    sectionBadge.textContent = now?.name ?? "";
    sectionBadge.hidden = !now;
    sectionLeft.textContent = tx.pilot.left(left);
    const chip = next && el("li", { class: "queued is-auto", "data-queued": next.id }, el("span", { text: next.name }));
    chip?.classList.toggle("is-next", left <= 2);
    queueList.replaceChildren(...(chip ? [chip] : []));
    queueList.hidden = !chip;
    for (const [id, { node }] of snapTiles) node.classList.toggle("is-next", left <= 2 && next?.id === id);
    nextBtn.disabled = Boolean(tour.skip) || left <= 2;
  }

  // What the open editor's playhead shows: the step, or the part step for a
  // part longer than a loop (a snapshot's editor has no part).
  function rollStep(id, step) {
    if (step === null || defOf(id)?.kind !== "notes") return step;
    const data = dataNow(id);
    if ((data.loops ?? 1) === 1) return step;
    return Math.floor(positionAt(step, engine.visibleLoop() ?? 0, data, engine.fromOf(id)));
  }

  let shownStep = null;
  function paintStep(step) {
    if (open) open.editor.paint(rollStep(open.id, step));
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
      const events = eventsAt(id, step, false, live.get(id) ?? dataNow(id), loop, engine.fromOf(id));
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
    paintRides(performance.now());
    const fx = engine.activeFx();
    if ([...fx].sort().join() !== [...fxShown].sort().join()) {
      renderButtons(fx);
      for (const id of fx) {
        if (fxShown.has(id) || !tiles.has(id)) continue;
        strike(tiles.get(id).node, true);
      }
      fxShown = fx;
    }
    if (engine.isRunning() || fx.size > 0 || rides.size > 0) frame = requestAnimationFrame(draw);
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
    if (state.auto) state.setSeconds += BAR_STEPS * stepDuration(state.tempo);
    if (bar === 0 && state.drop?.phase !== "armed") state.drop = null; // a fresh run: no drop left halfway
    if (bar === 0 && state.openFx) {
      fire(state.openFx, time); // the opening's swell, on the track's first beat
      state.openFx = null;
    }
    if (loopStart) {
      for (const id of state.newParts) writeNewPart(id);
      state.newParts.clear();
      varyAll();
    }
    // A new seed re-engages the pilot here, on the grid, in place of its step.
    const reseeded = loopStart && state.auto && state.reseed;
    if (reseeded) engageAuto();
    runQueued();
    rollBuildUp(step);
    stepRamp();
    let changed = reseeded;
    if (state.pending) {
      if (state.queuedSnap) load(state.queuedSnap, step);
      else if (state.tour) state.tour = countBar(state.tour, step); // the hand wins this line
      state.queuedSnap = null;
      state.active = state.pending;
      state.pending = null;
      changed = true;
    } else if (state.tour) {
      changed = state.tour.bars === null; // its first line drops the background kick
      state.tour = countBar(state.tour, step);
      if (tourDue(state.tour, step, ws.changeBars)) {
        const next = nextSnapshot(ws.snapshots, state.tour);
        if (next) {
          load(next, step);
          state.active = { ...next.active };
        } else state.tour = null;
        changed = true;
      }
    } else if (state.auto && loopStart && !reseeded) {
      const move = advance(state.pilot, state.active, pilotLists(), state.rng, {
        style: ws.style,
        changeBars: ws.changeBars,
      });
      if (move.end) {
        setTimeout(endSet); // the outro is over, and so is the set: off the engine's tick
        return undefined;
      }
      const was = state.active;
      const plan = state.pilot.plan;
      const tame = !frenzy(state.pilot);
      state.pilot = move.pilot;
      // The set goes wild: the visuals flash until the fade.
      const { left, ending } = state.pilot;
      if (tame && frenzy(state.pilot)) engine.frenzy(time, time + (left - ending.fade - ending.brake) * loopSeconds());
      // The set's last loops: the mix slows to a stop, like a vinyl, until the
      // end. Its end is fixed in audio time, so the tempo holds still till then.
      if (braking(state.pilot) && left === ending.brake) {
        state.ramp = null;
        showRamp();
        engine.brake(time, left * loopSeconds());
      }
      const sectionStart = move.pilot.left === move.pilot.length;
      if (move.style) {
        styleNow(move.style); // before any part is written: it takes the new scale
        status(tx.pilot.styleIn(tx.styles[move.style]));
      } else if (sectionStart && move.pilot.section === "breakdown") rampBreak();
      // The plan the new section was built from: its dress and parts land now.
      const own = sectionStart && plan?.section === move.pilot.section ? plan : null;
      const playing = new Set(Object.values(move.active));
      const fx = move.fx.filter((id) => !ws.banned.includes(id)); // drawn all the same: the seed goes on as ever
      const restyled = (own?.dress ?? []).filter((d) => playing.has(d.id));
      for (const d of restyled) state.run.dress[d.id] = d;
      dressIn([...new Set([...entering(state.active, move.active), ...fx, ...restyled.map((d) => d.id)])]);
      for (const id of move.rewrite) rewrite(id);
      for (const [layer, degrees] of Object.entries(own?.parts ?? {})) {
        const id = own.layers[layer]?.[0];
        if (playing.has(id) && !(move.pilot.theme ?? []).includes(id)) writeIn(id, degrees);
      }
      for (const id of fx) fire(id, time);
      state.active = move.active;
      improviseIn(sectionStart ? Object.values(move.active) : entering(was, move.active), entering(move.active, was));
      if (sectionStart) enterSection();
      else if (state.pilot.left === 1 && planning?.at === sectionNo() + 1) cancelPlanning(); // too late for the next one's plan
      showSection();
      changed = true;
    }
    if (state.leaving.size) {
      const kept = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => !state.leaving.has(v)));
      if (state.auto) {
        changed ||= Object.values(state.active).some((id) => state.leaving.has(id));
        state.active = kept(state.active);
      }
      state.leaving.clear();
    }
    // Under the autopilot a mix with no lead and no pad lasts one bar at most.
    if (state.auto) {
      if (!isBare(state.active)) state.bare = 0;
      else if (state.bare++ >= 1) {
        const full = fillMelodic(state.active, pilotLists(), Math.random, ws.style);
        dressIn(entering(state.active, full));
        state.active = full;
        state.bare = 0;
        changed = true;
      }
    }
    if (state.auto && loopStart) engine.setPump(PUMP[state.pilot.section] ?? {}, time);
    setBar(step, stepDrop(time, step, loopStart) ?? frenzyKinds() ?? fillKinds(step));
    if (state.tour) showSection();
    if (!changed) return undefined;
    if (state.auto) {
      mixIn();
      toneIn();
    }
    lanes = laneMap();
    renderButtons();
    return lanes;
  });

  /* ---- the drop: a roll, a bar without kick and bass, then everything ---- */
  // Two bars. The first rolls the kick (the build-up) and starts the sweep up
  // the mix; the second takes kick and bass out (their parts, silenced for
  // the bar); the bar line after it is the drop: they come back on the 1 and
  // the sweep snaps open. The pilot starts one on its drop loops (it fires
  // the riser and the peak's FX itself); 💥 by hand starts one on the next
  // bar line, with a riser into it and an impact on it. Returns this bar's
  // overlays while the drop owns the bar, else null.
  function stepDrop(time, step, loopStart) {
    const d = state.drop;
    if (d?.phase === "gap") {
      state.drop = null;
      engine.sweepOff(time);
      if (d.hit) fire(DROP_HIT, time);
      showDrop();
      return {};
    }
    if (d?.phase === "roll") {
      state.drop = { ...d, phase: "gap" };
      const out = {};
      for (const id of Object.values(laneMap())) if (GAP_LAYERS.includes(layerOf(id).id)) out[id] = "gap";
      return out;
    }
    const byPilot = state.auto && loopStart && dropping(state.pilot);
    if (!byPilot && !(d?.phase === "armed" && !state.auto)) return null;
    state.drop = { phase: "roll", hand: !byPilot, hit: !byPilot || Boolean(state.pilot.opening) }; // an opening explodes too
    const kick = Object.values(laneMap()).find((id) => layerOf(id).id === "kick");
    if (kick) {
      setBuildUp(kick, true);
      state.buildUp.from = step; // this bar, not the next
      feed(kick, dataNow(kick));
    }
    engine.sweep(time, time + LOOP_STEPS * stepDuration(state.tempo));
    if (!byPilot) fire(DROP_RISER, time);
    showDrop();
    return null;
  }

  // The pilot's phrase-end fill, on the second bar of a loop that ends a
  // phrase: the kick breaks, the percussion rolls, or both (dress.js fillOf).
  function fillKinds(step) {
    const out = {};
    if (!state.auto || step !== BAR_STEPS || state.drop) return out;
    const at = phraseEnd(state.pilot);
    const fill = at ? fillOf(ws.seed, state.pilot.section, at) : null;
    if (!fill) return out;
    for (const id of Object.values(laneMap())) {
      const layer = layerOf(id).id;
      if (fill !== "roll" && layer === "kick") out[id] = "break";
      else if (fill !== "break" && layer === "perc" && defOf(id).kind === "drum") out[id] = "roll";
    }
    return out;
  }

  // The frenzy's last two loops roll every drum it plays, bar after bar;
  // null elsewhere (its other phrases end in the usual fills).
  function frenzyKinds() {
    const p = state.pilot;
    if (!state.auto || !frenzy(p) || p.left - p.ending.fade - p.ending.brake > 2) return null;
    const out = {};
    for (const id of Object.values(laneMap())) if (defOf(id).kind === "drum") out[id] = "build";
    return out;
  }

  // This bar's overlays, from its bar line to the next: the last bar's come
  // off, the new ones go on.
  function setBar(from, kinds) {
    const was = state.bar?.kinds ?? {};
    if (!Object.keys(was).length && !Object.keys(kinds).length) return;
    state.bar = Object.keys(kinds).length ? { from, kinds } : null;
    for (const id of new Set([...Object.keys(was), ...Object.keys(kinds)])) feed(id, dataNow(id));
  }

  // A drop armed by hand becomes the pilot's: its next loop.
  function adoptDrop() {
    if (state.drop?.phase !== "armed") return;
    state.drop = null;
    state.pilot = dropNext(state.pilot);
  }

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

  // The seed's params and synth for each sound the autopilot brings in, and
  // the ✨ AI's macros over them where a plan dressed it this run.
  function dressIn(ids) {
    for (const id of ids) {
      if (!tiles.has(id) || owned(id)) continue;
      const next = { ...dataOf(id), ...restyle(id, ws.seed, state.run?.dress?.[id] ?? null, dataOf(id).insert) };
      if (sameData(next, dataOf(id))) continue;
      setVariant(id, next, { generated: true });
      if (open?.id === id) openEditor(open.layer, id);
    }
  }

  // A plan's part (planner.js `parts`), in the style's scale, unless the
  // user owns the sound.
  function writeIn(id, degrees) {
    const def = defOf(id);
    if (def.kind !== "notes" || owned(id)) return;
    const scale = STYLES[ws.style].scale ?? def.data.scale;
    const notes = writePart(styleOf(id), degrees, scaleRows(scale, def.low, def.high), def.data.notes);
    if (!notes) return;
    const was = dataOf(id);
    setVariant(id, { ...was, notes, scale }, { generated: true });
    if (open?.id !== id) return;
    if (was.scale === scale) open.editor.show(dataOf(id));
    else openEditor(open.layer, id);
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

  function setVarying(id, on, { pilot = false } = {}) {
    if (pilot && on) state.autoVary.add(id);
    else state.autoVary.delete(id); // by hand it is yours
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
    setVariant(id, { ...data, loops: 1, notes: improvise(styleOf(id), scaleRows(data.scale, def.low, def.high)) });
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
      const keys = [...(defOf(id).kind === "drum" ? ["steps", "mods"] : ["notes", "loops"]), "speed", "iter", "echo"];
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
      keepForEnd(id);
      setLevel(id, level, { pilot: true, glide: stepDuration(state.tempo) * LOOP_STEPS });
      moved = true;
    }
    if (moved) persist();
  }

  // The autopilot's tone filters on every sound it rides (autopilot.js
  // toneOf): an exponential line over the loop, like the faders. Yours too:
  // the rest of your edit stays.
  // The kick and bass an opening filtered open at once when it ends.
  function toneIn(active = state.active) {
    let moved = false;
    const opening = Boolean(state.pilot.opening);
    for (const [id, tone] of Object.entries(toneOf(state.pilot, active))) {
      if (opening && OPENING_OPEN.includes(layerOf(id).id)) openRidden.add(id);
      const ins = dataOf(id).insert;
      if (!tiles.has(id) || (ins.hp === tone.hp && ins.lp === tone.lp)) continue;
      keepForEnd(id);
      setTone(id, tone, stepDuration(state.tempo) * LOOP_STEPS);
      moved = true;
    }
    if (!opening && openRidden.size) {
      for (const id of openRidden) if (tiles.has(id)) setTone(id, { hp: HP_OPEN, lp: LP_OPEN }, 0);
      openRidden.clear();
      moved = true;
    }
    if (moved) persist();
  }
  const openRidden = new Set();

  // A closing's outro rides every sound's level and lowpass, kick and bass
  // too: each goes back to where it was as the outro took it once the set
  // ends, or once anything else ends the outro (⏹, 🤖, a new seed), so
  // nothing is left muted or muffled. `glide`: over that long.
  const outroFrom = new Map(); // variant -> { level, hp, lp } before the outro rode it
  function keepForEnd(id) {
    if (!state.pilot?.closing || state.pilot.section !== OUTRO || outroFrom.has(id)) return;
    const { level, insert } = dataOf(id);
    outroFrom.set(id, { level, hp: insert.hp, lp: insert.lp });
  }
  function restoreOutro(glide = 0) {
    for (const [id, { level, hp, lp }] of outroFrom) {
      if (!tiles.has(id)) continue;
      setLevel(id, level, { pilot: true, glide });
      setTone(id, { hp, lp }, glide);
    }
    if (outroFrom.size) persist();
    outroFrom.clear();
  }

  function setTone(id, { hp, lp }, glide) {
    if (!(id in ws.variants)) ws.auto.push(id);
    const from = toneNow(id);
    const toned = (data) => ({ ...data, insert: { ...data.insert, hp, lp } });
    ws.variants[id] = toned(dataOf(id));
    if (state.varying.has(id)) state.varying.set(id, toned(state.varying.get(id)));
    feed(id, toned(dataNow(id)), glide);
    open?.id === id && open.editor.showTone(ws.variants[id].insert);
    if (glide > 0) {
      rides.set(id, { from, to: { hp, lp }, t0: performance.now(), ms: glide * 1000 });
      paintTone(id, from);
      animate();
    } else {
      rides.delete(id);
      paintTone(id, { hp, lp });
    }
  }

  // The tone rides in flight (`rides`): the audio glides the filters in an
  // exponential line, and each frame (draw) the tile's band and an open
  // editor's knobs follow it, so a ride is seen while it is heard.
  function toneAt(ride, now) {
    const t = Math.min(1, Math.max(0, (now - ride.t0) / ride.ms));
    const line = (a, b) => a * (b / a) ** t;
    return { hp: line(ride.from.hp, ride.to.hp), lp: line(ride.from.lp, ride.to.lp) };
  }
  const toneNow = (id) => (rides.has(id) ? toneAt(rides.get(id), performance.now()) : dataOf(id).insert);

  // The band a sound's tone lets through, on a log scale from 20 Hz to 20 kHz.
  function tonePos(hz) {
    const at = Math.log(Math.min(LP_OPEN, Math.max(HP_OPEN, hz)) / HP_OPEN) / Math.log(LP_OPEN / HP_OPEN);
    return `${Math.round(at * 1000) / 10}%`;
  }
  function paintTone(id, tone) {
    const t = tiles.get(id);
    if (!t?.toneEl || !tone) return;
    t.toneEl.style.setProperty("--hp", tonePos(tone.hp));
    t.toneEl.style.setProperty("--lp", tonePos(tone.lp));
    t.node.classList.toggle("is-toned", tone.hp > HP_OPEN || tone.lp < LP_OPEN);
  }
  function paintRides(now) {
    for (const [id, ride] of rides) {
      const tone = toneAt(ride, now);
      paintTone(id, tone);
      if (open?.id === id) open.editor.showToneAt(tone);
      if (now >= ride.t0 + ride.ms) rides.delete(id);
    }
  }

  // The autopilot's 🔀: on a section's first loop it decides for everything
  // it plays, mid-section only for what comes in, so a hand toggle holds
  // until the section changes. From the seed, per section and sound. What
  // it switched on stops when the sound `left`.
  function improviseIn(ids, left = []) {
    const section = state.pilot.section;
    for (const id of new Set(ids)) {
      if (!tiles.has(id) || layerOf(id).oneShot) continue;
      const on = improvises(section, id, coin(ws.seed, `improv/${section}/${id}`));
      if (on !== state.varying.has(id)) setVarying(id, on, { pilot: true });
    }
    for (const id of left) if (state.autoVary.has(id) && tiles.has(id)) setVarying(id, false, { pilot: true });
  }

  // ⊘ keeps a sound away from the autopilot (and the ✨ AI); by hand it
  // still plays. Banned while the pilot plays it, it leaves on the next bar
  // line.
  function setBanned(layer, id, on) {
    ws.banned = on ? [...ws.banned, id].sort() : ws.banned.filter((x) => x !== id);
    if (on && state.auto && !layer.oneShot) state.leaving.add(id);
    else state.leaving.delete(id);
    persist();
    status(on ? tx.tile.banned(labelOf(id)) : tx.tile.unbanned(labelOf(id)));
    renderButtons();
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
    if (state.auto && braking(state.pilot)) return; // a new style's ramp too: the brake ends where it was set
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
    const section = state.auto && state.pilot && state.pilot.section !== OUTRO ? state.pilot.section : guessSection(parts.active);
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

  // A recalled snapshot's sounds go back to the data they played then, a
  // running autopilot jumps to its section and the snapshot autopilot carries
  // on from it, counting from bar line `step` (or the next one).
  function load(snap, step = null) {
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
      enterSection();
    }
    if (state.tour) state.tour = startTour(ws.snapshots, snap.id, step);
    showSection();
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
        const snap = named(draft);
        ws.snapshots = ws.snapshots.map((s) => (s.id === id ? snap : s));
        state.drafts.delete(id);
        persist();
        const tile = snapTiles.get(id);
        tile.labelEl.textContent = snap.name;
        tile.detailEl.textContent = snapDetail(snap);
        tile.edit.setAttribute("aria-label", tx.tile.edit(snap.name));
        renderButtons();
        showSection(); // a new name on the pilot row
        return snap;
      },
      onTry: (draft) => recall(draft),
      onShare: (draft) => shareSnapshot(named(draft)),
      onRemove: () => removeSnapshot(id),
      onClose: closeEditor,
    });
    open = { layer: { id: SNAP_PANEL }, id, editor };
    showEditor(editor.node);
    if (focusName) editor.focusName();
  }

  async function shareSnapshot(snap) {
    stats?.count("shares");
    copyLink(await snapFragment(ws, snap), tx.snap.copied(snap.name));
  }

  function removeSnapshot(id) {
    if (!confirm(tx.snap.confirmRemove(snapById(id).name))) return;
    closeEditor();
    ws.snapshots = ws.snapshots.filter((s) => s.id !== id);
    if (!ws.snapshots.length) state.tour = null;
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
        // A hand on the tone takes it from a ride in flight.
        const ride = rides.get(id);
        if (ride && (next.insert.hp !== ride.to.hp || next.insert.lp !== ride.to.lp)) rides.delete(id);
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
      folds: state.folds,
      onFold: () => saveFolds(storage, state.folds),
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
    editor.paint(rollStep(id, engine.visibleStep()));
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

  // The picker's ▶, before uploading: decoded here, played like a stored one.
  function auditionSample(candidate) {
    engine.ensureContext();
    return samples.audition(candidate).then((id) => engine.previewSample(id));
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
    ws.banned = ws.banned.filter((x) => x !== id);
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
    if (!ws.snapshots.length) state.tour = null;
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
    alive = false;
    cancelPlanning();
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
    const { pending, armed, active, auto, pilot, rng, tour, varying, queuedSnap, applied, drafts, tempo, ramp, dj, brush, euclid } = state;
    const { drop, bar, autoVary, folds } = state;
    const carried = { pending, armed, active, auto, pilot, rng, tour, varying, queuedSnap, applied, drafts, tempo, ramp, dj, brush, euclid, drop, bar, autoVary, folds };
    Object.assign(carried, { run: state.run, replay: state.replay, replayOpening: state.replayOpening });
    Object.assign(carried, { aiPrefs: state.aiPrefs, chrome: state.chrome });
    const next = { ws, ...carried, open: open?.id, ...changes };
    destroy();
    return mountApp(root, engine, { ...opts, recorder, resume: next });
  }

  async function loadShared({ seed, style: sharedStyle, bpm: sharedBpm, sounds, plans, opening }) {
    history.replaceState(null, "", location.pathname + location.search);
    let next = { ...ws, seed, style: sharedStyle ?? ws.style, bpm: sharedBpm ?? ws.bpm };
    let replay = null;
    let replayOpening = null;
    try {
      if (plans) replay = await unpackPlans(plans);
      if (opening) replayOpening = await unpackOpening(opening);
    } catch {
      status(tx.share.badLink);
      return;
    }
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
    // With the ✨ AI on, a seed-only link plays on as the model's track.
    const text = !replay && ai && state.aiPrefs.on ? `${tx.share.loaded(seed)} ${tx.ai.varies}` : tx.share.loaded(seed);
    remount({ ws: normalize(next), ...fresh(), replay, replayOpening, pending: null, status: text, open: null });
  }

  // A snapshot link adds its snapshot after yours, like ⬆ Importar does,
  // and leaves what plays alone.
  async function loadSharedSnap(packed) {
    history.replaceState(null, "", location.pathname + location.search);
    let merged;
    try {
      merged = importSnapshots(ws, await unpackSnap(packed));
    } catch {
      status(tx.snap.badLink);
      return;
    }
    const { added, left } = merged;
    const text = added ? tx.snap.linked(merged.ws.snapshots.at(-1).name) : left ? tx.snap.full : tx.snap.had;
    remount({ ws: merged.ws, status: text });
  }

  const onHash = () => {
    const snap = readSnapFragment(location?.hash);
    const shared = readFragment(location?.hash);
    if (snap) loadSharedSnap(snap);
    else if (shared) loadShared(shared);
  };

  // Over a playing mix the autopilot takes it as it is and carries on from
  // there (in `section`, when one was asked for); the background kick becomes
  // a real kick so it does not drop out. From silence it starts an intro, or
  // `section`; with the ✨ AI on it waits armed while the model plans the
  // first sections and then plays (`arm`: until ▶).
  function engageAuto(section = null, { arm = false } = {}) {
    if (!state.auto) stats?.count("autopilot"); // a new seed re-engages: not a start
    landStyle();
    restoreOutro(loopSeconds()); // a new seed over an outro: the pilot rides the levels from where they were
    engine.unbrake();
    const rearm = state.auto && state.armed; // still from silence
    const playing = rearm ? {} : { ...(state.pending ?? state.active) };
    state.armed = false; // the autopilot takes what was queued and starts
    state.auto = true;
    state.reseed = false;
    state.tour = null;
    state.bare = 0;
    state.rng = seeded(hashSeed(ws.seed));
    if (Object.keys(playing).length) {
      if (ws.bgKick && !playing.kick) playing.kick = BG_KICK_VARIANT;
      state.pilot = joinPilot(playing, section);
      state.replay = null; // a link's track only replays from silence
      state.replayOpening = null;
      cancelPlanning();
      state.run = newRun();
      adoptDrop();
      dressIn(Object.values(playing).sort());
      mixIn(playing);
      toneIn(playing);
      armForAi(arm);
      commit(playing);
      enterSection();
      showSection();
      if (cueWhenPlanned && !planning) cue();
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
    const start = startPilot(pilotLists(), state.rng, ws.style, section ?? "intro");
    state.pilot = start.pilot;
    cancelPlanning();
    state.run = newRun();
    dressIn(Object.values(start.active).sort());
    for (const id of start.rewrite) rewrite(id);
    mixIn(start.active);
    toneIn(start.active);
    improviseIn(Object.values(start.active));
    armForAi(arm, rearm);
    commit(start.active);
    if (state.replayOpening) {
      const opening = normalizeOpening(state.replayOpening, { lists: pilotLists(), style: ws.style, section: start.pilot.section });
      if (opening) openOn(opening);
    }
    enterSection();
    showSection();
    if (cueWhenPlanned && !planning) cue();
  }

  // Stopped with ✨ on, the autopilot waits armed while the model plans the
  // first sections, from silence or from a mix ⏹ left. It then plays by
  // itself (`cueWhenPlanned`), or waits for ▶ when ✨ armed it (`arm`).
  function armForAi(arm, rearm = false) {
    const wait = !engine.isRunning() && Boolean(ai) && state.aiPrefs.on && !state.replay;
    cueWhenPlanned = wait && (rearm ? cueWhenPlanned : !arm);
    if (cueWhenPlanned) engine.ensureContext(); // inside the click: the mix starts once planned
    state.armed = wait;
  }

  // The snapshot autopilot starts from the snapshot queued or playing, or
  // from the first, and turns the other autopilot off.
  function engageTour() {
    stats?.count("autopilot");
    landStyle();
    state.auto = false;
    state.pilot = null;
    cancelPlanning();
    engine.setPump({}); // the peak's pump was the other autopilot's
    const target = state.pending ?? state.active;
    const playing = ws.snapshots.find((s) => s.id === state.applied && sameLanes(target, s.active));
    const start = state.queuedSnap ?? playing ?? ws.snapshots[0];
    state.armed = false;
    state.tour = startTour(ws.snapshots, start.id);
    // Already queued or playing, it carries on from the next bar line (where
    // the background kick drops); anything else enters on that line, or at
    // once with the loop stopped.
    if (!engine.isRunning() || (start !== state.queuedSnap && start !== playing)) recall(start);
    showSection();
  }

  // A phase button: queued while the autopilot runs, else it starts there.
  function forceSection(id) {
    if (!state.auto) engageAuto(id);
    else {
      state.pilot = enqueue(state.pilot, id);
      requeue();
      showSection();
    }
  }

  // The queue changed: the plans for sections that no longer come go, and
  // the ✨ AI plans what now does.
  function requeue() {
    if (!state.pilot || !state.run || replaying()) return;
    const p = state.pilot;
    const ahead = state.run.ahead;
    const kept = keptAhead(ahead, sequence(p));
    // So do the plans made in another style than the one their section plays.
    const restyled = ahead.findIndex((e, i) => e.style !== styleAt(p, i, ws.style));
    dropAhead(restyled < 0 ? kept : Math.min(kept, restyled));
    planAhead();
  }

  // A vibe applied: the plans made with the old words go and the ✨ AI plans
  // again with the new ones, the form of the track first. Playing, the next
  // section's plan stays (and its place in the form), so the model has a
  // section's time to answer and none plays unplanned. Armed, the track
  // starts over from the seed, so the opening follows them too.
  function revibe() {
    if (!state.pilot || !state.run || !state.aiPrefs.on || replaying()) return;
    if (state.armed) {
      engageAuto(state.run.sections[0]);
      return;
    }
    dropAhead(1);
    if (planning?.form) cancelPlanning();
    const p = state.pilot;
    const decided = p.left === 1 && p.next ? 1 : 0; // its last loop already announced it
    const kept = Math.max(state.run.ahead.length, decided) - p.queue.length;
    state.pilot = withForm(p, (p.form ?? []).slice(0, Math.max(0, kept)));
    state.run.formed = false;
    planAhead();
  }

  // The plans ahead from slot `from` on go, with an ask for one of them; the
  // pilot lets go of the next section's while it still can.
  function dropAhead(from) {
    const p = state.pilot;
    const ahead = state.run.ahead;
    if (from === 0 && p.plan && p.left > 1) {
      const { plan: _dropped, ...rest } = p;
      state.pilot = rest;
      delete state.run.plans[sectionNo()];
    }
    ahead.splice(from);
    if (planning && planning.at - sectionNo() - 1 >= from) cancelPlanning();
  }

  // A style narrows the autopilot's sounds and takes the BPM into its range,
  // to the end nearest the BPM now (one inside it stays). While the pilot
  // plays, it waits for the next drop out of a breakdown (autopilot.js
  // styleOnDrop): the sections up to it are queued, the BPM rides the break,
  // and the plans from the drop on are asked again in the new style.
  function setStyle(value) {
    // Closing, there is no drop out of a break to wait for: it comes in on the next loop.
    if (!state.auto || !state.pilot || state.armed || !engine.isRunning() || state.pilot.closing) {
      styleNow(value);
      if (state.auto && state.pilot) state.pilot = rearrange(state.pilot);
      return;
    }
    state.pilot = styleOnDrop(state.pilot, value, ws.style);
    const handoff = state.pilot.handoff;
    if (handoff) rampBreak();
    else {
      // Called off: the break's ramp goes, back into the playing style's range.
      state.ramp = null;
      showRamp();
      startRampTo(bpmFor(ws.style, state.tempo));
    }
    status(handoff ? tx.pilot.styleWaits(tx.styles[value]) : tx.pilot.styleKept(tx.styles[value]));
    requeue();
    showSection();
  }

  function styleNow(value) {
    ws.style = value;
    style.value = value;
    persist();
    startRampTo(bpmFor(value, state.tempo));
  }

  function startRampTo(bpm) {
    if (bpm === state.tempo) return;
    rampTo.value = String(bpm);
    startRamp();
  }

  // A style the pilot has not reached yet: it plays from now on.
  function landStyle() {
    const handoff = state.pilot?.handoff;
    if (handoff) styleNow(handoff.style);
  }

  // A style on its way rides the BPM into its range over the break, once in
  // it: what is left of the breakdown and the build after it, so the new BPM
  // is there by the drop.
  function rampBreak() {
    const p = state.pilot;
    const handoff = p?.handoff;
    if (!handoff?.broke) return;
    const to = bpmFor(handoff.style, state.tempo);
    rampTo.value = String(to);
    const loops = p.left + (p.section === "breakdown" ? SECTIONS.build.loops[0] : 0);
    state.ramp = to === state.tempo ? null : { from: state.tempo, to, bars: loops * 2, done: 0 };
    showRamp();
  }

  function setSeed(value) {
    ws.seed = cleanSeed(value) || randomSeed();
    state.replay = null; // another track: a link's plans were for its own seed
    state.replayOpening = null;
    seedInput.value = ws.seed;
    persist();
    if (!state.auto) return;
    // Playing, the new track comes in on the next loop, not mid-bar.
    if (engine.isRunning()) {
      state.reseed = true;
      renderButtons();
    } else engageAuto();
  }

  /* ---- ✨ AI ---- */
  let alive = true;
  let failing = false; // the last ask failed: said once, until one works
  const sectionNo = () => state.run.sections.length - 1;
  // Chrome's model where it runs, unless another was picked.
  const engineNow = () => {
    const { engine } = state.aiPrefs;
    if (engine === "lmstudio" || clouds.includes(engine)) return engine;
    return state.chrome === "unavailable" ? "lmstudio" : "chrome";
  };
  const modelOf = (engine) => (isCloud(engine) ? state.aiPrefs.models[engine] : state.aiPrefs.model);
  const keyOf = (engine) => (isCloud(engine) ? state.aiPrefs.keys[engine] : "");
  // What the engine needs to be asked: an endpoint, or a linked account's key.
  const reach = (engine) =>
    isCloud(engine) ? { key: keyOf(engine), model: modelOf(engine) } : { endpoint: state.aiPrefs.endpoint, model: modelOf(engine) };
  // An ask goes with the instructions for the track it plans: the brief of
  // its style at its BPM and the listener's wish, then its level's rules.
  const systemFor = (style = ws.style, bpm = state.tempo) =>
    systemOf({ level: state.aiPrefs.level, style, bpm, vibe: state.aiPrefs.vibe });
  const asking = (engine, signal, track = {}) => ({ ...reach(engine), system: systemFor(track.style, track.bpm), signal });
  // What a prompt and its schema take from the settings.
  // An empty vibe is no message: the sounds go by id, with no words to match.
  // The set's length and how much of it has played, for the arc of the night.
  const setNow = () => ({ minutes: state.aiPrefs.set, elapsed: state.setSeconds });
  const asked = () => ({ level: state.aiPrefs.level, describe: Boolean(state.aiPrefs.vibe), set: setNow() });
  const knownOf = (engine) => (engine === "chrome" ? null : (ai?.[engine]?.known?.(isCloud(engine) ? keyOf(engine) : state.aiPrefs.endpoint) ?? null));
  // A share link's run, from silence: while it has an entry for the section
  // playing, that entry (or none) stands in for the model's answer.
  const replaying = () => Boolean(state.replay) && Boolean(state.run) && sectionNo() < state.replay.length;

  function showAi() {
    const { on, endpoint, vibe, level } = state.aiPrefs;
    const engine = engineNow();
    const name = tx.ai.engines[engine];
    const cloud = isCloud(engine);
    const model = modelOf(engine);
    aiBtn.setAttribute("aria-pressed", String(on));
    aiBtn.classList.toggle("is-thinking", Boolean(planning));
    aiPanel.hidden = !ai || !on;
    if (aiPanel.open !== state.aiPrefs.open) aiPanel.open = state.aiPrefs.open;
    const linked = cloud && !keyOf(engine) ? `${name} ${tx.ai.notLinked}` : model ? `${name} (${model})` : name;
    const [levelName, levelWhat] = tx.ai.levels[level];
    const leveled = level === LEVEL_DEFAULT ? linked : `${linked} · ${tx.ai.level} ${levelName.toLowerCase()}`;
    const what = state.aiPrefs.set ? `${leveled} · ${tx.ai.setShort(tx.ai.sets[state.aiPrefs.set])}` : leveled;
    aiSummary.textContent = vibe ? `${what} · «${vibe}»` : what;
    levelInput.value = level;
    setInput.value = String(state.aiPrefs.set);
    levelBox.title = `${tx.ai.levelTitle}. ${levelName}: ${levelWhat}`;
    const engines = [...(state.chrome === "unavailable" ? [] : ["chrome"]), "lmstudio", ...clouds];
    if (engineInput.options.length !== engines.length) {
      engineInput.replaceChildren(...engines.map((id) => el("option", { value: id, text: tx.ai.engines[id] })));
    }
    engineInput.value = engine;
    endpointBox.hidden = engine !== "lmstudio";
    keyBox.hidden = !cloud;
    modelBox.hidden = engine === "chrome";
    if (document.activeElement !== endpointInput) endpointInput.value = endpoint;
    if (cloud) {
      keyBox.title = tx.ai.keyTitle(name);
      keyLink.href = CLOUDS[engine].keys;
      unlinkBtn.hidden = !keyOf(engine);
      unlinkBtn.title = tx.ai.unlinkTitle(name);
      if (document.activeElement !== keyInput) keyInput.value = keyOf(engine);
    }
    modelBox.title = cloud ? tx.ai.modelTitleCloud(name) : tx.ai.modelTitle;
    modelsBtn.title = tx.ai.modelsRefresh(name);
    modelsBtn.setAttribute("aria-label", modelsBtn.title);
    showModels();
    if (document.activeElement !== vibeInput) vibeInput.value = vibe;
    noteVibe();
    showSection();
  }

  // Automatic, then what LM Studio or the account has; a saved model it no
  // longer lists stays, marked, until another is picked.
  function showModels() {
    const engine = engineNow();
    if (engine === "chrome") return;
    const model = modelOf(engine);
    const known = knownOf(engine);
    const missing = tx.ai.modelMissing(tx.ai.engines[engine]);
    const ids = [...(known ?? []), ...(model && !known?.includes(model) ? [model] : [])];
    const key = JSON.stringify([engine, known, ids]);
    if (modelInput.dataset.key !== key) {
      modelInput.dataset.key = key;
      modelInput.replaceChildren(
        el("option", { value: "", text: isCloud(engine) ? tx.ai.modelAutoCloud : tx.ai.modelAuto }),
        ...ids.map((id) => el("option", { value: id, text: known && !known.includes(id) ? `${id} ${missing}` : id })),
      );
    }
    modelInput.value = model;
  }

  function setPrefs(changes) {
    state.aiPrefs = { ...state.aiPrefs, ...changes };
    savePrefs(storage, state.aiPrefs);
    showAi();
  }

  function cancelPlanning() {
    planning?.abort.abort();
    planning = null;
    clearTimeout(retry);
    retry = 0;
    if (alive) showAi();
  }

  // One ask to the model at a time: `planning` holds what it is for. It is
  // cut off after ASK_TIMEOUT_MS whether or not the model honours the abort,
  // and a failed one asks again RETRY_MS later. `take` gets the answer;
  // `then(ok)` runs once it is over, unless something else took its place.
  let retry = 0;
  function ask(engine, what, send, take, then) {
    const abort = new AbortController();
    const cut = new Promise((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("cut")), { once: true }));
    const timer = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS);
    const mine = () => planning?.abort === abort;
    let ok = false;
    planning = { ...what, abort };
    Promise.race([send(abort.signal), cut])
      .then(
        (raw) => {
          if (!mine()) return;
          failing = false;
          ok = true;
          take(raw);
        },
        () => {
          if (!mine()) return;
          // Chrome's model may still need the click that downloads it.
          if (!failing) status(engine === "chrome" && state.chrome !== "available" ? tx.ai.chromeFailed : tx.ai.failed);
          failing = true;
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (!mine()) return;
        planning = null;
        if (!alive) return;
        showAi();
        if (!ok) retry = setTimeout(retryAsk, RETRY_MS);
        then(ok);
      });
    showAi();
  }

  function retryAsk() {
    retry = 0;
    if (alive && state.aiPrefs.on) planAhead();
  }

  // Stopped, with no autopilot on: the ✨ AI may arm one. A mix ⏹ left
  // armed for ▶ does not count: the pilot carries on from it.
  const silent = () => !state.auto && !state.tour && !engine.isRunning();

  // A click on ✨ (or a new engine, endpoint, key or model): gets the model
  // going, so the user hears now whether it answers: Chrome's may download
  // first; an account must be linked. `arm`: in silence the autopilot then
  // waits armed for ▶ while the model plans the first sections.
  function startAi({ arm = false } = {}) {
    cancelPlanning();
    failing = false;
    const engine = engineNow();
    const { endpoint } = state.aiPrefs;
    const model = modelOf(engine);
    const name = tx.ai.engines[engine];
    const cloud = isCloud(engine);
    if (cloud && !keyOf(engine)) {
      showModels();
      status(tx.ai.needKey(name));
      return;
    }
    const started =
      engine === "chrome"
        ? ai.chrome.start((done) => alive && status(tx.ai.downloading(Math.round(done * 100))), systemFor())
        : ai[engine].start(reach(engine));
    started.then(
      () => {
        if (engine === "chrome") state.chrome = "available"; // downloaded now
        if (!alive || !state.aiPrefs.on) return;
        showModels();
        const known = knownOf(engine);
        if (model && known && !known.includes(model)) status(cloud ? tx.ai.modelGoneCloud(model, name) : tx.ai.modelGone(model));
        else status(tx.ai.ready(name));
        if (arm && silent()) engageAuto(null, { arm: true });
        else planAhead();
      },
      (err) => {
        if (!alive || !state.aiPrefs.on) return;
        showModels();
        // A provider answers a bad key with 400 (Gemini), 401 or 403.
        const rejected = [400, 401, 403].includes(err?.status);
        status(
          engine === "chrome"
            ? tx.ai.chromeFailed
            : cloud
              ? rejected
                ? tx.ai.keyRejected(name)
                : tx.ai.cloudFailed(name)
              : tx.ai.unreachable(endpoint),
        );
      },
    );
  }

  // The pilot takes a plan for the section after this one (it records it, so
  // 🔗 Compartir can carry it), unless it comes too late. Whether it took it.
  function attach(plan) {
    const next = withPlan(state.pilot, plan);
    if (!plan || next === state.pilot) return false;
    state.pilot = next;
    state.run.plans[sectionNo()] = plan;
    return true;
  }

  // Each melodic sound's synth now.
  const synthsNow = () =>
    Object.fromEntries(
      Object.values(ws.lists)
        .flat()
        .filter((id) => defOf(id).kind === "notes")
        .map((id) => [id, dataOf(id).synth]),
    );

  // The opening (planner.js normalizeOpening) laid over the armed intro: its
  // sounds, length, dress and parts, and a swell on the first beat. A lead it
  // brings in with no part gets a new one, like any lead the pilot brings.
  function openOn(opening) {
    state.run.opening = opening;
    const from = state.pending ?? state.active;
    const next = openWith(from, opening, pilotLists(), ws.style);
    state.pilot = { ...state.pilot, opening: true, ...(opening.bars ? { left: opening.bars / 2, length: opening.bars / 2 } : {}) };
    const dressed = opening.dress ?? [];
    for (const d of dressed) state.run.dress[d.id] = d;
    const playing = new Set(Object.values(next));
    const brought = entering(from, next);
    dressIn([...new Set([...brought, ...dressed.filter((d) => playing.has(d.id)).map((d) => d.id)])]);
    for (const id of brought) if (layerOf(id).id === "lead" && !opening.parts?.lead) rewrite(id);
    for (const [layer, degrees] of Object.entries(opening.parts ?? {})) {
      const id = opening.layers[layer]?.[0];
      if (playing.has(id)) writeIn(id, degrees);
    }
    state.openFx = opening.fx && !ws.banned.includes(opening.fx) ? opening.fx : null;
    mixIn(next);
    toneIn(next);
    improviseIn(Object.values(next));
    commit(next);
    if (state.run.sounds.length) state.run.sounds[0] = [...playing].sort();
  }

  // From silence, armed, the first ask is the opening; then planAhead().
  // Once ▶ plays, an answer comes too late and is dropped.
  const wantsOpening = () => state.armed && sectionNo() === 0 && state.run.opening === undefined;
  function planOpening() {
    const p = state.pilot;
    const engine = engineNow();
    if (isCloud(engine) && !keyOf(engine)) return;
    const ctx = { lists: pilotLists(), style: ws.style, section: p.section, ...asked() };
    const { vibe } = state.aiPrefs;
    const prompt = openingPrompt({
      ...ctx,
      active: state.pending ?? state.active,
      vibe,
      names: ws.names,
      synths: synthsNow(),
    });
    ask(
      engine,
      { at: sectionNo(), opening: true },
      (signal) => ai[engine].plan(prompt, openingSchema(ctx), asking(engine, signal)),
      (raw) => {
        const opening = normalizeOpening(raw, ctx);
        if (!opening || !state.armed || state.pilot.left !== state.pilot.length) return;
        openOn(opening);
        state.run.why = whyOf(raw);
        vibeFresh = false;
      },
      (ok) => {
        if (!state.run) return;
        state.run.opening ??= null;
        if (ok) planAhead();
        else settle(); // the model is down: the pilot plays alone, or waits for ▶
      },
    );
    status(tx.ai.arming(1, AHEAD + 1));
  }

  // Asks the model for the first section ahead with no plan, until AHEAD of
  // them have one: each answer asks for the next. The next section's own
  // plan only while the pilot can still take it, before this one's last loop.
  // An armed autopilot plays when the asks stop, or says it is ready.
  function planAhead() {
    const p = state.pilot;
    if (!ai || !state.aiPrefs.on || !state.auto || !p || !state.run || planning || replaying()) return;
    if (wantsOpening()) {
      planOpening();
      return;
    }
    const engine = engineNow();
    if (isCloud(engine) && !keyOf(engine)) return;
    // The low level skips the form: one ask less before the section comes.
    // Closing, the model lays out the closing in its place, while it may.
    if (p.closing && !closingOpen(p)) state.run.formed = true;
    if (!state.run.formed && asksForm(state.aiPrefs.level)) {
      if (p.closing) planClosing(engine);
      else planForm(engine);
      return;
    }
    const slot = state.run.ahead.length;
    if (slot >= AHEAD || (slot === 0 && p.left <= 1)) return;
    const coming = sequence(p);
    const next = coming[slot] ?? null; // queued by hand or by the form: the model arranges that one
    if (p.closing && !next) return; // nothing plays after the outro
    if (next && !PLAN_SECTIONS.includes(next) && next !== OUTRO) return;
    const at = sectionNo() + 1 + slot;
    const ctx = { lists: pilotLists(), style: styleAt(p, slot, ws.style), next, ...asked() };
    const { vibe } = state.aiPrefs;
    const fresh = vibeFresh;
    const planned = state.run.ahead.map((e) => e.plan);
    const mix = state.pending ?? state.active; // armed, what ▶ plays
    const bpm = ctx.style === ws.style ? state.tempo : bpmFor(ctx.style, state.tempo);
    const prompt = planPrompt({
      ...ctx,
      formed: slot >= p.queue.length,
      form: coming.slice(slot + 1),
      planned,
      theme: themeAfter(p, mix, planned),
      active: mix,
      sections: state.run.sections,
      sounds: state.run.sounds,
      dressed: Object.values(state.run.dress),
      synths: synthsNow(),
      bars: p.length * 2,
      vibe,
      fresh,
      names: ws.names,
      closing: p.closing ? { seconds: p.closing.left * loopSeconds(), route: coming } : null,
    });
    let more = false;
    ask(
      engine,
      { at },
      (signal) => ai[engine].plan(prompt, planSchema(ctx), asking(engine, signal, { style: ctx.style, bpm })),
      (raw) => {
        const plan = (next === OUTRO ? normalizeOutro : normalizePlan)(raw, { lists: pilotLists(), style: ctx.style });
        // The section it plans may be the next one by now.
        const ahead = state.run.ahead;
        if (!plan || at !== sectionNo() + 1 + ahead.length || (!ahead.length && !attach(plan))) return;
        ahead.push({ plan, why: whyOf(raw), queued: Boolean(next), style: ctx.style });
        more = true;
        if (fresh) {
          vibeFresh = false;
          status(tx.ai.vibeApplied(vibe, tx.sections[plan.section]));
        }
      },
      () => {
        if (more) planAhead();
        settle();
      },
    );
    const opened = state.run.opening !== undefined ? 1 : 0;
    if (state.armed && !failing) status(tx.ai.arming(slot + 1 + opened, AHEAD + opened));
  }

  // An armed autopilot plays once the ✨ AI stops asking, or says it is ready.
  function settle() {
    if (planning || !state.auto || !state.armed) return;
    const length = state.run.ahead.length + (state.run.opening ? 1 : 0);
    if (cueWhenPlanned) cue();
    else status(length ? tx.ai.armed(length) : tx.ai.failed);
  }

  // Asks the model once per run for the form of the track: the order of the
  // sections after the queue (and the form kept, after a vibe), which the
  // pilot walks and each plan then fills in. Answered or not, the plans follow.
  function planForm(engine) {
    // The sections coming already: the queue, the form kept, the plans past them.
    const comingNow = () => {
      const coming = sequence(state.pilot);
      for (const e of state.run.ahead.slice(coming.length)) coming.push(e.plan.section);
      return coming;
    };
    const prompt = formPrompt({
      sections: state.run.sections,
      coming: comingNow(),
      vibe: state.aiPrefs.vibe,
      set: setNow(),
    });
    ask(
      engine,
      { form: true },
      (signal) => ai[engine].plan(prompt, formSchema(), asking(engine, signal)),
      (raw) => {
        const form = normalizeForm(raw);
        if (!form.length) return;
        state.pilot = withForm(state.pilot, [...comingNow().slice(state.pilot.queue.length), ...form]);
        state.run.formWhy = whyOf(raw);
        if (!state.armed) status(tx.ai.formReady(form.length));
      },
      (ok) => {
        if (!state.run) return;
        state.run.formed = true;
        if (ok) planAhead(); // failed, the retry asks for the sections
        settle();
      },
    );
    if (state.armed) status(tx.ai.forming);
  }

  // 🌅 Asks the model for the sections that close the set, before the
  // outro, in what it has left (autopilot.js routeRoom); the pilot walks them
  // in place of its own route. An answer for a section gone by is too late:
  // the pilot's route stays. Answered or not, the plans follow.
  function planClosing(engine) {
    const p = state.pilot;
    const at = sectionNo();
    const prompt = closingPrompt({
      sections: state.run.sections,
      left: p.left * 2,
      coming: announced(p),
      room: Math.max(0, routeRoom(p)) * 2,
      seconds: p.closing.left * loopSeconds(),
      vibe: state.aiPrefs.vibe,
    });
    ask(
      engine,
      { form: true, closing: true },
      (signal) => ai[engine].plan(prompt, closingSchema(), asking(engine, signal)),
      (raw) => {
        if (at !== sectionNo() || !closingOpen(state.pilot)) return;
        state.pilot = closeWith(state.pilot, normalizeClosing(raw));
        state.run.closeWhy = whyOf(raw);
        requeue();
        status(tx.ai.closingReady(sequence(state.pilot).map((id) => tx.sections[id]).join(" → ")));
      },
      (ok) => {
        if (!state.run) return;
        state.run.formed = true;
        if (ok) planAhead(); // failed, the retry plans the pilot's route
      },
    );
  }

  // A new section for the pilot: the plan made for it leaves the ones ahead
  // (all of them, if the pilot went elsewhere) and the next one's goes to the
  // pilot; or a share link's plan for the one after it.
  function enterSection() {
    state.run ??= newRun();
    state.run.sections.push(state.pilot.section);
    state.run.sounds[sectionNo()] = [...new Set(Object.values(state.pending ?? state.active))].sort();
    const ahead = state.run.ahead;
    const head = ahead.shift();
    if (head && head.plan.section !== state.pilot.section) ahead.length = 0;
    if (planning && !planning.form && planning.at !== sectionNo() + 1 + ahead.length) cancelPlanning();
    if (replaying()) {
      const raw = state.replay[sectionNo()];
      if (raw) attach(normalizePlan(raw, { lists: pilotLists(), style: ws.style }));
      return;
    }
    if (ahead.length) attach(ahead[0].plan);
    planAhead();
  }

  aiBtn.addEventListener("click", () => {
    if (state.aiPrefs.on) {
      setPrefs({ on: false });
      cancelPlanning();
      if (cueWhenPlanned) cue();
      return;
    }
    setPrefs({ on: true });
    startAi({ arm: true });
  });
  engineInput.addEventListener("change", () => {
    const engine = engineInput.value;
    setPrefs({ engine: engine === "lmstudio" || clouds.includes(engine) ? engine : "chrome" });
    startAi();
  });
  // A new level asks again at once, with its own instructions.
  levelInput.addEventListener("change", () => {
    setPrefs({ level: LEVELS.includes(levelInput.value) ? levelInput.value : state.aiPrefs.level });
    startAi();
  });
  // The next asks place themselves in the new length; nothing is asked again.
  setInput.addEventListener("change", () => {
    const minutes = Number(setInput.value);
    setPrefs({ set: SET_LENGTHS.includes(minutes) ? minutes : 0 });
    status(state.aiPrefs.set ? tx.ai.setSaved(tx.ai.sets[state.aiPrefs.set]) : tx.ai.setOpen);
  });
  vibeInput.addEventListener("input", noteVibe);
  keyInput.addEventListener("change", () => {
    const engine = engineNow();
    if (!isCloud(engine)) return;
    const key = cleanKey(keyInput.value);
    if (keyInput.value.trim() && !key) {
      status(tx.ai.badKey);
      keyInput.value = keyOf(engine);
      return;
    }
    setPrefs({ keys: { ...state.aiPrefs.keys, [engine]: key } });
    startAi();
  });
  unlinkBtn.addEventListener("click", (e) => {
    e.preventDefault(); // inside the field's label
    const engine = engineNow();
    if (!isCloud(engine)) return;
    cancelPlanning();
    keyInput.value = "";
    setPrefs({ keys: { ...state.aiPrefs.keys, [engine]: "" } });
    showModels();
    status(tx.ai.unlinked(tx.ai.engines[engine]));
  });
  endpointInput.addEventListener("change", () => {
    const endpoint = cleanEndpoint(endpointInput.value);
    if (!endpoint) {
      status(tx.ai.badEndpoint);
      endpointInput.value = state.aiPrefs.endpoint;
      return;
    }
    setPrefs({ endpoint });
    endpointInput.value = endpoint;
    startAi();
  });
  modelInput.addEventListener("change", () => {
    const engine = engineNow();
    setPrefs(isCloud(engine) ? { models: { ...state.aiPrefs.models, [engine]: modelInput.value } } : { model: modelInput.value });
    startAi();
  });
  modelsBtn.addEventListener("click", startAi);
  aiPanel.addEventListener("toggle", () => {
    if (aiPanel.open !== state.aiPrefs.open) setPrefs({ open: aiPanel.open });
  });
  // The vibe's words, kept as typed: the next plans asked follow them.
  function saveVibe() {
    const vibe = vibeInput.value.replace(/\s+/g, " ").trim().slice(0, 200);
    if (vibe === state.aiPrefs.vibe) return false;
    setPrefs({ vibe });
    vibeFresh = Boolean(vibe);
    return true;
  }
  // Aplicar (or Enter): the words now, even the same ones again.
  function applyVibe() {
    saveVibe();
    const { vibe } = state.aiPrefs;
    vibeFresh = Boolean(vibe);
    revibe();
    const p = state.auto ? state.pilot : null;
    const kept = state.run?.ahead[0]?.plan.section;
    if (planning && !state.armed) status(tx.ai.vibeAsking(vibe, p && kept ? tx.sections[kept] : null));
    else if (p && state.aiPrefs.on && !replaying() && !planning && !state.armed) status(tx.ai.vibeLater(vibe));
    else if (!planning) status(tx.ai.vibeSaved(vibe));
    showSection();
  }
  vibeInput.addEventListener("change", () => {
    if (saveVibe()) status(tx.ai.vibeSaved(state.aiPrefs.vibe));
  });
  vibeInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return; // an IME's Enter picks a word
    e.preventDefault();
    applyVibe();
  });
  vibeBtn.addEventListener("click", (e) => {
    e.preventDefault(); // inside the field's label
    applyVibe();
  });
  if (ai?.chrome.supported()) {
    ai.chrome.availability(lang()).then((can) => {
      if (!alive) return;
      state.chrome = can;
      showAi();
    });
  }

  /* ---- controls ---- */
  bpm.addEventListener("input", () => {
    state.ramp = null; // the hand on the slider wins
    setTempo(Number(bpm.value));
    showRamp();
  });
  // Tap tempo (tempo.js): the first tap of a count takes the loop back to its
  // 1, every tap after it brings the BPM and the phase onto the tapped beat.
  // On the press, not the release, and timed by the event, not by when the
  // handler runs: a busy main thread would otherwise jitter every tap.
  let taps = null;
  const tapTime = (e) => {
    const now = performance.now();
    return Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now; // an epoch timeStamp (old engines) is no use
  };
  const tap = (e) => {
    const at = tapTime(e);
    const before = taps;
    taps = addTap(taps, at);
    if (taps === before) return; // a bounce
    state.ramp = null; // the hand wins
    const beat = tapBeat(taps);
    if (beat) {
      setTempo(beat.bpm);
      engine.align(beat.at);
    } else engine.restart(at);
    showRamp();
  };
  tapBtn.addEventListener("pointerdown", (e) => {
    if (e.button === 0) tap(e);
  });
  // Space and Enter tap on the key press. The key's own click (Space clicks on
  // the release) is not a second tap; a click with no pointer or key behind it
  // (assistive tech) is a tap.
  let keyedAt = -Infinity;
  tapBtn.addEventListener("keydown", (e) => {
    if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
    e.preventDefault();
    keyedAt = performance.now();
    tap(e);
  });
  tapBtn.addEventListener("click", (e) => {
    if (e.detail === 0 && performance.now() - keyedAt > 1000) tap(e);
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
  function setVolume(value) {
    engine.setVolume(value);
    volumeOut.textContent = `${Math.round(value * 100)} %`;
  }
  volumeInput.addEventListener("input", () => {
    setVolume(Number(volumeInput.value));
    saveVolume(storage, Number(volumeInput.value));
  });
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
  // What played stays queued for ▶ (`keep`), so it comes back together on
  // the first step.
  function stopSet({ keep = true } = {}) {
    const playing = state.active;
    state.active = {};
    state.armed = keep && Object.keys(playing).length > 0;
    state.pending = state.armed ? playing : null;
    landStyle();
    state.auto = false;
    state.pilot = null;
    state.tour = null;
    cancelPlanning();
    cueWhenPlanned = false;
    state.queuedSnap = null;
    state.ramp = null;
    state.newParts.clear();
    state.setSeconds = 0;
    open?.editor.showNewPart(false);
    for (const action of state.queued.get(open?.id) ?? []) open.editor.showQueued(action, false);
    state.queued.clear();
    showRamp();
    if (state.buildUp) setBuildUp(state.buildUp.id, false);
    state.drop = null;
    setBar(0, {});
    engine.setPump({});
    lanes = {};
    engine.stop();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    fxShown = new Set();
    restoreOutro(); // once the lanes are gone: no level jumps before the fade
    renderButtons(new Set());
    paintStep(null);
    showSection();
  }
  stopBtn.addEventListener("click", () => stopSet());

  // 🌅 The closing: the pilot (over what plays, if it was off) queues the
  // sections up to a last peak and the outro, all within CLOSE_SECONDS at
  // the slowest tempo it is heading to; with ✨ on the model lays them out
  // instead (planClosing) and plans each one. 🌅 again calls it off while
  // the outro is not announced. A new style on its way goes with its ramp.
  function closeNow() {
    if (!engine.isRunning() || state.armed) return;
    if (!state.auto) engageAuto();
    if (state.pilot.handoff) {
      state.ramp = null;
      showRamp();
    }
    const slowest = Math.min(state.tempo, state.ramp?.to ?? state.tempo);
    state.pilot = closeSet(state.pilot, Math.floor(CLOSE_SECONDS / loopSeconds(slowest)));
    if (planning?.form) cancelPlanning(); // a form: the closing is laid out in its place
    state.run.formed = false;
    requeue();
    const route = sequence(state.pilot).map((id) => tx.sections[id]).join(" → ");
    status(tx.pilot.closing(route, clock(state.pilot.closing.left * loopSeconds())));
    showSection();
  }

  function uncloseNow() {
    state.pilot = uncloseSet(state.pilot);
    if (planning?.form) cancelPlanning();
    state.run.formed = false; // the form of the track is laid out again
    state.run.closeWhy = "";
    requeue();
    status(tx.pilot.closeOff);
    showSection();
  }

  // Past the outro's last loop: everything stops, nothing stays queued for ▶.
  function endSet() {
    if (!alive || !state.pilot?.closing) return;
    stopSet({ keep: false });
    status(tx.pilot.closed);
  }

  closeBtn.addEventListener("click", () => {
    if (closingOpen(state.auto ? state.pilot : null)) uncloseNow();
    else if (!state.pilot?.closing) closeNow();
  });
  // The keyboard's play/pause and stop keys press the same buttons.
  mediaKeys?.bind({ playing: engine.isRunning, play: () => cueBtn.click(), stop: () => stopBtn.click() });
  // What was queued plays: ▶, or the armed autopilot once its plans are in.
  function cue() {
    if (!state.armed) return;
    engine.ensureContext(); // inside ▶: the queued mix starts now
    state.armed = false;
    cueWhenPlanned = false;
    if (state.queuedSnap) load(state.queuedSnap);
    if (state.pending) state.active = state.pending;
    state.pending = null;
    state.queuedSnap = null;
    sync();
    if (planning?.opening) {
      cancelPlanning(); // too late for an opening: on with the sections ahead
      state.run.opening = null;
      planAhead();
    }
    showSection();
  }
  cueBtn.addEventListener("click", () => {
    if (!state.armed) {
      state.armed = true;
      renderButtons();
      return;
    }
    cue();
  });
  autoBtn.addEventListener("click", () => {
    if (!state.auto) {
      engageAuto();
      return;
    }
    if (state.armed) {
      cue(); // armed, it starts now with the plans it has
      return;
    }
    landStyle();
    restoreOutro(loopSeconds()); // an outro let go of comes back over a loop
    engine.unbrake(); // and so does a vinyl stopping
    state.auto = false;
    state.pilot = null;
    cancelPlanning();
    engine.setPump({}); // a drop on its way finishes by hand
    sync(); // the background kick may come back
    showSection();
  });
  // 💥 Drop: by hand it arms for the next bar line (a second click takes it
  // back); under the pilot it makes the next loop its drop into a peak.
  dropBtn.addEventListener("click", () => {
    if (!engine.isRunning()) return;
    if (state.auto && state.pilot) {
      state.pilot = dropNext(state.pilot);
      requeue();
    } else if (!state.drop) state.drop = { phase: "armed" };
    else if (state.drop.phase === "armed") state.drop = null;
    showSection();
  });
  tourBtn.addEventListener("click", () => {
    if (!state.tour) {
      engageTour();
      return;
    }
    state.tour = null;
    sync(); // the background kick may come back
    showSection();
  });
  seedInput.addEventListener("change", () => setSeed(seedInput.value));
  nextBtn.addEventListener("click", () => {
    if (state.tour) state.tour = skipTour(state.tour);
    else if (state.auto && state.pilot) state.pilot = skip(state.pilot);
    showSection();
  });
  changes.addEventListener("input", () => {
    ws.changeBars = CHANGE_BARS[Number(changes.value)];
    changesOut.textContent = tx.pilot.every(ws.changeBars);
    persist();
    if (state.tour) showSection();
  });
  diceBtn.addEventListener("click", () => setSeed(randomSeed()));
  // This page's URL with `fragment`, to the clipboard or, failing that, on screen.
  async function copyLink(fragment, copied) {
    const url = `${location.origin}${location.pathname}${fragment}`;
    try {
      await navigator.clipboard.writeText(url);
      status(copied);
    } catch {
      status(tx.share.manual(url));
    }
  }
  shareBtn.addEventListener("click", async () => {
    stats?.count("shares");
    copyLink(await shareFragment(ws, state.run?.plans ?? [], state.run?.opening ?? state.replayOpening), tx.share.copied);
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
        tour: null,
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
  showAi();
  showRec();
  showRamp();
  setDj(state.dj);
  setVolume(Number(volumeInput.value));
  syncSamples();
  if (resume) {
    persist();
    sync();
    if (resume.open && tiles.has(resume.open)) openEditor(layerOf(resume.open), resume.open);
    else if (resume.open && snapTiles.has(resume.open)) openSnapEditor(resume.open);
    if (resume.status) status(resume.status);
    planAhead(); // a remount drops the ask on its way
  } else {
    if (!stored.seed) persist();
    renderButtons(new Set());
    onHash();
  }
  return { ws, state, destroy };
}
