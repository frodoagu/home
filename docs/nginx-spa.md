# nginx-spa

Chart: [`charts/nginx-spa`](../charts/nginx-spa). Deployed by ArgoCD from
[apps/nginx-spa.yaml](../apps/nginx-spa.yaml), reachable at the apex
`https://agu.com.ar`.

A minimal nginx that serves a built single-page application (React/Vue/Svelte/…)
as static files behind Traefik. It does **not** build anything — it just serves
files, either baked into a container image or rendered from a placeholder
ConfigMap.

## Where the files come from — `content.source`

`content.source` in [values.yaml](../charts/nginx-spa/values.yaml) selects the
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
#   FROM nginx:1.27-alpine
#   COPY dist/ /usr/share/nginx/html/
# then in charts/nginx-spa/values.yaml:
#   image.repository: ghcr.io/<you>/<spa>
#   image.tag:        <version>      # pin explicitly; also bump Chart.yaml appVersion
#   content.source:   image
```

The deployment annotates pods with a `checksum/config` of the ConfigMap, so a
config change rolls the pods automatically. Bumping `image.tag` likewise triggers
a new rollout via ArgoCD.

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
