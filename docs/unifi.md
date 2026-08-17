# UniFi Network Application (`charts/unifi`)

Self-hosted controller for the LAN's UniFi access point, at
`unifi.agu.com.ar` (google-auth gated). Deployed as a Deployment + its own
MongoDB, both on the Pi's SD card.

| Piece | Where it lives |
|---|---|
| Controller | `lscr.io/linuxserver/unifi-network-application` (arm64) |
| Database | `mongo:7.0.x`, cluster-internal only |
| Managed device | AP "Oficina", `f4:92:bf:10:74:f9` → `192.168.0.163` (pinned in `charts/pihole` DHCP reservations) |
| Credentials | `unifi-mongo` Secret, out-of-band ([docs/secrets.md](secrets.md)) |

## What this is NOT: UniFi OS Server

Ubiquiti's self-hosted **UniFi OS Server** cannot run here, for two independent
reasons: it is **x86-64 only** (no arm64 build, and this cluster is a Pi 5), and
it installs as a **host-level podman + systemd stack**, not as a container that
Kubernetes can schedule. The **UniFi Network Application** — the classic Java
controller — is the piece that ships arm64 images, and it is what this chart
runs. If a future Ubiquiti release changes either constraint, this whole chart
becomes replaceable; nothing else depends on its internals.

There is **no UniFi gateway** on this network (the router is an ISP Sagemcom), so
the controller manages the AP only. No DPI, no IDS/IPS, no traffic flows, no WAN
statistics — those all require a USG/UXG/UDM. This is load-bearing for the
storage sizing below: **DPI is the single largest data producer in UniFi, and it
never runs here.**

## MongoDB version has a hardware floor

Network 10.x supports MongoDB up to 8.0; 7.0 is the best-tested pairing and is
what the chart pins. On arm64 that choice is constrained by the CPU, not by
preference: MongoDB ≥5.0 needs **ARMv8.2-A** (LSE atomics). The Pi 5 is a
Cortex-A76 (ARMv8.2-A) and is fine. A Pi 4 is a Cortex-A72 (ARMv8.0-A) and would
be capped at **MongoDB 4.4** — worth remembering if this ever moves hardware.

## Why hostNetwork, and why Pi-hole moved off 8080

Adoption is a layer-2 protocol: the AP and the controller find each other with
**UDP broadcast on 10001**, which the pod overlay network cannot carry. Running
the controller in `hostNetwork` also makes it see `192.168.0.100` as its own
address, so the inform URL it hands to the AP is LAN-reachable with no
`system_ip` override — the same reasoning as [`charts/pihole`](../charts/pihole).

That put two hostNetwork pods on one node, and they collided:

- **`8080/tcp`** is UniFi's **inform** port — the one a factory-reset AP tries on
  its own, and the one baked into every device that has ever been adopted.
- Pi-hole was already bound to `8080` for its web UI, a port reached **only by
  Traefik** through a ClusterIP Service.

Pi-hole's port is the arbitrary one, so Pi-hole yields: `webPort` and
`service.port` moved to **8081**. Pi-hole's DNS (53) and DHCP (67) are untouched.
The alternative — moving UniFi's inform port via `unifi.http.port` in
`system.properties` — was rejected because it breaks stock auto-adoption and has
to be re-applied by hand after any AP factory reset.

Host ports the controller now owns: `8080/tcp` (inform), `8443/tcp` (UI),
`3478/udp` (STUN), `10001/udp` (discovery), `1900/udp` (discoverable). None are
port-forwarded; they are LAN-only. Only the UI is exposed publicly, through
Traefik.

## The UI is HTTPS with a self-signed cert

The controller has no plain-HTTP UI listener — it serves 8443 over TLS with a
certificate it generates itself, and there is no supported way to hand it the
Let's Encrypt cert. The IngressRoute therefore uses a **`ServersTransport` with
`insecureSkipVerify: true`** plus `scheme: https` on the service. The browser
still gets the real letsencrypt cert from Traefik; only the Traefik→controller
hop inside the node skips verification. This is the first `ServersTransport` in
the repo.

## Storage: bounding growth on the SD card

Two PVCs on the default `local-path` StorageClass — `unifi-config` (2 Gi,
`/config`: site config, certs, **auto-backups**, logs) and `unifi-data` (8 Gi,
MongoDB). Both live on the Pi's SD card, like every other stateful chart here.

### The sizes are not limits

`local-path` **enforces no quota at all**: the capacity requested in a PVC is
ignored and the volume grows until the disk is full (documented upstream in
`rancher/local-path-provisioner`). So those two numbers are reporting metadata,
nothing more. Nothing at the filesystem layer will stop MongoDB.

That is worth stating plainly because it is easy to misread a `size:` field as a
guardrail. **The real bounds are all above the filesystem** — the retention
settings and the auto-backup count below, plus the alert that watches the trend.
Skipping them means there is no limit at all.

