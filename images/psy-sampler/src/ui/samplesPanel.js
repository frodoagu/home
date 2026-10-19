// The "🎵 Samples" panel: the signed-in user's library (samples.js). Upload,
// record from the microphone (audio/mic.js), listen, delete, and "+ Sound in…" a layer, which makes a new sound that
// plays the sample (the app builds it). Signed out, or without the API, it
// only says why there is nothing to show. Collapsed by default.
//
// Uploads take files, a folder (picked or dropped) or archives; what they
// hold comes from import/gather.js. A lone audio file goes straight up; more
// than one, or a project file, opens a picker to choose (and audition) which.
// A recording waits to be heard, dressed with effects (audio/takeFx.js) and
// named before it goes up the same way.
import { LAYERS } from "../catalog.js";
import { FX_DRIVES, FX_FILTERS, FX_PRESETS, FX_RANGES, isDry, presetFx, renderFxOffThread, sanitizeFx } from "../audio/takeFx.js";
import { encodeWav } from "../audio/wav.js";
import { ACCEPT, FORMATS } from "../import/formats.js";
import { decodeWav } from "../import/pcm.js";
import { MAX_SECONDS, formatBytes } from "../samples.js";
import { checkbox, el, nextId, select, slider } from "./dom.js";

const MAX_DROPPED = 20000;
const FORMAT_GROUPS = ["audio", "archives", "instruments", "projects", "closed"];

// [[app, [".ext", …]], …] in the table's order; a null app is the format itself (".zip").
function byApp(entries) {
  const out = new Map();
  for (const [ext, app] of entries) out.set(app, [...(out.get(app) ?? []), `.${ext}`]);
  return [...out];
}

// "ⓘ Supported formats": built from import/formats.js, the table the importer itself reads.
function formatsGuide(text) {
  const limits = el("p", { class: "hint" });
  const groups = FORMAT_GROUPS.flatMap((group) => {
    const [title, note] = text[group];
    const lines = byApp(FORMATS[group]).map(([app, exts]) =>
      el("li", {}, ...(app ? [el("span", { class: "format-app", text: app })] : []), el("code", { text: exts.join(" ") })),
    );
    return [el("dt", { text: title }), el("dd", {}, el("p", { class: "hint", text: note }), el("ul", { class: "format-list" }, ...lines))];
  });
  const node = el("details", { class: "sample-formats", "data-role": "formats" }, el("summary", { text: text.title }), el("dl", {}, ...groups), limits);
  return { node, limits };
}
const NAMES_SHOWN = 3;
const METER_MS = 100;
const METER_FLOOR_DB = -60;

// The take's effects, in the panel's groups: a slider spec per number
// (dom.js slider), or "filter" / "drive" / "reverse" for the other controls.
const hz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const pct = (v) => `${Math.round(v * 100)} %`;
const FX_GROUPS = {
  voice: [
    { key: "pitch", step: 1, fmt: (v) => `${v > 0 ? "+" : ""}${v} st` },
    { key: "robot", step: 0.05, fmt: pct },
    { key: "robotHz", step: 1, fmt: hz, log: true },
    { key: "whisper", step: 0.05, fmt: pct },
    { key: "ring", step: 0.05, fmt: pct },
    { key: "ringHz", step: 1, fmt: hz, log: true },
  ],
  tone: ["filter", { key: "cutoff", step: 10, fmt: hz, log: true }, { key: "res", step: 0.1, fmt: (v) => v.toFixed(1) }, "drive", { key: "amount", step: 0.05, fmt: pct }],
  space: [
    { key: "chorus", step: 0.05, fmt: pct },
    { key: "chorusDepth", step: 0.05, fmt: pct },
    { key: "echo", step: 0.05, fmt: pct },
    { key: "echoTime", step: 0.01, fmt: (v) => `${Math.round(v * 1000)} ms` },
    { key: "echoFb", step: 0.05, fmt: pct },
    { key: "reverb", step: 0.05, fmt: pct },
    { key: "reverbSize", step: 0.05, fmt: pct },
    "reverse",
  ],
};

