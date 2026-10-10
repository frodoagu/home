import { describe, expect, it } from "vitest";
import { BG_KICK_VARIANT, desiredLanes, isOn, laneKey, pressVariant } from "./selection.js";

const kick = { id: "kick", exclusive: true };
const bass = { id: "bass", exclusive: true };
const perc = { id: "perc" };
const lead = { id: "lead" };

describe("pressVariant", () => {
  it("toggles variants across layers", () => {
    let a = pressVariant({}, bass, "bass.rolling");
    a = pressVariant(a, lead, "lead.acid");
    expect(a).toEqual({ bass: "bass.rolling", "lead.acid": "lead.acid" });
    expect(pressVariant(a, lead, "lead.acid")).toEqual({ bass: "bass.rolling" });
  });

  it("keeps one variant per exclusive layer", () => {
    expect(pressVariant({ bass: "bass.rolling" }, bass, "bass.offbeat")).toEqual({ bass: "bass.offbeat" });
  });

  it("Ctrl stacks another on an exclusive layer, and a plain click leaves one again", () => {
    let a = pressVariant({ bass: "bass.offbeat" }, bass, "bass.rolling", true);
    a = pressVariant(a, bass, "bass.fm", true);
    expect(a).toEqual({ bass: "bass.offbeat", "bass.rolling": "bass.rolling", "bass.fm": "bass.fm" });
    expect(pressVariant(a, bass, "bass.rolling", true)).toEqual({ bass: "bass.offbeat", "bass.fm": "bass.fm" });
    expect(pressVariant(a, bass, "bass.rolling")).toEqual({ bass: "bass.offbeat", "bass.fm": "bass.fm" });
    expect(pressVariant({ ...a, kick: "kick.tok" }, bass, "bass.prog")).toEqual({ kick: "kick.tok", bass: "bass.prog" });
  });

  it("Ctrl on an empty exclusive layer, or a stacking one, is a plain click", () => {
    expect(pressVariant({}, kick, "kick.long", true)).toEqual({ kick: "kick.long" });
    expect(pressVariant({}, perc, "perc.hat", true)).toEqual({ "perc.hat": "perc.hat" });
  });

  it("does not mutate the previous state", () => {
    const prev = { bass: "bass.rolling" };
    pressVariant(prev, lead, "lead.acid");
    pressVariant(prev, bass, "bass.fm", true);
    expect(prev).toEqual({ bass: "bass.rolling" });
  });
});

describe("isOn", () => {
  it("finds a variant on any lane", () => {
    const a = { bass: "bass.offbeat", "bass.fm": "bass.fm" };
    expect([isOn(a, "bass.offbeat"), isOn(a, "bass.fm"), isOn(a, "bass.prog")]).toEqual([true, true, false]);
  });
});

describe("laneKey", () => {
  it("exclusive layers share one lane; the rest get one per variant", () => {
    expect(laneKey(kick, "kick.long")).toBe("kick");
    expect(laneKey(perc, "perc.hat")).toBe("perc.hat");
  });

  it("so percussion stacks while a second kick replaces the first", () => {
    let a = pressVariant({}, perc, "perc.hat");
    a = pressVariant(a, perc, "perc.clap");
    a = pressVariant(a, kick, "kick.long");
    a = pressVariant(a, kick, "kick.tok");
    expect(a).toEqual({ "perc.hat": "perc.hat", "perc.clap": "perc.clap", kick: "kick.tok" });
  });
});

describe("desiredLanes", () => {
  it("adds the background kick under other layers", () => {
    expect(desiredLanes({ bass: "bass.rolling" }, { bgKick: true })).toEqual({
      bass: "bass.rolling",
      bgKick: BG_KICK_VARIANT,
    });
  });

  it("never plays the background kick alone", () => {
    expect(desiredLanes({}, { bgKick: true })).toEqual({});
  });

  it("does not double a stacked kick either", () => {
    expect(desiredLanes({ "kick.tok": "kick.tok", bass: "bass.offbeat" }, { bgKick: true })).not.toHaveProperty("bgKick");
  });

  it("does not double a selected kick", () => {
    expect(desiredLanes({ kick: "kick.long", bass: "bass.offbeat" }, { bgKick: true })).toEqual({
      kick: "kick.long",
      bass: "bass.offbeat",
    });
  });

  it("respects the checkbox", () => {
    expect(desiredLanes({ pad: "pad.chord" }, { bgKick: false })).toEqual({ pad: "pad.chord" });
  });
});
