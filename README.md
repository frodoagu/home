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
                                                  │    └─ Dashboard (https://traefik.home.agu.com.ar)
                                                  ├─ Argo CD  (https://argocd.home.agu.com.ar)
                                                  └─ Home Assistant (https://home.agu.com.ar)
```

ArgoCD manages all deployments using the [App of Apps](https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/) pattern – every chart in this repo is declared as an `Application` under `apps/`.

## Prerequisites

- Raspberry Pi (tested on RPi 4) running [k3s](https://k3s.io/)
- `kubectl` and `helm` CLI configured to reach the cluster
- DNS records pointing to the RPi's public IP:
  - `home.agu.com.ar` → Home Assistant
  - `argocd.home.agu.com.ar` → Argo CD
  - `traefik.home.agu.com.ar` → Traefik dashboard
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

### 3 – Install k3s (without the bundled Traefik)

k3s ships its own Traefik, but this repo deploys Traefik via Helm, so disable
the built-in one. Keep the bundled ServiceLB (klipper) so the Traefik
`LoadBalancer` service gets the Pi's IP.

```bash
curl -sfL https://get.k3s.io | sh -s - --disable traefik --write-kubeconfig-mode 644

# Verify the node is Ready
sudo k3s kubectl get nodes
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

ArgoCD will automatically deploy Traefik and Home Assistant.

### 3 – Create the Traefik dashboard credentials

The Traefik dashboard (`traefik.home.agu.com.ar`) is protected by HTTP basic
auth. Create the credentials secret (the password never lives in git):

```bash
htpasswd -nb admin 'your-password' | \
  kubectl create secret generic traefik-dashboard-auth \
    -n traefik --from-file=users=/dev/stdin
```

> Need `htpasswd`? Install it with `sudo apt install -y apache2-utils`.

### 4 – Customise values

Hosts and email are already set for `agu.com.ar`. If you fork to another
domain/repo, edit the `repoURL` in `apps/*.yaml` and the values below:

| Chart | Key values to change |
|---|---|
| `charts/traefik/values.yaml` | `traefik.certResolvers.letsencrypt.email`, dashboard `matchRule` host |
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
