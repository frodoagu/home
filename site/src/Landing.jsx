import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { apps, CATEGORIES, privateLinks } from "./apps/registry";
import PrivateSection from "./PrivateSection";

export default function Landing() {
  // null = no filter (show everything). Clicking the active chip clears it.
  const [active, setActive] = useState(null);

  const toggle = (cat) => setActive((cur) => (cur === cat ? null : cat));

  const visible = active
    ? apps.filter((app) => app.categories?.includes(active))
    : apps;

  return (
    <div className="min-h-full bg-slate-950 text-slate-100 font-sans">
      <div className="mx-auto max-w-5xl px-5 py-12 sm:py-16">
        {/* Header */}
        <header className="mb-10 sm:mb-14">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">Agu</h1>
          <p className="mt-2 text-slate-400 max-w-2xl">
            Herramientas y experimentos web que voy armando. Cosas de oficios,
            infra y lo que se cruce.
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
                  {cat}
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
              {active ? `Públicas · ${active}` : "Públicas"}
            </h2>
            {active && (
              <button
                onClick={() => setActive(null)}
                className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
              >
                limpiar filtro
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
              Todavía no hay apps en <span className="text-slate-300">{active}</span>. Pronto. 🛠️
            </p>
          )}
        </section>

        {/* Private half — external links to self-hosted services, gated by Google sign-in. */}
        <PrivateSection active={active} />

        <footer className="mt-16 text-xs text-slate-600">
          agu.com.ar · self-hosted en un Raspberry Pi 🍓
        </footer>
      </div>
    </div>
  );
}

function AppCard({ app }) {
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
      <h3 className="text-base font-semibold text-slate-100">{app.title}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-400">{app.description}</p>
      {app.tag && (
        <span
          className="mt-3 self-start rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: accent,
            backgroundColor: accent + "14",
            border: `1px solid ${accent}33`,
          }}
        >
          {app.tag}
        </span>
      )}
    </Link>
  );
}
