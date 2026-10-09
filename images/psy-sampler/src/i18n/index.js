// UI language. t() returns the active dictionary; strings that take values
// are functions in it. Switching language re-renders the app (app.js).
import en from "./en.js";
import es from "./es.js";
import pt from "./pt.js";

export const DICTS = { es, en, pt };
export const LANGS = Object.keys(DICTS);
export const DEFAULT_LANG = "es";

let current = DEFAULT_LANG;

export const t = () => DICTS[current];
export const lang = () => current;

export function setLang(id) {
  current = id in DICTS ? id : DEFAULT_LANG;
  return current;
}

// The stored choice wins; else the browser's first supported language.
export function detectLang(saved, languages = []) {
  if (saved in DICTS) return saved;
  for (const l of languages) {
    const id = String(l).slice(0, 2).toLowerCase();
    if (id in DICTS) return id;
  }
  return DEFAULT_LANG;
}
