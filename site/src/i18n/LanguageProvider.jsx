import { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "site:language";
const SUPPORTED = ["es", "en"];

function normalizeLanguage(raw) {
  if (!raw || typeof raw !== "string") return "es";
  return raw.toLowerCase().startsWith("es") ? "es" : "en";
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

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      toggleLanguage: () => setLanguage((cur) => (cur === "es" ? "en" : "es")),
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used inside <LanguageProvider>");
  }
  return ctx;
}
