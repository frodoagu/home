import { describe, expect, it } from "vitest";
import { defaultData } from "./audio/patterns.js";
import {
  addPart,
  capture,
  countBar,
  freshName,
  nextSnapId,
  nextSnapshot,
  partsOf,
  removePart,
  sameSnapshot,
  skipTour,
  startTour,
  tourDue,
  tourLeft,
} from "./snapshots.js";

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

describe("the snapshot autopilot", () => {
  const list = [{ id: "snap-1" }, { id: "snap-4" }, { id: "snap-2" }];

  // Bar lines from `tour` on, alternating steps from `step`, until it moves on.
  function barsUntilDue(tour, step, changeBars) {
    let t = tour;
    for (let n = 1; n < 100; n++) {
      step = 16 - step;
      t = countBar(t, step);
      expect(tourLeft(t, changeBars)).toBeGreaterThanOrEqual(1);
      if (tourDue(t, step, changeBars)) return n;
    }
    throw new Error("never moves on");
  }

  it("goes through the list in panel order, round again", () => {
    expect(nextSnapshot(list, startTour(list, "snap-1")).id).toBe("snap-4");
    expect(nextSnapshot(list, startTour(list, "snap-4")).id).toBe("snap-2");
    expect(nextSnapshot(list, startTour(list, "snap-2")).id).toBe("snap-1");
  });

  it("with its snapshot gone, the one that took its place is next; none left, nothing", () => {
    const tour = startTour(list, "snap-4");
    expect(nextSnapshot([list[0], list[2]], tour).id).toBe("snap-2");
    expect(nextSnapshot([list[0], list[1]], startTour(list, "snap-2")).id).toBe("snap-1");
    expect(nextSnapshot([], tour)).toBeNull();
  });

  it("moves on on a loop start once it played the bars, counted from where it came in", () => {
    for (const bars of [2, 4, 8, 16, 32]) {
      expect(barsUntilDue(startTour(list, "snap-1", 0), 0, bars)).toBe(bars);
      expect(barsUntilDue(startTour(list, "snap-1", 16), 16, bars)).toBe(bars + 1); // in mid-loop: one more
    }
  });

  it("counts from the first bar line when started outside one", () => {
    const tour = startTour(list, "snap-1");
    expect(tour.bars).toBeNull();
    expect(tourLeft(tour, 8)).toBe(8);
    const first = countBar(tour, 0);
    expect(first.bars).toBe(0);
    expect(tourDue(first, 0, 8)).toBe(false);
    expect(barsUntilDue(first, 0, 8)).toBe(8);
  });

  it("tells the bars left as they go", () => {
    let tour = startTour(list, "snap-1", 0);
    const left = [tourLeft(tour, 4)];
    for (const step of [16, 0, 16]) {
      tour = countBar(tour, step);
      left.push(tourLeft(tour, 4));
    }
    expect(left).toEqual([4, 3, 2, 1]);
    expect(tourLeft(startTour(list, "snap-1", 16), 4)).toBe(5);
  });

  it("⏭ moves on on the next loop start", () => {
    const tour = skipTour(startTour(list, "snap-1", 0));
    expect(tourLeft(tour, 16)).toBe(2);
    expect(barsUntilDue(tour, 0, 16)).toBe(2);
    expect(barsUntilDue(skipTour(startTour(list, "snap-1", 16)), 16, 16)).toBe(1);
  });

  it("a shorter Cambios applies to the snapshot playing", () => {
    let tour = startTour(list, "snap-1", 0);
    for (const step of [16, 0, 16, 0, 16]) tour = countBar(tour, step); // 5 bars in, mid-loop
    expect(tourLeft(tour, 2)).toBe(1);
    expect(tourDue(countBar(tour, 0), 0, 2)).toBe(true);
  });
});
