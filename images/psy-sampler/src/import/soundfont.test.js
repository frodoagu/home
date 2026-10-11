import { describe, expect, it } from "vitest";
import { ramp, soundfont, wav16 } from "../test/audioFiles.js";
import { isSoundfont, soundfontSamples } from "./soundfont.js";

const tone = (n, a) => Int16Array.from(ramp(n, a));

describe("soundfontSamples", () => {
  it("lists every sample and reads its 16-bit audio on demand", async () => {
    const sf = soundfont([
      { name: "Piano C4", data: tone(100, 16384), rate: 44100 },
      { name: "Kick", data: tone(50, 32767), rate: 22050 },
    ]);
    expect(isSoundfont(sf)).toBe(true);
    const list = await soundfontSamples(new Blob([sf]));
    expect(list.map((s) => [s.name, s.sampleRate, s.channelCount, s.frames])).toEqual([
      ["Piano C4", 44100, 1, 100],
      ["Kick", 22050, 1, 50],
    ]);
    const { pcm } = await list[0].load();
    expect(pcm.sampleRate).toBe(44100);
    expect(pcm.channels[0][0]).toBeCloseTo(-0.5, 4);
    expect(pcm.channels[0][99]).toBeCloseTo(0.5, 4);
  });

  it("joins a linked left/right pair into one stereo sample, named without the side", async () => {
    const list = await soundfontSamples(
      new Blob([
        soundfont([
          { name: "Strings R", data: tone(80, 1000), type: 2, link: 1 },
          { name: "Strings L", data: tone(80, 2000), type: 4, link: 0 },
          { name: "Lonely L", data: tone(10, 10), type: 4, link: 9 },
        ]),
      ]),
    );
    expect(list.map((s) => [s.name, s.channelCount])).toEqual([
      ["Strings", 2],
      ["Lonely L", 1],
    ]);
    const { pcm } = await list[0].load();
    expect(pcm.channels[0][0]).toBeCloseTo(-2000 / 32768, 6); // left first
    expect(pcm.channels[1][0]).toBeCloseTo(-1000 / 32768, 6);
  });

  it("adds sm24's low bytes in a 24-bit bank, and skips ROM samples", async () => {
    const data = Int16Array.of(0x100, -2, 0);
    // sm24 runs alongside smpl, one byte per frame (46 padding frames after each sample).
    const sm24 = new Uint8Array(2 * (3 + 46));
    sm24[0] = 0x80;
    const list = await soundfontSamples(new Blob([soundfont([{ name: "Hi", data }, { name: "Rom", data, type: 0x8001 }], { sm24 })]));
    expect(list).toHaveLength(1);
    const { pcm } = await list[0].load();
    expect(pcm.channels[0][0]).toBe((0x100 * 256 + 0x80) / 8388608);
  });

  it("SF3: compressed samples come out as their own bytes, even without pad bytes", async () => {
    const ogg = Uint8Array.from("OggS-not-really", (c) => c.charCodeAt(0));
    const list = await soundfontSamples(new Blob([soundfont([{ name: "Gun", ogg, type: 0x11, rate: 11025 }], { pad: false })]));
    expect(list.map((s) => [s.name, s.sampleRate])).toEqual([["Gun", 11025]]);
    expect((await list[0].load()).bytes).toEqual(ogg);
  });

  it("refuses what isn't a SoundFont", async () => {
    expect(isSoundfont(wav16([[0]]))).toBe(false);
    await expect(soundfontSamples(new Blob([wav16([[0]])]))).rejects.toThrow();
  });
});
