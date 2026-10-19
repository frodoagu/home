// Runs on the audio thread (engine.monitor): the microphone through the
// take's effects (fxChain.js), live. A message is the new settings; null
// stops it. Clipped to full scale, since a chain can ring past it.
import { createChain, sanitizeFx } from "./fxChain.js";

class TakeFx extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chain = createChain(sampleRate);
    this.fx = sanitizeFx({});
    this.mono = new Float32Array(128);
    this.done = false;
    this.port.onmessage = ({ data }) => {
      if (data === null) this.done = true;
      else this.fx = sanitizeFx(data);
    };
  }

  process([input], [output]) {
    if (this.done) return false;
    const n = output[0].length;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    const mono = this.mono;
    mono.fill(0);
    for (const data of input) for (let i = 0; i < n; i++) mono[i] += data[i] / input.length;
    const channels = this.chain.process(mono, this.fx);
    output.forEach((out, c) => {
      const data = channels[Math.min(c, channels.length - 1)];
      for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, data[i]));
    });
    return true;
  }
}

registerProcessor("psy-take-fx", TakeFx);
