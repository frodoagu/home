// Cloud save client for the psy-sync API (images/psy-sync). Keeps the
// workspace of the signed-in Google account in sync with this browser:
//
//   - every local save marks the workspace dirty; a debounced PUT uploads it
//     with `base` = the server version it was built on
//   - on sign-in / page load, reconcile() decides between pulling, pushing,
//     doing nothing, or asking (both sides changed)
//   - a 409 on upload means another device saved meanwhile: same question
//
// What was last synced is remembered per browser (META_KEY) as the server's
// updatedAt plus a hash of the content, so "dirty" survives a reload.
import { hashSeed } from "./share.js";

const META_KEY = "psy-sampler:cloud";
const DEBOUNCE_MS = 2500;

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

export function createCloud({ fetch = globalThis.fetch?.bind(globalThis), storage, base = "/api", debounceMs = DEBOUNCE_MS } = {}) {
  const info = { available: false, clientId: null, user: null, phase: "idle" };
  const listeners = new Set();
  let timer = null;
  let pending = null; // the snapshot waiting for the debounce
  let busy = null; // the PUT in flight

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

  async function call(method, path, body, extra = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...extra,
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, data: type.includes("application/json") ? await res.json() : null };
  }

  async function push(snapshot, { force = false, keepalive = false } = {}) {
    const meta = readMeta();
    setPhase("saving");
    try {
      const { status, data } = await call(
        "PUT",
        "/state",
        { state: snapshot, base: meta?.at ?? null, force },
        { keepalive },
      );
      if (status === 200) {
        writeMeta({ at: data.updatedAt, hash: contentHash(snapshot) });
        setPhase("saved");
        return { ok: true };
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
    if (!snapshot || !info.user) return;
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

    /** Is the API there, and who is signed in. Never throws. */
    async init() {
      try {
        const health = await call("GET", "/health");
        if (!health.data?.ok) return info;
        info.available = true;
        info.clientId = health.data.clientId;
        const me = await call("GET", "/session");
        info.user = me.data?.email ? me.data : null;
      } catch {
        info.available = false;
      }
      return info;
    },

    async signIn(credential) {
      const { status, data } = await call("POST", "/session", { credential });
      if (status !== 200) throw new Error(data?.error ?? `HTTP ${status}`);
      info.user = data;
      emit("user", data);
      return data;
    },

    async signOut() {
      await flushPending();
      await call("DELETE", "/session").catch(() => {});
      writeMeta(null);
      info.user = null;
      setPhase("idle");
      emit("user", null);
    },

    async deleteAccount() {
      clearTimeout(timer);
      pending = null;
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
      setPhase("saved");
    },

    push,

    /** A local save: upload it after a quiet moment, if it changed. */
    changed(snapshot) {
      if (!info.user) return;
      if (readMeta()?.hash === contentHash(snapshot)) return;
      pending = snapshot;
      setPhase("pending");
      clearTimeout(timer);
      timer = setTimeout(() => flushPending(), debounceMs);
    },

    /** Upload now (the page is being hidden: keepalive survives the unload). */
    flush: () => flushPending({ keepalive: true }),
  };
}
