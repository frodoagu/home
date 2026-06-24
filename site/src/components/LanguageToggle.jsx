import { Languages } from "lucide-react";
import { useLanguage } from "../i18n/LanguageProvider";

export default function LanguageToggle() {
  const { language, setLanguage } = useLanguage();

  return (
    <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-2 py-1">
      <Languages size={14} className="text-slate-500" />
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
  );
}
