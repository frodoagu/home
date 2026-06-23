import { useEffect, useRef } from "react";
import { ArrowUpRight, Lock, LogOut, ShieldAlert } from "lucide-react";
import { useAuth } from "./auth/AuthProvider";
import { privateLinks } from "./apps/registry";

// The private half of the landing: external links to other self-hosted
// services, revealed only after a Google sign-in with an allowed email.
export default function PrivateSection({ active }) {
  const { user, authorized, signOut } = useAuth();

  const visible = active
    ? privateLinks.filter((link) => link.categories?.includes(active))
    : privateLinks;

  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
          <Lock size={13} />
          {active ? `Privado · ${active}` : "Privado"}
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
              Salir
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
          Nada privado en <span className="text-slate-300">{active}</span>.
        </p>
      )}
    </section>
  );
}

function SignInGate() {
  const { renderButton, ready } = useAuth();
  const btnRef = useRef(null);

  useEffect(() => {
    renderButton(btnRef.current);
  }, [renderButton]);

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-5 py-10 text-center">
      <div className="rounded-lg border border-slate-800 bg-slate-950 p-2.5 text-amber-300">
        <Lock size={20} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-slate-100">Zona privada</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
          Accesos a los servicios self-hosted. Iniciá sesión con Google para
          verlos.
        </p>
      </div>
      <div ref={btnRef} className="min-h-[40px]" />
      {!ready && (
        <p className="text-xs text-slate-600">Cargando Google…</p>
      )}
    </div>
  );
}

function NotAuthorized() {
  const { user } = useAuth();
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 px-5 py-10 text-center">
      <div className="rounded-lg border border-amber-500/30 bg-slate-950 p-2.5 text-amber-300">
        <ShieldAlert size={20} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-slate-100">Sin acceso</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-400">
          La cuenta <span className="text-slate-300">{user?.email}</span> no está
          autorizada para esta sección.
        </p>
      </div>
    </div>
  );
}

function LinkCard({ link }) {
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
      <h3 className="text-base font-semibold text-slate-100">{link.title}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-400">{link.description}</p>
      {link.tag && (
        <span
          className="mt-3 self-start rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: accent,
            backgroundColor: accent + "14",
            border: `1px solid ${accent}33`,
          }}
        >
          {link.tag}
        </span>
      )}
    </a>
  );
}
