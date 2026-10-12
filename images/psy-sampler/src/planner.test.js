import { describe, expect, it } from "vitest";
import { LAYERS } from "./catalog.js";
import { DEFAULTS } from "./audio/patterns.js";
import { SECTIONS, STYLES, countRange, poolOf } from "./autopilot.js";
import {
  CHARACTER,
  PLAN_MAX,
  PLAN_SECTIONS,
  SYSTEM,
  normalizePlan,
  planPrompt,
  planSchema,
  readPlans,
  whyOf,
} from "./planner.js";
import { normalize } from "./workspace.js";

const { lists } = normalize({ lists: { lead: ["lead.acid~1"] } });
const goa = { lists, style: "goa" };

describe("the prompt", () => {
  it("teaches the sections' forms, read off the autopilot", () => {
    expect(SYSTEM).toContain("- peak: 16 or 24 bars; kick 1, bass 1, perc 2-3, lead 1, pad 1, glitch 1");
    expect(SYSTEM).toContain("- breakdown: 8 or 16 bars; kick 0, bass 0, perc 0-1, lead 1, pad 1, glitch 0-1");
    expect(SYSTEM).toContain("An empty list leaves that layer out.");
    expect(SYSTEM).toContain("The listener's wishes come first");
    expect(SYSTEM).toContain("its length in bars (one of the lengths that section has)");
  });

  it("knows the character of every looping sound, and of nothing else", () => {
    const loops = new Set(LAYERS.filter((l) => !l.oneShot).map((l) => l.id));
    const ids = Object.keys(DEFAULTS).filter((id) => loops.has(id.split(".")[0]));
    expect(Object.keys(CHARACTER).sort()).toEqual(ids.sort());
  });

  it("says the style, what played, what plays now, the vibe and every sound it may use", () => {
    const prompt = planPrompt({
      ...goa,
      bpm: 145.4,
      active: { kick: "kick.long", "lead.acid~1": "lead.acid~1" },
      sections: ["intro", "groove", "build", "peak", "breakdown", "build", "peak", "groove", "build", "peak"],
      sounds: [[], [], [], [], [], [], ["kick.long", "pad.prog"], ["kick.long", "bass.rolling"], [], ["kick.long"]],
      bars: 16,
      vibe: 'oscuro "y" largo',
      fresh: true,
      names: { "lead.acid~1": "Mi ácido" },
    });
    expect(prompt).toContain("Style: Goa, 145 BPM.");
    expect(prompt).toContain("Sections so far: build, peak, breakdown, build, peak, groove, build, peak."); // the last 8
    expect(prompt).toContain("Now playing: peak, 16 bars.");
    expect(prompt).toContain("Sounds playing now: kick.long, lead.acid~1.");
    // the 3 before the one playing, those that opened with something
    expect(prompt).toContain("What the sections before it opened with:\n- peak: kick.long, pad.prog\n- groove: kick.long, bass.rolling\n");
    expect(prompt).toContain('The listener just asked for: "oscuro \\"y\\" largo". That comes first');
    expect(prompt.indexOf("The listener just asked")).toBeGreaterThan(prompt.indexOf("Sounds you can use")); // last, so it weighs
    for (const id of poolOf(lists, "lead", "goa")) expect(prompt).toContain(`${id} (`);
    expect(prompt).toContain('lead.acid~1 ("Mi ácido", a copy of Acid: 303: resonant filter, A minor; squelchy, hypnotic, driving)');
    expect(prompt).toContain("After the peak, the usual next is breakdown or groove.");
    expect(prompt).not.toContain("kick.punchy"); // not goa's
    expect(prompt.trim().endsWith("Plan the next section.")).toBe(true);
  });

  it("leaves the vibe out when there is none, and asks for the queued section when there is one", () => {
    const base = { ...goa, bpm: 145, active: {}, sections: ["intro"], bars: 8 };
    expect(planPrompt(base)).not.toContain("listener");
    expect(planPrompt({ ...base, vibe: "dark" })).toContain('The listener\'s standing wish: "dark".');
    expect(planPrompt(base)).not.toContain("What the sections before it");
    expect(planPrompt(base)).toContain("After the intro, the usual next is groove. Plan the next section.");
    expect(planPrompt({ ...base, sections: ["groove", "build"] })).toContain("the usual next is peak; now and then breakdown.");
    expect(planPrompt(base)).toContain("Sounds playing now: none.");
    const queued = planPrompt({ ...base, next: "breakdown" });
    expect(queued).toContain("The listener queued breakdown next: plan that section.");
    expect(queued).not.toContain("usual next");
    expect(planPrompt(base)).not.toContain("theme");
  });

  it("says the theme only where the pilot holds it: the step after a breakdown or a build", () => {
    const base = { ...goa, bpm: 145, active: {}, bars: 8, theme: ["lead.acid"] };
    const held = "If you plan a build, its lead is the theme, lead.acid: the pilot keeps it there whatever you pick.";
    expect(planPrompt({ ...base, sections: ["breakdown"] })).toContain(held);
    expect(planPrompt({ ...base, sections: ["build"] })).toContain("If you plan a peak, its lead is the theme");
    expect(planPrompt({ ...base, sections: ["breakdown"], next: "groove" })).not.toContain("theme");
    expect(planPrompt({ ...base, sections: ["breakdown"], next: "build" })).toContain(held);
    expect(planPrompt({ ...base, sections: ["peak"] })).not.toContain("theme");
  });
});

