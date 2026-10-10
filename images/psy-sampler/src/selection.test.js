import { describe, expect, it } from "vitest";
import { BG_KICK_VARIANT, desiredLanes, laneKey, pressVariant } from "./selection.js";

describe("pressVariant", () => {
  it("toggles variants across layers", () => {
    let a = pressVariant({}, "bass", "bass.rolling");
    a = pressVariant(a, "lead", "lead.acid");
    expect(a).toEqual({ bass: "bass.rolling", lead: "lead.acid" });
    expect(pressVariant(a, "lead", "lead.acid")).toEqual({ bass: "bass.rolling" });
  });

  it("keeps one variant per layer", () => {
    const a = pressVariant({ bass: "bass.rolling" }, "bass", "bass.offbeat");
    expect(a).toEqual({ bass: "bass.offbeat" });
  });

  it("does not mutate the previous state", () => {
    const prev = { bass: "bass.rolling" };
    pressVariant(prev, "lead", "lead.acid");
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
    let a = pressVariant({}, laneKey(perc, "perc.hat"), "perc.hat");
    a = pressVariant(a, laneKey(perc, "perc.clap"), "perc.clap");
    a = pressVariant(a, laneKey(kick, "kick.long"), "kick.long");
    a = pressVariant(a, laneKey(kick, "kick.tok"), "kick.tok");
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
