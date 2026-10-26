import { describe, it, expect } from "vitest";
import {
  DEFAULTS, KEYS, LOOP_S, NOISES, MAINS_HZ, VIZ_N, VIZ_RATE, TONE_HZ,
  lineModel, snrDb, noiseRms, monitorGains, trace, vizWaves, renderSignal, renderNoise,
  noiseWave, phoneGate, dbu, cmrrLeak, shieldShare, wavePeak,
} from "./balancedAudio";

const noisy = { hum: 1, dimmer: 1, phone: 1, ground: 1 };
const only = (key) => Object.fromEntries(NOISES.map((n) => [n.key, n.key === key ? 1 : 0]));
const ideal = { imbalance: 0, cmrr: 400 };

describe("levels", () => {
  it("+4 dBu line level is 1.228 V rms", () => {
    expect(dbu(1.736)).toBeCloseTo(4, 1);
  });

  it("CMRR in dB becomes a leak factor", () => {
    expect(cmrrLeak(60)).toBeCloseTo(0.001);
    expect(cmrrLeak(0)).toBe(1);
  });

  it("a longer shield carries more of the ground difference", () => {
    expect(shieldShare(10)).toBeCloseTo(0.5);
    expect(shieldShare(100)).toBeGreaterThan(shieldShare(10));
  });
});

describe("unbalanced line", () => {
  it("hands every bit of noise on the hot conductor to the output", () => {
    const { hot, cold, out } = lineModel({ mode: "unbalanced", noise: noisy });
    expect(cold).toBeNull();
    expect(out).toEqual(hot);
    expect(out.ground).toBeGreaterThan(0);
  });

  it("carries the ground-loop drop in series with the signal", () => {
    const { out } = lineModel({ mode: "unbalanced", noise: only("ground"), length: 10 });
    expect(out.ground).toBeCloseTo(0.05 * shieldShare(10));
  });

  it("pickup grows with the cable length", () => {
    const short = lineModel({ mode: "unbalanced", noise: only("dimmer"), shield: false, length: 2 }).out;
    const long = lineModel({ mode: "unbalanced", noise: only("dimmer"), shield: false, length: 50 }).out;
    expect(long.dimmer / short.dimmer).toBeCloseTo(25);
  });
});

describe("balanced line", () => {
  it("drives the legs in opposite polarity and gains 6 dB", () => {
    const { hot, cold, out } = lineModel({ mode: "balanced", level: 1 });
    expect(hot.signal).toBe(1);
    expect(cold.signal).toBe(-1);
    expect(out.signal).toBeCloseTo(2, 2);
  });

  it("a perfect receiver cancels everything common to both legs", () => {
    const { hot, cold, out } = lineModel({ mode: "balanced", noise: only("ground"), ...ideal });
    expect(hot.ground).toBeGreaterThan(0);
    expect(cold.ground).toBeCloseTo(hot.ground);
    expect(out.ground).toBeCloseTo(0, 12);
  });

  it("leaves the common-mode noise times the imbalance", () => {
    const { hot, out } = lineModel({ mode: "balanced", noise: only("dimmer"), imbalance: 0.02, cmrr: 400 });
    expect(out.dimmer / hot.dimmer).toBeCloseTo(0.02, 3);
  });

  it("is limited by the receiver's CMRR when the legs match", () => {
    const { hot, out } = lineModel({ mode: "balanced", noise: only("dimmer"), imbalance: 0, cmrr: 40 });
    expect(out.dimmer / hot.dimmer).toBeCloseTo(0.01, 4);
  });

  it("twisting is what stops magnetic hum; balancing alone does not", () => {
    const parallel = lineModel({ mode: "balanced", noise: only("hum"), twisted: false, ...ideal }).out;
    const twisted = lineModel({ mode: "balanced", noise: only("hum"), twisted: true, ...ideal }).out;
    expect(Math.abs(parallel.hum)).toBeGreaterThan(20 * Math.abs(twisted.hum));
  });

  it("the shield stops electric pickup but not magnetic", () => {
    const run = (key, shield) => lineModel({ mode: "unbalanced", noise: only(key), shield }).out[key];
    expect(run("dimmer", true)).toBeLessThan(run("dimmer", false) / 10);
    expect(run("hum", true)).toBe(run("hum", false));
  });

  it("beats the unbalanced line by far on the same cable", () => {
    const u = snrDb(lineModel({ mode: "unbalanced", noise: noisy }).out);
    const b = snrDb(lineModel({ mode: "balanced", noise: noisy }).out);
    expect(b - u).toBeGreaterThan(30);
  });
});

describe("impedance-balanced output", () => {
  it("rejects noise as well as a symmetric one, just 6 dB quieter", () => {
    const b = lineModel({ mode: "balanced", noise: noisy }).out;
    const z = lineModel({ mode: "impedance", noise: noisy }).out;
    expect(z.signal).toBeCloseTo(b.signal / 2, 3);
    for (const n of NOISES) expect(z[n.key]).toBeCloseTo(b[n.key], 9);
    expect(snrDb(b) - snrDb(z)).toBeCloseTo(6.02, 1);
  });

  it("puts no signal on the cold leg", () => {
    expect(lineModel({ mode: "impedance" }).cold.signal).toBe(0);
  });
});

