import { describe, expect, it } from "vitest";
import { LAYERS } from "./catalog.js";
import { DEFAULTS } from "./audio/patterns.js";
import { SECTIONS, STYLES, countRange, poolOf } from "./autopilot.js";
import {
  CHARACTER,
  OPENING_FX,
  PLAN_MAX,
  PLAN_SECTIONS,
  SYSTEM,
  keptAhead,
  normalizeOpening,
  normalizePlan,
  openWith,
  openingPrompt,
  openingSchema,
  planPrompt,
  planSchema,
  readPlans,
  themeAfter,
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
    const loops = new Set(LAYERS.filter((l) => !l.oneShot && !l.manual).map((l) => l.id));
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

describe("planning ahead", () => {
  const base = { ...goa, bpm: 145, active: {}, sections: ["intro"], bars: 8 };
  const planned = [
    { section: "groove", bars: 16, layers: { kick: ["kick.long"], bass: ["bass.rolling"], pad: [] } },
    { section: "build", bars: null, layers: {} },
  ];

  it("lists the sections already planned and asks for the one after the last", () => {
    const prompt = planPrompt({ ...base, planned });
    expect(prompt).toContain("Already planned to follow it, in order:\n- groove, 16 bars: kick.long, bass.rolling; no pad\n- build\n");
    expect(prompt).toContain("After the planned build, the usual next is peak; now and then breakdown. Plan the section after it.");
    expect(prompt).not.toContain("Plan the next section.");
    expect(planPrompt({ ...base, planned, next: "breakdown" })).toContain("The listener queued breakdown after the planned build: plan that section.");
    expect(SYSTEM).toContain("after the last of them");
  });

  it("says the theme where the last planned section leads into its hold", () => {
    const prompt = planPrompt({ ...base, sections: ["peak"], planned: [{ section: "breakdown", bars: 8, layers: {} }], theme: ["lead.acid"] });
    expect(prompt).toContain("If you plan a build, its lead is the theme, lead.acid");
  });

  it("follows the theme the pilot will hold through the planned sections", () => {
    const active = { kick: "kick.long", "lead.arp": "lead.arp" };
    const plan = (section, lead) => ({ section, bars: null, layers: lead ? { lead } : {} });
    expect(themeAfter({ section: "breakdown" }, active)).toEqual(["lead.arp"]);
    expect(themeAfter({ section: "build", theme: ["lead.bell"] }, active)).toEqual(["lead.bell"]);
    expect(themeAfter({ section: "peak" }, active)).toEqual([]);
    expect(themeAfter({ section: "breakdown" }, active, [plan("build")])).toEqual(["lead.arp"]); // held into the peak
    expect(themeAfter({ section: "breakdown" }, active, [plan("build"), plan("peak")])).toEqual([]);
    expect(themeAfter({ section: "peak" }, active, [plan("breakdown", ["lead.acid"])])).toEqual(["lead.acid"]);
    expect(themeAfter({ section: "peak" }, active, [plan("breakdown")])).toEqual([]); // the pilot draws it
    expect(themeAfter({ section: "groove" }, active, [plan("build")])).toEqual([]); // no breakdown before it
  });

  it("keeps the plans ahead that the queue still leads to", () => {
    const entry = (section, queued = false) => ({ plan: { section }, queued });
    const ahead = [entry("peak", true), entry("breakdown"), entry("build")];
    expect(keptAhead(ahead, ["peak"])).toBe(3);
    expect(keptAhead(ahead, ["peak", "breakdown"])).toBe(3);
    expect(keptAhead(ahead, ["peak", "groove"])).toBe(1);
    expect(keptAhead(ahead, ["groove"])).toBe(0);
    expect(keptAhead(ahead, [])).toBe(0); // the peak was only planned because it was queued
    expect(keptAhead([entry("groove"), entry("build")], [])).toBe(2);
    expect(keptAhead([], ["peak"])).toBe(0);
  });
});

describe("the schema", () => {
  it("names every section a plan may pick, their lengths and each layer's pool as enums", () => {
    const schema = planSchema(goa);
    expect(Object.keys(schema.properties)[0]).toBe("why"); // said before it picks
    expect(schema.required).toEqual(["why", "section", "bars", "layers", "dress", "parts"]);
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

  it("dresses any sound it may name with whole macros, a synth of its group or none", () => {
    const { dress, parts } = planSchema(goa).properties;
    const item = dress.items;
    expect(item.properties.id.enum).toEqual(expect.arrayContaining(poolOf(lists, "lead", "goa")));
    expect(item.properties.tone.enum).toEqual([-2, -1, 0, 1, 2]);
    expect(item.required).toEqual(["id", "tone", "length", "drive", "motion", "synth"]);
    expect(item.properties.synth.enum).toEqual(expect.arrayContaining(["", "acid", "supersaw", "sub", "pad"]));
    expect(dress.maxItems).toBe(1 + 1 + 3 + 1 + 1 + 1);
    expect(parts.properties.lead).toMatchObject({ maxItems: 16 });
    expect(parts.properties.pad).toMatchObject({ maxItems: 2 });
    expect(parts.properties.bass).toMatchObject({ maxItems: 4 });
    expect(parts.properties.lead.items.enum).toEqual(["-", ...Array.from({ length: 15 }, (_, i) => String(i + 1))]);
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

describe("dress and parts in a plan", () => {
  const plan = { section: "peak", bars: 16, layers: { kick: ["kick.long"], bass: ["bass.rolling"], lead: ["lead.acid"], pad: [] } };

  it("keeps the macros that move a sound the plan names, in id order", () => {
    const out = normalizePlan(
      {
        ...plan,
        dress: [
          { id: "lead.acid", tone: -2, length: 0, drive: 1, motion: 2, synth: "supersaw" },
          { id: "kick.long", tone: 1, length: 0, drive: 0, motion: 2, synth: "" }, // no motion on a kick
          { id: "lead.acid", tone: 2 }, // the first one counts
          { id: "pad.chord", tone: 1 }, // not in the plan
          { id: "bass.rolling", tone: 3, drive: 1.5, synth: "acid" }, // out of range, not whole, not its group
          { id: "__proto__", tone: 1 },
          "lead.acid",
        ],
      },
      goa,
    );
    expect(out.dress).toEqual([
      { id: "kick.long", tone: 1 },
      { id: "lead.acid", tone: -2, drive: 1, motion: 2, synth: "supersaw" },
    ]);
    expect(normalizePlan(out, goa)).toEqual(out);
    expect(normalizePlan({ ...plan, dress: [{ id: "lead.acid", tone: 0, synth: "" }] }, goa)).not.toHaveProperty("dress");
  });

  it("keeps a part for each melodic layer the plan names a sound in, at its full length", () => {
    const out = normalizePlan({ ...plan, parts: { lead: ["1", "-", "3", "-", "5", "-", "-", "-"], pad: ["1", "6"], bass: ["-", "1", "x", "1", "1", "1"] } }, goa);
    expect(out.parts.lead).toEqual(Array(2).fill(["1", "-", "3", "-", "5", "-", "-", "-"]).flat());
    expect(out.parts).not.toHaveProperty("pad"); // the plan leaves the pad out
    expect(out.parts.bass).toEqual(["-", "1", "1", "1"]);
    expect(normalizePlan(out, goa)).toEqual(out);
    expect(normalizePlan({ ...plan, parts: { lead: ["-", "-"], kick: ["1"] } }, goa)).not.toHaveProperty("parts");
    expect(normalizePlan({ ...plan, parts: "1 3 5" }, goa)).not.toHaveProperty("parts");
  });

  it("tells the model the key, the synths it may switch to and how it dressed what plays", () => {
    const prompt = planPrompt({
      ...goa,
      bpm: 145,
      active: { lead: "lead.acid" },
      sections: ["intro"],
      bars: 8,
      dressed: [{ id: "lead.acid", tone: -1, synth: "acid" }, { id: "pad.chord", tone: 2 }],
      synths: { "lead.acid": "acid" },
    });
    expect(prompt).toContain("Key: A harmonic minor.");
    expect(prompt).toContain("How you dressed them: lead.acid tone -1 synth acid.");
    expect(prompt).not.toContain("pad.chord tone");
    expect(prompt).toContain("lead.acid (Acid: 303: resonant filter, A minor; squelchy, hypnotic, driving; synth acid)");
    expect(prompt).toMatch(/^lead: acid \(Acid 303: .*supersaw \(Supersaw/m);
    expect(prompt).toMatch(/^bass: bass \(Saw pluck/m);
    expect(SYSTEM).toContain('"-", "1", "1", "1" rolls between the kicks');
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

describe("the opening", () => {
  const psy = { lists, style: "psytrance", section: "intro" };

  it("asks for the section the track starts with, with room to make it count", () => {
    const prompt = openingPrompt({ ...psy, bpm: 145, active: { kick: "kick.punchy", "pad.chord": "pad.chord" }, vibe: "épico" });
    expect(prompt).toContain("Style: Psytrance, 145 BPM.");
    expect(prompt).toContain("This is the opening of the track and of the show");
    expect(prompt).toContain("Plan the intro it opens with: 8 or 16 bars; kick 0-1, bass 0-1, perc 0-2, lead 0-1, pad 0-2, glitch 0-1.");
    expect(prompt).toContain("The seed drew: kick.punchy, pad.chord.");
    for (const id of poolOf(lists, "lead", "psytrance")) expect(prompt).toContain(`${id} (`);
    for (const id of OPENING_FX) expect(prompt).toContain(`${id} (`);
    expect(prompt).toContain('The listener asked for: "épico".');
    expect(prompt.trim().endsWith("Plan the opening intro.")).toBe(true);
    expect(openingPrompt({ ...psy, bpm: 145 })).not.toContain("listener");
    expect(SYSTEM).toContain("or, when asked, the opening the track starts with");
  });

  it("its schema names only that section, its lengths, a lead and the hits", () => {
    const schema = openingSchema(psy);
    expect(schema.properties.section.enum).toEqual(["intro"]);
    expect(schema.properties.bars.enum).toEqual([8, 16]);
    expect(schema.properties.layers.properties.lead.maxItems).toBe(1);
    expect(schema.properties.layers.properties.pad.maxItems).toBe(2);
    expect(schema.properties.fx.enum).toEqual(["", ...OPENING_FX]);
    expect(schema.required).toContain("fx");
    expect(planSchema(psy).properties).not.toHaveProperty("fx");
    // another section opens within its own shape
    expect(openingSchema({ ...psy, section: "peak" }).properties.bars.enum).toEqual([16, 24]);
  });

  it("keeps a good opening, with its hit, and is idempotent", () => {
    const raw = {
      why: "soaring",
      section: "intro",
      bars: 16,
      layers: { kick: [], lead: ["lead.soaring"], pad: ["pad.supersaw", "pad.chord", "pad.prog"] },
      parts: { lead: ["8", "5"] },
      fx: "fx.impact",
    };
    const opening = normalizeOpening(raw, psy);
    expect(opening).toEqual({
      section: "intro",
      bars: 16,
      layers: { kick: [], lead: ["lead.soaring"], pad: ["pad.supersaw", "pad.chord"] },
      parts: { lead: Array.from({ length: 16 }, (_, i) => (i % 2 ? "5" : "8")) },
      fx: "fx.impact",
    });
    expect(normalizeOpening(opening, psy)).toEqual(opening);
    expect(normalizeOpening({ ...raw, fx: "fx.tapeStop" }, psy)).not.toHaveProperty("fx");
    expect(normalizeOpening({ ...raw, bars: 24 }, psy).bars).toBeNull();
  });

  it("refuses an opening for another section, or what is not one", () => {
    expect(normalizeOpening({ section: "groove", layers: {} }, psy)).toBeNull();
    expect(normalizeOpening([], psy)).toBeNull();
    expect(normalizeOpening(null, psy)).toBeNull();
    expect(normalizeOpening({ section: "intro", layers: {} }, { ...psy, section: "nope" })).toBeNull();
  });

  it("is laid over the seed's draw, layer by layer, and always keeps a lead or a pad", () => {
    const drawn = { kick: "kick.punchy", "perc.hat": "perc.hat", "pad.chord": "pad.chord" };
    const over = (layers) => openWith(drawn, { section: "intro", bars: null, layers }, lists, "psytrance");
    expect(over({ kick: [], lead: ["lead.soaring"] })).toEqual({ "perc.hat": "perc.hat", "pad.chord": "pad.chord", "lead.soaring": "lead.soaring" });
    expect(over({ kick: ["kick.fullon"], pad: ["pad.supersaw"] })).toEqual({ kick: "kick.fullon", "perc.hat": "perc.hat", "pad.supersaw": "pad.supersaw" });
    expect(over({ pad: [] })).toEqual(drawn); // no lead, no pad: the draw's pad stays
    expect(over({ lead: ["lead.techno"] })).toEqual(drawn); // not psytrance's
  });
});
