import { describe, expect, it, vi } from "vitest";
import { LMSTUDIO_URL, autoModel, cleanEndpoint, cleanKey, cleanPrefs, createAi, loadPrefs, savePrefs } from "./ai.js";
import { SYSTEM } from "./planner.js";

const PLAN = { section: "peak", bars: 16, layers: {} };
const SCHEMA = { type: "object" };

// Chrome's LanguageModel, as far as ai.js uses it.
function fakeLanguageModel({ can = () => "available", answer = JSON.stringify(PLAN), clone = true } = {}) {
  const sessions = [];
  const session = (options) => {
    const s = {
      options,
      prompts: [],
      destroyed: false,
      prompt: vi.fn(async (text, opts) => {
        s.prompts.push({ text, opts });
        return answer;
      }),
      destroy() {
        s.destroyed = true;
      },
    };
    if (clone) s.clone = vi.fn(async () => session(options));
    sessions.push(s);
    return s;
  };
  const api = {
    sessions,
    availability: vi.fn(async (options) => can(options)),
    create: vi.fn(async (options) => {
      const listeners = [];
      options.monitor?.({ addEventListener: (type, cb) => listeners.push([type, cb]) });
      for (const [type, cb] of listeners) if (type === "downloadprogress") cb({ loaded: 0.5, total: 1 });
      return session(options);
    }),
  };
  return api;
}

describe("Chrome's built-in model", () => {
  it("is unsupported without LanguageModel, or when it says it cannot run", async () => {
    expect(createAi({ api: undefined }).chrome.supported()).toBe(false);
    expect(await createAi({ api: undefined }).chrome.availability()).toBe("unavailable");
    const api = fakeLanguageModel({ can: () => "unavailable" });
    expect(await createAi({ api }).chrome.availability("es")).toBe("unavailable");
    const broken = fakeLanguageModel({ can: () => Promise.reject(new Error("nope")) });
    expect(await createAi({ api: broken }).chrome.availability()).toBe("unavailable");
  });

  it("asks for the page's language too, and settles for English alone", async () => {
    const api = fakeLanguageModel({ can: (o) => (o.expectedInputs[0].languages.includes("pt") ? "unavailable" : "downloadable") });
    const { chrome } = createAi({ api });
    expect(await chrome.availability("pt")).toBe("downloadable");
    expect(api.availability.mock.calls.map(([o]) => o.expectedInputs[0].languages)).toEqual([["en", "pt"], ["en"]]);
    await chrome.start();
    expect(api.create.mock.calls[0][0].expectedInputs[0].languages).toEqual(["en"]);
    expect(api.create.mock.calls[0][0].expectedOutputs[0].languages).toEqual(["en"]);
  });

  it("starts once, reports the download, and holds the instructions in the base session", async () => {
    const api = fakeLanguageModel();
    const { chrome } = createAi({ api });
    const progress = [];
    await Promise.all([chrome.start((f) => progress.push(f)), chrome.start()]);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([0.5]);
    expect(api.create.mock.calls[0][0].initialPrompts).toEqual([{ role: "system", content: SYSTEM }]);
  });

  it("plans on a clone of the base session, held to the schema, and drops the clone", async () => {
    const api = fakeLanguageModel();
    const { chrome } = createAi({ api });
    const signal = new AbortController().signal;
    expect(await chrome.plan("next?", SCHEMA, { signal })).toEqual(PLAN);
    expect(await chrome.plan("next?", SCHEMA)).toEqual(PLAN);
    const [base, ...clones] = api.sessions;
    expect(base.prompts).toEqual([]); // the context never grows
    expect(clones).toHaveLength(2);
    expect(clones[0].prompts[0]).toEqual({ text: "next?", opts: { responseConstraint: SCHEMA, signal } });
    expect(clones.every((s) => s.destroyed)).toBe(true);
  });

  it("keeps one base session per set of instructions: a level's", async () => {
    const api = fakeLanguageModel();
    const { chrome } = createAi({ api });
    await chrome.plan("a", SCHEMA);
    await chrome.plan("b", SCHEMA, { system: "short" });
    await chrome.plan("c", SCHEMA, { system: "short" });
    const bases = api.create.mock.calls.map(([o]) => o.initialPrompts[0].content);
    expect(bases).toEqual([SYSTEM, "short"]);
  });

  it("without clone(), opens and closes a fresh session per plan", async () => {
    const api = fakeLanguageModel({ clone: false });
    const { chrome } = createAi({ api });
    await chrome.plan("a", SCHEMA);
    await chrome.plan("b", SCHEMA);
    expect(api.create).toHaveBeenCalledTimes(3);
    expect(api.sessions[0].prompts).toEqual([]);
    expect(api.sessions.slice(1).every((s) => s.destroyed && s.options.initialPrompts[0].content === SYSTEM)).toBe(true);
  });

  it("a failed start can be tried again; a broken answer rejects", async () => {
    const api = fakeLanguageModel({ answer: "not json" });
    api.create.mockRejectedValueOnce(new DOMException("needs a click", "NotAllowedError"));
    const { chrome } = createAi({ api });
    await expect(chrome.start()).rejects.toThrow("needs a click");
    await chrome.start();
    await expect(chrome.plan("x", SCHEMA)).rejects.toThrow(SyntaxError);
  });
});

