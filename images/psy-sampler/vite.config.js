/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Static SPA built to ./dist, baked into an nginx image (see Dockerfile) and
// served by the psy-sampler chart at psy.agu.com.ar.
export default defineConfig({
  test: {
    environment: "node", // DOM tests opt in with @vitest-environment jsdom
    css: false,
  },
});
