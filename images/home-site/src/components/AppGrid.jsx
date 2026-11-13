import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { localizeText, useLanguage } from "../i18n/LanguageProvider";

// The landing's cards, public apps and private links alike (apps/registry.jsx).
export default function AppGrid({ apps }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {apps.map((app) => (
        <AppCard key={app.slug} app={app} />
      ))}
    </div>
  );
}

function AppCard({ app }) {
  const { language } = useLanguage();
  const { icon: Icon, accent } = app;
  const className = `group relative flex flex-col rounded-xl border border-slate-800 bg-slate-900 p-5
                 transition-colors hover:border-slate-600 hover:bg-slate-800/60`;
  const body = (
    <>
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
    </>
  );
  // Apps on their own subdomain link out; the rest are routed in-app.
  return app.href ? (
    <a href={app.href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : (
    <Link to={`/app/${app.slug}`} className={className}>
      {body}
    </Link>
  );
}
