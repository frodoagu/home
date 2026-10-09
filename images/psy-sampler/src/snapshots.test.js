import { describe, expect, it } from "vitest";
import { defaultData } from "./audio/patterns.js";
import { addPart, capture, freshName, nextSnapId, partsOf, removePart, sameSnapshot } from "./snapshots.js";

const data = (id) => ({ ...defaultData(id), level: 0.5 });

describe("capture", () => {
  it("freezes the lanes and the data each variant plays", () => {
    const snap = capture({ bass: "bass.gallop", "perc.hat": "perc.hat" }, data);
    expect(snap.active).toEqual({ bass: "bass.gallop", "perc.hat": "perc.hat" });
    expect(snap.data["bass.gallop"]).toEqual(data("bass.gallop"));
    expect(snap.data["perc.hat"]).not.toBe(data("perc.hat"));
  });

  it("turns the background kick into the kick it is", () => {
    const snap = capture({ bass: "bass.offbeat", bgKick: "kick.punchy" }, defaultData);
    expect(snap.active).toEqual({ bass: "bass.offbeat", kick: "kick.punchy" });
    expect(Object.keys(snap.data)).toEqual(["bass.offbeat", "kick.punchy"]);
  });
});

describe("parts", () => {
  const snap = { id: "snap-1", name: "A", section: "peak", ...capture({ kick: "kick.long", "lead.acid": "lead.acid" }, defaultData) };

  it("adding on an exclusive layer replaces the variant there, stacking layers add", () => {
    const kick = addPart(snap, "kick.tok", data("kick.tok"));
    expect(kick.active).toEqual({ kick: "kick.tok", "lead.acid": "lead.acid" });
    expect(Object.keys(kick.data).sort()).toEqual(["kick.tok", "lead.acid"]);
    expect(kick.data["kick.tok"].level).toBe(0.5);
    expect(partsOf(addPart(snap, "lead.arp", data("lead.arp")))).toEqual(["kick.long", "lead.acid", "lead.arp"]);
  });

  it("removing drops the lane and its data", () => {
    const out = removePart(snap, "kick.long");
    expect(out.active).toEqual({ "lead.acid": "lead.acid" });
    expect(Object.keys(out.data)).toEqual(["lead.acid"]);
    expect(snap.active.kick).toBe("kick.long"); // untouched
  });

  it("partsOf lists them in layer order", () => {
    const mixed = capture({ "pad.air": "pad.air", bass: "bass.gallop", kick: "kick.long" }, defaultData);
    expect(partsOf(mixed)).toEqual(["kick.long", "bass.gallop", "pad.air"]);
  });

  it("sameSnapshot compares name, section and parts", () => {
    expect(sameSnapshot(snap, structuredClone(snap))).toBe(true);
    expect(sameSnapshot(snap, { ...snap, section: "intro" })).toBe(false);
    expect(sameSnapshot(snap, removePart(snap, "lead.acid"))).toBe(false);
  });
});

describe("ids and names", () => {
  it("nextSnapId goes past the highest one", () => {
    expect(nextSnapId([])).toBe("snap-1");
    expect(nextSnapId([{ id: "snap-4" }, { id: "snap-2" }])).toBe("snap-5");
  });

  it("freshName numbers a repeated name", () => {
    expect(freshName("Pico", [])).toBe("Pico");
    expect(freshName("Pico", ["Pico", "Pico 2"])).toBe("Pico 3");
  });
});
