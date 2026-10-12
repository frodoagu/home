import { describe, expect, it, vi } from "vitest";
import { LMSTUDIO_URL, cleanEndpoint, cleanPrefs, createAi, loadPrefs, savePrefs } from "./ai.js";
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
    await expect(createAi({ fetch: fakeFetch({ models: ["text-embedding-x"] }) }).lmstudio.start({ endpoint: LMSTUDIO_URL })).rejects.toThrow(
      "no model",
    );
    await expect(createAi({ fetch: fakeFetch({ status: 500 }) }).lmstudio.start({ endpoint: LMSTUDIO_URL })).rejects.toThrow("HTTP 500");
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

describe("settings", () => {
  it("endpoints: http(s) only, no credentials, query or trailing slash; /v1 when there is no path", () => {
    expect(cleanEndpoint("http://localhost:1234")).toBe("http://localhost:1234/v1");
    expect(cleanEndpoint(" http://localhost:1234/v1/ ")).toBe("http://localhost:1234/v1");
    expect(cleanEndpoint("https://u:p@llm.lan/api/v1?x=1#y")).toBe("https://llm.lan/api/v1");
    for (const bad of ["", "localhost:1234", "ftp://x/v1", "javascript:alert(1)", 42, null]) expect(cleanEndpoint(bad)).toBeNull();
  });

  it("clean whatever was stored, and default to LM Studio's local server", () => {
    expect(cleanPrefs(null)).toEqual({ on: false, engine: null, endpoint: LMSTUDIO_URL, model: "", vibe: "" });
    expect(
      cleanPrefs({ on: "yes", engine: "constructor", endpoint: "nope", model: ` ${"m".repeat(200)}`, vibe: "  dark \n\n hypnotic " }),
    ).toEqual({ on: false, engine: null, endpoint: LMSTUDIO_URL, model: "m".repeat(120), vibe: "dark hypnotic" });
    expect(cleanPrefs({ on: true, engine: "lmstudio", endpoint: "http://pc.lan:1234/v1" })).toMatchObject({
      on: true,
      engine: "lmstudio",
      endpoint: "http://pc.lan:1234/v1",
    });
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