describe("an LM Studio endpoint", () => {
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  function fakeFetch({ models = ["text-embedding-nomic", "qwen2.5-7b-instruct"], content = JSON.stringify(PLAN), status = 200 } = {}) {
    return vi.fn(async (url, init = {}) => {
      if (url.endsWith("/models")) return reply({ data: models.map((id) => ({ id })) }, status);
      if (url.endsWith("/chat/completions")) return reply({ choices: [{ message: { content } }] }, status);
      throw new TypeError(`no route ${url} ${init.method}`);
    });
  }

  it("start() checks the endpoint and answers the model it will ask: the first one that is not an embedding", async () => {
    const fetch = fakeFetch();
    const { lmstudio } = createAi({ fetch });
    expect(await lmstudio.start({ endpoint: LMSTUDIO_URL })).toBe("qwen2.5-7b-instruct");
    expect(await lmstudio.start({ endpoint: LMSTUDIO_URL, model: "mine" })).toBe("mine");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${LMSTUDIO_URL}/models`, `${LMSTUDIO_URL}/models`]);
    expect(lmstudio.known(LMSTUDIO_URL)).toEqual(["qwen2.5-7b-instruct"]); // what to pick from: no embeddings
    expect(lmstudio.known("http://other:1234/v1")).toBeNull();
    await expect(createAi({ fetch: fakeFetch({ models: ["text-embedding-x"] }) }).lmstudio.start({ endpoint: LMSTUDIO_URL })).rejects.toThrow(
      "no model",
    );
    const down = createAi({ fetch: fakeFetch({ status: 500 }) }).lmstudio;
    await expect(down.start({ endpoint: LMSTUDIO_URL })).rejects.toThrow("HTTP 500");
    expect(down.known(LMSTUDIO_URL)).toBeNull();
  });

  it("plans through chat/completions, with the instructions and the schema as response_format", async () => {
    const fetch = fakeFetch();
    const { lmstudio } = createAi({ fetch });
    const signal = new AbortController().signal;
    expect(await lmstudio.plan("next?", SCHEMA, { endpoint: LMSTUDIO_URL, signal })).toEqual(PLAN);
    const [url, init] = fetch.mock.calls.at(-1);
    expect(url).toBe(`${LMSTUDIO_URL}/chat/completions`);
    expect(init).toMatchObject({ method: "POST", signal, headers: { "Content-Type": "application/json" } });
    const body = JSON.parse(init.body);
    expect(body.model).toBe("qwen2.5-7b-instruct");
    expect(body.messages).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "next?" },
    ]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "section_plan", strict: true, schema: SCHEMA } });
    await lmstudio.plan("again", SCHEMA, { endpoint: LMSTUDIO_URL });
    expect(fetch.mock.calls.filter(([u]) => u.endsWith("/models"))).toHaveLength(1); // the model is remembered
    await lmstudio.plan("named", SCHEMA, { endpoint: LMSTUDIO_URL, model: "mine" });
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).model).toBe("mine");
    await lmstudio.plan("low", SCHEMA, { endpoint: LMSTUDIO_URL, system: "short" });
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).messages[0]).toEqual({ role: "system", content: "short" });
  });

  it("rejects an error status or an answer that is not JSON", async () => {
    await expect(createAi({ fetch: fakeFetch({ content: "{oops" }) }).lmstudio.plan("x", SCHEMA, { endpoint: LMSTUDIO_URL })).rejects.toThrow(
      SyntaxError,
    );
    const failing = fakeFetch();
    failing.mockImplementation(async (url) => (url.endsWith("/models") ? reply({ data: [{ id: "m" }] }) : reply({}, 400)));
    await expect(createAi({ fetch: failing }).lmstudio.plan("x", SCHEMA, { endpoint: LMSTUDIO_URL })).rejects.toThrow("HTTP 400");
  });
});

describe("a linked account", () => {
  const KEY = "sk-test-12345678";
  const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  // Each provider's API, as far as ai.js uses it.
  function fakeFetch({ status = 200, plan = PLAN } = {}) {
    return vi.fn(async (url) => {
      if (status !== 200) return reply({ error: "no" }, status);
      if (url === "https://api.openai.com/v1/models")
        return reply({
          data: [
            { id: "gpt-4o", created: 1 },
            { id: "gpt-4o-mini", created: 2 },
            { id: "gpt-5-mini", created: 5 },
            { id: "gpt-5", created: 4 },
            { id: "text-embedding-3-small", created: 9 },
            { id: "gpt-4o-realtime-preview", created: 9 },
            { id: "dall-e-3", created: 9 },
          ],
        });
      if (url === "https://api.openai.com/v1/chat/completions") return reply({ choices: [{ message: { content: JSON.stringify(plan) } }] });
      if (url === "https://api.anthropic.com/v1/models?limit=100")
        return reply({ data: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }, { id: "claude-haiku-4-5" }] });
      if (url === "https://api.anthropic.com/v1/messages")
        return reply({ content: [{ type: "text", text: "Sure." }, { type: "tool_use", name: "section_plan", input: plan }] });
      if (url === "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000")
        return reply({
          models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3-flash-preview", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          ],
        });
      if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/"))
        return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan).slice(0, 5) }, { text: JSON.stringify(plan).slice(5) }] } }] });
      throw new TypeError(`no route ${url}`);
    });
  }
  const bodyOf = (fetch) => JSON.parse(fetch.mock.calls.at(-1)[1].body);
  const headersOf = (fetch) => fetch.mock.calls.at(-1)[1].headers;

  it("Automatic takes the newest fast model, a stable one first", () => {
    expect(autoModel(["gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"], /flash/)).toBe("gemini-2.5-flash");
    expect(autoModel(["gemini-3-flash-preview", "gemini-2.5-pro"], /flash/)).toBe("gemini-3-flash-preview");
    expect(autoModel(["gpt-5"], /mini/)).toBe("gpt-5");
    expect(autoModel([], /mini/)).toBeNull();
  });

  it("start() needs a key, lists the chat models newest first and answers the one it will ask", async () => {
    const fetch = fakeFetch();
    const ai = createAi({ fetch });
    await expect(ai.openai.start({ key: "" })).rejects.toThrow("no key");
    expect(fetch).not.toHaveBeenCalled();
    expect(await ai.openai.start({ key: KEY })).toBe("gpt-5-mini");
    expect(ai.openai.known(KEY)).toEqual(["gpt-5-mini", "gpt-5", "gpt-4o-mini", "gpt-4o"]);
    expect(ai.openai.known("another-key-123")).toBeNull();
    expect(await ai.anthropic.start({ key: KEY })).toBe("claude-haiku-5-5");
    expect(await ai.gemini.start({ key: KEY, model: "gemini-2.5-pro" })).toBe("gemini-2.5-pro");
    expect(ai.gemini.known(KEY)).toEqual(["gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"]);
  });

  it("a rejected key fails with its status", async () => {
    const ai = createAi({ fetch: fakeFetch({ status: 401 }) });
    await expect(ai.anthropic.start({ key: KEY })).rejects.toMatchObject({ status: 401 });
    expect(ai.anthropic.known(KEY)).toBeNull();
  });

  it("OpenAI: chat/completions with the key, the schema as response_format and a short think", async () => {
    const fetch = fakeFetch();
    const { openai } = createAi({ fetch });
    const signal = new AbortController().signal;
    expect(await openai.plan("next?", SCHEMA, { key: KEY, signal })).toEqual(PLAN);
    expect(fetch.mock.calls.at(-1)[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetch.mock.calls.at(-1)[1]).toMatchObject({ method: "POST", signal });
    expect(headersOf(fetch).Authorization).toBe(`Bearer ${KEY}`);
    const body = bodyOf(fetch);
    expect(body).toMatchObject({ model: "gpt-5-mini", reasoning_effort: "low" });
    expect(body.messages).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "next?" },
    ]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "section_plan", strict: true, schema: SCHEMA } });
    expect(fetch.mock.calls.filter(([u]) => u.endsWith("/models"))).toHaveLength(1);
    await openai.plan("next?", SCHEMA, { key: KEY, model: "gpt-4o" });
    expect(bodyOf(fetch).model).toBe("gpt-4o");
    expect(bodyOf(fetch)).not.toHaveProperty("reasoning_effort");
  });

  it("Anthropic: messages from the browser, the plan as a tool the model must call", async () => {
    const fetch = fakeFetch();
    const { anthropic } = createAi({ fetch });
    expect(await anthropic.plan("next?", SCHEMA, { key: KEY, model: "claude-haiku-5-5" })).toEqual(PLAN);
    expect(fetch).toHaveBeenCalledTimes(1); // a named model needs no list
    expect(headersOf(fetch)).toMatchObject({
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    });
    const body = bodyOf(fetch);
    expect(body).toMatchObject({ model: "claude-haiku-5-5", system: SYSTEM, messages: [{ role: "user", content: "next?" }] });
    expect(body.tools).toEqual([{ name: "section_plan", description: expect.any(String), input_schema: SCHEMA }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "section_plan" });
    await anthropic.plan("high", SCHEMA, { key: KEY, model: "claude-haiku-5-5", system: "long" });
    expect(bodyOf(fetch).system).toBe("long");
  });

  it("Gemini: generateContent with the key in a header, never in the URL", async () => {
    const fetch = fakeFetch();
    const { gemini } = createAi({ fetch });
    expect(await gemini.plan("next?", SCHEMA, { key: KEY })).toEqual(PLAN);
    const [url] = fetch.mock.calls.at(-1);
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(fetch.mock.calls.every(([u]) => !u.includes(KEY))).toBe(true);
    expect(headersOf(fetch)["x-goog-api-key"]).toBe(KEY);
    expect(bodyOf(fetch)).toEqual({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: "next?" }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: SCHEMA },
    });
    await gemini.plan("x", SCHEMA, { key: KEY, model: "../../evil?x=" });
    expect(fetch.mock.calls.at(-1)[0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/..%2F..%2Fevil%3Fx%3D:generateContent");
  });
});

describe("settings", () => {
  it("endpoints: http(s) only, no credentials, query or trailing slash; /v1 when there is no path", () => {
    expect(cleanEndpoint("http://localhost:1234")).toBe("http://localhost:1234/v1");
    expect(cleanEndpoint(" http://localhost:1234/v1/ ")).toBe("http://localhost:1234/v1");
    expect(cleanEndpoint("https://u:p@llm.lan/api/v1?x=1#y")).toBe("https://llm.lan/api/v1");
    for (const bad of ["", "localhost:1234", "ftp://x/v1", "javascript:alert(1)", 42, null]) expect(cleanEndpoint(bad)).toBeNull();
  });

  it("clean whatever was stored, and default to LM Studio's local server", () => {
    const none = { openai: "", anthropic: "", gemini: "" };
    const rest = { keys: none, models: none, level: "mid" };
    expect(cleanPrefs(null)).toEqual({ on: false, engine: null, endpoint: LMSTUDIO_URL, model: "", vibe: "", open: true, ...rest });
    expect(
      cleanPrefs({
        on: "yes",
        engine: "constructor",
        endpoint: "nope",
        model: ` ${"m".repeat(200)}`,
        vibe: "  dark \n\n hypnotic ",
        open: 0,
        level: "ultra",
      }),
    ).toEqual({ on: false, engine: null, endpoint: LMSTUDIO_URL, model: "m".repeat(120), vibe: "dark hypnotic", open: true, ...rest });
    expect(cleanPrefs({ open: false }).open).toBe(false);
    expect(cleanPrefs({ level: "low", describe: false })).toEqual({ ...cleanPrefs(null), level: "low" });
    expect(cleanPrefs({ level: "high" }).level).toBe("high");
    expect(cleanPrefs({ on: true, engine: "lmstudio", endpoint: "http://pc.lan:1234/v1" })).toMatchObject({
      on: true,
      engine: "lmstudio",
      endpoint: "http://pc.lan:1234/v1",
    });
  });

  it("keep one API key and model per linked account, and nothing else", () => {
    const prefs = cleanPrefs({
      engine: "anthropic",
      keys: { openai: " sk-proj-abc123 ", anthropic: "has a space in it", gemini: 42, other: "sk-xyz-12345678" },
      models: { gemini: " gemini-2.5-flash ", __proto__: { openai: "x" } },
    });
    expect(prefs.engine).toBe("anthropic");
    expect(prefs.keys).toEqual({ openai: "sk-proj-abc123", anthropic: "", gemini: "" });
    expect(prefs.models).toEqual({ openai: "", anthropic: "", gemini: "gemini-2.5-flash" });
    expect(cleanPrefs({ keys: "sk-proj-abc123" }).keys.openai).toBe("");
    for (const bad of ["", "short", "sk-ünicode-123", "a b c d e f g h", null, {}]) expect(cleanKey(bad)).toBe("");
  });

  it("live in their own key, and survive storage that throws", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    savePrefs(storage, { ...cleanPrefs(null), on: true, vibe: "goa" });
    expect([...store.keys()]).toEqual(["psy-sampler:ai"]);
    expect(loadPrefs(storage)).toMatchObject({ on: true, vibe: "goa" });
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadPrefs(broken)).toEqual(cleanPrefs(null));
    expect(() => savePrefs(broken, cleanPrefs(null))).not.toThrow();
    expect(loadPrefs(null)).toEqual(cleanPrefs(null));
  });
});
