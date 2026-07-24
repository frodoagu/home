import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Linkedin, Mail } from "lucide-react";
import { apps, CATEGORIES, getCategoryLabel, privateLinks } from "./apps/registry";
import PrivateSection from "./PrivateSection";
import LanguageToggle from "./components/LanguageToggle";
import { localizeText, useLanguage } from "./i18n/LanguageProvider";

export default function Landing() {
  const { language } = useLanguage();
  // null = no filter (show everything). Clicking the active chip clears it.
  const [active, setActive] = useState(null);

  const toggle = (cat) => setActive((cur) => (cur === cat ? null : cat));

  const visible = active
    ? apps.filter((app) => app.categories?.includes(active))
    : apps;

  const txt = language === "es"
    ? {
        intro: "Herramientas y experimentos web que voy armando. Cosas de oficios, infra y lo que se cruce.",
        publicTitle: "Publicas",
        privateLabel: "Privadas",
        clearFilter: "limpiar filtro",
        empty: "Todavia no hay apps en",
        soon: "Pronto.",
        footer: "agu.com.ar · self-hosted en un Raspberry Pi",
      }
    : {
        intro: "Web tools and experiments I keep building. A mix of trades, infra, and whatever comes next.",
        publicTitle: "Public",
        privateLabel: "Private",
        clearFilter: "clear filter",
        empty: "No apps yet in",
        soon: "Soon.",
        footer: "agu.com.ar · self-hosted on a Raspberry Pi",
      };

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 font-sans">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
        {/* Header */}
        <header className="mb-10 sm:mb-14">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Agu</h1>
            <LanguageToggle />
          </div>
          <p className="mt-2 text-slate-400 max-w-2xl">
            {txt.intro}
          </p>

          {/* Identity facets — click to filter the apps below */}
          <div className="mt-4 flex flex-wrap gap-2">
            {CATEGORIES.map((cat) => {
              const isActive = active === cat;
              const count = [...apps, ...privateLinks].filter((a) =>
                a.categories?.includes(cat),
              ).length;
              return (
                <button
                  key={cat}
                  onClick={() => toggle(cat)}
                  aria-pressed={isActive}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    isActive
                      ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                      : "border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                  }`}
                >
                  {getCategoryLabel(cat, language)}
                  <span className="ml-1.5 text-[10px] text-slate-600">{count}</span>
                </button>
              );
            })}
          </div>
        </header>

        {/* App grid */}
        <section>
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {active ? `${txt.publicTitle} · ${getCategoryLabel(active, language)}` : txt.publicTitle}
            </h2>
            {active && (
              <button
                onClick={() => setActive(null)}
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
              >
                {txt.clearFilter}
              </button>
            )}
          </div>

          {visible.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((app) => (
                <AppCard key={app.slug} app={app} />
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-5 py-8 text-center text-sm text-slate-500">
              {txt.empty} <span className="text-slate-300">{getCategoryLabel(active, language)}</span>. {txt.soon} 🛠️
            </p>
          )}
        </section>

        {/* Private half — external links to self-hosted services, gated by Google sign-in. */}
        <PrivateSection active={active} />

        <footer className="mt-16 flex flex-col gap-3 border-t border-slate-900 pt-6 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <span>{txt.footer} 🍓</span>
          <div className="flex items-center gap-4">
            <a
              href="https://www.linkedin.com/in/%E2%96%BAfederico-ag%C3%BA-75a85a60/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 transition-colors hover:text-slate-300"
            >
              <Linkedin size={14} /> LinkedIn
            </a>
            <a
              href="mailto:fede@agu.com.ar"
              className="flex items-center gap-1.5 transition-colors hover:text-slate-300"
            >
              <Mail size={14} /> fede@agu.com.ar
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}

function AppCard({ app }) {
  const { language } = useLanguage();
  const { icon: Icon, accent } = app;
  return (
    <Link
      to={`/app/${app.slug}`}
      className="group relative flex flex-col rounded-xl border border-slate-800 bg-slate-900 p-5
                 transition-colors hover:border-slate-600 hover:bg-slate-800/60"
    >
      <div className="mb-3 flex items-center justify-between">
        <div
          className="rounded-lg border border-slate-800 bg-slate-950 p-2"
          style={{ color: accent }}
        >
          <Icon size={20} />
        </div>
        <ArrowUpRight
          size={18}
          className="text-slate-600 transition-colors group-hover:text-slate-300"
        />
      </div>
      <h3 className="text-base font-semibold text-slate-100">{localizeText(app.title, language)}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-400">{localizeText(app.description, language)}</p>
      {localizeText(app.tag, language) && (
        <span
          className="mt-3 self-start rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: accent,
            backgroundColor: accent + "14",
            border: `1px solid ${accent}33`,
          }}
        >
          {localizeText(app.tag, language)}
        </span>
      )}
    </Link>
  );
}
