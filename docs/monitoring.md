# Monitoring

Observability for the cluster and the Raspberry Pi, deployed by
[charts/monitoring](../charts/monitoring) (ArgoCD app `monitoring`, namespace
`monitoring`). It wraps the **VictoriaMetrics k8s-stack** (a lighter,
SD-card-friendly alternative to kube-prometheus-stack) plus a **blackbox
exporter** for external uptime/TLS probing.

Grafana: **https://grafana.agu.com.ar** (Google sign-in via the same
`google-auth` ForwardAuth as the other private services; only the all-listed
email gets in). It opens on the *Raspberry Pi — Health* dashboard.

Alertmanager: **https://alertmanager.agu.com.ar** (same google-auth gate) —
active alerts and silences. Its `externalURL` is set to that host so the links
it generates resolve.

## Components

| Piece | Role |
|---|---|
| **vmsingle** | metrics database (single node). 15-day retention, ~1Gi RAM limit |
| **vmagent** | scraper (k8s service discovery), 60s interval |
| **vmalert** | evaluates the alerting rules |
| **Alertmanager** | routes firing alerts → **Telegram** |
| **Grafana** | dashboards (ephemeral; provisioned every start) |
| **node-exporter** | host CPU/RAM/disk/network/temperature |
| **kube-state-metrics** | pod/deployment/workload state |
| **rpi-throttle-exporter** | Raspberry Pi throttling/under-voltage via `vcgencmd` (textfile collector) |
| **blackbox-exporter** | external HTTP/TLS probes of the public hostnames |
| **pihole-exporter** | Pi-hole stats from its v6 REST API ([eko/pihole-exporter](https://github.com/eko/pihole-exporter)) |
| **VM operator** | reconciles the `VM*` CRDs (VMSingle, VMAgent, VMRule, VMProbe, VMPodScrape, …) |

Tuned small for the Pi and biased toward **few SD-card writes** (long scrape
interval, short retention, ephemeral Grafana). The Pi has 8 GB RAM, so the
memory *limits* are generous — the earlier values were too tight and caused
OOMKills.

Grafana idles around 330Mi, so its limit is 768Mi. At 512Mi, opening a few
dashboards in a row OOMKilled it. The chart's `GOMEMLIMIT` (90% of the limit)
doesn't prevent that: it bounds only Grafana's Go heap, and the
`victoriametrics-logs-datasource` plugin runs as a separate process in the same
container.

**Logs** live in a separate app, [VictoriaLogs](../charts/victoria-logs) (single
node + a bundled Vector collector). This chart provisions the VictoriaLogs
**Grafana datasource** (`victoria-metrics-k8s-stack.defaultDatasources.extra` →
`http://victoria-logs.victoria-logs.svc.cluster.local:9428`) and installs the
signed `victoriametrics-logs-datasource` plugin (`grafana.plugins`), so logs are
queryable from Grafana Explore (LogsQL) alongside metrics. The VictoriaLogs UI
(vmui) is also exposed at `logs.agu.com.ar` behind google-auth.

## Dashboards

All custom dashboards live as JSON under
[charts/monitoring/dashboards/](../charts/monitoring/dashboards); the
`monitoring-dashboards` ConfigMap globs them in and the Grafana sidecar imports
any ConfigMap labelled `grafana_dashboard: "1"`. The chart's bundled
VM/Kubernetes dashboards are **disabled** (`defaultDashboards.enabled: false`) to
keep Grafana focused on these:

| Dashboard | uid | What |
|---|---|---|
| Raspberry Pi — Health | `rpi-health` | temp, fan RPM/PWM/cooler level, throttle/under-voltage timeline, per-core CPU + load, RAM/swap, disk usage + SD I/O, network, uptime |
| Kubernetes — Cluster | `k8s-cluster` | pod phases, restarts, CrashLoops, CPU/RAM by namespace, PVC usage, deployment health |
| Workloads — Per-service | `workloads` | per-namespace drilldown: CPU/RAM/network/restarts per pod (+ pod table) |
| Traefik — Ingress | `traefik-ingress` | request rate, status codes, p50/p95/p99 latency, 5xx, open connections |
| Blackbox — Uptime & SLA | `blackbox-sla` | per-endpoint status, uptime %, up/down history, latency, TLS days-to-expiry |
| Pi-hole — DNS | `pihole` | blocking status, queries/blocked/% (24h), cached vs forwarded, query and reply types, top domains/ads, upstreams, active clients. Community dashboard [10176](https://grafana.com/grafana/dashboards/10176-pi-hole-exporter/), adapted (see *Pi-hole metrics*) |
| psy-sampler — Cloud save | `psy-sync` | accounts (total, vs cap, new/active per window), anonymous browsers, visitor countries (map, top list, over time; from VictoriaLogs), disk per account and size distribution, SQLite vs PVC, API traffic by route/status (see *psy-sampler cloud save*) |

To add one: drop a `*.json` in `dashboards/` (give it a unique `uid`, and include
the `home` tag — see *Playlist* below) and commit — no template changes needed.
Each dashboard carries a `DS_PROM` datasource variable so it binds to the
provisioned VictoriaMetrics datasource automatically. To change the landing
dashboard, set `grafana."grafana.ini".dashboards.default_home_dashboard_path` in
`values.yaml` (path is `/var/lib/grafana/dashboards/default/<file>.json`).

## Playlist (rotate through all dashboards)

Grafana has an **All dashboards** playlist that cycles through every dashboard on
a 1-minute interval — handy for a wall display. It's defined **by tag**: each
dashboard above carries a shared `home` tag and the playlist is a
`dashboard_by_tag: home` item, so any new tagged dashboard joins automatically.

Playlists aren't file-provisionable like dashboards/datasources, and Grafana here
is **ephemeral** (no PVC → its SQLite DB is wiped on every restart). So a
`playlist-provisioner` **sidecar** in the Grafana pod
(`grafana.extraContainers` in [values.yaml](../charts/monitoring/values.yaml))
re-creates the playlist via the Grafana HTTP API on each start: it waits for
`/api/health`, deletes any stale copy, then POSTs `/api/playlists`. It
authenticates by sending the operator's `X-Auth-Request-Email` (the same header
the `google-auth` ForwardAuth injects), which Grafana's `auth.proxy` trusts and
auto-assigns Admin — no password or secret needed.

Start it from the UI (*Dashboards → Playlists → All dashboards → ▶*) or directly
at `https://grafana.agu.com.ar/playlists/play/<uid>`.

## Alerts → Telegram

Rules in [templates/vmrules.yaml](../charts/monitoring/templates/vmrules.yaml)
(plus the chart's `defaultRules`) cover: RPi temperature (70 °C warn / 80 °C
crit), under-voltage/throttling, disk/memory pressure, node-exporter down, pod
issues, blackbox probe down, and TLS cert expiry (<14d / <3d). They fire through
Alertmanager to a Telegram bot.

Setup:
1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) → bot token.
2. **Send your bot a message** (e.g. `/start`). A bot cannot initiate a chat, so
   without this Alertmanager fails with `telegram: chat not found (400)`.
3. Get your numeric chat id ([@userinfobot](https://t.me/userinfobot)).
4. Create the secret (token only — never in git) and set the chat id in values:

```bash
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoring create secret generic alertmanager-telegram \
  --from-literal=bot-token='<token-from-BotFather>'
# then set chat_id in charts/monitoring/values.yaml:
#   victoria-metrics-k8s-stack.alertmanager.config.receivers[].telegram_configs[0].chat_id
```

The token is mounted into Alertmanager via `bot_token_file`
(`/etc/vm/secrets/alertmanager-telegram/bot-token`); the chat id is not sensitive
and lives in git.

Send a manual test alert (routes through the real Telegram path):

```bash
AM=vmalertmanager-monitoring-victoria-metrics-k8s-stack-0
kubectl -n monitoring port-forward "pod/$AM" 9093:9093 &
curl -s localhost:9093/api/v2/alerts -XPOST -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"TelegramTest","severity":"warning"},
       "annotations":{"summary":"test"}}]'
```

## Blackbox probing

Probes run from inside the cluster against the **public** hostnames, so they also
exercise Traefik + Let's Encrypt end-to-end. Targets are split in
`values.yaml` `blackboxTargets`:

- **public** → `http_2xx` module, expects a 2xx.
- **authGated** (e.g. `grafana.agu.com.ar`) → `http_auth` module, which also
  accepts `301/302/401/403`. These sit behind `google-auth`, so an
  unauthenticated probe gets a 401/redirect — for uptime that still means "the
  stack is serving", and TLS is still validated. (Probing them with the strict
  `http_2xx` module would show a permanent false **DOWN**.)

## Traefik metrics

The k3s-bundled Traefik already exposes Prometheus metrics on its `metrics`
container port (9100) — it's just not published on the Service. So
[templates/vmpodscrape-traefik.yaml](../charts/monitoring/templates/vmpodscrape-traefik.yaml)
scrapes the **pod** directly with a `VMPodScrape` (entrypoint/service/cert
metrics). No change to `charts/traefik-config` or the ingress is needed.

## Pi-hole metrics

Pi-hole has no Prometheus endpoint, so
[templates/pihole-exporter.yaml](../charts/monitoring/templates/pihole-exporter.yaml)
runs [eko/pihole-exporter](https://github.com/eko/pihole-exporter) (`piholeExporter`
in `values.yaml`) plus a `VMPodScrape`. On every scrape it reads Pi-hole's v6 REST
API (`/api/stats/*`, `/api/dns/blocking`) through the in-cluster Service
`pihole.pihole.svc.cluster.local:8080`. It can't use `pihole.agu.com.ar`: that route
sits behind google-auth, so the exporter would only get a sign-in redirect.

- **Its own Deployment, not a sidecar.** Pi-hole runs `hostNetwork`, so a sidecar's
  `:9617` would listen on the node and expose top domains and client names to the
  whole LAN.
- **No password needed** while charts/pihole keeps `admin.disablePassword: true`.
  FTL answers the exporter's `POST /api/auth` with `valid: true`, no sid and
  `validity: -1`, so no session slot is used. If the Pi-hole password is ever
  turned on, create the same password as a Secret in **this** namespace and set
  `piholeExporter.passwordSecret.name` (see [pihole.md](pihole.md#admin-password-optional)).
- **The dashboard** is grafana.com
  [10176](https://grafana.com/grafana/dashboards/10176-pi-hole-exporter/)
  (`grafana/dashboard.json` from the exporter's v1.2.0 tag), adapted to this repo:
  `DS_PROM` datasource variable, uid `pihole`, `home` tag, `1m` refresh and a 24h
  default range. It also fixes upstream bugs: four queries ignored the
  `$node` variable, and the *DNS Query types* and *Forward destinations* panels
  showed query counts with a `percent` unit.

Limitations (in the exporter, not fixable here):

- **A dead Pi-hole looks alive.** When the API is unreachable the exporter logs a
  warning and keeps serving the **last** values with a 200 (reproduced against a
  mock). `up` stays 1 and `pihole_status` stays 1, so don't build a "Pi-hole down"
  alert on these series.
- **`top_*` series go stale.** These gauges are never reset, so a domain or client
  that drops out of the top 10 keeps its last count until the exporter restarts.
- **"today" means the last 24h.** `*_today` comes from FTL's in-memory window
  (`/api/stats/summary`), not from the calendar day.

## psy-sampler cloud save

[`images/psy-sync`](../images/psy-sync) serves `/metrics` on its own port
(`9787`), which neither the Service nor the IngressRoute exposes; a
`VMPodScrape` in [`charts/psy-sampler`](../charts/psy-sampler)
(`sync.metrics.enabled`) scrapes it as `job="psy-sampler/psy-sampler-sync"`.
Database figures are queried from SQLite on every scrape, so they are exact
after a restart; only `psy_sync_http_requests_total` lives in memory.

| Metric | What |
|---|---|
| `psy_sync_users`, `psy_sync_users_max` | accounts, and the sign-up cap (`sync.maxUsers`) |
| `psy_sync_users_created{window}`, `psy_sync_users_active{window}` | accounts created / seen in the last `1d`, `7d`, `30d` |
| `psy_sync_anonymous_visitors`, `…_active{window}`, `…_new{window}` | browsers that never signed in (see below) |
| `psy_sync_visitors_stored`, `psy_sync_visitors_max` | browser rows, and their cap (100 000) |
| `psy_sync_user_workspace_bytes{email}` | workspace size of the `sync.metrics.topUsers` (20) largest accounts |
| `psy_sync_workspaces`, `psy_sync_workspace_bytes_total`, `psy_sync_workspaces_by_size{le}` | saved workspaces, their total size, and a cumulative size distribution |
| `psy_sync_workspace_bytes_limit` | largest workspace the API accepts (256 KB) |
| `psy_sync_db_bytes{file="db\|wal"}`, `psy_sync_volume_request_bytes` | SQLite files on the PVC, and the PVC request (`sync.persistence.size`) |
| `psy_sync_volume_size_bytes`, `psy_sync_volume_avail_bytes` | `statfs` of the data volume: with local-path, the SD card |
| `psy_sync_samples`, `psy_sync_sample_bytes_total` | uploaded audio samples, and their total size |
| `psy_sync_sample_bytes_limit`, `psy_sync_sample_quota_bytes` | the shared cap on all samples (`sync.samples.total`) and the per-account quota (`sync.samples.quota`) |
| `psy_sync_user_sample_bytes{email}` | sample bytes of the `sync.metrics.topUsers` accounts storing the most |
| `psy_sync_http_requests_total{route,status}` | API requests; unknown paths fold into `route="other"`, every sample id into one `…/api/samples/:id` route per method |

- **Anonymous visitors.** The page keeps a random id in localStorage
  (`psy-sampler:visitor`) and sends it as `X-Psy-Visitor` on the session check
  that every page load makes. psy-sync stores one row per id; a signed-in check
  links the row to the account, and deleting the account unlinks it. Anonymous =
  rows with no account. It counts browsers that ran the page with the API up,
  not people: a user on two browsers who signed in on one counts once as an
  account and once as anonymous. Ids are client-made, so the number can be
  inflated by a script (bounded by the `/api/` rate limit and the 100 000-row
  cap); anonymous rows unseen for 90 days are pruned.
- **Active** is `seen_at`, written at most once an hour per account or browser,
  so the session check on every page load doesn't turn into an SD write.
- **Disk per account** is the byte length of the stored JSON. The SQLite files
  are larger (pages, indexes, WAL, the visitor table). local-path does not
  enforce the PVC size, so the database can outgrow its 2 Gi into the SD card's
  free space. That is why `PsySyncDataVolumeHigh` compares against the request.
- **Emails are labels** on `psy_sync_user_workspace_bytes` and `psy_sync_user_sample_bytes`, so they land in
  VictoriaMetrics. Grafana is behind google-auth, and only the top N accounts
  are exported.

- **Countries** don't come from psy-sync: the dashboard's 🌍 row queries
  Traefik's access log in VictoriaLogs (`log.RequestHost:="psy.agu.com.ar"`),
  counting distinct `log.request_Cf-Connecting-Ip` per `log.client_country`
  (see *GeoIP* below). It follows the time picker but logs only keep 7 days, and
  it counts every client, crawlers and link previews included.

Alerts (group `psy-sampler.sync` in `templates/vmrules.yaml`):

| Alert | Fires when |
|---|---|
| `PsySyncDown` / `PsySyncNotScraped` | scrape failing for 5m / no target for 15m |
| `PsySyncServerErrors` | any 500 in 15m |
| `PsySyncSignInFailures` | > 20 rejected Google tokens in 1h (forgery, or a client-id/clock problem locking everyone out) |
| `PsySyncUsersNearCap` / `PsySyncSignupsClosed` | accounts > 80% of `sync.maxUsers` for 1h / at the cap (critical) |
| `PsySyncSignupBurst` | > 25 new accounts in 1h |
| `PsySyncAnonymousBurst` / `PsySyncVisitorsCapReached` | > 500 new browser rows in 1h / visitor table full (anonymous counts frozen) |
| `PsySyncWorkspaceNearLimit` | an account's workspace > 90% of 256 KB for 1h (its saves are about to get 413) |
| `PsySyncDataVolumeHigh` | SQLite files > 80% of the PVC request for 30m |
| `PsySyncSamplesNearCap` | all samples together > 80% of `sync.samples.total` for 1h (uploads are about to get 507) |

## GeoIP

Vector (the log shipper in [`charts/victoria-logs`](../charts/victoria-logs))
looks up every log line that carries Traefik's `request_Cf-Connecting-Ip` and
adds `log.client_country` (ISO code) and `log.client_country_name`, so any
host's visitors can be grouped by country in LogsQL:

```
log.RequestHost:="psy.agu.com.ar" | stats by (log.client_country) count_uniq("log.request_Cf-Connecting-Ip")
```

- The database is DB-IP's free **IP-to-Country Lite** (`mmdb`, CC BY 4.0,
  attribution in the panel descriptions), read by Vector's `mmdb` enrichment
  table. An init container (`geoip`, `curlimages/curl`) downloads the current
  month's file (falling back to last month's) on every Vector pod start into
  the node's `/var/lib/vector/geoip/country.mmdb`. It is never refreshed
  between restarts; `kubectl -n victoria-logs rollout restart ds` picks up a
  new month.
- If the download fails, the cached copy stays. With **no** cached copy (a
  fresh node offline) the init container fails and retries: Vector can't start
  without the file, so log shipping waits for the first successful download.
- Only lines with a public IP get a country: LAN and cluster addresses, and logs
  without the header, are left as they were. Lines ingested before the change
  have no country.

## Operating notes

- **Don't force a sync with prune on a transient OutOfSync.** The VM operator +
  ServerSideApply often show benign `OutOfSync`; a forced prune-sync can trigger
  the chart's pre-delete hooks and cascade-delete the whole app (the Application
  picks up a `deletionTimestamp` and the `resources-finalizer` prunes children).
  Let ArgoCD reconcile on its own; if you must nudge it, use a plain refresh.
- **A permanent `OutOfSync` on the `VMRule` is the CRD's own doing.** Its
  v1beta1 schema declares `default: ""` for `record` (and for `alert`), so the
  API server stamps `record: ""` onto every alerting rule and the live object
  never matches the rendered manifest. selfHeal cannot close it — applying does
  not remove a server-side default — so [apps/monitoring.yaml](../apps/monitoring.yaml)
  drops the field with `ignoreDifferences` when it holds exactly that default,
  leaving a genuine recording rule still comparable. `ServerSideDiff=true` also
  hides it, but on this app it surfaces false diffs on the Grafana
  Secret/Deployment and the operator's validating webhook instead.
- If the app ever gets stuck deleting because the **operator is gone but `VM*`
  CRs still hold finalizers**, clear them so the cascade (and the app-of-apps
  recreation) can finish:

  ```bash
  for cr in vmsingle vmagent vmalert vmalertmanager; do
    for n in $(kubectl -n monitoring get $cr -o name); do
      kubectl -n monitoring patch $n --type=merge -p '{"metadata":{"finalizers":[]}}'
    done
  done
  ```

- Quick health check:

  ```bash
  kubectl -n monitoring get pods
  kubectl -n monitoring get vmsingle,vmagent,vmalert,vmalertmanager,vmprobe,vmpodscrape,vmrule
  ```
