// Minimal Web Audio stand-in for jsdom: records every node, connection and
// AudioParam automation call so tests can assert on what would be scheduled.
// `currentTime` is a plain field the test advances by hand.

export class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.events.push(["set", v, t]);
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(["linear", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this.events.push(["exp", v, t]);
    return this;
  }
  setTargetAtTime(v, t, tau) {
    this.events.push(["target", v, t, tau]);
    return this;
  }
  cancelScheduledValues(t) {
    this.events.push(["cancel", t]);
    return this;
  }
}

export class FakeNode {
  constructor(ctx, kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnected = false;
    ctx.nodes.push(this);
  }
  connect(dest) {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(dest) {
    if (dest) {
      this.outputs = this.outputs.filter((o) => o !== dest);
      return;
    }
    this.outputs = [];
    this.disconnected = true;
  }
}

export class FakeSource extends FakeNode {
  start(t, offset = 0) {
    this.startTime = t;
    this.offset = offset;
  }
  stop(t) {
    this.stopTime = t;
  }
}

const withParams = (node, params) => {
  for (const [name, value] of Object.entries(params)) node[name] = new FakeParam(value);
  return node;
};

export class FakeAudioContext {
  constructor() {
    this.nodes = [];
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.outputLatency = 0;
    this.state = "running";
    this.destination = new FakeNode(this, "destination");
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  createGain() {
    return withParams(new FakeNode(this, "gain"), { gain: 1 });
  }
  createOscillator() {
    const n = withParams(new FakeSource(this, "oscillator"), { frequency: 440, detune: 0 });
    n.type = "sine";
    return n;
  }
  createBufferSource() {
    const n = withParams(new FakeSource(this, "buffer"), { playbackRate: 1 });
    n.buffer = null;
    n.loop = false;
    return n;
  }
  createBiquadFilter() {
    const n = withParams(new FakeNode(this, "filter"), { frequency: 350, detune: 0, Q: 1, gain: 0 });
    n.type = "lowpass";
    return n;
  }
  createDynamicsCompressor() {
    return withParams(new FakeNode(this, "compressor"), {
      threshold: -24,
      knee: 30,
      ratio: 12,
      attack: 0.003,
      release: 0.25,
    });
  }
  createDelay() {
    return withParams(new FakeNode(this, "delay"), { delayTime: 0 });
  }
  createWaveShaper() {
    const n = new FakeNode(this, "waveshaper");
    n.curve = null;
    n.oversample = "none";
    return n;
  }
  createConvolver() {
    const n = new FakeNode(this, "convolver");
    n.buffer = null;
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels, getChannelData: (c) => data[c] };
  }
  sources() {
    return this.nodes.filter((n) => n instanceof FakeSource);
  }
}
