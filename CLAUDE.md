# Repository guide

Agu's home-lab **GitOps** repository: Helm charts + ArgoCD `Application`s for
services running on a Raspberry Pi with **k3s**. Mostly Kubernetes/Helm
manifests; the exceptions are `site/`, the source for the agu.com.ar landing
SPA (built into an image by CI — see below), and `esphome/`, ESP32 firmware
configs flashed out-of-band (not deployed by ArgoCD). The README has the full operator
runbook (fresh-Pi setup, secrets, DNS); this file is the orientation for editing.

## Layout

```
apps/                ArgoCD Application manifests (App-of-Apps). One file per workload.
  root.yaml          Root app — points at apps/ itself; `kubectl apply -f` this once to bootstrap.
  <name>.yaml        One Application per chart, all in namespace `argocd`.
charts/              Helm charts, one dir per service. Each app/<name>.yaml -> charts/<name>.
  argocd/            ArgoCD itself (app-of-apps deploys ArgoCD from here). Google login via bundled Dex/OIDC;
                     the local `admin` account is disabled (`admin.enabled: "false"`) so sign-in is Google-only.
  traefik-config/    Configures the k3s-BUNDLED Traefik via HelmChartConfig (does NOT install it). Targets kube-system.
                     Also ships the dashboard IngressRoute + auth middlewares (google-auth ForwardAuth,
                     dashboard-auth basic-auth fallback) and the www→apex redirect.
  oauth2-proxy/      Google OAuth2 ForwardAuth backend (wrapper chart over upstream). Backs the
                     `google-auth` Traefik middleware that gates the dashboard. Host: auth.agu.com.ar.
  home-assistant/    Home Assistant + Google Assistant integration. The ONLY private service not behind
                     google-auth (its own login stays, so the mobile app / Google Assistant webhook keep
                     working); a Traefik rateLimit on /auth/* throttles login brute-force (see gotchas).
  cloudflare-ddns/   Dynamic DNS updater.
  agu-spa/         nginx serving the agu.com.ar SPA from the GHCR image (digest pinned by Image Updater).
  argocd-image-updater/  Argo CD Image Updater (wrapper chart) + the ImageUpdater CR that auto-updates the SPA image.
  monitoring/        VictoriaMetrics k8s-stack + blackbox (wrapper chart). Grafana at grafana.agu.com.ar
                     (google-auth gated), Telegram alerts, RPi temp/throttle, uptime/TLS probes.
                     Custom dashboards are JSON under charts/monitoring/dashboards/ (globbed into one
                     ConfigMap; bundled defaultDashboards are off). Also provisions the VictoriaLogs
                     Grafana datasource (see victoria-logs below). See docs/monitoring.md.
  pihole/            Pi-hole DNS ad-blocker + DHCP server (hostNetwork). UI at pihole.agu.com.ar (google-auth).
  victoria-logs/     VictoriaLogs single + bundled Vector collector (wrapper chart). Cluster-wide log DB;
                     UI (vmui) at logs.agu.com.ar (google-auth) + queryable from Grafana. SD-friendly retention.
  sealed-secrets/    Bitnami Sealed Secrets controller, VENDORED from the upstream release manifest
                     (its Helm repo 404s). In kube-system as `sealed-secrets-controller` (kubeseal zero-flag).
  homepage/          gethomepage dashboard/start page at dash.agu.com.ar (google-auth). k8s service
                     discovery + cluster resource widget via RBAC.
site/                Source for the agu.com.ar landing SPA (Vite + React + Tailwind).
                     Public apps (in-app tools, src/apps/registry.jsx `apps`) + a private
                     section of external links (`privateLinks`) gated by client-side Google
                     sign-in (src/auth/). Pure logic lives in plain .js modules next to each
                     component (mandelbrot.js, neutralCurrent.js, auth.js) and is unit-tested
                     with Vitest (*.test.js[x]).
                     CI: .github/workflows/site-test.yml runs tests+build on PRs/pushes;
                     .github/workflows/site.yml builds ghcr.io/frodoagu/home-site:latest (arm64);
                     Argo CD Image Updater then pins the digest into charts/agu-spa/values.yaml via git.
.github/workflows/   CI. site-test.yml (Vitest+build) and site.yml (SPA image build) for site/;
                     release.yml (auto semver tag+release from Conventional Commits on push to main)
                     and pr-lint.yml (Conventional-Commit PR-title gate). See "Commit & release conventions".
esphome/             ESP32 firmware configs (ESPHome YAML) flashed to devices out-of-band — NOT a
                     Kubernetes workload, so no chart/ArgoCD app. saeco-lirika.yaml controls a Saeco
                     Lirika coffee machine (see docs/cafetera-saeco-lirika.md). Secrets via !secret
                     (secrets.yaml gitignored; secrets.yaml.example is the template).
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
- **Auth (Google sign-in)**: two independent paths, both using the same Google
  OAuth client. (1) The **Traefik dashboard** (`traefik.agu.com.ar`) is gated by
  the `google-auth` Traefik **ForwardAuth** middleware → `oauth2-proxy`
  (`auth.agu.com.ar`); a `google-auth-signin` `errors` middleware turns 401/403s
  into a sign-in redirect. The session cookie is scoped to `.agu.com.ar`, so one
  sign-in covers all subdomains; authorization is an explicit email allowlist
  (`authenticatedEmailsFile.restricted_access` in `charts/oauth2-proxy/values.yaml`),
  NOT `--email-domain`. (2) **ArgoCD** logs in via its bundled **Dex/OIDC**
  (`charts/argocd/values.yaml`); its local `admin` account is disabled
  (`admin.enabled: "false"`), so Google is the only sign-in and the email must
  be mapped to `role:admin`. **Home Assistant** is deliberately NOT behind
  google-auth (the mobile app / Google Assistant webhook need direct access) —
  it keeps its own login, fronted by a Traefik `rateLimit` on `/auth/*`
  (`charts/home-assistant`). The site's `privateLinks` use a separate,
  purely client-side Google sign-in (`site/src/auth/`) — unrelated to oauth2-proxy.
- **Secrets** (Cloudflare tokens, Google OAuth for oauth2-proxy + ArgoCD Dex,
  Google HomeGraph SA, dashboard basic-auth fallback, `ghcr-creds`, `git-creds`)
  are created **out-of-band with `kubectl create secret`** and
  referenced by name — never committed. Full list in `docs/secrets.md`. The
  `sealed-secrets` controller (kube-system) offers a git-committable alternative:
  `kubeseal` encrypts a Secret into a `SealedSecret` only this cluster can decrypt.
- **SPA image auto-updates**: CI builds `site/` → `ghcr.io/frodoagu/home-site:latest`;
  the `ImageUpdater` CR (in `charts/argocd-image-updater`) pins its digest into
  `charts/agu-spa/values.yaml` via git write-back. The v1.x Image Updater
  controller only reconciles `ImageUpdater` CRs — NOT Application annotations.
- **Instant sync**: a GitHub push webhook → `argocd.agu.com.ar/api/webhook`
  refreshes apps on push (no secret configured); otherwise ArgoCD polls ~3 min.
- **Releases**: every change lands via **squash-merge of a Conventional-Commit
  PR title** (`pr-lint.yml` enforces it). On push to `main`, `release.yml`
  derives the next semver tag (`feat:`→minor, `fix:`→patch, `BREAKING CHANGE`→major)
  and publishes a GitHub release. Tags are bookkeeping only — nothing deploys off
  them. See "Commit & release conventions".

## Chart conventions (match these when adding/editing a chart)

- Standard Helm scaffold: `Chart.yaml`, `values.yaml`, `templates/` with
  `_helpers.tpl` (name/fullname/chart/labels/selectorLabels), `deployment.yaml`,
  `service.yaml`, `ingress.yaml` (IngressRoute), `NOTES.txt`.
- **Wrapper charts** (`oauth2-proxy`, `argocd-image-updater`, `argocd`, `monitoring`,
  `victoria-logs`) don't have their own `deployment.yaml`: they declare the real chart as a
  `Chart.yaml` dependency, forward config under a sub-key in `values.yaml`, and add
  only their own templates (IngressRoute, CRs, ConfigMaps). Run `helm dependency
  build charts/<name>` before templating locally. The fetched `charts/*/charts/`
  and `Chart.lock` are gitignored and NOT committed — ArgoCD resolves dependencies
  from the upstream repos at sync time.
- Helper template names are namespaced per chart: `{{ include "<chart>.fullname" . }}`.
- **Pin image tags** explicitly in `values.yaml` (no `latest`/`stable`); keep
  `Chart.yaml` `appVersion` in sync. Image ref pattern:
  `"{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"`.
- Ingress block shape: `ingress.{enabled, host, certResolver: letsencrypt, middlewares: []}`.
- `resources` requests/limits are tuned small for the RPi.
- `maintainers: [{name: frodoagu}]`, `repoURL: git@github.com:frodoagu/home.git`.

## Per-chart gotchas (hard-won — don't re-investigate)

- **monitoring — Grafana datasources/plugins.** The VM k8s-stack provisions
  datasources via `victoria-metrics-k8s-stack.defaultDatasources` (it renders a
  `grafana_datasource`-labelled ConfigMap that the Grafana sidecar imports), NOT
  Grafana's native `grafana.additionalDataSources` (that key silently renders
  nothing here). Add custom datasources under `defaultDatasources.extra` (a list
  of full datasource objects, tpl-rendered). There's a built-in
  `defaultDatasources.victorialogs`, but it only auto-derives a URL when the
  stack deploys VL itself — we run VL separately, so we use `extra` with an
  explicit `url`. Grafana plugins go under `grafana.plugins`; the VictoriaLogs
  datasource plugin `victoriametrics-logs-datasource` is signed and fetched from
  grafana.com at pod start (needs egress).
- **victoria-logs.** The upstream `victoria-logs-single` chart bundles a **Vector**
  agent (`vector.enabled: true`, DaemonSet) whose elasticsearch sink is
  auto-wired to the server when both are enabled — no manual endpoint needed.
  `server.fullnameOverride: victoria-logs` gives a stable Service `victoria-logs:9428`
  (named port `http`) for the IngressRoute and the Grafana datasource URL
  `http://victoria-logs.victoria-logs.svc.cluster.local:9428`. SD-card friendly:
  bound BOTH `server.retentionPeriod` and `server.retentionDiskSpaceUsage`.
