// Usage reports for psy-sync (POST /api/stats): seconds the loop played and a
// few counts (exports, shares, autopilot starts), keyed by this browser's
// visitor id, the one the session check already registers. Nothing else
// leaves the page. Each report carries only what happened since the last one;
// psy-sync adds it to the browser's day.
import { visitorId } from "./cloud.js";

export const EVENTS = ["recordings", "recorded", "renders", "presets", "snapshots", "shares", "autopilot"];
const INTERVAL_MS = 5 * 60 * 1000;

export function createStats({
  engine,
  storage,
  fetch = globalThis.fetch?.bind(globalThis),
  base = "/api",
  intervalMs = INTERVAL_MS,
} = {}) {
  const pending = {};
  let sentPlayed = 0; // whole seconds already reported; the fraction waits

  /** The report due now, or null when there is nothing to say. */
  function take() {
    const played = Math.floor(engine.playedSeconds() - sentPlayed);
    const body = { ...(played > 0 ? { played } : {}) };
    for (const event of EVENTS) if (pending[event]) body[event] = Math.round(pending[event]);
    if (!Object.keys(body).length) return null;
    sentPlayed += played > 0 ? played : 0;
    for (const event of EVENTS) delete pending[event];
    return body;
  }

  // A report that never reached the server comes back for the next one.
  function giveBack(body) {
    if (body.played) sentPlayed -= body.played;
    for (const event of EVENTS) if (body[event]) pending[event] = (pending[event] ?? 0) + body[event];
  }

  return {
    /** Something happened: `n` more of `event` (seconds, for "recorded"). */
    count(event, n = 1) {
      pending[event] = (pending[event] ?? 0) + n;
    },

    /** Sends what is due. keepalive lets it finish while the page goes away. */
    async report() {
      const visitor = visitorId(storage);
      const body = visitor && take();
      if (!body) return;
      try {
        await fetch(`${base}/stats`, {
          method: "POST",
          credentials: "same-origin",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visitor, ...body }),
        });
      } catch {
        giveBack(body);
      }
    },

    /** Reports every `intervalMs` while the page lives. Returns stop(). */
    start() {
      const timer = setInterval(() => this.report(), intervalMs);
      return () => clearInterval(timer);
    },
  };
}
