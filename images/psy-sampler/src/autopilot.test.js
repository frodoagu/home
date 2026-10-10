import { describe, expect, it } from "vitest";
import {
  CHANGE_BARS,
  SECTIONS,
  STYLES,
  STYLE_IDS,
  advance,
  arrange,
  dequeue,
  enqueue,
  fillMelodic,
  guessSection,
  isBare,
  joinPilot,
  poolOf,
  rearrange,
  skip,
  startPilot,
} from "./autopilot.js";
import { baseOf } from "./audio/patterns.js";
import { seeded } from "./editing.js";
import { normalize, layerOfVariant } from "./workspace.js";

const { lists } = normalize({ lists: { kick: ["kick.punchy~1"] } });
const count = (active, layer) => Object.values(active).filter((id) => layerOfVariant(id) === layer).length;
const melodic = (active) => count(active, "lead") + count(active, "pad");

// Runs the pilot for `loops` loop boundaries and records every step.
function run(seed, loops, opts = {}, steer = (pilot) => pilot) {
  const rng = seeded(seed);
  let { pilot, active } = startPilot(lists, rng, opts.style);
  const log = [{ pilot, active, fx: [], rewrite: [] }];
  for (let i = 0; i < loops; i++) {
    const move = advance(steer(pilot, i), active, lists, rng, opts);
    ({ pilot, active } = move);
    log.push({ ...move, prev: log.at(-1).active });
  }
  return log;
}

