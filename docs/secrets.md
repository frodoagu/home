# Secrets

No plaintext credentials live in git. Every secret below is committed
**encrypted** as a `SealedSecret` (`charts/<chart>/templates/<name>-sealed.yaml`);
the in-cluster `sealed-secrets-controller` decrypts each into a real Secret of
the same name/namespace, owned by the SealedSecret. Only this cluster can
decrypt them, so the committed form is safe — and the cluster is reproducible
from this repo alone (given the controller key backup, below). See
[Sealed Secrets](#sealed-secrets) for the workflow, fresh-Pi bootstrap order,
and rotation.

The imperative `kubectl create secret` commands under [Create them](#create-them)
are still how you *mint* each secret's plaintext the first time (or recover one);
you then **seal** that value instead of applying it. `kubeconfig` is gitignored —
see [.gitignore](../.gitignore).

## Required secrets

| Secret | Namespace | Used by | Holds |
|---|---|---|---|
| `traefik-cloudflare-token` | `kube-system` | Traefik ACME DNS-01 | Cloudflare API token (Zone:DNS:Edit) under key `CF_DNS_API_TOKEN` |
| `traefik-dashboard-auth` | `kube-system` | Traefik dashboard (basic auth fallback) | htpasswd `users` for HTTP basic auth |
| `oauth2-proxy-secrets` | `oauth2-proxy` | oauth2-proxy | Google OAuth `client-id`, `client-secret`, and 32-byte `cookie-secret` |
| `argocd-google-oidc` | `argocd` | ArgoCD Dex (Google login) | Google OAuth `clientId` / `clientSecret`; must carry label `app.kubernetes.io/part-of: argocd` |
| `cloudflare-ddns-token` | `cloudflare-ddns` | cloudflare-ddns | Cloudflare API token under key `CLOUDFLARE_API_TOKEN` |
| `ghcr-creds` | `agu-spa` **and** `argocd` | kubelet pull (agu-spa) + Argo CD Image Updater registry reads (argocd) | GHCR `docker-registry` creds — classic PAT with `read:packages` |
| `git-creds` | `argocd` | Argo CD Image Updater git write-back (HTTPS push) | GitHub classic PAT with `repo`, under keys `username` / `password` |
| `ha-google-sa` | `home-assistant` | Home Assistant `google_assistant` | HomeGraph service-account JSON under key `service_account.json` (optional — only for report_state / request_sync) |
| `alertmanager-telegram` | `monitoring` | Alertmanager (telegram receiver) | Telegram bot token under key `bot-token` |
| `pihole-admin` | `pihole` | Pi-hole web UI | Admin password under key `password` (**optional** — only when `admin.disablePassword: false`; by default Pi-hole's own login is off and google-auth gates the UI) |

## Create them

These commands mint each secret's **plaintext**. Rather than applying them
directly, append `--dry-run=client -o yaml | kubeseal --format yaml > …` to
commit the encrypted form (see
[Add or rotate a sealed secret](#add-or-rotate-a-sealed-secret)); apply directly
only when bootstrapping before the controller exists.

**Traefik ACME (DNS-01) — Cloudflare token:** see [tls.md](tls.md).

```bash
kubectl create secret generic traefik-cloudflare-token -n kube-system \
  --from-literal=CF_DNS_API_TOKEN='your-cloudflare-token'
```

**Traefik dashboard basic auth** (`htpasswd` comes from `apache2-utils`):

```bash
htpasswd -nb admin 'your-password' | \
  kubectl create secret generic traefik-dashboard-auth \
    -n kube-system --from-file=users=/dev/stdin
```

**oauth2-proxy Google OAuth** (powers the `google-auth` ForwardAuth middleware).
Prerequisites:
1. In Google Cloud Console → APIs & Services → Credentials, open the OAuth Client
   `1036300943412-3np4as1pb6d2ovkbt9j89aiact2bddc0` and add
   `https://auth.agu.com.ar/oauth2/callback` to *Authorized redirect URIs*.
2. Copy the client secret from the console.

```bash
kubectl create namespace oauth2-proxy
kubectl create secret generic oauth2-proxy-secrets -n oauth2-proxy \
  --from-literal=client-id='1036300943412-3np4as1pb6d2ovkbt9j89aiact2bddc0.apps.googleusercontent.com' \
  --from-literal=client-secret='<google-client-secret-from-console>' \
  --from-literal=cookie-secret="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
```

**ArgoCD Google login (Dex/OIDC).** ArgoCD's Dex reads the Google client creds
from this secret via the `$argocd-google-oidc:<key>` references in
`charts/argocd/values.yaml`. The `app.kubernetes.io/part-of: argocd` label is
**required** — ArgoCD only resolves `$`-variables from labelled secrets.
Prerequisites:
1. In Google Cloud Console, add `https://argocd.agu.com.ar/api/dex/callback` to
   the OAuth client's *Authorized redirect URIs* (same client as oauth2-proxy).
2. Copy the client secret from the console.

```bash
kubectl create secret generic argocd-google-oidc -n argocd \
  --from-literal=clientId='1036300943412-3np4as1pb6d2ovkbt9j89aiact2bddc0.apps.googleusercontent.com' \
  --from-literal=clientSecret='<google-client-secret-from-console>'
kubectl label secret argocd-google-oidc -n argocd app.kubernetes.io/part-of=argocd
```

**cloudflare-ddns token.** `charts/cloudflare-ddns/values.yaml` `domains:` spans
**two zones** — `agu.com.ar` *and* `yaskia.com` (for `yaskia-spa`) — so this token
needs **Zone:DNS:Edit on both zones** (or drop the `yaskia.com` entries):

```bash
kubectl create namespace cloudflare-ddns
kubectl create secret generic cloudflare-ddns-token -n cloudflare-ddns \
  --from-literal=CLOUDFLARE_API_TOKEN='your-cloudflare-token'
```

**Home Assistant HomeGraph service account** (Google Assistant): see
[google-assistant.md](google-assistant.md).

```bash
kubectl create secret generic ha-google-sa -n home-assistant \
  --from-file=service_account.json=/path/to/homegraph-key.json
```

**Pi-hole admin password (optional).** Pi-hole's own login is **disabled by default**
(google-auth gates the UI). Only needed if you set `admin.disablePassword: false` in
`charts/pihole/values.yaml`; then create the secret and set
`admin.existingSecret: pihole-admin`. See [pihole.md](pihole.md).

```bash
kubectl create secret generic pihole-admin -n pihole \
  --from-literal=password='your-password'
```

**GHCR + Image Updater (the private SPA pipeline).** One GitHub **classic** PAT
with `read:packages` **and** `repo` scopes drives both: pulling the private
`ghcr.io/frodoagu/home-site` image and letting Argo CD Image Updater push the
digest write-back. `ghcr-creds` goes in two namespaces (kubelet pull in
`agu-spa`, registry queries in `argocd`); `git-creds` holds the same PAT for
the HTTPS git push.

```bash
PAT='your-classic-PAT-with-repo+read:packages'

# Pull credentials in both namespaces
for ns in agu-spa argocd; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$ns" create secret docker-registry ghcr-creds \
    --docker-server=ghcr.io --docker-username=frodoagu --docker-password="$PAT"
done

# Write-back credentials (Image Updater commits the pinned digest over HTTPS)
kubectl -n argocd create secret generic git-creds \
  --from-literal=username=frodoagu --from-literal=password="$PAT"
```

**Alertmanager → Telegram bot token.** Create a bot with [@BotFather](https://t.me/BotFather)
(`/newbot`) to get the token, then message your bot once and grab your numeric
chat id (e.g. via [@userinfobot](https://t.me/userinfobot)). Only the **token** is
a secret; the chat id goes in `charts/monitoring/values.yaml`
(`victoria-metrics-k8s-stack.alertmanager.config` → `telegram_configs[0].chat_id`).

```bash
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoring create secret generic alertmanager-telegram \
  --from-literal=bot-token='123456:ABC-your-telegram-bot-token'
```

GHCR has no usable fine-grained-token path for container pulls — use a *classic*
token. Prefer narrower scope? Drop `repo` and give the Argo CD repository a
read-write deploy key instead, then point the `ImageUpdater` CR's write-back at
the SSH `repoURL` (see the [README](../README.md)).

## Rotation

To rotate, re-seal the new value and commit — the controller overwrites the
underlying Secret on sync. See [Add or rotate a sealed secret](#add-or-rotate-a-sealed-secret).
Restart the consuming workload only if it caches the value (most re-read on the
next mount projection). The two Cloudflare tokens can be the same token or
separate ones — separate is cleaner for revocation.

## Sealed Secrets

The `sealed-secrets` chart (`charts/sealed-secrets`) runs the Bitnami Sealed
Secrets controller in `kube-system` as `sealed-secrets-controller`. Every secret
in the table above is committed as a `SealedSecret` and decrypted in-cluster, so
secrets are managed **from git** like everything else. The encrypted blobs live
beside the chart that consumes them:

| Secret (ns) | File |
|---|---|
| `traefik-cloudflare-token` (kube-system) | `charts/traefik-config/templates/traefik-cloudflare-token-sealed.yaml` |
| `traefik-dashboard-auth` (kube-system) | `charts/traefik-config/templates/traefik-dashboard-auth-sealed.yaml` |
| `oauth2-proxy-secrets` (oauth2-proxy) | `charts/oauth2-proxy/templates/oauth2-proxy-secrets-sealed.yaml` |
| `argocd-google-oidc` (argocd) | `charts/argocd/templates/argocd-google-oidc-sealed.yaml` |
| `git-creds` (argocd) | `charts/argocd-image-updater/templates/git-creds-sealed.yaml` |
| `ghcr-creds` (argocd) | `charts/argocd-image-updater/templates/ghcr-creds-sealed.yaml` |
| `ghcr-creds` (agu-spa) | `charts/agu-spa/templates/ghcr-creds-sealed.yaml` |
| `cloudflare-ddns-token` (cloudflare-ddns) | `charts/cloudflare-ddns/templates/cloudflare-ddns-token-sealed.yaml` |
| `ha-google-sa` (home-assistant) | `charts/home-assistant/templates/ha-google-sa-sealed.yaml` |
| `alertmanager-telegram` (monitoring) | `charts/monitoring/templates/alertmanager-telegram-sealed.yaml` |

Install the CLI once, matching the controller's `appVersion` in
`charts/sealed-secrets/Chart.yaml` (`brew install kubeseal`). The controller is
at `kube-system/sealed-secrets-controller`, so `kubeseal` needs **no**
`--controller-*` flags (it fetches the public key from the cluster).

### Fresh-Pi bootstrap — restore the key FIRST

The controller generates a **new** signing key on first start, which cannot
decrypt any SealedSecret committed here. Before (or right after) the stack
syncs, restore the backed-up key so the controller can decrypt:

```bash
kubectl apply -f sealed-secrets-key.backup.yaml          # the off-repo backup
kubectl -n kube-system rollout restart deploy/sealed-secrets-controller
```

Until the key is restored the SealedSecrets stay `Synced=False` and the
dependent workloads crash-loop; they self-heal once the controller can decrypt.
If the backup is lost, fall back to [Create them](#create-them) to re-mint every
value, then re-seal (next section).

### Add or rotate a sealed secret

Build the Secret manifest **without applying it**, pipe through `kubeseal`, and
commit. To rotate, do the same with the new value — the new SealedSecret
overwrites the Secret on sync:

```bash
kubectl create secret generic <name> -n <namespace> \
  --from-literal=<key>='<value>' --dry-run=client -o yaml \
| kubeseal --format yaml > charts/<chart>/templates/<name>-sealed.yaml
```

To re-seal from a secret **already live** in the cluster (no plaintext re-entry),
strip server-side fields and **all annotations** first — a
`kubectl.kubernetes.io/last-applied-configuration` annotation embeds the value in
plaintext base64 and would leak into git:

```bash
kubectl get secret <name> -n <ns> -o json \
| jq '{apiVersion:"v1", kind:"Secret",
       metadata:({name:.metadata.name, namespace:.metadata.namespace}
                 + (if .metadata.labels then {labels:.metadata.labels} else {} end)),
       type:.type, data:.data}' \
| kubeseal --format yaml > charts/<chart>/templates/<name>-sealed.yaml
```

### Adopting a pre-existing (imperative) Secret

If a plain Secret of that name already exists, the controller refuses to
overwrite it (`already exists and is not managed by SealedSecret`) unless the
**existing Secret** carries `sealedsecrets.bitnami.com/managed: "true"`. Annotate
it once, then apply the SealedSecret; the controller adopts it **in place** (sets
an owner reference, value unchanged — no downtime). The committed manifests carry
this annotation in `spec.template.metadata` so re-derived Secrets stay adoptable:

```bash
kubectl annotate secret <name> -n <ns> sealedsecrets.bitnami.com/managed=true --overwrite
kubectl apply -f charts/<chart>/templates/<name>-sealed.yaml   # or let ArgoCD sync
```

### Back up the controller key

The controller generates a private key (a `Secret` in `kube-system` labelled
`sealedsecrets.bitnami.com/sealed-secrets-key`). **Losing it makes every
committed `SealedSecret` permanently unrecoverable** — back it up off the repo:

```bash
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.backup.yaml
```

> Packaging note: the chart **vendors** the upstream `controller.yaml` (the
> project's Helm repo `bitnami-labs.github.io/sealed-secrets` now 404s). To bump
> the controller, re-fetch the release manifest, re-apply the image/resources
> edits, and sync `Chart.yaml` `appVersion`. See `charts/sealed-secrets/`.
