# Candy simply-Fi washer-dryer (local API, no cloud)

Monitoring for the **Candy simply-Fi washer-dryer** over its **local HTTP API**,
using the HACS integration
[`ofalvai/home-assistant-candy`](https://github.com/ofalvai/home-assistant-candy).
Nothing goes through the Candy/Haier cloud, no account is needed, and it does not
depend on the simply-Fi app — which has been **closed to new enrolments** since
April 2024 because of the UK PSTI legislation.

| Piece | Where it lives |
|---|---|
| DHCP reservation | [`charts/pihole/values.yaml`](../charts/pihole/values.yaml) → `dhcp.reservations` |
| Sensors + control | [`charts/home-assistant/packages/lavarropas.yaml`](../charts/home-assistant/packages/lavarropas.yaml) |
| Operator CLI | [`scripts/candyctl.py`](../scripts/candyctl.py) (read / learn / send / stop) |
| `candy` integration | **removed** 2026-08-17 (§3.1) — HACS files still on the PVC, no config entry |

```
  Candy washer-dryer      <──HTTP, no TLS──>  Home Assistant
  lavarropas.lan / .40 (ESP8266)             packages/lavarropas.yaml
  48:55:19:c1:90:bb        read : hex, XOR      17 sensor entities, 60 s polling
      │                    write: hex, plain    5 helpers + 2 scripts (§8)
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

The response is ASCII JSON, hex-encoded, and **sometimes** encrypted with a
**repeating 16-character XOR key**. For this appliance the key is:

```
aeaclekbgmjjcebg
```

### The cipher is not guaranteed — detect it, don't assume it

The firmware is inconsistent about `encrypted=1`: `/http-config.json` and
`/http-getStatistics.json` always answer hex-encoded **plaintext**, and
`/http-read.json` has been observed doing the same — same URL, same appliance,
no config change. A reader that XORs unconditionally then turns a perfectly good
plaintext reply into garbage, `json.loads` raises, and every downstream entity
goes unavailable at once.

So both readers (`scripts/candyctl.py` `decrypt()` and the `command_line` sensor
in `charts/home-assistant/packages/lavarropas.yaml`) hex-decode first and apply
the XOR **only when the result does not already start with `{`**. Decoding
failures across all entities simultaneously point here first: check with

```bash
curl -sS "http://lavarropas.lan/http-read.json?encrypted=1" \
  | python3 -c "import sys;print(bytes.fromhex(sys.stdin.read().strip())[:40])"
```

If that already prints JSON, the reply is plaintext.

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

### 3.1 From the integration — REMOVED 2026-08-17

The `candy` config entry is **deleted**. It polled the same one-connection-at-a-time
endpoint every 60 s and collided with the package's fetch, which surfaces as
`curl: (52) Empty reply from server` and `Empty reply found when expecting JSON data`
in the HA log. Its three sensors were redundant and already hidden, so the package
lost nothing. The HACS files stay at `/config/custom_components/candy`; with no
config entry HA never loads them. Re-adding the integration re-creates the
collisions — don't.

It created **sensors only** (`PLATFORMS = ["sensor"]`). Names and area were set by
hand — the integration hardcodes its suggested area in `SUGGESTED_AREA_BATHROOM`
(`const.py`) and creates a "Bathroom" area regardless of where the appliance
actually is.

| Entity (gone) | What it was |
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

- **The *integration* is read-only; the appliance is not.** `PLATFORMS = ["sensor"]`
  and its client has no write call, which is why the removed integration could never
  start a cycle. `/http-write.json` does work — the format was never publicly
  documented and is reverse-engineered in **§8**, and the package uses it. Writing
  in bursts wedges the module (§8.4).

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
3. Single field: the **IP** (`192.168.0.40`, i.e. `lavarropas.lan`). The key is auto-detected; if it ever
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

The integration's three sensors were hidden while it was installed; deleting the
config entry (§3.1) took them and its `Lavasecarropas` device out of the registry
altogether, so only the package entities remain.

| Entity | Change |
|---|---|
| `sensor.lavasecarropas_datos` | area `cocina`, **hidden** — it only carries raw attributes, its state is meaningless |
| the other 16 package entities | area `cocina` |

Hiding is UI-only: hidden entities keep their state and the template sensors that
read `sensor.lavasecarropas_datos` keep working.

The `Lavasecarropas` device belonged to the integration's config entry and went away
with it; the package's entities have no device at all (see §7.2).

### 7.2 Why the package entities land under "Other"

Template entities have no device, so HA files them under *Other* on the area page.
The template integration **does** accept a `device_id`
(`homeassistant/components/template/entity.py`) which would have grouped them under
the integration's `Lavasecarropas` device — deliberately not used, because that id
came from the integration's config entry and would have coupled a standalone package
to the integration's existence. Deleting that entry (§3.1) would then have orphaned
all 16 entities; instead they were untouched. The dedicated dashboard below sidesteps
the grouping entirely.

### 7.3 The dashboard

A separate dashboard, so the auto-generated Overview and the existing `Mapa` /
`TVs` dashboards are untouched.

- **URL path:** `lavasecarropas-panel` (HA requires a hyphen in custom paths)
- **Title / icon:** Lavasecarropas · `mdi:washing-machine`
- Rebuild with *Settings → Dashboards → Add*, then in the new dashboard use the
  three-dot menu → *Raw configuration editor* and paste:

Two things this layout deliberately avoids, both of which the first version got
wrong:

- **The binary sensors are not on it.** `en_marcha` and `ciclo_terminado` exist to
  drive automations; as tiles they only restate `sensor.lavasecarropas_estado`.
- **The finish time is shown as a wall clock, not a countdown.** A `tile` renders a
  `device_class: timestamp` entity as relative time ("in 38 minutes"), which is a
  verbatim repeat of the remaining-minutes sensor beside it. An `entities` row with
  `format: time` prints `23:47` instead, which is the only reason to show it at all.
  There is no countdown graph for the same reason: plotting a counter that decrements
  by one is a straight line that carries no information the number lacks. The only
  history graph kept is the phase progression, which cannot be read off any single
  number.

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
      - type: grid
        cards:
          - {type: heading, heading: Tiempo, icon: mdi:timer-sand, heading_style: subtitle}
          - type: entities
            entities:
              - {entity: sensor.lavasecarropas_tiempo_restante, name: Faltan}
              - {entity: sensor.lavasecarropas_fin_estimado, name: Termina a las, format: time}
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
          - {type: heading, heading: Historial y diagnostico, icon: mdi:chart-timeline-variant, heading_style: subtitle}
          - {type: tile, entity: sensor.lavasecarropas_error, name: Codigo de error}
          - type: history-graph
            hours_to_show: 12
            entities:
              - {entity: sensor.lavasecarropas_fase, name: Fase}
              - {entity: sensor.lavasecarropas_estado, name: Estado}
```

### 7.4 The control view

A second view on the same dashboard. Add it under `views:` after the one above.

The layout follows the one rule the appliance imposes (§8.4): **one command per
press, and never a burst**. So selecting and starting are two separate buttons
rather than one — *Seleccionar* writes the recipe without `StSt=1`, and the
"Cargado en el equipo" card right below it then shows what the appliance actually
took. That readback is the only confirmation that exists, since the HTTP reply
always says `SUCCESS`. Once it looks right, *Arrancar* commits.

Both mutating buttons carry a `confirmation`, and the manual controls are behind a
`conditional` card so the normal path stays a single dropdown.

```yaml
  - title: Control
    path: control
    icon: mdi:play-box-outline
    type: sections
    max_columns: 2
    sections:
      - type: grid
        cards:
          - {type: heading, heading: Que lavar, icon: mdi:playlist-check, heading_style: subtitle}
          - type: entities
            entities:
              - {entity: input_select.lavasecarropas_preset, name: Preset}
          - type: conditional
            conditions:
              - {condition: state, entity: input_select.lavasecarropas_preset, state: Manual}
            card:
              type: entities
              title: A mano
              entities:
                - {entity: input_select.lavasecarropas_programa_manual, name: Programa}
                - {entity: input_select.lavasecarropas_temperatura_manual, name: Temperatura}
                - {entity: input_select.lavasecarropas_centrifugado_manual, name: Centrifugado}
                - {entity: input_select.lavasecarropas_secado_manual, name: Secado}
          - type: button
            name: Seleccionar
            icon: mdi:tray-arrow-down
            tap_action:
              action: perform-action
              perform_action: script.lavasecarropas_aplicar
              data: {arrancar: false}

      - type: grid
        cards:
          - {type: heading, heading: Cargado en el equipo, icon: mdi:check-decagram, heading_style: subtitle}
          - type: entities
            entities:
              - {entity: sensor.lavasecarropas_programa, name: Programa}
              - {entity: sensor.lavasecarropas_temperatura, name: Temperatura}
              - {entity: sensor.lavasecarropas_centrifugado, name: Centrifugado}
              - {entity: sensor.lavasecarropas_nivel_de_secado, name: Secado}
              - {entity: sensor.lavasecarropas_tiempo_restante, name: Duracion}
              - {entity: sensor.lavasecarropas_estado, name: Estado}
          - type: button
            name: Arrancar
            icon: mdi:play
            tap_action:
              action: perform-action
              perform_action: script.lavasecarropas_aplicar
              data: {arrancar: true}
              confirmation:
                text: Arrancar el ciclo con el programa seleccionado?
          - type: button
            name: Detener
            icon: mdi:stop
            tap_action:
              action: perform-action
              perform_action: script.lavasecarropas_detener
              confirmation:
                text: Cancelar el ciclo en curso?
```

The sensors on the right update on the package's 60 s poll, so a selection takes
up to a minute to show. Forcing it with `homeassistant.update_entity` would fire a
second fetch at the appliance right after a write — precisely the pattern §8.4
warns about — so the view waits instead.

---

## 8. Control: confirmed working

The appliance **can** be driven over the LAN, and the Home Assistant package
does it. Everything in this section was verified against this machine on
**2026-08-17**, with the dial on **Smart Fi+** and `WiFiStatus: 1`.

### 8.1 The wire format

```text
GET http://lavarropas.lan/http-write.json?encrypted=1&data=<HEX>
```

Two things about that URL are counter-intuitive, and between them they are why
writing looks impossible until it suddenly isn't:

- **`encrypted=1` is mandatory** — `encrypted=0` answers `{"response":"BAD REQUEST"}`,
  on the write path exactly as on the read path.
- **…but nothing is encrypted.** `data=` is the **hex of the plain ASCII
  command**. Sending the XOR blob under the read key (§2) — the obvious reading
  of `encrypted=1`, and what the reference Android client does on *its* hardware —
  is accepted, answered `SUCCESS`, and **silently ignored**.

> **The reply is worthless as a signal.** `/http-write.json` returns
> `{"response":"SUCCESS"}` for *everything*: an empty request, a valid command, a
> command made of invented parameters. It confirms only that the endpoint is
> routed. The **only** evidence that a command was understood is a changed field
> in `/http-read.json`, which is why `candyctl.py send` snapshots the status
> before and after and prints the diff.

### 8.2 Parameters

The write names are **not** the read names. Writing `Temp=30` or `DryT=3` does
nothing at all; the targets are separate fields:

| Write | Effect | Read back as |
|---|---|---|
| `Write=1` | required on every command | — |
| `PrNm=<n>` | select program **and load its whole default recipe** | `Pr` |
| `TmpTgt=<°C>` | target temperature | `Temp` |
| `SpdTgt=<rpm/100>` | target spin (`10` → 1000 rpm) | `SpinSp` |
| `SLevTgt=<n>` | target soil level | `SLevel` |
| `Dry=<n>` | drying level | `DryT` (**not** the same scale — `Dry=3` reads back `DryT=2`) |
| `StSt=1` | start the selected program | `MachMd` → 2 |
| `StSt=0` | stop / cancel, including an armed delayed start | `MachMd` → 1 |

`PrNm` overwrites temperature, spin and soil level with the program's defaults,
so any override has to travel **in the same command**, after it:

```bash
scripts/candyctl.py send "Write=1&PrNm=6&TmpTgt=30&SpdTgt=8" --yes   # select only
scripts/candyctl.py send "Write=1&PrNm=6&TmpTgt=30&SpdTgt=8&StSt=1" --yes
scripts/candyctl.py stop --yes                                       # cancel
```

**`DelVl` is not exposed anywhere.** Delayed start was reached once, but only as
a side effect of malformed writes, and `DelVl=<n>` alongside a valid `StSt=1`
did not arm it. `StSt=0` does clear it, which is what matters for recovery.

### 8.3 The program table

`PrNm` (what you write) is **not** `Pr` (what you read) — `PrNm=3` comes back as
`Pr=2`. This table is the appliance's own answer: set `PrNm`, then read the
recipe it loaded. Temperature/spin of `255` mean "not applicable to this program".

| `PrNm` | → `Pr` | Temp | Spin | `DryT` | `RemTime` | Reads as |
|---|---|---|---|---|---|---|
| 1, 2 | *(rejected)* | | | | | leaves the program unchanged |
| 3 | 2 | 40 | 1000 | 0 | 117 | mixed / Perfect Mix |
| 4, 5 | 4 | 40 | 1000 | 0 | 59 | 59-minute wash |
| 6 | 6 | 40 | 1400 | 0 | 232 | long cottons |
| 7 | 7 | 40 | 400 | 0 | 59 | |
| 8, 9 | 8 | 40 | 400 | 0 | 59 | |
| 10 | 10 | 30 | 800 | 0 | 48 | delicates |
| 11, 12 | 11 | — | — | **2** | 120 | drying only |
| 13, 14 | 13 | — | — | **1** | 230 | wash + dry |
| 15 | 15 | 90 | 400 | 0 | 136 | Smart Fi+ resting position |
| 16 | 16 | — | — | 0 | 59 | |
| 17, 18 | 17 / 18 | — | 0 | 0 | **1** | drain, no spin |
| 19 | 19 | 30 | 0 | 0 | 45 | |
| 20 | 20 | — | 0 | 0 | 59 | |

The **names are descriptions of the measured recipe**, not the dial legend —
only `Pr=2` (Perfect Mix, from a real cycle) and `Pr=15` (Smart Fi+) are
confirmed against the panel, and the measurements **contradict** the rest of that
legend: `PrNm=11` loads a drying program where the panel reads "Lana". So the
manual selector labels each entry by what it measurably does
(`Perfect Mix · 40° · 1h57`, `Sólo secado · 2h`, `Desagüe · sin centrifugado · 1'`)
and falls back to `Programa N · <recipe>` for the ones that could not be
characterised — a true statement instead of a guessed name. Reconcile them with
`candyctl.py learn` before renaming.

### 8.4 A burst of writes hangs the appliance

Sweeping parameters back-to-back — roughly one write every 10 s for a few
minutes — **wedged the Wi-Fi module**: it kept answering `/http-read.json`, but
with incoherent values (`SpdTgt=0` reading back as `SpinSp=12`, `SpdTgt=4` as
`11`), and it took a **power cycle** to recover. Nothing was damaged, and the
appliance came back on its own resting values.

Read this together with the one-connection-at-a-time limit in §5: the appliance
tolerates the 60 s polling of the package plus the occasional command, and does
not tolerate being driven like an API. Hence:

- `shell_command.lavasecarropas_enviar` retries **3 times, 3 s apart**, and stops.
- The scripts send **one** command per press.
- Incoherent readings across several fields at once — as opposed to everything
  going unavailable together, which is the decode failure of §2 — mean the module
  is wedged. Power-cycle the appliance.

### 8.5 What the package exposes

[`packages/lavarropas.yaml`](../charts/home-assistant/packages/lavarropas.yaml)
carries the write path (`shell_command` + two scripts + the helpers behind the
dashboard in §7.4):

| Entity | What it does |
|---|---|
| `input_select.lavasecarropas_preset` | 7 measured presets, plus `Manual` |
| `input_select.lavasecarropas_programa_manual` | the 13 programs by name; the script maps each to its `PrNm` |
| `input_select.lavasecarropas_temperatura_manual` | `Del programa` / 20…90 °C |
| `input_select.lavasecarropas_centrifugado_manual` | `Del programa` / 0…1400 rpm |
| `input_select.lavasecarropas_secado_manual` | `Del programa` / `Sin secado`…`Extra` |
| `script.lavasecarropas_aplicar` | builds the command; field `arrancar` adds `StSt=1` |
| `script.lavasecarropas_detener` | `Write=1&StSt=0` |
| `shell_command.lavasecarropas_enviar` | hexes the plain command and GETs it |

`aplicar` with `arrancar: false` only **selects** — the sensors then show the
recipe the appliance actually loaded, which is the cheap way to confirm a command
landed before committing to a cycle. It refuses to start over a running cycle
(`MachMd == 2`); selecting during one is harmless and allowed.

HA switches to `create_subprocess_exec` (no shell) as soon as a `shell_command`
contains a template, so `lavasecarropas_enviar` invokes `sh -c` explicitly and
passes the command as a **positional argument** rather than interpolating it into
the URL — that keeps the `&` between parameters from being split. It follows that
a command containing a quote would break the quoting; none of the generated ones
do.
