// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/index.js";
import { askForTab } from "./tabNotice.js";

describe("another-tab notice", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setLang("es");
  });

  const $ = (sel) => document.querySelector(sel);

  it("says whether the other tab plays", () => {
    askForTab({ playing: true });
    expect($("#tab-title").textContent).toBe("Hay otra pestaña sonando");
    document.body.replaceChildren();
    askForTab({ playing: false });
    expect($("#tab-title").textContent).toBe("El sampler ya está abierto en otra pestaña");
  });

  it("Usar esta pestaña takes over and goes away", async () => {
    let taken = false;
    const asked = askForTab({ playing: true }).then(() => (taken = true));
    expect($("dialog.tab").open).toBe(true);
    expect(document.activeElement).toBe($('[data-action="tab-take"]'));
    await Promise.resolve();
    expect(taken).toBe(false);
    $('[data-action="tab-take"]').click();
    await asked;
    expect(taken).toBe(true);
    expect($("dialog.tab")).toBeNull();
  });
});
