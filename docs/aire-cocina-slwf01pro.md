# Kitchen AC: SMLIGHT SLWF-01pro (ESPHome + Midea)

The kitchen split is controlled over Wi-Fi by a **SMLIGHT SLWF-01pro** module
plugged into the indoor unit, instead of by infrared like the other three. It is
the only two-way AC in the house.

The same change frees the kitchen's IR blaster, which moves to the **kids' room**
to drive the new **Philco iView 3800 W** there. So this is one swap with two
halves, and both are described here.

Firmware: [`esphome/aire-cocina.yaml`](../esphome/aire-cocina.yaml).
Entities and scenes: [`packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml).

---

## 1. The new layout

| Room | Path | Blaster / module | Entity |
|---|---|---|---|
| Living | SmartIR + IR | `remote.control_living` (`192.168.0.31`) | `climate.aire_living` |
| Bedroom | SmartIR + IR | `remote.control_dormitorio` (`192.168.0.30`) | `climate.aire_dormitorio` |
| **Kitchen** | **ESPHome + Midea UART** | **SLWF-01pro (`192.168.0.12`)** | `climate.aire_cocina` |
| **Kids' room** | SmartIR + IR | **`remote.broadlink_cocina` (`192.168.0.32`), moved** | `climate.aire_chicos` |

The blaster keeps its MAC, its `.32` reservation and its HA config entry — only
the room it radiates in changes, so nothing has to be re-paired. Its entity id
still says `cocina`; Broadlink is a config-flow integration, so renaming it is a
UI job and would mean editing `controller_data` in `climate.yaml` to match.

## 2. Why the kitchen and not the kids' room

The SLWF-01pro speaks **Midea's UART protocol** and only works on units with Midea
electronics. The kitchen unit qualifies: the repo already had it on SmartIR code
`1382` (*Midea MSY-12HRDN1*, the BGH Silent Air rebadge, same unit as the living
room), and the brands sold on Midea electronics include Samsung, Carrier, Comfee,
Electrolux, Bosch, Beko, Kaisai, Qlima and Toshiba.

The Philco in the kids' room does **not** qualify on paper — Philco isn't on that
list — and the precedent in this house points the other way: the bedroom AC is
labelled *Philco* and turned out to be a **rebranded Mitsubishi Electric**, running
Mitsubishi's `5140` because the Philco code never worked. Philco is a licensed
brand, so the OEM changes with the model and the year.

Putting the module on the unit that is known to be Midea and giving the Philco the
IR path that already works for the other Philco is the low-risk assignment of the
two.

Since the living room is the **same model as the kitchen**, it is the obvious
candidate if a second module ever gets bought.

## 3. Architecture

```
   Kitchen indoor unit (Midea electronics)
        │  4-pin USB-A-shaped port (5 V UART, NOT USB)
        ▼
   SLWF-01pro  ── ESP8266 (esp12e) + level shifter to 5 V
        │  ESPHome firmware, `midea` component @ 9600 8N1 (GPIO1/GPIO3)
        ▼  Wi-Fi — native ESPHome API, port 6053
   Home Assistant (k3s, hostNetwork)
        └── climate.aire_cocina  +  outdoor temperature sensor  +  RSSI
```

The module draws power from that same port, which is live whenever the indoor
unit has mains — the AC does not have to be switched on.

## 4. What changes for the kitchen entity

`climate.aire_cocina` keeps its id, so **every scene and automation that names it
is untouched**. What changes is what's behind it:

| | Before (SmartIR) | After (ESPHome) |
|---|---|---|
| Transport | IR, **one-way** | UART on the unit's own bus, **two-way** |
| State in HA | The one HA **assumed** it sent | The one the unit **reports** |
| Physical remote | HA never found out | HA finds out and updates the entity |
| Ambient temperature | None (no ATC thermometer in the kitchen) | Measured by the AC itself |
| Outdoor temperature | — | Reported by the unit |
| If Wi-Fi drops | Kept working (IR is local) | Entity goes `unavailable` |

Two consequences worth knowing:

- The group toggles (`aires_toggle_calor`, `aires_cocina_living_toggle_*`) read a
  **real** state for the kitchen and an assumed one for the other two. That's
  strictly better than before, but it doesn't make the group logic exact.
- The kitchen is also the only AC that can now go `unavailable`. The toggle
  conditions therefore decide on the units HA can actually see: an offline kitchen
  is ignored rather than read as "off", which would otherwise pin those buttons to
  the turn-everything-on branch until the module came back. For every state
  reachable while all three are visible, the outcome is identical to the IR-only
  version.
- `climate.aire_cocina` is now the one entity whose state is worth trusting in an
  automation condition. `aires_apagar_templado` currently keys on
  `climate.aire_living` (assumed); pointing it at the kitchen instead would make
  it more reliable. Not done here — it changes an automation nobody asked to
  change.

## 5. Physical install

With the AC **powered down at the breaker** (the port itself is 5 V, but the board
around it is not):

1. Lift the indoor unit's front cover.
2. Find the 4-pin USB-A female port (sometimes labelled *WiFi* or *USB*, behind a
   small cap) and remove the cap. **If the port isn't there, stop** — the module
   has nowhere to go, and §9 covers that case.
3. Plug the SLWF-01pro in. It only fits one way.
4. Leave the module inside the enclosure, not resting on the heat exchanger and
   not blocking airflow.
5. Breaker back on.

No soldering, and nothing touching mains.

Then move the kitchen blaster to the kids' room and plug it in there. Nothing to
reconfigure: same LAN, same `.32`, same config entry.

## 6. Flashing

The module ships with SMLIGHT's own firmware and a web interface for uploading
another. First load:

```bash
esphome compile esphome/aire-cocina.yaml    # prints the firmware.bin path
```

Join the AP the module brings up, open its web UI and upload that `.bin`.

From then on everything goes over OTA, with the module already on the house Wi-Fi:

```bash
esphome run esphome/aire-cocina.yaml        # uses aire_cocina_ota_password
esphome logs esphome/aire-cocina.yaml
```

The keys (`aire_cocina_api_key`, `aire_cocina_ota_password`) live in
`esphome/secrets.yaml`, which is **not** committed; the template with the names is
[`secrets.yaml.example`](../esphome/secrets.yaml.example).

Two things in the config that are not optional:

- **`logger.baud_rate: 0`** — UART0 is the unit's bus. Logging over serial feeds
  garbage into the protocol. Logs still come out over the API and the web server.
- **`uart` on GPIO1/GPIO3 at 9600 8N1** — that's what the unit speaks; there is
  nothing to configure on the AC side.

`esphome logs` is also the compatibility test: if the unit answers, `autoconf`
reports the detected capabilities. If all you see are `midea` component timeouts,
the connector was there but the protocol isn't Midea → §9.

## 7. ⚠️ Keeping the `climate.aire_cocina` entity id

This is the step that breaks things if it's done out of order.

The SmartIR kitchen entity owns `climate.aire_cocina` in HA's **entity registry**,
and removing its YAML block does not free the id — the registry keeps the entry as
an orphan. If the ESPHome device is onboarded while that orphan is still there,
its climate entity lands on **`climate.aire_cocina_2`**, and every scene and
automation that names `climate.aire_cocina` silently points at a dead entity: the
morning heat automation, all four group toggles, "apagar todos".

Correct order:

1. Merge the change and let HA restart with the SmartIR kitchen block gone.
2. **Settings → Devices & Services → Entities**, search `aire_cocina`. The old
   entry shows up as unavailable / restored. **Delete it.**
3. Only then onboard the ESPHome device (§8). It claims `climate.aire_cocina`.

If it did land on `_2`: delete the orphan, then rename the ESPHome entity back to
`climate.aire_cocina` in the same screen. Nothing in git needs changing either way.

## 8. Onboarding in Home Assistant

HA runs with `hostNetwork: true`, so it sees the device's mDNS and discovers it by
itself (Settings → Devices → ESPHome, "Discovered").

1. Accept the discovery (or add it manually as `aire-cocina.lan`, port 6053).
2. Paste the **encryption key**: it's `aire_cocina_api_key` from
   `esphome/secrets.yaml`.
3. You get `climate.aire_cocina`, plus `sensor.aire_cocina_temperatura_exterior`
   and the RSSI as a diagnostic.

The entity is named that way because the YAML's `climate` carries `name: ""` and
inherits the device's `friendly_name`. Renaming the device means re-flashing and
re-discovering.

`climate` is in `googleAssistant.exposedDomains`, so the AC shows up in Google
Home with nothing else to do.

### DHCP reservation

The address plan gives the module **`192.168.0.12`**, in the ESPHome decade (see
[pihole.md](pihole.md)). The entry is already written in
[`charts/pihole/values.yaml`](../charts/pihole/values.yaml) but **commented out**,
because an invalid MAC in `dhcp-host` doesn't just break that line: it takes down
the whole DHCP configuration.

1. Get the module's MAC — ESPHome prints it (`esphome logs`, or the device's web
   server), or read it off Pi-hole's lease list.
2. Uncomment the line and paste it in:

   ```yaml
   - { mac: "xx:xx:xx:xx:xx:xx", ip: "192.168.0.12", name: "aire-cocina" }
   ```

3. Commit and push. ArgoCD syncs Pi-hole on its own.
4. **Reboot the module** so it renews the lease and picks up `.12` — otherwise it
   keeps its dynamic-pool address until that one expires.

After that it also answers as `aire-cocina.lan`.

## 9. If it doesn't work

**No USB-shaped port, or the unit never answers (`midea` component timeouts).**
The kitchen unit isn't Midea inside after all. Reverting means putting the kitchen
back on SmartIR with code `1382` — but the blaster it used is in the kids' room by
then, so the revert costs a blaster: either move it back and leave the kids' room
for later, or buy a fourth Broadlink RM4 mini (`192.168.0.33` is the next free
address in its decade).

**It answers, but modes the physical remote has are missing in HA.** Capability
detection came up short: set `autoconf: false` and list `supported_modes`,
`custom_fan_modes`, `supported_presets` and `supported_swing_modes` by hand.

**The entity goes `unavailable` now and then.** The ESP8266 is short on RAM and
`web_server` is the most expensive thing running. Drop it from the YAML before
blaming the Wi-Fi.

**The kids' room AC doesn't respond to `climate.aire_chicos`.** `device_code: 5140`
is a hypothesis, not a verified code — it's what the bedroom Philco needed. Don't
guess by brand: compare the IR waveform of candidate codes against one that
partially works, the method is in
[home-assistant.md](home-assistant.md#air-conditioners-smartir--broadlink).

## 10. Checklist for the day it arrives

**Kitchen (the module):**

- [ ] Breaker off, cover up, confirm the 4-pin USB-A port exists (§5).
- [ ] Plug the module in, close up, breaker back on.
- [ ] `esphome compile` and upload the `.bin` through the module's web UI (§6).
- [ ] Point it at the house Wi-Fi from its captive portal.
- [ ] `esphome logs` → the unit answers and `autoconf` detects capabilities (§6).
- [ ] **Delete the stale `climate.aire_cocina` from the entity registry** (§7).
- [ ] Accept the discovery in HA, paste the encryption key, confirm the entity
      came back as `climate.aire_cocina` and *not* `_2` (§7-8).
- [ ] Note the MAC, uncomment the reservation, commit, reboot the module (§8).
- [ ] Run "Aires - Toggle todos" and check the kitchen reacts.

**Kids' room (the blaster):**

- [ ] Move the blaster from the kitchen and plug it in there.
- [ ] Try `climate.aire_chicos` with `device_code: 5140`; if the unit ignores it
      or the temperature table is wrong, find the right code (§9).
- [ ] Try both toggles: *Aire chicos - Toggle (calor 20 / off)* and
      *(frío 24 / off)*.
