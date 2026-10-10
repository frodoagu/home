// Runs on the audio thread (engine.tap): copies its stereo input and posts it
// to the main thread in blocks of BLOCK frames. Any message asks it to post
// what it holds, then `null`, and stop.
const BLOCK = 4096;

class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    this.fill = 0;
    this.done = false;
    this.port.onmessage = () => {
      this.send();
      this.port.postMessage(null);
      this.done = true;
    };
  }

  send() {
    if (!this.fill) return;
    const out = this.block.map((d) => d.slice(0, this.fill));
    this.port.postMessage(out, out.map((d) => d.buffer));
    this.fill = 0;
  }

  process([input]) {
    if (this.done) return false;
    const n = input[0]?.length ?? 128; // no active input: a quantum of silence
    if (this.fill + n > BLOCK) this.send();
    this.block.forEach((d, c) => {
      const src = input[c] ?? input[0];
      if (src) d.set(src, this.fill);
      else d.fill(0, this.fill, this.fill + n);
    });
    this.fill += n;
    if (this.fill === BLOCK) this.send();
    return true;
  }
}

registerProcessor("psy-tap", Tap);
