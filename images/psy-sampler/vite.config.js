/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { LANGS, pathLang } from "./src/i18n/index.js";
import { pageHtml, sitemap } from "./src/seo.js";

// Static SPA built to ./dist, baked into an nginx image (see Dockerfile) and
// served by the psy-sampler chart at psy.agu.com.ar. Each build gets an id,
// baked into the page and written to /version.json, so an open page notices
// a deploy (src/update.js).
export default defineConfig(({ command }) => {
  const build = command === "build" ? new Date().toISOString() : "dev";
  return {
    define: { "import.meta.env.BUILD_ID": JSON.stringify(build) },
    plugins: [
      {
        // `/` gets the x-default head and, under `npm run dev`, /<lang>/ its
        // own; the build adds a copy of the page per language
        // (/en/index.html...) and the sitemap.
        name: "seo-pages",
        enforce: "post",
        transformIndexHtml(html, { filename, originalUrl = "" }) {
          return filename.endsWith("/index.html") ? pageHtml(html, pathLang(originalUrl.split("?")[0])) : html;
        },
        generateBundle(_, bundle) {
          const page = String(bundle["index.html"].source);
          for (const id of LANGS) this.emitFile({ type: "asset", fileName: `${id}/index.html`, source: pageHtml(page, id) });
          this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap() });
        },
      },
      {
        name: "version-json",
        apply: "build",
        generateBundle() {
          this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build }) });
        },
      },
    ],
    // `npm run dev` + a local psy-sync (images/psy-sync, ALLOWED_ORIGINS=
    // http://localhost:5173) gives the cloud save; without it the page hides it.
    server: {
      proxy: { "/api": "http://localhost:8787" },
    },
    // Two pages: the sampler and its visuals in a window of their own.
    build: {
      rolldownOptions: { input: { main: "index.html", visuals: "visuals.html" } },
    },
    test: {
      environment: "node", // DOM tests opt in with @vitest-environment jsdom
      css: false,
    },
  };
});