describe("the schema", () => {
  it("names every section a plan may pick, their lengths and each layer's pool as enums", () => {
    const schema = planSchema(goa);
    expect(Object.keys(schema.properties)[0]).toBe("why"); // said before it picks
    expect(schema.required).toEqual(["why", "section", "bars", "layers"]);
    expect(schema.properties.section.enum).toEqual(PLAN_SECTIONS);
    expect(PLAN_SECTIONS).not.toContain("intro");
    expect(schema.properties.bars.enum).toEqual([8, 16, 24]);
    const layers = schema.properties.layers;
    expect(Object.keys(layers.properties)).toEqual(["kick", "bass", "perc", "lead", "pad", "glitch"]);
    expect(layers.required).toEqual(Object.keys(layers.properties));
    expect(layers.properties.lead.items.enum).toEqual(poolOf(lists, "lead", "goa"));
    expect(layers.properties.perc.maxItems).toBe(3); // the peak's
    expect(layers.properties.kick.maxItems).toBe(1);
  });

  it("only allows the queued section when one is queued, unless a plan cannot pick it", () => {
    expect(planSchema({ ...goa, next: "peak" }).properties.section.enum).toEqual(["peak"]);
    expect(planSchema({ ...goa, next: "intro" }).properties.section.enum).toEqual(PLAN_SECTIONS);
  });

  it("leaves out a layer the style leaves out", () => {
    const style = "test-no-glitch";
    STYLES[style] = { bpm: 140, pool: { ...STYLES.goa.pool, glitch: undefined } };
    try {
      expect(planSchema({ lists, style }).properties.layers.properties).not.toHaveProperty("glitch");
      expect(planPrompt({ lists, style, bpm: 140, active: {}, sections: ["intro"], bars: 8 })).not.toMatch(/^glitch:/m);
    } finally {
      delete STYLES[style];
    }
  });
});

describe("whyOf", () => {
  it("keeps the model's sentence on one short line, and nothing else", () => {
    expect(whyOf({ why: "  a dark\n break " })).toBe("a dark break");
    expect(whyOf({ why: "x".repeat(500) })).toHaveLength(200);
    for (const raw of [null, {}, { why: 3 }, "why"]) expect(whyOf(raw)).toBe("");
  });

  it("is not part of a plan", () => {
    expect(normalizePlan({ why: "because", section: "groove", bars: 8 }, goa)).toEqual({ section: "groove", bars: 8, layers: {} });
  });
});

