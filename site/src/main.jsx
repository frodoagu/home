import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import Landing from "./Landing";
import AppHost from "./AppHost";

const router = createBrowserRouter([
  { path: "/", element: <Landing /> },
  { path: "/app/:slug", element: <AppHost /> },
]);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
