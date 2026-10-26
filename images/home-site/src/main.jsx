import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { routes } from "./routes";
import { AuthProvider } from "./auth/AuthProvider";
import { LanguageProvider } from "./i18n/LanguageProvider";
import { installWheelRanges } from "./wheelRange";

const router = createBrowserRouter(routes);

installWheelRanges();

// createRoot, not hydrateRoot: the prerendered markup is Spanish and signed
// out, while language and session are per browser, so it is replaced on mount.
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LanguageProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </LanguageProvider>
  </React.StrictMode>
);
