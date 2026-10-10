// The "how to use it" page: a top-bar button that opens a modal
// dialog with every gesture and trick, from the dictionary's `help`
// sections ([term, text] pairs). Esc, ✕ or a click on the backdrop closes it.
import { el } from "./dom.js";

export function createHelp(tx) {
  const close = el("button", { type: "button", class: "ghost icon help-close", "aria-label": tx.close, text: "✕" });
  close.title = tx.close;
  const title = el("h2", { id: "help-title", text: tx.title });
  const sections = tx.sections.map(({ title: heading, items }) =>
    el(
      "section",
      { class: "help-section" },
      el("h3", { text: heading }),
      el("dl", {}, ...items.flatMap(([term, text]) => [el("dt", { text: term }), el("dd", { text })])),
    ),
  );
  const dialog = el(
    "dialog",
    { class: "help", "aria-labelledby": "help-title" },
    el(
      "div",
      { class: "help-page" },
      el("div", { class: "help-head" }, title, close),
      el("p", { class: "help-intro", text: tx.intro }),
      ...sections,
    ),
  );
  const button = el("button", { type: "button", class: "ghost help-open", "data-action": "help", text: tx.open });
  button.title = tx.title;
  button.addEventListener("click", () => dialog.showModal());
  close.addEventListener("click", () => dialog.close());
  // The page fills the dialog, so a click on the dialog itself is the backdrop.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  return { button, dialog };
}