// Rendered effects -> .wav bytes. Stereo goes 16-bit: 15 s of it at 48 kHz
// stays under the 3 MiB a file may weigh.
const asWav = (take) => new Uint8Array(encodeWav(take, take.channels.length > 1 ? 16 : 24));

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
// A peak (0-1) -> how full the meter is (0-1), in dB from METER_FLOOR_DB.
export const meterFill = (peak) => (peak > 0 ? Math.max(0, Math.min(1, 1 - (20 * Math.log10(peak)) / METER_FLOOR_DB)) : 0);

// A drop -> [{ file, path }], walking dropped folders. The entries must be taken
// while the event is dispatched; reading them can wait.
export function droppedEntries(dataTransfer) {
  const entries = [...(dataTransfer?.items ?? [])].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  const files = [...(dataTransfer?.files ?? [])];
  return async () => {
    if (!entries.length) return files.map((file) => ({ file, path: file.name }));
    const out = [];
    async function walk(entry, prefix) {
      if (out.length >= MAX_DROPPED) return;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null);
        if (file) out.push({ file, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        // readEntries hands a directory over in batches, until an empty one.
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)).catch(() => []);
          if (!batch.length) break;
          for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        }
      }
    }
    for (const entry of entries) await walk(entry, "");
    return out;
  };
}

