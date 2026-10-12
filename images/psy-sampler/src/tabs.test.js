import { describe, expect, it, vi } from "vitest";
import { claimTab } from "./tabs.js";

// One browser's LockManager, shared by its tabs: ifAvailable and steal, no queue.
function fakeLocks() {
  let held = null;
  return {
    request(_name, options, callback) {
      if (held && options.ifAvailable) return Promise.resolve(callback(null));
      if (held && options.steal) held.reject(new DOMException("Lock broken by another request", "AbortError"));
      else if (held) throw new Error("queued requests are not faked");
      return new Promise((resolve, reject) => {
        held = { reject };
        Promise.resolve(callback({ name: _name })).then(resolve, reject);
      });
    },
  };
}

// One browser's BroadcastChannel: a message reaches every other tab.
function fakeChannel() {
  const tabs = new Set();
  return class {
    constructor() {
      this.onmessage = null;
      tabs.add(this);
    }
    postMessage(data) {
      for (const tab of tabs) if (tab !== this) queueMicrotask(() => tab.onmessage?.({ data }));
    }
  };
}

function browser() {
  const locks = fakeLocks();
  const Channel = fakeChannel();
  return (opts = {}) => {
    const tab = { playing: false, ask: vi.fn(async () => {}), onDropped: vi.fn(), ...opts };
    tab.claimed = claimTab({ locks, Channel, wait: 20, playing: () => tab.playing, ask: tab.ask, onDropped: tab.onDropped });
    return tab;
  };
}

describe("one sampler per browser", () => {
  it("the first tab takes it without asking", async () => {
    const open = browser();
    const first = open();
    await first.claimed;
    expect(first.ask).not.toHaveBeenCalled();
  });

  it("a second tab says the first one plays and drops it once you take over", async () => {
    const open = browser();
    const first = open();
    await first.claimed;
    first.playing = true;
    let take;
    const second = open({ ask: vi.fn(() => new Promise((resolve) => (take = resolve))) });
    await vi.waitFor(() => expect(second.ask).toHaveBeenCalledWith({ playing: true }));
    let mounted = false;
    second.claimed.then(() => (mounted = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(mounted).toBe(false);
    expect(first.onDropped).not.toHaveBeenCalled();
    take();
    await second.claimed;
    await vi.waitFor(() => expect(first.onDropped).toHaveBeenCalledOnce());
  });

  it("a silent tab is open, not playing", async () => {
    const open = browser();
    await open().claimed;
    const second = open();
    await second.claimed;
    expect(second.ask).toHaveBeenCalledWith({ playing: false });
  });

  it("the tab that took over answers the next one; the dropped one stays quiet", async () => {
    const open = browser();
    const first = open();
    await first.claimed;
    const second = open();
    await second.claimed;
    second.playing = true;
    const third = open();
    await third.claimed;
    expect(third.ask).toHaveBeenCalledWith({ playing: true });
    expect(second.onDropped).toHaveBeenCalledOnce();
  });

  it("with no answer it says open, not playing", async () => {
    const locks = fakeLocks();
    await claimTab({ locks, Channel: null, playing: () => true, ask: async () => {}, onDropped: () => {} });
    const ask = vi.fn(async () => {});
    await claimTab({ locks, Channel: null, playing: () => true, ask, onDropped: () => {} });
    expect(ask).toHaveBeenCalledWith({ playing: false });
  });

  it("guards nothing without Web Locks, or when they refuse", async () => {
    const ask = vi.fn();
    await claimTab({ locks: undefined, playing: () => false, ask, onDropped: () => {} });
    const refusing = { request: () => Promise.reject(new DOMException("opaque origin", "SecurityError")) };
    await claimTab({ locks: refusing, Channel: null, playing: () => false, ask, onDropped: () => {} });
    expect(ask).not.toHaveBeenCalled();
  });
});
