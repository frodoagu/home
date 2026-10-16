import { describe, expect, it } from "vitest";
import { importMidi, isMidi, readMidi, toPart } from "./midi.js";

const u16 = (n) => [n >> 8, n & 0xff];
const u32 = (n) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const text = (s) => [...new TextEncoder().encode(s)];
function varlen(n) {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const chunk = (tag, data) => [...text(tag), ...u32(data.length), ...data];

// A Standard MIDI File: each track is a list of [delta ticks, ...event bytes].
function smf(tracks, { ppq = 96, format = 1 } = {}) {
  const head = chunk("MThd", [...u16(format), ...u16(tracks.length), ...u16(ppq)]);
  const body = tracks.flatMap((events) =>
    chunk("MTrk", [...events.flatMap(([delta, ...bytes]) => [...varlen(delta), ...bytes]), 0, 0xff, 0x2f, 0]),
  );
  return Uint8Array.from([...head, ...body]);
}
const on = (delta, key, vel = 100, ch = 0) => [delta, 0x90 | ch, key, vel];
const off = (delta, key, ch = 0) => [delta, 0x80 | ch, key, 64];
const name = (s) => [0, 0xff, 0x03, ...varlen(text(s).length), ...text(s)];

describe("readMidi", () => {
  it("reads notes in beats, whatever the tempo, with the track's name", () => {
    const tempo = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20];
    const file = smf([[name("Lead"), tempo, on(0, 57), off(48, 57), on(48, 60, 120), off(96, 60)]]);
    expect(isMidi(file)).toBe(true);
    expect(readMidi(file)).toEqual([
      {
        name: "Lead",
        notes: [
          { beat: 0, beats: 0.5, midi: 57, vel: 100 },
          { beat: 1, beats: 1, midi: 60, vel: 120 },
        ],
      },
    ]);
  });

  it("follows running status, and reads a note-on at velocity 0 as its end", () => {
    const file = smf([[[0, 0x90, 64, 90], [24, 64, 0], [0, 67, 90], [24, 67, 0]]]);
    expect(readMidi(file)[0].notes).toEqual([
      { beat: 0, beats: 0.25, midi: 64, vel: 90 },
      { beat: 0.25, beats: 0.25, midi: 67, vel: 90 },
    ]);
  });

  it("skips controllers, programs and sysex, and ends a held note with its track", () => {
    const file = smf([[[0, 0xc0, 5], [0, 0xb0, 7, 100], [0, 0xf0, 2, 0x7e, 0xf7], on(0, 50), [192, 0xff, 0x01, 1, 65]]]);
    expect(readMidi(file)[0].notes).toEqual([{ beat: 0, beats: 2, midi: 50, vel: 100 }]);
  });

  it("is null for anything else: another format, SMPTE time, a broken track", () => {
    expect(readMidi(Uint8Array.from(text("RIFF0000WAVEfmt ")))).toBeNull();
    expect(readMidi(smf([[on(0, 60), off(10, 60)]], { ppq: 0xe728 }))).toBeNull();
    expect(readMidi(smf([[[0, 0x40, 1]]]))).toBeNull(); // a data byte with no status before it
  });

  it("keeps what came before a file cut short", () => {
    const file = smf([[on(0, 60), off(96, 60), on(0, 62)]]);
    const cut = file.subarray(0, file.length - 3);
    expect(readMidi(cut)[0].notes.map((n) => n.midi)).toEqual([60, 62]);
  });
});

const n = (beat, midi, beats = 0.25, vel = 100) => ({ beat, beats, midi, vel });

describe("toPart", () => {
  it("snaps to 16ths and counts what was off the grid", () => {
    const part = toPart([n(0, 57), n(0.5, 60, 0.5), n(1 / 3, 64)]);
    expect(part.notes).toEqual([
      { step: 0, midi: 57, len: 1, accent: false },
      { step: 1, midi: 64, len: 1, accent: false },
      { step: 2, midi: 60, len: 2, accent: false },
    ]);
    expect(part).toMatchObject({ loops: 1, dropped: 0, offGrid: 1 });
  });

  it("drops the empty bars before the first note, keeping where it falls in its bar", () => {
    expect(toPart([n(9, 60)]).notes).toEqual([{ step: 4, midi: 60, len: 1, accent: false }]);
  });

  it("takes as many loops as the notes need, and cuts what runs past the longest", () => {
    expect(toPart([n(0, 60), n(9, 60)]).loops).toBe(2);
    expect(toPart([n(0, 60), n(36, 60)]).loops).toBe(6);
    const long = toPart([n(0, 60), n(63, 62, 4), n(64, 64)]);
    expect(long).toMatchObject({ loops: 8, dropped: 1 });
    expect(long.notes[1]).toEqual({ step: 252, midi: 62, len: 4, accent: false });
  });

  it("accents only the notes clearly louder than the rest", () => {
    expect(toPart([n(0, 60), n(1, 62)]).notes.every((x) => !x.accent)).toBe(true);
    const part = toPart([n(0, 60, 0.25, 90), n(1, 62, 0.25, 90), n(2, 64, 0.25, 90), n(3, 65, 0.25, 127)]);
    expect(part.notes.map((x) => x.accent)).toEqual([false, false, false, true]);
  });

  it("moves notes out of range by octaves, ends a note where the same pitch starts again, keeps chords", () => {
    const part = toPart([n(0, 5), n(0, 120), n(0, 60, 2), n(1, 60), n(1, 60), n(1, 64)]);
    expect(part.notes).toEqual([
      { step: 0, midi: 17, len: 1, accent: false },
      { step: 0, midi: 60, len: 4, accent: false },
      { step: 0, midi: 108, len: 1, accent: false },
      { step: 4, midi: 60, len: 1, accent: false },
      { step: 4, midi: 64, len: 1, accent: false },
    ]);
  });

  it("is an empty 2-bar part for no notes", () => {
    expect(toPart([])).toEqual({ notes: [], loops: 1, dropped: 0, offGrid: 0 });
  });
});

describe("importMidi", () => {
  it("takes the busiest track of a multi-track file", () => {
    const file = smf([[name("Tempo")], [name("Bass"), on(0, 33), off(24, 33)], [name("Lead"), on(0, 69), off(24, 69), on(0, 72), off(24, 72)]]);
    const part = importMidi(file);
    expect(part.name).toBe("Lead");
    expect(part.notes.map((x) => x.midi)).toEqual([69, 72]);
  });

  it("is null for a file that isn't MIDI, and an empty part for one with no notes", () => {
    expect(importMidi(Uint8Array.from(text("not a midi file")))).toBeNull();
    expect(importMidi(smf([[name("Empty")]]))).toMatchObject({ name: "Empty", notes: [] });
  });
});
