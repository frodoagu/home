# Kids' room AC: SMLIGHT SLWF-01pro (ESPHome + Midea)

The fourth split in the house, a **Philco iView 3800 W**, is controlled over Wi-Fi
with a **SMLIGHT SLWF-01pro** module plugged into the indoor unit, instead of by
infrared like the other three.

Firmware: [`esphome/aire-chicos.yaml`](../esphome/aire-chicos.yaml).
Scenes: [`packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml).

---

## 1. How it differs from the other three

| | Living / bedroom / kitchen | Kids' room |
|---|---|---|
| Path | SmartIR + Broadlink blaster | SLWF-01pro inside the unit |
| Transport | IR, **one-way** | UART on the unit's own bus, **two-way** |
| State in HA | The one HA **assumes** it sent | The one the unit **reports** |
| Physical remote | HA never finds out | HA finds out and updates the entity |
| Ambient temperature | Separate ATC BLE thermometer | Measured by the AC itself |
| If Wi-Fi drops | Keeps working (IR is local) | Entity goes `unavailable` |

Practical consequence: this AC's toggles can read their own state and trust it.
The other three can't — hence the "only turn off when all three are on" logic they
carry in the same package.

## 2. Architecture

```
   Philco iView 3800 W (indoor unit)
        │  4-pin USB-A-shaped port (5 V UART, NOT USB)
        ▼
   SLWF-01pro  ── ESP8266 (esp12e) + level shifter to 5 V
        │  ESPHome firmware, `midea` component @ 9600 8N1 (GPIO1/GPIO3)
        ▼  Wi-Fi — native ESPHome API, port 6053
   Home Assistant (k3s, hostNetwork)
        └── climate.aire_chicos  +  outdoor temperature sensor  +  RSSI
```

The module draws power from that same port, which is live whenever the indoor
unit has mains — the AC does not have to be switched on.

## 3. ⚠️ Compatibility: verify before assuming it works

The SLWF-01pro speaks **Midea's UART protocol**, and only works on units with
Midea electronics, sold under dozens of brands (Carrier, Comfee, Electrolux,
Bosch, Beko, Kaisai, Qlima, Toshiba, Samsung, Senville…). **Philco is not on that
list.**

There is already a precedent in this house pointing the other way: the bedroom AC
is labelled *Philco* and turned out to be a **rebranded Mitsubishi Electric** — the
Philco IR code never worked and it runs on Mitsubishi's `5140` (see
[home-assistant.md](home-assistant.md#air-conditioners-smartir--broadlink)).
Philco is a licensed brand, so the OEM changes with the model and the year:
whether the iView is Midea inside is unknown until the cover comes off.

**The two checks, in order:**

1. **The connector.** Lift the indoor unit's front cover and look for a 4-pin
   USB-A female port (sometimes labelled *WiFi* or *USB*, behind a small cap). If
   it isn't there, the module has nowhere to go and there is nothing else to test.
2. **The conversation.** With the module flashed and plugged in, run `esphome logs
   esphome/aire-chicos.yaml`. If the unit answers, `autoconf` reports the detected
   capabilities and the entity shows up with real modes and fan speeds. If all you
   see are `midea` component timeouts, the connector was there but the protocol
   isn't Midea.

If either check fails, see [§8 If it doesn't work](#8-if-it-doesnt-work).

## 4. Physical install

With the AC **powered down at the breaker** (the port itself is 5 V, but the board
around it is not):

1. Lift the indoor unit's front cover.
2. Find the 4-pin USB-A female port and remove its cap if it has one.
3. Plug the SLWF-01pro in. It only fits one way.
4. Leave the module inside the enclosure, not resting on the heat exchanger and
   not blocking airflow.
5. Breaker back on.

No soldering, and nothing touching mains.

## 5. Flashing

The module ships with SMLIGHT's own firmware and a web interface for uploading
another. First load:

```bash
esphome compile esphome/aire-chicos.yaml    # prints the firmware.bin path
```

Join the AP the module brings up, open its web UI and upload that `.bin`.

From then on everything goes over OTA, with the module already on the house Wi-Fi:

```bash
esphome run esphome/aire-chicos.yaml        # uses aire_chicos_ota_password
esphome logs esphome/aire-chicos.yaml
```

The keys (`aire_chicos_api_key`, `aire_chicos_ota_password`) live in
`esphome/secrets.yaml`, which is **not** committed; the template with the names is
[`secrets.yaml.example`](../esphome/secrets.yaml.example).

Two things in the config that are not optional:

- **`logger.baud_rate: 0`** — UART0 is the unit's bus. Logging over serial feeds
  garbage into the protocol. Logs still come out over the API and the web server.
- **`uart` on GPIO1/GPIO3 at 9600 8N1** — that's what the unit speaks; there is
  nothing to configure on the AC side.

## 6. DHCP reservation

The address plan gives it **`192.168.0.12`**, in the ESPHome decade (see
[pihole.md](pihole.md)). The entry is already written in
[`charts/pihole/values.yaml`](../charts/pihole/values.yaml) but **commented out**,
because an invalid MAC in `dhcp-host` doesn't just break that line: it takes down
the whole DHCP configuration.

To activate it:

1. Get the module's MAC — ESPHome prints it (`esphome logs`, or the device's web
   server), or read it off Pi-hole's lease list.
2. Uncomment the line and paste it in:

   ```yaml
   - { mac: "xx:xx:xx:xx:xx:xx", ip: "192.168.0.12", name: "aire-chicos" }
   ```

3. Commit and push. ArgoCD syncs Pi-hole on its own.
4. **Reboot the module** so it renews the lease and picks up `.12` — otherwise it
   keeps its dynamic-pool address until that one expires.

After that it also answers as `aire-chicos.lan`.

## 7. Onboarding in Home Assistant

HA runs with `hostNetwork: true`, so it sees the device's mDNS and discovers it by
itself (Settings → Devices → ESPHome, "Discovered").

1. Accept the discovery (or add it manually as `aire-chicos.lan`, port 6053).
2. Paste the **encryption key**: it's `aire_chicos_api_key` from
   `esphome/secrets.yaml`.
3. You get `climate.aire_chicos`, plus `sensor.aire_chicos_temperatura_exterior`
   and the RSSI as a diagnostic.

The entity is named that way because the YAML's `climate` carries `name: ""` and
inherits the device's `friendly_name`. Renaming the device means re-flashing and
re-discovering, and leaves the references in `climate.yaml` dangling.

`climate` is in `googleAssistant.exposedDomains`, so the AC shows up in Google
Home with nothing else to do.

## 8. If it doesn't work

**The unit never answers (`midea` component timeouts).** It isn't Midea inside.
The path known to work in this house is the one the other three use: SmartIR plus
a fourth Broadlink RM4 mini (the next free address in its decade is
`192.168.0.33`), finding the `device_code` by comparing the IR waveform rather
than trusting the brand — the method is in
[home-assistant.md](home-assistant.md#air-conditioners-smartir--broadlink). In
that case this firmware and the `.12` reservation go unused.

**It answers, but modes the physical remote has are missing in HA.** Capability
detection came up short: set `autoconf: false` and list `supported_modes`,
`custom_fan_modes`, `supported_presets` and `supported_swing_modes` by hand.

**The entity goes `unavailable` now and then.** The ESP8266 is short on RAM and
`web_server` is the most expensive thing running. Drop it from the YAML before
blaming the Wi-Fi.

**The unit beeps on every command.** `beeper: false` is set precisely to avoid
that; if it still beeps, the unit ignores the flag.

## 9. Checklist for the day it arrives

- [ ] Breaker off, cover up, look for the 4-pin USB-A port (§3.1).
- [ ] Plug the module in, close up, breaker back on.
- [ ] `esphome compile` and upload the `.bin` through the module's web UI (§5).
- [ ] Point it at the house Wi-Fi from its captive portal.
- [ ] `esphome logs` → confirm the unit answers and `autoconf` detects it (§3.2).
- [ ] Note the MAC, uncomment the reservation in `values.yaml`, commit, reboot the
      module (§6).
- [ ] Accept the discovery in HA and paste the encryption key (§7).
- [ ] Try both toggles: *Aire chicos - Toggle (calor 20 / off)* and
      *(frío 24 / off)*.