describe("autopilot", () => {
  it("starts an intro: one kick, one percussion and a pad", () => {
    const { pilot, active } = startPilot(lists, seeded(1));
    expect(pilot).toEqual({ section: "intro", left: 4, length: 4, queue: [] });
    expect([count(active, "kick"), count(active, "perc"), count(active, "pad")]).toEqual([1, 1, 1]);
    expect(Object.keys(active)).toHaveLength(3);
  });

  it("can start in any section", () => {
    const { pilot, active } = startPilot(lists, seeded(1), "psytrance", "peak");
    expect(pilot.section).toBe("peak");
    expect(SECTIONS.peak.loops).toContain(pilot.length);
    expect(count(active, "bass")).toBe(1);
  });

  it("joins a playing mix in the section it looks like, at its start", () => {
    expect(guessSection({ kick: "kick.punchy", "perc.shaker": "perc.shaker" })).toBe("intro");
    expect(guessSection({ kick: "kick.punchy", bass: "bass.rolling" })).toBe("groove");
    expect(guessSection({ kick: "kick.punchy", "lead.acid": "lead.acid" })).toBe("build");
    expect(guessSection({ kick: "kick.punchy", "pad.air": "pad.air" })).toBe("peak");
    expect(guessSection({ "pad.air": "pad.air" })).toBe("breakdown");
    expect(joinPilot({ kick: "kick.punchy", bass: "bass.rolling" })).toEqual({
      section: "groove",
      left: 4,
      length: 4,
      queue: [],
    });
    expect(joinPilot({ kick: "kick.punchy" }, "peak")).toMatchObject({ section: "peak", rearrange: true });
  });

  it("a seed replays the same track, whatever the tile order", () => {
    const shuffled = { ...lists, perc: [...lists.perc].reverse(), lead: [...lists.lead].reverse() };
    const play = (l) => {
      const rng = seeded(42);
      let { pilot, active } = startPilot(l, rng);
      const out = [active];
      for (let i = 0; i < 30; i++) {
        const move = advance(pilot, active, l, rng);
        ({ pilot, active } = move);
        out.push(move);
      }
      return out;
    };
    expect(play(shuffled)).toEqual(play(lists));
  });

  it("walks the sections in order and holds each for one of its lengths", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const log = run(seed, 200);
      for (let i = 1; i < log.length; i++) {
        const [prev, cur] = [log[i - 1].pilot, log[i].pilot];
        if (prev.left > 1) {
          expect(cur).toMatchObject({ section: prev.section, left: prev.left - 1, length: prev.length });
        } else {
          expect(SECTIONS[prev.section].next).toContain(cur.section);
          expect(SECTIONS[cur.section].loops).toContain(cur.length);
          expect(cur.left).toBe(cur.length);
        }
      }
      expect(new Set(log.map((m) => m.pilot.section))).toEqual(new Set(Object.keys(SECTIONS)));
    }
  });

  it("no section is longer than 24 bars", () => {
    for (const { loops } of Object.values(SECTIONS)) expect(Math.max(...loops) * 2).toBeLessThanOrEqual(24);
  });

  it("every section change matches the section's shape", () => {
    for (const style of ["psytrance", "hitech"]) {
      for (const seed of [7, 8, 9]) {
        for (const { pilot, active } of run(seed, 200, { style }).filter((m) => m.pilot.left === m.pilot.length)) {
          const shape = SECTIONS[pilot.section].shape;
          for (const [layer, spec] of Object.entries(shape)) {
            // A style without a pool for a layer leaves it out.
            const [lo, hi] = !STYLES[style].pool[layer] ? [0, 0] : Array.isArray(spec) ? spec : [spec, spec];
            expect(count(active, layer)).toBeGreaterThanOrEqual(lo);
            expect(count(active, layer)).toBeLessThanOrEqual(hi);
          }
        }
      }
    }
  });

  it("every style glitches: one glitch from its pool from the groove to the peak", () => {
    for (const style of STYLE_IDS) {
      const pool = STYLES[style].pool?.glitch; // "anything goes" has none: every glitch
      if (STYLES[style].pool) expect(pool, style).toBeDefined();
      const log = run(3, 120, { style });
      const entries = log.filter((m) => ["groove", "build", "peak"].includes(m.pilot.section) && m.pilot.left === m.pilot.length);
      expect(entries.length).toBeGreaterThan(0);
      for (const m of entries) expect(count(m.active, "glitch"), style).toBe(1);
      for (const id of log.flatMap((m) => Object.values(m.active)).filter((v) => layerOfVariant(v) === "glitch")) {
        if (pool) expect(pool).toContain(baseOf(id));
      }
    }
  });

  it("never plays kick, bass and percussion alone: every loop has a lead or a pad", () => {
    for (const style of STYLE_IDS) {
      for (const seed of [1, 2, 3]) {
        for (const { active } of run(seed, 150, { style, changeBars: 2 })) {
          expect(melodic(active), style).toBeGreaterThanOrEqual(1);
          expect(isBare(active)).toBe(false);
        }
      }
    }
  });

  it("the loop before a peak fires a riser; a breakdown enters with a downlifter and no kick", () => {
    const log = run(11, 200);
    for (const m of log) {
      if (m.pilot.left === 1 && m.pilot.next === "peak") expect(m.fx[0]).toMatch(/^fx\.(riser|reverse)/);
      if (m.pilot.section === "breakdown" && m.pilot.left === m.pilot.length) {
        expect(m.fx).toEqual(["fx.down"]);
        expect(m.active.kick).toBeUndefined();
        expect(m.active.bass).toBeUndefined();
      }
    }
  });

  it("inside a section one sound changes every `changeBars` bars, and only then", () => {
    for (const changeBars of CHANGE_BARS) {
      let swaps = 0;
      for (const seed of [1, 2, 3]) {
        const log = run(seed, 200, { changeBars });
        for (let i = 1; i < log.length; i++) {
          const [prev, cur] = [log[i - 1], log[i]];
          if (cur.pilot.section !== prev.pilot.section || cur.pilot.left !== prev.pilot.left - 1) continue;
          const line = ((cur.pilot.length - cur.pilot.left) * 2) % changeBars === 0;
          if (cur.active !== prev.active) {
            swaps++;
            expect(line).toBe(true);
            expect(Object.keys(cur.active)).toHaveLength(Object.keys(prev.active).length);
          }
        }
      }
      if (changeBars <= 16) expect(swaps, `every ${changeBars}`).toBeGreaterThan(0);
    }
  });

  it("queued sections play next, in order, and can be dropped before they play", () => {
    const steer = (pilot, i) => (i === 0 ? enqueue(enqueue(enqueue(pilot, "peak"), "breakdown"), "intro") : pilot);
    const sections = [];
    for (const m of run(3, 60, {}, (p, i) => (i === 0 ? dequeue(steer(p, i), 2) : p))) {
      if (sections.at(-1) !== m.pilot.section) sections.push(m.pilot.section);
    }
    expect(sections.slice(0, 4)).toEqual(["intro", "peak", "breakdown", "build"]);
  });

  it("skip ends the section on the next loop, with the queue's head if any", () => {
    const rng = seeded(5);
    const { pilot, active } = startPilot(lists, rng);
    const move = advance(skip(enqueue(pilot, "breakdown")), active, lists, rng);
    expect(move.pilot).toMatchObject({ section: "breakdown", queue: [] });
    expect(advance(skip(move.pilot), move.active, lists, rng).pilot.section).toBe("build");
  });

  it("each style plays its own pool; a new style rearranges the section on the next loop", () => {
    for (const style of STYLE_IDS.filter((s) => STYLES[s].pool)) {
      for (const { active } of run(4, 80, { style })) {
        for (const id of Object.values(active)) {
          expect(STYLES[style].pool[layerOfVariant(id)], `${style} ${id}`).toContain(baseOf(id));
        }
      }
    }
    expect(poolOf(lists, "kick", "all")).toEqual([...lists.kick].sort());
    const rng = seeded(8);
    const { pilot, active } = startPilot(lists, rng, "psytrance");
    const move = advance(rearrange(pilot), active, lists, rng, { style: "techno" });
    for (const id of Object.values(move.active)) expect(STYLES.techno.pool[layerOfVariant(id)]).toContain(baseOf(id));
    expect(move.pilot.rearrange).toBeUndefined();
  });

  it("every lead that comes in gets a new melody; only playing parts are rewritten", () => {
    for (const m of run(5, 200)) {
      for (const id of m.rewrite) expect(Object.values(m.active)).toContain(id);
      if (!m.prev) continue;
      const was = Object.values(m.prev);
      for (const id of Object.values(m.active)) {
        if (layerOfVariant(id) === "lead" && !was.includes(id)) expect(m.rewrite).toContain(id);
      }
      for (const [key, id] of Object.entries(m.active)) {
        const layer = layerOfVariant(id);
        expect(key).toBe(layer === "kick" || layer === "bass" ? layer : id);
      }
    }
    expect(startPilot(lists, seeded(1), "psytrance", "build").rewrite).toHaveLength(1);
  });

  it("a bare mix gets a lead or a pad from the style", () => {
    const bare = { kick: "kick.punchy", bass: "bass.rolling", "perc.hat": "perc.hat" };
    expect(isBare(bare)).toBe(true);
    expect(isBare({})).toBe(false);
    expect(isBare({ "pad.air": "pad.air" })).toBe(false);
    for (let seed = 1; seed < 20; seed++) {
      const full = fillMelodic(bare, lists, seeded(seed), "darkpsy");
      expect(isBare(full)).toBe(false);
      const added = Object.values(full).filter((id) => !Object.values(bare).includes(id));
      expect(added).toHaveLength(1);
      expect(STYLES.darkpsy.pool[layerOfVariant(added[0])]).toContain(added[0]);
    }
  });

  it("copies take part like any other variant", () => {
    const seen = new Set();
    for (let seed = 1; seed < 40; seed++) seen.add(arrange("groove", {}, lists, seeded(seed)).kick);
    expect(seen).toContain("kick.punchy~1");
  });
});
