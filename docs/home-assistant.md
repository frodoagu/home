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

## LG webOS TVs — Wake on LAN turn-on

Two LG webOS TVs are added via the `webostv` integration (`media_player.sala_de_estar`,
`media_player.dormitorio`). The integration controls a TV that's already on and can
turn it **off**, but **turning it on is not built in** — this HA version's `webostv`
exposes a *turn-on trigger* (`webostv.turn_on`) and leaves the actual wake to you.
So `media_player.turn_on` only works once you wire an automation that sends a
**Wake-on-LAN** magic packet. Until such an automation exists the media_player
doesn't even advertise the `TURN_ON` feature.

Two pieces make it work (both hand-added to `/config`, like the ACs):

1. **`wake_on_lan:`** in `configuration.yaml` — registers the
   `wake_on_lan.send_magic_packet` service.
2. **Two automations** in `automations.yaml`, one per TV, triggered by
   `webostv.turn_on` and calling `send_magic_packet` with the TV's MAC:

   ```yaml
   - id: tv_sala_wake_on_lan
     alias: TV Sala - Wake on LAN
     trigger:
       - platform: webostv.turn_on
         entity_id: media_player.sala_de_estar
     action:
       - action: wake_on_lan.send_magic_packet
         data:
           mac: "4c:ba:d7:11:bb:12"
     mode: single
   # ...and tv_dormitorio_wake_on_lan → media_player.dormitorio, mac 44:cb:8b:e4:44:c8
   ```

**On the TV itself (mandatory):** LG TVs kill the NIC on power-off unless network
standby is enabled, so no magic packet can reach them. Enable *General → Devices
→ "Mobile TV On" / "Turn on via Wi-Fi" + "Turn on via Ethernet"* (and Quick Start+).
Wired Ethernet is far more reliable for WoL than Wi-Fi.

**Static IPs (Pi-hole DHCP).** WoL targets the MAC so it survives IP changes, but
the `webostv` connection addresses the TV by **IP** — and a DHCP renewal had already
moved the bedroom TV off its configured `.10`. Both TVs are now pinned in
[`charts/pihole` `dhcp.reservations`](../charts/pihole/values.yaml) so their IPs
(and the `webostv` config-entry host) stay put:

| TV | IP | MAC |
|---|---|---|
| Sala de estar | `192.168.0.221` | `4c:ba:d7:11:bb:12` |
| Dormitorio | `192.168.0.155` | `44:cb:8b:e4:44:c8` |

> The `webostv` config entries, the `wake_on_lan:` line and the automations all
> live on the `/config` PVC (not git); only the DHCP reservations are in the repo.
> On a fresh PVC, re-pair the TVs and re-add the two automations above.

## LG webOS TVs — unified webOS + IR entity

On top of the `webostv` (IP) integration, each TV also has an **IR** path through
the room's **Broadlink RM4 mini** (the same blasters the ACs use), and the two are
merged into **one** `media_player` per room. Google Home / the dashboard see only
that single unified entity. Like the ACs and the WoL bits, all of this lives on the
`/config` PVC (not git) — treat this as the recovery runbook.

**Why IR at all.** `webostv` needs the TV reachable by IP; when a TV is off (LG
kills the NIC unless network standby holds) or the network is down, IP control and
even WoL can fail. The IR blaster is a hardware fallback that always reaches the TV,
and gives full manual control (volume, sources, nav, apps) when IP is unavailable.

**The three layers per TV** (all in `/config/configuration.yaml` + `scripts.yaml`):

1. **IR entity — SmartIR `media_player`, LG `device_code: 1042`.** Same pattern as
   the ACs (SmartIR + Broadlink), just the `media_player` platform. `1042` is the LG
   webOS profile (43UM7510 / OLED B8/B9) and — key for reliability — it has
   **discrete `on` and `off`** codes (not a power toggle), plus volume/mute/channels
   and a full `sources` map (Input, Home, Back, Netflix, Prime, Settings, OK, arrows,
   Play/Pause, Info, digits). `controller_data` is the room's Broadlink:

   ```yaml
   media_player:
     - platform: smartir
       name: "TV Sala IR"
       unique_id: tv_sala_ir
       device_code: 1042
       controller_data: remote.control_living
     - platform: smartir
       name: "TV Dormitorio IR"
       unique_id: tv_dormitorio_ir
       device_code: 1042
       controller_data: remote.control_dormitorio
   ```

   SmartIR auto-downloads `codes/media_player/1042.json` on first use (needs egress).
   If `1042` ever mismatches a set, the other LG codes are `1040/1041/1043` — compare
   IR waveforms like the ACs (see the AC section).

2. **Unified entity — `universal` `media_player`** (`media_player.tv_sala`,
   `media_player.tv_dormitorio`). State and rich control (apps, sources, real volume
   level) come from the **webOS child**; `turn_on`/`turn_off` are overridden to
   scripts that do WoL/webOS **first** and fall back to IR:

   ```yaml
     - platform: universal
       name: "TV Sala"
       unique_id: tv_sala
       device_class: tv
       children:
         - media_player.sala_de_estar
       commands:
         turn_on: { action: script.tv_sala_turn_on }
         turn_off: { action: script.tv_sala_turn_off }
       attributes:
         state: media_player.sala_de_estar
     # ...tv_dormitorio -> media_player.dormitorio, script.tv_dormitorio_turn_*
   ```

