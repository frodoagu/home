import { describe, expect, it } from "vitest";
import { zipEntries } from "./import/zip.js";
import { crc32, zipBlob } from "./zip.js";

const text = (s) => new Blob([new TextEncoder().encode(s)]);

describe("zip writer", () => {
  it("computes CRC-32", async () => {
    expect(await crc32(text("123456789"))).toBe(0xcbf43926);
    expect(await crc32(new Blob([]))).toBe(0);
  });

  it("stores the files, in order, under their (UTF-8) names, for the reader to read back", async () => {
    const zip = await zipBlob([
      { name: "set/01-kick.wav", blob: text("boom") },
      { name: "set/03-percusión.wav", blob: text("tss tss") },
    ]);
    expect(zip.type).toBe("application/zip");
    const entries = await zipEntries(zip);
    expect(entries.map((e) => [e.name, e.size, e.problem])).toEqual([
      ["set/01-kick.wav", 4, undefined],
      ["set/03-percusión.wav", 7, undefined],
    ]);
    expect(new TextDecoder().decode(await entries[1].read())).toBe("tss tss");
  });

  it("stamps the entries with the time it is given, in MS-DOS form", async () => {
    const zip = await zipBlob([{ name: "a", blob: text("x") }], new Date(2026, 9, 22, 21, 30, 14));
    const v = new DataView(await zip.slice(0, 30).arrayBuffer());
    expect(v.getUint16(10, true)).toBe((21 << 11) | (30 << 5) | 7);
    expect(v.getUint16(12, true)).toBe((46 << 9) | (10 << 5) | 22);
  });
});
