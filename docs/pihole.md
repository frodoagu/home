# Pi-hole

Network-wide DNS ad-blocker that **also runs as the LAN's DHCP server**.
Chart: `charts/pihole/` · App: `apps/pihole.yaml` (namespace `pihole`).

- Web UI: `https://pihole.agu.com.ar/admin` (Google sign-in gated)
- DNS: `192.168.0.100:53` (the Pi's static LAN IP)
- DHCP: dynamic pool `192.168.0.150 – .250`, static reservations `.10 – .99`,
  gateway `192.168.0.1` (see [address plan](#address-plan))

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

### Address plan

The static and the dynamic halves of `192.168.0.0/24` are kept apart, so no device
that something else addresses by IP can ever have its address handed to a phone
while it is off:

| Range | Use |
|---|---|
| `.1` | router (gateway) |
| `.10 – .99` | **static** reservations, one decade per device class |
| `.100` | the Pi — static on the host (NetworkManager), not a DHCP reservation |
| `.101 – .149` | free headroom |
| `.150 – .250` | **dynamic** pool (`dhcp.start` – `dhcp.end`) |

dnsmasq already keeps a reserved address out of the pool even when it sits inside
`start`–`end`, so the split isn't what makes this correct — it's what makes it
readable, and it means the pool can be widened without auditing every reservation.

### The reservations

Devices that must keep their address because something else addresses them by IP —
**Broadlink** and the **webOS TVs** (Home Assistant config entries), the **Shelly**
door switches (`charts/shelly-config` + `charts/shelly-proxy`), the **Candy**
washer-dryer (`packages/lavarropas.yaml`, `scripts/candyctl.py`) and the **ESPHome
BLE proxies** — get MAC→IP reservations in `dhcp.reservations`, grouped by class:

```yaml
dhcp:
  reservations:
    # .10-.19  ESPHome / BLE proxies
    - { mac: "d4:d4:da:4a:06:70", ip: "192.168.0.10", name: "esphome-btproxy" }
    - { mac: "30:76:f5:e6:ab:38", ip: "192.168.0.11", name: "ble-proxy" }
    # .20-.29  Shelly relays
    - { mac: "7c:2c:67:67:2c:90", ip: "192.168.0.20", name: "shelly-escalera" }
    - { mac: "7c:2c:67:60:94:38", ip: "192.168.0.21", name: "shelly-puerta-principal" }
    # .30-.39  Broadlink IR blasters
    - { mac: "34:8e:89:2d:d9:ca", ip: "192.168.0.30", name: "broadlink-1" }  # dormitorio
    - { mac: "34:8e:89:2d:c3:19", ip: "192.168.0.31", name: "broadlink-2" }  # living
    - { mac: "34:8e:89:2d:bb:4b", ip: "192.168.0.32", name: "broadlink-3" }  # cocina
    - { mac: "34:8e:89:2e:29:c7", ip: "192.168.0.33", name: "broadlink-4" }  # chicos
    # .40-.49  electrodomesticos
    - { mac: "48:55:19:c1:90:bb", ip: "192.168.0.40", name: "lavarropas" }
    # .50-.59  TVs / media
    - { mac: "4c:ba:d7:11:bb:12", ip: "192.168.0.50", name: "tv-sala" }
    - { mac: "44:cb:8b:e4:44:c8", ip: "192.168.0.51", name: "tv-dormitorio" }
    # .70-.79  computers
    - { mac: "3c:7c:3f:50:dd:03", ip: "192.168.0.70", name: "pc-fede" }   # gaming
    - { mac: "f4:4e:e3:98:c9:4d", ip: "192.168.0.71", name: "think" }     # work laptop
    - { mac: "a8:e2:91:b8:67:1a", ip: "192.168.0.72", name: "pc-noah" }
    - { mac: "60:ff:9e:8d:f9:7a", ip: "192.168.0.73", name: "pc-julian" }
    # .80-.89  phones
    - { mac: "28:12:d0:99:e5:e1", ip: "192.168.0.80", name: "celu-fede" }  # motorola edge 70
```

### Random MACs (laptops, phones)

A reservation is keyed on the MAC, so a device that randomizes it silently falls
back to the dynamic pool. The tell is a locally-administered address (second hex
digit `2`, `6`, `A` or `E`, e.g. `b6:ca:…`) and a device that shows up in
Pi-hole's network table under many MACs. Pin the real MAC on the device first,
reconnect, and only then copy the address from `dhcp.leases`:

- **Android**: Wi-Fi → the network → Privacy → *Use device MAC*. Each SSID keeps
  its own setting, so repeat it for every SSID the phone joins.
- **iOS**: Wi-Fi → (i) → *Private Wi-Fi Address* → Off.
- **Windows**: Wi-Fi → *Random hardware addresses* → Off (global and per network).
- **NetworkManager** (`think`): `nmcli connection modify <conn>
  802-11-wireless.cloned-mac-address permanent` (the burned-in MAC) or `stable`
  (a fixed per-network MAC), then reconnect.

To find a new Shelly's MAC/IP: it registers on the LAN with no reverse-DNS hostname
(`nmap -sn 192.168.0.0/24`), and its local HTTP API confirms the model —
`curl http://<ip>/shelly`.

These render into `FTLCONF_dhcp_hosts` as `mac,ip,name` entries joined by `;`. To
find a device's MAC: the live lease table, Home Assistant, or the Pi's neighbour
table + an OUI lookup:

```bash
kubectl -n pihole exec deploy/pihole -- cat /etc/pihole/dhcp.leases
ip neigh show          # IP ↔ MAC on the LAN (eth0)
curl -s https://api.macvendors.com/<mac>   # identify the vendor
```

> **Renumbering one of these is never just an edit in `values.yaml`.** Grep the repo
> for the old address (`charts/shelly-config`, `charts/shelly-proxy`,
> `packages/lavarropas.yaml`, `scripts/candyctl.py`, `docs/`) and re-point the
> matching Home Assistant config entry **by hand** — Broadlink, webOS and ESPHome are
> config-flow integrations that keep the host in `/config/.storage`, where git can't
> reach it. The device itself only picks up the new address when its lease renews
> (`leaseTime: 24h`) or it is power-cycled.

> The reservation list only captures devices seen at setup time. Any device that
> previously relied on a **router** DHCP reservation loses it when the router's DHCP
> is disabled — add it here too.

### Reaching a device by name instead of by IP

Pi-hole hands DHCP clients the local domain `lan` (`dns.domain` →
`FTLCONF_dns_domain`) and answers every lease **and every static reservation**
under it, using the entry's `name`. So the reservation list is the single source of
truth for those addresses and consumers don't have to hardcode them:

```bash
dig +short lavarropas.lan @192.168.0.100        # -> 192.168.0.40
dig +short shelly-escalera.lan @192.168.0.100   # -> 192.168.0.20
```

That works on the LAN for free (every device gets Pi-hole as its resolver), but
**not inside the cluster**: pods resolve through CoreDNS, which forwards what it
doesn't own to the node's upstream rather than to Pi-hole, so `lavarropas.lan` is
NXDOMAIN in a pod. `dns.clusterForwarding` fixes that by rendering the
`coredns-custom` ConfigMap:

```
lan:53 {
    errors
    cache 300 {
        success 9984 300 300
        denial 9984 300 300
    }
    forward . 192.168.0.100
}
```

k3s's CoreDNS already mounts a ConfigMap named exactly `coredns-custom` from
`kube-system` as an **optional** volume at `/etc/coredns/custom`, and its stock
Corefile ends with `import /etc/coredns/custom/*.server` — so this splices in a
server block without touching the k3s-managed Corefile, and no Deployment change is
needed. `forward` points at the **node's LAN IP** because Pi-hole runs hostNetwork
(there is no Service for :53). CoreDNS's `reload` plugin picks the change up within
~2 min; `kubectl -n kube-system rollout restart deploy/coredns` forces it.

#### Why the TTLs are pinned

dnsmasq answers everything it builds itself — leases, reservations, `localRecords` —
with **TTL 0**, and the NODATA for an IPv4-only device's AAAA carries no SOA, so no
TTL at all. Nothing downstream can cache either: before `dns.localTTL`, CoreDNS
forwarded every `lavarropas.lan` lookup (A + AAAA) to Pi-hole, and while the washer
was off the Candy poller's 5 retries a minute made that ~13k queries a day, the
single biggest client on the LAN. `dns.localTTL` (300 s) fixes both ends: it renders
`local-ttl` into `misc.dnsmasq_lines` for every LAN client, and the CoreDNS block
above floors both success and denial at the same value (the `MINTTL` field), which
is what makes the TTL-less NODATA cacheable. The cost is that a renumbered device
can take up to 5 min to resolve to its new address.

Who uses names, and who deliberately doesn't:

| Consumer | Runs in | Addressing |
|---|---|---|
| `packages/lavarropas.yaml` | HA pod | `lavarropas.lan` |
| `charts/shelly-config` reconciler | CronJob pod | `shelly-*.lan` |
| `scripts/candyctl.py` | your laptop | `lavarropas.lan` |
| `charts/shelly-proxy` nginx | nginx pod | **IP** — literal `proxy_pass` resolves at startup, so an unresolvable name makes the pod refuse to start |
| `scripts/luces-afuera.js` | **on the Shelly** | **IP** — it exists to survive HA and the Pi being down; a name puts Pi-hole back on the critical path |

Note the circularity this introduces for the pod cases: Pi-hole is itself a
workload, so on a cold boot a pod may briefly fail to resolve a device until
Pi-hole is up. That's the same chicken-and-egg the DHCP cutover has, and the same
answer — these are all retrying consumers (the Candy package retries 5×, the
reconciler runs again in 30 min).

## Configuration

Everything is driven by `FTLCONF_*` env vars rendered from `values.yaml`:

| Value | Maps to | Default |
|---|---|---|
| `dns.upstreams` | `FTLCONF_dns_upstreams` | Cloudflare `1.1.1.1;1.0.0.1` |
| `dns.listeningMode` | `FTLCONF_dns_listeningMode` | `all` (safe — :53 isn't internet-exposed) |
| `dns.dnssec` | `FTLCONF_dns_dnssec` | `false` |
| `dns.localTTL` | `local-ttl` in `FTLCONF_misc_dnsmasq_lines` + CoreDNS `.lan` cache | `300` (dnsmasq's own default is 0) |
| `dns.blockTTL` | `FTLCONF_dns_blockTTL` | `300` (FTL's default is 2, so blocked trackers are re-queried on every retry; an unblock takes up to this long to reach clients) |
| `dns.localRecords` | `FTLCONF_dns_hosts` | see below |
| `webPort` | `FTLCONF_webserver_port` | `8080` |
| `dhcp.{start,end,router,leaseTime}` | `FTLCONF_dhcp_*` | `.150 / .250 / .1 / 24h` |
| `dhcp.reservations` | `FTLCONF_dhcp_hosts` | see above |

## Local DNS records (split-horizon)

`dns.localRecords` makes Pi-hole answer `*.agu.com.ar` with the Pi's own LAN IP
instead of forwarding upstream and getting back Cloudflare's public IP. Traefik on
the Pi does the same host-based routing either way, so this only shortcuts the
path (no NAT hairpin out to the internet and back) — behavior is identical to the
public route. Devices not using Pi-hole as their resolver are unaffected.

```yaml
dns:
  localRecords:
    - ip: "192.168.0.100"
      hosts:
        - agu.com.ar
        - www.agu.com.ar
        - home.agu.com.ar
        - argocd.agu.com.ar
        - traefik.agu.com.ar
        - auth.agu.com.ar
        - grafana.agu.com.ar
        - pihole.agu.com.ar
        - logs.agu.com.ar
        - dash.agu.com.ar
        - alertmanager.agu.com.ar
```

Renders into `FTLCONF_dns_hosts` as one `IP host1 host2 ...` entry per `ip` (hosts-file
syntax), multiple `ip` groups joined by `;`. Verify after deploying:

```bash
dig @192.168.0.100 agu.com.ar +short          # -> 192.168.0.100 (from the LAN)
dig @1.1.1.1 agu.com.ar +short                # -> Cloudflare's public IP (unchanged)
```

`yaskia.com` also runs on this Pi but was deliberately left out — it still
resolves via Cloudflare even on the LAN. Add it to `localRecords` the same way if
that hairpin ever becomes annoying.

### Caveat: the HTTPS (SVCB) record must be served locally too

`localRecords` are hosts-file entries, so they override **A/AAAA only**. Browsers
also query the **HTTPS record (type 65)**, and left alone that one is forwarded
upstream and answered by Cloudflare — advertising `alpn="h3,h2"` plus an **ECH
config** whose public name is `cloudflare-ech.com`.

That ECH config breaks the LAN path. Chromium's built-in resolver (the default on
Windows, unlike Linux where it goes through `getaddrinfo`) fetches the record,
encrypts the real SNI and sends `cloudflare-ech.com` as the outer SNI — to the Pi,
because the A record is local. Traefik has no certificate for that name, answers
with `TRAEFIK DEFAULT CERT`, and the browser fails with
`ERR_ECH_FALLBACK_CERTIFICATE_INVALID`.

So the chart also serves the HTTPS record locally for every `localRecords` host:
`dns.localHttpsRecord` (hex RDATA of `1 . alpn="h3,h2"`) becomes one dnsmasq
`dns-rr=<host>,65,<hex>` line each, via `FTLCONF_misc_dnsmasq_lines`:

```bash
dig @192.168.0.100 A      home.agu.com.ar +short   # -> 192.168.0.100 (local record)
dig @192.168.0.100 TYPE65 home.agu.com.ar +short   # -> 1 . alpn="h3,h2" (local, no ech)
```

The ALPN still says h3, so Traefik must actually serve QUIC on udp/443
(`http3.enabled` in `charts/traefik-config`, see
[tls.md](tls.md#http3-udp443--lan-only)) or Chromium fails with
`ERR_QUIC_PROTOCOL_ERROR` instead of falling back to TCP.

The record is scoped to exact names on purpose: a global dnsmasq `filter-rr=65`
disables ECH for every site on the LAN, and `local=/home.agu.com.ar/` also
swallows `_acme-challenge.home.agu.com.ar`, breaking DNS-01 renewal for that
certificate. `dns-rr` touches only type 65 of the listed names. A host added to
`localRecords` gets its HTTPS record automatically.

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
