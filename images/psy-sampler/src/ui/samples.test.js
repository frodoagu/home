// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext, FakeWorklet } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { createCloud } from "../cloud.js";
import { createSamples } from "../samples.js";
import { mountApp } from "./app.js";
import { resetAccountForTests } from "./account.js";
import { droppedEntries } from "./samplesPanel.js";
import { gzip, ramp, wav16, zip } from "../test/audioFiles.js";

let server;
let root;
let ctx;
let engine;
let samples;
let confirmAnswer;

const KICK = { id: "kickkickkickkickkick01", name: "Kick 909", type: "audio/wav", bytes: 2048, createdAt: 1 };

// psy-sync in memory: a signed-in (or not) user and their samples.
async function fakeFetch(url, { method = "GET", body } = {}) {
  const reply = (status, data) => ({
    ok: status < 400,
    status,
    headers: { get: () => (data === undefined ? "" : "application/json") },
    json: async () => data,
    arrayBuffer: async () => new ArrayBuffer(16),
  });
  const path = url.split("?")[0];
  if (path === "/api/health") return reply(200, { ok: true, clientId: "cid" });
  if (path === "/api/session") return reply(200, server.user ?? { email: null });
  if (path === "/api/state") return reply(404, {});
  if (!server.user) return reply(401, {});
  if (path === "/api/samples" && method === "GET") {
    const bytes = server.samples.reduce((n, s) => n + s.bytes, 0);
    return reply(200, { samples: server.samples.map((s) => ({ ...s })), used: { count: server.samples.length, bytes }, limits: { bytes: 3 << 20, count: 24, quota: 30 << 20 } });
  }
  if (path === "/api/samples" && method === "POST") {
    const sample = { id: `up${String(server.samples.length).padStart(20, "0")}`, name: new URLSearchParams(url.split("?")[1]).get("name"), type: "audio/wav", bytes: body.byteLength, createdAt: 2 };
    server.samples.push(sample);
    server.bodies.push(body);
    return reply(201, sample);
  }
  const id = path.split("/").pop();
  if (method === "DELETE") {
    server.samples = server.samples.filter((s) => s.id !== id);
    return reply(204);
  }
  return server.samples.some((s) => s.id === id) ? reply(200, {}) : reply(404, {});
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const WAV = wav16([ramp(480)]);
const pick = (input, files) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change"));
};
const inFolder = (path) => {
  const file = new File([WAV], path.split("/").pop());
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const saved = () => JSON.parse(localStorage.getItem("psy-sampler:v2"));
const choose = (selectEl, value) => {
  selectEl.value = value;
  selectEl.dispatchEvent(new Event("change"));
};

async function mount(opts = {}) {
  const cloud = createCloud({ fetch: fakeFetch, storage: localStorage, debounceMs: 100 });
  samples = createSamples({ fetch: fakeFetch, decode: async () => ctx.createBuffer(1, 4800, 48000) });
  engine = createEngine({ createContext: () => ctx, sampleBuffer: samples.get, createWorklet: (c, name, options) => new FakeWorklet(c, name, options) });
  root = document.createElement("div");
  document.body.replaceChildren(root);
  const loadButton = async () => ({ renderButton: () => {} });
  mountApp(root, engine, { languages: ["es"], cloud, samples, confirm: () => confirmAnswer, loadButton, ...opts });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  server = { user: { email: "ana@example.com" }, samples: [KICK], bodies: [] };
  localStorage.clear();
  history.replaceState(null, "", "/");
  resetAccountForTests();
  ctx = new FakeAudioContext();
  confirmAnswer = true;
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A microphone the test plays through the tap's worklet.
function fakeMedia(fail) {
  const track = { stop: vi.fn() };
  return {
    track,
    getUserMedia: vi.fn(async () => {
      if (fail) throw Object.assign(new Error(fail), { name: fail });
      return { getTracks: () => [track] };
    }),
  };
}
const micTap = () => ctx.nodes.findLast((n) => n.kind === "worklet" && n.name === "psy-tap");
const hear = (frames, v) => micTap().port.onmessage({ data: { frame: 0, channels: [new Float32Array(frames).fill(v), new Float32Array(frames).fill(v)] } });
const recordBtn = () => $('[data-action="record-sample"]');
async function stopRecording() {
  recordBtn().click();
  await settle();
  micTap().port.onmessage({ data: null }); // the worklet's flush
  await settle();
}

describe("recording a sample with the microphone", () => {
  it("no microphone API, no button", async () => {
    await mount({ media: undefined });
    expect($('[data-action="upload-sample"]')).not.toBeNull();
    expect(recordBtn()).toBeNull();
  });

  it("records from the first sound, then the take is heard, named and uploaded", async () => {
    const media = fakeMedia();
    await mount({ media });
    expect(recordBtn().textContent).toBe("🎙 Grabar");
    recordBtn().click();
    expect(recordBtn().textContent).toBe("🎙 Abriendo el micrófono…");
    await settle();
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(ctx.nodes.find((n) => n.kind === "mic").outputs).toContain(micTap());
    expect(recordBtn().textContent).toBe("■ Esperando sonido…");
    hear(4800, 0.001); // the room
    vi.advanceTimersByTime(100);
    expect(recordBtn().textContent).toBe("■ Esperando sonido…");
    hear(96000, 0.5);
    vi.advanceTimersByTime(100);
    expect(recordBtn().textContent).toBe("■ 0:02 / 0:15");
    expect(recordBtn().classList.contains("is-recording")).toBe(true);
    expect($(".mic-meter").hidden).toBe(false);
    expect(Number($(".mic-meter").style.getPropertyValue("--level"))).toBeCloseTo(0.9); // -6 dBFS

    await stopRecording();
    expect(media.track.stop).toHaveBeenCalled();
    expect(recordBtn().textContent).toBe("🎙 Grabar");
    expect($(".mic-meter").hidden).toBe(true);
    expect($(".sample-take").textContent).toContain("Grabación de 2 s");
    const name = $('[data-role="take-name"]');
    expect(name.value).toMatch(/^Grabación \d\d:\d\d$/);

    $('[data-action="audition-take"]').click();
    await settle();
    name.value = "Voz";
    $('[data-action="upload-take"]').click();
    await settle();
    expect(server.samples.map((s) => s.name)).toEqual(["Kick 909", "Voz"]);
    expect($(".sample-take")).toBeNull();
    expect($(".status").textContent).toBe("Sample «Voz» subido.");
  });

  it("stops by itself at the longest a sample lasts", async () => {
    await mount({ media: fakeMedia() });
    recordBtn().click();
    await settle();
    hear(48000 * 16, 0.5);
    await settle();
    micTap().port.onmessage({ data: null });
    await settle();
    expect($(".sample-take").textContent).toContain("Grabación de 15 s");
  });

  it("a take goes up with the effects it was given", async () => {
    await mount({ media: fakeMedia() });
    recordBtn().click();
    await settle();
    hear(48000, 0.5);
    await stopRecording();
    const preset = $('[data-control="take-preset"]');
    expect(preset.value).toBe("none");
    expect([...preset.options].map((o) => o.textContent)).toContain("Coro");
    const auditions = () => ctx.nodes.filter((n) => n.kind === "buffer").length;
    const before = auditions();

    choose(preset, "chorus"); // a preset plays at once
    await vi.waitFor(() => expect(auditions()).toBeGreaterThan(before));
    const knob = (key) => $(`.take-fx [data-param="${key}"]`);
    expect(knob("chorus").value).toBe("0.7");
    knob("pitch").value = "-5";
    knob("pitch").dispatchEvent(new Event("input"));
    expect(preset.value).toBe("custom");
    expect(knob("pitch").closest(".knob").querySelector("output").textContent).toBe("-5 st");

    $('[data-action="upload-take"]').click();
    await vi.waitFor(() => expect(server.samples).toHaveLength(2));
    // Stereo (the chorus), 16-bit so 15 s still fit a file.
    const header = new DataView(new Uint8Array(server.bodies[0]).buffer);
    expect(header.getUint16(22, true)).toBe(2);
    expect(header.getUint16(34, true)).toBe(16);
  });

  it("the next take starts with the last one's effects", async () => {
    await mount({ media: fakeMedia() });
    for (const take of [1, 2]) {
      recordBtn().click();
      await settle();
      hear(4800, 0.5);
      await stopRecording();
      if (take === 1) choose($('[data-control="take-preset"]'), "robot");
    }
    expect($('[data-control="take-preset"]').value).toBe("robot");
    expect($('.take-fx [data-param="robot"]').value).toBe("1");
  });

  it("🎧 plays the microphone through the chosen effect, live, before recording", async () => {
    const media = fakeMedia();
    await mount({ media });
    const live = () => $('[data-action="monitor-fx"]');
    const fxNode = () => ctx.nodes.find((n) => n.kind === "worklet" && n.name === "psy-take-fx");
    expect(live().textContent).toBe("🎧 Probar en vivo");
    choose($('[data-control="take-preset"]'), "robot");

    live().click();
    expect(live().textContent).toBe("🎙 Abriendo el micrófono…");
    await settle();
    expect(live().textContent).toBe("■ Dejar de escuchar");
    expect(live().getAttribute("aria-pressed")).toBe("true");
    expect(ctx.nodes.find((n) => n.kind === "mic").outputs).toContain(fxNode());
    expect(fxNode().port.sent.at(-1)).toMatchObject({ robot: 1 });

    // Live, an edit reaches the preview at once.
    const pitch = $('.take-fx [data-param="pitch"]');
    pitch.value = "5";
    pitch.dispatchEvent(new Event("input"));
    expect(fxNode().port.sent.at(-1)).toMatchObject({ robot: 1, pitch: 5 });
    choose($('[data-control="take-preset"]'), "cathedral");
    expect(fxNode().port.sent.at(-1)).toMatchObject({ robot: 0, pitch: 0, reverb: 0.6 });

    live().click();
    expect(live().textContent).toBe("🎧 Probar en vivo");
    expect(media.track.stop).toHaveBeenCalled();
    expect(fxNode().disconnected).toBe(true);
  });

  it("says when the live preview can't open the microphone", async () => {
    await mount({ media: fakeMedia("NotAllowedError") });
    $('[data-action="monitor-fx"]').click();
    await settle();
    expect($('[data-action="monitor-fx"]').textContent).toBe("🎧 Probar en vivo");
    expect($(".status").textContent).toBe("El navegador no dio permiso para usar el micrófono.");
  });

  it("a take nobody keeps goes away with Descartar", async () => {
    await mount({ media: fakeMedia() });
    recordBtn().click();
    await settle();
    hear(4800, 0.5);
    await stopRecording();
    $('[data-action="discard-take"]').click();
    expect($(".sample-take")).toBeNull();
    expect(server.samples).toHaveLength(1);
  });

  it("says when nothing was heard, or the microphone was refused", async () => {
    await mount({ media: fakeMedia() });
    recordBtn().click();
    await settle();
    hear(4800, 0.001);
    await stopRecording();
    expect($(".sample-take")).toBeNull();
    expect($(".status").textContent).toBe("No se oyó nada: ¿el micrófono está silenciado o muy lejos?");

    await mount({ media: fakeMedia("NotAllowedError") });
    recordBtn().click();
    await settle();
    expect($(".status").textContent).toBe("El navegador no dio permiso para usar el micrófono.");
    expect(recordBtn().textContent).toBe("🎙 Grabar");
  });
});

describe("samples panel", () => {
  it("signed out it only explains how to get samples", async () => {
    server.user = null;
    await mount();
    expect($(".samples").textContent).toContain("Iniciá sesión con Google para subir tus samples");
    expect($('[data-action="upload-sample"]')).toBeNull();
  });

  it("signed in it lists the library with its usage", async () => {
    await mount();
    expect($(".samples-usage").textContent).toBe("2 kB de 30 MB · 1 de 24 samples");
    expect($('[data-sample="kickkickkickkickkick01"] .sample-name').textContent).toBe("Kick 909");
  });

  it("uploads a file and lists it", async () => {
    await mount();
    const input = $('.samples input[type="file"]');
    const file = new File([new Uint8Array(100)], "Snare.wav", { type: "audio/wav" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await settle();
    expect(server.samples.map((s) => s.name)).toEqual(["Kick 909", "Snare"]);
    expect(root.querySelectorAll(".sample-row")).toHaveLength(2);
    expect($(".status").textContent).toBe("Sample «Snare» subido.");
  });

  it("+ Sound in… makes a new sound in that layer playing the sample", async () => {
    await mount();
    choose($('[data-sample="kickkickkickkickkick01"] [data-control="use-sample"]'), "perc");
    await settle();
    const tile = $('[data-variant="perc.clap~1"]');
    expect(tile.querySelector(".variant-label").textContent).toBe("Kick 909");
    expect(saved().variants["perc.clap~1"].sample).toMatchObject({ id: KICK.id, name: "Kick 909", pitch: 0 });
    // Its editor is open, on the sample, with the sample's sliders.
    const editor = $('[data-editor="perc.clap~1"]');
    expect(editor.querySelector('[data-control="source"]').value).toBe(KICK.id);
    expect(editor.querySelector('[data-param="pitch"]')).not.toBeNull();
    expect(editor.querySelector('[data-param="tone"]')).toBeNull();
    // A lead copy is transposed back around A3, where the sample plays as recorded.
    choose($('[data-sample="kickkickkickkickkick01"] [data-control="use-sample"]'), "lead");
    expect(saved().variants["lead.melodic~1"].transpose).toBe(-12);
  });

  it("the sound plays the decoded sample once loaded", async () => {
    await mount();
    choose($('[data-sample="kickkickkickkickkick01"] [data-control="use-sample"]'), "kick");
    await settle();
    $('[data-variant="kick.punchy~1"]').click();
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
    expect(ctx.sources().some((s) => s.buffer === samples.get(KICK.id))).toBe(true);
  });

  it("any sound's editor can switch its source to a sample and back", async () => {
    await mount();
    $('[data-edit="perc.hat"]').click();
    const source = () => $('[data-editor="perc.hat"] [data-control="source"]');
    choose(source(), KICK.id);
    expect(saved().variants["perc.hat"].sample.id).toBe(KICK.id);
    // Its start and length mark the sample in the waveform box, by the fades.
    const wave = $('[data-editor="perc.hat"] [data-fold="wave"]');
    expect([...wave.querySelectorAll("input[data-param]")].map((i) => i.dataset.param)).toEqual(["start", "length", "fadeIn", "fadeOut"]);
    choose(source(), "");
    expect(saved().variants["perc.hat"].sample).toBeNull();
    expect($('[data-editor="perc.hat"] [data-param="tone"]')).not.toBeNull();
  });

  it("deleting a sample sends the sounds using it back to their voice", async () => {
    await mount();
    choose($('[data-sample="kickkickkickkickkick01"] [data-control="use-sample"]'), "perc");
    $('[data-sample="kickkickkickkickkick01"] [data-action="remove-sample"]').click();
    await settle();
    expect(server.samples).toEqual([]);
    expect(saved().variants["perc.clap~1"].sample).toBeNull();
    expect($(".status").textContent).toBe("Sample «Kick 909» borrado.");
  });

  it("ⓘ Supported formats lists what the importer reads, signed in or not", async () => {
    await mount();
    const guide = $('[data-role="formats"]');
    expect(guide.querySelector("summary").textContent).toBe("ⓘ Formatos admitidos");
    expect([...guide.querySelectorAll("dt")].map((n) => n.textContent)).toEqual([
      "Audio",
      "Packs comprimidos",
      "Instrumentos",
      "Proyectos, con su carpeta",
      "No se pueden leer",
    ]);
    const line = (app) => [...guide.querySelectorAll(".format-list li")].find((li) => li.querySelector(".format-app")?.textContent === app);
    expect(line("Ableton Live").querySelector("code").textContent).toBe(".als .alc .adg .adv");
    expect(line("Kontakt").querySelector("code").textContent).toContain(".nki");
    expect(guide.querySelector("code").textContent).toContain(".wav");
    expect(guide.textContent).toContain("Cada sample dura hasta 15 s y pesa hasta 3 MB");

    server.user = null;
    await mount();
    expect($('[data-role="formats"]')).not.toBeNull();
    expect($('[data-role="formats"]').textContent).toContain("Cada sample dura hasta 15 s.");
  });

  it("several files open a picker; the chosen ones go up one by one", async () => {
    await mount();
    pick($('.samples input[type="file"][multiple]'), [new File([WAV], "Kick.wav"), new File([WAV], "Snare.wav"), new File([WAV], "Hat.wav")]);
    await settle();
    expect($(".status").textContent).toBe("Encontré 3 samples.");
    expect($$(".pick-row .sample-name").map((n) => n.textContent)).toEqual(["Kick", "Snare", "Hat"]);
    expect($$("[data-pick]").every((b) => b.checked)).toBe(true);
    $$("[data-pick]")[1].click(); // not the snare
    expect($('[data-action="upload-picked"]').textContent).toBe("⬆ Subir 2");
    $('[data-action="upload-picked"]').click();
    await vi.waitFor(() => expect(server.samples.map((s) => s.name)).toEqual(["Kick 909", "Kick", "Hat"]));
    await settle();
    expect($(".status").textContent).toBe("Subidos 2 de 2.");
    expect($(".sample-picker")).toBeNull();
  });

  it("an Ableton project folder: what the set uses is preselected, what's missing is said", async () => {
    await mount();
    const set = await gzip(`<?xml version="1.0"?><Ableton><SampleRef><FileRef><RelativePath Value="Samples/Imported/Amen.wav" /></FileRef></SampleRef>
      <SampleRef><FileRef><RelativePath Value="Samples/Imported/Gone.wav" /></FileRef></SampleRef></Ableton>`);
    const als = new File([set], "Song.als");
    Object.defineProperty(als, "webkitRelativePath", { value: "Song Project/Song.als" });
    pick($('.samples input[webkitdirectory]'), [als, inFolder("Song Project/Samples/Imported/Amen.wav"), inFolder("Song Project/Samples/Imported/Other.wav")]);
    await vi.waitFor(() => expect($(".sample-picker")).not.toBeNull());
    const hint = $(".sample-picker .hint").textContent;
    expect(hint).toContain("«Song Project/Song.als» (Ableton Live) usa 2 archivos: 1 está en lo que elegiste.");
    expect(hint).toContain("Falta «Gone.wav». Elegí la carpeta del proyecto entera");
    expect($$("[data-pick]").map((b) => [b.dataset.pick, b.checked])).toEqual([
      ["Song Project/Samples/Imported/Amen.wav", true],
      ["Song Project/Samples/Imported/Other.wav", false],
    ]);
    $('[data-action="cancel-pick"]').click();
    expect($(".sample-picker")).toBeNull();
  });

  it("never preselects more than the account has room for", async () => {
    server.samples = Array.from({ length: 22 }, (_, i) => ({ ...KICK, id: `k${String(i).padStart(21, "0")}` }));
    await mount();
    pick($('.samples input[type="file"][multiple]'), ["a", "b", "c"].map((n) => new File([WAV], `${n}.wav`)));
    await settle();
    expect($$("[data-pick]").map((b) => b.checked)).toEqual([true, true, false]);
    expect($(".sample-picker").textContent).toContain("Te quedan 2 lugares.");
    $('[data-action="pick-all"]').click();
    expect($('[data-action="upload-picked"]').disabled).toBe(true);
  });

  it("▶ in the picker plays a candidate before it is uploaded", async () => {
    await mount();
    pick($('.samples input[type="file"][multiple]'), [new File([WAV], "a.wav"), new File([WAV], "b.wav")]);
    await settle();
    $$('[data-action="audition"]')[1].click();
    await settle();
    expect(ctx.sources().some((src) => src.buffer)).toBe(true);
    expect(server.samples).toHaveLength(1);
  });

  it("closed formats get named, with where to export from", async () => {
    await mount();
    pick($('.samples input[type="file"][multiple]'), [new File([new Uint8Array(40)], "Break.rx2")]);
    await settle();
    expect($(".status").textContent).toBe(
      "No encontré audio en lo que elegiste (mirá ⓘ Formatos admitidos). «Break.rx2» es un formato cerrado de ReCycle (REX): exportá sus samples a WAV.",
    );
  });

  it("a dropped zip goes through the same picker", async () => {
    await mount();
    const pack = await zip([
      { name: "Pack/Kick.wav", data: WAV, deflate: true },
      { name: "Pack/Clap.wav", data: WAV },
    ]);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    event.dataTransfer = { files: [new File([pack], "Pack.zip")], items: [] };
    $(".samples").dispatchEvent(event);
    await settle();
    await vi.waitFor(() => expect($$(".pick-row .pick-origin").map((n) => n.textContent)).toEqual(["Pack.zip/Pack/Kick.wav", "Pack.zip/Pack/Clap.wav"]));
    expect($(".samples").open).toBe(true);
  });
});

describe("droppedEntries", () => {
  it("walks dropped folders, batch by batch, into paths", async () => {
    const file = (name) => ({ isFile: true, name, file: (ok) => ok(new File(["x"], name)) });
    const dir = (name, children) => ({
      isDirectory: true,
      name,
      createReader: () => {
        const batches = [children.slice(0, 1), children.slice(1), []];
        return { readEntries: (ok) => ok(batches.shift()) };
      },
    });
    const items = [dir("Kit", [file("Kick.wav"), dir("Hats", [file("Hat.wav")])]), file("Loose.wav")].map((entry) => ({ webkitGetAsEntry: () => entry }));
    const read = droppedEntries({ items, files: [] });
    expect((await read()).map((i) => i.path)).toEqual(["Kit/Kick.wav", "Kit/Hats/Hat.wav", "Loose.wav"]);
  });
});
