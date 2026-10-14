// The VJ: which scene and palette play, when they change, and the strobe.
// It reads the stage's frames and only ever changes on a bar line, a drop or
// a key, so the show follows the arrangement. Every choice is a hash of what
// plays and the bar it lands on, never Math.random: the same seed played the
// same way gives the same show.

// mood: where a scene fits. "calm" plays breakdowns, "peak" the bars after a
// drop; "high" is everything with a kick in between. Silence is the bulb's,
// and so is a set's ending, so it fades and stops on it.
export const SCENES = [
  { id: "bulb", moods: ["calm", "high", "peak"] },
  { id: "kifs", moods: ["high", "peak"] },
  { id: "mandala", moods: ["calm", "high"] },
  { id: "flow", moods: ["calm"] },
  { id: "julia", moods: ["calm", "high", "peak"] },
  { id: "gyroid", moods: ["high", "peak"] },
  { id: "coral", moods: ["calm", "high"] },
  { id: "cells", moods: ["calm"] },
  { id: "phyllo", moods: ["calm", "high"] },
  { id: "hyper", moods: ["high", "peak"] },
  { id: "turing", moods: ["calm", "high"] },
  { id: "physarum", moods: ["calm", "high", "peak"] },
];

export const PALETTES = 8; // shaders.js PALETTES
const PEAK_BEATS = 64; // a drop's peak lasts 16 bars
const MIN_BARS = 4; // a section change switches only after this many bars on a scene
const MAX_BARS = { calm: 16, high: 16, peak: 8 };
const FADE_BEATS = 1;
const MANUAL_FADE_BEATS = 0.5;
const FLASH_MS = 140;

// FNV-1a, 0..1.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const pulse = (phase, sharp) => Math.exp(-phase * sharp);

/** "calm" | "high" | "peak" for a stage frame. */
export function moodOf(s) {
  if (!s.playing || !s.layers.has("kick")) return "calm";
  return s.sinceDrop >= 0 && s.sinceDrop < PEAK_BEATS ? "peak" : "high";
}

/**
 * The strobe the music asks for at a frame, 0..1, before the viewer's level:
 * 8ths through the drop's first bar, 16ths rising over the second half of the
 * build, the kicks through the peak, a set's frenzy at full (16ths, then 32nds
 * over its second half) and a flash by hand.
 */
export function strobeOf(s, flashAt = -Infinity) {
  let f = 0;
  if (s.frenzy > 0) f = pulse((s.beats * (s.frenzy < 0.5 ? 4 : 8)) % 1, 5);
  if (s.sinceDrop >= 0 && s.sinceDrop < 4) f = Math.max(f, pulse((s.sinceDrop * 2) % 1, 7));
  if (s.build > 0.5) f = Math.max(f, pulse((s.beats * 4) % 1, 9) * ((s.build - 0.5) * 2) ** 2);
  if (moodOf(s) === "peak") f = Math.max(f, s.env.kick ** 3 * 0.5);
  const hand = s.time - flashAt;
  if (hand >= 0) f = Math.max(f, Math.exp(-hand / FLASH_MS));
  return clamp01(f);
}

const variation = (key) => [hash(`${key}:a`), hash(`${key}:b`), hash(`${key}:c`), hash(`${key}:d`)];

export function createDirector({ scenes = SCENES } = {}) {
  const look = (index, palette, key) => ({ index, id: scenes[index].id, palette, vars: variation(key) });
  const bulb = scenes.findIndex((sc) => sc.id === "bulb");
  let current = look(Math.max(0, bulb), 0, "start");
  let previous = null;
  let fade = { start: -Infinity, ms: 1 };
  let locked = false;
  let since = 0; // bar the current scene came in on
  let seen = { bar: null, sig: null, drops: 0, beat: null, playing: null, ending: false };
  let changedSig = false; // the lanes changed since the scene came in
  let flashAt = -Infinity;
  let manual = 0; // presses, so a manual pick hashes differently each time

  // `beats` 0 is a cut: the new scene from this very frame.
  function show(next, s, beats) {
    previous = beats > 0 ? current : null;
    current = next;
    fade = beats > 0 ? { start: s.time, ms: beats * s.beatMs } : { start: -Infinity, ms: 1 };
    since = s.bar;
    changedSig = false;
  }

  // A scene for `mood`, other than the current one, picked by `key`.
  function choose(mood, key) {
    const pool = scenes.map((sc, i) => i).filter((i) => scenes[i].moods.includes(mood) && i !== current.index);
    const list = pool.length ? pool : scenes.map((sc, i) => i).filter((i) => i !== current.index);
    const index = list[Math.floor(hash(key) * list.length)] ?? current.index;
    const palette = Math.floor(hash(`${key}:p`) * PALETTES);
    return look(index, palette === current.palette ? (palette + 1) % PALETTES : palette, key);
  }

  function frame(s) {
    const sig = [...s.variants].sort().join(",");
    if (seen.sig !== null && sig !== seen.sig) changedSig = true;
    const mood = moodOf(s);
    const beat = Math.floor(s.beats);
    // Silence plays the bulb, and the music's bars count from when it comes back.
    if (!s.playing || !seen.playing) {
      since = s.bar;
      changedSig = false;
    }
    if (!s.playing) {
      if (seen.playing !== false && !locked && bulb >= 0 && current.index !== bulb) {
        show(look(bulb, current.palette, "silence"), s, FADE_BEATS);
      }
    } else if (s.ending) {
      if (!seen.ending && !locked && bulb >= 0 && current.index !== bulb) {
        show(look(bulb, current.palette, "ending"), s, FADE_BEATS);
      }
    } else if (s.frenzy > 0 && beat !== seen.beat && !locked) {
      // A set going wild cuts to a new scene and palette on every beat.
      show(choose("peak", `frenzy:${sig}:${beat}`), s, 0);
    } else if (s.drops > seen.drops) {
      // The drop cuts: no crossfade, a new scene on the 1.
      if (!locked) show(choose("peak", `drop:${sig}:${s.bar}`), s, 0);
    } else if (seen.bar !== null && s.bar !== seen.bar && !locked) {
      const bars = s.bar - since;
      if ((changedSig && bars >= MIN_BARS) || bars >= MAX_BARS[mood] || bars < 0) {
        show(choose(mood, `${sig}:${s.bar}`), s, FADE_BEATS);
      }
    }
    seen = { bar: s.bar, sig, drops: s.drops, beat, playing: s.playing, ending: Boolean(s.ending) };

    const mix = clamp01((s.time - fade.start) / fade.ms);
    const strobe = strobeOf(s, flashAt);
    return {
      scene: current,
      previous: mix < 1 ? previous : null,
      mix,
      mood,
      locked,
      strobe,
    };
  }

  // By hand, from the keys: a crossfade of half a beat, right away.
  function step(s, by) {
    const index = (current.index + by + scenes.length) % scenes.length;
    show(look(index, current.palette, `hand:${index}:${++manual}`), s, MANUAL_FADE_BEATS);
  }

  return {
    frame,
    next: (s) => step(s, 1),
    prev: (s) => step(s, -1),
    pick: (s, index) => {
      if (index >= 0 && index < scenes.length && index !== current.index) {
        show(look(index, current.palette, `hand:${index}:${++manual}`), s, MANUAL_FADE_BEATS);
      }
    },
    palette: () => {
      current = { ...current, palette: (current.palette + 1) % PALETTES };
    },
    lock: () => (locked = !locked),
    flash: (t) => {
      flashAt = t;
    },
  };
}
