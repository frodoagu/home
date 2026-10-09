import { describe, expect, it } from "vitest";
import { PHRASE, SECTIONS, advance, arrange, startPilot } from "./autopilot.js";
import { seeded } from "./editing.js";
import { normalize, layerOfVariant } from "./workspace.js";

const { lists } = normalize({ lists: { kick: ["kick.punchy~1"] } });
const count = (active, layer) => Object.values(active).filter((id) => layerOfVariant(id) === layer).length;

// Runs the pilot for `loops` loop boundaries and records every step.
function run(seed, loops) {
  const rng = seeded(seed);
  let { pilot, active } = startPilot(lists, rng);
  const log = [{ pilot, active, fx: [], rewrite: [] }];
  for (let i = 0; i < loops; i++) {
    const move = advance(pilot, active, lists, rng);
    ({ pilot, active } = move);
    log.push(move);
  }
  return log;
}

describe("autopilot", () => {
  it("starts an intro: one kick and one percussion", () => {
    const { pilot, active } = startPilot(lists, seeded(1));
    expect(pilot).toEqual({ section: "intro", left: SECTIONS.intro.loops });
    expect(count(active, "kick")).toBe(1);
    expect(count(active, "perc")).toBe(1);
    expect(Object.keys(active)).toHaveLength(2);
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

  it("walks the sections in order and holds each for its length", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const log = run(seed, 200);
      for (let i = 1; i < log.length; i++) {
        const [prev, cur] = [log[i - 1].pilot, log[i].pilot];
        if (prev.left > 1) expect(cur).toEqual({ section: prev.section, left: prev.left - 1 });
        else {
          expect(SECTIONS[prev.section].next).toContain(cur.section);
          expect(cur.left).toBe(SECTIONS[cur.section].loops);
        }
      }
      expect(new Set(log.map((m) => m.pilot.section))).toEqual(new Set(Object.keys(SECTIONS)));
    }
  });

  it("every section change matches the section's shape", () => {
    for (const seed of [7, 8, 9]) {
      for (const { pilot, active } of run(seed, 200).filter((m) => m.pilot.left === SECTIONS[m.pilot.section].loops)) {
        const shape = SECTIONS[pilot.section].shape;
        for (const [layer, spec] of Object.entries(shape)) {
          const [lo, hi] = Array.isArray(spec) ? spec : [spec, spec];
          expect(count(active, layer)).toBeGreaterThanOrEqual(lo);
          expect(count(active, layer)).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it("the build's last loop fires a riser; a breakdown enters with a downlifter and no kick", () => {
    const log = run(11, 200);
    for (const m of log) {
      if (m.pilot.section === "build" && m.pilot.left === 1) expect(m.fx[0]).toMatch(/^fx\.riser/);
      if (m.pilot.section === "breakdown" && m.pilot.left === SECTIONS.breakdown.loops) {
        expect(m.fx).toEqual(["fx.down"]);
        expect(m.active.kick).toBeUndefined();
        expect(m.active.bass).toBeUndefined();
      }
    }
  });

  it("sections are whole phrases, and inside one the mix only changes on a phrase line", () => {
    for (const { loops } of Object.values(SECTIONS)) expect(loops % PHRASE).toBe(0);
    let swaps = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const log = run(seed, 200);
      for (let i = 1; i < log.length; i++) {
        const [prev, cur] = [log[i - 1], log[i]];
        if (cur.pilot.section !== prev.pilot.section || cur.pilot.left !== prev.pilot.left - 1) continue;
        if (cur.active === prev.active) continue;
        swaps++;
        expect((SECTIONS[cur.pilot.section].loops - cur.pilot.left) % PHRASE).toBe(0);
      }
    }
    expect(swaps).toBeGreaterThan(0);
  });

  it("only asks to rewrite parts that play, and lanes follow the layer rules", () => {
    for (const m of run(5, 200)) {
      for (const id of m.rewrite) expect(Object.values(m.active)).toContain(id);
      for (const [key, id] of Object.entries(m.active)) {
        const layer = layerOfVariant(id);
        expect(key).toBe(layer === "kick" || layer === "bass" ? layer : id);
      }
    }
  });

  it("copies take part like any other variant", () => {
    const seen = new Set();
    for (let seed = 1; seed < 40; seed++) seen.add(arrange("groove", {}, lists, seeded(seed)).kick);
    expect(seen).toContain("kick.punchy~1");
  });
});
