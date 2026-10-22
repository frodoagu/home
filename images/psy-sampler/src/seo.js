// What search engines get: one page per language (/es/, /en/, /pt/, /fr/) plus
// `/`, the x-default that picks the language in the browser. Each carries its
// own <head> (title, description, canonical, hreflang, Open Graph, JSON-LD),
// written in by the build (vite.config.js) from the dictionaries' `seo`.
import { DICTS, LANGS, langPath } from "./i18n/index.js";

export const SITE = "https://psy.agu.com.ar";
export const NAME = "Trance Lab";
const DEFAULT_PAGE = "en"; // the language `/` is described in
const LOCALES = { es: "es_AR", en: "en_US", pt: "pt_BR", fr: "fr_FR" };
const START = "<!--seo-->";
const END = "<!--/seo-->";

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const urlOf = (id) => SITE + (id ? langPath(id) : "/");

/** The <head> tags of one page: a language id, or null for `/`. */
export function headTags(id) {
  const tx = DICTS[id ?? DEFAULT_PAGE];
  const { title, description, keywords } = tx.seo;
  const url = urlOf(id);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: NAME,
    alternateName: "Psy Layers DAW",
    url,
    description,
    keywords,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    browserRequirements: "Requires JavaScript and Web Audio",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    inLanguage: id ?? LANGS,
    author: { "@type": "Person", name: "Federico Agú", url: "https://agu.com.ar/" },
  };
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${urlOf(l)}" />`),
    `<link rel="alternate" hreflang="x-default" href="${urlOf(null)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${NAME}" />`,
    `<meta property="og:locale" content="${LOCALES[id ?? DEFAULT_PAGE]}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
    // `<` escaped so a string can never close the script tag.
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`,
  ].join("\n    ");
}

/** index.html with one page's head between its seo markers, and its lang. */
export function pageHtml(html, id) {
  const start = html.indexOf(START);
  const end = html.indexOf(END);
  if (start < 0 || end < start) throw new Error("index.html lost its <!--seo--> markers");
  return (
    html.slice(0, start + START.length).replace(/<html lang="[^"]*"/, `<html lang="${id ?? DEFAULT_PAGE}"`) +
    "\n    " +
    headTags(id) +
    "\n    " +
    html.slice(end)
  );
}

export function sitemap() {
  const alternates = [
    ...LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${urlOf(l)}" />`),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlOf(null)}" />`,
  ];
  const urls = [null, ...LANGS].map((id) => ["  <url>", `    <loc>${urlOf(id)}</loc>`, ...alternates, "  </url>"].join("\n"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