describe("balanced into unbalanced (TRS → TS)", () => {
  it("grounds the cold leg and loses both the 6 dB and the rejection", () => {
    const { cold, out } = lineModel({ mode: "mixed", noise: noisy, level: 1 });
    expect(Object.values(cold).every((v) => v === 0)).toBe(true);
    expect(out.signal).toBe(1);
    expect(out.ground).toBe(lineModel({ mode: "unbalanced", noise: noisy }).out.ground);
  });
});

describe("faults", () => {
  it("an open cold leg turns the line into an unbalanced one", () => {
    const { hot, out } = lineModel({ mode: "balanced", noise: noisy, faults: { coldOpen: true }, cmrr: 400 });
    for (const k of KEYS) expect(out[k]).toBeCloseTo(hot[k], 12);
  });

  it("swapped pins 2/3 flip the polarity and nothing else", () => {
    const ok = lineModel({ mode: "balanced", noise: noisy }).out;
    const swapped = lineModel({ mode: "balanced", noise: noisy, faults: { swapped: true } }).out;
    for (const k of KEYS) expect(swapped[k]).toBeCloseTo(-ok[k], 12);
    expect(snrDb(swapped)).toBeCloseTo(snrDb(ok), 9);
  });
});

describe("SNR", () => {
  it("is infinite with no noise and drops 20 dB per 10x of noise", () => {
    const quiet = { hum: 0, dimmer: 0, phone: 0, ground: 0 };
    expect(snrDb(lineModel({ noise: quiet }).out)).toBe(Infinity);
    const a = snrDb(lineModel({ noise: only("hum") }).out);
    const b = snrDb(lineModel({ noise: { ...only("hum"), hum: 0.1 } }).out);
    expect(b - a).toBeCloseTo(20, 6);
  });

  it("a mic-level signal drowns on an unbalanced cable that a line level survives", () => {
    const mic = snrDb(lineModel({ mode: "unbalanced", level: 0.005 }).out);
    const line = snrDb(lineModel({ mode: "unbalanced", level: 1.736 }).out);
    expect(mic).toBeLessThan(20);
    expect(line - mic).toBeCloseTo(20 * Math.log10(1.736 / 0.005), 6);
  });

  it("noiseRms ignores the signal", () => {
    const { out } = lineModel({ noise: noisy });
    expect(noiseRms(out)).toBeCloseTo(noiseRms({ ...out, signal: 99 }), 12);
  });
});

describe("waveforms", () => {
  it("mains-borne noise repeats every mains cycle", () => {
    for (const key of ["hum", "ground", "dimmer"]) {
      for (const t of [0.0013, 0.0071, 0.0152]) {
        expect(noiseWave(key, t + 1 / MAINS_HZ)).toBeCloseTo(noiseWave(key, t), 6);
      }
    }
  });

  it("the phone buzzes at 217 Hz and only in bursts", () => {
    expect(noiseWave("phone", 0.0001)).toBeGreaterThan(0.5);
    expect(noiseWave("phone", 0.001)).toBeLessThan(0);
    expect(phoneGate(0.3)).toBe(1);
    expect(phoneGate(0.6)).toBe(0);
    expect(phoneGate(0.3 + LOOP_S)).toBe(1);
  });

  it("every waveform peaks near 1", () => {
    for (const k of KEYS) {
      expect(wavePeak(k)).toBeGreaterThan(0.8);
      expect(wavePeak(k)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("the audio loop holds whole periods so it repeats without a click", () => {
    const rate = 8000;
    const tone = renderSignal("tone", rate);
    expect(tone.length).toBe(rate * LOOP_S);
    expect((TONE_HZ * LOOP_S) % 1).toBe(0);
    expect(Math.abs(tone[0] - Math.sin((2 * Math.PI * TONE_HZ * tone.length) / rate))).toBeLessThan(1e-6);
    const hum = renderNoise("hum", rate);
    expect(hum[0]).toBeCloseTo(noiseWave("hum", LOOP_S), 5);
  });

  it("the guitar is deterministic, normalized and silence is silent", () => {
    const a = renderSignal("guitar", 8000);
    const b = renderSignal("guitar", 8000, LOOP_S + 0); // same cache key → same array
    expect(a).toBe(b);
    expect(Math.max(...a.map(Math.abs))).toBeCloseTo(1, 6);
    expect(renderSignal("silence", 8000).every((v) => v === 0)).toBe(true);
  });

  it("the plots get one mains cycle of everything", () => {
    for (const kind of ["tone", "guitar", "silence"]) {
      const waves = vizWaves(kind);
      for (const k of KEYS) expect(waves[k].length).toBe(VIZ_N);
    }
    expect(VIZ_N).toBe(VIZ_RATE / MAINS_HZ);
  });

  it("trace mixes the waveforms by their coefficients", () => {
    const waves = vizWaves("tone");
    const t = trace({ signal: 2, hum: 0, dimmer: 0, phone: 0, ground: 0 }, waves);
    expect(t[10]).toBeCloseTo(2 * waves.signal[10], 6);
  });
});

describe("monitorGains", () => {
  it("brings the signal to full scale when the noise is small", () => {
    const g = monitorGains(lineModel({ ...DEFAULTS, mode: "balanced", level: 1.736 }).out);
    expect(g.signal).toBeCloseTo(1, 3);
  });

  it("turns everything down together rather than clip", () => {
    const g = monitorGains(lineModel({ mode: "unbalanced", level: 0.005, noise: noisy }).out);
    const total = KEYS.reduce((s, k) => s + Math.abs(g[k]) * wavePeak(k), 0);
    expect(total).toBeCloseTo(1, 6);
    expect(g.signal).toBeLessThan(0.5);
  });
});
