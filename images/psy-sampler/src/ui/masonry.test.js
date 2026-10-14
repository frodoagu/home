// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { masonry } from "./masonry.js";

describe("masonry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("spans each child its height plus the column gap", () => {
    let report;
    const observed = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb) {
          report = cb;
        }
        observe(node) {
          observed.push(node);
        }
        disconnect() {}
      },
    );
    const grid = document.createElement("div");
    grid.style.columnGap = "10px";
    const a = grid.appendChild(document.createElement("section"));
    const b = grid.appendChild(document.createElement("section"));
    a.getBoundingClientRect = () => ({ height: 120.4 });
    b.getBoundingClientRect = () => ({ height: 300 });
    document.body.append(grid);
    masonry(grid);
    expect(observed).toEqual([a, b]);
    report([{ target: a }, { target: b }]);
    expect(a.style.getPropertyValue("--span")).toBe("131");
    expect(b.style.getPropertyValue("--span")).toBe("310");
    grid.remove();
  });

  it("does nothing without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const grid = document.createElement("div");
    grid.append(document.createElement("section"));
    expect(() => masonry(grid).destroy()).not.toThrow();
  });
});
