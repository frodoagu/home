import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The processor as the audio thread runs it: registered under a name, fed quanta.
let Processor;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("currentFrame", 0);
  vi.stubGlobal("AudioWorkletProcessor", class {
    constructor() {
      this.port = { onmessage: null, sent: [], postMessage: (msg) => this.port.sent.push(msg) };
    }
  });
  vi.stubGlobal("registerProcessor", (name, cls) => {
    expect(name).toBe("psy-tap");
    Processor = cls;
  });
  await import("./tap.worklet.js");
});
afterEach(() => vi.unstubAllGlobals());

const quantum = (v) => new Float32Array(128).fill(v);

// Runs `count` quanta from context frame `from`, the inputs from `inputs(q)`.
function run(node, from, count, inputs) {
  for (let q = 0; q < count; q++) {
    vi.stubGlobal("currentFrame", from + q * 128);
    expect(node.process(inputs(q))).toBe(true);
  }
}

describe("the tap processor", () => {
  it("posts its stereo input in blocks of 4096 frames, with the frame each starts on", () => {
    const node = new Processor({ numberOfInputs: 1 });
    run(node, 256, 33, (q) => [[quantum(q), quantum(-q)]]);
    expect(node.port.sent).toHaveLength(1);
    const [{ frame, channels }] = node.port.sent;
    expect(frame).toBe(256);
    expect(channels.map((d) => d.length)).toEqual([4096, 4096]);
    expect([channels[0][128], channels[1][4095]]).toEqual([1, -31]);
  });

  it("taps several inputs together as left/right pairs; a mono or silent one fills both sides", () => {
    const node = new Processor({ numberOfInputs: 3 });
    run(node, 0, 2, () => [[quantum(0.5), quantum(0.25)], [quantum(0.75)], []]);
    node.port.onmessage();
    const [{ frame, channels }, end] = node.port.sent;
    expect(frame).toBe(0);
    expect(channels.map((d) => [d.length, d[0]])).toEqual([[256, 0.5], [256, 0.25], [256, 0.75], [256, 0.75], [256, 0], [256, 0]]);
    expect(end).toBeNull();
    expect(node.process([[quantum(1)]])).toBe(false);
  });
});
