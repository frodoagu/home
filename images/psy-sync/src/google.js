// Google ID token verification (the credential "Sign in with Google" hands
// the browser). RS256 against Google's published keys, then the claims.

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const MIN_REFRESH_MS = 60_000; // an unknown kid refetches, at most this often
const SKEW_MS = 60_000;

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** Google's signing keys by kid, cached for the max-age Google sends. */
export function googleKeys({ fetch = globalThis.fetch, now = Date.now } = {}) {
  let keys = new Map();
  let expires = 0;
  let fetched = 0;

  async function refresh() {
    fetched = now();
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`certs: HTTP ${res.status}`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    const { keys: jwks } = await res.json();
    const next = new Map();
    for (const jwk of jwks) {
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      next.set(jwk.kid, key);
    }
    keys = next;
    expires = now() + maxAge * 1000;
  }

  return async (kid) => {
    if (now() >= expires || (!keys.has(kid) && now() - fetched >= MIN_REFRESH_MS)) await refresh();
    const key = keys.get(kid);
    if (!key) throw new Error("unknown signing key");
    return key;
  };
}

/** The token's claims if it is a valid, unexpired Google token for `clientId`; throws otherwise. */
export async function verifyIdToken(token, { clientId, getKey, now = Date.now }) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [head, body, sig] = parts;
  const header = b64urlJson(head);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const key = await getKey(header.kid);
  const data = new TextEncoder().encode(`${head}.${body}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), data))) {
    throw new Error("bad signature");
  }
  const claims = b64urlJson(body);
  if (claims.aud !== clientId) throw new Error("wrong audience");
  if (!ISSUERS.has(claims.iss)) throw new Error("wrong issuer");
  if (!(claims.exp * 1000 > now() - SKEW_MS)) throw new Error("expired");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new Error("email not verified");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("no subject");
  return claims;
}
