# Repository guide

Agu's home-lab **GitOps** repository: Helm charts + ArgoCD `Application`s for
services running on a Raspberry Pi with **k3s**. Mostly Kubernetes/Helm
manifests; the one exception is `site/`, the source for the agu.com.ar landing
SPA (built into an image by CI — see below). The README has the full operator
runbook (fresh-Pi setup, secrets, DNS); this file is the orientation for editing.

## Layout

```
apps/                ArgoCD Application manifests (App-of-Apps). One file per workload.
  root.yaml          Root app — points at apps/ itself; `kubectl apply -f` this once to bootstrap.
  <name>.yaml        One Application per chart, all in namespace `argocd`.
charts/              Helm charts, one dir per service. Each app/<name>.yaml -> charts/<name>.
  argocd/            ArgoCD itself (app-of-apps deploys ArgoCD from here).
  traefik-config/    Configures the k3s-BUNDLED Traefik via HelmChartConfig (does NOT install it). Targets kube-system.
  home-assistant/    Home Assistant + Google Assistant integration.
  cloudflare-ddns/   Dynamic DNS updater.
  nginx-spa/         nginx serving the agu.com.ar SPA from the GHCR image (digest pinned by Image Updater).
  argocd-image-updater/  Argo CD Image Updater (wrapper chart) + the ImageUpdater CR that auto-updates the SPA image.
site/                Source for the agu.com.ar landing SPA (Vite + React + Tailwind).
                     Public apps (in-app tools, src/apps/registry.jsx `apps`) + a private
                     section of external links (`privateLinks`) gated by client-side Google
                     sign-in (src/auth/). Pure logic lives in plain .js modules next to each
                     component (mandelbrot.js, neutralCurrent.js, auth.js) and is unit-tested
                     with Vitest (*.test.js[x]).
                     CI: .github/workflows/site-test.yml runs tests+build on PRs/pushes;
                     .github/workflows/site.yml builds ghcr.io/frodoagu/home-site:latest (arm64);
                     Argo CD Image Updater then pins the digest into charts/nginx-spa/values.yaml via git.
docs/                Long-form guides (e.g. Google Assistant setup).
kubeconfig           Cluster kubeconfig (gitignored secrets live out-of-band).
```

## How it fits together

- **App-of-Apps**: `apps/root.yaml` syncs the whole `apps/` dir. Every other
  `apps/*.yaml` is an `Application` that deploys one chart in `charts/`. Adding a
  service = add `charts/<name>/` + `apps/<name>.yaml`; ArgoCD auto-syncs.
- **Ingress**: the Traefik bundled with k3s. Charts expose themselves with a
  Traefik **`IngressRoute`** (`apiVersion: traefik.io/v1alpha1`), `entryPoints: [websecure]`,
  and `tls.certResolver: letsencrypt`. HTTP→HTTPS redirect is global (no HTTP route needed).
- **TLS**: Let's Encrypt via ACME **DNS-01** through Cloudflare (configured in
  `charts/traefik-config`). Hostnames are under `agu.com.ar`.
- **Secrets** (Cloudflare tokens, Google HomeGraph SA, basic-auth, `ghcr-creds`,
  `git-creds`) are created **out-of-band with `kubectl create secret`** and
  referenced by name — never committed. Full list in `docs/secrets.md`.
- **SPA image auto-updates**: CI builds `site/` → `ghcr.io/frodoagu/home-site:latest`;
  the `ImageUpdater` CR (in `charts/argocd-image-updater`) pins its digest into
  `charts/nginx-spa/values.yaml` via git write-back. The v1.x Image Updater
  controller only reconciles `ImageUpdater` CRs — NOT Application annotations.
- **Instant sync**: a GitHub push webhook → `argocd.agu.com.ar/api/webhook`
  refreshes apps on push (no secret configured); otherwise ArgoCD polls ~3 min.

## Chart conventions (match these when adding/editing a chart)

- Standard Helm scaffold: `Chart.yaml`, `values.yaml`, `templates/` with
  `_helpers.tpl` (name/fullname/chart/labels/selectorLabels), `deployment.yaml`,
  `service.yaml`, `ingress.yaml` (IngressRoute), `NOTES.txt`.
- Helper template names are namespaced per chart: `{{ include "<chart>.fullname" . }}`.
- **Pin image tags** explicitly in `values.yaml` (no `latest`/`stable`); keep
  `Chart.yaml` `appVersion` in sync. Image ref pattern:
  `"{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"`.
- Ingress block shape: `ingress.{enabled, host, certResolver: letsencrypt, middlewares: []}`.
- `resources` requests/limits are tuned small for the RPi.
- `maintainers: [{name: frodoagu}]`, `repoURL: git@github.com:frodoagu/home.git`.

## Validating changes

Charts (no CI renders these — run helm locally before committing):

```bash
helm lint charts/<name>
helm template t charts/<name>            # render with defaults
helm template t charts/<name> --set k=v  # exercise conditional paths
```

Site (`site/`) — CI runs these on PRs/pushes, but run them locally too:

```bash
cd site
npm test            # Vitest unit + component tests (vitest run)
npm run build       # production bundle (also catches import/JSX errors)
```

When adding logic to a site app, keep the pure/computational part in a plain
`.js` module beside the component (e.g. `mandelbrot.js`) and add a `*.test.js`
next to it — components stay thin and the math gets covered.

## Deploying

ArgoCD picks up commits automatically (`syncPolicy.automated`, prune + selfHeal).
Manual nudge if needed: `argocd app sync <name>` or `kubectl -n argocd ...`.
