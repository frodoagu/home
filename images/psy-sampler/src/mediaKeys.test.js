// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaKeys } from "./mediaKeys.js";

function fakeSession() {
  const handlers = {};
  return {
    handlers,
    playbackState: "none",
    metadata: null,
    setActionHandler: (action, fn) => (handlers[action] = fn),
  };
}

function fakeAudio() {
  return {
    paused: true,
    play: vi.fn(function () {
      this.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(function () {
      this.paused = true;
    }),
  };
}

describe("createMediaKeys", () => {
  let session;
  let audio;
  let running;
  let transport;
  const make = () => createMediaKeys({ session, makeAudio: () => (audio = fakeAudio()), title: "Psy" });

  beforeEach(() => {
    session = fakeSession();
    audio = null;
    running = false;
    transport = { playing: () => running, play: vi.fn(), stop: vi.fn() };
  });

  it("opens no session until the engine first runs", () => {
    const keys = make();
    keys.setPlaying(false);
    expect(audio).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("plays the silent track while the engine runs and pauses it when it stops", () => {
    const keys = make();
    keys.setPlaying(true);
    keys.setPlaying(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(session.playbackState).toBe("playing");
    keys.setPlaying(false);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(session.playbackState).toBe("paused");
  });

  it("presses play when stopped and stop when running", () => {
    const keys = make();
    keys.bind(transport);
    session.handlers.pause();
    expect(transport.stop).not.toHaveBeenCalled();
    session.handlers.play();
    expect(transport.play).toHaveBeenCalledTimes(1);
    running = true;
    session.handlers.play();
    expect(transport.play).toHaveBeenCalledTimes(1);
    session.handlers.pause();
    session.handlers.stop();
    expect(transport.stop).toHaveBeenCalledTimes(2);
  });

  it("does nothing while no app is bound", () => {
    const keys = make();
    keys.bind(transport);
    keys.bind(null);
    session.handlers.play();
    expect(transport.play).not.toHaveBeenCalled();
  });

  it("falls back to key events without a media session", () => {
    session = undefined;
    const keys = make();
    keys.bind(transport);
    const press = (key) => window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    press("MediaPlayPause");
    expect(transport.play).toHaveBeenCalledTimes(1);
    running = true;
    press("MediaPlayPause");
    press("MediaStop");
    expect(transport.stop).toHaveBeenCalledTimes(2);
    keys.bind(null);
  });
});
