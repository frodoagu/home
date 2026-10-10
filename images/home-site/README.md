# home-site

The [agu.com.ar](https://agu.com.ar) landing SPA (Vite + React + Tailwind) and
the Dockerfile that bakes it into an nginx image. Deployed by
[`charts/agu-spa`](../../charts/agu-spa); full guide in
[docs/agu-spa.md](../../docs/agu-spa.md).

## What's in it

- **Public apps**: `apps` in [`src/apps/registry.jsx`](src/apps/registry.jsx).
  An entry is either an in-app tool (`Component`, routed at `/app/<slug>`) or an
  app on its own subdomain (`href`, e.g. `psy.agu.com.ar`).
- **Private links**: `privateLinks` in the same registry, shown only after a
  client-side Google sign-in with an email from `ALLOWED_EMAILS` in
  [`src/auth/config.js`](src/auth/config.js). It hides the URLs from casual
  visitors; each linked service still does its own auth.

Pure logic lives in a plain `.js` module next to its component
(`mandelbrot.js`, `neutralCurrent.js`, `auth/auth.js`) with a `*.test.js`
beside it; components stay thin.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest (unit + Testing Library)
npm run lint
npm run build    # production bundle in dist/
```

`VITE_GOOGLE_CLIENT_ID` overrides the committed OAuth client ID (public by
design). `http://localhost:5173` must be an authorized JavaScript origin of that
client for sign-in to work in dev.

## Image

Two stages: `node:24-alpine` builds `dist/`, `nginx:1.31-alpine` serves it. The
image ships only the files; the chart mounts its own nginx `default.conf` (SPA
fallback, caching, `/healthz`).

## CI and deploy

- [`site-test.yml`](../../.github/workflows/site-test.yml): tests + build on
  every PR and push touching this directory.
- [`site.yml`](../../.github/workflows/site.yml): on push to `main`, builds
  `ghcr.io/frodoagu/home-site:latest` for `linux/arm64`.
- Argo CD Image Updater pins the new digest into
  `charts/agu-spa/values.yaml`, and Argo CD rolls it out. The package is
  private; the kubelet pulls with the `ghcr-creds` secret.
