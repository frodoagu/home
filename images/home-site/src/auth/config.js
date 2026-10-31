/* -------------------------------------------------------------------------
 * Google sign-in config for the private section.
 *
 * The OAuth Client ID is PUBLIC by design (it ships in the client-side JS of
 * every site that uses Google sign-in), so committing it is fine. Override at
 * build time with VITE_GOOGLE_CLIENT_ID if you prefer not to commit it.
 *
 * The gate is UX-level: it hides the existence/URLs of internal services from
 * casual visitors. Real authentication still lives on each service behind the
 * links (basic-auth / its own login).
 *
 * To wire this up: create a "Web application" OAuth Client ID in Google Cloud,
 * add https://agu.com.ar (and http://localhost:5173 for dev) to the Authorized
 * JavaScript origins, then paste the ID below and list the allowed accounts.
 * ---------------------------------------------------------------------- */
export const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "1036300943412-3np4as1pb6d2ovkbt9j89aiact2bddc0.apps.googleusercontent.com";

// Google account IDs (the ID token's `sub`) allowed into the private section.
// IDs, not emails: this ships in the public bundle and lives in a public repo.
// Same ID as the Argo CD admin in charts/argocd/values.yaml.
export const ALLOWED_SUBJECTS = ["108670547033650249289"];
