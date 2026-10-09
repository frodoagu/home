import { describe, expect, it } from "vitest";
import { LAYERS } from "./catalog.js";
import { defaultData } from "./audio/patterns.js";
import { copyId, moveItem, normalize, parsePreset, toPreset } from "./workspace.js";

describe("normalize", () => {
  it("fills a factory workspace from nothing", () => {
    const ws = normalize(undefined);
    expect(ws).toMatchObject({ bpm: 145, combine: false, bgKick: true, quantize: true, names: {}, variants: {} });
    expect(ws.effects).toEqual({ delay: true, reverb: true });
    expect(ws.order).toEqual([...LAYERS.map((l) => l.id), "snap"]);
    expect(ws.snapshots).toEqual([]);
    expect(ws.rampBars).toBe(8);
    expect(ws.lists.kick).toEqual(LAYERS[0].variants);
    expect(ws.active).toEqual({});
  });

  it("keeps a valid layout and appends whatever is missing", () => {
    const ws = normalize({
      order: ["pad", "nope", "kick", "pad"],
      lists: { kick: ["kick.tok", "kick.punchy~2", "bass.offbeat", "kick.punchy~x"] },
    });
    expect(ws.order.slice(0, 2)).toEqual(["pad", "kick"]);
    expect(ws.order).toHaveLength(7);
    expect(ws.lists.kick).toEqual(["kick.tok", "kick.punchy~2", "kick.punchy", "kick.long", "kick.fullon"]);
  });

  it("gives every copy data and drops data, names and selections of unknown variants", () => {
    const ws = normalize({
      lists: { lead: ["lead.acid~1"] },
      names: { "lead.acid~1": "  Mi ácido  ", "lead.acid~9": "ghost", "lead.arp": "" },
      variants: { "lead.acid~9": {}, "perc.hat": { level: 9 } },
      auto: ["lead.acid~1", "lead.arp"],
      active: { "lead.acid~1": "lead.acid~1", kick: "kick.long", bass: "kick.tok", "fx.riser": "fx.riser" },
    });
    expect(ws.variants["lead.acid~1"]).toEqual(defaultData("lead.acid"));
    expect(ws.variants["lead.acid~9"]).toBeUndefined();
    expect(ws.variants["perc.hat"].level).toBe(1.5);
    expect(ws.names).toEqual({ "lead.acid~1": "Mi ácido" });
    expect(ws.auto).toEqual(["lead.acid~1"]);
    expect(ws.active).toEqual({ "lead.acid~1": "lead.acid~1", kick: "kick.long" });
  });

  it("keeps snapshots that still play something, with sanitized data", () => {
    const ws = normalize({
      lists: { lead: ["lead.acid~1"] },
      snapshots: [
        {
          id: "snap-2",
          name: "  Pico fuerte ",
          section: "peak",
          active: { kick: "kick.long", "lead.acid~9": "lead.acid~9", bass: "kick.tok" },
          data: { "kick.long": { level: 9 } },
        },
        { id: "snap-2", active: { kick: "kick.tok" } }, // duplicate id
        { id: "snap-3", section: "nope", active: { "lead.acid~1": "lead.acid~1" } },
        { id: "snap-4", active: { "fx.riser": "fx.riser" } }, // nothing left
        { id: "mine", active: { kick: "kick.tok" } },
      ],
    });
    expect(ws.snapshots.map((s) => [s.id, s.name, s.section])).toEqual([
      ["snap-2", "Pico fuerte", "peak"],
      ["snap-3", "snap-3", "groove"],
    ]);
    expect(ws.snapshots[0].active).toEqual({ kick: "kick.long" });
    expect(ws.snapshots[0].data["kick.long"]).toEqual({ ...defaultData("kick.long"), level: 1.5 });
    expect(ws.snapshots[1].data).toEqual({ "lead.acid~1": defaultData("lead.acid") });
  });

  it("puts the snapshots panel last unless it was moved, and checks the ramp length", () => {
    expect(normalize({ order: ["snap", "pad"] }).order.slice(0, 2)).toEqual(["snap", "pad"]);
    expect(normalize({ rampBars: 16 }).rampBars).toBe(16);
    expect(normalize({ rampBars: 7 }).rampBars).toBe(8);
  });

  it("clamps the BPM and ignores non-booleans", () => {
    expect(normalize({ bpm: 300 }).bpm).toBe(180);
    expect(normalize({ bpm: "150" }).bpm).toBe(145);
    expect(normalize({ combine: "yes", quantize: false }).combine).toBe(false);
    expect(normalize({ quantize: false }).quantize).toBe(false);
  });
});

describe("presets", () => {
  it("round-trip through JSON", () => {
    const ws = normalize({ bpm: 160, lists: { pad: ["pad.air~1"] }, names: { "pad.air~1": "Brisa" } });
    expect(parsePreset(JSON.stringify(toPreset(ws)))).toEqual(ws);
  });

  it("reject anything that is not a psy-sampler preset", () => {
    expect(() => parsePreset("{}")).toThrow();
    expect(() => parsePreset("not json")).toThrow();
    expect(() => parsePreset('{"app":"other"}')).toThrow();
  });
});

describe("helpers", () => {
  it("copyId takes the first free number on the base", () => {
    expect(copyId("kick.punchy", [])).toBe("kick.punchy~1");
    expect(copyId("kick.punchy~1", ["kick.punchy~1", "kick.punchy~2"])).toBe("kick.punchy~3");
  });

  it("moveItem moves within bounds", () => {
    expect(moveItem(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], "c", -4)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
  });
});
