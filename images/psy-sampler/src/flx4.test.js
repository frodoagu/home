import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BPM_MAX, BPM_MIN } from "./audio/timing.js";
import { createFlx4 } from "./flx4.js";

const RAW_MAX = 0x3fff;
const RAW_CENTRE = 0x2000;
const KICK = [0xb0, 0x13]; // a fader: bottom 0, top RAW_MAX
const PERC = [0xb0, 0x07]; // a knob: centre RAW_CENTRE
const DJ = [0xb6, 0x17];
const VOLUME = [0xb6, 0x18];
const TEMPO = [0xb0, 0x00];

describe("createFlx4", () => {
  let port;
  let access;
  let nav;
  let controls;
  let values;
  let flx4;

  const send = (...data) => port.onmidimessage({ data: Uint8Array.from(data), timeStamp: 1234 });
  const move = ([status, number], raw) => {
    send(status, number, raw >> 7);
    send(status, number + 0x20, raw & 0x7f);
  };
  const press = (status, number) => {
    send(status, number, 127);
    send(status, number, 0);
  };
  const target = (name) => ({ get: () => values[name], set: vi.fn((v) => (values[name] = v)) });

  beforeEach(() => {
    vi.useFakeTimers();
    port = { name: "DDJ-FLX4", state: "connected", onmidimessage: null };
    access = { inputs: new Map([["1", port]]), onstatechange: null };
    nav = { requestMIDIAccess: vi.fn(async () => access) };
    values = { kick: 1, bass: 1, perc: 1, dj: 0, volume: 0.5, tempo: 145 };
    controls = {
      playing: vi.fn(() => false),
      play: vi.fn(),
      stop: vi.fn(),
      tap: vi.fn(),
      bend: vi.fn(),
      settled: vi.fn(),
      changed: vi.fn(),
      targets: Object.fromEntries(Object.keys(values).map((name) => [name, target(name)])),
    };
    flx4 = createFlx4({ nav });
    flx4.bind(controls);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("connecting", () => {
    it("is not available without Web MIDI", () => {
      expect(createFlx4({ nav: {} }).available).toBe(false);
      expect(flx4.available).toBe(true);
    });

    it("finds the controller by its name", async () => {
      await expect(flx4.connect()).resolves.toBe("on");
      expect(flx4.connected()).toBe(true);
      expect(port.onmidimessage).toBeTypeOf("function");
    });

    it("tells a missing controller and a refused permission apart", async () => {
      access.inputs = new Map([["1", { name: "Other keyboard", state: "connected" }]]);
      await expect(flx4.connect()).resolves.toBe("missing");
      nav = { requestMIDIAccess: vi.fn(async () => Promise.reject(new Error("no"))) };
      await expect(createFlx4({ nav }).connect()).resolves.toBe("denied");
    });

    it("follows the cable and forgets the hand when unplugged", async () => {
      await flx4.connect();
      move(KICK, RAW_MAX);
      move(KICK, 0);
      expect(flx4.holds("kick")).toBe(true);
      port.state = "disconnected";
      access.onstatechange();
      expect(flx4.connected()).toBe(false);
      expect(flx4.holds("kick")).toBe(false);
      port.state = "connected";
      access.onstatechange();
      expect(flx4.connected()).toBe(true);
      expect(controls.changed).toHaveBeenCalledTimes(3); // connect, unplug, plug
    });
  });

  describe("buttons", () => {
    beforeEach(() => flx4.connect());

    it("toggles on PLAY's press, not on its release, from either deck", () => {
      press(0x90, 0x0b);
      expect(controls.play).toHaveBeenCalledOnce();
      controls.playing.mockReturnValue(true);
      press(0x91, 0x0b);
      expect(controls.stop).toHaveBeenCalledOnce();
    });

    it("stops on CUE only while playing", () => {
      press(0x90, 0x0c);
      expect(controls.stop).not.toHaveBeenCalled();
      controls.playing.mockReturnValue(true);
      press(0x91, 0x0c);
      expect(controls.stop).toHaveBeenCalledOnce();
    });

    it("taps on BEAT SYNC with the message's own time", () => {
      press(0x90, 0x58);
      expect(controls.tap).toHaveBeenCalledOnce();
      expect(controls.tap.mock.calls[0][0].timeStamp).toBe(1234);
    });

    it("does nothing with no app bound", () => {
      flx4.bind(null);
      expect(() => press(0x90, 0x0b)).not.toThrow();
    });
  });

  describe("absolute controls", () => {
    beforeEach(() => flx4.connect());
    const set = (name) => controls.targets[name].set;

    it("takes a value from the coarse and fine CCs, on the fine one", () => {
      send(0xb0, 0x13, 127);
      send(0xb0, 0x13 + 0x20, 127); // top: catches the kick at its 1
      send(0xb0, 0x13, 64);
      expect(set("kick")).not.toHaveBeenCalled();
      send(0xb0, 0x13 + 0x20, 0);
      expect(values.kick).toBeCloseTo(0.5, 2);
    });

    it("maps a fader 0-1 and a layer knob 0-1-1.5", () => {
      move(KICK, RAW_MAX);
      move(KICK, 0);
      expect(values.kick).toBe(0);
      move(PERC, RAW_CENTRE);
      move(PERC, RAW_MAX);
      expect(values.perc).toBe(1.5);
      move(PERC, 0);
      expect(values.perc).toBe(0);
    });

    it("drives the DJ filter and the volume", () => {
      move(DJ, RAW_CENTRE);
      move(DJ, 0);
      expect(values.dj).toBe(-1);
      move(DJ, RAW_MAX);
      expect(values.dj).toBe(1);
      move(VOLUME, RAW_CENTRE);
      move(VOLUME, RAW_MAX);
      expect(values.volume).toBe(1);
    });

    it("picks a control up only where its value is", () => {
      move(KICK, 0); // the fader is down, the kick is at 1
      move(KICK, RAW_MAX / 2);
      expect(set("kick")).not.toHaveBeenCalled();
      move(KICK, RAW_MAX);
      move(KICK, RAW_MAX / 2);
      expect(values.kick).toBeCloseTo(0.5, 2);
    });

    it("picks up when a move jumps over the value", () => {
      values.perc = 0.5;
      move(PERC, 0);
      move(PERC, RAW_MAX);
      expect(values.perc).toBe(1.5);
    });

    it("lets go when something else moves the value", () => {
      move(KICK, RAW_MAX);
      move(KICK, RAW_MAX / 2);
      values.kick = 0.1; // the mouse, a loaded workspace
      move(KICK, RAW_MAX * 0.6);
      expect(values.kick).toBe(0.1);
    });

    it("sets the tempo with the slider down as faster, picking up too", () => {
      const at = ((BPM_MAX - 145) / (BPM_MAX - BPM_MIN)) * RAW_MAX;
      move(TEMPO, at);
      move(TEMPO, 0);
      expect(values.tempo).toBe(BPM_MAX);
      move(TEMPO, RAW_MAX);
      expect(values.tempo).toBe(BPM_MIN);
    });

    it("writes a value once, however many messages land on it", () => {
      move(TEMPO, ((BPM_MAX - 145) / (BPM_MAX - BPM_MIN)) * RAW_MAX);
      expect(set("tempo")).not.toHaveBeenCalled();
    });

    it("ignores what it does not map and messages of another length", () => {
      expect(() => {
        send(0xfe);
        move([0xb6, 0x1f], 100); // the crossfader
        send(0x97, 0x30, 127); // a pad
      }).not.toThrow();
      expect(flx4.holds("kick")).toBe(false);
    });
  });

  describe("taking a layer from the autopilot", () => {
    beforeEach(() => flx4.connect());

    it("holds a layer off its neutral and hands it back there", () => {
      move(KICK, RAW_MAX);
      expect(flx4.holds("kick")).toBe(false);
      move(KICK, RAW_MAX / 2);
      expect(flx4.holds("kick")).toBe(true);
      expect(flx4.holds("bass")).toBe(false);
      move(KICK, RAW_MAX);
      expect(flx4.holds("kick")).toBe(false);
    });

    it("hands a knob back at its centre detent", () => {
      move(PERC, RAW_CENTRE);
      move(PERC, RAW_MAX);
      expect(flx4.holds("perc")).toBe(true);
      move(PERC, RAW_CENTRE + 40);
      expect(values.perc).toBe(1);
      expect(flx4.holds("perc")).toBe(false);
    });

    it("never holds on the filter, the volume or the tempo", () => {
      move(DJ, RAW_CENTRE);
      move(DJ, 0);
      expect(flx4.holds("dj")).toBe(false);
    });

    it("saves once the hand settles, not on every message", () => {
      move(KICK, RAW_MAX);
      for (const raw of [12000, 11000, 10000]) move(KICK, raw);
      expect(controls.settled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(controls.settled).toHaveBeenCalledOnce();
    });
  });

  describe("the jogs", () => {
    beforeEach(() => flx4.connect());

    it("bends by the turn's speed and lets go when it stops", () => {
      send(0xb0, 0x21, 66);
      expect(controls.bend).toHaveBeenLastCalledWith(0.02);
      send(0xb1, 0x22, 63);
      expect(controls.bend).toHaveBeenLastCalledWith(-0.01);
      vi.advanceTimersByTime(149);
      expect(controls.bend).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(controls.bend).toHaveBeenLastCalledWith(0);
    });

    it("limits a fast turn", () => {
      send(0xb0, 0x21, 127);
      expect(controls.bend).toHaveBeenLastCalledWith(0.04);
    });
  });
});
