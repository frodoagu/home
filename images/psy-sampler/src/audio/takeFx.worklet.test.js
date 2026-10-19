import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChain, sanitizeFx } from "./fxChain.js";

// The processor as the audio thread runs it: registered under a name, fed quanta.
let Processor;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("sampleRate", 8000);
  vi.stubGlobal("AudioWorkletProcessor", class {
    constructor() {
      this.port = { onmessage: null };
    }
  });
  vi.stubGlobal("registerProcessor", (name, cls) => {
    expect(name).toBe("psy-take-fx");
    Processor = cls;
  });
  await import("./takeFx.worklet.js");
});
afterEach(() => vi.unstubAllGlobals());

const quantum = (seed) => Float32Array.from({ length: 128 }, (_, i) => Math.sin(seed * 128 + i) * 0.5);

describe("the live effects processor", () => {
  it("plays the chain the take renders through, in stereo", () => {
    const fx = { pitch: 4, chorus: 0.5, reverb: 0.3 };
    const node = new Processor();
    node.port.onmessage({ data: fx });
    const chain = createChain(8000);
    for (let q = 0; q < 4; q++) {
      const output = [new Float32Array(128), new Float32Array(128)];
      expect(node.process([[quantum(q)]], [output])).toBe(true);
      const want = chain.process(quantum(q), sanitizeFx(fx));
      for (const c of [0, 1]) output[c].forEach((x, i) => expect(x).toBeCloseTo(want[c][i], 6));
    }
  });

  it("dry, it passes the microphone through to both sides, clipped to full scale", () => {
    const node = new Processor();
    const output = [new Float32Array(128), new Float32Array(128)];
    node.process([[new Float32Array(128).fill(3)]], [output]);
    expect(output[0][0]).toBe(1);
    expect(output[1][5]).toBe(1);
  });

  it("silence in when nothing is connected; null stops it", () => {
    const node = new Processor();
    const output = [new Float32Array(128).fill(9), new Float32Array(128).fill(9)];
    expect(node.process([[]], [output])).toBe(true);
    expect(output[0].every((x) => x === 0)).toBe(true);
    node.port.onmessage({ data: null });
    expect(node.process([[]], [output])).toBe(false);
  });
});
