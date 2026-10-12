// The sampler is already open in another tab (tabs.js): a card that says so,
// whether that tab is playing, and that using this one cuts it. The app
// mounts only once you take over, so the card is all the page shows; there
// is nothing to dismiss it to, and closing the tab is the way out.
import { t } from "../i18n/index.js";
import { el } from "./dom.js";

export function askForTab({ playing, root = document.body }) {
  const tx = t().tab;
  const take = el("button", { type: "button", class: "tab-take", "data-action": "tab-take", text: tx.take });
  const dialog = el(
    "dialog",
    { class: "tab", open: "", "aria-labelledby": "tab-title" },
    el("h2", { id: "tab-title", text: playing ? tx.playing : tx.open }),
    el("p", { text: tx.text }),
    el("p", { text: tx.close }),
    el("div", { class: "tab-actions" }, take),
  );
  root.append(dialog);
  take.focus();
  return new Promise((resolve) => {
    take.addEventListener("click", () => {
      dialog.remove();
      resolve();
    });
  });
}