If a hard ceiling is ever wanted without new hardware, the way to get one is a
fixed-size loopback filesystem (`fallocate` an image on the card, `mkfs.ext4`,
mount it, point a `local` PV at the mount). That is not deployed today; the
retention settings are considered sufficient at this scale.

### Cost to the SD card

MongoDB adds continuous write load to the card, which is the usual reason to
avoid it. In context, the marginal risk is smaller than it sounds: this node
already runs **VictoriaMetrics and VictoriaLogs** on the same card, both of which
write far more than a one-AP UniFi controller ever will. The card also has ~90 GB
free, against a database expected to settle in the hundreds of MB. The failure
mode to actually watch for is not steady-state growth but an unbounded backlog —
which is exactly what the retention and auto-backup settings prevent.

### Retention is UI state, and git cannot set it

The statistics retention settings live in **MongoDB**, reachable only through
Settings → System → Other Configuration (untick "Statistics Retention" to unlock
the per-bucket fields). There is no `system.properties` key for them and no
config file to template. This is the same trap as `telegram_bot` and `http:` in
Home Assistant — see the per-chart gotchas in [CLAUDE.md](../CLAUDE.md).

So the buckets have to be set **by hand after first login**, and re-set after any
restore from backup. Suggested for a one-AP site:

| Bucket | Setting |
|---|---|
| 5-minute stats | 1 day |
| Hourly stats | 7 days |
| Daily stats | 90 days |

**Then bound the auto-backups** in Settings → System → Backups: set the number to
keep to a finite value (3–7). An unlimited auto-backup count is the most common
real cause of a UniFi install filling its disk — well ahead of the statistics.

Reclaiming space needs one more step: MongoDB does **not** return freed space to
the OS when documents expire. The `compact` button (Settings → Maintenance) is
what shrinks the files, and it only helps *after* retention has actually expired
data — it deletes nothing by itself.

### Expected scale

With one AP and ~16 clients, `stat_5minutes` gets roughly one document per site +
per device + per client each interval — on the order of 5,000 documents/day, a
few MB, and that bucket is capped at 1 day. The `ace_stat` collections
(`stat_5minutes`, `stat_hourly`, `stat_daily`, `stat_monthly`, `stat_archive`,
`stat_life`) should settle in the **hundreds of MB**, dominated by WiredTiger's
own floor rather than by the data. The 20 GB LV is deliberate slack, not a
forecast.

### Alerting

Two node-level alerts cover the card, both in
[`charts/monitoring`](../charts/monitoring/templates/vmrules.yaml) → Telegram:

- **`NodeFilesystemLow`** (pre-existing) — under 15% free for 15m.
- **`NodeFilesystemFillingUp`** (added with this chart) — `predict_linear` over
  6h says the mount runs out inside 7 days, and it is already under 40% free.
  Growth alerts before a threshold breach, which for a steadily-growing database
  is the difference between a warning and an outage.

Node-level rather than PVC-level deliberately: `local-path` enforces nothing and
the PVC's reported capacity is fiction, so the filesystem is the only layer that
knows the truth. With no hard limit in place, this alert is the last line of
defence — the one thing standing between a forgotten retention setting and a full
SD card.

## Adoption

`hostNetwork` means layer-2 auto-adoption should just work — the AP appears under
Devices as "Pending Adoption". If it does not:

```bash
ssh ubnt@192.168.0.163          # the AP runs dropbear; default creds are ubnt/ubnt
set-inform http://192.168.0.100:8080/inform
```

Run `set-inform` **again** after clicking Adopt in the UI — the AP forgets the URL
until provisioning completes. This is also the fallback if the inform port ever
has to change.

## Operations

```bash
kubectl -n unifi get pods
kubectl -n unifi logs deploy/unifi -f
kubectl -n unifi exec -it deploy/unifi-mongodb -- mongosh -u root -p --authenticationDatabase admin

# Collection sizes, largest first
kubectl -n unifi exec -it deploy/unifi-mongodb -- mongosh unifi_stat \
  -u unifi -p --authenticationDatabase unifi_stat --quiet --eval \
  'db.getCollectionNames().map(c => ({c, mb: +(db[c].totalSize()/1048576).toFixed(1)})).sort((a,b)=>b.mb-a.mb)'
```

### Gotchas

- **`MONGO_AUTHSOURCE` must be the controller's own database**, not `admin`. The
  init script creates the user inside `unifi`, so that is where it authenticates.
  Left at the image's `admin` default, the controller reports only a generic
  "database down" and gives no hint that it is an auth failure.
- **The `root-*` credentials are read exactly once.** The official mongo image
  runs `/docker-entrypoint-initdb.d` only when the data directory is empty, so
  rotating them later does nothing unless the volume is wiped. Create the Secret
  before the first sync.
- **MongoDB passwords go into a URI by string concatenation**, so `/`, `+` and `=`
  break the connection unless percent-encoded. The generator in
  [docs/secrets.md](secrets.md) strips them instead.
- **Never scale either Deployment past 1.** Both use `strategy: Recreate`;
  WiredTiger takes an exclusive lock on its data directory and a second pod would
  crash-loop.
