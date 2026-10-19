import { describe, expect, it } from "vitest";
import { FakeAudioContext } from "../test/fakeAudio.js";
import { buildMaster, ceilingCurve } from "./master.js";

const dbOf = (g) => 20 * Math.log10(g);
const filters = (ctx, type) => ctx.nodes.filter((n) => n.kind === "filter" && n.type === type);

describe("ceilingCurve", () => {
  const curve = ceilingCurve();
  const at = (x) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))];

  it("passes everything under the knee untouched", () => {
    for (const x of [-0.7, -0.3, 0, 0.25, 0.75]) expect(at(x)).toBeCloseTo(x, 3);
  });

  it("rises all the way and never goes past -1 dBFS", () => {
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    const top = Math.max(...curve.map(Math.abs));
    expect(dbOf(top)).toBeLessThanOrEqual(-1);
    expect(dbOf(top)).toBeGreaterThan(-1.1);
    expect(curve[0]).toBeCloseTo(-curve.at(-1), 6);
  });
});

describe("buildMaster", () => {
  const ctx = new FakeAudioContext();
  const { input, output } = buildMaster(ctx);

  it("takes a mono mix in as stereo", () => {
    expect([input.channelCount, input.channelCountMode, input.channelInterpretation]).toEqual([2, "explicit", "speakers"]);
  });

  it("cuts the subsonics first, 24 dB/octave", () => {
    const [a] = input.outputs;
    const [b] = a.outputs;
    for (const f of [a, b]) expect([f.type, f.frequency.value, f.Q.value]).toEqual(["highpass", 16, -3.0103]);
    expect(b.outputs[0].kind).toBe("splitter");
  });

  it("takes the side's lows out and gives the mid the same phase", () => {
    const side = filters(ctx, "highpass").filter((f) => f.frequency.value === 120);
    expect(side).toHaveLength(2);
    const mid = filters(ctx, "allpass").find((f) => f.frequency.value === 120);
    expect(mid.Q.value).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("splits in three Linkwitz-Riley bands, the lows put through the upper crossover's phase", () => {
    for (const f of [150, 5000]) {
      expect(filters(ctx, "lowpass").filter((n) => n.frequency.value === f)).toHaveLength(2);
      expect(filters(ctx, "highpass").filter((n) => n.frequency.value === f)).toHaveLength(2);
    }
    const lowPhase = filters(ctx, "allpass").find((f) => f.frequency.value === 5000);
    const [lowEnd] = filters(ctx, "lowpass").filter((n) => n.outputs.includes(lowPhase));
    expect(lowEnd.frequency.value).toBe(150);
  });

  it("runs the same compressor on every band and takes its makeup back", () => {
    const comps = ctx.nodes.filter((n) => n.kind === "compressor");
    expect(comps).toHaveLength(4); // three bands and the limiter
    const bands = comps.filter((c) => c.ratio.value !== 20);
    expect(bands).toHaveLength(3);
    for (const c of bands) {
      expect([c.threshold.value, c.knee.value, c.ratio.value]).toEqual([-24, 12, 2]);
      const pre = ctx.nodes.find((n) => n.outputs.includes(c));
      const [post] = c.outputs;
      expect(dbOf(pre.gain.value * post.gain.value)).toBeCloseTo(-5.31, 6);
    }
  });

  it("ends limiter -> its makeup back -> ceiling -> output, the ceiling's samples never past it", () => {
    const limiter = ctx.nodes.find((n) => n.kind === "compressor" && n.ratio.value === 20);
    const [back] = limiter.outputs;
    expect(dbOf(back.gain.value)).toBeCloseTo(0.6 * -2 * (1 - 1 / 20), 6);
    const [ceiling] = back.outputs;
    expect([ceiling.kind, ceiling.oversample]).toEqual(["waveshaper", "none"]);
    expect(ceiling.curve).toEqual(ceilingCurve());
    expect(ceiling.outputs).toEqual([output]);
  });
});