3. **Fallback scripts** (`scripts.yaml`). `turn_on` calls `media_player.turn_on` on
   the webOS entity (which fires the existing `webostv.turn_on` → WoL automation),
   waits ~4s, and **only if the TV is still off/unavailable** sends the IR `on`.
   Because IR `on`/`off` are discrete, the guard makes the fallback safe — no toggle
   can flip an already-on TV. `turn_off` mirrors it (webOS off → if still on, IR off):

   ```yaml
   tv_sala_turn_on:
     sequence:
       - action: media_player.turn_on
         target: { entity_id: media_player.sala_de_estar }
       - delay: "00:00:04"
       - if:
           - condition: state
             entity_id: media_player.sala_de_estar
             state: ["off", "unavailable", "standby"]
         then:
           - action: media_player.turn_on
             target: { entity_id: media_player.tv_sala_ir }
     mode: single
   # ...tv_sala_turn_off, tv_dormitorio_turn_on/off analogous
   ```

**One entity to Google.** `expose_by_default: true` would surface all three
media_players per room, so the `webostv` children and the `*_ir` entities are hidden
via `google_assistant.entity_config`, leaving only the unified `tv_sala`/`tv_dormitorio`:

```yaml
google_assistant:
  entity_config:
    media_player.sala_de_estar: { expose: false }
    media_player.tv_sala_ir: { expose: false }
    media_player.dormitorio: { expose: false }
    media_player.tv_dormitorio_ir: { expose: false }
```

**One entity in the HA UI too.** `entity_config` only affects Google — the HA
auto-dashboards and entity pickers still list all six media_players. To leave a single
tile per TV, the four auxiliaries are marked **hidden** in the entity registry
(`hidden_by: user` on `sala_de_estar`, `dormitorio`, `tv_sala_ir`, `tv_dormitorio_ir`),
leaving only `tv_sala`/`tv_dormitorio` visible. Hidden entities still function fully —
the universal player reads its (hidden) webOS child and the remote pad drives the
(hidden) IR entity; they just drop out of listings. Normally you'd toggle this in the
UI (entity → settings → *Hidden*); off-PVC it's a `hidden_by` field in
`.storage/core.entity_registry`. **Editing that file directly requires HA to not
rewrite it on graceful shutdown** — either edit via the UI, or edit the file and
`kubectl delete pod --grace-period=0 --force` (a graceful stop flushes the in-memory
registry over your edit).

**Gotcha — `webostv` stalls HA when a TV is unreachable.** If an LG TV is off/off-net,
this HA/`aiowebostv` version blocks the event loop in `is_connected()` on update,
which shows up as `TimeoutError` spam and **failing liveness/readiness probes** (the
pod stays Running, doesn't crash-loop). It clears once the TV is reachable again. It's
independent of the IR/unified config above; the unified `turn_on` (WoL + IR fallback)
is precisely what recovers an off/off-net TV.

> Fresh-PVC recovery: re-add the `media_player:` block (SmartIR IR + universal) and the
> four `tv_*_turn_on/off` scripts, plus the `google_assistant.entity_config` hides, and
> re-hide the four auxiliary entities (UI → entity → *Hidden*). The WoL automations and
> `wake_on_lan:` from the section above are prerequisites; the `1042.json` re-downloads
> itself.

### IR remote dashboard (universal-remote-card)

A dedicated **storage-mode dashboard** "TVs" (`url_path: tv-remotes`, in the sidebar)
renders a physical-remote-style pad per TV using the
[`universal-remote-card`](https://github.com/Nerwyn/android-tv-card) custom card.
Every button is a `custom_actions` entry calling the IR `media_player` (SmartIR) —
power via `turn_on`/`turn_off`, volume via `volume_up`/`down`/`volume_mute`, channels
via `media_next/previous_track`, and all nav/apps (Home, Back, OK, arrows, Netflix,
Prime, Settings, Input, Play/Pause) via `media_player.select_source` with the source
names from the `1042` code. So the pad drives the TV over **IR**, independent of the
network.

The card is **not installed through HACS** — it was added manually (equivalent effect,
but HACS won't track it for updates):

- JS lives at `/config/www/universal-remote-card.min.js` (v4.11.3), served at
  `/local/universal-remote-card.min.js` and registered as a `module` resource in
  `.storage/lovelace_resources`.
- The dashboard config is `.storage/lovelace.tv-remotes` (+ its registry entry in
  `.storage/lovelace_dashboards`).

Gotchas:
- After (re)registering the resource, **hard-refresh the browser** (Ctrl-Shift-R) or
  the card shows "Configuration error" / "Custom element doesn't exist" against the
  stale cached JS — it's not actually a config problem.
- Lovelace resources are read at startup in storage mode, so a new resource needs an
  HA restart to load.

> Fresh-PVC recovery: re-download the JS into `/config/www/`, re-add the resource +
> dashboard registry + `lovelace.tv-remotes` config, restart, hard-refresh. Or just
> install "Universal Remote Card" from HACS and rebuild the two cards.

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
