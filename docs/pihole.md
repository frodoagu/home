# Pi-hole

Network-wide DNS ad-blocker that **also runs as the LAN's DHCP server**.
Chart: `charts/pihole/` · App: `apps/pihole.yaml` (namespace `pihole`).

- Web UI: `https://pihole.agu.com.ar/admin` (Google sign-in gated)
- DNS: `192.168.0.100:53` (the Pi's static LAN IP)
- DHCP: leases `192.168.0.150 – .250`, gateway `192.168.0.1`

## Why it also does DHCP

The router can't be told to hand out a custom DNS server, so the only way to get
LAN-wide blocking without touching every device is to let Pi-hole own **DHCP** and
advertise itself as the resolver. **The router's own DHCP must be off** — two DHCP
servers on one LAN conflict.

## Networking (hostNetwork)

Pi-hole runs with `hostNetwork: true`: DNS (53) and DHCP broadcasts (67) must reach
the physical LAN, which the pod overlay network cannot do. Consequences:

- It binds the **host's** ports directly, so the web UI is moved off 80/443 (owned
  by the bundled Traefik) to **:8080** (`FTLCONF_webserver_port`).
- A `ClusterIP` Service fronts only :8080 for the Traefik `IngressRoute`; DNS and
  DHCP are reached straight at the node IP, with no Service.
- Capabilities: `NET_ADMIN` + `NET_RAW` (DHCP) and `NET_BIND_SERVICE` (:53).

The UI `IngressRoute` is gated by a **local copy** of the `google-auth` ForwardAuth
middleware — Traefik won't reference middlewares across namespaces, same pattern as
Grafana in [monitoring.md](monitoring.md).

## ⚠️ The Pi MUST have a static IP (cold-boot chicken-and-egg)

Because Pi-hole *is* the DHCP server, the Pi can't get its own IP from DHCP: at boot
the router's DHCP is off and Pi-hole (a pod) isn't up yet. Without a static IP the
whole stack deadlocks after a power cut.

The Pi uses **NetworkManager**. A static profile is configured at OS level:

```bash
sudo nmcli con add type ethernet ifname eth0 con-name static-eth0 \
  ipv4.method manual \
  ipv4.addresses 192.168.0.100/24 \
  ipv4.gateway 192.168.0.1 \
  ipv4.dns "1.1.1.1 1.0.0.1" \
  connection.autoconnect yes \
  connection.autoconnect-priority 100
```

Why these choices:

- `static-eth0` has priority **100**; the auto-generated `Wired connection 1` (DHCP)
  stays at priority **-999** as a **fallback** — if the static profile ever fails to
  activate, NM falls back to DHCP so the node stays reachable (only while the router
  DHCP is still on).
- Host DNS is **1.1.1.1**, *not* Pi-hole, so the Pi always resolves even when Pi-hole
  is down.
- `.100` is **outside** the DHCP pool (`.150–.250`), so it's never handed to another
  device.

Adding the profile does **not** disturb the live connection; it activates on the next
reboot. Verify afterwards:

```bash
nmcli -t -f NAME,DEVICE,STATE con show --active | grep eth0   # static-eth0:eth0:activated
kubectl get nodes -o wide                                     # Ready, INTERNAL-IP 192.168.0.100
```

Revert to DHCP: `sudo nmcli con delete static-eth0`.

### Does it self-recover from a full power cut? Yes — with the static IP

```
power back → Pi boots → NM applies static .100 (no DHCP needed)
  → k3s starts (service enabled) → containerd starts the cached Pi-hole image
    (imagePullPolicy: IfNotPresent — no registry or DNS needed)
  → FTL binds :53/:67 → DNS + DHCP back (~1–3 min)
```

Devices holding a valid lease keep their IP; the rest retry DHCP until Pi-hole
answers. No manual steps.

## Phased rollout

`dhcp.enabled` gates the DHCP server. Roll out in two phases so DNS can be validated
without disrupting the LAN:

