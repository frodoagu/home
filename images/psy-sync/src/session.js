// Stateless session cookie: "<sub>.<expiry ms>.<HMAC-SHA256>", signed with a
// key that lives next to the database. Revocation is the user row: a valid
// cookie for a deleted account opens nothing.

export const COOKIE = "psy_session";
export const SESSION_MS = 30 * 24 * 3600 * 1000;

const enc = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function signSession(key, sub, expires) {
  const payload = `${sub}.${expires}`;
  return `${payload}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)))}`;
}

/** The session's sub, or null when the value is forged, malformed or expired. */
export async function readSession(key, value, now) {
  const m = /^([^.]+)\.(\d+)\.([\w-]+)$/.exec(value ?? "");
  if (!m || Number(m[2]) <= now) return null;
  const expected = await signSession(key, m[1], m[2]);
  // Compare as HMACs of both, so the check takes the same time for any input.
  const [a, b] = await Promise.all([value, expected].map((v) => crypto.subtle.sign("HMAC", key, enc.encode(v))));
  return b64url(a) === b64url(b) ? m[1] : null;
}

export function cookieValue(req) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

export const setCookie = (value, maxAgeS) =>
  `${COOKIE}=${value}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
