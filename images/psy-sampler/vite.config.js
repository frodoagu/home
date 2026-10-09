/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Static SPA built to ./dist, baked into an nginx image (see Dockerfile) and
// served by the psy-sampler chart at psy.agu.com.ar.
export default defineConfig({
  // `npm run dev` + a local psy-sync (images/psy-sync, ALLOWED_ORIGINS=
  // http://localhost:5173) gives the cloud save; without it the page hides it.
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
  test: {
    environment: "node", // DOM tests opt in with @vitest-environment jsdom
    css: false,
  },
});
