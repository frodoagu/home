// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n/index.js";
import { showUpdate } from "./updateNotice.js";

describe("new-version notice", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setLang("es");
  });

  const $ = (sel) => document.querySelector(sel);

  it("opens without a backdrop, one at a time, and Más tarde hides it", () => {
    showUpdate({ reload: () => {} });
    showUpdate({ reload: () => {} });
    expect(document.querySelectorAll("dialog.update")).toHaveLength(1);
    expect($("dialog.update").open).toBe(true);
    expect($("#update-title").textContent).toBe("Hay una versión nueva");
    $('[data-action="update-later"]').click();
    expect($("dialog.update")).toBeNull();
  });

  it("Recargar reloads, once", () => {
    const reload = vi.fn();
    showUpdate({ reload });
    $('[data-action="update-reload"]').click();
    $('[data-action="update-reload"]').click();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
