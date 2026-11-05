// The Pioneer DDJ-FLX4 as a control surface, through Web MIDI. Absolute
// controls pick up: they move nothing until they reach the value they drive.
// The handlers outlive remounts; each mount binds its own controls. The map
// and its reasons are in docs/psy-sampler.md#ddj-flx4.
import { LEVEL } from "./audio/params.js";
import { BPM_MAX, BPM_MIN } from "./audio/timing.js";

const PORT_NAME = /flx4/i;
const RAW_MAX = 0x3fff; // 14 bits: a coarse CC, then its fine one
const RAW_CENTRE = 0x2000;
const FINE = 0x20; // from a coarse CC to its fine one
const DETENT = 0.02;
const JOG_CENTRE = 64; // jogs send the turn as an offset from this
const BEND_PER_TICK = 0.01;
const BEND_MAX = 0.04;
const BEND_IDLE_MS = 150;
const SETTLE_MS = 400;

const round = (v) => Math.round(v * 100) / 100;
const detent = (v, at) => (Math.abs(v - at) < DETENT ? at : v);
const fader = (raw) => round(detent(raw / RAW_MAX, LEVEL.def));
const knob = (low, mid, high) => (raw) => {
  const v =
    raw < RAW_CENTRE
      ? low + ((mid - low) * raw) / RAW_CENTRE
      : mid + ((high - mid) * (raw - RAW_CENTRE)) / (RAW_MAX - RAW_CENTRE);
  return round(detent(v, mid));
};
const tempo = (raw) => Math.round(BPM_MAX - (raw / RAW_MAX) * (BPM_MAX - BPM_MIN)); // down is faster

const layerFader = (target) => ({ target, read: fader, reach: 0.03, layer: true });
const layerKnob = (target) => ({ target, read: knob(LEVEL.min, LEVEL.def, LEVEL.max), reach: 0.03, layer: true });

// Keys are (status << 8) | number. A 14-bit control is listed by its coarse CC.
const ABSOLUTE = {
  0xb013: layerFader("kick"),
  0xb113: layerFader("bass"),
  0xb007: layerKnob("perc"), // left EQ: hi, mid, low
  0xb00b: layerKnob("lead"),
  0xb00f: layerKnob("pad"),
  0xb107: layerKnob("glitch"), // right EQ: hi, mid, low
  0xb10b: layerKnob("classic"),
  0xb10f: layerKnob("fx"),
  0xb617: { target: "dj", read: knob(-1, 0, 1), reach: 0.04 }, // left CFX
  0xb618: { target: "volume", read: knob(0, 0.5, 1), reach: 0.02 }, // right CFX
  0xb000: { target: "tempo", read: tempo, reach: 2 }, // left tempo slider
};
const JOGS = new Set([0xb021, 0xb022, 0xb121, 0xb122]); // ring and top of each deck

const toggle = (c) => (c.playing() ? c.stop() : c.play());
const stop = (c) => {
  if (c.playing()) c.stop();
};
const tap = (c, event) => c.tap(event);
const BUTTONS = {
  0x900b: toggle, // PLAY
  0x910b: toggle,
  0x900c: stop, // CUE
  0x910c: stop,
  0x9058: tap, // BEAT SYNC
  0x9158: tap,
};

export function createFlx4({ nav = globalThis.navigator } = {}) {
  let access = null;
  let input = null;
  let bound = null; // the mounted app's controls
  let bendTimer = 0;
  let settleTimer = 0;
  const controls = new Map(); // coarse key -> { high, last, caught, sent }
  const held = new Set(); // layers the hand took from the autopilot

  function bend(value) {
    const amount = (value - JOG_CENTRE) * BEND_PER_TICK;
    bound?.bend(Math.max(-BEND_MAX, Math.min(BEND_MAX, amount)));
    clearTimeout(bendTimer);
    bendTimer = setTimeout(() => bound?.bend(0), BEND_IDLE_MS);
  }

  function hold(layer, value) {
    if (value === LEVEL.def) held.delete(layer);
    else held.add(layer);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => bound?.settled(), SETTLE_MS);
  }

  function move(control, { target: name, read, reach, layer }, raw) {
    const target = bound?.targets[name];
    if (!target) return;
    const value = read(raw);
    const current = target.get();
    const before = control.last;
    control.last = value;
    if (current !== control.sent) control.caught = false; // something else moved it
    if (!control.caught) {
      const crossed = before !== undefined && (before - current) * (value - current) <= 0;
      if (!crossed && Math.abs(value - current) > reach) return;
      control.caught = true;
    }
    if (value !== current) target.set(value);
    control.sent = target.get();
    if (layer) hold(name, value);
  }

  function message(event) {
    const { data } = event;
    if (data.length !== 3) return;
    const [status, number, value] = data;
    const key = (status << 8) | number;
    if (BUTTONS[key]) {
      if (value && bound) BUTTONS[key](bound, event);
    } else if (JOGS.has(key)) {
      bend(value);
    } else if (ABSOLUTE[key]) {
      if (!controls.has(key)) controls.set(key, {});
      controls.get(key).high = value;
    } else if (ABSOLUTE[key - FINE] && controls.has(key - FINE)) {
      const control = controls.get(key - FINE);
      move(control, ABSOLUTE[key - FINE], (control.high << 7) | value);
    }
  }

  function attach() {
    const next = [...access.inputs.values()].find((port) => PORT_NAME.test(port.name) && port.state === "connected") ?? null;
    if (next === input) return;
    if (input) input.onmidimessage = null;
    input = next;
    if (input) input.onmidimessage = message;
    controls.clear();
    held.clear();
    bound?.changed();
  }

  return {
    available: typeof nav?.requestMIDIAccess === "function",
    /** Opens the controller: "on", "missing" or "denied". A later plug-in connects by itself. */
    async connect() {
      try {
        access ??= await nav.requestMIDIAccess();
      } catch {
        return "denied";
      }
      access.onstatechange = attach;
      attach();
      return input ? "on" : "missing";
    },
    connected: () => input !== null,
    /** The mounted app's controls, or null while none is. */
    bind(next) {
      bound = next;
    },
    /** Whether the hand has this layer: the autopilot leaves its levels alone. */
    holds: (layer) => held.has(layer),
  };
}
