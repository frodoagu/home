# Google Home automations (migrated — reference copies)

> **These three automations were migrated to Home Assistant.** They now live in
> [`charts/home-assistant/packages/climate.yaml`](../charts/home-assistant/packages/climate.yaml)
> (`aires_calor_manana`, `aires_apagar_templado`, `aires_frio_dia_caluroso`),
> with the same schedules, thresholds and guards.
>
> **Pending manual step: delete the three automations in the Google Home app.**
> Nothing in git can do it — until they're deleted, two schedulers drive the same
> ACs. The files below are kept only so the original can be diffed against the
> migrated version; once the app side is clean, this whole directory can go.

Why migrate: Google Home automations run entirely in Google's cloud, with no
API, no GitOps path, no logs and no traces — when one silently stops firing there
is nothing to inspect. In HA they're versioned, they show up in the automation
traces, and they keep working when the internet is down. The outdoor-lights
dusk automation lived here too and is now
[`packages/luces_afuera.yaml`](../charts/home-assistant/packages/luces_afuera.yaml)
(it was never mirrored into this directory).

## How this directory worked

A **manually maintained mirror** of the YAML in the Google Home app's automation
script editor (Google Home app → Automations → open one → ⋮ → **Edit in YAML**).
**Editing a file here does nothing on its own** — the contents have to be pasted
back into the app.

Device names (`Device Name - Room`) are whatever the entity's Home Assistant
name + the room it's assigned to in the Google Home app resolve to — the
`automations/starters-conditions-and-actions` page at
<https://developers.home.google.com/automations> documents the schema, and the
app's YAML editor validates real device/field names on save (it lists the
valid options in its error messages if you get a name wrong).

## Files

| File | Migrated to |
| --- | --- |
| [`automations/morning-heat-kitchen-living.yaml`](automations/morning-heat-kitchen-living.yaml) — heats kitchen + living on a schedule, gated on presence and living ≤ 17 °C | `aires_calor_manana` |
| [`automations/turn-off-acs-mild-weather.yaml`](automations/turn-off-acs-mild-weather.yaml) — turns all ACs off once it's 19 °C outside, only while heating | `aires_apagar_templado` |
| [`automations/cool-down-hot-weather.yaml`](automations/cool-down-hot-weather.yaml) — all ACs to cool 24 °C when it's over 30 °C out and over 24 °C in, gated on presence | `aires_frio_dia_caluroso` |

The name translation (Google device name → HA `entity_id`) is written out in the
comment above the `automation:` block in `climate.yaml`.
