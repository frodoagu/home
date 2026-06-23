import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { apps } from "./apps/registry";

const TAGLINE = [
  "DevOps",
  "Motoviajero",
  "Endurero",
  "Papá",
  "Oficios",
];

export default function Landing() {
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
          <div className="mt-4 flex flex-wrap gap-2">
            {TAGLINE.map((t) => (
              <span
                key={t}
                className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-xs text-slate-400"
              >
                {t}
              </span>
            ))}
          </div>
        </header>

        {/* App grid */}
        <section>
          <h2 className="mb-4 text-xs font-medium uppercase tracking-wide text-slate-500">
            Apps
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => (
              <AppCard key={app.slug} app={app} />
            ))}
          </div>
        </section>

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
