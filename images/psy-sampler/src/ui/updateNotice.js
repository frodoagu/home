// The new-version notice: a non-modal dialog, so the loop keeps playing and
// the page stays usable until you choose. One at a time; Later hides it.
import { t } from "../i18n/index.js";
import { el } from "./dom.js";

export function showUpdate({ reload, root = document.body }) {
  root.querySelector("dialog.update")?.remove();
  const tx = t().update;
  const later = el("button", { type: "button", class: "ghost", "data-action": "update-later", text: tx.later });
  const now = el("button", { type: "button", class: "update-reload", "data-action": "update-reload", text: tx.reload });
  const dialog = el(
    "dialog",
    { class: "update", open: "", "aria-labelledby": "update-title" },
    el("h2", { id: "update-title", text: tx.title }),
    el("p", { text: tx.text }),
    el("div", { class: "update-actions" }, later, now),
  );
  later.addEventListener("click", () => dialog.remove());
  now.addEventListener("click", () => {
    now.disabled = true;
    reload();
  });
  root.append(dialog); // open, not shown modal: no backdrop, nothing blocked
  return dialog;
}
