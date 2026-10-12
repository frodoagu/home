import { describe, expect, it } from "vitest";
import { SCENES, createDirector, hash, lasersOf, moodOf, strobeOf } from "./director.js";

const BEAT_MS = 400;
// A stage frame (stage.js) with what the director reads.
const frame = (over = {}) => ({
  time: 0,
  beatMs: BEAT_MS,
  beats: 0,
  bar: 0,
  env: { kick: 0 },
  layers: new Set(["kick", "bass"]),
  variants: ["kick.a", "bass.b"],
  playing: true,
  build: 0,
  sinceDrop: -Infinity,
  drops: 0,
  ...over,
});
const at = (bar, over = {}) => frame({ time: bar * 4 * BEAT_MS, beats: bar * 4, bar, ...over });

// The scenes `director` shows bar by bar, under `frameAt(bar)`.
function play(director, bars, frameAt = (b) => at(b)) {
  const out = [];
  for (let b = 0; b < bars; b++) out.push(director.frame(frameAt(b)).scene.id);
  return out;
}

describe("director", () => {
  it("holds a scene while nothing changes, and moves on after 16 bars", () => {
    const shown = play(createDirector(), 40);
    expect(new Set(shown.slice(0, 16)).size).toBe(1);
    expect(shown[16]).not.toBe(shown[15]);
  });

  it("changes on a section change, but not before 4 bars on a scene", () => {
    const d = createDirector();
    const lanesAt = (b) => (b < 2 ? ["kick.a"] : b < 6 ? ["kick.a", "bass.b"] : ["kick.a", "lead.c"]);
    const shown = play(d, 8, (b) => at(b, { variants: lanesAt(b) }));
    expect(shown[2]).toBe(shown[0]); // changed at bar 2, too soon
    expect(shown[4]).not.toBe(shown[3]); // the first bar line 4 bars in
  });

  it("is the same show for the same music", () => {
    const lanesAt = (b) => ({ variants: [`kick.${Math.floor(b / 5)}`] });
    expect(play(createDirector(), 64, (b) => at(b, lanesAt(b)))).toEqual(play(createDirector(), 64, (b) => at(b, lanesAt(b))));
  });

  it("cuts to a peak scene on the drop, with no crossfade", () => {
    const d = createDirector();
    d.frame(at(0));
    const out = d.frame(at(1, { drops: 1, sinceDrop: 0 }));
    expect(SCENES.find((s) => s.id === out.scene.id).moods).toContain("peak");
    expect(out.mix).toBe(1);
    expect(out.previous).toBe(null);
  });

  it("crossfades over a beat on a bar change", () => {
    const d = createDirector();
    play(d, 16);
    const start = d.frame(at(16));
    expect(start.mix).toBe(0);
    expect(start.previous).not.toBe(null);
    const half = d.frame(at(16, { time: 16 * 4 * BEAT_MS + BEAT_MS / 2 }));
    expect(half.mix).toBeCloseTo(0.5);
  });

  it("plays only calm scenes without a kick", () => {
    const calm = SCENES.filter((s) => s.moods.includes("calm")).map((s) => s.id);
    const shown = play(createDirector(), 200, (b) => at(b, { layers: new Set(["pad"]), variants: ["pad.a"] }));
    for (const id of shown.slice(16)) expect(calm).toContain(id);
  });

  it("stays put while locked, and moves by hand", () => {
    const d = createDirector();
    d.frame(at(0));
    expect(d.lock()).toBe(true);
    const shown = play(d, 40);
    expect(new Set(shown).size).toBe(1);
    const before = shown[0];
    d.next(at(40));
    expect(d.frame(at(40)).scene.id).not.toBe(before);
    d.pick(at(41), 2);
    expect(d.frame(at(41)).scene.id).toBe(SCENES[2].id);
  });

  it("changes the palette by hand", () => {
    const d = createDirector();
    const before = d.frame(at(0)).scene.palette;
    d.palette();
    expect(d.frame(at(0)).scene.palette).not.toBe(before);
  });
});

describe("moods, strobe and lasers", () => {
  it("reads the mood from the kick and the drop", () => {
    expect(moodOf(frame({ layers: new Set(["pad"]) }))).toBe("calm");
    expect(moodOf(frame({ playing: false }))).toBe("calm");
    expect(moodOf(frame())).toBe("high");
    expect(moodOf(frame({ sinceDrop: 10 }))).toBe("peak");
    expect(moodOf(frame({ sinceDrop: 80 }))).toBe("high");
  });

  it("strobes on the drop's eighths and not between them, and not at all in a calm bar", () => {
    expect(strobeOf(frame({ sinceDrop: 0 }))).toBeCloseTo(1);
    expect(strobeOf(frame({ sinceDrop: 0.45 }))).toBeLessThan(0.05);
    expect(strobeOf(frame({ sinceDrop: 1 }))).toBeCloseTo(1);
    expect(strobeOf(frame({ layers: new Set(["pad"]) }))).toBe(0);
  });

  it("strobes harder as the build nears the drop", () => {
    const early = strobeOf(frame({ build: 0.6, beats: 0 }));
    const late = strobeOf(frame({ build: 0.95, beats: 0 }));
    expect(late).toBeGreaterThan(early);
    expect(strobeOf(frame({ build: 0.4, beats: 0 }))).toBe(0);
  });

  it("flashes by hand, briefly", () => {
    expect(strobeOf(frame({ time: 1000, layers: new Set() }), 1000)).toBe(1);
    expect(strobeOf(frame({ time: 2000, layers: new Set() }), 1000)).toBeLessThan(0.01);
  });

  it("keeps the lasers faint at rest, fuller with a kick, full on the drop and rising with a build", () => {
    const rest = lasersOf(frame({ playing: false, layers: new Set() }));
    const breakdown = lasersOf(frame({ layers: new Set(["pad"]) }));
    const groove = lasersOf(frame());
    expect(rest).toBeGreaterThan(0);
    expect(rest).toBeLessThan(breakdown);
    expect(breakdown).toBeLessThan(groove);
    expect(lasersOf(frame({ sinceDrop: 0 }))).toBe(1);
    expect(lasersOf(frame({ sinceDrop: 60 }))).toBeLessThan(lasersOf(frame({ sinceDrop: 1 })));
    expect(lasersOf(frame({ build: 0.9 }))).toBeGreaterThan(groove);
  });

  it("hashes text into 0..1", () => {
    for (const s of ["", "a", "kick.a:12"]) expect(hash(s)).toBeGreaterThanOrEqual(0);
    expect(hash("a")).not.toBe(hash("b"));
  });
});
