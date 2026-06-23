/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA built to ./dist, then baked into an nginx image (see Dockerfile)
// and served by the nginx-spa chart at agu.com.ar.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.js",
    css: false,
  },
});
