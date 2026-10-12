// The sampler is in use somewhere else: another tab of this browser
// (tabs.js) or another device on the same account (cloud.js). A modal says
// so, whether it is playing there, and that using it here cuts that one off.
// It cannot be dismissed: there is nothing behind it to go back to, and
// closing the tab is the way to stay there.
import { t } from "../i18n/index.js";
import { el } from "./dom.js";

export function askToTake({ where, playing, root = document.body }) {
  const tx = t().elsewhere[where];
  const take = el("button", { type: "button", class: "elsewhere-take", "data-action": "take-here", text: tx.take });
  const dialog = el(
    "dialog",
    { class: "elsewhere", "aria-labelledby": "elsewhere-title" },
    el("h2", { id: "elsewhere-title", text: playing ? tx.playing : tx.open }),
    el("p", { text: tx.text }),
    el("p", { text: tx.close }),
    el("div", { class: "elsewhere-actions" }, take),
  );
  let taken = false;
  dialog.addEventListener("cancel", (e) => e.preventDefault());
  // A browser may still close it on a second Esc: it comes straight back.
  dialog.addEventListener("close", () => {
    if (!taken) dialog.showModal();
  });
  root.append(dialog);
  dialog.showModal();
  take.focus();
  return new Promise((resolve) => {
    take.addEventListener("click", () => {
      taken = true;
      dialog.close();
      dialog.remove();
      resolve();
    });
  });
}
