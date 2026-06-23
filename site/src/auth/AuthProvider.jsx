import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ALLOWED_EMAILS, GOOGLE_CLIENT_ID } from "./config";

/* -------------------------------------------------------------------------
 * Client-side Google sign-in (Google Identity Services).
 *
 * No backend: the GIS script returns a signed JWT ID token in the browser. We
 * decode it for the email/name/picture, persist it until it expires, and treat
 * any email in ALLOWED_EMAILS as authorized. This gates the private section at
 * the UX level only — the services behind the links keep their own auth.
 * ---------------------------------------------------------------------- */

const STORAGE_KEY = "agu.auth.user";
const GSI_SRC = "https://accounts.google.com/gsi/client";

const AuthContext = createContext(null);

// Decode the payload of a JWT (base64url) without verifying the signature —
// good enough for reading public claims client-side.
function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
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

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw);
    // exp is in seconds (JWT convention).
    if (!user?.exp || user.exp * 1000 < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

// Load the GIS script once and resolve when window.google is ready.
let gsiPromise = null;
function loadGsi() {
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const script = document.createElement("script");
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("No se pudo cargar Google Identity"));
    document.head.appendChild(script);
  });
  return gsiPromise;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => loadStoredUser());
  const [ready, setReady] = useState(false);

  // Keep the latest setter available to the GIS callback without re-initializing.
  const handleCredential = useCallback((response) => {
    const claims = decodeJwt(response?.credential || "");
    if (!claims?.email) return;
    const next = {
      email: claims.email,
      emailVerified: claims.email_verified === true,
      name: claims.name || claims.email,
      picture: claims.picture || "",
      exp: claims.exp,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setUser(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadGsi()
      .then((google) => {
        if (cancelled) return;
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredential,
          auto_select: false,
        });
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      cancelled = true;
    };
  }, [handleCredential]);

  const renderButton = useCallback(
    (el) => {
      if (!el || !ready || !window.google?.accounts?.id) return;
      el.innerHTML = "";
      window.google.accounts.id.renderButton(el, {
        theme: "filled_black",
        size: "large",
        shape: "pill",
        text: "signin_with",
        locale: "es",
      });
    },
    [ready],
  );

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    window.google?.accounts?.id?.disableAutoSelect?.();
    setUser(null);
  }, []);

  const authorized = useMemo(() => {
    if (!user?.email || !user.emailVerified) return false;
    return ALLOWED_EMAILS.map((e) => e.toLowerCase()).includes(
      user.email.toLowerCase(),
    );
  }, [user]);

  const value = useMemo(
    () => ({ user, authorized, ready, renderButton, signOut }),
    [user, authorized, ready, renderButton, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
