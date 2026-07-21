import { Activity, GitBranch, Home, LayoutDashboard, Network, ScrollText, Shield, Sparkles, Zap } from "lucide-react";
import NeutralCurrentVisualizer from "./NeutralCurrentVisualizer";
import MandelbrotExplorer from "./MandelbrotExplorer";

/* -------------------------------------------------------------------------
 * Filter categories — the identity facets shown as chips on the landing.
 * Each app declares which of these it belongs to (`categories`), and the
 * chips filter the grid by them. Keep this list in sync with app entries.
 * ---------------------------------------------------------------------- */
export const CATEGORIES = ["devops", "rider", "enduro", "dad", "trades", "mate"];

export const CATEGORY_LABELS = {
  devops: { es: "DevOps", en: "DevOps" },
  rider: { es: "Motoviajero", en: "Rider" },
  enduro: { es: "Endurero", en: "Enduro" },
  dad: { es: "Papa", en: "Dad" },
  trades: { es: "Oficios", en: "Trades" },
  mate: { es: "Mate", en: "Mate" },
};

export const getCategoryLabel = (key, language) =>
  CATEGORY_LABELS[key]?.[language] || CATEGORY_LABELS[key]?.es || key;

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
    title: { es: "Corriente de Neutro", en: "Neutral Current" },
    description: {
      es: "Visualizador de fases y consumo en un sistema trifasico (3F + N).",
      en: "Phase and load visualizer for a three-phase system (3P + N).",
    },
    categories: ["trades"],
    tag: { es: "Electricidad", en: "Electrical" },
    icon: Zap,
    accent: "#f59e0b",
    Component: NeutralCurrentVisualizer,
  },
  {
    slug: "mandelbrot",
    title: { es: "Mandelbrot", en: "Mandelbrot" },
    description: {
      es: "Explora el fractal con zoom infinito, colores vibrantes y lugares emblematicos.",
      en: "Explore the fractal with infinite zoom, vivid colors, and iconic locations.",
    },
    categories: ["mate"],
    tag: { es: "Fractal", en: "Fractal" },
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
    title: { es: "Traefik", en: "Traefik" },
    description: {
      es: "Panel del ingress del cluster.",
      en: "Ingress dashboard for the cluster.",
    },
    href: "https://traefik.agu.com.ar/dashboard/",
    categories: ["devops"],
    tag: { es: "Infra", en: "Infra" },
    icon: Network,
    accent: "#3b82f6",
  },
  {
    slug: "home-assistant",
    title: { es: "Home Assistant", en: "Home Assistant" },
    description: { es: "Domotica del hogar.", en: "Home automation." },
    href: "https://home.agu.com.ar",
    categories: ["devops", "dad"],
    tag: { es: "Hogar", en: "Home" },
    icon: Home,
    accent: "#22c55e",
  },
  {
    slug: "argocd",
    title: { es: "ArgoCD", en: "ArgoCD" },
    description: {
      es: "GitOps / estado de los despliegues.",
      en: "GitOps / deployment status.",
    },
    href: "https://argocd.agu.com.ar",
    categories: ["devops"],
    tag: { es: "GitOps", en: "GitOps" },
    icon: GitBranch,
    accent: "#f97316",
  },
  {
    slug: "grafana",
    title: { es: "Grafana", en: "Grafana" },
    description: {
      es: "Metricas del cluster, hardware del Pi y uptime.",
      en: "Cluster metrics, Pi hardware, and uptime.",
    },
    href: "https://grafana.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Monitoreo", en: "Monitoring" },
    icon: Activity,
    accent: "#f59e0b",
  },
  {
    slug: "pihole",
    title: { es: "Pi-hole", en: "Pi-hole" },
    description: {
      es: "Bloqueo de publicidad y DNS/DHCP de la red.",
      en: "Network-wide ad-blocking and DNS/DHCP.",
    },
    href: "https://pihole.agu.com.ar/admin",
    categories: ["devops"],
    tag: { es: "DNS", en: "DNS" },
    icon: Shield,
    accent: "#ef4444",
  },
  {
    slug: "victoria-logs",
    title: { es: "VictoriaLogs", en: "VictoriaLogs" },
    description: {
      es: "Logs centralizados del cluster (LogsQL).",
      en: "Centralized cluster logs (LogsQL).",
    },
    href: "https://logs.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Logs", en: "Logs" },
    icon: ScrollText,
    accent: "#14b8a6",
  },
  {
    slug: "homepage",
    title: { es: "Homepage", en: "Homepage" },
    description: {
      es: "Tablero de inicio con todos los servicios.",
      en: "Start page linking every service.",
    },
    href: "https://dash.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Dashboard", en: "Dashboard" },
    icon: LayoutDashboard,
    accent: "#6366f1",
  },
];
