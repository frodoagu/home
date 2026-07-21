import { Languages } from "lucide-react";
import { useLanguage } from "../i18n/LanguageProvider";

export default function LanguageToggle() {
  const { language, setLanguage } = useLanguage();

  const label = language === "es" ? "Idioma" : "Language";

  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-2 py-1">
      <Languages size={14} className="text-slate-500" />

      <label className="sm:hidden">
        <span className="sr-only">{label}</span>
        <select
          aria-label={label}
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] font-medium text-slate-200 focus:outline-none"
        >
          <option value="es">ES</option>
          <option value="en">EN</option>
        </select>
      </label>

      <div className="hidden items-center gap-1 sm:flex">
        <button
          onClick={() => setLanguage("es")}
          aria-pressed={language === "es"}
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
            language === "es"
              ? "bg-amber-400/20 text-amber-300"
              : "text-slate-500 hover:text-slate-200"
          }`}
        >
          ES
        </button>
        <button
          onClick={() => setLanguage("en")}
          aria-pressed={language === "en"}
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
            language === "en"
              ? "bg-amber-400/20 text-amber-300"
              : "text-slate-500 hover:text-slate-200"
          }`}
        >
          EN
        </button>
      </div>
    </div>
  );
}
