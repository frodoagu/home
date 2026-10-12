import { describe, expect, it } from "vitest";
import { gzip } from "../test/audioFiles.js";
import { abletonRefs, decentRefs, isProject, projectRefs, reaperRefs, sfzRefs } from "./projects.js";

// What Live 11/12 writes, trimmed to the parts that matter.
const LIVE12 = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="12.0_12049" SchemaChangeCount="7" Creator="Ableton Live 12.0.10" Revision="">
  <LiveSet>
    <AudioClip Id="0" Time="0">
      <Name Value="Break" />
      <SampleRef>
        <FileRef>
          <RelativePathType Value="3" />
          <RelativePath Value="Samples/Imported/Amen &amp; Co.wav" />
          <Path Value="C:/Users/fede/Music/Set Project/Samples/Imported/Amen &amp; Co.wav" />
          <Type Value="1" />
        </FileRef>
        <DefaultDuration Value="441000" />
        <DefaultSampleRate Value="44100" />
      </SampleRef>
    </AudioClip>
    <MultiSamplePart Id="0" HasImportedSlicePoints="false">
      <Name Value="Kick 1" />
      <RootKey Value="60" />
      <SampleStart Value="0" />
      <SampleEnd Value="22050" />
      <SampleRef>
        <FileRef>
          <RelativePath Value="Samples/Imported/Amen &amp; Co.wav" />
          <Path Value="" />
        </FileRef>
        <DefaultDuration Value="441000" />
        <DefaultSampleRate Value="44100" />
      </SampleRef>
    </MultiSamplePart>
    <MultiSamplePart Id="1">
      <Name Value="Clap" />
      <SampleStart Value="0" />
      <SampleEnd Value="9999" />
      <SampleRef>
        <FileRef>
          <RelativePath Value="" />
          <Path Value="/Users/fede/Music/Ableton/User Library/Samples/Clap.aif" />
        </FileRef>
        <DefaultDuration Value="10000" />
        <DefaultSampleRate Value="48000" />
      </SampleRef>
    </MultiSamplePart>
  </LiveSet>
</Ableton>`;

// Live 9/10: the path as RelativePathElements plus a Name.
const LIVE10 = `<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="5" MinorVersion="10.0_377" Creator="Ableton Live 10.1.30">
  <SampleRef>
    <FileRef>
      <HasRelativePath Value="true" />
      <RelativePath>
        <RelativePathElement Id="0" Dir="Samples" />
        <RelativePathElement Id="1" Dir="Recorded" />
      </RelativePath>
      <Name Value="1-Audio 0001 [2019-05-04 201517].aif" />
      <SearchHint><PathHint><RelativePathElement Id="0" Dir="Elsewhere" /></PathHint></SearchHint>
    </FileRef>
  </SampleRef>
</Ableton>`;

describe("Ableton Live", () => {
  it("Live 11/12: relative paths, else absolute ones; Simpler slices with their name", () => {
    expect(abletonRefs(LIVE12)).toEqual([
      { path: "Samples/Imported/Amen & Co.wav" },
      { path: "Samples/Imported/Amen & Co.wav", name: "Kick 1", region: { start: 0, end: 22050, rate: 44100 } },
      // The whole file (to the last frame) is no slice.
      { path: "/Users/fede/Music/Ableton/User Library/Samples/Clap.aif", name: "Clap" },
    ]);
  });

  it("Live 9/10: the path elements and the file name", () => {
    expect(abletonRefs(LIVE10)).toEqual([{ path: "Samples/Recorded/1-Audio 0001 [2019-05-04 201517].aif" }]);
  });

  it("reads a gzipped .als/.alc/.adg/.adv, and keeps only audio files", async () => {
    const found = await projectRefs("Set.als", await gzip(LIVE12.replace("Clap.aif", "Clap.nki")));
    expect(found.app).toBe("Ableton Live");
    expect(found.refs.map((r) => r.file)).toEqual(["Amen & Co.wav", "Amen & Co.wav"]);
    expect(await projectRefs("x.adv", await gzip("<?xml?><NotLive/>"))).toBeNull();
    expect(await projectRefs("bomb.als", Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2))).toBeNull();
  });
});

describe("other formats", () => {
  it("SFZ: sample= with spaces, under default_path=, comments out", () => {
    const sfz = `// a kit
<control> default_path=..\\Samples\\
<region> sample=Kick 01.wav lokey=36 hikey=36
<region> sample=Snare.flac
/* <region> sample=old.wav */`;
    expect(sfzRefs(sfz)).toEqual([{ path: "../Samples/Kick 01.wav" }, { path: "../Samples/Snare.flac" }]);
  });

  it("Decent Sampler and REAPER", () => {
    expect(decentRefs(`<DecentSampler><groups><group><sample path="Samples/Pad C3.wav" rootNote="48"/></group></groups></DecentSampler>`)).toEqual([
      { path: "Samples/Pad C3.wav" },
    ]);
    const rpp = `<REAPER_PROJECT 0.1 "7.0"
  <TRACK
    <ITEM
      <SOURCE WAVE
        FILE "Audio Files/Vox take 1.wav"
      >
    >
    <ITEM
      <SOURCE FLAC
        FILE C:\\Loops\\hat.flac
      >
    >
  >
>`;
    expect(reaperRefs(rpp)).toEqual([{ path: "Audio Files/Vox take 1.wav" }, { path: "C:/Loops/hat.flac" }]);
  });

  it("tells project files apart by extension, or by their first bytes", async () => {
    expect(isProject("Set.als")).toBe(true);
    expect(isProject("kit.SFZ")).toBe(true);
    expect(isProject("Kick.wav")).toBe(false);
    expect(isProject("mystery", Uint8Array.of(0x1f, 0x8b))).toBe(true);
    expect((await projectRefs("kit.sfz", new TextEncoder().encode("<region> sample=a.wav"))).app).toBe("SFZ");
  });
});
