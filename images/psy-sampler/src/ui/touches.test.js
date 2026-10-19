// @vitest-environment jsdom
// ✨ touches (app.js planTouch), apart from app.test.js: that file already
// runs at its worker's heap limit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioContext, FakeWorklet } from "../test/fakeAudio.js";
import { createEngine } from "../audio/engine.js";
import { defaultData } from "../audio/patterns.js";
import { stepDuration } from "../audio/timing.js";
import { systemOf } from "../planner.js";
import { mountApp } from "./app.js";

let ctx;
let engine;
let root;

const BAR = 16 * stepDuration(145);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  ctx = new FakeAudioContext();
  engine = createEngine({ createContext: () => ctx, createWorklet: (c, name, options) => new FakeWorklet(c, name, options) });
  localStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const $ = (sel) => root.querySelector(sel);
const advanceSeconds = (s) => {
  for (let i = 0; i < Math.ceil(s / 0.025); i++) {
    ctx.currentTime += 0.025;
    vi.advanceTimersByTime(25);
  }
};
const saved = () => JSON.parse(localStorage.getItem("psy-sampler:v2"));
const flushPromises = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Chrome's model, as ai.js hands it over. Plans get `answers` in turn (a
// function gets the ask's opts and schema) and go to `asks`; touches (their
// schema has loops) get `touches` in turn (nothing by default) and go to
// `touchAsks`. Openings, forms, closings and tunes get nothing usable: the
// intro, the set's own form and the listener's words stay.
function fakeAi({ answers = [], touches = [] } = {}) {
  const asks = [];
  const touchAsks = [];
  const pick = (list, n, none) => {
    const answer = list[Math.min(n - 1, list.length - 1)] ?? none;
    return (opts, schema) => (typeof answer === "function" ? answer(opts, schema) : Promise.resolve(answer));
  };
  const plan = vi.fn((prompt, schema, opts) => {
    const p = schema.properties;
    if (p.genre) return Promise.resolve({ vibe: "", genre: "" });
    if (p.form) return Promise.resolve({ why: "" });
    if (p.sections) return Promise.resolve({ why: "", sections: [] });
    if (p.fx) return Promise.resolve(null);
    if (p.loops) {
      touchAsks.push({ prompt, schema, opts });
      return pick(touches, touchAsks.length, { why: "", id: "", loops: 4 })(opts, schema);
    }
    asks.push({ prompt, schema, opts });
    return pick(answers, asks.length, null)(opts, schema);
  });
  const chrome = { supported: () => true, availability: vi.fn(async () => "available"), start: vi.fn(async () => "chrome"), plan };
  return { asks, touchAsks, chrome };
}

const mountWith = async (ai) => {
  root = document.createElement("div");
  document.body.replaceChildren(root);
  mountApp(root, engine, { languages: ["es-AR"], confirm: () => true, ai });
  await flushPromises();
  return ai;
};
const aiBtn = () => $("button.ai");
// `plan`, for the section and the bars the ask pins (the form's) where it pins them.
const fits = (plan) => (opts, schema) => {
  const [only, more] = schema.properties.section.enum;
  const [bars, longer] = schema.properties.bars.enum;
  return Promise.resolve({ ...plan, ...(more ? {} : { section: only }), ...(longer ? {} : { bars }) });
};
const OPEN = { why: "rolling in", section: "groove", bars: 8, layers: { lead: ["lead.acid"], pad: ["pad.chord"] } };
const GROOVE = { section: "groove", bars: 16, layers: {} };
const PLANS = [fits(OPEN), fits(GROOVE)];

