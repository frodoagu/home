// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { createCloud } from "../cloud.js";
import { createSamples } from "../samples.js";
import { mountApp } from "./app.js";
import { resetAccountForTests } from "./account.js";

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
const settle = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const saved = () => JSON.parse(localStorage.getItem("psy-sampler:v2"));
const choose = (selectEl, value) => {
  selectEl.value = value;
  selectEl.dispatchEvent(new Event("change"));
};

async function mount() {
  const cloud = createCloud({ fetch: fakeFetch, storage: localStorage, debounceMs: 100 });
  samples = createSamples({ fetch: fakeFetch, decode: async () => ctx.createBuffer(1, 4800, 48000) });
  engine = createEngine({ createContext: () => ctx, sampleBuffer: samples.get });
  root = document.createElement("div");
  document.body.replaceChildren(root);
  const loadButton = async () => ({ renderButton: () => {} });
  mountApp(root, engine, { languages: ["es"], cloud, samples, confirm: () => confirmAnswer, loadButton });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  server = { user: { email: "ana@example.com" }, samples: [KICK] };
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
    expect($('[data-editor="perc.hat"] [data-param="start"]')).not.toBeNull();
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
});
