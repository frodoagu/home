// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/index.js";
import { showIntro } from "./intro.js";

describe("first-visit welcome", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    setLang("es");
    // jsdom has no modal dialogs: open and close the way a browser does.
    HTMLDialogElement.prototype.showModal ??= function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  const $ = (sel) => document.querySelector(sel);

  it("shows once per browser, counted from the moment it opens", () => {
    expect(showIntro({ storage: localStorage, openHelp: () => {} })).not.toBeNull();
    expect($("dialog.intro").open).toBe(true);
    expect($("#intro-title").textContent).toBe("Esto es Psy Layers");
    document.body.replaceChildren(); // a reload without closing it
    expect(showIntro({ storage: localStorage, openHelp: () => {} })).toBeNull();
    expect($("dialog.intro")).toBeNull();
  });

  it("Empezar closes it and the instructions link opens the how-to page", () => {
    const openHelp = vi.fn();
    showIntro({ storage: localStorage, openHelp });
    $('[data-action="intro-help"]').click();
    expect(openHelp).toHaveBeenCalledOnce();
    expect($("dialog.intro")).toBeNull();
    localStorage.clear();
    showIntro({ storage: localStorage, openHelp });
    $('[data-action="intro-start"]').click();
    expect($("dialog.intro")).toBeNull();
    expect(openHelp).toHaveBeenCalledOnce();
  });

  it("never shows without storage to remember it", () => {
    expect(showIntro({ storage: null, openHelp: () => {} })).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); } };
    expect(showIntro({ storage: broken, openHelp: () => {} })).toBeNull();
  });
});
