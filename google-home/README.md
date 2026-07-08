# Google Home automations (reference copies)

This directory is a **manually maintained mirror** of the YAML scripts configured
in the Google Home app's automation script editor (Google Home app → Automations
→ open one → ⋮ → **Edit in YAML**).

Google Home automations live entirely in Google's cloud — there's no API/GitOps
path to deploy them, unlike the rest of this repo. These files exist only so
changes are tracked in git and can be diffed/copy-pasted back into the app by
hand. **Editing a file here does nothing on its own** — paste its contents into
the corresponding automation's YAML editor in the Google Home app to apply it,
and update the file here when you change something in the app.

Device names (`Device Name - Room`) are whatever the entity's Home Assistant
name + the room it's assigned to in the Google Home app resolve to — the
`automations/starters-conditions-and-actions` page at
https://developers.home.google.com/automations documents the schema, and the
app's YAML editor validates real device/field names on save (it lists the
valid options in its error messages if you get a name wrong).

## Files

- [`automations/morning-heat-kitchen-living.yaml`](automations/morning-heat-kitchen-living.yaml) —
  turns on + heats the kitchen and living room ACs on a schedule, gated on
  presence and on the living room being 17C or colder.
- [`automations/turn-off-acs-mild-weather.yaml`](automations/turn-off-acs-mild-weather.yaml) —
  turns off all ACs once the outside temperature (`sensor.temperatura_exterior`,
  see [`charts/home-assistant/packages/weather.yaml`](../charts/home-assistant/packages/weather.yaml))
  reaches the heating setpoint, gated on the ACs actually being in heat mode so
  it never fires in summer.
- [`automations/cool-down-hot-weather.yaml`](automations/cool-down-hot-weather.yaml) —
  starts all ACs in cool mode at 24C when it's over 30C outside and the living
  room is already over 24C inside, gated on presence.
