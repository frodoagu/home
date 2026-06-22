<div align="center">

<img src="docs/logo.png" alt="Sierras Pi Lab" width="180" />

# home 🏠

**Agu's home-lab GitOps repository** — Helm charts and ArgoCD applications for
services running on a Raspberry Pi with k3s.

</div>

## Stack

| Component | Role | Chart location |
|---|---|---|
| [Traefik](https://traefik.io/) | Ingress / load-balancer with automatic Let's Encrypt TLS (k3s-bundled, configured via this repo) | `charts/traefik-config/` |
| [Argo CD](https://argo-cd.readthedocs.io/) | GitOps continuous delivery | `charts/argocd/` |
| [Home Assistant](https://www.home-assistant.io/) | Home automation | `charts/home-assistant/` |
| [nginx](https://nginx.org/) | Static single-page app served at the apex `agu.com.ar` | `charts/nginx-spa/` |
| [cloudflare-ddns](https://github.com/favonia/cloudflare-ddns) | Dynamic DNS – keeps Cloudflare records on the home public IP | `charts/cloudflare-ddns/` |

## Architecture

```mermaid
flowchart TD
    Internet([Internet])
    CF[Cloudflare DNS<br/>agu.com.ar zone]
    Router[Home Router<br/>forwards TCP 80/443]

    Internet -->|DNS lookup| CF
    Internet -->|HTTPS| Router

    subgraph RPi["Raspberry Pi · k3s"]
        Traefik[Traefik<br/>bundled · LoadBalancer 80/443<br/>Let's Encrypt DNS-01]
        Argo[Argo CD]
        HA[Home Assistant<br/>hostNetwork · Bluetooth]
        SPA[nginx-spa<br/>static site]
        DDNS[cloudflare-ddns]
    end

    Router --> Traefik
    Traefik -->|argocd.agu.com.ar| Argo
    Traefik -->|home.agu.com.ar| HA
    Traefik -->|agu.com.ar| SPA
    Traefik -->|traefik.agu.com.ar<br/>dashboard| Traefik

    Argo -.->|App of Apps sync| Traefik
    Argo -.-> HA
    Argo -.-> SPA
    Argo -.-> DDNS

    Traefik -->|ACME DNS-01| CF
    DDNS -->|update A records| CF
    HA -->|mDNS/SSDP discovery| LAN([LAN devices])
```

ArgoCD manages all deployments using the [App of Apps](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/) pattern – every chart in this repo is declared as an `Application` under `apps/`.

## Prerequisites

- Raspberry Pi (tested on RPi 4) running [k3s](https://k3s.io/)
- `kubectl` and `helm` CLI configured to reach the cluster
- The `agu.com.ar` zone hosted on [Cloudflare](https://www.cloudflare.com/) and
  a Cloudflare API token with **Zone:DNS:Edit**. The `cloudflare-ddns` app
  creates/updates these A records to track the home public IP:
  - `agu.com.ar` → nginx-spa (apex static site)
  - `home.agu.com.ar` → Home Assistant
  - `argocd.agu.com.ar` → Argo CD
  - `traefik.agu.com.ar` → Traefik dashboard
- Router port-forwarding: **TCP 80** and **TCP 443** → RPi local IP

## Setup from a fresh Raspberry Pi OS

These steps take a brand-new RPi to a running k3s cluster ready for the Quick
start below. Run them on the Pi (or over SSH).

### 1 – Flash and boot Raspberry Pi OS

Flash **Raspberry Pi OS Lite (64-bit)** with [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
In the imager's advanced options (⚙️) set the hostname, enable SSH, and
configure the user/Wi-Fi so you can log in headless. Then boot the Pi and SSH in:

```bash
ssh <user>@<pi-ip>
```

### 2 – Base system prep

```bash
# Update the OS
sudo apt update && sudo apt full-upgrade -y

# Enable cgroup memory (required by k3s) – append to the kernel cmdline
sudo sed -i '1 s/$/ cgroup_memory=1 cgroup_enable=memory/' /boot/firmware/cmdline.txt

# A static IP / DHCP reservation for the Pi is strongly recommended so your
# router port-forwarding and DNS records stay valid.
sudo reboot
```

### 3 – Install k3s

This repo uses the **Traefik bundled with k3s** (configured later via a
`HelmChartConfig`), so install k3s with its defaults — no `--disable` needed.
The bundled ServiceLB (klipper) gives Traefik's `LoadBalancer` service the
Pi's IP.

```bash
curl -sfL https://get.k3s.io | sh -s - --write-kubeconfig-mode 644

# Verify the node is Ready and Traefik is running
sudo k3s kubectl get nodes
sudo k3s kubectl -n kube-system get deploy traefik
```

### 4 – Install kubectl & Helm and grab the kubeconfig

```bash
# Helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Point kubectl/helm at the k3s cluster
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config
export KUBECONFIG=~/.kube/config

# (k3s already provides kubectl as `k3s kubectl`; the line above lets the
#  standalone kubectl/helm binaries reach the cluster too.)
```

### 5 – Clone this repo

```bash
git clone https://github.com/frodoagu/home.git
cd home
```

You're now ready for the Quick start below.

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

ArgoCD applies the Traefik `HelmChartConfig` (k3s redeploys Traefik with
Let's Encrypt + the dashboard) and deploys the remaining apps (Home Assistant,
nginx-spa, cloudflare-ddns).

### 3 – Create the required secrets

These hold credentials that must never live in git. See [docs/secrets.md](docs/secrets.md)
for the full list, keys, and rotation notes.

**Traefik ACME — Cloudflare token** (Zone:DNS:Edit on `agu.com.ar`; used for the
DNS-01 challenge — see [docs/tls.md](docs/tls.md)):

```bash
kubectl create secret generic traefik-cloudflare-token -n kube-system \
  --from-literal=CF_DNS_API_TOKEN='your-cloudflare-token'
```

**Traefik dashboard** (HTTP basic auth, in the bundled Traefik's namespace):

```bash
htpasswd -nb admin 'your-password' | \
  kubectl create secret generic traefik-dashboard-auth \
    -n kube-system --from-file=users=/dev/stdin
```

> Need `htpasswd`? Install it with `sudo apt install -y apache2-utils`.

**Cloudflare DDNS** (API token with Zone:DNS:Edit on `agu.com.ar`):

```bash
kubectl create namespace cloudflare-ddns
kubectl create secret generic cloudflare-ddns-token \
  -n cloudflare-ddns --from-literal=CLOUDFLARE_API_TOKEN='your-cloudflare-token'
```

> The Google Assistant integration needs an extra secret (`ha-google-sa`) only
> if you enable it — see [docs/google-assistant.md](docs/google-assistant.md).

### 4 – Customise values

Hosts and email are already set for `agu.com.ar`. If you fork to another
domain/repo, edit the `repoURL` in `apps/*.yaml` and the values below:

| Chart | Key values to change |
|---|---|
| `charts/traefik-config/values.yaml` | `acme.email`, `dashboard.host` |
| `charts/argocd/values.yaml` | `argo-cd.server.ingress.hostname` |
| `charts/home-assistant/values.yaml` | `ingress.host`, `externalUrl`, `env` (e.g. timezone), `hostNetwork`, `googleAssistant` |
| `charts/nginx-spa/values.yaml` | `ingress.host`, `image` + `content.source` (image vs. placeholder ConfigMap) |
| `charts/cloudflare-ddns/values.yaml` | `domains`, `proxied` |

## Repository layout

```
.
├── docs/                    # Per-topic guides (secrets, TLS, Home Assistant, Google Assistant)
├── apps/                    # ArgoCD Application manifests
│   ├── root.yaml            # App-of-apps bootstrap entry point
│   ├── traefik.yaml
│   ├── argocd.yaml
│   ├── home-assistant.yaml
│   ├── nginx-spa.yaml
│   └── cloudflare-ddns.yaml
└── charts/
    ├── traefik-config/      # HelmChartConfig for the k3s-bundled Traefik (ACME, dashboard, auth)
    ├── argocd/              # Argo CD wrapper (upstream chart)
    ├── home-assistant/      # Home Assistant Helm chart
    ├── nginx-spa/           # nginx serving a static single-page app (apex agu.com.ar)
    └── cloudflare-ddns/     # Cloudflare dynamic-DNS updater
```

## Documentation

Per-topic guides live in [docs/](docs/):

- [docs/secrets.md](docs/secrets.md) — all out-of-band secrets and how to create them
- [docs/tls.md](docs/tls.md) — Let's Encrypt via the DNS-01 Cloudflare challenge
- [docs/home-assistant.md](docs/home-assistant.md) — config bootstrap, device discovery (host networking), Bluetooth
- [docs/google-assistant.md](docs/google-assistant.md) — Google Home / `google_assistant` integration runbook
- [docs/nginx-spa.md](docs/nginx-spa.md) — static SPA chart: image vs. placeholder content, SPA routing fallback

## Let's Encrypt notes

The bundled Traefik obtains certificates from Let's Encrypt using the **DNS-01**
challenge via Cloudflare (configured in `charts/traefik-config`). DNS-01 is used
because the global HTTP→HTTPS redirect would bounce an HTTP-01 challenge to
`:443` and fail it; DNS-01 needs no inbound port. It requires the
`traefik-cloudflare-token` secret (see [docs/secrets.md](docs/secrets.md)).

ACME certificates are stored in a PersistentVolume (`/data/acme.json`) so they
survive Traefik restarts. Full details and troubleshooting in
[docs/tls.md](docs/tls.md).
