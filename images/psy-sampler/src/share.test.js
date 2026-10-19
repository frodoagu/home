import { describe, expect, it } from "vitest";
import { seeded } from "./editing.js";
import { importSnapshots, normalize } from "./workspace.js";
import {
  SOUNDS_MAX,
  cleanSeed,
  hashSeed,
  packSounds,
  randomSeed,
  readFragment,
  readSnapFragment,
  shareFragment,
  snapFragment,
  unpackPlans,
  unpackSnap,
  unpackSounds,
} from "./share.js";
import { PLAN_MAX } from "./planner.js";

describe("seeds", () => {
  it("hash deterministically, and differ from each other", () => {
    expect(hashSeed("goa")).toBe(hashSeed("goa"));
    expect(hashSeed("goa")).not.toBe(hashSeed("goa2"));
    expect(hashSeed("")).toBe(0x811c9dc5);
  });

  it("random seeds are short and unambiguous", () => {
    const s = randomSeed(seeded(3));
    expect(s).toMatch(/^[a-z2-9]{6}$/);
    expect(s).not.toMatch(/[01ilo]/);
  });

  it("cleanSeed trims and bounds", () => {
    expect(cleanSeed("  hola ")).toBe("hola");
    expect(cleanSeed("x".repeat(50))).toHaveLength(32);
    expect(cleanSeed(null)).toBe("");
    expect(cleanSeed(42)).toBe("");
  });
});

describe("share links", () => {
  it("carry only seed, style and BPM with factory sounds", async () => {
    const ws = { ...normalize({ bpm: 150, style: "goa" }), seed: "abc" };
    expect(await shareFragment(ws)).toBe("#seed=abc&style=goa&bpm=150");
    expect(readFragment("#seed=abc&style=goa&bpm=150")).toEqual({
      seed: "abc",
      style: "goa",
      bpm: 150,
      key: 9,
      sounds: null,
      plans: null,
      opening: null,
    });
  });

  it("carry the key when it is not A, and read a missing or broken one as A", async () => {
    const ws = { ...normalize({ bpm: 150, style: "goa", key: 6 }), seed: "abc" };
    const hash = await shareFragment(ws);
    expect(hash).toBe("#seed=abc&style=goa&bpm=150&key=6");
    expect(readFragment(hash).key).toBe(6);
    expect(readFragment("#seed=abc&key=0").key).toBe(0);
    expect(readFragment("#seed=abc").key).toBe(9);
    expect(readFragment("#seed=abc&key=").key).toBe(9);
    expect(readFragment("#seed=abc&key=12").key).toBe(9);
    expect(readFragment("#seed=abc&key=2.5").key).toBe(9);
  });

  it("carry the plans the ✨ AI made, one per section, and only when there are some", async () => {
    const ws = { ...normalize({ style: "goa" }), seed: "abc" };
    expect(await shareFragment(ws, [])).toBe("#seed=abc&style=goa&bpm=145");
    expect(await shareFragment(ws, [null, undefined])).toBe("#seed=abc&style=goa&bpm=145");
    const plan = { section: "peak", bars: 16, layers: { kick: ["kick.long"] } };
    const plans = [];
    plans[2] = plan; // sections 0 and 1 had none
    const fragment = await shareFragment(ws, plans);
    const read = readFragment(fragment);
    expect(read.plans).toMatch(/^[\w-]+$/);
    expect(await unpackPlans(read.plans)).toEqual([null, null, plan]);
  });

  it("refuse plans that are not a list, and keep at most PLAN_MAX", async () => {
    const deflate = async (value) => {
      const out = new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("deflate-raw")));
      const bin = String.fromCharCode(...new Uint8Array(await out.arrayBuffer()));
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    await expect(unpackPlans(await deflate({ section: "peak" }))).rejects.toThrow("not a list");
    await expect(unpackPlans("%%%")).rejects.toThrow();
    const many = Array.from({ length: PLAN_MAX + 10 }, () => ({ section: "groove" }));
    expect(await unpackPlans(await deflate(many))).toHaveLength(PLAN_MAX);
    expect(await unpackPlans(await deflate([1, "x", [], { section: "peak" }]))).toEqual([null, null, null, { section: "peak" }]);
  });

  it("leave out what the autopilot wrote: the seed writes it again", async () => {
    const ws = { ...normalize({ variants: { "kick.punchy": { level: 0.5 } }, auto: ["kick.punchy"] }), seed: "s" };
    expect(await shareFragment(ws)).not.toContain("&s=");
    const mine = { ...ws, variants: { ...ws.variants, "perc.hat": { ...ws.variants["kick.punchy"] } } };
    expect(Object.keys((await unpackSounds(await packSounds(mine))).variants)).toEqual(["perc.hat"]);
  });

  it("carry the user's descriptions of the sounds, which the ✨ AI picks by", async () => {
    const ws = { ...normalize({ descriptions: { "pad.air": "wind" } }), seed: "s" };
    const { sounds } = readFragment(await shareFragment(ws));
    expect((await unpackSounds(sounds)).descriptions).toEqual({ "pad.air": "wind" });
  });

  it("carry the sounds banned from the autopilot, since they change what a seed plays", async () => {
    const ws = { ...normalize({ banned: ["lead.acid"] }), seed: "s" };
    const { sounds } = readFragment(await shareFragment(ws));
    expect((await unpackSounds(sounds)).banned).toEqual(["lead.acid"]);
  });

  it("carry edited and duplicated sounds, compressed", async () => {
    const ws = {
      ...normalize({
        lists: { lead: ["lead.acid~1"] },
        names: { "lead.acid~1": "Mío ✓" },
        descriptions: { "lead.acid~1": "oscuro" },
        variants: { "perc.hat": { level: 0.5 } },
      }),
      seed: "s",
    };
    const fragment = await shareFragment(ws);
    const { sounds } = readFragment(fragment);
    expect(sounds).toMatch(/^[\w-]+$/);
    const back = await unpackSounds(sounds);
    expect(back.names).toEqual({ "lead.acid~1": "Mío ✓" });
    expect(back.descriptions).toEqual({ "lead.acid~1": "oscuro" });
    expect(back.variants["perc.hat"].level).toBe(0.5);
    expect(back.lists.lead).toContain("lead.acid~1");
    expect(await unpackSounds(await packSounds(ws))).toEqual(back);
  });

  it("refuse sounds that inflate past the cap", async () => {
    const deflate = async (text) => {
      const out = new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw")));
      const bin = String.fromCharCode(...new Uint8Array(await out.arrayBuffer()));
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const bomb = await deflate(`{"app":"psy-sampler","x":"${"a".repeat(SOUNDS_MAX)}"}`);
    expect(bomb.length).toBeLessThan(2000);
    await expect(unpackSounds(bomb)).rejects.toThrow("too big");
    const ws = normalize({ variants: { "perc.hat": { level: 0.5 } } });
    const sounds = await packSounds(ws);
    await expect(unpackSounds(sounds, 100)).rejects.toThrow("too big");
    expect((await unpackSounds(sounds)).variants["perc.hat"].level).toBe(0.5);
  });

  it("ignore fragments without a seed", () => {
    expect(readFragment("")).toBeNull();
    expect(readFragment("#bpm=150")).toBeNull();
    expect(readFragment("#seed=x&bpm=nope").bpm).toBeNull();
  });
});

