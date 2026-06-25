# Home Assistant

Chart: [`charts/home-assistant`](../charts/home-assistant). Deployed by ArgoCD
from [apps/home-assistant.yaml](../apps/home-assistant.yaml), reachable at
`https://home.agu.com.ar`.

This page covers the non-obvious bits of the chart. For the Google Home
integration see [google-assistant.md](google-assistant.md).

## Config bootstrap (init container)

Home Assistant **owns** `/config/configuration.yaml` — it writes
`default_config:` and friends on first boot and rewrites the file as you change
things in the UI. The chart therefore never replaces that file. Instead, an init
container (`ensure-proxy-config` in
[templates/deployment.yaml](../charts/home-assistant/templates/deployment.yaml))
*idempotently ensures* only the few blocks the deployment needs, using `printf`
so the written YAML is correct regardless of template indentation:

1. Seeds a minimal `default_config:` only if no config file exists yet (so a
   fresh PVC still boots with the default integrations enabled).
2. Appends the `http:` reverse-proxy block (`use_x_forwarded_for` +
   `trusted_proxies`) if not already present.
3. Appends `homeassistant: external_url:` from `.Values.externalUrl`, guarded so
   it never creates a duplicate top-level `homeassistant:` key.
4. Appends the `google_assistant:` block when that integration is enabled.
5. Installs HACS into `/config/custom_components/hacs` when enabled and missing.

Each block is written **once** and skipped if already present. To change a block
after first sync, edit it in `/config/configuration.yaml` (or delete the block
and restart the pod to let the init container regenerate it).

## HACS default bootstrap

HACS is enabled by default (`.Values.hacs.enabled: true`). A dedicated init
container downloads the pinned release zip from
`https://github.com/hacs/integration` and extracts it into
`/config/custom_components/hacs`.

Behavior is idempotent:

- If `/config/custom_components/hacs` already exists, install is skipped.
- If it does not exist, HACS is installed before Home Assistant starts.

To disable this behavior, set:

```yaml
hacs:
   enabled: false
```

To upgrade/downgrade HACS, bump `.Values.hacs.version` to another release tag.

> Why not a ConfigMap? An earlier design copied a whole `configuration.yaml` from
> a ConfigMap on first run. It was effectively dead on any existing install, and
> on a fresh PVC it would have produced a broken HA (no `default_config`, only a
> `10.0.0.0/8` trusted proxy). The init-container approach replaced it.

## `trusted_proxies` and host networking

HA sits behind Traefik, so it must trust the proxy's source IP to honour
`X-Forwarded-For`. Because the pod runs with `hostNetwork: true` (below), the
source IP HA sees for proxied requests is the node/pod IP, so the block trusts
the cluster + LAN ranges:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 10.0.0.0/8
    - 172.16.0.0/12
    - 192.168.0.0/16
```

`externalUrl` (`https://home.agu.com.ar`) is also set so HA knows its canonical
public URL and avoids redirect loops behind the proxy.

## Device discovery — `hostNetwork: true`

Most discovery protocols are link-local multicast/broadcast and **cannot cross
the pod overlay network into the physical LAN**:

- mDNS / Zeroconf — `224.0.0.251:5353`
- SSDP — `239.255.255.250:1900`
- DHCP discovery — broadcast

So the pod runs with `hostNetwork: true`, which puts HA directly on the Pi's LAN
(its pod IP becomes the node IP). `dnsPolicy: ClusterFirstWithHostNet` is set
alongside it so cluster DNS keeps working while sharing the host netns.

Implications:
- HA binds port `8123` directly on the node — nothing else may use it.
- Devices must be on the **same L2 subnet/VLAN** as the Pi. Across VLANs you also
  need an mDNS reflector/repeater on your router.

## Bluetooth

Containerised HA talks to the host's **BlueZ** daemon over D-Bus rather than to
the `hci` adapter directly. Two things make it work:

1. The host D-Bus socket is mounted into the pod (`/run/dbus`, via
   `extraVolumes`/`extraVolumeMounts` in
   [values.yaml](../charts/home-assistant/values.yaml)).
2. The container is granted `NET_ADMIN` and `NET_RAW` capabilities
   (`.Values.securityContext`), which HA's Bluetooth integration needs to manage
   the adapter (active scanning, automatic adapter recovery). Without them the
   logs show *"Missing NET_ADMIN/NET_RAW capabilities for Bluetooth management"*.

Requires `hostNetwork: true` and a working `bluetooth`/`bluez` service on the Pi.

## Probes

A `startupProbe` tolerates HA's slow boot (up to ~150s) while keeping the
liveness/readiness probes lean, so the pod is marked Ready as soon as HA actually
responds — rather than after a fixed long `initialDelaySeconds`.

## Image pinning

`image.tag` is pinned to an explicit version (e.g. `2026.6.4`) and `Chart.yaml`
`appVersion` matches. Avoid floating tags like `stable` — they make ArgoCD report
"Synced" while the running image silently drifts. Bump both deliberately to
upgrade.

## Storage

`/config` is a `ReadWriteOnce` PVC (default 5Gi). The deployment uses the
`Recreate` strategy so a new pod doesn't fight the old one for the volume on a
single-node cluster.
