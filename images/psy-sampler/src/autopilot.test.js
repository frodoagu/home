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
  mixOf,
  poolOf,
  rearrange,
  skip,
  startPilot,
  withPlan,
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

  describe("the mix", () => {
    const at = (section, loop, length = 4) => ({ section, length, left: length - loop, queue: [] });

    it("a build swells the lead into the peak, landing on the section's end value", () => {
      const mix = { kick: "kick.punchy", bass: "bass.rolling", "lead.acid": "lead.acid" };
      const levels = [0, 1, 2, 3].map((loop) => mixOf(at("build", loop), mix)["lead.acid"]);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
      expect(levels[0]).toBeLessThan(1);
      expect(levels[3]).toBe(1.15);
      expect(mixOf(at("groove", 2), mix)).toEqual({ "kick.punchy": 1, "bass.rolling": 1, "lead.acid": 1 });
    });

    it("stacked sounds share their layer's room and a pad steps back under a lead", () => {
      const one = mixOf(at("peak", 0), { "perc.hat": "perc.hat" })["perc.hat"];
      const three = mixOf(at("peak", 0), { "perc.hat": "perc.hat", "perc.clap": "perc.clap", "perc.ride": "perc.ride" });
      expect(three["perc.hat"]).toBeLessThan(one);
      expect(three["perc.hat"]).toBe(three["perc.clap"]);
      const pad = (mix) => mixOf(at("groove", 0), mix)["pad.air"];
      expect(pad({ "pad.air": "pad.air", "lead.acid": "lead.acid" })).toBeLessThan(pad({ "pad.air": "pad.air" }));
    });

    it("the breakdown opens the pad up and pulls the percussion back", () => {
      const mix = { "pad.air": "pad.air", "lead.acid": "lead.acid", "perc.hat": "perc.hat" };
      const breakdown = mixOf(at("breakdown", 0), mix);
      const peak = mixOf(at("peak", 0), mix);
      expect(breakdown["pad.air"]).toBeGreaterThan(peak["pad.air"]);
      expect(breakdown["perc.hat"]).toBeLessThan(peak["perc.hat"]);
    });

    it("every level is on the volume slider's grid and in range, in every section", () => {
      for (const { pilot, active } of run(3, 200)) {
        for (const level of Object.values(mixOf(pilot, active))) {
          expect(level).toBeGreaterThan(0);
          expect(level).toBeLessThanOrEqual(1.5);
          expect(Math.abs(level * 20 - Math.round(level * 20))).toBeLessThan(1e-9);
        }
      }
    });
  });
});

describe("plans (✨ AI)", () => {
  // Plays the pilot until its first section change, with `plan` handed over at the start.
  function toNext(plan, { seed = 7, steer = (p) => p, style } = {}) {
    const rng = seeded(seed);
    let { pilot, active } = startPilot(lists, rng, style);
    pilot = steer(withPlan(pilot, plan));
    const moves = [];
    do {
      const move = advance(pilot, active, lists, rng, { style });
      ({ pilot, active } = move);
      moves.push(move);
    } while (pilot.left !== pilot.length);
    return moves;
  }

  it("are taken only before a section's last loop", () => {
    const plan = { section: "peak", bars: 16, layers: {} };
    const { pilot } = startPilot(lists, seeded(1));
    expect(withPlan(pilot, plan).plan).toBe(plan);
    expect(withPlan(pilot, null)).toBe(pilot);
    expect(withPlan({ ...pilot, left: 1 }, plan).plan).toBeUndefined();
    expect(withPlan(null, plan)).toBeNull();
  });

  it("pick the next section, its length and the layers they name; a peak still gets its riser", () => {
    const plan = { section: "peak", bars: 24, layers: { kick: ["kick.long"], lead: ["lead.acid"], perc: ["perc.hat", "perc.shaker", "perc.toms"] } };
    const moves = toNext(plan, { style: "goa" });
    const last = moves.at(-2); // the intro's last loop
    expect(last.pilot).toMatchObject({ left: 1, next: "peak" });
    expect(last.fx.some((id) => ["fx.riser", "fx.riserImpact", "fx.reverse"].includes(id))).toBe(true);
    const entry = moves.at(-1);
    expect(entry.pilot).toMatchObject({ section: "peak", length: 12, left: 12 });
    expect(entry.pilot.plan).toBeUndefined();
    expect(entry.active.kick).toBe("kick.long");
    expect(Object.values(entry.active).filter((id) => layerOfVariant(id) === "lead")).toEqual(["lead.acid"]);
    expect(Object.values(entry.active).filter((id) => layerOfVariant(id) === "perc").sort()).toEqual(["perc.hat", "perc.shaker", "perc.toms"]);
    expect(count(entry.active, "bass")).toBe(1); // not in the plan: drawn, to the peak's shape
    expect(count(entry.active, "pad")).toBe(1);
  });

  it("with no length (normalizePlan drops one the section cannot have), the pilot draws one", () => {
    for (let seed = 1; seed < 10; seed++) {
      expect([8, 12]).toContain(toNext({ section: "peak", bars: null, layers: {} }, { seed }).at(-1).pilot.length);
    }
  });

  it("a queued section goes first; its arrangement is the plan's only if it is the same section", () => {
    const plan = { section: "peak", bars: 16, layers: { lead: ["lead.acid"] } };
    const other = toNext(plan, { steer: (p) => enqueue(p, "breakdown") }).at(-1);
    expect(other.pilot).toMatchObject({ section: "breakdown", queue: [] });
    const same = toNext(plan, { steer: (p) => enqueue(p, "peak") }).at(-1);
    expect(same.pilot).toMatchObject({ section: "peak", length: 8, queue: [] });
    expect(Object.values(same.active)).toContain("lead.acid");
  });

  it("a plan with no lead and no pad still plays one of them", () => {
    for (let seed = 1; seed < 30; seed++) {
      const entry = toNext({ section: "groove", bars: 8, layers: { lead: [], pad: [] } }, { seed }).at(-1);
      expect(melodic(entry.active)).toBeGreaterThan(0);
    }
  });

  it("a layer the style no longer has the planned sounds of is drawn from the new pool", () => {
    const plan = { section: "groove", bars: 8, layers: { kick: ["kick.long"] } }; // goa's, not techno's
    const entry = toNext(plan, { style: "techno" }).at(-1);
    expect(STYLES.techno.pool.kick).toContain(entry.active.kick);
  });

  it("the same seed and the same plans make the same track", () => {
    const plan = { section: "breakdown", bars: 16, layers: { pad: ["pad.prog"], lead: ["lead.arp"] } };
    expect(toNext(plan, { seed: 11 })).toEqual(toNext(plan, { seed: 11 }));
  });
});
