import { Activity, AudioWaveform, BellRing, Cable, GitBranch, GlobeLock, Home, LayoutDashboard, Lightbulb, Network, ScrollText, Shield, Sparkles, Zap } from "lucide-react";
import NeutralCurrentVisualizer from "./NeutralCurrentVisualizer";
import MandelbrotExplorer from "./MandelbrotExplorer";
import BalancedAudio from "./BalancedAudio";

/* -------------------------------------------------------------------------
 * Filter categories — the identity facets shown as chips on the landing.
 * Each app declares which of these it belongs to (`categories`), and the
 * chips filter the grid by them. Keep this list in sync with app entries.
 * ---------------------------------------------------------------------- */
export const CATEGORIES = ["devops", "rider", "enduro", "dad", "trades", "mate", "music"];

export const CATEGORY_LABELS = {
  devops: { es: "DevOps", en: "DevOps", pt: "DevOps", fr: "DevOps" },
  rider: { es: "Motoviajero", en: "Rider", pt: "Motoviajante", fr: "Motard voyageur" },
  enduro: { es: "Endurero", en: "Enduro", pt: "Enduro", fr: "Enduro" },
  dad: { es: "Papa", en: "Dad", pt: "Pai", fr: "Papa" },
  trades: { es: "Oficios", en: "Trades", pt: "Ofícios", fr: "Métiers" },
  mate: { es: "Mate", en: "Math", pt: "Matemática", fr: "Maths" },
  music: { es: "Musica", en: "Music", pt: "Música", fr: "Musique" },
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
    title: { es: "Corriente de Neutro", en: "Neutral Current", pt: "Corrente de Neutro", fr: "Courant de neutre" },
    description: {
      es: "Visualizador de fases y consumo en un sistema trifasico (3F + N).",
      en: "Phase and load visualizer for a three-phase system (3P + N).",
      pt: "Visualizador de fases e consumo em um sistema trifásico (3F + N).",
      fr: "Visualiseur de phases et de consommation dans un système triphasé (3P + N).",
    },
    categories: ["trades"],
    tag: { es: "Electricidad", en: "Electrical", pt: "Elétrica", fr: "Électricité" },
    icon: Zap,
    accent: "#f59e0b",
    Component: NeutralCurrentVisualizer,
  },
  {
    slug: "mandelbrot",
    title: { es: "Mandelbrot", en: "Mandelbrot", pt: "Mandelbrot", fr: "Mandelbrot" },
    description: {
      es: "Explora el fractal con zoom infinito, colores vibrantes y lugares emblematicos.",
      en: "Explore the fractal with infinite zoom, vivid colors, and iconic locations.",
      pt: "Explore o fractal com zoom infinito, cores vibrantes e lugares emblemáticos.",
      fr: "Explore la fractale avec un zoom infini, des couleurs vives et des lieux emblématiques.",
    },
    categories: ["mate"],
    tag: { es: "Fractal", en: "Fractal", pt: "Fractal", fr: "Fractal" },
    icon: Sparkles,
    accent: "#c026d3",
    Component: MandelbrotExplorer,
  },
  {
    slug: "psy-sampler",
    title: { es: "Trance Lab", en: "Trance Lab", pt: "Trance Lab", fr: "Trance Lab" },
    description: {
      es: "Un DAW online y gratis para hacer psytrance, goa y techno en el navegador: arma, edita y mezcla loops mientras suenan.",
      en: "A free online DAW to make psytrance, goa and techno in your browser: build, edit and mix loops while they play.",
      pt: "Um DAW online e grátis para fazer psytrance, goa e techno no navegador: monte, edite e mixe loops enquanto tocam.",
      fr: "Un DAW en ligne et gratuit pour faire de la psytrance, de la goa et de la techno dans le navigateur : construis, édite et mixe des boucles pendant qu'elles jouent.",
    },
    href: "https://psy.agu.com.ar",
    categories: ["music"],
    tag: { es: "Psytrance", en: "Psytrance", pt: "Psytrance", fr: "Psytrance" },
    icon: AudioWaveform,
    accent: "#a855f7",
  },
  {
    slug: "audio-balanceado",
    title: { es: "Audio balanceado", en: "Balanced Audio", pt: "Áudio balanceado", fr: "Audio symétrique" },
    description: {
      es: "Por qué un cable balanceado rechaza el ruido: sumá hum, dimmers y lazos de masa, comparalo con uno no balanceado y escuchá la diferencia.",
      en: "Why a balanced cable rejects noise: add hum, dimmers and ground loops, compare it with an unbalanced one and hear the difference.",
      pt: "Por que um cabo balanceado rejeita o ruído: some hum, dimmers e loops de terra, compare com um não balanceado e ouça a diferença.",
      fr: "Pourquoi un câble symétrique rejette le bruit : ajoute du ronflement, des variateurs et des boucles de masse, compare avec un câble asymétrique et écoute la différence.",
    },
    categories: ["music", "trades"],
    tag: { es: "Audio", en: "Audio", pt: "Áudio", fr: "Audio" },
    icon: Cable,
    accent: "#22d3ee",
    Component: BalancedAudio,
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
    title: { es: "Traefik", en: "Traefik", pt: "Traefik", fr: "Traefik" },
    description: {
      es: "Panel del ingress del cluster.",
      en: "Ingress dashboard for the cluster.",
      pt: "Painel do ingress do cluster.",
      fr: "Tableau de bord de l'ingress du cluster.",
    },
    href: "https://traefik.agu.com.ar/dashboard/",
    categories: ["devops"],
    tag: { es: "Infra", en: "Infra", pt: "Infra", fr: "Infra" },
    icon: Network,
    accent: "#3b82f6",
  },
  {
    slug: "home-assistant",
    title: { es: "Home Assistant", en: "Home Assistant", pt: "Home Assistant", fr: "Home Assistant" },
    description: { es: "Domotica del hogar.", en: "Home automation.", pt: "Automação residencial.", fr: "Domotique de la maison." },
    href: "https://home.agu.com.ar",
    categories: ["devops", "dad"],
    tag: { es: "Hogar", en: "Home", pt: "Casa", fr: "Maison" },
    icon: Home,
    accent: "#22c55e",
  },
  {
    slug: "argocd",
    title: { es: "ArgoCD", en: "ArgoCD", pt: "ArgoCD", fr: "ArgoCD" },
    description: {
      es: "GitOps / estado de los despliegues.",
      en: "GitOps / deployment status.",
      pt: "GitOps / estado dos deploys.",
      fr: "GitOps / état des déploiements.",
    },
    href: "https://argocd.agu.com.ar",
    categories: ["devops"],
    tag: { es: "GitOps", en: "GitOps", pt: "GitOps", fr: "GitOps" },
    icon: GitBranch,
    accent: "#f97316",
  },
  {
    slug: "grafana",
    title: { es: "Grafana", en: "Grafana", pt: "Grafana", fr: "Grafana" },
    description: {
      es: "Metricas del cluster, hardware del Pi y uptime.",
      en: "Cluster metrics, Pi hardware, and uptime.",
      pt: "Métricas do cluster, hardware do Pi e uptime.",
      fr: "Métriques du cluster, matériel du Pi et uptime.",
    },
    href: "https://grafana.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Monitoreo", en: "Monitoring", pt: "Monitoramento", fr: "Monitoring" },
    icon: Activity,
    accent: "#f59e0b",
  },
  {
    slug: "alertmanager",
    title: { es: "Alertmanager", en: "Alertmanager", pt: "Alertmanager", fr: "Alertmanager" },
    description: {
      es: "Alertas activas y silencios.",
      en: "Active alerts and silences.",
      pt: "Alertas ativos e silenciamentos.",
      fr: "Alertes actives et silences.",
    },
    href: "https://alertmanager.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Alertas", en: "Alerts", pt: "Alertas", fr: "Alertes" },
    icon: BellRing,
    accent: "#dc2626",
  },
  {
    slug: "pihole",
    title: { es: "Pi-hole", en: "Pi-hole", pt: "Pi-hole", fr: "Pi-hole" },
    description: {
      es: "Bloqueo de publicidad y DNS/DHCP de la red.",
      en: "Network-wide ad-blocking and DNS/DHCP.",
      pt: "Bloqueio de anúncios e DNS/DHCP da rede.",
      fr: "Blocage des pubs et DNS/DHCP du réseau.",
    },
    href: "https://pihole.agu.com.ar/admin",
    categories: ["devops"],
    tag: { es: "DNS", en: "DNS", pt: "DNS", fr: "DNS" },
    icon: Shield,
    accent: "#ef4444",
  },
  {
    slug: "victoria-logs",
    title: { es: "VictoriaLogs", en: "VictoriaLogs", pt: "VictoriaLogs", fr: "VictoriaLogs" },
    description: {
      es: "Logs centralizados del cluster (LogsQL).",
      en: "Centralized cluster logs (LogsQL).",
      pt: "Logs centralizados do cluster (LogsQL).",
      fr: "Logs centralisés du cluster (LogsQL).",
    },
    href: "https://logs.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Logs", en: "Logs", pt: "Logs", fr: "Logs" },
    icon: ScrollText,
    accent: "#14b8a6",
  },
  {
    slug: "shelly",
    title: { es: "Shelly", en: "Shelly", pt: "Shelly", fr: "Shelly" },
    description: {
      es: "Control de las luces de afuera (prender/apagar y estado).",
      en: "Control the outdoor lights (on/off and status).",
      pt: "Controle das luzes externas (ligar/desligar e estado).",
      fr: "Contrôle des lumières extérieures (allumer/éteindre et état).",
    },
    href: "https://shelly.agu.com.ar",
    categories: ["devops", "dad"],
    tag: { es: "Hogar", en: "Home", pt: "Casa", fr: "Maison" },
    icon: Lightbulb,
    accent: "#eab308",
  },
  {
    slug: "vpn",
    title: { es: "VPN", en: "VPN", pt: "VPN", fr: "VPN" },
    description: {
      es: "WireGuard para salir por la IP de casa: dispositivos y códigos QR.",
      en: "WireGuard out through the home IP: devices and QR codes.",
      pt: "WireGuard para sair pelo IP de casa: dispositivos e códigos QR.",
      fr: "WireGuard pour sortir par l'IP de la maison : appareils et QR codes.",
    },
    href: "https://vpn.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Red", en: "Network", pt: "Rede", fr: "Réseau" },
    icon: GlobeLock,
    accent: "#10b981",
  },
  {
    slug: "homepage",
    title: { es: "Homepage", en: "Homepage", pt: "Homepage", fr: "Homepage" },
    description: {
      es: "Tablero de inicio con todos los servicios.",
      en: "Start page linking every service.",
      pt: "Painel inicial com todos os serviços.",
      fr: "Page d'accueil avec tous les services.",
    },
    href: "https://dash.agu.com.ar",
    categories: ["devops"],
    tag: { es: "Dashboard", en: "Dashboard", pt: "Dashboard", fr: "Dashboard" },
    icon: LayoutDashboard,
    accent: "#6366f1",
  },
];