describe("normalizePlan", () => {
  const plan = {
    section: "peak",
    bars: 24,
    layers: { kick: ["kick.long"], bass: ["bass.rolling"], perc: ["perc.hat", "perc.toms"], lead: ["lead.acid~1"], pad: ["pad.prog"], glitch: ["glitch.zips"] },
  };

  it("keeps a good plan as it is, and is idempotent", () => {
    expect(normalizePlan(plan, goa)).toEqual(plan);
    expect(normalizePlan(normalizePlan(plan, goa), goa)).toEqual(plan);
  });

  it("refuses what is not a plan, or picks no section it may pick", () => {
    for (const raw of [null, "peak", 3, [], {}, { section: "intro" }, { section: "constructor" }, { section: "__proto__" }]) {
      expect(normalizePlan(raw, goa)).toBeNull();
    }
  });

  it("forgets a length the section cannot have: the pilot draws one", () => {
    expect(normalizePlan({ ...plan, bars: 8 }, goa).bars).toBeNull(); // a peak is 16 or 24
    expect(normalizePlan({ ...plan, bars: "24" }, goa).bars).toBeNull();
    expect(normalizePlan({ section: "groove", bars: 8 }, goa)).toEqual({ section: "groove", bars: 8, layers: {} });
  });

  it("keeps only ids in the style's pool, at most as many as the section plays", () => {
    const out = normalizePlan(
      {
        section: "groove",
        bars: 16,
        layers: {
          kick: ["kick.punchy", "kick.long"], // punchy is not goa's
          perc: ["perc.hat", "perc.hat", "perc.toms", "perc.snare"], // a groove plays 1-2
          lead: [42, { id: "lead.acid" }, "lead.acid"],
          pad: "pad.prog",
          fx: ["fx.riser"],
        },
      },
      goa,
    );
    expect(out.layers).toEqual({ kick: ["kick.long"], perc: ["perc.hat", "perc.toms"], lead: ["lead.acid"] });
    const sneaky = JSON.parse('{"section":"groove","layers":{"__proto__":{"kick":["kick.long"]}}}');
    expect(normalizePlan(sneaky, goa).layers).toEqual({});
    expect({}.kick).toBeUndefined();
  });

  it("keeps fewer sounds than the section usually plays, down to none: the vibe's call", () => {
    const out = normalizePlan({ section: "peak", layers: { kick: [], perc: ["perc.hat"], pad: [] } }, goa);
    expect(out.layers).toEqual({ kick: [], perc: ["perc.hat"], pad: [] });
    const bd = normalizePlan({ section: "breakdown", layers: { kick: [], perc: [], glitch: [] } }, goa);
    expect(bd.layers).toEqual({ kick: [], perc: [], glitch: [] });
  });

  it("drops a layer whose sounds are all foreign: the pilot draws it", () => {
    const out = normalizePlan({ section: "peak", layers: { pad: ["pad.nope"], kick: ["kick.punchy"] } }, goa);
    expect(out.layers).toEqual({});
  });

  it("every plan it keeps fits its section's shape", () => {
    for (const section of PLAN_SECTIONS) {
      const all = Object.fromEntries(Object.entries(lists).map(([layer, ids]) => [layer, ids]));
      const out = normalizePlan({ section, bars: SECTIONS[section].loops[0] * 2, layers: all }, { lists, style: "all" });
      for (const [layer, ids] of Object.entries(out.layers)) {
        expect(ids.length).toBeLessThanOrEqual(countRange(section, layer)[1]);
      }
    }
  });
});

describe("readPlans", () => {
  it("takes a list, at most PLAN_MAX long, with null for anything that is not an object", () => {
    expect(readPlans({})).toBeNull();
    expect(readPlans("[]")).toBeNull();
    expect(readPlans([{ section: "peak" }, null, 3, [], "x"])).toEqual([{ section: "peak" }, null, null, null, null]);
    expect(readPlans(Array.from({ length: PLAN_MAX + 1 }, () => null))).toHaveLength(PLAN_MAX);
  });
});
