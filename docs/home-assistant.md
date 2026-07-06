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

## Air conditioners (SmartIR + Broadlink)

The two split ACs (living room + bedroom) are IR-controlled via **Broadlink RM4
mini** blasters and the **[SmartIR](https://github.com/smartHomeHub/SmartIR)**
custom component (installed through HACS). This is **not** managed by the chart —
it lives entirely in the on-PVC `/config`, so treat this section as the recovery
runbook if the PVC is ever lost.

**What lives where:**

- **Broadlink devices** — added via the HA UI (Settings → Devices → Broadlink).
  They register as `remote.*` entities:
  - `remote.control_living` — living-room blaster (`192.168.0.186`)
  - `remote.control_dormitorio` — bedroom blaster (`192.168.0.101`)
  - Learned commands (if any) persist in `/config/.storage/broadlink_remote_<mac>_codes`.
- **SmartIR** — `/config/custom_components/smartir` (via HACS). Device-code JSONs
  are cached under `codes/climate/` and auto-downloaded from the SmartIR repo on
  first use.
- **`climate:` blocks** — added **by hand** to `/config/configuration.yaml` (the
  init container never touches them). Current config:

  ```yaml
  climate:
    - platform: smartir
      name: "Aire Living"
      unique_id: aire_living
      device_code: 1382              # Midea MSY-12HRDN1 (BGH Silent Air)
      controller_data: remote.control_living
      temperature_sensor: sensor.atc_29a8_temperatura
      humidity_sensor: sensor.atc_29a8_humedad
    - platform: smartir
      name: "Aire Dormitorio"
      unique_id: aire_dormitorio
      device_code: 5140              # Mitsubishi Electric MSC-A12WV
      controller_data: remote.control_dormitorio
      temperature_sensor: sensor.dormitorio_atc_b6d2_temperatura
      humidity_sensor: sensor.dormitorio_atc_b6d2_humedad
  ```

  The `sensor.*_temperatura`/`_humedad` entities are the per-room ATC BLE
  thermometers (Xiaomi/ATC), which SmartIR shows on the thermostat card as the
  real ambient reading (the IR AC reports nothing back).

**Finding the right `device_code`.** Neither AC matched its labelled brand:

- **Bedroom** — branded *Philco*, but the Philco code (`3000`) never worked; it's
  a **rebranded Mitsubishi Electric**. `5140` (MSC-A12WV) is the winner. It was
  found as the Mitsubishi sibling of `1126`, which powered the unit on/off but had
  the wrong temperature table.
- **Living room** — a *BGH Silent Air*, which is **OEM Midea** (the SmartIR Midea
  RG-series codes are BGH's remotes). `1382` (MSY-12HRDN1) works with full modes.

When the labelled brand fails, don't guess by brand — compare the **IR waveform**
of candidate codes against a code that already partially works. Two codes are the
same protocol/OEM when their Broadlink packets share the same **leader timing**
and **frame length** (pulse count); the matching sibling with a fuller/correct
command table is the one to keep (e.g. `1382` was picked over the bare `1381`
because both share an identical on/off waveform but `1382` adds `dry`/`heat_cool`/
`fan_only` + auto fan). A helper that decodes the Broadlink base64 and ranks codes
by waveform similarity lived in the scratchpad during that work; the gist is:
same leader + same pulse count ⇒ try it.

**No swing on Midea codes.** None of SmartIR's Broadlink Midea codes encode a
`swingModes` table, so the living-room AC has no swing control in HA regardless of
`device_code`. If swing is ever needed, the only path is learning that one IR
command off the physical remote (`remote.learn_command`) and wiring it separately.

**Gotcha — `fan_mode`/`swing_mode` restore-state `KeyError`.** SmartIR restores
the entity's last `fan_mode`/`swing_mode` on boot and immediately looks them up
in `commands[mode][fan][swing][temp]`. If you **change `device_code`** to one
whose code JSON names those levels differently (e.g. Philco `Auto`/`Stop` vs
Mitsubishi `auto`/`auto`), the restored value isn't a key → `KeyError` → the
command is never built and **nothing is sent to the Broadlink** (the blaster LED
doesn't even blink). Two fixes:

- **Easiest:** give the entity a **new `unique_id`** (and name). A fresh entity
  has no restored state and boots with the new code's valid defaults. Both ACs
  were renamed this way when their code changed (`aire_dormitorio` replaced
  `aire_acondicionado_dormitorio`; `aire_living` replaced `aire_acondicionado_salon`).
- **Alternative:** clear the entity from `/config/.storage/core.restore_state`
  **with HA stopped** — a graceful shutdown rewrites that file from memory, so
  editing it while HA runs (or a rolling restart) just gets clobbered. Note
  ArgoCD `selfHeal` reverts a manual `kubectl scale --replicas=0`, so this path
  is fiddly; prefer the new-`unique_id` approach.

> Because none of this is in git, a fresh `/config` PVC loses it. Re-adding the
> `climate:` blocks above + re-pairing the Broadlinks in the UI restores it;
> SmartIR re-downloads the code JSONs automatically.

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
