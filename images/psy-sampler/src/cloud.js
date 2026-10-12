// Cloud save client for the psy-sync API (images/psy-sync). Keeps the
// workspace of the signed-in Google account in sync with this browser:
//
//   - every local save marks the workspace dirty; a debounced PUT uploads it
//     with `base` = the server version it was built on
//   - on sign-in / page load, reconcile() decides between pulling, pushing,
//     doing nothing, or asking (both sides changed)
//   - a 409 on upload means another device saved meanwhile: same question
//   - the account plays on one device at a time: signing in (or a page load
//     signed in) claims it from psy-sync, and with another device on it,
//     ask() waits for you to take it over before anything syncs. The holder
//     beats every BEAT_MS; the one that lost it hears so (on a beat or an
//     upload), forfeits what it never uploaded and calls onDropped()
//
// What was last synced is remembered per browser (META_KEY) as the server's
// updatedAt plus a hash of the content, so "dirty" survives a reload.
//
// The session check also carries a random id for this browser (VISITOR_KEY),
// which is how psy-sync counts visitors that never sign in.
import { hashSeed } from "./share.js";

const META_KEY = "psy-sampler:cloud";
const VISITOR_KEY = "psy-sampler:visitor";
const DEBOUNCE_MS = 2500;
const BEAT_MS = 10_000;

export const contentHash = (state) => hashSeed(JSON.stringify(state ?? null));

/**
 * What to do when both copies are known. `remote`: { state, updatedAt } or
 * null; `meta`: { at, hash } of the last sync from this browser or null;
 * `pristine`: the local workspace is untouched factory data.
 *   push      the server has nothing newer than what we built on
 *   pull      the server is newer and nothing changed here
 *   none      already in sync
 *   conflict  both changed: the user picks
 */
export function reconcile({ remote, meta, local, pristine = false }) {
  const dirty = !pristine && (!meta || meta.hash !== contentHash(local));
  if (!remote) return "push";
  if (contentHash(remote.state) === contentHash(local)) return "adopt";
  if (meta && remote.updatedAt === meta.at) return dirty ? "push" : "none";
  return dirty ? "conflict" : "pull";
}

