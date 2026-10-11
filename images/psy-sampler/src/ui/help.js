// The "how to use it" page: a top-bar button that opens a modal
// dialog with every gesture and trick, from the dictionary's `help`
// sections ({icon, title, items: [term, text] pairs}). The sections start
// folded, so the page opens as their index; the search box filters every section at once and marks
// the matches. Esc, ✕ or a click on the backdrop closes it.
import { el } from "./dom.js";

// Keys and arrows read as keycaps wherever they appear.
const KEYS = /\b(?:Ctrl|Shift|Alt|Enter|Esc)\b|⌘|←|→/g;

// Lowercase, accents off, one entry per UTF-16 unit of `s` so a match in the
// folded text maps straight back onto the original.
export function fold(s) {
  let text = "";
  const at = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (const c of f) {
      text += c;
      at.push(i);
    }
  }
  return { text, at };
}

// [start, end) ranges of every occurrence of `query` in `s`, ignoring case
// and accents.
export function matches(s, query) {
  const q = fold(query.trim()).text;
  if (!q) return [];
  const { text, at } = fold(s);
  const out = [];
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
    out.push([at[i], at[i + q.length - 1] + 1]);
  }
  return out;
}

// `s` as nodes: keycaps in <kbd>, the search hits in <mark>.
export function rich(s, query = "") {
  const key = new Uint8Array(s.length);
  const hit = new Uint8Array(s.length);
  for (const m of s.matchAll(KEYS)) key.fill(1, m.index, m.index + m[0].length);
  for (const [a, b] of matches(s, query)) hit.fill(1, a, b);
  const nodes = [];
  for (let i = 0; i < s.length; ) {
    let j = i + 1;
    while (j < s.length && key[j] === key[i] && hit[j] === hit[i]) j++;
    let node = s.slice(i, j);
    if (hit[i]) node = el("mark", {}, node);
    if (key[i]) node = el("kbd", {}, node);
    nodes.push(node);
    i = j;
  }
  return nodes;
}

export function createHelp(tx) {
  const close = el("button", { type: "button", class: "ghost icon help-close", "aria-label": tx.close, text: "✕" });
  close.title = tx.close;
  const title = el("h2", { id: "help-title", text: tx.title });
  const search = el("input", {
    type: "search",
    class: "help-search",
    placeholder: tx.search,
    "aria-label": tx.search,
    autocomplete: "off",
    spellcheck: "false",
  });
  const toggleAll = el("button", { type: "button", class: "ghost help-toggle" });
  const empty = el("p", { class: "help-empty", hidden: "" });

  const sections = tx.sections.map(({ icon, title: heading, items }) => {
    const rows = items.map(([term, text]) => {
      const dt = el("dt");
      const dd = el("dd");
      return { term, text, dt, dd, node: el("div", { class: "help-item" }, dt, dd) };
    });
    const count = el("span", { class: "help-count" });
    const node = el(
      "details",
      { class: "help-section" },
      el(
        "summary",
        {},
        el("span", { class: "help-icon", "aria-hidden": "true", text: icon }),
        el("h3", { text: heading }),
        count,
      ),
      el("dl", {}, ...rows.map((r) => r.node)),
    );
    return { node, rows, count, total: items.length, wasOpen: false };
  });

  const allOpen = () => sections.every((s) => s.node.hidden || s.node.open);
  const syncToggle = () => {
    toggleAll.textContent = allOpen() ? tx.collapseAll : tx.expandAll;
  };

  let query = "";
  function render() {
    let shown = 0;
    for (const s of sections) {
      let hits = 0;
      for (const r of s.rows) {
        const hit = !query || matches(r.term, query).length > 0 || matches(r.text, query).length > 0;
        r.node.hidden = !hit;
        r.dt.replaceChildren(...rich(r.term, hit ? query : ""));
        r.dd.replaceChildren(...rich(r.text, hit ? query : ""));
        if (hit) hits++;
      }
      s.node.hidden = hits === 0;
      s.count.textContent = query ? `${hits}/${s.total}` : String(s.total);
      if (query) s.node.open = hits > 0;
      shown += hits;
    }
    empty.hidden = shown > 0;
    empty.textContent = shown ? "" : tx.noMatch(query.trim());
    syncToggle();
  }

  search.addEventListener("input", () => {
    const was = query;
    query = search.value.trim();
    // Leaving a search puts every section back as the reader had it.
    if (was && !query) for (const s of sections) s.node.open = s.wasOpen;
    render();
  });
  // Esc first empties the search; only an empty box lets it close the page.
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
  });
  for (const s of sections) {
    s.node.addEventListener("toggle", () => {
      if (!query) s.wasOpen = s.node.open;
      syncToggle();
    });
  }
  toggleAll.addEventListener("click", () => {
    const open = !allOpen();
    for (const s of sections) {
      s.node.open = open;
      if (!query) s.wasOpen = open;
    }
    syncToggle();
  });
  render();

  const dialog = el(
    "dialog",
    { class: "help", "aria-labelledby": "help-title" },
    el(
      "div",
      { class: "help-page" },
      el(
        "div",
        { class: "help-head" },
        el("div", { class: "help-title" }, title, close),
        el("div", { class: "help-tools" }, search, toggleAll),
      ),
      el("p", { class: "help-intro", text: tx.intro }),
      ...sections.map((s) => s.node),
      empty,
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
