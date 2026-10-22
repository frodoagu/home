import { apps } from "./apps/registry";
import { localizeText } from "./i18n/LanguageProvider";

/* -------------------------------------------------------------------------
 * What search engines get: one prerendered page per route (scripts/prerender.js)
 * with its own title, description, canonical URL and JSON-LD, plus the
 * sitemap. Pages are prerendered in Spanish, the site's default language.
 * ---------------------------------------------------------------------- */

export const SITE_URL = "https://agu.com.ar";
export const SITE_NAME = "Agu";
export const LINKEDIN_URL = "https://www.linkedin.com/in/%E2%96%BAfederico-ag%C3%BA-75a85a60/";

const TAGLINE = {
  es: "Herramientas y experimentos web",
  en: "Web tools and experiments",
  pt: "Ferramentas e experimentos web",
  fr: "Outils et expériences web",
};

const HOME_DESCRIPTION = `Herramientas y experimentos web de Agu: ${new Intl.ListFormat("es").format(
  apps.map((app) => localizeText(app.title, "es")),
)}. Self-hosted en un Raspberry Pi.`;

const NOT_FOUND = { es: "No encontrado", en: "Not found", pt: "Não encontrado", fr: "Introuvable" };

const AUTHOR = { "@type": "Person", name: "Federico Agú", url: `${SITE_URL}/`, sameAs: [LINKEDIN_URL] };

export const homeTitle = (language) => `${SITE_NAME} · ${localizeText(TAGLINE, language)}`;
export const appTitle = (app, language) => `${localizeText(app.title, language)} · ${SITE_NAME}`;
export const notFoundTitle = (language) => `${localizeText(NOT_FOUND, language)} · ${SITE_NAME}`;

// In-app tools only: an `href` app lives on its own host, with its own sitemap.
export function pages() {
  const home = {
    path: "/",
    title: homeTitle("es"),
    description: HOME_DESCRIPTION,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      inLanguage: "es",
      author: AUTHOR,
    },
  };
  const tools = apps
    .filter((app) => app.Component)
    .map((app) => ({
      path: `/app/${app.slug}`,
      title: appTitle(app, "es"),
      description: localizeText(app.description, "es"),
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: localizeText(app.title, "es"),
        description: localizeText(app.description, "es"),
        url: `${SITE_URL}/app/${app.slug}`,
        operatingSystem: "Web",
        browserRequirements: "Requires JavaScript",
        isAccessibleForFree: true,
        author: AUTHOR,
      },
    }));
  return [home, ...tools];
}

export const notFoundPage = { path: "/404", title: notFoundTitle("es"), noindex: true };

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function headTags(page) {
  const title = escapeHtml(page.title);
  const tags = [`<title>${title}</title>`];
  if (page.noindex) {
    tags.push('<meta name="robots" content="noindex" />');
    return tags.join("\n    ");
  }
  const description = escapeHtml(page.description);
  const url = escapeHtml(SITE_URL + page.path);
  tags.push(
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="es_AR" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
  );
  if (page.jsonLd) {
    // `<` escaped so a string can never close the script tag.
    const json = JSON.stringify(page.jsonLd).replace(/</g, "\\u003c");
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join("\n    ");
}

export function sitemap(list) {
  const urls = list.map((p) => `  <url><loc>${escapeHtml(SITE_URL + p.path)}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
