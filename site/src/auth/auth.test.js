import { describe, it, expect, beforeEach } from "vitest";
import {
  STORAGE_KEY,
  decodeJwt,
  userFromClaims,
  loadStoredUser,
  storeUser,
  clearStoredUser,
  isAuthorized,
} from "./auth";
import { ALLOWED_EMAILS } from "./config";

const ALLOWED = ALLOWED_EMAILS[0];

// Build a JWT-like token "header.payload.sig" with a UTF-8-safe base64url payload,
// exactly the inverse of what decodeJwt expects.
function makeJwt(claims) {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${b64url}.sig`;
}

describe("decodeJwt", () => {
  it("decodifica los claims del payload", () => {
    const token = makeJwt({ email: "a@b.com", name: "Fede Agú", exp: 123 });
    expect(decodeJwt(token)).toMatchObject({ email: "a@b.com", name: "Fede Agú", exp: 123 });
  });

  it("devuelve null ante tokens inválidos", () => {
    expect(decodeJwt("")).toBeNull();
    expect(decodeJwt("no-es-un-jwt")).toBeNull();
    expect(decodeJwt(null)).toBeNull();
    expect(decodeJwt("header..sig")).toBeNull();
  });
});

describe("userFromClaims", () => {
  it("mapea los claims al usuario persistido", () => {
    const u = userFromClaims({
      email: "x@y.com",
      email_verified: true,
      name: "X",
      picture: "http://img",
      exp: 999,
    });
    expect(u).toEqual({
      email: "x@y.com",
      emailVerified: true,
      name: "X",
      picture: "http://img",
      exp: 999,
    });
  });

  it("usa el email como nombre si falta, y emailVerified=false si no es true", () => {
    const u = userFromClaims({ email: "x@y.com" });
    expect(u.name).toBe("x@y.com");
    expect(u.emailVerified).toBe(false);
    expect(u.picture).toBe("");
  });

  it("devuelve null si no hay email", () => {
    expect(userFromClaims(null)).toBeNull();
    expect(userFromClaims({})).toBeNull();
  });
});

describe("storage de la sesión", () => {
  beforeEach(() => localStorage.clear());

  it("storeUser + loadStoredUser hace round-trip si no expiró", () => {
    const user = { email: ALLOWED, emailVerified: true, exp: Math.floor(Date.now() / 1000) + 3600 };
    storeUser(user);
    expect(loadStoredUser()).toEqual(user);
  });

  it("loadStoredUser descarta sesiones expiradas", () => {
    const expired = { email: ALLOWED, exp: Math.floor(Date.now() / 1000) - 10 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expired));
    expect(loadStoredUser()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull(); // la limpia
  });

  it("loadStoredUser devuelve null sin sesión o con JSON corrupto", () => {
    expect(loadStoredUser()).toBeNull();
    localStorage.setItem(STORAGE_KEY, "{no-json");
    expect(loadStoredUser()).toBeNull();
  });

  it("clearStoredUser borra la sesión", () => {
    storeUser({ email: ALLOWED, exp: Date.now() });
    clearStoredUser();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("isAuthorized", () => {
  it("autoriza email en la allowlist con email verificado", () => {
    expect(isAuthorized({ email: ALLOWED, emailVerified: true })).toBe(true);
  });

  it("es case-insensitive con el email", () => {
    expect(isAuthorized({ email: ALLOWED.toUpperCase(), emailVerified: true })).toBe(true);
  });

  it("rechaza si el email no está verificado", () => {
    expect(isAuthorized({ email: ALLOWED, emailVerified: false })).toBe(false);
  });

  it("rechaza emails fuera de la allowlist y usuarios nulos", () => {
    expect(isAuthorized({ email: "intruso@evil.com", emailVerified: true })).toBe(false);
    expect(isAuthorized(null)).toBe(false);
    expect(isAuthorized({})).toBe(false);
  });
});