/** This browser's random id, created on first use; null without storage (or crypto). */
export function visitorId(storage) {
  try {
    let id = storage?.getItem(VISITOR_KEY);
    if (!id) {
      id = globalThis.crypto.randomUUID();
      storage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

export function createCloud({
  fetch = globalThis.fetch?.bind(globalThis),
  storage,
  base = "/api",
  debounceMs = DEBOUNCE_MS,
  beatMs = BEAT_MS,
  playing = () => false,
  ask = async () => {},
  onDropped = () => {},
} = {}) {
  // checking: the first init() has not answered yet. savedAt: last time the
  // cloud copy matched this browser (ms), for the top bar.
  const info = { checking: true, available: false, clientId: null, user: null, phase: "idle", savedAt: null };
  const listeners = new Set();
  let timer = null;
  let pending = null; // the snapshot waiting for the debounce
  let busy = null; // the PUT in flight
  let initing = null; // the init() on its way: a remount meanwhile joins it
  let device; // this browser's id (the visitor id), the account's lease is on it
  let holding = false; // this device has the account: it may upload
  let beat = null;
  let latest = null; // the last local save, for what a drop forfeits

  const emit = (event, data) => listeners.forEach((fn) => fn(event, data));
  const setPhase = (phase) => {
    info.phase = phase;
    emit("phase", phase);
  };

  function readMeta() {
    try {
      const meta = JSON.parse(storage?.getItem(META_KEY) ?? "null");
      return meta && meta.email === info.user?.email ? meta : null;
    } catch {
      return null;
    }
  }
  function writeMeta(meta) {
    try {
      if (meta) storage?.setItem(META_KEY, JSON.stringify({ ...meta, email: info.user?.email }));
      else storage?.removeItem(META_KEY);
    } catch {
      // Without storage every load reconciles from scratch; still correct.
    }
  }

  async function call(method, path, body, { headers = {}, ...extra } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...extra,
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, data: type.includes("application/json") ? await res.json() : null };
  }

  const deviceId = () => {
    if (device === undefined) device = visitorId(storage) ?? globalThis.crypto?.randomUUID?.() ?? null;
    return device;
  };

  async function sendBeat(take = false) {
    const { status, data } = await call("PUT", "/device", { device: deviceId(), playing: Boolean(playing()), take });
    return status === 409 ? { taken: true, playing: data?.playing === true } : { taken: false };
  }

  // Resolves once this device holds the account. A server without leases
  // (older, or unreachable) answers anything but 409: held.
  async function hold() {
    if (deviceId()) {
      const first = await sendBeat().catch(() => ({ taken: false }));
      if (first.taken) {
        await ask({ playing: first.playing });
        await sendBeat(true).catch(() => {});
      }
    }
    holding = true;
    clearInterval(beat);
    beat = setInterval(heartbeat, beatMs);
  }

  function letGo() {
    holding = false;
    clearInterval(beat);
    beat = null;
  }

  async function heartbeat() {
    if (!holding) return;
    try {
      if ((await sendBeat()).taken) drop();
    } catch {
      // Offline: the next beat tries again.
    }
  }

  // Another device took the account. What never went up stays out: marking
  // the last local save as synced makes the next load pull the other
  // device's copy instead of asking which one to keep.
  function drop() {
    if (!holding) return;
    letGo();
    clearTimeout(timer);
    timer = null;
    pending = null;
    const meta = readMeta();
    if (meta && latest) writeMeta({ at: meta.at, hash: contentHash(latest) });
    setPhase("idle");
    onDropped();
  }

  async function push(snapshot, { force = false, keepalive = false } = {}) {
    const meta = readMeta();
    setPhase("saving");
    try {
      const { status, data } = await call(
        "PUT",
        "/state",
        { state: snapshot, base: meta?.at ?? null, force, device: deviceId() },
        { keepalive },
      );
      if (status === 200) {
        writeMeta({ at: data.updatedAt, hash: contentHash(snapshot) });
        info.savedAt = Date.now();
        setPhase("saved");
        return { ok: true };
      }
      if (status === 409 && data?.taken) {
        drop();
        return { taken: true };
      }
      if (status === 409) {
        setPhase("conflict");
        return { conflict: data };
      }
      if (status === 401) info.user = null;
      setPhase("error");
      return { error: status };
    } catch {
      setPhase("offline");
      return { error: "offline" };
    }
  }

  async function flushPending(opts) {
    clearTimeout(timer);
    timer = null;
    const snapshot = pending;
    pending = null;
    if (!snapshot || !info.user || !holding) return;
    await busy;
    busy = push(snapshot, opts).then((result) => {
      if (result.conflict) emit("conflict", result.conflict);
      return result;
    });
    await busy;
  }

  return {
    info,
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Is the API there, and who is signed in (holding the account). Never throws. */
    init() {
      initing ??= (async () => {
        try {
          const health = await call("GET", "/health");
          info.available = Boolean(health.data?.ok);
          if (info.available) {
            info.clientId = health.data.clientId;
            const visitor = visitorId(storage);
            const me = await call("GET", "/session", undefined, visitor ? { headers: { "x-psy-visitor": visitor } } : {});
            if (me.data?.email) await hold();
            info.user = me.data?.email ? me.data : null;
          }
        } catch {
          info.available = false;
        } finally {
          info.checking = false;
          initing = null;
        }
        emit("info", info);
        return info;
      })();
      return initing;
    },

    async signIn(credential) {
      const { status, data } = await call("POST", "/session", { credential });
      if (status !== 200) throw new Error(data?.error ?? `HTTP ${status}`);
      await hold();
      info.user = data;
      emit("user", data);
      return data;
    },

    async signOut() {
      await flushPending();
      await this.release();
      await call("DELETE", "/session").catch(() => {});
      writeMeta(null);
      info.user = null;
      setPhase("idle");
      emit("user", null);
    },

    async deleteAccount() {
      clearTimeout(timer);
      pending = null;
      letGo();
      const { status } = await call("DELETE", "/account");
      if (status !== 204) throw new Error(`HTTP ${status}`);
      writeMeta(null);
      info.user = null;
      setPhase("idle");
      emit("user", null);
    },

    /** Compares with the server: { action, remote } (see reconcile). */
    async check(local, pristine) {
      const { status, data } = await call("GET", "/state");
      if (status !== 200 && status !== 404) throw new Error(`HTTP ${status}`);
      const remote = status === 200 ? data : null;
      return { action: reconcile({ remote, meta: readMeta(), local, pristine }), remote };
    },

    /** The local copy now matches `remote` (pulled or identical). */
    adopt(remote, local) {
      writeMeta({ at: remote.updatedAt, hash: contentHash(local) });
      info.savedAt = Date.now();
      setPhase("saved");
    },

    push,

    /** A local save: upload it after a quiet moment, if it changed. */
    changed(snapshot) {
      latest = snapshot;
      if (!info.user) return;
      if (readMeta()?.hash === contentHash(snapshot)) return;
      pending = snapshot;
      setPhase("pending");
      clearTimeout(timer);
      timer = setTimeout(() => flushPending(), debounceMs);
    },

    /** Upload now (the page is being hidden: keepalive survives the unload). */
    flush: () => flushPending({ keepalive: true }),

    /** Beat now (the tab came back: a device that lost it hears so at once). */
    beat: heartbeat,

    /** Let go of the account (the tab is closing): the next device takes it without asking. */
    async release() {
      if (!holding) return;
      letGo();
      if (deviceId()) await call("DELETE", "/device", { device: deviceId() }, { keepalive: true }).catch(() => {});
    },
  };
}
