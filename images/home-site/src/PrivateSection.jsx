import { useEffect, useRef } from "react";
import { ArrowUpRight, Lock, LogOut, ShieldAlert } from "lucide-react";
import { useAuth } from "./auth/AuthProvider";
import { getCategoryLabel, privateLinks } from "./apps/registry";
import { localizeText, useLanguage } from "./i18n/LanguageProvider";

// The private half of the landing: external links to other self-hosted
// services, revealed only after a Google sign-in with an allowed email.
export default function PrivateSection({ active }) {
  const { language } = useLanguage();
  const { user, authorized, signOut } = useAuth();

  const txt = language === "es"
    ? {
        title: "Privado",
        signOut: "Salir",
        empty: "Nada privado en",
      }
    : {
        title: "Private",
        signOut: "Sign out",
        empty: "No private links in",
      };

  const visible = active
    ? privateLinks.filter((link) => link.categories?.includes(active))
    : privateLinks;

  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          <Lock size={13} />
          {active ? `${txt.title} · ${getCategoryLabel(active, language)}` : txt.title}
        </h2>
        {user && (
          <div className="flex items-center gap-2">
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                referrerPolicy="no-referrer"
                className="h-6 w-6 rounded-full border border-slate-700"
              />
            ) : null}
            <span className="max-w-[10rem] truncate text-xs text-slate-400">
              {user.name}
            </span>
            <button
              onClick={signOut}
              className="flex items-center gap-1 rounded-full border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
            >
              <LogOut size={12} />
              {txt.signOut}
            </button>
          </div>
        )}
      </div>

      {!user ? (
        <SignInGate />
      ) : !authorized ? (
        <NotAuthorized />
      ) : visible.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((link) => (
            <LinkCard key={link.slug} link={link} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-5 py-8 text-center text-sm text-slate-500">
          {txt.empty} <span className="text-slate-300">{getCategoryLabel(active, language)}</span>.
        </p>
      )}
    </section>
  );
}

function SignInGate() {
  const { language } = useLanguage();
  const { renderButton, ready } = useAuth();
  const btnRef = useRef(null);

  const txt = language === "es"
    ? {
        title: "Zona privada",
        body: "Accesos a los servicios self-hosted. Inicia sesion con Google para verlos.",
        loading: "Cargando Google...",
      }
    : {
        title: "Private zone",
        body: "Access to self-hosted services. Sign in with Google to view them.",
        loading: "Loading Google...",
      };

  useEffect(() => {
    renderButton(btnRef.current);
  }, [renderButton]);

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-5 py-10 text-center">
      <div className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-amber-300">
        <Lock size={20} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-slate-100">{txt.title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
          {txt.body}
        </p>
      </div>
      <div ref={btnRef} className="min-h-[40px]" />
      {!ready && (
        <p className="text-xs text-slate-600">{txt.loading}</p>
      )}
    </div>
  );
}

function NotAuthorized() {
  const { language } = useLanguage();
  const { user } = useAuth();
  const txt = language === "es"
    ? {
        title: "Sin acceso",
        bodyStart: "La cuenta",
        bodyEnd: "no esta autorizada para esta seccion.",
      }
    : {
        title: "No access",
        bodyStart: "Account",
        bodyEnd: "is not authorized for this section.",
      };

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 px-5 py-10 text-center">
      <div className="rounded-lg border border-amber-500/30 bg-slate-950 p-2.5 text-amber-300">
        <ShieldAlert size={20} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-slate-100">{txt.title}</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
          {txt.bodyStart} <span className="text-slate-300">{user?.email}</span> {txt.bodyEnd}
        </p>
      </div>
    </div>
  );
}

function LinkCard({ link }) {
  const { language } = useLanguage();
  const { icon: Icon, accent } = link;
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
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
      <h3 className="text-base font-semibold text-slate-100">{localizeText(link.title, language)}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-400">{localizeText(link.description, language)}</p>
      {localizeText(link.tag, language) && (
        <span
          className="mt-3 self-start rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: accent,
            backgroundColor: accent + "14",
            border: `1px solid ${accent}33`,
          }}
        >
          {localizeText(link.tag, language)}
        </span>
      )}
    </a>
  );
}
