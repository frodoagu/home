// The models behind the autopilot's ✨ AI (planner.js says what to ask them):
//
// - "chrome": Chrome's built-in model (the Prompt API, Gemini Nano). It runs
//   on the user's machine and Chrome downloads it once for every site;
//   starting that download needs a click. Offered only where the browser
//   exposes `LanguageModel` and says the model can run. Each plan runs on a
//   clone of one base session that holds the instructions, so the context
//   never grows.
// - "lmstudio": any OpenAI-compatible chat endpoint, LM Studio's by default
//   (its server on, with CORS). The answer is held to the plan's JSON Schema
//   through `response_format`.
//
// Like the engine, both outlive the app's remounts: the session stays.
import { SYSTEM } from "./planner.js";

export const ENGINES = ["chrome", "lmstudio"];
export const LMSTUDIO_URL = "http://localhost:1234/v1";

const textIn = (languages) => ({
  expectedInputs: [{ type: "text", languages }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
});

function chromeModel(api) {
  let options = textIn(["en"]); // what availability() found the model takes
  let base = null;
  let starting = null;
  const supported = () => typeof api?.availability === "function" && typeof api?.create === "function";
  const system = [{ role: "system", content: SYSTEM }];

  // "unavailable" | "downloadable" | "downloading" | "available". The prompt
  // is English; the page's language too when the model takes it (the vibe).
  async function availability(lang = "en") {
    if (!supported()) return "unavailable";
    for (const languages of lang === "en" ? [["en"]] : [["en", lang], ["en"]]) {
      let state = "unavailable";
      try {
        state = await api.availability(textIn(languages));
      } catch {
        // not with these languages
      }
      if (state !== "unavailable") {
        options = textIn(languages);
        return state;
      }
    }
    return "unavailable";
  }

  // Inside a click when the model still has to download; `onProgress` gets 0-1.
  function start(onProgress = () => {}) {
    starting ??= api
      .create({
        ...options,
        initialPrompts: system,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) => onProgress(e.total ? e.loaded / e.total : e.loaded));
        },
      })
      .then(
        (session) => (base = session),
        (err) => {
          starting = null;
          throw err;
        },
      );
    return starting;
  }

  async function plan(prompt, schema, { signal } = {}) {
    const root = base ?? (await start());
    const session =
      typeof root.clone === "function"
        ? await root.clone({ signal })
        : await api.create({ ...options, initialPrompts: system, signal });
    try {
      return JSON.parse(await session.prompt(prompt, { responseConstraint: schema, signal }));
    } finally {
      session.destroy?.();
    }
  }

  return { supported, availability, start, plan };
}

function openAiModel(fetchFn) {
  const models = new Map(); // endpoint -> the model it serves first

  async function call(url, init) {
    const res = await fetchFn(url, init);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // The endpoint's first chat model, or null. LM Studio lists every
  // downloaded model when it loads them on demand, embeddings included.
  async function listed(endpoint, signal) {
    const list = await call(`${endpoint}/models`, { signal });
    const ids = (Array.isArray(list?.data) ? list.data : []).map((m) => m?.id);
    const id = ids.find((m) => typeof m === "string" && !/embed/i.test(m)) ?? null;
    if (id) models.set(endpoint, id);
    return id;
  }

  // The model named, else the endpoint's first.
  async function modelOf({ endpoint, model, signal }) {
    const id = model || models.get(endpoint) || (await listed(endpoint, signal));
    if (!id) throw new Error(`${endpoint}: no model`);
    return id;
  }

  return {
    supported: () => typeof fetchFn === "function",
    // Checks that the endpoint answers; resolves to the model it will ask.
    async start({ endpoint, model, signal } = {}) {
      models.delete(endpoint);
      const first = await listed(endpoint, signal);
      if (!model && !first) throw new Error(`${endpoint}: no model`);
      return model || first;
    },
    async plan(prompt, schema, { endpoint, model, signal } = {}) {
      const body = await call(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: await modelOf({ endpoint, model, signal }),
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: prompt },
          ],
          temperature: 0.8,
          max_tokens: 800,
          response_format: { type: "json_schema", json_schema: { name: "section_plan", strict: true, schema } },
        }),
      });
      return JSON.parse(body?.choices?.[0]?.message?.content ?? "");
    },
  };
}

export function createAi({ api = globalThis.LanguageModel, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  return { chrome: chromeModel(api), lmstudio: openAiModel(fetch) };
}

/* ---- per-browser settings: on, engine, endpoint, model, vibe ---- */

/** An http(s) base URL with no trailing slash ("/v1" when it has no path), or null. */
export function cleanEndpoint(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (url.pathname === "/") url.pathname = "/v1";
  return url.href.replace(/\/+$/, "");
}

const line = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function cleanPrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    on: p.on === true,
    engine: ENGINES.includes(p.engine) ? p.engine : null, // null: Chrome's where it runs
    endpoint: cleanEndpoint(p.endpoint) ?? LMSTUDIO_URL,
    model: line(p.model, 120),
    vibe: line(p.vibe, 200),
  };
}

// Its own key, out of the workspace: what a browser can run is that
// browser's, so it never travels with a preset or the cloud save.
const PREFS_KEY = "psy-sampler:ai";

export function loadPrefs(storage) {
  try {
    return cleanPrefs(JSON.parse(storage?.getItem(PREFS_KEY) ?? "null"));
  } catch {
    return cleanPrefs(null);
  }
}

export function savePrefs(storage, prefs) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Blocked: the settings last as long as the page.
  }
}
