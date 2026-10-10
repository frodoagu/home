// Language picker shaped like agu.com.ar's: a pill with the languages icon and
// one button per language. Phones get a compact select instead (style.css).
import { el } from "./dom.js";

const SVG = "http://www.w3.org/2000/svg";
// lucide "languages"
const ICON = ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"];

function icon() {
  const svg = document.createElementNS(SVG, "svg");
  const attrs = {
    class: "lang-icon",
    viewBox: "0 0 24 24",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of ICON) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// `langs` is [{ id, name }]; onChange only fires for a different language.
export function langSwitch(label, langs, current, onChange) {
  const choose = (id) => {
    if (id !== current) onChange(id);
  };

  const select = el(
    "select",
    { "aria-label": label, "data-control": "lang" },
    ...langs.map(({ id, name }) => el("option", { value: id, title: name, text: id.toUpperCase() })),
  );
  select.value = current;
  select.addEventListener("change", () => choose(select.value));

  const buttons = langs.map(({ id, name }) => {
    const b = el("button", {
      type: "button",
      "data-lang": id,
      title: name,
      "aria-pressed": String(id === current),
      text: id.toUpperCase(),
    });
    b.addEventListener("click", () => choose(id));
    return b;
  });

  return el(
    "div",
    { class: "lang-switch", role: "group", "aria-label": label },
    icon(),
    select,
    el("div", { class: "lang-buttons" }, ...buttons),
  );
}
