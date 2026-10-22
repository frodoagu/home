import { describe, expect, it } from "vitest";
import { LAYERS } from "../catalog.js";
import { DEFAULTS } from "../audio/patterns.js";
import { PARAMS, LEVEL, SYNTHS } from "../audio/params.js";
import { SCALES } from "../audio/music.js";
import { DICTS, detectLang, pathLang } from "./index.js";

// Same keys, same value kinds (string, function, array length) at every depth.
function shape(value) {
  if (typeof value === "function") return "fn";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])]));
  }
  return typeof value;
}

describe("dictionaries", () => {
  it("en, pt and fr have exactly the shape of es", () => {
    expect(shape(DICTS.en)).toEqual(shape(DICTS.es));
    expect(shape(DICTS.pt)).toEqual(shape(DICTS.es));
    expect(shape(DICTS.fr)).toEqual(shape(DICTS.es));
  });

  it("name every layer, variant, synth, scale and slider", () => {
    const es = DICTS.es;
    expect(Object.keys(es.layers).sort()).toEqual(LAYERS.map((l) => l.id).sort());
    expect(Object.keys(es.variants).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(Object.keys(es.synths).sort()).toEqual(SYNTHS.map((s) => s.id).sort());
    expect(Object.keys(es.scales).sort()).toEqual(Object.keys(SCALES).sort());
    const labels = new Set([LEVEL, ...Object.values(PARAMS).flat()].map((p) => p.label));
    for (const key of labels) expect(es.params[key], key).toBeTypeOf("string");
    for (const s of SYNTHS) expect(es.synthGroups[s.group]).toBeTypeOf("string");
    expect(es.noteNames).toHaveLength(12);
  });
});

describe("detectLang", () => {
  it("prefers the stored choice, then the browser, then Spanish", () => {
    expect(detectLang("pt", ["en-US"])).toBe("pt");
    expect(detectLang(undefined, ["de-DE", "pt-BR"])).toBe("pt");
    expect(detectLang(undefined, ["fr-FR", "pt-BR"])).toBe("fr");
    expect(detectLang("xx", ["EN"])).toBe("en");
    expect(detectLang(null, ["de"])).toBe("es");
    expect(detectLang("constructor", ["__proto__"])).toBe("es");
  });

  it("a language's own page wins over both", () => {
    expect(detectLang("pt", ["en-US"], "/fr/")).toBe("fr");
    expect(detectLang("pt", ["en-US"], "/")).toBe("pt");
  });
});

describe("pathLang", () => {
  it("reads /<lang>/ and nothing else", () => {
    expect(pathLang("/en/")).toBe("en");
    expect(pathLang("/en")).toBe("en");
    expect(pathLang("/")).toBeNull();
    expect(pathLang("/de/")).toBeNull();
    expect(pathLang("/en/visuals.html")).toBeNull();
    expect(pathLang("/__/")).toBeNull();
  });
});
