// UI language. t() returns the active dictionary; strings that take values
// are functions in it. Switching language re-renders the app (app.js).
import en from "./en.js";
import es from "./es.js";
import fr from "./fr.js";
import pt from "./pt.js";

export const DICTS = { es, en, pt, fr };
export const LANGS = Object.keys(DICTS);
export const DEFAULT_LANG = "es";

let current = DEFAULT_LANG;

export const t = () => DICTS[current];
export const lang = () => current;

export function setLang(id) {
  current = Object.hasOwn(DICTS, id) ? id : DEFAULT_LANG;
  return current;
}

// Each language has a page of its own (/es/, /en/...), for search engines.
export const langPath = (id) => `/${id}/`;

export function pathLang(pathname = "") {
  const id = /^\/([a-z]{2})\/?$/.exec(pathname)?.[1];
  return Object.hasOwn(DICTS, id) ? id : null;
}

// The page's language wins, then the stored choice, then the browser's first
// supported language.
export function detectLang(saved, languages = [], pathname = "") {
  const fromPath = pathLang(pathname);
  if (fromPath) return fromPath;
  if (Object.hasOwn(DICTS, saved)) return saved;
  for (const l of languages) {
    const id = String(l).slice(0, 2).toLowerCase();
    if (Object.hasOwn(DICTS, id)) return id;
  }
  return DEFAULT_LANG;
}
