import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStats } from "./stats.js";

describe("createStats", () => {
  let seconds;
  let sent;
  let fetch;
  let storage;
  const make = (opts = {}) => createStats({ engine: { playedSeconds: () => seconds }, storage, fetch, ...opts });
  const bodies = () => sent.map(([, init]) => JSON.parse(init.body));

  beforeEach(() => {
    seconds = 0;
    sent = [];
    fetch = vi.fn(async (...args) => {
      sent.push(args);
      return { status: 204 };
    });
    const data = new Map([["psy-sampler:visitor", "visitor-0123456789abcdef"]]);
    storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  });

  afterEach(() => vi.useRealTimers());

  it("sends nothing when nothing happened", async () => {
    await make().report();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports whole seconds played and the counts since the last report, once", async () => {
    const stats = make();
    seconds = 90.7;
    stats.count("renders");
    stats.count("recordings");
    stats.count("recorded", 12.4);
    await stats.report();
    seconds = 100.2;
    stats.count("shares");
    await stats.report();
    await stats.report();
    expect(bodies()).toEqual([
      { visitor: "visitor-0123456789abcdef", played: 90, renders: 1, recordings: 1, recorded: 12 },
      // The 0.7 s left over from the first report rides along here.
      { visitor: "visitor-0123456789abcdef", played: 10, shares: 1 },
    ]);
    expect(sent[0][0]).toBe("/api/stats");
    expect(sent[0][1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("keeps a report that never arrived for the next one", async () => {
    const stats = make();
    seconds = 30;
    stats.count("presets");
    fetch.mockRejectedValueOnce(new Error("offline"));
    await stats.report();
    seconds = 40;
    await stats.report();
    expect(bodies()).toEqual([{ visitor: "visitor-0123456789abcdef", played: 40, presets: 1 }]);
  });

  it("stays quiet without storage for the visitor id", async () => {
    const stats = make({ storage: null });
    seconds = 30;
    await stats.report();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports on its interval until stopped", async () => {
    vi.useFakeTimers();
    const stats = make({ intervalMs: 1000 });
    const stop = stats.start();
    seconds = 5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(bodies()).toEqual([{ visitor: "visitor-0123456789abcdef", played: 5 }]);
    stop();
    seconds = 9;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
