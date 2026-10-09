import { describe, expect, it } from "vitest";
import { seeded } from "./editing.js";
import { normalize } from "./workspace.js";
import { cleanSeed, hashSeed, packSounds, randomSeed, readFragment, shareFragment, unpackSounds } from "./share.js";

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
  it("carry only seed and BPM with factory sounds", async () => {
    const ws = { ...normalize({ bpm: 150 }), seed: "abc" };
    expect(await shareFragment(ws)).toBe("#seed=abc&bpm=150");
    expect(readFragment("#seed=abc&bpm=150")).toEqual({ seed: "abc", bpm: 150, sounds: null });
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

  it("ignore fragments without a seed", () => {
    expect(readFragment("")).toBeNull();
    expect(readFragment("#bpm=150")).toBeNull();
    expect(readFragment("#seed=x&bpm=nope").bpm).toBeNull();
  });
});
