import { Zap } from "lucide-react";
import NeutralCurrentVisualizer from "./NeutralCurrentVisualizer";

/* -------------------------------------------------------------------------
 * App registry — single source of truth for the landing grid and routing.
 * Add a new tool by importing its component and pushing an entry here.
 *   slug        URL segment: /app/<slug>  (must be unique, kebab-case)
 *   title       card heading
 *   description one-liner shown on the card
 *   tag         small category label (e.g. "Electricidad", "DevOps")
 *   icon        a lucide-react icon component
 *   accent      hex color for the card accent
 *   Component   the React component rendered at /app/<slug>
 * ---------------------------------------------------------------------- */
export const apps = [
  {
    slug: "corriente-neutro",
    title: "Corriente de Neutro",
    description: "Visualizador de fases y consumo en un sistema trifásico (3F + N).",
    tag: "Electricidad",
    icon: Zap,
    accent: "#f59e0b",
    Component: NeutralCurrentVisualizer,
  },
];

export const getApp = (slug) => apps.find((a) => a.slug === slug);
