// Per-browser persistence of the workspace (workspace.js) and the language.
// Every access is guarded: storage can be missing or throw (private mode,
// blocked site data), and the sampler must work the same without it.

const KEY = "psy-sampler:v2";

export function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadState(storage) {
  try {
    const raw = storage?.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveState(storage, state) {
  try {
    storage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Full or blocked: the edits still live for this session.
  }
}

// The first-visit welcome (ui/intro.js) shows once per browser. Without
// storage it would show on every visit, so then it never shows.
const INTRO_KEY = "psy-sampler:intro";

export function introSeen(storage) {
  try {
    return !storage || storage.getItem(INTRO_KEY) !== null;
  } catch {
    return true;
  }
}

export function markIntroSeen(storage) {
  try {
    storage?.setItem(INTRO_KEY, "1");
  } catch {
    // Blocked: it shows again next visit.
  }
}

// Which of the editor's boxes are open (folds.js): a per-browser habit, kept
// apart from the workspace so it never reaches a share link or the cloud.
const FOLDS_KEY = "psy-sampler:folds";

export function loadFolds(storage) {
  try {
    return JSON.parse(storage?.getItem(FOLDS_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveFolds(storage, folds) {
  try {
    storage?.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // Blocked: every box starts folded again next visit.
  }
}

// The master volume: how loud this browser's speakers want it, never part of
// the workspace, a share link or the cloud.
const VOLUME_KEY = "psy-sampler:volume";

export function loadVolume(storage) {
  try {
    const v = Number(storage?.getItem(VOLUME_KEY) ?? 1);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
}

export function saveVolume(storage, volume) {
  try {
    storage?.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Blocked: it starts at full volume again next visit.
  }
}
