import js from "@eslint/js";
import globals from "globals";

// Flat config (ESLint 9) for the vanilla-JS Vite SPA.
export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["warn", { varsIgnorePattern: "^[A-Z_]" }],
    },
  },
  {
    files: ["*.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
