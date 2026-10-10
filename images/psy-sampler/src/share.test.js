import { describe, expect, it } from "vitest";
import { seeded } from "./editing.js";
import { normalize } from "./workspace.js";
import {
  SOUNDS_MAX,
  cleanSeed,
  hashSeed,
  packSounds,
  randomSeed,
  readFragment,
  shareFragment,
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