export function mountSamplesPanel({ samples, cloud, mic = null, tx, lang, confirm, status, onPreview, onAudition, onUse, onRemove }) {
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
  const guide = formatsGuide(t.formats);
  function errorText(err) {
    const e = t.errors;
    const limits = samples.info.limits;
    if (err.code === "tooBig") return e.tooBig(size(err.detail ?? limits?.bytes ?? 0));
    if (err.code === "tooLong") return e.tooLong(err.detail);
    if (err.code === "count") return e.count(limits?.count ?? 0);
    return e[err.code] ?? e.failed;
  }

  const slotsLeft = () => {
    const { limits, used } = samples.info;
    return limits ? Math.max(0, limits.count - used.count) : Infinity;
  };

  let busy = false;
  let picking = null; // the open picker: { node, sync }

  const files = el("input", { type: "file", accept: ACCEPT, multiple: "", hidden: "" });
  const folder = el("input", { type: "file", webkitdirectory: "", hidden: "" });
  const uploadBtn = el("button", { type: "button", class: "action", "data-action": "upload-sample", text: t.upload });
  const folderBtn = el("button", { type: "button", class: "ghost", "data-action": "upload-folder", text: t.folder });
  uploadBtn.addEventListener("click", () => files.click());
  folderBtn.addEventListener("click", () => folder.click());
  for (const input of [files, folder]) {
    input.addEventListener("change", () => {
      const chosen = [...(input.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      input.value = "";
      importFrom(chosen);
    });
  }

  /* ---- 🎙: a take from the microphone, heard and named before it goes up ---- */
  const m = t.mic;
  const recordBtn = el("button", { type: "button", class: "rec rec-sample", "data-action": "record-sample" });
  const meter = el("span", { class: "mic-meter", role: "meter", "aria-label": m.level, "aria-valuemin": "0", "aria-valuemax": "1" }, el("span"));
  let ticking = null;
  let taken = null; // the take waiting to go up: { node }
  let lastFx = { preset: "none", fx: presetFx("none") }; // the next take starts with the last one's effects

  function showMic() {
    const now = mic?.state() ?? "idle";
    recordBtn.textContent = now === "recording" ? m.recording(clock(mic.seconds()), clock(mic.maxSeconds)) : now === "waiting" ? m.waiting : now === "opening" ? m.opening : m.record;
    recordBtn.title = now === "idle" ? m.recordTitle(MAX_SECONDS) : m.stopTitle;
    recordBtn.classList.toggle("is-waiting", now === "waiting" || now === "opening");
    recordBtn.classList.toggle("is-recording", now === "recording");
    recordBtn.disabled = busy && now === "idle";
    meter.hidden = now === "idle";
    const fill = meterFill(mic?.level() ?? 0);
    meter.style.setProperty("--level", fill.toFixed(3));
    meter.setAttribute("aria-valuenow", fill.toFixed(2));
  }

  const stopTicking = () => {
    clearInterval(ticking);
    ticking = null;
  };

  function micError(err) {
    if (err?.name === "NotAllowedError" || err?.name === "SecurityError") return m.denied;
    if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") return m.missing;
    return m.failed;
  }

  function startMic() {
    dropTake();
    const opening = mic.start(); // inside the click: it may create the AudioContext
    stopTicking();
    ticking = setInterval(showMic, METER_MS);
    showMic();
    opening.then(showMic, (err) => {
      stopTicking();
      showMic();
      status(micError(err));
    });
  }

  async function stopMic() {
    const was = mic.state();
    stopTicking();
    recordBtn.disabled = true;
    const take = await mic.stop();
    showMic();
    if (take) openTake(take);
    else if (was !== "opening") status(m.silent);
  }

  recordBtn.addEventListener("click", () => (mic.state() === "idle" ? startMic() : stopMic()));
  mic?.onFull(() => stopMic());

  function dropTake() {
    if (!taken) return;
    taken = null;
    samples.endAuditions();
    render();
  }

  function openTake({ blob, seconds }) {
    const time = new Date().toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    const fallback = m.name(time);
    const name = el("input", { type: "text", class: "name-input take-name", maxlength: "60", "aria-label": m.nameLabel, "data-role": "take-name" });
    name.value = fallback;

    let { preset, fx } = lastFx;
    const raw = blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    let rendered = null; // { key, bytes }: the last render, for ▶ and ⬆ alike
    // The take's bytes with the effects as they are now; dry, as recorded.
    async function bytes() {
      if (isDry(fx)) return raw;
      const key = JSON.stringify(fx);
      if (rendered?.key !== key) {
        const wanted = { key, bytes: raw.then((b) => renderFxOffThread(decodeWav(b), fx)).then(asWav) };
        rendered = wanted;
        wanted.bytes.catch(() => rendered === wanted && (rendered = null));
      }
      return rendered.bytes;
    }
    const candidate = () => ({ key: "mic", name: name.value.trim() || fallback, load: async () => ({ bytes: await bytes() }) });

    const play = el("button", { type: "button", class: "ghost icon", "data-action": "audition-take", text: "▶" });
    play.title = t.play;
    play.setAttribute("aria-label", t.play);
    function audition() {
      const c = candidate();
      play.classList.add("is-busy");
      onAudition?.(c)
        .catch((err) => status(t.failedOne(c.name, errorText(err))))
        .finally(() => play.classList.remove("is-busy"));
    }
    play.addEventListener("click", audition);

    const f = m.fx;
    const controls = new Map(); // key -> (value) => void, to show a preset
    const edit = (key, v) => {
      fx = sanitizeFx({ ...fx, [key]: v });
      preset = "custom";
      presets.querySelector("select").value = preset;
      lastFx = { preset, fx };
    };
    const control = (item) => {
      if (item === "filter" || item === "drive") {
        const list = item === "filter" ? FX_FILTERS : FX_DRIVES;
        const types = item === "filter" ? tx.editor.filterTypes : tx.editor.driveTypes;
        const node = select(tx.editor[item], list.map((v) => ({ value: v, label: types[v] })), fx[item], (v) => {
          edit(item, v);
          audition();
        }, `take-${item}`);
        controls.set(item, (v) => (node.querySelector("select").value = v));
        return node;
      }
      if (item === "reverse") {
        const box = checkbox(nextId("take-reverse"), f.params.reverse, fx.reverse);
        box.input.dataset.param = "reverse";
        box.input.addEventListener("change", () => {
          edit("reverse", box.input.checked);
          audition();
        });
        controls.set(item, (v) => (box.input.checked = v));
        return box.node;
      }
      const [min, max] = FX_RANGES[item.key];
      const node = slider({ ...item, label: f.params[item.key], min, max }, fx[item.key], (v) => edit(item.key, v));
      node.querySelector("input").addEventListener("change", audition);
      controls.set(item.key, (v) => node.setValue(v));
      return node;
    };
    const groups = Object.entries(FX_GROUPS).map(([group, items]) =>
      el("fieldset", { class: "take-fx-group" }, el("legend", { text: f.groups[group] }), el("div", { class: "knobs" }, ...items.map(control))),
    );

    const presetOptions = [...Object.keys(FX_PRESETS), "custom"].map((value) => ({ value, label: f.presets[value] }));
    const presets = select(f.preset, presetOptions, preset, (value) => {
      if (value === "custom") return;
      preset = value;
      fx = presetFx(value);
      lastFx = { preset, fx };
      for (const [key, show] of controls) show(fx[key]);
      audition();
    }, "take-preset");
    presets.querySelector("option[value=custom]").disabled = true;

    const go = el("button", { type: "button", class: "action", "data-action": "upload-take", text: m.upload });
    const discard = el("button", { type: "button", class: "ghost", "data-action": "discard-take", text: m.discard });
    discard.addEventListener("click", dropTake);
    go.addEventListener("click", async () => {
      setBusy(true);
      try {
        if (await uploadAll([candidate()])) dropTake();
      } finally {
        setBusy(false);
      }
    });
    const secs = seconds.toLocaleString(lang, { maximumFractionDigits: 1 });
    taken = {
      node: el(
        "div",
        { class: "sample-take", role: "group", "aria-label": m.record },
        el("p", { class: "hint", text: m.take(secs) }),
        el("div", { class: "tools-row" }, play, presets, name, go, discard),
        el("details", { class: "take-fx", "data-role": "take-fx" }, el("summary", { text: f.adjust }), el("p", { class: "hint", text: f.hint }), ...groups),
      ),
    };
    status(m.take(secs));
    render();
    name.select();
  }

  const setBusy = (on) => {
    busy = on;
    uploadBtn.disabled = on;
    folderBtn.disabled = on;
    for (const box of [picking, taken]) box?.node.querySelectorAll("button, input, select").forEach((b) => (b.disabled = on));
    if (!on) picking?.sync();
    showMic();
  };

  // What the selection held besides candidates: projects, missing files, closed formats, failures.
  function notes(found) {
    const out = found.projects.map((p) => t.project(p.name, p.app, p.found, p.refs));
    const { missing } = found;
    if (missing.length) out.push(t.missing(missing.slice(0, NAMES_SHOWN), Math.max(0, missing.length - NAMES_SHOWN)));
    for (const c of found.closed) out.push(t.closed(c.name, c.app));
    for (const u of found.unreadable) {
      out.push(u.why === "encrypted" ? t.encrypted(u.name) : u.why === "tooBig" ? t.failedOne(u.name, errorText({ code: "tooBig" })) : t.unreadable(u.name));
    }
    if (found.more) out.push(t.more(found.more));
    return out;
  }

  async function importFrom(inputs) {
    if (!inputs.length || busy) return;
    closePicker();
    setBusy(true);
    status(t.reading);
    try {
      const found = await samples.gather(inputs);
      const extra = notes(found);
      if (!found.candidates.length) {
        status([t.nothing, ...extra].join(" "));
        return;
      }
      if (found.candidates.length === 1 && !found.projects.length) {
        await uploadAll(found.candidates, extra);
        return;
      }
      openPicker(found, extra);
    } catch {
      status(t.errors.failed);
    } finally {
      setBusy(false);
    }
  }

  // One by one, saying how it goes; a full account stops the rest.
  async function uploadAll(candidates, extra = []) {
    const failed = [];
    let ok = 0;
    for (const [i, candidate] of candidates.entries()) {
      status(candidates.length === 1 ? t.uploading(candidate.name) : t.progress(i + 1, candidates.length, candidate.name));
      try {
        const sample = await samples.upload(candidate);
        ok++;
        if (candidates.length === 1) status([t.uploaded(sample.name), ...extra].join(" "));
      } catch (err) {
        failed.push(t.failedOne(candidate.name, errorText(err)));
        if (["quota", "count", "full"].includes(err.code)) break;
      }
    }
    if (candidates.length === 1 && !ok) status([failed[0] ?? t.errors.failed, ...extra].join(" "));
    else if (candidates.length > 1) status([t.done(ok, candidates.length), ...failed.slice(0, NAMES_SHOWN), ...extra].join(" "));
    return ok;
  }

  function closePicker() {
    if (!picking) return;
    picking = null;
    samples.endAuditions();
    render();
  }

  function openPicker(found, extra) {
    const { candidates } = found;
    // What the projects use, if they found any of it; otherwise everything. As many as fit.
    const wanted = found.projects.length && candidates.some((c) => c.used) ? candidates.filter((c) => c.used) : candidates;
    const preselected = new Set(wanted.slice(0, slotsLeft()));

    const go = el("button", { type: "button", class: "action", "data-action": "upload-picked" });
    const cancel = el("button", { type: "button", class: "ghost", "data-action": "cancel-pick", text: t.cancel });
    const slots = el("span", { class: "hint" });
    const allId = nextId("pick-all");
    const all = el("input", { type: "checkbox", id: allId, "data-action": "pick-all" });
    const boxes = [];

    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      go.textContent = t.uploadN(n);
      go.disabled = busy || n === 0 || n > slotsLeft();
      all.checked = n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
      slots.textContent = Number.isFinite(slotsLeft()) ? t.slots(slotsLeft()) : "";
    };

    const rows = candidates.map((candidate) => {
      const id = nextId("pick");
      const box = el("input", { type: "checkbox", id, "data-pick": candidate.key });
      box.checked = preselected.has(candidate);
      box.addEventListener("change", sync);
      boxes.push(box);
      const play = el("button", { type: "button", class: "ghost icon", "data-action": "audition", text: "▶" });
      play.title = t.play;
      play.setAttribute("aria-label", `${t.play}: ${candidate.name}`);
      play.addEventListener("click", () => {
        onAudition?.(candidate).catch((err) => status(t.failedOne(candidate.name, errorText(err))));
      });
      const origin = candidate.region ? `${candidate.origin} · ${t.slice}` : candidate.origin;
      return el(
        "li",
        { class: "pick-row" },
        box,
        el("label", { for: id, class: "pick-label" }, el("span", { class: "sample-name", text: candidate.name }), el("span", { class: "pick-origin", text: origin })),
        play,
      );
    });

    all.addEventListener("change", () => {
      boxes.forEach((b) => (b.checked = all.checked));
      sync();
    });
    cancel.addEventListener("click", closePicker);
    go.addEventListener("click", async () => {
      const chosen = candidates.filter((_, i) => boxes[i].checked);
      setBusy(true);
      try {
        await uploadAll(chosen, extra);
      } finally {
        setBusy(false);
        closePicker();
      }
    });

    picking = {
      node: el(
        "div",
        { class: "sample-picker", role: "group", "aria-label": t.pick },
        el("p", { class: "hint", text: [t.found(candidates.length), ...extra].join(" ") }),
        el("p", { class: "hint", text: t.pick }),
        el("div", { class: "pick-head" }, all, el("label", { for: allId, text: t.all }), slots),
        el("ul", { class: "pick-list" }, ...rows),
        el("div", { class: "tools-row" }, go, cancel),
      ),
      sync,
    };
    sync();
    status(t.found(candidates.length));
    render();
  }

  // Dropping files or folders anywhere on the panel.
  const canImport = () => Boolean(cloud?.info.available && cloud.info.user && samples.info.ready);
  node.addEventListener("dragover", (e) => {
    if (!canImport()) return;
    e.preventDefault();
    node.classList.add("dropping");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("dropping");
  });
  node.addEventListener("drop", async (e) => {
    node.classList.remove("dropping");
    if (!canImport()) return;
    e.preventDefault();
    node.open = true;
    const read = droppedEntries(e.dataTransfer);
    importFrom(await read());
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
    guide.limits.textContent = t.formats.limits(MAX_SECONDS, user && limits ? size(limits.bytes) : null);
    if (!available) {
      picking = null;
      taken = null;
      body.replaceChildren(el("p", { class: "hint", text: t.unavailable }));
      return;
    }
    if (!user) {
      picking = null;
      taken = null;
      body.replaceChildren(el("p", { class: "hint", text: t.signIn }), guide.node);
      return;
    }
    const items = list.length
      ? el("ul", { class: "sample-list" }, ...list.map(row))
      : el("p", { class: "hint", text: t.empty });
    body.replaceChildren(
      el("p", { class: "hint", text: `${t.hint} ${t.how}` }),
      el("div", { class: "tools-row" }, uploadBtn, folderBtn, ...(mic ? [recordBtn, meter] : []), files, folder),
      guide.node,
      ...(taken ? [taken.node] : []),
      ...(picking ? [picking.node] : []),
      items,
    );
  }

  const offs = [samples.on(render), cloud?.on((event) => (event === "user" || event === "info") && render())];
  showMic();
  render();
  return {
    node,
    destroy: () => {
      offs.forEach((off) => off?.());
      stopTicking();
      mic?.onFull(null);
      if (mic && mic.state() !== "idle") mic.stop();
    },
  };
}
