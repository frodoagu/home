import { describe, it, expect } from "vitest";
import { apps, privateLinks, CATEGORIES, getApp } from "./registry";

const isSubset = (cats) => cats.every((c) => CATEGORIES.includes(c));

describe("registry · apps públicas", () => {
  it("cada app tiene los campos requeridos y un Component", () => {
    for (const a of apps) {
      expect(typeof a.slug).toBe("string");
      expect(a.slug).toMatch(/^[a-z0-9-]+$/); // kebab-case
      expect(typeof a.title).toBe("string");
      expect(typeof a.description).toBe("string");
      expect(typeof a.Component).toBe("function");
      expect(a.icon).toBeTruthy();
    }
  });

  it("los slugs son únicos", () => {
    const slugs = apps.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("toda categoría usada existe en CATEGORIES", () => {
    for (const a of apps) expect(isSubset(a.categories ?? [])).toBe(true);
  });
});

describe("registry · enlaces privados", () => {
  it("cada enlace tiene href https y categorías válidas", () => {
    for (const l of privateLinks) {
      expect(l.href).toMatch(/^https:\/\//);
      expect(typeof l.title).toBe("string");
      expect(isSubset(l.categories ?? [])).toBe(true);
      expect(l.icon).toBeTruthy();
    }
  });

  it("los slugs privados son únicos", () => {
    const slugs = privateLinks.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("getApp", () => {
  it("encuentra una app por slug", () => {
    const first = apps[0];
    expect(getApp(first.slug)).toBe(first);
  });

  it("devuelve undefined para slugs inexistentes", () => {
    expect(getApp("no-existe")).toBeUndefined();
  });
});
