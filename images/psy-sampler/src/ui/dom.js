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

// Range input with its live readout; `spec` is a params.js slider spec.
export function slider(spec, value, onInput) {
  const id = nextId(spec.key);
  const input = el("input", {
    type: "range",
    id,
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    value: String(value),
    "data-param": spec.key,
  });
  const out = el("output", { for: id, text: spec.fmt(value) });
  input.addEventListener("input", () => {
    const v = Number(input.value);
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