describe("✨ touches", () => {
  it("idle, it rides a touch on the lead from the next loop's first beat, never stored, and takes it off after its loops", async () => {
    const touch = { why: "open the acid", id: "lead.acid", loops: 1, filter: "lowpass", cutoff: 2, res: 2, sweep: "", shape: "", env: 0, distortion: "soft", drive: 1 };
    const rest = { why: "let it breathe", id: "", loops: 4 };
    const ai = await mountWith(fakeAi({ answers: PLANS, touches: [touch, rest] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    expect(ai.touchAsks).toHaveLength(0); // the intro's lead is not the planned one's: nothing is touched before
    advanceSeconds(8 * BAR);
    const planned = ai.asks.length;
    await flushPromises();
    expect($(".section-badge").textContent).toBe("Groove");
    expect(ai.asks).toHaveLength(planned); // all three planned: the model is free
    expect(ai.touchAsks).toHaveLength(1);
    const [ask] = ai.touchAsks;
    expect(ask.prompt).toContain("Now playing: groove, loop 1 of 4");
    expect(ask.prompt).toContain("Melodic sounds you can touch: lead.acid."); // no vibe: by id
    expect(ask.schema.properties.id.enum).toEqual(["", "lead.acid"]);
    expect(ask.opts.system).toBe(systemOf({ style: "psytrance", bpm: 145 })); // the plans' own instructions
    expect(aiBtn().classList.contains("is-thinking")).toBe(false); // a touch is no plan
    const setData = vi.spyOn(engine, "setData");
    const lead = () => setData.mock.calls.filter(([id]) => id === "lead.acid").at(-1);
    const tile = () => $('[data-key="lead.acid"]');
    advanceSeconds(2 * BAR);
    const [, data, , at] = lead();
    expect(data.insert).toMatchObject({ filter: "lowpass", res: 12, drive: "soft", amount: 0.35 });
    expect(at).toBeGreaterThan(0); // on the bar line, not as the tick runs
    expect(tile().classList.contains("is-touched")).toBe(true);
    expect(tile().title).toBe("open the acid");
    expect(saved().variants["lead.acid"].insert.filter).toBe(defaultData("lead.acid").insert.filter);
    await flushPromises();
    expect(ai.touchAsks).toHaveLength(2); // its last loop: the next one is asked
    expect(ai.touchAsks[1].prompt).toContain("Your last touches, oldest first: lead.acid drive 1 filter lowpass cutoff 2 res 2 distortion soft for 1 loop.");
    advanceSeconds(2 * BAR);
    expect(lead()[1].insert.filter).toBe(defaultData("lead.acid").insert.filter);
    expect(tile().classList.contains("is-touched")).toBe(false);
    advanceSeconds(2 * BAR);
    await flushPromises();
    expect(ai.touchAsks).toHaveLength(2); // nothing for 4 loops, and this one is the section's last
    advanceSeconds(2 * BAR);
    await flushPromises();
    expect($(".section-badge").textContent).toBe("Subida");
    expect(ai.touchAsks).toHaveLength(3); // a new section ends the rest
  });

  it("Toques off, the model's idle time goes to nothing", async () => {
    localStorage.setItem("psy-sampler:ai", JSON.stringify({ touches: false }));
    const ai = await mountWith(fakeAi({ answers: PLANS }));
    expect($("#ai-touch").value).toBe("off");
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    advanceSeconds(12 * BAR);
    await flushPromises();
    expect(ai.touchAsks).toHaveLength(0);
    $("#ai-touch").value = "on";
    $("#ai-touch").dispatchEvent(new Event("change"));
    expect(ai.touchAsks).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("psy-sampler:ai")).touches).toBe(true);
  });

  it("a section to plan comes before a touch on its way", async () => {
    const ai = await mountWith(fakeAi({ answers: PLANS, touches: [() => new Promise(() => {})] }));
    aiBtn().click();
    $("button.auto").click();
    await flushPromises();
    advanceSeconds(10 * BAR);
    await flushPromises();
    expect(ai.touchAsks).toHaveLength(1); // never answers
    const [ask] = ai.touchAsks;
    const planned = ai.asks.length;
    $("#ai-vibe").value = "más oscuro";
    $("#ai-vibe").dispatchEvent(new Event("change"));
    $(".ai-apply").click(); // the plans past the next go: one to ask again
    await flushPromises();
    expect(ask.opts.signal.aborted).toBe(true);
    expect(ai.asks.length).toBeGreaterThan(planned);
  });
});
