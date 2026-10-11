import { describe, expect, it } from "vitest";
import { bytesOf, wav16, ramp, zip } from "../test/audioFiles.js";
import { TooBig } from "./bytes.js";
import { isZip, zipEntries } from "./zip.js";

const WAV = wav16([ramp(500)]);

describe("zipEntries", () => {
  it("lists files (not folders) and reads stored and deflated ones", async () => {
    const blob = new Blob([
      await zip([
        { name: "Pack/", data: "" },
        { name: "Pack/Kick.wav", data: WAV, deflate: true },
        { name: "Pack/Snare.wav", data: WAV },
      ]),
    ]);
    const entries = await zipEntries(blob);
    expect(entries.map((e) => [e.name, e.size])).toEqual([
      ["Pack/Kick.wav", WAV.length],
      ["Pack/Snare.wav", WAV.length],
    ]);
    for (const e of entries) expect(await e.read()).toEqual(WAV);
  });

  it("decodes names: the UTF-8 flag, UTF-8 without it (macOS), CP437 otherwise", async () => {
    const entries = await zipEntries(
      new Blob([
        await zip([
          { name: "Bombo ñ.wav", data: "x", utf8: true },
          { name: "Caja é.wav", data: "x" },
          { rawName: bytesOf("Tom ", [0xa4], ".wav"), data: "x" }, // ñ in CP437
        ]),
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(["Bombo ñ.wav", "Caja é.wav", "Tom ñ.wav"]);
  });

  it("marks what it can't read, and caps what it inflates", async () => {
    const entries = await zipEntries(
      new Blob([
        await zip([
          { name: "secret.wav", data: WAV, encrypted: true },
          { name: "lzma.wav", data: WAV, method: 14 },
          { name: "big.wav", data: WAV, deflate: true },
        ]),
      ]),
    );
    expect(entries.map((e) => e.problem ?? null)).toEqual(["encrypted", "method", null]);
    await expect(entries[0].read()).rejects.toThrow("encrypted");
    await expect(entries[2].read(100)).rejects.toBeInstanceOf(TooBig);
  });

  it("knows a zip by its first bytes, and refuses what isn't one", async () => {
    expect(isZip(await zip([]))).toBe(true);
    expect(isZip(WAV)).toBe(false);
    await expect(zipEntries(new Blob([WAV]))).rejects.toThrow();
  });
});
