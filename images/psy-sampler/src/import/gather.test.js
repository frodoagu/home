import { describe, expect, it } from "vitest";
import { aiff, bytesOf, gzip, ramp, soundfont, wav16, zip } from "../test/audioFiles.js";
import { MAX_CANDIDATES, gather, looksLikeAudio, universal } from "./gather.js";

const WAV = wav16([ramp(100)]);
const picked = (bytes, name) => ({ file: new File([bytes], name), path: name });
const inFolder = (bytes, path) => ({ file: new File([bytes], path.split("/").pop()), path });

const SET = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" Creator="Ableton Live 12.0">
  <AudioClip><SampleRef><FileRef><RelativePath Value="Samples/Imported/Amen.wav" /></FileRef></SampleRef></AudioClip>
  <MultiSamplePart><Name Value="Kick" /><SampleStart Value="0" /><SampleEnd Value="50" />
    <SampleRef><FileRef><RelativePath Value="Samples/Imported/Amen.wav" /></FileRef><DefaultDuration Value="100" /><DefaultSampleRate Value="48000" /></SampleRef>
  </MultiSamplePart>
  <MultiSamplePart><Name Value="Kick" /><SampleStart Value="50" /><SampleEnd Value="99" />
    <SampleRef><FileRef><RelativePath Value="Samples/Imported/Amen.wav" /></FileRef><DefaultDuration Value="100" /><DefaultSampleRate Value="48000" /></SampleRef>
  </MultiSamplePart>
  <AudioClip><SampleRef><FileRef><RelativePath Value="Samples/Recorded/Vox.wav" /></FileRef></SampleRef></AudioClip>
  <AudioClip><SampleRef><FileRef><Path Value="/Users/x/Library/Clap.aif" /></FileRef></SampleRef></AudioClip>
