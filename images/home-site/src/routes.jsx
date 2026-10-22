import Landing from "./Landing";
import AppHost from "./AppHost";
import NotFound from "./NotFound";

// Shared by the browser router (main.jsx) and the prerender (entry-server.jsx).
export const routes = [
  { path: "/", element: <Landing /> },
  { path: "/app/:slug", element: <AppHost /> },
  { path: "*", element: <NotFound /> },
];
