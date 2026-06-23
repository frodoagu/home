import { GitBranch, Home, Network, Sparkles, Zap } from "lucide-react";
import NeutralCurrentVisualizer from "./NeutralCurrentVisualizer";
import MandelbrotExplorer from "./MandelbrotExplorer";

/* -------------------------------------------------------------------------
 * Filter categories — the identity facets shown as chips on the landing.
 * Each app declares which of these it belongs to (`categories`), and the
 * chips filter the grid by them. Keep this list in sync with app entries.
 * ---------------------------------------------------------------------- */
export const CATEGORIES = ["DevOps", "Motoviajero", "Endurero", "Papá", "Oficios", "Mate"];

/* -------------------------------------------------------------------------
 * App registry — single source of truth for the landing grid and routing.
 * Add a new tool by importing its component and pushing an entry here.
 *   slug        URL segment: /app/<slug>  (must be unique, kebab-case)
 *   title       card heading
 *   description one-liner shown on the card
 *   categories  which CATEGORIES this app belongs to (drives the filters)
 *   tag         small label shown on the card (more specific than category)
 *   icon        a lucide-react icon component
 *   accent      hex color for the card accent
 *   Component   the React component rendered at /app/<slug>
 * ---------------------------------------------------------------------- */
export const apps = [
  {
    slug: "corriente-neutro",
    title: "Corriente de Neutro",
    description: "Visualizador de fases y consumo en un sistema trifásico (3F + N).",
    categories: ["Oficios"],
    tag: "Electricidad",
    icon: Zap,
    accent: "#f59e0b",
    Component: NeutralCurrentVisualizer,
  },
  {
    slug: "mandelbrot",
    title: "Mandelbrot",
    description: "Explorá el fractal con zoom infinito, colores vibrantes y lugares emblemáticos.",
    categories: ["Mate"],
    tag: "Fractal",
    icon: Sparkles,
    accent: "#c026d3",
    Component: MandelbrotExplorer,
  },
];

export const getApp = (slug) => apps.find((a) => a.slug === slug);

/* -------------------------------------------------------------------------
 * Private links — external links to other self-hosted services, shown only
 * after Google sign-in (see PrivateSection + AuthProvider). Unlike `apps`,
 * these are NOT internal React components: each is just an external `href`.
 *   href   absolute URL to the service (opens in a new tab)
 *   icon   a lucide-react icon component
 *   accent hex color for the card accent
 * Like public apps, each declares `categories` (from CATEGORIES) so the same
 * landing filter chips apply to the private grid too.
 * NOTE: URLs are placeholders under the `<x>.agu.com.ar` pattern — adjust to
 * the real hostnames.
 * ---------------------------------------------------------------------- */
export const privateLinks = [
  {
    slug: "traefik",
    title: "Traefik",
    description: "Dashboard del ingress del cluster.",
    href: "https://traefik.agu.com.ar/dashboard/",
    categories: ["DevOps"],
    tag: "Infra",
    icon: Network,
    accent: "#3b82f6",
  },
  {
    slug: "home-assistant",
    title: "Home Assistant",
    description: "Domótica del hogar.",
    href: "https://home.agu.com.ar",
    categories: ["DevOps", "Papá"],
    tag: "Hogar",
    icon: Home,
    accent: "#22c55e",
  },
  {
    slug: "argocd",
    title: "ArgoCD",
    description: "GitOps / estado de los despliegues.",
    href: "https://argocd.agu.com.ar",
    categories: ["DevOps"],
    tag: "GitOps",
    icon: GitBranch,
    accent: "#f97316",
  },
];