</Ableton>`;

describe("gather", () => {
  it("loose files: one candidate per audio file, loaded on demand", async () => {
    const out = await gather([picked(WAV, "Kick 909.wav"), picked(aiff([ramp(10)]), "Loop.aif"), picked(WAV, "noext")]);
    expect(out.candidates.map((c) => [c.name, c.origin])).toEqual([
      ["Kick 909", "Kick 909.wav"],
      ["Loop", "Loop.aif"],
      ["noext", "noext"],
    ]);
    expect((await out.candidates[0].load()).bytes).toEqual(WAV);
    expect(out).toMatchObject({ projects: [], missing: [], closed: [], unreadable: [], more: 0 });
  });

  it("an Ableton project folder: what the set uses first (slices included), what's missing, clutter skipped", async () => {
    const out = await gather([
      inFolder(await gzip(SET), "Song Project/Song.als"),
      inFolder(await gzip(SET.replace("Vox", "Old")), "Song Project/Backup/Song [2024-01-01 120000].als"),
      inFolder(WAV, "Song Project/Samples/Imported/Amen.wav"),
      inFolder(new Uint8Array(10), "Song Project/Samples/Imported/Amen.wav.asd"),
      inFolder(WAV, "Song Project/Samples/Recorded/Vox.wav"),
      inFolder(WAV, "Song Project/Samples/Processed/Freeze/Freeze Bass.wav"),
      inFolder(new Uint8Array(10), "Song Project/Ableton Project Info/AProject.ico"),
      inFolder(new Uint8Array(10), "Song Project/.DS_Store"),
    ]);
    expect(out.candidates.map((c) => [c.name, c.used, c.region ?? null])).toEqual([
      ["Amen", true, null],
      ["Kick 1", true, { start: 0, end: 50, rate: 48000 }],
      ["Kick 2", true, { start: 50, end: 99, rate: 48000 }],
      ["Vox", true, null],
      ["Freeze Bass", false, null],
    ]);
    expect(out.projects).toEqual([{ name: "Song Project/Song.als", app: "Ableton Live", refs: 5, found: 4 }]);
    expect(out.missing).toEqual(["Clap.aif"]);
    expect(out.unreadable).toEqual([]);
  });

  it("a reference picks the file whose folders match it best", async () => {
    const out = await gather([
      inFolder(await gzip(SET), "P/Song.als"),
      inFolder(WAV, "P/Other/Amen.wav"),
      inFolder(wav16([ramp(7)]), "P/Samples/Imported/Amen.wav"),
    ]);
    expect(out.candidates.filter((c) => c.used && !c.region).map((c) => c.origin)).toEqual(["P/Samples/Imported/Amen.wav"]);
  });

  it("archives open up: nested zips, SoundFonts inside, junk and locked entries", async () => {
    const inner = await zip([{ name: "Hats/Hat.wav", data: WAV }]);
    const sf2 = soundfont([{ name: "Bell", data: Int16Array.from(ramp(20)) }]);
    const pack = await zip([
      { name: "Pack/Kicks/Kick.wav", data: WAV, deflate: true },
      { name: "Pack/More.zip", data: inner },
      { name: "Pack/Bank.sf2", data: sf2, deflate: true },
      { name: "Pack/Locked.wav", data: WAV, encrypted: true },
      { name: "__MACOSX/Pack/Kicks/._Kick.wav", data: "junk" },
      { name: "Pack/License.pdf", data: "%PDF" },
    ]);
    const out = await gather([picked(pack, "Pack.zip")]);
    expect(out.candidates.map((c) => c.origin)).toEqual(["Pack.zip/Pack/Kicks/Kick.wav", "Pack.zip/Pack/More.zip/Hats/Hat.wav", "Pack.zip/Pack/Bank.sf2 › Bell"]);
    expect((await out.candidates[0].load()).bytes).toEqual(WAV);
    expect((await out.candidates[2].load()).pcm.channels[0]).toHaveLength(20);
    expect(out.unreadable).toEqual([{ name: "Pack.zip/Pack/Locked.wav", why: "encrypted" }]);
  });

  it("closed formats are named; non-audio picked by hand is unreadable", async () => {
    const out = await gather([picked(new Uint8Array(40), "Break.rx2"), picked(new Uint8Array(40), "Kit.nki"), picked(bytesOf("hello"), "notes.txt")]);
    expect(out.candidates).toEqual([]);
    expect(out.closed).toEqual([
      { name: "Break.rx2", app: "ReCycle (REX)" },
      { name: "Kit.nki", app: "Kontakt" },
    ]);
    expect(out.unreadable).toEqual([{ name: "notes.txt", why: "format" }]);
  });

  it("stops listing at MAX_CANDIDATES", async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 3 }, (_, i) => inFolder(WAV, `Lib/${i}.wav`));
    const out = await gather(many);
    expect(out.candidates).toHaveLength(MAX_CANDIDATES);
    expect(out.more).toBe(3);
  });
});

describe("formats", () => {
  it("looksLikeAudio knows containers by their first bytes", () => {
    expect(looksLikeAudio(WAV)).toBe(true);
    expect(looksLikeAudio(aiff([[0]]))).toBe(true);
    expect(looksLikeAudio(bytesOf("OggS", new Uint8Array(8)))).toBe(true);
    expect(looksLikeAudio(bytesOf("%PDF-1.7", new Uint8Array(8)))).toBe(false);
  });

  it("universal: what every browser decodes is stored as it came", () => {
    expect(universal(WAV)).toBe(true);
    expect(universal(bytesOf("fLaC", new Uint8Array(8)))).toBe(true);
    expect(universal(bytesOf("ID3", new Uint8Array(8)))).toBe(true);
    expect(universal(bytesOf([0, 0, 0, 0x20], "ftypM4A ", "....mp4a"))).toBe(true);
    expect(universal(bytesOf([0, 0, 0, 0x20], "ftypM4A ", "....alac"))).toBe(false);
    expect(universal(aiff([[0]]))).toBe(false);
    expect(universal(bytesOf("OggS", new Uint8Array(8)))).toBe(false);
  });
});
