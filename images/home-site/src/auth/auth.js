import { ALLOWED_EMAILS } from "./config";

/* -------------------------------------------------------------------------
 * Pure auth helpers (no React) for the client-side Google sign-in: JWT decode,
 * the persisted-session storage, the user mapping and the allowlist check.
 * Kept separate from AuthProvider so they can be unit-tested in isolation.
 * ---------------------------------------------------------------------- */

export const STORAGE_KEY = "agu.auth.user";

// Decode the payload of a JWT (base64url) without verifying the signature —
// good enough for reading public claims client-side. Returns null on garbage.
export function decodeJwt(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    // Handle UTF-8 (e.g. accents in the name).
    const decoded = decodeURIComponent(
      json
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join(""),
    );
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

// Map Google ID-token claims to the user object we persist/use, or null if the
// token has no email.
export function userFromClaims(claims) {
  if (!claims?.email) return null;
  return {
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: claims.name || claims.email,
    picture: claims.picture || "",
    exp: claims.exp,
  };
}

// Read the persisted session, dropping it if missing or expired (exp in seconds).
export function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw);
    if (!user?.exp || user.exp * 1000 < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

export function storeUser(user) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

export function clearStoredUser() {
  localStorage.removeItem(STORAGE_KEY);
}

// A user is authorized only if their email is verified and in the allowlist
// (compared case-insensitively).
export function isAuthorized(user) {
  if (!user?.email || !user.emailVerified) return false;
  return ALLOWED_EMAILS.map((e) => e.toLowerCase()).includes(user.email.toLowerCase());
}
