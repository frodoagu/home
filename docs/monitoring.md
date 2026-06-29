# Monitoring

Observability for the cluster and the Raspberry Pi, deployed by
[charts/monitoring](../charts/monitoring) (ArgoCD app `monitoring`, namespace
`monitoring`). It wraps the **VictoriaMetrics k8s-stack** (a lighter,
SD-card-friendly alternative to kube-prometheus-stack) plus a **blackbox
exporter** for external uptime/TLS probing.

Grafana: **https://grafana.agu.com.ar** (Google sign-in via the same
`google-auth` ForwardAuth as the other private services; only the all-listed
email gets in). It opens on the *Raspberry Pi — Health* dashboard.

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
| **VM operator** | reconciles the `VM*` CRDs (VMSingle, VMAgent, VMRule, VMProbe, VMPodScrape, …) |

Tuned small for the Pi and biased toward **few SD-card writes** (long scrape
interval, short retention, ephemeral Grafana). The Pi has 8 GB RAM, so the
memory *limits* are generous — the earlier values were too tight and caused
OOMKills.

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

## Operating notes

- **Don't force a sync with prune on a transient OutOfSync.** The VM operator +
  ServerSideApply often show benign `OutOfSync`; a forced prune-sync can trigger
  the chart's pre-delete hooks and cascade-delete the whole app (the Application
  picks up a `deletionTimestamp` and the `resources-finalizer` prunes children).
  Let ArgoCD reconcile on its own; if you must nudge it, use a plain refresh.
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
