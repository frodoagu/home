import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { routes } from "./routes";
import { AuthProvider } from "./auth/AuthProvider";
import { LanguageProvider } from "./i18n/LanguageProvider";

export { headTags, notFoundPage, pages, sitemap } from "./seo";

// Build-time render of one route, signed out and in Spanish (scripts/prerender.js).
export function render(path) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return renderToString(
    <StrictMode>
      <LanguageProvider initialLanguage="es">
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </LanguageProvider>
    </StrictMode>,
  );
}
