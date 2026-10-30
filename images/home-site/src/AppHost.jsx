import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { getApp } from "./apps/registry";
import LanguageToggle from "./components/LanguageToggle";
import { localizeText, useLanguage } from "./i18n/LanguageProvider";
import NotFound from "./NotFound";
import { appTitle } from "./seo";

// Wraps a registered app: a thin top bar with a back link, then the app itself.
export default function AppHost() {
  const { language } = useLanguage();
  const { slug } = useParams();
  const app = getApp(slug);

  const txt = {
    es: { home: "Inicio" },
    en: { home: "Home" },
    pt: { home: "Início" },
    fr: { home: "Accueil" },
  }[language];

  useEffect(() => {
    if (app) document.title = appTitle(app, language);
  }, [app, language]);

  if (!app) return <NotFound />;

  const { Component } = app;

  return (
    <div className="flex min-h-full flex-col bg-slate-950">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
          >
            <ArrowLeft size={16} />
            {txt.home}
          </Link>
          <span className="text-slate-700">/</span>
          <span className="text-sm text-slate-300">{localizeText(app.title, language)}</span>
        </div>
        <LanguageToggle />
      </div>
      <div className="flex-1">
        <Component />
      </div>
    </div>
  );
}
