// The panel a snapshot's ▾ opens. It edits a DRAFT: name, section and parts
// (drop one, add one with how it sounds now, or recapture the whole mix)
// change nothing saved until Guardar; Descartar goes back to the saved
// version. The app keeps the draft while the panel is closed, so nothing is
// lost by folding it. "Probar" plays the draft on the next bar line.
import { LAYERS, layerOfVariant } from "../catalog.js";
import { SECTIONS } from "../autopilot.js";
import { addPart, partsOf, removePart, sameSnapshot } from "../snapshots.js";
import { t } from "../i18n/index.js";
import { el, select } from "./dom.js";

export function createSnapshotEditor({
  saved,
  draft = saved,
  labelOf,
  pool, // { layer id: variant ids }, loop layers only
  dataNow, // variant -> the data it plays now
  capture, // () => { active, data } of what sounds, or null when silent
  onDraft, // (draft | null): null once it matches the saved version again
  onSave,
  onTry,
  onRemove,
  onClose,
}) {
  const tx = t();
  const st = tx.snap;
  let current = structuredClone(draft);

  const name = el("input", { type: "text", class: "name-input", "data-action": "name", maxlength: "40" });
  name.addEventListener("input", () => change({ name: name.value }));
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
  const section = select(
    st.section,
    Object.keys(SECTIONS).map((value) => ({ value, label: tx.sections[value] })),
    current.section,
    (value) => change({ section: value }),
    "section",
  );
  const sectionInput = section.querySelector("select");

  const button = (action, text, title, cls = "ghost") => {
    const b = el("button", { type: "button", class: cls, "data-action": action, text });
    if (title) b.title = title;
    return b;
  };
  const saveBtn = button("save", st.save, null, "action");
  const restoreBtn = button("restore", st.restore, st.restoreTitle);
  const tryBtn = button("try", st.try, st.tryTitle);
  const recaptureBtn = button("recapture", st.recapture, st.recaptureTitle);
  const removeBtn = button("remove", st.remove);
  const closeBtn = button("close", tx.editor.close);
  saveBtn.addEventListener("click", save);
  restoreBtn.addEventListener("click", () => {
    current = structuredClone(saved);
    onDraft(null);
    render({ name: true });
  });
  tryBtn.addEventListener("click", () => onTry(current));
  recaptureBtn.addEventListener("click", () => {
    const parts = capture();
    if (parts) change(parts);
  });
  removeBtn.addEventListener("click", () => onRemove());
  closeBtn.addEventListener("click", () => onClose());

  const dirtyNote = el("span", { class: "dirty-note", text: st.unsaved });
  const parts = el("ul", { class: "snap-parts", "aria-label": st.parts });
  const emptyNote = el("p", { class: "legend", text: st.empty });

  // Adding a sound takes it as it plays now; on kick or bass it replaces the one there.
  const add = el("select", { "data-control": "add-part", "aria-label": st.add });
  add.append(el("option", { value: "", text: st.add }));
  for (const layer of LAYERS.filter((l) => !l.oneShot)) {
    const group = el("optgroup", { label: tx.layers[layer.id].name });
    for (const id of pool[layer.id]) group.append(el("option", { value: id, text: labelOf(id) }));
    add.append(group);
  }
  add.addEventListener("change", () => {
    const id = add.value;
    add.value = "";
    if (!id) return;
    current = addPart(current, id, dataNow(id));
    report();
  });

  parts.addEventListener("click", (e) => {
    const b = e.target.closest("[data-part]");
    if (!b) return;
    current = removePart(current, b.dataset.part);
    report();
  });

  function change(patch) {
    current = { ...current, ...patch };
    report();
  }

  function report() {
    onDraft(sameSnapshot(current, saved) ? null : current);
    render();
  }

  function save() {
    if (!partsOf(current).length) return;
    saved = onSave(current); // the app fills an empty name back in
    current = structuredClone(saved);
    render({ name: true });
  }

  // The name field is only rewritten from outside (load, Descartar, Guardar),
  // never while it is the one reporting: that would move the caret.
  function render({ name: withName = false } = {}) {
    if (withName) name.value = current.name;
    sectionInput.value = current.section;
    parts.replaceChildren(
      ...partsOf(current).map((id) =>
        el(
          "li",
          { "data-layer": layerOfVariant(id) },
          el("span", { class: "part-layer", text: tx.layers[layerOfVariant(id)].name }),
          el("span", { class: "part-name", text: labelOf(id) }),
          el("button", {
            type: "button",
            class: "part-remove",
            "data-part": id,
            "aria-label": st.removePart(labelOf(id)),
            text: "✕",
          }),
        ),
      ),
    );
    const dirty = !sameSnapshot(current, saved);
    const empty = !partsOf(current).length;
    emptyNote.hidden = !empty;
    dirtyNote.hidden = !dirty;
    saveBtn.disabled = !dirty || empty;
    restoreBtn.disabled = !dirty;
    tryBtn.disabled = empty;
  }

  const node = el(
    "div",
    { class: "editor snap-editor", role: "region", "aria-label": st.region(saved.name), "data-editor": saved.id },
    el(
      "div",
      { class: "editor-head" },
      el("label", { class: "name-field" }, el("span", { text: tx.editor.name }), name),
      el("div", { class: "editor-tools" }, removeBtn, closeBtn),
    ),
    el("div", { class: "pickers" }, section, el("label", { class: "pick" }, add)),
    parts,
    emptyNote,
    el("div", { class: "editor-actions" }, saveBtn, restoreBtn, dirtyNote, tryBtn, recaptureBtn),
  );
  render({ name: true });

  return {
    node,
    id: saved.id,
    focusName: () => {
      name.focus();
      name.select();
    },
    paint: () => {},
    destroy: () => {},
  };
}
