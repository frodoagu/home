import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_MS, watchVersion } from "./update.js";

const fakeDoc = () => {
  const listeners = new Set();
  return {
    visibilityState: "visible",
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    fire: () => listeners.forEach((fn) => fn()),
    listeners,
  };
};

describe("watchVersion", () => {
  let served;
  let fetch;
  let doc;
  beforeEach(() => {
    vi.useFakeTimers();
    served = { ok: true, body: { build: "a" } };
    fetch = vi.fn(async () => ({ ok: served.ok, json: async () => served.body }));
    doc = fakeDoc();
  });
  afterEach(() => vi.useRealTimers());

  const watch = (onNew, current = "a") => watchVersion({ current, onNew, fetch, doc });

  it("tells once per new build, polling every minute without the cache", async () => {
    const onNew = vi.fn();
    watch(onNew);
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetch).toHaveBeenCalledWith("/version.json", { cache: "no-store" });
    expect(onNew).not.toHaveBeenCalled();
    served.body = { build: "b" };
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith("b");
    served.body = { build: "c" };
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onNew).toHaveBeenLastCalledWith("c");
  });

  it("checks when the tab comes back, and shrugs off errors and junk", async () => {
    const onNew = vi.fn();
    watch(onNew);
    served = { ok: false, body: { build: "b" } };
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    served = { ok: true, body: { nope: 1 } };
    doc.fire();
    fetch.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onNew).not.toHaveBeenCalled();
    served.body = { build: "b" };
    doc.visibilityState = "hidden";
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).not.toHaveBeenCalled();
    doc.visibilityState = "visible";
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).toHaveBeenCalledWith("b");
  });

  it("does nothing in dev, and stops when told", async () => {
    const onNew = vi.fn();
    watch(onNew, "dev");
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetch).not.toHaveBeenCalled();
    const stop = watch(onNew);
    stop();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetch).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });
});
