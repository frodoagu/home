# Shelly devices

LAN Shelly relays, and the declarative config the cluster reconciles onto them
([`charts/shelly-config`](../charts/shelly-config)). The devices are **not** a
Kubernetes workload — the chart only ships a reconciler that talks to them over
their local RPC.

## Inventory

| Light | `switch.*` (Home Assistant) | Input (wall switch) | IP | Model |
|---|---|---|---|---|
| Puerta Principal | `switch.afuera_interruptor_puerta_principal` | `binary_sensor.afuera_interruptor_puerta_principal_entrada_0` | 192.168.0.222 | Shelly 1 Mini Gen4 |
| Puerta Escalera | `switch.afuera_interruptor_puerta_escalera` | `binary_sensor.afuera_interruptor_puerta_escalera_entrada_0` | 192.168.0.215 | Shelly 1 Mini Gen4 |

IPs are DHCP reservations in [`charts/pihole`](../charts/pihole). Both devices are
also commissioned into a Matter fabric (Google Home) and picked up by Home
Assistant's Shelly integration.

## Outdoor lights — wall switches ganged, app independent

The behaviour is **deliberately asymmetric**:

- **App / Google Home / Home Assistant**: each light is a plain, independent
  `switch`. Turning on just one is a normal thing to do.
- **Either wall switch**: drives **both** lights, as an idempotent toggle — if
  either light is off, a flip turns **both on**; only with both already on does a
  flip turn them off. A mixed state left by the app is first normalised to "both
  on", and the next flip turns them off.

It is implemented **on the devices**, in
[`charts/shelly-config/scripts/luces-afuera.js`](../charts/shelly-config/scripts/luces-afuera.js):

1. Both relays run with `in_mode: "detached"`, so a wall switch does **not** drive
   its own relay — it is reduced to a pure input signal.
2. The script reacts to that input, reads the peer's relay over RPC, and sets
   both. The same file goes to both devices unedited: each matches its own MAC
   against `DEVICES` and derives who the peer is.
3. `initial_state: "restore_last"` brings both back to their last (in-sync) state
   after a power cut, rather than to each wall switch's position — which means
   nothing once the input is detached.

**Why on the devices and not in Home Assistant.** An HA automation on the same
inputs works, but it dies with HA: `detached` leaves the relay with no local path,
so every HA restart — including the pod roll that *any* change to a HA package
triggers — leaves the wall switches dead. On the device it keeps working with HA
down, and it is faster (no round trip). HA and Google Home still see two ordinary
switches and drive them independently.

**Degraded mode.** If the peer does not answer (powered off, rebooting, no
network) the script falls back to toggling its own light. Worst case equals a
plain wall switch, never a dead one.

## Gotchas (hard-won — don't re-investigate)

- **Exactly ONE controller may act on the input.** This bit us: an HA automation
  and the device script were both reacting to the same wall switch, each doing
  the toggle. The symptom was maddeningly intermittent — sometimes right,
  sometimes the lights blinked off and came straight back on — because the
  outcome depended on which controller won the race and whether the other one
  read the relays before or after the first had written them. There is no
  debounce that fixes two controllers; delete one. If you ever want the logic in
  HA instead, remove the script (or `enable: false` it) in the same change.
- **Scripts must be pure ASCII.** The device mangles multi-byte UTF-8 on upload:
  accents in *comments* are enough to corrupt the source, and it then fails at
  runtime with a `ReferenceError` pointing at an innocent line several functions
  away. `reconcile.py` refuses to upload non-ASCII rather than let that happen.
- **Never trust `Script.PutCode`.** It takes the code in chunks; slice by BYTES,
  and always read the code back with `Script.GetCode` and compare. A silently
  truncated upload looks like a device that "runs" a broken script.
- **One actuation = one `toggle` event.** Measured on this hardware with an
  instrumented build. If you see behaviour that looks like a double event,
  suspect a second controller (see above) before adding a debounce.
- **`enable` vs `running` are different things.** `enable` is autostart-on-boot,
  `running` is the live state. A device that reboots with `enable: false` comes up
  silent; the reconciler pins both.
