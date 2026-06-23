import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { getApp } from "./apps/registry";

// Wraps a registered app: a thin top bar with a back link, then the app itself.
export default function AppHost() {
  const { slug } = useParams();
  const app = getApp(slug);

  if (!app) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
        <p className="text-slate-400">No encontré esa app.</p>
        <Link to="/" className="text-sm text-amber-400 hover:underline">
          ← Volver al inicio
        </Link>
      </div>
    );
  }

  const { Component } = app;

  return (
    <div className="flex min-h-full flex-col bg-slate-950">
      <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2.5">
        <Link
          to="/"
          className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
        >
          <ArrowLeft size={16} />
          Inicio
        </Link>
        <span className="text-slate-700">/</span>
        <span className="text-sm text-slate-300">{app.title}</span>
      </div>
      <div className="flex-1">
        <Component />
      </div>
    </div>
  );
}
