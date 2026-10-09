import { describe, expect, it } from "vitest";
import { BG_KICK_VARIANT, desiredLanes, laneKey, pressVariant } from "./selection.js";

describe("pressVariant · solo", () => {
  it("replaces whatever was active", () => {
    const a = pressVariant({}, "bass", "bass.rolling", false);
    expect(a).toEqual({ bass: "bass.rolling" });
    expect(pressVariant(a, "lead", "lead.acid", false)).toEqual({ lead: "lead.acid" });
  });

  it("turns the lone active variant off when clicked again", () => {
    expect(pressVariant({ bass: "bass.rolling" }, "bass", "bass.rolling", false)).toEqual({});
  });

  it("collapses a combined set to the clicked variant", () => {
    const combined = { bass: "bass.rolling", lead: "lead.acid" };
    expect(pressVariant(combined, "lead", "lead.acid", false)).toEqual({ lead: "lead.acid" });
  });
});

describe("pressVariant · combine", () => {
  it("toggles variants across layers", () => {
    let a = pressVariant({}, "bass", "bass.rolling", true);
    a = pressVariant(a, "lead", "lead.acid", true);
    expect(a).toEqual({ bass: "bass.rolling", lead: "lead.acid" });
    expect(pressVariant(a, "lead", "lead.acid", true)).toEqual({ bass: "bass.rolling" });
  });

  it("keeps one variant per layer", () => {
    const a = pressVariant({ bass: "bass.rolling" }, "bass", "bass.offbeat", true);
    expect(a).toEqual({ bass: "bass.offbeat" });
  });

  it("does not mutate the previous state", () => {
    const prev = { bass: "bass.rolling" };
    pressVariant(prev, "lead", "lead.acid", true);
    expect(prev).toEqual({ bass: "bass.rolling" });
  });
});

describe("laneKey", () => {
  const kick = { id: "kick", exclusive: true };
  const perc = { id: "perc" };

  it("exclusive layers share one lane; the rest get one per variant", () => {
    expect(laneKey(kick, "kick.long")).toBe("kick");
    expect(laneKey(perc, "perc.hat")).toBe("perc.hat");
  });

  it("so percussion stacks while a second kick replaces the first", () => {
    let a = pressVariant({}, laneKey(perc, "perc.hat"), "perc.hat", true);
    a = pressVariant(a, laneKey(perc, "perc.clap"), "perc.clap", true);
    a = pressVariant(a, laneKey(kick, "kick.long"), "kick.long", true);
    a = pressVariant(a, laneKey(kick, "kick.tok"), "kick.tok", true);
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
