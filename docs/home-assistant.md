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
container (`ensure-config` in
[templates/deployment.yaml](../charts/home-assistant/templates/deployment.yaml))
*idempotently ensures* only the few blocks the deployment needs, using `printf`
so the written YAML is correct regardless of template indentation:

1. Seeds a minimal `default_config:` only if no config file exists yet (so a
   fresh PVC still boots with the default integrations enabled).
2. Appends `homeassistant: external_url:` from `.Values.externalUrl`, guarded so
   it never creates a duplicate top-level `homeassistant:` key.
3. Ensures `homeassistant: packages: !include_dir_named packages` (inserted under
   the existing `homeassistant:` block via `awk`, or appended fresh) so HA merges
   the versioned `/config/packages` ConfigMap — see [Versioned config](#versioned-config-ha-packages).
4. Appends the `google_assistant:` block when that integration is enabled
   (including the `entity_config` exposure hides from `.Values.googleAssistant.entityConfig`).
5. Installs HACS into `/config/custom_components/hacs` when enabled and missing.

It does **not** write an `http:` block anymore — see
[`trusted_proxies`](#trusted_proxies-and-host-networking) below.

Each block is written **once** and skipped if already present. To change a block
after first sync, edit it in `/config/configuration.yaml` (or delete the block
and restart the pod to let the init container regenerate it).

## Versioned config (HA packages)

The hand-authored declarative config — the **AC `climate:` entities, the TV
`media_player:` (IR + unified), the TV `script:`s, the WoL `automation:`s, and the
`smartir:`/`wake_on_lan:` activations** — lives in git as **[Home Assistant
packages](https://www.home-assistant.io/docs/configuration/packages/)**, not by
hand on the PVC. HA still **owns** `configuration.yaml`; packages are the supported
way to add config-as-code alongside it (a previous attempt to own the whole
`configuration.yaml` from a ConfigMap broke — see *"Why not a ConfigMap?"* below).

How it works:

- YAML files under [`charts/home-assistant/packages/`](../charts/home-assistant/packages/)
  (`climate.yaml`, `gas.yaml`, `luces_afuera.yaml`, `salud.yaml`, `tv.yaml`,
  `weather.yaml`) are globbed into a ConfigMap
  (`templates/configmap-packages.yaml`, same pattern as the monitoring dashboards)
  and mounted **read-only** at `/config/packages/`.
- The init container ensures `homeassistant: packages: !include_dir_named packages`
  in `configuration.yaml`, so HA loads every file in that dir as a package and
  **merges** it into the main config. Toggle with `.Values.packages.enabled`.
- **The filename is the package name, and it must be a valid slug** — letters,
  digits and `_` only. `!include_dir_named` names each package after its file, so
  `luces-afuera.yaml` is rejected whole with *"invalid slug luces-afuera (try
  luces_afuera)"* and **the package silently doesn't load**: HA starts fine,
  everything else works, that one file's entities just never appear. Use `_`, not
  `-`. Nothing catches this before deploy — schema validation passes because the
  file's *contents* are valid; only HA's own package loader looks at the name.
  (Note this is the opposite of the repo's file-naming habit elsewhere —
  `luces-afuera.js` on the Shelly devices keeps its hyphen.)
- Because they're merged (not owned), package config **coexists** with HA's own
  files: `script:`/`automation:` from the packages load *alongside* anything you
  create in the UI (which still writes to the PVC's `scripts.yaml`/`automations.yaml`).
  The package entries are **read-only in the UI** (they're not in those files).

**Consequence for a fresh `/config` PVC:** climate/media_player/scripts/automations
now come back **automatically** from git — no re-adding by hand. What still lives
only in `.storage` (and must be recreated) is the *stateful* stuff the UI owns:
the webOS/Broadlink **config entries** (re-pair the devices), the **network
settings** (`use_x_forwarded_for`/`trusted_proxies` — see
[`trusted_proxies`](#trusted_proxies-and-host-networking)), entity **hides**
(`hidden_by`) and any **disables**, and the Lovelace dashboards. SmartIR re-downloads
its code JSONs on first use as before.

**Editing the versioned config:** change the file under `charts/home-assistant/packages/`
and let ArgoCD sync (the ConfigMap update propagates to the mount; HA picks it up on
its next restart). Do **not** hand-edit these blocks in `/config/configuration.yaml`
anymore — they're no longer there.

> **Migration gotcha (one-time).** When these blocks moved out of
> `configuration.yaml` into packages, the live PVC copy had to be stripped of the
> now-duplicated `climate:`/`media_player:`/`smartir:`/`wake_on_lan:` keys and the
> `scripts.yaml`/`automations.yaml` entries **before** the pod rolled with the
> packages mounted — otherwise HA sees the same entities twice (duplicate
> `unique_id`s, and a fatal duplicate `script` key). Order: strip the PVC first
> (the running pod keeps its in-memory config), then deploy.

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
`X-Forwarded-For` — without it every request looks like it came from the node
and the login IP-ban / rate-limit buckets are meaningless. Because the pod runs
with `hostNetwork: true` (below), the source IP HA sees for proxied requests is
the node/pod IP, so it trusts the cluster + LAN ranges:

```text
use_x_forwarded_for: true
trusted_proxies: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
```

**This is UI state, not YAML.** Since **2026.8** the `http` integration is a
config flow: HA imported the old `http:` block into a config entry
(`/config/.storage/http`, `yaml_migration_done: true`) and now raises a
deprecation repair for any `http:` block left in `configuration.yaml`
(*"stops working in 2027.2.0"*). The settings live in **Settings > System >
Network**, and nothing in git can set them — a config entry only exists in
`.storage`. So the init container no longer writes the block, and:

- **On a fresh `/config` PVC** (or a restore from before the migration) this is a
  manual post-onboarding step: set the two fields in the UI, like the
  webOS/Broadlink re-pairing above.
- **Removing the block is a one-time PVC edit** — the import already happened, so
  deleting it changes no behaviour:

  ```bash
  kubectl -n home-assistant exec deploy/home-assistant -c home-assistant -- python -c "
  import re, shutil
  p = '/config/configuration.yaml'
  shutil.copy(p, p + '.bak-http')
  s = open(p).read()
  out = re.sub(r'\n\nhttp:\n(?:[ \t].*\n)*', '\n', s)
  assert out != s and '\nhttp:' not in out
  open(p, 'w').write(out)"
  ```

  **Order matters**: strip the PVC *without* restarting (the running pod keeps
  its in-memory config), and only let the pod roll once the init-container change
  above is on `main` and synced. Restart against the old init container and it
  re-appends the block, because its guard is `grep -q "trusted_proxies:"`.

`externalUrl` (`https://home.agu.com.ar`) is still set from git so HA knows its
canonical public URL and avoids redirect loops behind the proxy.

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

### BLE proxies

The Pi's own adapter does not reach the whole house, so two ESP32s relay
advertisements over WiFi. They only **forward** packets — every device is still
decoded by its own HA integration, so adding a proxy never needs a code change
on the ESP32 side.

| Proxy | Firmware | Where it lives |
|---|---|---|
| `BLE Proxy` (`30:76:F5:E6:AB:38`) | ours — [`esphome/ble-proxy.yaml`](../esphome/ble-proxy.yaml) | kitchen, in range of the gas tank |
| `Bluetooth Proxy 4a0670` (`D4:D4:DA:4A:06:70`) | the prebuilt one from esphome.io's web installer — no YAML in this repo, it is not ours to build | bedroom |

What currently arrives through them: the **Mopeka** gas sensor (integration
`mopeka`, see [gas-mopeka.md](gas-mopeka.md)) and the two **BTHome/ATC**
thermometers (living room + bedroom). Passive scanning is enough for all three —
they broadcast, nothing connects to them, which is why `ble-proxy.yaml` runs
`active: false` on both the tracker and the proxy.

Our proxy's config was reconstructed from the validated copy ESPHome leaves in
the (gitignored) `esphome/.esphome/` after a build — the original never made it
into git. It is byte-for-byte equivalent to what is flashed, so re-flashing it
changes nothing:

```bash
esphome config esphome/ble-proxy.yaml   # validar
esphome run esphome/ble-proxy.yaml      # flashear / OTA
```

One leftover: the WiFi-signal sensor kept an old entity_id
(`sensor.gas_tubo_wifi`) from a previous name of the device.

## Air conditioners (SmartIR + Broadlink)

Three of the four split ACs (living room + bedroom + kids' room) are IR-controlled via **Broadlink RM4
mini** blasters and the **[SmartIR](https://github.com/smartHomeHub/SmartIR)**
custom component (installed through HACS). The `climate:` entities are **versioned in
git** as an HA package ([`packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml),
see [Versioned config](#versioned-config-ha-packages)); the Broadlink pairing and
SmartIR code cache still live on the PVC. Treat this section as the recovery runbook.

**What lives where:**

- **Broadlink devices** — added via the HA UI (Settings → Devices → Broadlink).
  They register as `remote.*` entities:
  - `remote.control_living` — living-room blaster (`192.168.0.31`)
  - `remote.control_dormitorio` — bedroom blaster (`192.168.0.30`)
  - `remote.broadlink_cocina` — kids'-room blaster (`192.168.0.32`). The id still
    says *cocina* because it used to hang there; it moved when the kitchen went
    over to ESPHome, and Broadlink is a config-flow integration whose entity id
    git cannot rename.
  - Learned commands (if any) persist in `/config/.storage/broadlink_remote_<mac>_codes`.
- **SmartIR** — `/config/custom_components/smartir` (via HACS). Device-code JSONs
  are cached under `codes/climate/` and auto-downloaded from the SmartIR repo on
  first use.
- **`climate:` blocks** — versioned in
  [`packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml)
  (merged via HA packages; no longer hand-edited in `configuration.yaml`):

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
    - platform: smartir
      name: "Aire Chicos"
      unique_id: aire_chicos
      device_code: 5140              # hypothesis: what the other Philco in the house needed
      controller_data: remote.broadlink_cocina
      # No ATC BLE thermometer in this room, so no temperature/humidity sensor.
  ```

  The `sensor.*_temperatura`/`_humedad` entities are the per-room ATC BLE
  thermometers (Xiaomi/ATC), which SmartIR shows on the thermostat card as the
  real ambient reading (the IR AC reports nothing back). The kids' room has no ATC
  thermometer, so `Aire Chicos` runs without one (its card shows no ambient
  reading until a sensor is added).

  `Aire Chicos` is a **Philco iView 3800 W** and its `device_code` is **not
  verified**: `5140` is seeded as the first candidate because it is what the other
  Philco in this house turned out to need. Confirm it against the physical remote
  and swap it using the waveform method below if the tables don't line up.

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

> On a fresh `/config` PVC the `climate:` blocks come back **from git** (the
> [`packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml) package).
> You only re-pair the Broadlinks in the UI (so the `remote.*` entities exist);
> SmartIR re-downloads the code JSONs automatically.

**Quick-access scenes.** The same package ships several `script:`s for one-tap
presets — they show up as `script.*` entities (buttons on the HA app / dashboard
cards) and, because `script` is in `googleAssistant.exposedDomains`, as scenes in
Google Home:

- `aires_todos_encender` — living + kitchen to **heat 21 °C**, bedroom to
  **heat 20 °C** (it's a degree cooler for sleeping).
- `aires_todos_frio` — all three ACs to **cool 24 °C**.
- `aires_solo_pieza` — bedroom to **heat 20 °C**, living + kitchen **off**.
- `aires_todos_apagar` — all three **off**.
- `aires_toggle_calor` — one-button toggle. Only turns **off** when **all
  three** ACs are on; in any other state (mixed, or all off) it turns all on to
  heat (21 °C, bedroom 20 °C). So a mixed state is first driven to "all on" and
  only the next tap turns everything off. Ideal for a single Android
  home-screen widget / iOS Shortcut.
- `aires_toggle_frio` — same one-button toggle, but the "on" side sets **cool
  24 °C** (summer preset).
- `aires_cocina_living_toggle_calor` / `aires_cocina_living_toggle_frio` — the
  same toggle scoped to the **living area only** (kitchen + living, no bedroom):
  off only when **both** are on, otherwise both to heat 21 °C / cool 24 °C.

Turn-on presets fix mode+temperature in a single `climate.set_temperature` call
(passing `hvac_mode`): IR sends the whole state frame each time, so one blast
lands the unit in the target state — re-blasting a unit that's already on
re-asserts mode+temperature instead of toggling it, which is why the "on" side
targets every AC in the group rather than only the ones HA believes are off.

To add a button to the phone, drop an `entities`/`button` card pointing at the
`script.*` entity, or add it to the Google Home app once linked. For a
home-screen **widget**: on Android the HA companion app ships an *Entity/Script*
widget — add it, pick the `script.*` entity, and one tap runs it; on iOS use
Shortcuts (*Home Assistant → Run Script*) and add the shortcut to the home
screen or Lock Screen.

### Automatic schedule (migrated from Google Home)

The same package ships three `automation:`s, migrated 1:1 from the Google Home
app (same times, thresholds and guards — see
[google-home/README.md](../google-home/README.md)):

- `aires_calor_manana` — kitchen + living to **heat 21 °C** at 08:00 on
  weekdays / 09:00 on weekends, if someone's home and the living room is ≤ 17 °C.
- `aires_apagar_templado` — all three **off** once it hits 19 °C outside, but
  only while the living AC is in `heat`. Checking the mode instead of a date
  range is what keeps it from firing in summer.
- `aires_frio_dia_caluroso` — all three to **cool 24 °C** when it's over 30 °C
  outside and over 24 °C in the living room, if someone's home.

Notes that matter when editing them:

- **Presence** is `zone.home > 0` (a zone's state is the number of people in it),
  which is Google's `home.state.HomePresence: HOME`. Both `person`s have a
  `device_tracker` from the mobile app.
- **The living-room temperature is `sensor.atc_29a8_temperatura`**, the BTHome
  thermometer (renamed "Living" in the registry) — not the AC entity. Google's
  `Living - Salón` device is that thermometer.
- **No `homeassistant.start` catch-up**, unlike
  [`luces_afuera.yaml`](../charts/home-assistant/packages/luces_afuera.yaml).
  Deliberate: losing one AC cycle to a restart beats having a deploy start the
  units by itself.
- **IR is one-way**, so `aires_apagar_templado`'s condition on
  `climate.aire_living` reads the state HA *assumes*, not the unit's. Someone
  using the physical remote desyncs it — same caveat as the toggle scripts.
- Google's ≥/> comparisons don't all map onto `numeric_state`, whose `above`/
  `below` are strict. Where the boundary matters (`≥ 19 °C` outside, `≤ 17 °C`
  inside) the check is a template instead — the reasons are in the comments.

## Air conditioner over Wi-Fi (ESPHome + Midea) — the kitchen

The kitchen split is **not** IR. It carries a **SMLIGHT SLWF-01pro** module plugged
into the indoor unit's 4-pin port, running
[`esphome/aire-cocina.yaml`](../esphome/aire-cocina.yaml) and speaking Midea's UART
protocol, so `climate.aire_cocina` comes from the **ESPHome integration** — there
is no `climate:` block for it in `climate.yaml`.

It kept its entity id through the move off SmartIR, so every scene and automation
that names it is unchanged. What changed is what's behind the id:

- **The link is two-way.** The entity reports what the unit is actually doing,
  including changes made with the physical remote, and the ambient temperature
  comes from the AC itself — the kitchen never had an ATC thermometer, so this is
  the first real reading its card has shown.
- **Its state is worth trusting in a condition**, unlike the three IR units. The
  group toggles now mix one real state with two assumed ones.
- **It depends on Wi-Fi.** The entity goes `unavailable` when the module drops,
  where an IR blast would still work.

The module went to the kitchen because that unit is known to be Midea inside (it
ran on SmartIR's `1382`, the *BGH Silent Air* Midea rebadge), and the blaster it
replaced moved to the kids' room to drive the Philco there.

**The one-time trap:** the SmartIR entity keeps owning `climate.aire_cocina` in the
entity registry after its YAML block is gone, so onboarding the ESPHome device
before deleting that orphan lands it on `climate.aire_cocina_2` and every reference
in `climate.yaml` silently points at a dead entity. Order and recovery, plus the
install, flashing, DHCP reservation and fallback:
[docs/aire-cocina-slwf01pro.md](aire-cocina-slwf01pro.md).

## Sensor health alerts (`salud.yaml`)

[`packages/salud.yaml`](../charts/home-assistant/packages/salud.yaml) is
notification-only — it drives no device. It exists because the AC and gas
automations trigger on **battery-powered BLE sensors reached through the ESPHome
Bluetooth proxy**, and when one of those dies the automation reading it doesn't
error: it just stops firing. Without an alert, "the ACs stopped turning on in the
morning" surfaces weeks later and looks like a broken automation.

| Automation | Fires when |
| --- | --- |
| `salud_termometro_living_sin_datos` | living thermometer unavailable 2 h (kills both AC automations) |
| `salud_termometro_dormitorio_sin_datos` | bedroom thermometer unavailable 2 h |
| `salud_termometros_pila_baja` | either CR2032 under 2.5 V for 2 h (healthy is ~2.95 V) |
| `salud_proxy_bluetooth_caido` | BLE proxy unavailable 1 h — takes out both thermometers **and** the gas sensor at once |
| `salud_backup_atrasado` | checked daily at 10:00; last successful HA backup older than 48 h |

All of them notify through the same Telegram entity as `gas.yaml`, with the same
caveat: the `entity_id` is assembled by Telegram (bot name + chat name) and can't
be pinned from git.

The BLE-proxy alert triggers on the device's `update.*` firmware entity because
that's the only thing it exposes in HA — ESPHome marks *all* of a device's
entities `unavailable` when the connection drops, so it works as a liveness
signal. If the proxy ever exposes a real sensor, prefer it.

## LG webOS TVs — Wake on LAN turn-on

Two LG webOS TVs are added via the `webostv` integration (`media_player.sala_de_estar`,
`media_player.dormitorio`). The integration controls a TV that's already on and can
turn it **off**, but **turning it on is not built in** — this HA version's `webostv`
exposes a *turn-on trigger* (`webostv.turn_on`) and leaves the actual wake to you.
So `media_player.turn_on` only works once you wire an automation that sends a
**Wake-on-LAN** magic packet. Until such an automation exists the media_player
doesn't even advertise the `TURN_ON` feature.

Two pieces make it work (both versioned in git in
[`packages/tv.yaml`](../charts/home-assistant/packages/tv.yaml), see
[Versioned config](#versioned-config-ha-packages)):

1. **`wake_on_lan:`** — registers the `wake_on_lan.send_magic_packet` service.
2. **Two automations**, one per TV, triggered by `webostv.turn_on` and calling
   `send_magic_packet` with the TV's MAC:

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
| Sala de estar | `192.168.0.50` | `4c:ba:d7:11:bb:12` |
| Dormitorio | `192.168.0.51` | `44:cb:8b:e4:44:c8` |

> The `wake_on_lan:` activation and the two WoL automations are **versioned in git**
> ([`packages/tv.yaml`](../charts/home-assistant/packages/tv.yaml), see
> [Versioned config](#versioned-config-ha-packages)) — a fresh PVC restores them
> automatically. Only the `webostv` **config entries** stay on the PVC (re-pair the
> TVs on a fresh PVC); the DHCP reservations are in `charts/pihole`.

## LG webOS TVs — unified webOS + IR entity

On top of the `webostv` (IP) integration, each TV also has an **IR** path through
the room's **Broadlink RM4 mini** (the same blasters the ACs use), and the two are
merged into **one** `media_player` per room. Google Home / the dashboard see only
that single unified entity. The `media_player:` (IR + universal) and the fallback
`script:`s are **versioned in git** ([`packages/tv.yaml`](../charts/home-assistant/packages/tv.yaml),
see [Versioned config](#versioned-config-ha-packages)); the `webostv` config entries
and the entity **hides** stay on the PVC. Treat this as the recovery runbook.

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

3. **Fallback scripts** (`packages/tv.yaml`, under `script:`). `turn_on` calls
   `media_player.turn_on` on the webOS entity (which fires the existing
   `webostv.turn_on` → WoL automation), waits ~4s, and **only if the TV is still
   off/unavailable** sends the IR `on`.
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
via `google_assistant.entity_config`, leaving only the unified `tv_sala`/`tv_dormitorio`.
This is now driven from **`.Values.googleAssistant.entityConfig`** (rendered into the
generated `google_assistant:` block by the init container), so it's in git:

```yaml
# values.yaml
googleAssistant:
  entityConfig:
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

> Fresh-PVC recovery: the `media_player:` block (SmartIR IR + universal), the four
> `tv_*_turn_on/off` scripts, the WoL automations and `wake_on_lan:` all come back
> **from git** ([`packages/tv.yaml`](../charts/home-assistant/packages/tv.yaml)), and
> the `entity_config` hides from `values.yaml`. What you still redo by hand: re-pair
> the TVs (webOS config entries) and **re-hide** the four auxiliary entities
> (UI → entity → *Hidden*). The `1042.json` re-downloads itself.

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

## Outdoor lights (Shelly) — see [docs/shelly.md](shelly.md)

The two outdoor lights (`switch.afuera_interruptor_puerta_principal` /
`…_escalera`) are Shelly 1 Mini Gen4 relays. Home Assistant sees them as two
ordinary, independent switches and drives them that way — but **either wall
switch drives both lights**, and that logic runs **on the devices**, not here.

Do **not** add an HA automation on their inputs
(`binary_sensor.…_entrada_0`): the device script already acts on that event, and
two controllers on the same input fight each other. That exact mistake produced a
long, intermittent debugging session — the full story, and the rest of the Shelly
setup, is in [docs/shelly.md](shelly.md).

### Dusk/dawn schedule

[`packages/luces_afuera.yaml`](../charts/home-assistant/packages/luces_afuera.yaml)
turns both on 15 min before sunset and off at sunrise. This used to be a **Google
Home automation** (Google's cloud, nothing in git — see
[google-home/README.md](../google-home/README.md)); if that one is still in the
app, delete it, otherwise two schedulers drive the same relays.

It does not violate the one-controller rule above: that rule is about reacting to
`input:0`, and these automations only call `switch.turn_on`/`turn_off` on the
relays — the same thing an operator does from the app, which raises no input
event. They target the two real entity ids, not the `switch.luz_escalera_espejo`
dashboard mirror (that helper lives in `.storage`, outside git).

Both automations also trigger on `homeassistant.start`. A sun trigger fires once
and is not replayed, so an HA restart across the sunset moment (an OOMKill, a
deploy, a Pi reboot) silently loses that day's switch — the restart trigger
re-evaluates and corrects it. The conditions bound the catch-up so it never
overrides a deliberate manual change: the on-side only applies between sunset and
local midnight, the off-side only during the day.

> **The two catch-up windows must not overlap.** Both automations trigger on
> `homeassistant.start`, so any instant where both conditions hold is an instant
> where starting HA runs *both* — one turning the lights on, the other off, with
> the winner decided by a race. The first version had exactly that: the on-side
> opened 15 min before sunset while the off-side's plain `before: sunset` stayed
> open until sunset, leaving a **15-minute overlap** — and, worse, it sat right on
> dusk, the window the catch-up exists to cover. The fix is `before_offset:
> "-00:15:00"` on the off-side, so its window closes where the on-side's opens.
>
> That means the **15-minute offset appears in three places** — the on-side's sun
> trigger `offset`, the on-side condition's `after_offset`, and the off-side
> condition's `before_offset`. Change one, change all three. (A single-microsecond
> overlap remains at the exact boundary instant; reaching it needs HA to start on
> that precise microsecond, so it's left alone rather than papered over with
> mismatched offsets.)

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