- **sealed-secrets.** Its canonical Helm repo `bitnami-labs.github.io/sealed-secrets`
  **404s** (post-2025 Bitnami/Broadcom catalog changes), so this chart is NOT a
  wrapper — it **vendors** the upstream release `controller.yaml` into
  `templates/controller.yaml`. Only image/`imagePullPolicy`/`resources` are
  parameterized; controller + CRD + RBAC + Services stay verbatim in kube-system
  with name `sealed-secrets-controller` (so kubeseal needs no flags). The image
  `docker.io/bitnami/sealed-secrets-controller:<ver>` is still published (it's
  maintained by the sealed-secrets project, NOT the Bitnami app catalog → not hit
  by the bitnamilegacy migration). To bump: re-fetch
  `…/releases/download/v<X.Y.Z>/controller.yaml`, re-apply the same 3 edits, sync
  `appVersion`. Back up the controller key (Secret labelled
  `sealedsecrets.bitnami.com/sealed-secrets-key`) — losing it = unrecoverable.
- **homepage.** v1.x validates the request `Host` header, so set
  `HOMEPAGE_ALLOWED_HOSTS` (built from `ingress.host`) AND use **TCP** probes —
  HTTP probes fail because the kubelet sends the pod IP as Host. `LOG_TARGETS=stdout`
  avoids writing to the read-only `/app/config` ConfigMap mount. Config files
  (settings/services/widgets/bookmarks/kubernetes/docker.yaml) are rendered from
  `config.*` values via `toYaml`. Traefik IngressRoutes aren't auto-discovered
  like k8s Ingresses, so services are listed statically in `values.yaml`.
