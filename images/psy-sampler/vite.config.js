/// <reference types="vitest/config" />
import { defineConfig } from "vite";

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
    test: {
      environment: "node", // DOM tests opt in with @vitest-environment jsdom
      css: false,
    },
  };
});
