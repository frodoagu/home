// The sampler's way into the show: 🌀 lays it over this tab, fullscreen,
// straight off the engine; from there ⧉ moves it to its own window
// (visuals.html) to drag onto a TV or a projector.
import { el } from "../ui/dom.js";
import { browserStorage } from "../storage.js";
import { mountShow } from "./show.js";
import { engineSource } from "./sources.js";

export const WINDOW = "psy-visuals";

export function openWindow() {
  return window.open("/visuals.html", WINDOW, "popup,width=1280,height=720");
}

export function visualsButton(engine, tx) {
  const button = el("button", { type: "button", class: "ghost", "data-action": "visuals", text: tx.button, title: tx.buttonTitle });
  button.addEventListener("click", () => {
    const show = mountShow({
      root: document.body,
      source: engineSource(engine),
      tx,
      storage: browserStorage(),
      popOut: () => {
        show.close();
        openWindow();
      },
      onClose: () => button.focus(),
    });
    show.fullscreen();
  });
  return button;
}