1. **DNS-only** (`dhcp.enabled: false`, the committed default). Deploy, then validate:
   ```bash
   kubectl -n pihole get pods
   dig @192.168.0.100 google.com +short                        # resolves
   dig @192.168.0.100 doubleclickads.g.doubleclick.net +short  # blocked (0.0.0.0 / empty)
   ```
   and that `https://pihole.agu.com.ar/admin` loads.
2. **DHCP cutover**: turn off the router's DHCP, set `dhcp.enabled: true`, commit.
   Confirm Pi-hole is serving leases:
   ```bash
   kubectl -n pihole exec deploy/pihole -- cat /etc/pihole/dhcp.leases
   ```
   then reboot a test device and check it gets an IP in `.150–.250` with DNS `.100`.

After it's stable, do a deliberate full power-cycle to confirm everything returns on
its own (see the chicken-and-egg section above).

## Static DHCP reservations

Devices that must keep their current IP — **Broadlink** (Home Assistant addresses it
by IP) and **ESPHome Bluetooth proxies** — get MAC→IP reservations in
`dhcp.reservations`:

```yaml
dhcp:
  reservations:
    - { mac: "34:8e:89:2d:d9:ca", ip: "192.168.0.101", name: "broadlink-1" }
    - { mac: "34:8e:89:2d:c3:19", ip: "192.168.0.186", name: "broadlink-2" }
    - { mac: "d4:d4:da:4a:06:70", ip: "192.168.0.56",  name: "esphome-btproxy" }
```

These render into `FTLCONF_dhcp_hosts` as `mac,ip,name` entries joined by `;`. A
reserved IP may sit inside or outside the pool. To find a device's MAC: the router's
lease table, Home Assistant, or the Pi's neighbour table + an OUI lookup:

```bash
ip neigh show          # IP ↔ MAC on the LAN (eth0)
curl -s https://api.macvendors.com/<mac>   # identify the vendor
```

> The reservation list only captures devices seen at setup time. Any device that
> previously relied on a **router** DHCP reservation loses it when the router's DHCP
> is disabled — add it here too.

## Configuration

Everything is driven by `FTLCONF_*` env vars rendered from `values.yaml`:

| Value | Maps to | Default |
|---|---|---|
| `dns.upstreams` | `FTLCONF_dns_upstreams` | Cloudflare `1.1.1.1;1.0.0.1` |
| `dns.listeningMode` | `FTLCONF_dns_listeningMode` | `all` (safe — :53 isn't internet-exposed) |
| `dns.dnssec` | `FTLCONF_dns_dnssec` | `false` |
| `webPort` | `FTLCONF_webserver_port` | `8080` |
| `dhcp.{start,end,router,leaseTime}` | `FTLCONF_dhcp_*` | `.150 / .250 / .1 / 24h` |
| `dhcp.reservations` | `FTLCONF_dhcp_hosts` | see above |

State (config, gravity DB, FTL query DB) persists in a 2Gi `local-path` PVC at
`/etc/pihole`. Image is pinned in `values.yaml` (`pihole/pihole`, keep `Chart.yaml`
`appVersion` in sync).

## Admin password (optional)

Pi-hole's **own login is disabled by default** (`admin.disablePassword: true` → empty
`FTLCONF_webserver_api_password`); google-auth gates the UI instead. This isn't just
convenience: the `google-auth-signin` errors middleware catches 401-403 from the
**backend** too, so a Pi-hole API 401 (its own login) gets replaced with the sign-in
page and the SPA reports **"Server unreachable!"**. With no password the API never
401s and stays out of the middleware's way.

To use a password instead, set `admin.disablePassword: false` and point
`admin.existingSecret` at a secret (takes precedence):

```bash
kubectl create secret generic pihole-admin -n pihole --from-literal=password='...'
```

See [secrets.md](secrets.md).

## DNS record

`pihole.agu.com.ar` is in the cloudflare-ddns `domains` list, so its A record tracks
the home's public IP like the other services (see [the README](../README.md)).

## Rollback

Re-enable the router's DHCP and set `dhcp.enabled: false` (or
`argocd app rollback pihole`). Existing leases stay valid until renewal, so there's
slack — reboot devices to pull from the router again.
