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
