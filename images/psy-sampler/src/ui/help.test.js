// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import es from "../i18n/es.js";
import { createHelp, matches, rich } from "./help.js";

const html = (nodes) => nodes.map((n) => (typeof n === "string" ? n : n.outerHTML)).join("");

function open() {
  const { dialog } = createHelp(es.help);
  document.body.replaceChildren(dialog);
  const search = dialog.querySelector(".help-search");
  const type = (q) => {
    search.value = q;
    search.dispatchEvent(new Event("input"));
  };
  const sections = [...dialog.querySelectorAll(".help-section")];
  const visible = (sel) => [...dialog.querySelectorAll(sel)].filter((n) => !n.hidden && !n.closest("[hidden]"));
  return { dialog, search, type, sections, visible };
}

describe("matches", () => {
  it("ignores case and accents and maps back onto the original text", () => {
    expect(matches("Condición y CONDICION", "condicion")).toEqual([
      [0, 9],
      [12, 21],
    ]);
    expect(matches("Probabilidad", "  ")).toEqual([]);
  });
});

describe("rich", () => {
  it("puts keys in keycaps and marks the search hits, even inside a key", () => {
    expect(html(rich("Ctrl + clic"))).toBe("<kbd>Ctrl</kbd> + clic");
    expect(html(rich("Ctrl + clic", "trl + c"))).toBe("<kbd>C</kbd><kbd><mark>trl</mark></kbd><mark> + c</mark>lic");
    expect(html(rich("arrastrala (o ← →)"))).toBe("arrastrala (o <kbd>←</kbd> <kbd>→</kbd>)");
    expect(html(rich("Alternar"))).toBe("Alternar");
  });
});

describe("help page", () => {
  it("folds every section, with its icon and item count", () => {
    const { sections } = open();
    expect(sections).toHaveLength(es.help.sections.length);
    expect(sections.some((s) => s.open)).toBe(false);
    const first = es.help.sections[0];
    expect(sections[0].querySelector(".help-icon").textContent).toBe(first.icon);
    expect(sections[0].querySelector(".help-count").textContent).toBe(String(first.items.length));
  });

  it("filters every section at once, opens the ones that match and marks the hits", () => {
    const { type, sections, visible, dialog } = open();
    type("ratchet");
    const shown = visible(".help-section");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((s) => s.open)).toBe(true);
    expect(visible(".help-item").every((i) => /ratchet/i.test(i.textContent))).toBe(true);
    expect(dialog.querySelector("mark").textContent.toLowerCase()).toBe("ratchet");
    type("");
    expect(visible(".help-section")).toHaveLength(sections.length);
    expect(sections.some((s) => s.open)).toBe(false);
    expect(dialog.querySelector("mark")).toBeNull();
  });

  it("says so when nothing matches", () => {
    const { type, visible, dialog } = open();
    type("zzzz");
    expect(visible(".help-section")).toHaveLength(0);
    expect(dialog.querySelector(".help-empty").hidden).toBe(false);
    expect(dialog.querySelector(".help-empty").textContent).toContain("zzzz");
  });

  it("opens and closes every section at once", () => {
    const { dialog, sections } = open();
    const toggle = dialog.querySelector(".help-toggle");
    expect(toggle.textContent).toBe(es.help.expandAll);
    toggle.click();
    expect(sections.every((s) => s.open)).toBe(true);
    expect(toggle.textContent).toBe(es.help.collapseAll);
    toggle.click();
    expect(sections.some((s) => s.open)).toBe(false);
  });

  it("Esc empties the search before it can close the page", () => {
    const { search, type } = open();
    type("kick");
    const esc = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    search.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(search.value).toBe("");
  });
});
