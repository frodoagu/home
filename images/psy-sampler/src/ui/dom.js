// Tiny DOM builders shared by the app and the editors.

let uid = 0;
export const nextId = (prefix) => `${prefix}-${++uid}`;

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function checkbox(id, label, checked) {
  const input = el("input", { type: "checkbox", id });
  input.checked = checked;
  return { input, node: el("label", { class: "check", for: id }, input, el("span", { text: label })) };
}

const LOG_STEPS = 400;

// Range input with its live readout; `spec` is a params.js slider spec. A
// `log` spec moves evenly in ratios (octaves for Hz): the input runs over
// 0..LOG_STEPS and maps onto [min, max].
export function slider(spec, value, onInput) {
  const id = nextId(spec.key);
  const span = Math.log(spec.max / spec.min);
  const toPos = (v) => (spec.log ? Math.round((Math.log(v / spec.min) / span) * LOG_STEPS) : v);
  const fromPos = (p) => (spec.log ? Math.round(spec.min * Math.exp((p / LOG_STEPS) * span)) : p);
  const input = el("input", {
    type: "range",
    id,
    min: String(spec.log ? 0 : spec.min),
    max: String(spec.log ? LOG_STEPS : spec.max),
    step: String(spec.log ? 1 : spec.step),
    value: String(toPos(value)),
    "data-param": spec.key,
  });
  const out = el("output", { for: id, text: spec.fmt(value) });
  input.addEventListener("input", () => {
    const v = fromPos(Number(input.value));
    out.textContent = spec.fmt(v);
    onInput(v);
  });
  return el("label", { class: "knob", for: id }, el("span", { text: spec.label }), input, out);
}

// <select> over [{ value, label, group? }]; groups become <optgroup>s.
export function select(label, options, value, onChange, name) {
  const id = nextId(name);
  const input = el("select", { id, "data-control": name });
  const groups = new Map();
  for (const o of options) {
    const opt = el("option", { value: String(o.value), text: o.label });
    if (o.group) {
      if (!groups.has(o.group)) {
        const g = el("optgroup", { label: o.group });
        groups.set(o.group, g);
        input.append(g);
      }
      groups.get(o.group).append(opt);
    } else input.append(opt);
  }
  input.value = String(value);
  input.addEventListener("change", () => onChange(input.value));
  return el("label", { class: "pick", for: id }, el("span", { text: label }), input);
}

// Hands the browser a file to save.
export function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Punchy corto (copia)" -> "punchy-corto-copia", for file names.
export const slug = (text) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "sound";

// A toggle that is a slider too: a drag along `axis` (once it travels a few
// px) or the arrow keys set a 0-1 amount in 5 % steps, and a drag does not
// click. `at(e, start)` maps the pointer to an amount, where `start` holds
// the position (`at`) and the `amount` the drag began from.
export function amountSlider(b, { axis = "x", get, set, at, onClick, onSlide = () => {} }) {
  const put = (v) => set(Math.round(Math.min(1, Math.max(0, v)) * 20) / 20);
  const pos = (e) => (axis === "y" ? e.clientY : e.clientX);
  let drag = null; // { at, amount, moved } while a pointer is down
  let swallow = false;
  b.addEventListener("pointerdown", (e) => {
    e.stopPropagation(); // the pointer is the slider's, not a reorder's
    drag = { at: pos(e), amount: get(), moved: false };
    b.setPointerCapture?.(e.pointerId);
  });
  b.addEventListener("pointermove", (e) => {
    if (!drag || (!drag.moved && Math.abs(pos(e) - drag.at) < 6)) return;
    if (!drag.moved) onSlide(true);
    drag.moved = true;
    const v = at(e, drag);
    if (Number.isFinite(v)) put(v);
  });
  const release = () => {
    if (drag?.moved) {
      swallow = true;
      onSlide(false);
    }
    drag = null;
  };
  b.addEventListener("pointerup", release);
  b.addEventListener("pointercancel", release);
  b.addEventListener("click", () => {
    if (swallow) swallow = false;
    else onClick();
  });
  b.addEventListener("keydown", (e) => {
    const delta = { ArrowLeft: -0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowUp: 0.05 }[e.key];
    if (delta === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    put(get() + delta);
  });
}
