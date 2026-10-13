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
// - "openai", "anthropic", "gemini": the listener's own account, linked with
//   an API key they paste. The page calls the provider directly (all three
//   answer browsers, with CORS), so the key goes to that provider and nowhere
//   else; usage is billed to their account. Each holds the answer to the
//   schema its own way: `response_format`, a forced tool, `responseJsonSchema`.
//
// Like the engine, they outlive the app's remounts: the session stays.
import { LEVELS, LEVEL_DEFAULT, SYSTEM } from "./planner.js";

export const LMSTUDIO_URL = "http://localhost:1234/v1";

// Where to get a key, and which models Automatic prefers (fast and cheap).
export const CLOUDS = {
  openai: { keys: "https://platform.openai.com/api-keys", fast: /mini/ },
  anthropic: { keys: "https://console.anthropic.com/settings/keys", fast: /haiku/ },
  gemini: { keys: "https://aistudio.google.com/apikey", fast: /flash/ },
};
export const CLOUD_IDS = Object.keys(CLOUDS);
export const ENGINES = ["chrome", "lmstudio", ...CLOUD_IDS];
export const isCloud = (engine) => CLOUD_IDS.includes(engine);

const textIn = (languages) => ({
  expectedInputs: [{ type: "text", languages }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
});

function chromeModel(api) {
  let options = textIn(["en"]); // what availability() found the model takes
  const bases = new Map(); // instructions -> the base session that holds them, once made
  const starting = new Map(); // instructions -> that session on its way
  const supported = () => typeof api?.availability === "function" && typeof api?.create === "function";
  const initial = (system) => [{ role: "system", content: system }];

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
  // One base session per set of instructions (a level's, planner.js systemOf).
  function start(onProgress = () => {}, system = SYSTEM) {
    if (!starting.has(system)) {
      const made = api
        .create({
          ...options,
          initialPrompts: initial(system),
          monitor(m) {
            m.addEventListener("downloadprogress", (e) => onProgress(e.total ? e.loaded / e.total : e.loaded));
          },
        })
        .then(
          (session) => {
            bases.set(system, session);
            return session;
          },
          (err) => {
            starting.delete(system);
            throw err;
          },
        );
      starting.set(system, made);
    }
    return starting.get(system);
  }

  async function plan(prompt, schema, { signal, system = SYSTEM } = {}) {
    const root = bases.get(system) ?? (await start(undefined, system));
    const session =
      typeof root.clone === "function"
        ? await root.clone({ signal })
        : await api.create({ ...options, initialPrompts: initial(system), signal });
    try {
      return JSON.parse(await session.prompt(prompt, { responseConstraint: schema, signal }));
    } finally {
      session.destroy?.();
    }
  }

  return { supported, availability, start, plan };
}

// The error carries the status: a rejected key reads differently from a
// provider that is down.
async function fetchJson(fetchFn, url, init) {
  const res = await fetchFn(url, init);
  if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { status: res.status });
  return res.json();
}

function openAiModel(fetchFn) {
  const models = new Map(); // endpoint -> the model it serves first
  const lists = new Map(); // endpoint -> every chat model it listed last
  const call = (url, init) => fetchJson(fetchFn, url, init);

  // The endpoint's first chat model, or null. LM Studio lists every
  // downloaded model when it loads them on demand, embeddings included.
  async function listed(endpoint, signal) {
    const list = await call(`${endpoint}/models`, { signal });
    const ids = (Array.isArray(list?.data) ? list.data : []).map((m) => m?.id);
    const chat = [...new Set(ids.filter((m) => typeof m === "string" && m && !/embed/i.test(m)))];
    lists.set(endpoint, chat);
    const id = chat[0] ?? null;
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
    // Checks that the endpoint answers (and reads its models again);
    // resolves to the model it will ask.
    async start({ endpoint, model, signal } = {}) {
      models.delete(endpoint);
      lists.delete(endpoint);
      const first = await listed(endpoint, signal);
      if (!model && !first) throw new Error(`${endpoint}: no model`);
      return model || first;
    },
    // The chat models the endpoint listed when it last started, or null.
    known: (endpoint) => lists.get(endpoint) ?? null,
    async plan(prompt, schema, { endpoint, model, signal, system = SYSTEM } = {}) {
      const body = await call(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: await modelOf({ endpoint, model, signal }),
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          temperature: 0.8,
          max_tokens: 2000, // a high level plan dresses every sound in full
          response_format: { type: "json_schema", json_schema: { name: "section_plan", strict: true, schema } },
        }),
      });
      return JSON.parse(body?.choices?.[0]?.message?.content ?? "");
    },
  };
}

/* ---- the providers behind a linked account ---- */

const OPENAI = "https://api.openai.com/v1";
const ANTHROPIC = "https://api.anthropic.com/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

const json = (headers) => ({ "Content-Type": "application/json", ...headers });
const post = (headers, signal, body) => ({ method: "POST", headers: json(headers), signal, body: JSON.stringify(body) });
const listOf = (value) => (Array.isArray(value) ? value : []);

