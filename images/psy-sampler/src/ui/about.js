// The foot of the page: what the sampler is and a short FAQ, in plain text
// so a search engine reads it (the dictionaries' `about`).
import { el } from "./dom.js";

export function about(tx) {
  return el(
    "section",
    { class: "about", "aria-labelledby": "about-title" },
    el("h2", { id: "about-title", text: tx.title }),
    ...tx.text.map((text) => el("p", { text })),
    el("h3", { text: tx.faqTitle }),
    el("dl", {}, ...tx.faq.flatMap(([q, a]) => [el("dt", { text: q }), el("dd", { text: a })])),
  );
}