- **Pods reach the devices directly.** No host networking needed for the
  reconciler — a normal pod routes to `192.168.0.0/24` fine.

## How the config gets there (`charts/shelly-config`)

[`files/reconcile.py`](../charts/shelly-config/files/reconcile.py) reads the live
device config, compares it against `values.yaml`, and writes **only on drift**. A
clean run prints `in sync` and touches nothing. Per device it enforces the
declared `Switch.SetConfig` keys, then makes sure each declared script is
uploaded (verified by readback), enabled and running.

It runs two ways:

- **PostSync hook Job** — applies a git change immediately, right after ArgoCD
  updates the ConfigMaps.
- **CronJob** (default every 30 min) — self-heal, so a factory reset or a setting
  changed by hand in the Shelly app comes back on its own, in the same spirit as
  ArgoCD's `selfHeal`.

```bash
# what the last sync did
kubectl -n shelly-config logs job/shelly-config-sync

# force a reconcile now
kubectl -n shelly-config create job --from=cronjob/shelly-config shelly-reconcile-manual
kubectl -n shelly-config logs job/shelly-reconcile-manual

# what a device actually has
curl 'http://192.168.0.215/rpc/Switch.GetConfig?id=0'
curl 'http://192.168.0.215/rpc/Script.List'
```

Adding a device or a script is a `values.yaml` edit (plus the `.js` under
`scripts/`); nothing else. A failed run exits non-zero so the Job shows `Failed`
rather than burying it in logs.

**To undo the gang entirely:** drop the device from `devices:` in `values.yaml`
(the reconciler stops managing it — it does not clean up), then set
`in_mode: "follow"` on each device so each wall switch drives its own light again,
and delete the script:

```bash
CFG='%7B%22id%22%3A0%2C%22in_mode%22%3A%22follow%22%7D'
curl "http://192.168.0.215/rpc/Switch.SetConfig?id=0&config=$CFG"
curl 'http://192.168.0.215/rpc/Script.Delete?id=1'
```

## Reaching the devices from outside (`charts/shelly-proxy`)

`charts/shelly-config` only reconciles config *onto* the devices — it does not
expose them. External access lives in a separate app,
[`charts/shelly-proxy`](../charts/shelly-proxy), at **`https://shelly.agu.com.ar`**,
gated by the `google-auth` ForwardAuth (Google sign-in, oauth2-proxy allowlist),
and its hostname is in `charts/cloudflare-ddns`. It's linked from the site's
private section (`images/home-site`) and the homepage dash.

An nginx pod does two things on that host:

- serves a small self-hosted **control panel** at `/` (on/off + status per light);
- reverse-proxies **one PathPrefix per device** — `/escalera/…` → `192.168.0.215`,
  `/principal/…` → `192.168.0.222` — so `/<path>/rpc/<Method>` hits the device's
  `/rpc/<Method>`.

**Why a custom panel and not the device's own web UI:** the Shelly Gen4 admin UI
drives the device over a *hardcoded* `ws://…/rpc` WebSocket (`"ws://"+location.host`,
no `wss://` fallback). Served over HTTPS the browser blocks that socket as mixed
content, so the native UI loads but is dead — no state, no toggles. The plain HTTP
RPC (`GET /rpc/Switch.GetStatus`, `Switch.Set`) works fine through the proxy, so the
panel speaks *that* from the **same origin** — no CORS, no mixed content, and the
google-auth cookie applies for free.

These devices have their own auth disabled (`auth_en:false`), so google-auth on
`shelly.agu.com.ar` is the **only** gate in front of them from the outside. Adding
a device is a `devices:` edit in
[`charts/shelly-proxy/values.yaml`](../charts/shelly-proxy/values.yaml) (path +
label + host); the panel and the nginx routes are generated from it. The panel
only ever sends explicit, user-initiated `Switch.Set` calls, so it does not create
a second competing controller (see the "exactly one controller" note above).

```bash
# hit a device's RPC through the proxy (after signing in)
curl 'https://shelly.agu.com.ar/escalera/rpc/Switch.GetStatus?id=0'
```
