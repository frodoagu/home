// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n/index.js";
import { askToTake } from "./elsewhere.js";

describe("in use elsewhere", () => {
  beforeEach(() => {
    document.body.replaceChildren();
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

  it("says where, and whether it plays there", () => {
    askToTake({ where: "tab", playing: true });
    expect($("#elsewhere-title").textContent).toBe("Hay otra pestaña sonando");
    document.body.replaceChildren();
    askToTake({ where: "tab", playing: false });
    expect($("#elsewhere-title").textContent).toBe("El sampler ya está abierto en otra pestaña");
    document.body.replaceChildren();
    askToTake({ where: "device", playing: true });
    expect($("#elsewhere-title").textContent).toBe("Tu cuenta está sonando en otro dispositivo");
    expect($('[data-action="take-here"]').textContent).toBe("Usarlo acá");
  });

  it("only taking over closes it", async () => {
    let taken = false;
    const asked = askToTake({ where: "device", playing: false }).then(() => (taken = true));
    const dialog = $("dialog.elsewhere");
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe($('[data-action="take-here"]'));
    const esc = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    dialog.close(); // forced shut anyway
    expect(dialog.open).toBe(true);
    await Promise.resolve();
    expect(taken).toBe(false);
    $('[data-action="take-here"]').click();
    await asked;
    expect(taken).toBe(true);
    expect($("dialog.elsewhere")).toBeNull();
  });
});
