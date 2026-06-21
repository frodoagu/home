# home 🏠

Agu's home-lab GitOps repository – Helm charts and ArgoCD applications for services running on a Raspberry Pi with k3s.

## Stack

| Component | Role | Chart location |
|---|---|---|
| [Traefik](https://traefik.io/) | Ingress / load-balancer with automatic Let's Encrypt TLS | `charts/traefik/` |
| [Argo CD](https://argo-cd.readthedocs.io/) | GitOps continuous delivery | `charts/argocd/` |
| [Home Assistant](https://www.home-assistant.io/) | Home automation | `charts/home-assistant/` |

## Architecture

```
Internet → Router (port 80/443 forwarded) → RPi
                                              └─ k3s
                                                  ├─ Traefik (LoadBalancer, port 80/443)
                                                  │    └─ Let's Encrypt ACME HTTP-01
                                                  ├─ Argo CD  (https://argocd.example.com)
                                                  └─ Home Assistant (https://homeassistant.example.com)
```

ArgoCD manages all deployments using the [App of Apps](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/) pattern – every chart in this repo is declared as an `Application` under `apps/`.

## Prerequisites

- Raspberry Pi (tested on RPi 4) running [k3s](https://k3s.io/)
- `kubectl` and `helm` CLI configured to reach the cluster
- DNS records for your domain(s) pointing to the RPi's public IP
- Router port-forwarding: **TCP 80** and **TCP 443** → RPi local IP

## Quick start

### 1 – Install ArgoCD

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd charts/argocd \
  --namespace argocd --create-namespace \
  --dependency-update
```

### 2 – Bootstrap the stack (App of Apps)

Edit the `repoURL` in `apps/root.yaml` (and other app manifests) to match your fork, then:

```bash
kubectl apply -f apps/root.yaml
```

ArgoCD will automatically deploy Traefik and Home Assistant.

### 3 – Customise values

Edit the `values.yaml` in each chart before pushing:

| Chart | Key values to change |
|---|---|
| `charts/traefik/values.yaml` | `traefik.certResolvers.letsencrypt.email` |
| `charts/argocd/values.yaml` | `argo-cd.server.ingress.hostname` |
| `charts/home-assistant/values.yaml` | `ingress.host`, `env` (e.g. timezone) |

## Repository layout

```
.
├── apps/                    # ArgoCD Application manifests
│   ├── root.yaml            # App-of-apps bootstrap entry point
│   ├── traefik.yaml
│   ├── argocd.yaml
│   └── home-assistant.yaml
└── charts/
    ├── traefik/             # Traefik wrapper (upstream chart + Let's Encrypt config)
    ├── argocd/              # Argo CD wrapper (upstream chart)
    └── home-assistant/      # Home Assistant Helm chart
```

## Let's Encrypt notes

Traefik is configured with the **HTTP-01** ACME challenge out of the box.  
If your RPi is behind NAT and you cannot expose port 80, switch to the **DNS-01** challenge by editing `charts/traefik/values.yaml`:

```yaml
traefik:
  certResolvers:
    letsencrypt:
      email: you@example.com
      dnsChallenge:
        provider: cloudflare   # or route53, digitalocean, etc.
      storage: /data/acme.json
```

ACME certificates are stored in a PersistentVolume (`/data/acme.json`) so they survive pod restarts.
