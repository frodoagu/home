// The "🎵 Samples" panel: the signed-in user's library (samples.js). Upload,
// listen, delete, and "+ Sound in…" a layer, which makes a new sound that
// plays the sample (the app builds it). Signed out, or without the API, it
// only says why there is nothing to show. Collapsed by default.
import { LAYERS } from "../catalog.js";
import { formatBytes, nameOf } from "../samples.js";
import { el, select } from "./dom.js";

export function mountSamplesPanel({ samples, cloud, tx, lang, confirm, status, onPreview, onUse, onRemove }) {
  const t = tx.samples;
  const usage = el("span", { class: "samples-usage" });
  const body = el("div", { class: "samples-body" });
  const node = el(
    "details",
    { class: "samples panel" },
    el("summary", {}, el("span", { class: "samples-title", text: t.title }), usage),
    body,
  );

  const size = (n) => formatBytes(n, lang);
  function errorText(err) {
    const e = t.errors;
    const limits = samples.info.limits;
    if (err.code === "tooBig") return e.tooBig(size(err.detail ?? limits?.bytes ?? 0));
    if (err.code === "tooLong") return e.tooLong(err.detail);
    if (err.code === "count") return e.count(limits?.count ?? 0);
    return e[err.code] ?? e.failed;
  }

  const file = el("input", { type: "file", accept: "audio/*", hidden: "" });
  const uploadBtn = el("button", { type: "button", class: "action", "data-action": "upload-sample", text: t.upload });
  uploadBtn.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    uploadBtn.disabled = true;
    status(t.uploading(nameOf(chosen)));
    try {
      const sample = await samples.upload(chosen);
      status(t.uploaded(sample.name));
    } catch (err) {
      status(errorText(err));
    } finally {
      uploadBtn.disabled = false;
    }
  });

  const layerOptions = [
    { value: "", label: t.useIn },
    ...LAYERS.map((l) => ({ value: l.id, label: tx.layers[l.id].name })),
  ];

  function row(sample) {
    const play = el("button", { type: "button", class: "ghost icon", "data-action": "preview-sample", text: "▶" });
    play.title = t.play;
    play.setAttribute("aria-label", `${t.play}: ${sample.name}`);
    play.addEventListener("click", () => onPreview(sample.id));
    const use = select(
      t.useIn,
      layerOptions,
      "",
      (layerId) => {
        if (!layerId) return;
        picker.value = "";
        onUse(sample, layerId);
      },
      "use-sample",
    );
    const picker = use.querySelector("select");
    picker.setAttribute("aria-label", `${t.useIn} ${sample.name}`);
    use.querySelector("span").hidden = true; // the first option says it
    const del = el("button", { type: "button", class: "ghost icon danger", "data-action": "remove-sample", text: "✕" });
    del.setAttribute("aria-label", t.remove(sample.name));
    del.title = t.remove(sample.name);
    del.addEventListener("click", async () => {
      if (!confirm(t.confirmRemove(sample.name))) return;
      try {
        await samples.remove(sample.id);
        onRemove(sample.id);
        status(t.removed(sample.name));
      } catch {
        status(tx.cloud.phases.error);
      }
    });
    return el(
      "li",
      { class: "sample-row", "data-sample": sample.id },
      play,
      el("span", { class: "sample-name", text: sample.name }),
      el("span", { class: "sample-size", text: size(sample.bytes) }),
      use,
      del,
    );
  }

  function render() {
    const { available, user } = cloud?.info ?? {};
    const { ready, samples: list, used, limits } = samples.info;
    usage.textContent = user && ready && limits ? t.usage(size(used.bytes), size(limits.quota), used.count, limits.count) : "";
    if (!available) {
      body.replaceChildren(el("p", { class: "hint", text: t.unavailable }));
      return;
    }
    if (!user) {
      body.replaceChildren(el("p", { class: "hint", text: t.signIn }));
      return;
    }
    const items = list.length
      ? el("ul", { class: "sample-list" }, ...list.map(row))
      : el("p", { class: "hint", text: t.empty });
    body.replaceChildren(el("p", { class: "hint", text: t.hint }), el("div", { class: "tools-row" }, uploadBtn, file), items);
  }

  const offs = [samples.on(render), cloud?.on((event) => (event === "user" || event === "info") && render())];
  render();
  return { node, destroy: () => offs.forEach((off) => off?.()) };
}
