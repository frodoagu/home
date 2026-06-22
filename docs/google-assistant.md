# Google Assistant / Google Home integration

This uses Home Assistant's **manual `google_assistant`** integration (a custom
"Actions on Google" smart-home Action linked to your own Google account), not
Nabu Casa. It requires HA to be reachable over public HTTPS — which it is, at
`https://home.agu.com.ar`.

Current deployment:

| Thing | Value |
|---|---|
| Actions on Google / GCP project | `growserver` |
| HomeGraph service account | `ha-homegraph@growserver.iam.gserviceaccount.com` |
| Kubernetes secret | `ha-google-sa` (namespace `home-assistant`, key `service_account.json`) |
| Fulfillment URL | `https://home.agu.com.ar/api/google_assistant` |

## What can and can't be automated

- **Automatable via `gcloud`:** enabling the HomeGraph API, creating the service
  account + key, and creating the Kubernetes secret. (Done — steps recorded
  below for reproducibility.)
- **Web console only (no CLI/API):** the *Actions on Google* project config —
  fulfillment URL and OAuth **account linking** — and the final account link in
  the **Google Home** mobile app. These need an interactive Google login.

## 1. Google Cloud side (gcloud)

Run as your personal Google account, against the `growserver` project:

```bash
gcloud services enable homegraph.googleapis.com --project growserver

gcloud iam service-accounts create ha-homegraph \
  --project growserver --display-name "Home Assistant HomeGraph"

gcloud iam service-accounts keys create /tmp/ha-homegraph-key.json \
  --iam-account ha-homegraph@growserver.iam.gserviceaccount.com \
  --project growserver
```

The service account needs **no project IAM role** — HA authenticates to the
HomeGraph API as the service account using this key. The key is only used for
`report_state` (proactive state push) and `request_sync`.

## 2. Kubernetes secret

Store the key as a Secret (out-of-band — never in git), then shred the local
copy:

```bash
kubectl create secret generic ha-google-sa -n home-assistant \
  --from-file=service_account.json=/tmp/ha-homegraph-key.json
shred -u /tmp/ha-homegraph-key.json
```

## 3. Chart values

In [charts/home-assistant/values.yaml](../charts/home-assistant/values.yaml):

```yaml
googleAssistant:
  enabled: true
  projectId: "growserver"
  reportState: true
  exposeByDefault: true
  exposedDomains: [light, switch, fan, cover, climate, scene, script, media_player, vacuum, lock]
  secureDevicesPin: ""        # set to require a spoken PIN for locks/garage/etc.
  serviceAccount:
    secretName: "ha-google-sa"
    secretKey: "service_account.json"
```

On sync the init container writes a `google_assistant:` block into
`configuration.yaml` with `service_account: !include google_assistant_sa.json`,
and the chart mounts the secret at `/config/google_assistant_sa.json`.

> **Running without the service account:** leave `serviceAccount.secretName: ""`.
> The chart then omits the secret volume, drops `service_account` from the config,
> and forces `report_state: false`. Account linking and device control still work;
> you just lose proactive state updates and `request_sync`. Steps 1–2 are then
> unnecessary.

> **Changing exposure later:** the `google_assistant:` block is written once. To
> change `exposedDomains`/PIN afterwards, edit the block in
> `/config/configuration.yaml` (or delete it and restart the pod). Per-entity
> exposure is also adjustable in the HA UI once linked.

## 4. Actions on Google console (manual)

At <https://console.actions.google.com>, in the `growserver` project:

1. **Action type:** Smart Home.
2. **Fulfillment URL** (Develop → ...): `https://home.agu.com.ar/api/google_assistant`
3. **Account linking** (Develop → Account linking):
   - Linking type: **OAuth** → **Authorization Code**
   - **Client ID:** `https://oauth-redirect.googleusercontent.com/r/growserver`
   - **Client Secret:** any non-empty string (HA does not validate it)
   - **Authorization URL:** `https://home.agu.com.ar/auth/authorize`
   - **Token URL:** `https://home.agu.com.ar/auth/token`
   - **Scopes:** `email`, `name`

## 5. Verify the HA side

```bash
pod=$(kubectl get pod -n home-assistant -l app.kubernetes.io/name=home-assistant -o jsonpath='{.items[0].metadata.name}')

# Block present + SA file mounted
kubectl exec -n home-assistant "$pod" -- sh -c 'grep -A12 "^google_assistant:" /config/configuration.yaml; ls -l /config/google_assistant_sa.json'

# Endpoint is live (these codes are EXPECTED — they mean it loaded):
curl -sk -o /dev/null -w "GET  -> %{http_code}\n" https://home.agu.com.ar/api/google_assistant   # 405 (POST-only)
curl -sk -o /dev/null -w "POST -> %{http_code}\n" -X POST https://home.agu.com.ar/api/google_assistant  # 401 (needs Google OAuth)
```

A `404` would mean the integration did not load; `405`/`401` confirm it is
serving. Also check `kubectl logs` has no `google_assistant` errors.

## 6. Link in the Google Home app (mobile)

Google Home app → **+** → **Set up a device** → **Works with Google** → find your
Action listed as **`[test] <your Action display name>`** → sign in with your HA
account and authorize. Your exposed devices then appear in Google Home.

The Action stays in **test mode** — that's fine for personal use; no public
review/publishing is needed as long as you link with the same Google account that
owns the project.

## Troubleshooting

- **Action not shown in Google Home app:** confirm you're signed into the app
  with the same Google account that owns the `growserver` project, and that the
  Action is in test mode.
- **`POST` returns 404:** the integration didn't load — check the
  `google_assistant:` block and `kubectl logs` for a config error.
- **Linking fails at the HA login step:** check the Authorization/Token URLs and
  that `externalUrl`/`trusted_proxies` are correct (see
  [home-assistant.md](home-assistant.md)).
- **"Couldn't update the setting" / no proactive updates:** verify `ha-google-sa`
  exists and `report_state: true` resolved (needs the service account).
- **Re-sync devices:** ask "Hey Google, sync my devices", or trigger
  `request_sync` from HA.
