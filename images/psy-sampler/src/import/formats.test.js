import { describe, expect, it } from "vitest";
import { ACCEPT, FORMATS, kindOf } from "./formats.js";

const KINDS = { audio: "audio", archives: "zip", instruments: "sf2", projects: "project", closed: "closed" };

describe("formats", () => {
  it("lists each extension once, lowercase, in exactly one group", () => {
    const all = Object.values(FORMATS).flatMap((group) => group.map(([ext]) => ext));
    expect(new Set(all).size).toBe(all.length);
    for (const ext of all) expect(ext).toMatch(/^[a-z0-9]+$/);
  });

  it("what the guide lists is how the importer sorts files", () => {
    for (const [group, entries] of Object.entries(FORMATS)) {
      for (const [ext] of entries) expect(kindOf(ext), ext).toBe(KINDS[group]);
    }
    expect(kindOf("txt")).toBeNull();
    expect(kindOf("constructor")).toBeNull();
  });

  it("the file dialog offers everything readable, and no closed format", () => {
    const accepted = ACCEPT.split(",");
    expect(accepted[0]).toBe("audio/*");
    for (const group of ["audio", "archives", "instruments", "projects"]) {
      for (const [ext] of FORMATS[group]) expect(accepted).toContain(`.${ext}`);
    }
    for (const [ext] of FORMATS.closed) expect(accepted).not.toContain(`.${ext}`);
  });
});
