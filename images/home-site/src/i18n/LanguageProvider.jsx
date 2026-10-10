import { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "site:language";
export const SUPPORTED = ["es", "en", "pt"];

function normalizeLanguage(raw) {
  if (!raw || typeof raw !== "string") return "es";
  const base = raw.toLowerCase().slice(0, 2);
  return SUPPORTED.includes(base) ? base : "en";
}

function detectBrowserLanguage() {
  if (typeof navigator === "undefined") return "es";
  const primary = navigator.languages?.[0] || navigator.language;
  return normalizeLanguage(primary);
}

function sanitizeLanguage(raw) {
  if (!raw) return null;
  const lang = normalizeLanguage(raw);
  return SUPPORTED.includes(lang) ? lang : null;
}

export function localizeText(value, language) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.es === "string" || typeof value.en === "string") {
    return value[language] || value.es || value.en || "";
  }
  return value;
}

// Inline form of localizeText for one-off strings.
export const pick = (language, es, en, pt) => localizeText({ es, en, pt }, language);

const LanguageContext = createContext(null);

export function LanguageProvider({ children, initialLanguage }) {
  const [language, setLanguage] = useState(() => {
    const fromProp = sanitizeLanguage(initialLanguage);
    if (fromProp) return fromProp;

    if (typeof localStorage !== "undefined") {
      const saved = sanitizeLanguage(localStorage.getItem(STORAGE_KEY));
      if (saved) return saved;
    }

    return detectBrowserLanguage();
  });

  useEffect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, language);
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = language;
    }
  }, [language]);

  const value = useMemo(() => ({ language, setLanguage }), [language]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used inside <LanguageProvider>");
  }
  return ctx;
}
