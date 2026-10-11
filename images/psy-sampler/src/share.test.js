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
  unpackSnap,
  unpackSounds,
} from "./share.js";

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
    expect(readFragment("#seed=abc&style=goa&bpm=150")).toEqual({ seed: "abc", style: "goa", bpm: 150, sounds: null });
  });

  it("leave out what the autopilot wrote: the seed writes it again", async () => {
    const ws = { ...normalize({ variants: { "kick.punchy": { level: 0.5 } }, auto: ["kick.punchy"] }), seed: "s" };
    expect(await shareFragment(ws)).not.toContain("&s=");
    const mine = { ...ws, variants: { ...ws.variants, "perc.hat": { ...ws.variants["kick.punchy"] } } };
    expect(Object.keys((await unpackSounds(await packSounds(mine))).variants)).toEqual(["perc.hat"]);
  });

  it("carry edited and duplicated sounds, compressed", async () => {
    const ws = {
      ...normalize({
        lists: { lead: ["lead.acid~1"] },
        names: { "lead.acid~1": "Mío ✓" },
        variants: { "perc.hat": { level: 0.5 } },
      }),
      seed: "s",
    };
    const fragment = await shareFragment(ws);
    const { sounds } = readFragment(fragment);
    expect(sounds).toMatch(/^[\w-]+$/);
    const back = await unpackSounds(sounds);
    expect(back.names).toEqual({ "lead.acid~1": "Mío ✓" });
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
