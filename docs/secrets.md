# Secrets

No credentials live in git. Every chart that needs one references a Kubernetes
Secret created **out-of-band** (the `existingSecret` / secret-name pattern), so
ArgoCD never sees the sensitive value and won't prune a secret it doesn't track.

`kubeconfig` is also gitignored — see [.gitignore](../.gitignore).

## Required secrets

| Secret | Namespace | Used by | Holds |
|---|---|---|---|
| `traefik-cloudflare-token` | `kube-system` | Traefik ACME DNS-01 | Cloudflare API token (Zone:DNS:Edit) under key `CF_DNS_API_TOKEN` |
| `traefik-dashboard-auth` | `kube-system` | Traefik dashboard | htpasswd `users` for HTTP basic auth |
| `cloudflare-ddns-token` | `cloudflare-ddns` | cloudflare-ddns | Cloudflare API token under key `CLOUDFLARE_API_TOKEN` |
| `ha-google-sa` | `home-assistant` | Home Assistant `google_assistant` | HomeGraph service-account JSON under key `service_account.json` (optional — only for report_state / request_sync) |

## Create them

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

**cloudflare-ddns token:**

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

## Rotation

These secrets are imperative (not GitOps-managed). To rotate, re-create with the
same name (`kubectl create ... --dry-run=client -o yaml | kubectl apply -f -`)
and restart the consuming workload. The two Cloudflare tokens can be the same
token or separate ones — separate is cleaner for revocation.