// Each lists its chat models newest first and asks one for a plan.
const PROVIDERS = {
  openai: {
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    async list(call, key, signal) {
      const body = await call(`${OPENAI}/models`, { headers: this.headers(key), signal });
      return listOf(body?.data)
        .filter((m) => typeof m?.id === "string" && /^(gpt-|o\d|chatgpt-)/.test(m.id))
        .filter((m) => !/audio|realtime|tts|transcribe|image|search|instruct|embedding|codex|research|-pro($|-)/.test(m.id))
        .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0))
        .map((m) => m.id);
    },
    async plan(call, { key, model, prompt, schema, signal, system }) {
      // Reasoning models take no temperature; a short think is plenty here.
      const reasons = /^(o\d|gpt-5)/.test(model) && !/chat/.test(model);
      const body = await call(
        `${OPENAI}/chat/completions`,
        post(this.headers(key), signal, {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_completion_tokens: 4000,
          ...(reasons ? { reasoning_effort: "low" } : {}),
          response_format: { type: "json_schema", json_schema: { name: "section_plan", strict: true, schema } },
        }),
      );
      return JSON.parse(body?.choices?.[0]?.message?.content ?? "");
    },
  },
  anthropic: {
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    }),
    async list(call, key, signal) {
      const body = await call(`${ANTHROPIC}/models?limit=100`, { headers: this.headers(key), signal });
      return listOf(body?.data)
        .map((m) => m?.id)
        .filter((id) => typeof id === "string" && id.startsWith("claude-"));
    },
    // The plan is the input of a tool the model must call: its schema holds.
    async plan(call, { key, model, prompt, schema, signal, system }) {
      const body = await call(
        `${ANTHROPIC}/messages`,
        post(this.headers(key), signal, {
          model,
          max_tokens: 2048,
          system,
          messages: [{ role: "user", content: prompt }],
          tools: [{ name: "section_plan", description: "Plays what you planned.", input_schema: schema }],
          tool_choice: { type: "tool", name: "section_plan" },
        }),
      );
      const use = listOf(body?.content).find((b) => b?.type === "tool_use");
      if (!use) throw new Error(`${model}: no plan`);
      return use.input;
    },
  },
  gemini: {
    headers: (key) => ({ "x-goog-api-key": key }),
    async list(call, key, signal) {
      const body = await call(`${GEMINI}/models?pageSize=1000`, { headers: this.headers(key), signal });
      return listOf(body?.models)
        .filter((m) => listOf(m?.supportedGenerationMethods).includes("generateContent"))
        .map((m) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : ""))
        .filter((id) => id.startsWith("gemini-") && !/tts|image|embedding|live|audio|computer-use|robotics/.test(id))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    },
    async plan(call, { key, model, prompt, schema, signal, system }) {
      const body = await call(
        `${GEMINI}/models/${encodeURIComponent(model)}:generateContent`,
        post(this.headers(key), signal, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
        }),
      );
      const parts = listOf(body?.candidates?.[0]?.content?.parts);
      return JSON.parse(parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join(""));
    },
  },
};

// Automatic: the newest fast model, a stable one before a preview.
export function autoModel(ids, fast) {
  const steady = (id) => !/preview|exp|lite|nano|latest/.test(id);
  return ids.find((id) => fast.test(id) && steady(id)) ?? ids.find((id) => fast.test(id)) ?? ids[0] ?? null;
}

function cloudModel(fetchFn, id) {
  const provider = PROVIDERS[id];
  const call = (url, init) => fetchJson(fetchFn, url, init);
  let listed = null; // { key, ids }: what the key could use when it last started

  async function list(key, signal) {
    if (!key) throw new Error(`${id}: no key`);
    const ids = await provider.list(call, key, signal);
    listed = { key, ids };
    return ids;
  }

  async function modelOf({ key, model, signal }) {
    if (model) return model;
    const ids = listed?.key === key ? listed.ids : await list(key, signal);
    const auto = autoModel(ids, CLOUDS[id].fast);
    if (!auto) throw new Error(`${id}: no model`);
    return auto;
  }

  return {
    supported: () => typeof fetchFn === "function",
    // Checks the key (and reads its models again); resolves to the model it will ask.
    async start({ key, model, signal } = {}) {
      listed = null;
      await list(key, signal);
      return modelOf({ key, model, signal });
    },
    // The chat models the key listed when it last started, or null.
    known: (key) => (listed && listed.key === key ? listed.ids : null),
    async plan(prompt, schema, { key, model, signal, system = SYSTEM } = {}) {
      return provider.plan(call, { key, model: await modelOf({ key, model, signal }), prompt, schema, signal, system });
    },
  };
}

export function createAi({ api = globalThis.LanguageModel, fetch = globalThis.fetch?.bind(globalThis) } = {}) {
  const clouds = Object.fromEntries(CLOUD_IDS.map((id) => [id, cloudModel(fetch, id)]));
  return { chrome: chromeModel(api), lmstudio: openAiModel(fetch), ...clouds };
}

/* ---- per-browser settings: on, engine, endpoint, model, keys, models, vibe, open, level, describe ---- */

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

/** A pasted API key: printable ASCII with no spaces, else "". */
export function cleanKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return /^[\x21-\x7e]{8,300}$/.test(key) ? key : "";
}

const perCloud = (raw, clean) =>
  Object.fromEntries(CLOUD_IDS.map((id) => [id, clean(raw && typeof raw === "object" && Object.hasOwn(raw, id) ? raw[id] : "")]));

export function cleanPrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    on: p.on === true,
    engine: ENGINES.includes(p.engine) ? p.engine : null, // null: Chrome's where it runs
    endpoint: cleanEndpoint(p.endpoint) ?? LMSTUDIO_URL,
    model: line(p.model, 120), // LM Studio's
    keys: perCloud(p.keys, cleanKey), // a linked account's API key, "" when not linked
    models: perCloud(p.models, (m) => line(m, 120)),
    vibe: line(p.vibe, 200),
    open: p.open !== false, // the settings unfolded
    level: LEVELS.includes(p.level) ? p.level : LEVEL_DEFAULT, // how much it asks (planner.js LEVELS)
    describe: p.describe !== false, // the sounds described in the prompt, or listed by id
  };
}

// Its own key, out of the workspace: what a browser can run is that
// browser's, so it never travels with a preset or the cloud save. The API
// keys with it: they stay in this browser.
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
