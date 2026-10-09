// Per-browser persistence of the edits (variant data + effect switches).
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