- **home-assistant — rate-limit source IP.** All traffic is proxied through
  Cloudflare (`proxied: true`), so Traefik sees a Cloudflare edge IP as the peer.
  The HA login `rateLimit` middlewares therefore key on the real client IP via
  `sourceCriterion.requestHeaderName: Cf-Connecting-IP` (`rateLimit.clientIPHeader`);
  keying on the peer IP would lump every visitor into one shared bucket. This
  trusts that header — sound only while the origin is reachable exclusively via
  Cloudflare. The tight limit is scoped to a dedicated `/auth/*` route (longer
  rule → Traefik prefers it); the catch-all gets a generous volumetric cap.
- **New public hostnames** must be added to `charts/cloudflare-ddns/values.yaml`
  `domains:` (the DDNS updater creates the Cloudflare A records).
- Local env: `helm` v3.14.2; chart-dependency repos (vm, oauth2-proxy,
  prometheus-community) are reachable for `helm dependency build`.

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

## Commit & release conventions

**Always use [Conventional Commits](https://www.conventionalcommits.org/).** This
isn't cosmetic — it drives the automated tag/release pipeline, and it's enforced.

- **Squash-merge only** (merge & rebase are disabled on the repo). The repo is set
  to use the **PR title as the squash commit subject**, so the PR title is what
  lands on `main` and what the release tooling reads. `.github/workflows/pr-lint.yml`
  (amannn/action-semantic-pull-request) **fails any PR whose title isn't a
  Conventional Commit** — so write `feat: …`, `fix: …`, `docs: …`, not `add thing`.
- **`release.yml`** (push to `main`, mathieudutour/github-tag-action +
  softprops/action-gh-release) computes the next tag from the commits since the
  last tag and publishes a GitHub release with the conventional-commit changelog:

  | Commit type | Bump |
  |---|---|
  | `feat:` | minor |
  | `fix:` | patch |
  | `feat!:` / `BREAKING CHANGE:` footer | major |
  | `build:` / `chore:` / `docs:` / Image Updater `build:` write-backs | **none** (no release) |

  `default_bump: false` is why non-bumping types (and the Image Updater's automated
  commits) cut no release — flip it to `patch` only if you want a tag on every push.
- **Tags/releases are bookkeeping only** — nothing deploys off them. ArgoCD syncs
  `main` directly; the SPA still updates by digest. Don't gate deploys on a tag.
- Versioning started from a seeded **`v0.0.0`** genesis tag (gives the action a
  real baseline; the implicit no-tag baseline would create nothing under
  `default_bump: false`); the first release is **`v1.0.0`**.

## Deploying

ArgoCD picks up commits automatically (`syncPolicy.automated`, prune + selfHeal).
Manual nudge if needed: `argocd app sync <name>` or `kubectl -n argocd ...`.
