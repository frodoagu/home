// The first-visit welcome: what the sampler is, that it needs headphones,
// what it is like, and the way to the how-to page. It counts as seen from the
// moment it opens, so a reload never brings it back. Start, Esc or the
// backdrop close it; the buttons stay pinned to the bottom when the page
// scrolls on a short screen.
import { t } from "../i18n/index.js";
import { introSeen, markIntroSeen } from "../storage.js";
import { el } from "./dom.js";

export function showIntro({ storage, openHelp, root = document.body }) {
  if (introSeen(storage)) return null;
  markIntroSeen(storage);
  const tx = t().intro;
  const help = el("button", { type: "button", class: "ghost intro-help", "data-action": "intro-help", text: tx.help });
  const start = el("button", { type: "button", class: "intro-start", "data-action": "intro-start", text: tx.start });
  const dialog = el(
    "dialog",
    { class: "intro", "aria-labelledby": "intro-title" },
    el(
      "div",
      { class: "intro-page" },
      el(
        "div",
        { class: "intro-main" },
        el("h2", { id: "intro-title", text: tx.title }),
        el("p", { class: "intro-what", text: tx.what }),
        el(
          "div",
          { class: "intro-phones", role: "note" },
          el("span", { class: "intro-phones-icon", "aria-hidden": "true", text: "🎧" }),
          el("strong", { text: tx.phones.title }),
          el("p", { text: tx.phones.text }),
        ),
      ),
      el(
        "ul",
        { class: "intro-points" },
        ...tx.points.map(([icon, text]) =>
          el("li", {}, el("span", { class: "intro-icon", "aria-hidden": "true", text: icon }), el("span", { text })),
        ),
      ),
      el("div", { class: "intro-actions" }, help, start),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  start.addEventListener("click", () => dialog.close());
  help.addEventListener("click", () => {
    dialog.close();
    openHelp();
  });
  // The page fills the dialog, so a click on the dialog itself is the backdrop.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  root.append(dialog);
  dialog.showModal();
  // Focus lands on Start without scrolling a tall page past its title.
  start.focus({ preventScroll: true });
  dialog.scrollTop = 0;
  return dialog;
}
