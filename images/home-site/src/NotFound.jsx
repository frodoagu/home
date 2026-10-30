import { useEffect } from "react";
import { Link } from "react-router";
import { pick, useLanguage } from "./i18n/LanguageProvider";
import { notFoundTitle } from "./seo";

// Any unknown route, including an unregistered /app/<slug>. Prerendered as
// 404.html, which nginx serves with a real 404 status.
export default function NotFound() {
  const { language } = useLanguage();

  useEffect(() => {
    document.title = notFoundTitle(language);
  }, [language]);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
      <p className="text-slate-400">
        {pick(language, "No encontre esa pagina.", "I could not find that page.", "Não encontrei essa página.", "Je n'ai pas trouvé cette page.")}
      </p>
      <Link to="/" className="text-sm text-amber-400 hover:underline">
        ← {pick(language, "Volver al inicio", "Back to home", "Voltar ao início", "Retour à l'accueil")}
      </Link>
    </div>
  );
}
