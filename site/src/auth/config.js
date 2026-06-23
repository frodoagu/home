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
 * JavaScript origins, then paste the ID below and list the allowed emails.
 * ---------------------------------------------------------------------- */
export const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  "PEGAR-CLIENT-ID.apps.googleusercontent.com";

// Emails allowed into the private section. Compared case-insensitively.
export const ALLOWED_EMAILS = ["federico.nicolas.agu@gmail.com"];
