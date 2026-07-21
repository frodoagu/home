# agu-spa

Chart: [`charts/agu-spa`](../charts/agu-spa). Deployed by ArgoCD from
[apps/agu-spa.yaml](../apps/agu-spa.yaml), reachable at the apex
`https://agu.com.ar`.

A minimal nginx that serves a built single-page application (React/Vue/Svelte/…)
as static files behind Traefik. It does **not** build anything — it just serves
files, either baked into a container image or rendered from a placeholder
ConfigMap.

## Where the files come from — `content.source`

`content.source` in [values.yaml](../charts/agu-spa/values.yaml) selects the
content origin:

- **`image` (default)** — the SPA build is already inside `image.repository` at
  `content.root` (default `/usr/share/nginx/html`). Point `image.repository` at
  your own registry image and `image.tag` at the build version. This is the real
  deployment path.
- **`configMap`** — the chart renders `content.placeholderHtml` into an
  `index.html` and mounts it over `content.root/index.html`. Useful to validate
  ingress/TLS/DNS end to end before a real build exists. The default `nginx`
  image's stock page is otherwise replaced by this placeholder.

### Shipping a real SPA

```bash
# Build your SPA into an image that copies the dist/ output to content.root, e.g.
#   FROM nginx:1.31-alpine
#   COPY dist/ /usr/share/nginx/html/
# then in charts/agu-spa/values.yaml:
#   image.repository: ghcr.io/<you>/<spa>
#   image.tag:        <version>      # pin explicitly; also bump Chart.yaml appVersion
#   content.source:   image
```

The deployment annotates pods with a `checksum/config` of the ConfigMap, so a
config change rolls the pods automatically. Changing `image.tag` likewise triggers
a new rollout via ArgoCD.

### How this repo actually ships it

The live `agu.com.ar` SPA is the React app in [`images/home-site/`](../images/home-site). On every push
to `images/home-site/`, the [`build-site`](../.github/workflows/site.yml) GitHub Action builds
an **arm64** image and pushes `ghcr.io/frodoagu/home-site:latest`. Argo CD Image
Updater (see [charts/argocd-image-updater](../charts/argocd-image-updater)) watches
that tag's digest and writes the pinned `image.tag: latest@sha256:...` back into
`values.yaml` over git, which ArgoCD then rolls out — so what runs is always an
immutable digest, with no manual tag bumps. The image is private; the kubelet
pulls it with the `ghcr-creds` secret (see [secrets.md](secrets.md)).

## Desarrollo y tests

```bash
cd site
npm install
npm run dev      # servidor de desarrollo (http://localhost:5173)
npm test         # Vitest: tests unitarios + de componentes (vitest run)
npm run build    # bundle de producción
```

La lógica pura de cada app vive en un módulo `.js` al lado de su componente
(`src/apps/mandelbrot.js`, `src/apps/neutralCurrent.js`, `src/auth/auth.js`) y se
testea con Vitest + Testing Library (`*.test.js[x]`). Los componentes quedan
finos (orquestan render/interacción) y el cálculo queda cubierto. Convención al
agregar una app: extraé la matemática a un `.js` y sumá su `*.test.js`.

CI corre los tests y el build en cada **push** y **pull request** que toque
`images/home-site/` ([`test-site`](../.github/workflows/site-test.yml)); el build de la
imagen ([`build-site`](../.github/workflows/site.yml)) sigue aparte, sólo en push
a `main`.

## Public vs. private apps (Google sign-in)

The landing has two halves (see [`images/home-site/src/Landing.jsx`](../images/home-site/src/Landing.jsx)):

- **Públicas** — the existing grid of in-app tools, visible to everyone. Source of
  truth: `apps` in [`images/home-site/src/apps/registry.jsx`](../images/home-site/src/apps/registry.jsx).
- **Privadas** — external links to other self-hosted services (Traefik dashboard,
  Home Assistant, ArgoCD), revealed only after a Google sign-in with an allowed
  email. Source of truth: `privateLinks` in the same registry — adjust the
  placeholder `*.agu.com.ar` URLs to your real hostnames.

Auth is **client-side** Google Identity Services
([`images/home-site/src/auth/AuthProvider.jsx`](../images/home-site/src/auth/AuthProvider.jsx)): no backend,
just a signed Google ID token decoded in the browser and checked against an
allowlist. This is a **UX gate** — it hides the existence/URLs of internal services
from casual visitors; the real authentication still lives on each linked service
(basic-auth / its own login).

### Wiring it up

1. In Google Cloud → APIs & Services → Credentials, create an **OAuth client ID**
   of type *Web application*. Under **Authorized JavaScript origins** add
   `https://agu.com.ar` (and `http://localhost:5173` for `npm run dev`). No redirect
   URIs are needed — GIS uses popup/one-tap.
2. Put the client ID in [`images/home-site/src/auth/config.js`](../images/home-site/src/auth/config.js)
   (or build with `VITE_GOOGLE_CLIENT_ID=...`). The client ID is **public by
   design**, so committing it is fine.
3. List the allowed emails in `ALLOWED_EMAILS` in the same file.

## SPA routing & caching

The bundled nginx config (`templates/configmap.yaml`) is tuned for SPAs:

- **Deep-link fallback:** `try_files $uri $uri/ /index.html` — unknown paths are
  handed to `index.html` so client-side routers (React Router, Vue Router, …)
  resolve them instead of returning 404 on refresh/deep-link.
- **`index.html` is never cached** (`no-cache, no-store, must-revalidate`) so a
  new deploy is picked up immediately.
- **Content-hashed assets** (`*.js`, `*.css`, fonts, images) are served
  `immutable` with a 1-year expiry.
- **gzip** is enabled for text/JS/CSS/JSON/SVG.

## Health checks

nginx exposes `GET /healthz` (returns `200 ok`, access-log off) used by the
liveness and readiness probes — separate from the SPA fallback so a healthy pod
doesn't depend on `index.html` resolving.

## Ingress & TLS

An `IngressRoute` on the `websecure` entrypoint with
`tls.certResolver: letsencrypt` (see [tls.md](tls.md)). HTTP→HTTPS redirect is
global, so no HTTP route is defined here. The apex `agu.com.ar` A record is kept
on the home IP by [cloudflare-ddns](../charts/cloudflare-ddns) (see the
[README](../README.md)).