describe("snapshot links", () => {
  const ws = normalize({
    lists: { lead: ["lead.acid~1"] },
    names: { "lead.acid~1": "Mía", "lead.arp~1": "Otra" },
    snapshots: [
      { id: "snap-1", name: "Pico", section: "peak", active: { kick: "kick.long" }, data: { "kick.long": { level: 0.5 } } },
      { id: "snap-2", name: "Break", section: "breakdown", active: { "lead.acid~1": "lead.acid~1" } },
    ],
  });

  it("carry one snapshot and the names of the copies it plays, nothing else", async () => {
    const fragment = await snapFragment(ws, ws.snapshots[1]);
    expect(fragment).toMatch(/^#snap=[\w-]+$/);
    expect(readFragment(fragment)).toBeNull(); // not a seed link
    const file = JSON.parse(await unpackSnap(readSnapFragment(fragment)));
    expect(file).toMatchObject({ app: "psy-sampler", kind: "snapshots", names: { "lead.acid~1": "Mía" } });
    expect(file.snapshots).toEqual([ws.snapshots[1]]);
  });

  it("open as an import: added after the ones there, once", async () => {
    const text = await unpackSnap(readSnapFragment(await snapFragment(ws, ws.snapshots[0])));
    const into = normalize({ snapshots: [ws.snapshots[1]], lists: ws.lists, names: ws.names });
    const once = importSnapshots(into, text);
    expect(once.added).toBe(1);
    expect(once.ws.snapshots.at(-1)).toMatchObject({ id: "snap-3", name: "Pico", data: { "kick.long": { level: 0.5 } } });
    expect(importSnapshots(once.ws, text).added).toBe(0);
  });

  it("refuse one that inflates past the cap, and ignore other fragments", async () => {
    const packed = readSnapFragment(await snapFragment(ws, ws.snapshots[0]));
    await expect(unpackSnap(packed, 50)).rejects.toThrow("too big");
    expect(readSnapFragment("#seed=x")).toBeNull();
    expect(readSnapFragment("#snap=")).toBeNull();
    expect(readSnapFragment(null)).toBeNull();
  });
});
