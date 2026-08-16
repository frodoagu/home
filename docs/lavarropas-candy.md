# Candy simply-Fi washer-dryer (local API, no cloud)

Monitoring for the **Candy simply-Fi washer-dryer** over its **local HTTP API**,
using the HACS integration
[`ofalvai/home-assistant-candy`](https://github.com/ofalvai/home-assistant-candy).
Nothing goes through the Candy/Haier cloud, no account is needed, and it does not
depend on the simply-Fi app — which has been **closed to new enrolments** since
April 2024 because of the UK PSTI legislation.

| Piece | Where it lives |
|---|---|
| `candy` integration | HACS → `/config/custom_components/candy` (PVC, **not in git**) |
| Config entry (IP + key) | HA UI (`.storage`, not in git — see [home-assistant.md](home-assistant.md)) |
| DHCP reservation | [`charts/pihole/values.yaml`](../charts/pihole/values.yaml) → `dhcp.reservations` |
| All-fields sensors | [`charts/home-assistant/packages/lavarropas.yaml`](../charts/home-assistant/packages/lavarropas.yaml) |

```
  Candy washer-dryer        ──HTTP/XOR──>   Home Assistant
  192.168.0.164 (ESP8266)    LAN, no TLS     custom_components/candy   (3 sensors)
  48:55:19:c1:90:bb                          packages/lavarropas.yaml  (17 entities)
      │                                      local polling, READ-ONLY
      └── UDP broadcast heartbeat :55555 every ~7 s
```

---

## 1. Finding the appliance

The Wi-Fi module is an **ESP** (the Pi-hole lease shows it as `ESP_C190BB`) and it
**does not answer ICMP**: a `ping` sweep will not find it even though it is
perfectly alive. Two reliable ways:

**UDP heartbeat.** The appliance broadcasts to `255.255.255.255:55555` every ~7
seconds, and the payload self-identifies with its MAC and IP:

```bash
python3 - <<'EOF'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('', 55555)); s.settimeout(15)
data, addr = s.recvfrom(4096)
print(addr[0], data[:120])
EOF
```

**Pi-hole lease.** Pi-hole is the LAN DHCP server ([pihole.md](pihole.md)), so the
appliance is in its lease table:

```bash
kubectl exec -n pihole deploy/pihole -- cat /etc/pihole/dhcp.leases | grep -i esp_
```

The IP is **pinned with a DHCP reservation** in `charts/pihole/values.yaml`,
because the integration addresses the appliance by IP and breaks if the lease
moves.

---

## 2. The XOR layer on the local API

The local API has two useful endpoints, and **this appliance requires
`encrypted=1`** (with `encrypted=0` it answers `{"response":"BAD REQUEST"}`):

| Endpoint | Returns |
|---|---|
| `/http-read.json?encrypted=1` | full status, hex |
| `/http-getStatistics.json?encrypted=1` | `{"response":"ERROR"}` — unsupported here |
| `/` | same as getStatistics |

The response is ASCII JSON encrypted with a **repeating 16-character XOR key**,
hex-encoded. For this appliance the key is:

```
aeaclekbgmjjcebg
```

### This is obfuscation, not security

The key is **recoverable from the appliance's own public response**, with no
credentials, in seconds. Neither the app nor
[CandySimplyFi-tool](https://github.com/MelvinGr/CandySimplyFi-tool) is required:

1. **Key length by autocorrelation** — XOR the ciphertext against itself shifted
   by *n*; the peak is the period. Here: 49 matches at shift 16 and 54 at shift
   32, against ~5 of noise everywhere else → 16-byte key.
2. **Per-column attack** — with period 16, bytes `i, i+16, i+32…` share one key
   byte. The plaintext is ASCII JSON, so the right byte is one of the very few
   that keep the **whole** column printable. Several positions came out with a
   single candidate.
3. **Frequency tie-break** — among the survivors, score letters, digits and `"{}:,`.

> **Trap:** the JSON is **pretty-printed with tabs and newlines**, so the
> plaintext does not start with `{"` but with `{\n\t"`. Using `{"` as
> known-plaintext makes the attack fail; `\t`, `\n` and `\r` have to be allowed in
> the valid-character set.

That is why the key is **not in git and not in a SealedSecret** — not out of
caution, but because it is not a secret: it grants nothing that reaching the
appliance on the LAN does not already grant. There would also be nowhere to put
it: the integration is **config-flow only** and its config lives in
`/config/.storage/core.config_entries`, with no YAML path — the same trap as
`telegram_bot` and `http:` (see the gotchas in `CLAUDE.md`). Since 0.7.0 the
integration **auto-detects the key** anyway; it only needs the IP.

---

## 3. Entities

### 3.1 From the integration

It creates **sensors only** (`PLATFORMS = ["sensor"]`). Names and area were set by
hand — the integration hardcodes its suggested area in `SUGGESTED_AREA_BATHROOM`
(`const.py`) and creates a "Bathroom" area regardless of where the appliance
actually is.

| Entity | What it is |
|---|---|
| `sensor.lavasecarropas` | machine state; attributes `program`, `temperature`, `spin_speed`, `remaining_minutes`, `remote_control` |
| `sensor.lavasecarropas_estado_ciclo` | program phase (wash, rinse, spin…) |
| `sensor.lavasecarropas_tiempo_restante_integracion` | remaining minutes — **wrong, see the bug in §5**; renamed out of the way so the package can own the clean id |

The **states already render in Spanish** with no extra work: the integration ships
`translations/sensor.es.json` and this HA runs with `language: es`. The API always
returns the raw English string (`Idle`, `Running`) and the translation is
presentation-only — which matters when writing automations: they **must compare
against the English string**, not against what the UI shows.

| Raw | Spanish UI |
|---|---|
| `Idle` / `Running` / `Paused` | En reposo / En marcha / En pausa |
| `Finished` | Completado |
| `Wash` / `Rinse` / `Spin` | Lavando / Aclarado / Centrifugando |
| `Drying` | Secando |

### 3.2 From the package (every field)

Because the integration drops 10 fields and publishes the time wrong,
[`packages/lavarropas.yaml`](../charts/home-assistant/packages/lavarropas.yaml)
reads the **same endpoint** and exposes everything. A single `command_line` sensor
does the fetch and the decryption; the other 16 entities are `template` sensors
over its attributes, so the request count against an appliance that tolerates very
few stays at one per cycle.

| Entity | What it is |
|---|---|
| `sensor.lavasecarropas_datos` | raw fetch; **every** field as an attribute |
| `sensor.lavasecarropas_estado` | En reposo / En marcha / En pausa / Completado / Error… |
| `sensor.lavasecarropas_fase` | Pre-lavado / Lavando / Aclarado / Centrifugando / Secando… |
| `sensor.lavasecarropas_tiempo_restante` | **corrected** minutes (no ÷60) |
| `sensor.lavasecarropas_fin_estimado` | finish timestamp; only available while running |
| `sensor.lavasecarropas_temperatura` | °C |
| `sensor.lavasecarropas_centrifugado` | rpm (`SpinSp × 100`) |
| `sensor.lavasecarropas_programa` | program number |
| `sensor.lavasecarropas_nivel_de_suciedad` | `SLevel` |
| `sensor.lavasecarropas_nivel_de_secado` | dry scale — **unconfirmed**, see §5 |
| `sensor.lavasecarropas_inicio_diferido` | "Sin programar" when `DelVal == 255` |
| `sensor.lavasecarropas_error` | "Sin error" when `Err == 255` |
| `sensor.lavasecarropas_opciones_activas` | which `OptN` are set |
| `binary_sensor.lavasecarropas_en_marcha` | `device_class: running` |
| `binary_sensor.lavasecarropas_ciclo_terminado` | `MachMd` in 7/8 |
| `binary_sensor.lavasecarropas_problema` | `device_class: problem` |
| `binary_sensor.lavasecarropas_vapor` | `Steam != 0` |

> Entity **names** are deliberately Spanish (this is a Spanish-speaking
> household); the docs are English.
>
> With the integration **and** the package both enabled there are **two 60 s
> pollers** against an appliance that serves one connection at a time, so they
> occasionally collide. That is why the package command retries 3×; observed in
> practice: the first read times out and the second succeeds.

---

## 4. Raw fields

The appliance reports under the `statusLavatrice` key. Mapping per
`client/model.py`:

| Field | Meaning | Transform |
|---|---|---|
| `MachMd` | machine state | 1 Idle · 2 Running · 3 Paused · 4/5 Delayed start · 6 Error · 7/8 Finished |
| `PrPh` | program phase | 0 Stopped · 1 Pre-wash · 2 Wash · 3 Rinse · 4 Last rinse · 5 End · 6 Drying · 7 Error · 8 Steam · 9 Spin Good Night · 10 Spin |
| `Pr` | program number | direct |
| `Temp` | temperature °C | direct |
| `SpinSp` | spin speed | **× 100** (`10` → 1000 rpm) |
| `RemTime` | remaining time | **÷ 60** — wrong here, see §5 |
| `WiFiStatus` | → `remote_control` attribute | `== "1"` |

**Fields the integration ignores entirely:** `Err`, `SLevel`, `Opt1`…`Opt8`,
`Steam`, **`DryT`**, `DelVal`, `RecipeId`, `CheckUpState`. In other words: even
though this is a washer-**dryer** reporting `DryT`, **none of the drying
information reaches an entity** — the integration models it as a plain washing
machine and creates no tumble-dryer device.

---

## 5. Gotchas

- **`RemTime` is in MINUTES on this appliance, not seconds.** The integration does
  `round(RemTime / 60)` assuming seconds, so its
  `sensor.…_wash_cycle_remaining_time` **reads ~60× lower than reality**: on a
  freshly started 40 °C wash, `RemTime: 116` (116 minutes) was published as
  `remaining_minutes: 2`. That this is a bug rather than a per-model unit
  difference is proven by the integration itself: in `TumbleDryerStatus.from_json`
  the same field is read as `remaining_minutes=int(json["RemTime"])`, **undivided**.
  The package publishes the correct value.

- **`RemTime` has two more quirks, measured on a real wash cycle.** The unit is
  unambiguously minutes — sampled every 15 s it gives `85 → 85 → 84 → 84 → 84 →
  84 → 83`, exactly one decrement per minute — but:

  1. **The estimate is revised downward early in the cycle**, presumably when the
     load is weighed: `116` held for the first few minutes, then `110 → 85` inside
     about a minute. For those first minutes the number is useless for computing a
     finish time.
  2. **The appliance emits transient bogus values.** Two consecutive reads (two
     minutes apart) returned `10` while the real value was around `110`, then the
     series recovered on its own. The JSON was valid and decrypted cleanly, so this
     is not a read error.

  Automations must therefore **trigger on state transitions** (`MachMd` / `PrPh`),
  which are reliable, and never on a single remaining-time reading.

- **`remote_control` does not mean remote control is armed.** The attribute comes
  from `WiFiStatus == "1"`. Empirically it is `True` with the machine idle and flips
  to `False` while a dial-started cycle runs, so it seems to track remote-control
  availability — but the field's exact semantics are unconfirmed. Do not read it as
  "I can send commands now".

- **Entity ids collide between the integration and the package, and HA resolves
  the collision the wrong way round.** Both want to publish a remaining-time
  sensor. Whichever registers second gets a `_2` suffix — on first deploy that was
  the package's (correct) sensor, leaving the integration's buggy one holding the
  clean `sensor.lavasecarropas_tiempo_restante`. Fixed in the entity registry by
  renaming the integration's to `…_tiempo_restante_integracion` first and then
  reclaiming the clean id. Both entities carry a `unique_id`, so the registry
  remembers the rename across restarts. Watch for the same trap if more overlapping
  sensors are added.

- **HA slugifies entity ids from the full friendly name, prepositions included.**
  `"Lavasecarropas nivel de secado"` becomes `sensor.lavasecarropas_nivel_de_secado`,
  not `…_nivel_secado`. Read the ids back from the API after a deploy instead of
  predicting them.

- **The appliance serves ONE connection at a time.** Two overlapping requests give
  `connection refused` on the second. This is what the integration fixed in 0.8.0
  with rate limiting; isolated errors in the log are expected and not a failure.

- **It does not answer ICMP** — it will not show up in `ping` sweeps, nor in the ARP
  table if nothing has talked to it. Use the UDP heartbeat (§1).

- **It is read-only.** `PLATFORMS = ["sensor"]` and the client has no write call at
  all. Cycles cannot be started, paused or configured from HA. The firmware does
  expose `/http-write.json` and the community uses it on other models, but the
  parameter format is not publicly documented and would need reverse engineering.

- **The integration is dormant.** Latest release 0.8.3 (January 2025) against HA
  2026.8.2. It is not archived and issues are still being closed in 2026, and it is
  simple polling with little surface to break — but nobody guarantees a fix if HA
  drops a constant it still uses. The fork
  [`bigmoby/home-assistant-candy`](https://github.com/bigmoby/home-assistant-candy)
  exists as an alternative, though its latest release (v1.2.2, June 2024) is
  **older** than the original's.

- **It lives on the PVC, not in git.** Like SmartIR: HACS installs the integration
  into `/config/custom_components` and the config entry lands in `.storage`. If the
  HA volume is recreated, it has to be reinstalled and the IP re-entered. Only the
  DHCP reservation and the package are versioned.

---

## 6. Setting it up from scratch

1. HACS → search **"Candy Simply-Fi"** (`ofalvai/home-assistant-candy`) → download
   → restart HA.
2. Settings → Devices & Services → Add Integration → **Candy**.
3. Single field: the **IP** (`192.168.0.164`). The key is auto-detected; if it ever
   has to be entered by hand, it is in §2.
4. Move the device to the **Cocina** area and rename the entities — by default they
   come out as `sensor.bathroom_washing_machine_*` and a spurious "Bathroom" area is
   created that should be deleted.
5. Rebuild the UI state below, which git cannot carry.

---

## 7. UI state (lives in `.storage`, not in git)

Everything in this section is entity-registry and Lovelace state. A rebuilt HA
volume loses all of it, and nothing here is reproducible from the chart.

### 7.1 Renames, area and hidden entities

The integration's three sensors are **redundant** once the package is running — two
of them also render their state in English — so they are hidden rather than shown
next to their corrected counterparts.

| Entity | Change |
|---|---|
| `sensor.lavasecarropas` | area `cocina`, **hidden** |
| `sensor.lavasecarropas_estado_ciclo` | **hidden** |
| `sensor.lavasecarropas_tiempo_restante_integracion` | renamed from the clean id, named "Tiempo restante (integración)", **hidden** |
| `sensor.lavasecarropas_datos` | area `cocina`, **hidden** — it only carries raw attributes, its state is meaningless |
| the other 16 package entities | area `cocina` |

Hiding is UI-only: hidden entities keep their state and the template sensors that
read `sensor.lavasecarropas_datos` keep working.

The device itself is renamed to **Lavasecarropas** and placed in **Cocina**.

### 7.2 Why the package entities land under "Other"

Template entities have no device, so HA files them under *Other* on the area page
while the integration's three sit under the `Lavasecarropas` device. The template
integration **does** accept a `device_id` (`homeassistant/components/template/entity.py`)
which would group all of them under that device — deliberately not used, because the
id is generated by the integration's config entry: removing and re-adding the
integration changes it, orphaning all 16 entities and coupling a package that is
otherwise standalone to the integration's existence. The dedicated dashboard below
sidesteps the grouping entirely.

### 7.3 The dashboard

A separate dashboard, so the auto-generated Overview and the existing `Mapa` /
`TVs` dashboards are untouched.

- **URL path:** `lavasecarropas-panel` (HA requires a hyphen in custom paths)
- **Title / icon:** Lavasecarropas · `mdi:washing-machine`
- Rebuild with *Settings → Dashboards → Add*, then in the new dashboard use the
  three-dot menu → *Raw configuration editor* and paste:

```yaml
views:
  - title: Lavasecarropas
    path: principal
    icon: mdi:washing-machine
    type: sections
    max_columns: 3
    sections:
      - type: grid
        cards:
          - {type: heading, heading: Ahora, icon: mdi:washing-machine, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_estado, name: Estado}
          - {type: tile, entity: sensor.lavasecarropas_fase, name: Fase del ciclo}
          - {type: tile, entity: binary_sensor.lavasecarropas_en_marcha, name: En marcha}
          - {type: tile, entity: binary_sensor.lavasecarropas_ciclo_terminado, name: Ciclo terminado}
      - type: grid
        cards:
          - {type: heading, heading: Tiempo, icon: mdi:timer-sand, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_tiempo_restante, name: Tiempo restante}
          - {type: tile, entity: sensor.lavasecarropas_fin_estimado, name: Termina}
          - type: history-graph
            hours_to_show: 6
            entities:
              - {entity: sensor.lavasecarropas_tiempo_restante, name: Minutos restantes}
      - type: grid
        cards:
          - {type: heading, heading: Programa, icon: mdi:playlist-music, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_programa, name: Programa}
          - {type: tile, entity: sensor.lavasecarropas_temperatura, name: Temperatura}
          - {type: tile, entity: sensor.lavasecarropas_centrifugado, name: Centrifugado}
          - {type: tile, entity: sensor.lavasecarropas_nivel_de_suciedad, name: Nivel de suciedad}
          - {type: tile, entity: sensor.lavasecarropas_nivel_de_secado, name: Nivel de secado}
      - type: grid
        cards:
          - {type: heading, heading: Opciones, icon: mdi:tune-variant, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_opciones_activas, name: Opciones activas}
          - {type: tile, entity: sensor.lavasecarropas_inicio_diferido, name: Inicio diferido}
          - {type: tile, entity: binary_sensor.lavasecarropas_vapor, name: Vapor}
      - type: grid
        cards:
          - {type: heading, heading: Diagnostico, icon: mdi:stethoscope, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_error, name: Codigo de error}
          - {type: tile, entity: binary_sensor.lavasecarropas_problema, name: Problema}
          - type: history-graph
            hours_to_show: 12
            entities:
              - {entity: sensor.lavasecarropas_estado, name: Estado}
              - {entity: sensor.lavasecarropas_fase, name: Fase}
```

---

## 8. Control: not today, but not impossible

The integration is read-only and that is not going to change upstream. Whether the
**appliance** can be driven is a separate question, and the answer looks like yes —
untested here.

The firmware exposes a write endpoint that the community has used on sibling models:

```text
http://<ip>/http-write.json?encrypted=1&data=<encrypted command>
```

The payload is encrypted with the **same XOR key** as the read path, which is the
part that usually blocks people and which §2 already recovers. Reported parameters
include `StartStop=1` to begin a program, plus `DelayStart`, `ExtraDry` and
`OpenDoorOpt`; some machines accept an unencrypted form
(`?encrypted=0&Write=1&…`), though this one rejects `encrypted=0` on the read path.

**Unverified on this appliance.** A bare `GET /http-write.json` timed out here, which
proves nothing either way — with two 60 s pollers running, a timeout is the ordinary
collision signature (§5). Before trying anything real:

- **Only with the machine idle.** Probing write commands mid-cycle risks interrupting
  a running wash.
- **Remote start is probably gated on the appliance.** `WiFiStatus` reads `1` when
  idle and `0` during a dial-started cycle; if it does track remote-control
  availability, the physical dial likely has to be in a remote-enabled position.
- **It starts a real washing machine.** Door, detergent and water supply are all
  physical preconditions no protocol check will catch.
