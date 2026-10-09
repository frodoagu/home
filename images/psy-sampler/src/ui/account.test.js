// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { createCloud } from "../cloud.js";
import { mountApp } from "./app.js";
import { resetAccountForTests } from "./account.js";

let server;
let root;
let engine;
let credentialCallback;
let confirmAnswer;

// An in-memory psy-sync behind fetch.
async function fakeFetch(url, { method = "GET", body } = {}) {
  const reply = (status, data) => ({
    status,
    headers: { get: () => (data === undefined ? "" : "application/json") },
    json: async () => data,
  });
  if (!server.up) return reply(200); // nginx's SPA fallback: HTML, not the API
  if (url === "/api/health") return reply(200, { ok: true, clientId: "cid" });
  if (url === "/api/session" && method === "GET") return reply(200, server.user ?? { email: null });
  if (url === "/api/session" && method === "POST") {
    server.user = { email: "ana@example.com" };
    return reply(200, server.user);
  }
  if (url === "/api/session" && method === "DELETE") {
    server.user = null;
    return reply(204);
  }
  if (url === "/api/account") {
    server.user = null;
    server.state = null;
    return reply(204);
  }
  if (url === "/api/state" && method === "GET") return server.state ? reply(200, server.state) : reply(404, {});
  if (url === "/api/state" && method === "PUT") {
    const { state, base, force } = JSON.parse(body);
    server.puts.push(state);
    if (server.state && !force && server.state.updatedAt !== base) return reply(409, server.state);
    server.state = { state, updatedAt: (server.state?.updatedAt ?? 0) + 1 };
    return reply(200, { updatedAt: server.state.updatedAt });
  }
  return reply(404, {});
}

const loadButton = vi.fn(async (clientId, onCredential) => {
  credentialCallback = onCredential;
  return { renderButton: (slot) => slot.append(Object.assign(document.createElement("button"), { className: "gsi" })) };
});

const $ = (sel) => root.querySelector(sel);
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function mount() {
  const cloud = createCloud({ fetch: fakeFetch, storage: localStorage, debounceMs: 100 });
  root = document.createElement("div");
  document.body.replaceChildren(root);
  mountApp(root, engine, { languages: ["es"], cloud, confirm: () => confirmAnswer, loadButton });
  await settle();
  return cloud;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  server = { up: true, user: null, state: null, puts: [] };
  localStorage.clear();
  history.replaceState(null, "", "/");
  resetAccountForTests();
  engine = createEngine({ createContext: () => new FakeAudioContext() });
  confirmAnswer = true;
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cloud save row", () => {
  it("stays hidden when the API is not there", async () => {
    server.up = false;
    await mount();
    expect($(".account").hidden).toBe(true);
  });

  it("offers Google sign-in when signed out", async () => {
    await mount();
    expect($(".account").hidden).toBe(false);
    expect($(".account-pitch").textContent).toMatch(/nube/);
    expect(loadButton).toHaveBeenCalledWith("cid", expect.any(Function));
    expect($(".gsi-slot .gsi")).not.toBeNull();
  });

  it("signing in on a fresh browser pulls the saved setup", async () => {
    server.state = { state: { bpm: 166, names: { "perc.hat": "Mi hat" } }, updatedAt: 4 };
    await mount();
    await credentialCallback("google-token");
    await settle();
    expect($("#bpm").value).toBe("166");
    expect($('[data-variant="perc.hat"] .variant-label').textContent).toBe("Mi hat");
    expect($(".account-email").textContent).toBe("☁ ana@example.com");
    expect($(".status").textContent).toMatch(/Cargué/);
  });

  it("signing in with nothing saved yet uploads this browser's setup", async () => {
    await mount();
    await credentialCallback("google-token");
    await settle();
    expect(server.state.state.bpm).toBe(145);
    expect(server.state.state.lang).toBe("es");
  });

  it("every change is uploaded after a quiet moment", async () => {
    server.user = { email: "ana@example.com" };
    server.state = { state: { bpm: 145 }, updatedAt: 1 };
    await mount();
    const bpm = $("#bpm");
    bpm.value = "150";
    bpm.dispatchEvent(new Event("input"));
    bpm.value = "152";
    bpm.dispatchEvent(new Event("input"));
    expect($(".account-phase").textContent).toMatch(/sin subir/);
    await vi.advanceTimersByTimeAsync(150);
    expect(server.state.state.bpm).toBe(152);
    expect($(".account-phase").textContent).toMatch(/guardado/);
  });

  it("a newer copy from another device, with changes here too, asks; Cancel keeps and uploads local", async () => {
    server.user = { email: "ana@example.com" };
    server.state = { state: { bpm: 133 }, updatedAt: 7 };
    localStorage.setItem("psy-sampler:v2", JSON.stringify({ bpm: 171 }));
    confirmAnswer = false;
    await mount();
    expect($("#bpm").value).toBe("171");
    expect(server.state.state.bpm).toBe(171);
  });

  it("…and OK takes the cloud copy", async () => {
    server.user = { email: "ana@example.com" };
    server.state = { state: { bpm: 133 }, updatedAt: 7 };
    localStorage.setItem("psy-sampler:v2", JSON.stringify({ bpm: 171 }));
    await mount();
    expect($("#bpm").value).toBe("133");
  });

  it("Borrar mis datos deletes the account after confirming", async () => {
    server.user = { email: "ana@example.com" };
    server.state = { state: { bpm: 145 }, updatedAt: 1 };
    await mount();
    $('[data-action="delete-account"]').click();
    await settle();
    expect(server.state).toBeNull();
    expect($(".account-pitch")).not.toBeNull();
    expect($(".status").textContent).toMatch(/se borraron/);
  });

  it("Salir signs out and keeps the local setup", async () => {
    server.user = { email: "ana@example.com" };
    server.state = { state: { bpm: 145 }, updatedAt: 1 };
    await mount();
    $('[data-action="sign-out"]').click();
    await settle();
    expect(server.user).toBeNull();
    expect($(".account-pitch")).not.toBeNull();
    expect($("#bpm").value).toBe("145");
  });
});
