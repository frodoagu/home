import { Activity, AudioWaveform, BellRing, GitBranch, Home, LayoutDashboard, Lightbulb, Network, ScrollText, Shield, Sparkles, Zap } from "lucide-react";
import NeutralCurrentVisualizer from "./NeutralCurrentVisualizer";
import MandelbrotExplorer from "./MandelbrotExplorer";

/* -------------------------------------------------------------------------
 * Filter categories — the identity facets shown as chips on the landing.
 * Each app declares which of these it belongs to (`categories`), and the
 * chips filter the grid by them. Keep this list in sync with app entries.
 * ---------------------------------------------------------------------- */
export const CATEGORIES = ["devops", "rider", "enduro", "dad", "trades", "mate", "music"];

export const CATEGORY_LABELS = {
  devops: { es: "DevOps", en: "DevOps", pt: "DevOps" },
  rider: { es: "Motoviajero", en: "Rider", pt: "Motoviajante" },
  enduro: { es: "Endurero", en: "Enduro", pt: "Enduro" },
  dad: { es: "Papa", en: "Dad", pt: "Pai" },
  trades: { es: "Oficios", en: "Trades", pt: "Ofícios" },
  mate: { es: "Mate", en: "Math", pt: "Matemática" },
  music: { es: "Musica", en: "Music", pt: "Música" },
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
 *   href        instead of Component: an app hosted on its own subdomain; the
 *               card links out (new tab) and there is no /app/<slug> route
 * ---------------------------------------------------------------------- */
export const apps = [
  {
    slug: "corriente-neutro",
    title: { es: "Corriente de Neutro", en: "Neutral Current", pt: "Corrente de Neutro" },
    description: {
      es: "Visualizador de fases y consumo en un sistema trifasico (3F + N).",
      en: "Phase and load visualizer for a three-phase system (3P + N).",
      pt: "Visualizador de fases e consumo em um sistema trifásico (3F + N).",
    },
    categories: ["trades"],
    tag: { es: "Electricidad", en: "Electrical", pt: "Elétrica" },
    icon: Zap,
    accent: "#f59e0b",
    Component: NeutralCurrentVisualizer,
  },
  {
    slug: "mandelbrot",
    title: { es: "Mandelbrot", en: "Mandelbrot", pt: "Mandelbrot" },
    description: {
      es: "Explora el fractal con zoom infinito, colores vibrantes y lugares emblematicos.",
      en: "Explore the fractal with infinite zoom, vivid colors, and iconic locations.",
      pt: "Explore o fractal com zoom infinito, cores vibrantes e lugares emblemáticos.",
    },
    categories: ["mate"],
    tag: { es: "Fractal", en: "Fractal", pt: "Fractal" },
    icon: Sparkles,
    accent: "#c026d3",
    Component: MandelbrotExplorer,
  },
  {
    slug: "psy-sampler",
    title: { es: "Psy Layers", en: "Psy Layers", pt: "Psy Layers" },
    description: {
      es: "Maquina de musica electronica en vivo: arma, edita y mezcla un tema de psytrance o techno mientras suena.",
      en: "A live electronic music machine: build, edit and mix a psytrance or techno track while it plays.",
      pt: "Máquina de música eletrônica ao vivo: monte, edite e mixe uma faixa de psytrance ou techno enquanto ela toca.",
    },
    href: "https://psy.agu.com.ar",
    categories: ["music"],
    tag: { es: "Psytrance", en: "Psytrance", pt: "Psytrance" },
    icon: AudioWaveform,
    accent: "#a855f7",
  },
];

export const getApp = (slug) => apps.find((a) => a.slug === slug && a.Component);

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
    title: { es: "Traefik", en: "Traefik", pt: "Traefik" },
    description: {
      es: "Panel del ingress del cluster.",
      en: "Ingress dashboard for the cluster.",
      pt: "Painel do ingress do cluster.",
    },
    href: "https://traefik.agu.com.ar/dashboard/",
    categories: ["devops"],
    tag: { es: "Infra", en: "Infra", pt: "Infra" },
    icon: Network,
    accent: "#3b82f6",
  },
  {
    slug: "home-assistant",
    title: { es: "Home Assistant", en: "Home Assistant", pt: "Home Assistant" },
    description: { es: "Domotica del hogar.", en: "Home automation.", pt: "Automação residencial." },
    href: "https://home.agu.com.ar",
    categories: ["devops", "dad"],
    tag: { es: "Hogar", en: "Home", pt: "Casa" },
    icon: Home,
    accent: "#22c55e",
  },
  {
    slug: "argocd",
    title: { es: "ArgoCD", en: "ArgoCD", pt: "ArgoCD" },
    description: {
      es: "GitOps / estado de los despliegues.",
      en: "GitOps / deployment status.",
      pt: "GitOps / estado dos deploys.",
    },
    href: "https://argocd.agu.com.ar",
    categories: ["devops"],
    tag: { es: "GitOps", en: "GitOps", pt: "GitOps" },
    icon: GitBranch,
    accent: "#f97316",
  },
  {
    slug: "grafana",
    title: { es: "Grafana", en: "Grafana", pt: "Grafana" },
    description: {
      es: "Metricas del cluster, hardware del Pi y uptime.",
      en: "Cluster metrics, Pi hardware, and uptime.",
      pt: "Métricas do cluster, hardware do Pi e uptime.",
    },
    href: "https://grafana.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Monitoreo", en: "Monitoring", pt: "Monitoramento" },
    icon: Activity,
    accent: "#f59e0b",
  },
  {
    slug: "alertmanager",
    title: { es: "Alertmanager", en: "Alertmanager", pt: "Alertmanager" },
    description: {
      es: "Alertas activas y silencios.",
      en: "Active alerts and silences.",
      pt: "Alertas ativos e silenciamentos.",
    },
    href: "https://alertmanager.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Alertas", en: "Alerts", pt: "Alertas" },
    icon: BellRing,
    accent: "#dc2626",
  },
  {
    slug: "pihole",
    title: { es: "Pi-hole", en: "Pi-hole", pt: "Pi-hole" },
    description: {
      es: "Bloqueo de publicidad y DNS/DHCP de la red.",
      en: "Network-wide ad-blocking and DNS/DHCP.",
      pt: "Bloqueio de anúncios e DNS/DHCP da rede.",
    },
    href: "https://pihole.agu.com.ar/admin",
    categories: ["devops"],
    tag: { es: "DNS", en: "DNS", pt: "DNS" },
    icon: Shield,
    accent: "#ef4444",
  },
  {
    slug: "victoria-logs",
    title: { es: "VictoriaLogs", en: "VictoriaLogs", pt: "VictoriaLogs" },
    description: {
      es: "Logs centralizados del cluster (LogsQL).",
      en: "Centralized cluster logs (LogsQL).",
      pt: "Logs centralizados do cluster (LogsQL).",
    },
    href: "https://logs.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Logs", en: "Logs", pt: "Logs" },
    icon: ScrollText,
    accent: "#14b8a6",
  },
  {
    slug: "shelly",
    title: { es: "Shelly", en: "Shelly", pt: "Shelly" },
    description: {
      es: "Control de las luces de afuera (prender/apagar y estado).",
      en: "Control the outdoor lights (on/off and status).",
      pt: "Controle das luzes externas (ligar/desligar e estado).",
    },
    href: "https://shelly.agu.com.ar",
    categories: ["devops", "dad"],
    tag: { es: "Hogar", en: "Home", pt: "Casa" },
    icon: Lightbulb,
    accent: "#eab308",
  },
  {
    slug: "homepage",
    title: { es: "Homepage", en: "Homepage", pt: "Homepage" },
    description: {
      es: "Tablero de inicio con todos los servicios.",
      en: "Start page linking every service.",
      pt: "Painel inicial com todos os serviços.",
    },
    href: "https://dash.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Dashboard", en: "Dashboard", pt: "Dashboard" },
    icon: LayoutDashboard,
    accent: "#6366f1",
  },
];
