// Standard MIDI Files (.mid) into a notes part: a clip dragged out of Ableton
// (or exported with Export MIDI Clip), or out of any other DAW. Only the
// notes count. Tempo, programs and controllers are dropped, and time is read
// in beats (ticks / PPQ), so the file's tempo never moves a note. Bars are
// taken as 4/4.

import { PART_LOOPS } from "../audio/patterns.js";
import { LOOP_STEPS } from "../audio/timing.js";
import { ascii, view } from "./bytes.js";

export const MAX_MIDI_BYTES = 4 * 2 ** 20;
const MAX_NOTES = 20000;
const LOW = 12;
const HIGH = 108;
const OFF_GRID = 0.25; // of a 16th: further than this from the grid is a triplet or a swing
const ACCENT = 16; // velocity over the clip's mean that reads as an accent

export const isMidi = (bytes) => bytes.length >= 14 && ascii(bytes, 0, 4) === "MThd";

class Truncated extends Error {}

/**
 * A .mid's bytes -> [{ name, notes: [{ beat, beats, midi, vel }] }], one per
 * track, or null when it isn't a MIDI file this can read (SMPTE time, broken
 * chunks). A note left on when its track ends lasts until that end.
 */
export function readMidi(bytes) {
  if (!isMidi(bytes)) return null;
  const dv = view(bytes);
  const ppq = dv.getUint16(12);
  if (ppq === 0 || ppq & 0x8000) return null; // SMPTE frames, not beats
  const tracks = [];
  let total = 0;
  let pos = 8 + dv.getUint32(4);
  try {
    while (pos + 8 <= bytes.length && total < MAX_NOTES) {
      const tag = ascii(bytes, pos, pos + 4);
      const end = Math.min(bytes.length, pos + 8 + dv.getUint32(pos + 4));
      if (tag === "MTrk") {
        const track = readTrack(bytes.subarray(pos + 8, end), ppq, MAX_NOTES - total);
        total += track.notes.length;
        tracks.push(track);
      }
      pos = end;
    }
  } catch {
    return null;
  }
  return tracks;
}

function readTrack(data, ppq, room) {
  let pos = 0;
  const byte = () => {
    if (pos >= data.length) throw new Truncated();
    return data[pos++];
  };
  const varlen = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte();
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("varlen");
  };
  let name = "";
  const notes = [];
  const open = new Map(); // "channel:key" -> [{ tick, vel }], first in first out
  let tick = 0;
  let status = 0;
  const close = (k, at) => {
    const on = open.get(k)?.shift();
    if (on && notes.length < room) {
      notes.push({ beat: on.tick / ppq, beats: (at - on.tick) / ppq, midi: Number(k.split(":")[1]), vel: on.vel });
    }
  };
  try {
    while (pos < data.length) {
      tick += varlen();
      const b = byte();
      if (b === 0xff) {
        const type = byte();
        const len = varlen();
        if (type === 0x03 && !name) name = new TextDecoder().decode(data.subarray(pos, pos + len)).trim();
        pos += len;
        if (type === 0x2f) break;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        const len = varlen(); // before the +=, which reads pos first
        pos += len;
        continue;
      }
      if (b > 0xf0) throw new Error("not in a file");
      if (b & 0x80) status = b;
      else if (status) pos--; // running status: this is the first data byte
      else throw new Error("no status");
      const kind = status & 0xf0;
      if (kind === 0xc0 || kind === 0xd0) {
        byte();
        continue;
      }
      const key = byte() & 0x7f;
      const vel = byte() & 0x7f;
      const k = `${status & 0x0f}:${key}`;
      if (kind === 0x90 && vel > 0) {
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ tick, vel });
      } else if (kind === 0x80 || kind === 0x90) close(k, tick);
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  for (const [k, list] of open) while (list.length) close(k, tick);
  notes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  return { name, notes };
}

/**
 * Notes in beats -> a notes part on the 16th grid: { notes, loops, dropped,
 * offGrid }. Whole empty bars before the first note go; the part takes as
 * many loops as the notes need, up to the longest, and what runs past that
 * is `dropped`. `offGrid` counts the notes snapped from too far away.
 * Notes out of range move by octaves, and on one pitch a note ends where
 * the next one starts.
 */
export function toPart(list) {
  if (!list.length) return { notes: [], loops: 1, dropped: 0, offGrid: 0 };
  const first = list.reduce((m, n) => Math.min(m, n.beat), Infinity);
  const shift = Math.floor(first / 4) * 4;
  const mean = list.reduce((s, n) => s + n.vel, 0) / list.length;
  let offGrid = 0;
  const snapped = list.map((n) => {
    const at = (n.beat - shift) * 4;
    const step = Math.round(at);
    if (Math.abs(at - step) > OFF_GRID) offGrid++;
    let midi = n.midi;
    while (midi < LOW) midi += 12;
    while (midi > HIGH) midi -= 12;
    return { step, midi, len: Math.max(1, Math.round(n.beats * 4)), accent: n.vel >= mean + ACCENT };
  });
  const end = snapped.reduce((m, n) => Math.max(m, n.step + n.len), 0);
  const most = PART_LOOPS[PART_LOOPS.length - 1];
  const loops = PART_LOOPS.find((n) => n * LOOP_STEPS >= end) ?? most;
  const size = loops * LOOP_STEPS;
  const kept = snapped.filter((n) => n.step < size).sort((a, b) => a.midi - b.midi || a.step - b.step);
  const notes = [];
  for (const n of kept) {
    const prev = notes[notes.length - 1];
    if (prev?.midi === n.midi && prev.step === n.step) continue; // the same note twice
    if (prev?.midi === n.midi && prev.step + prev.len > n.step) prev.len = n.step - prev.step;
    notes.push({ ...n, len: Math.min(n.len, size - n.step) });
  }
  notes.sort((a, b) => a.step - b.step || a.midi - b.midi);
  return { notes, loops, dropped: list.length - kept.length, offGrid };
}

/**
 * A .mid's bytes -> its busiest track as a part, { name, notes, loops,
 * dropped, offGrid }, or null when it isn't a MIDI file.
 */
export function importMidi(bytes) {
  const tracks = readMidi(bytes);
  if (!tracks) return null;
  const best = tracks.reduce((a, t) => (t.notes.length > (a?.notes.length ?? -1) ? t : a), null);
  return { name: best?.name ?? "", ...toPart(best?.notes ?? []) };
}
