// Prometheus text exposition for the Grafana "psy-sampler — Cloud save"
// dashboard and its alerts (charts/monitoring). Database figures are read on
// every scrape; request counts live in memory and restart from zero with the
// pod, which rate()/increase() absorb.

// Cumulative buckets for the workspace size distribution (the cap is 256 KB).
const SIZE_BUCKETS = [4, 16, 64, 128, 192, 256].map((kb) => kb * 1024);

/** Bytes in a Kubernetes quantity ("2Gi", "500M", "1024"), or 0 when unparsable. */
export function parseQuantity(text) {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(String(text ?? "").trim());
  if (!m) return 0;
  const unit = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Math.round(Number(m[1]) * (unit[m[2]] ?? 1));
}

export const escapeLabel = (value) => String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

/** In-memory request counter, keyed by route and status. */
export function requestCounter() {
  const counts = new Map();
  return {
    add(route, status) {
      const key = `${route}\u0000${status}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    entries: () => [...counts].map(([key, n]) => [...key.split("\u0000"), n]),
  };
}

export function renderMetrics({ stats, requests, limits, files = {}, volume = null }) {
  const out = [];
  const metric = (name, type, help, samples) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const tags = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
      out.push(`${name}${tags.length ? `{${tags.join(",")}}` : ""} ${value}`);
    }
  };
  const single = (value) => [[{}, value]];
  const perWindow = (byWindow) => Object.entries(byWindow).map(([window, n]) => [{ window }, n]);

  metric("psy_sync_users", "gauge", "Accounts (Google sign-ins) in the database.", single(stats.users));
  metric("psy_sync_users_max", "gauge", "New sign-ups stop at this many accounts.", single(limits.maxUsers));
  metric("psy_sync_users_created", "gauge", "Accounts created within the window.", perWindow(stats.usersCreated));
  metric("psy_sync_users_active", "gauge", "Accounts seen within the window (hourly resolution).", perWindow(stats.usersActive));

  metric("psy_sync_anonymous_visitors", "gauge", "Browsers that use the cloud API and never signed in there.", single(stats.anonymous));
  metric("psy_sync_anonymous_visitors_active", "gauge", "Anonymous browsers seen within the window.", perWindow(stats.anonymousActive));
  metric("psy_sync_anonymous_visitors_new", "gauge", "Anonymous browsers first seen within the window.", perWindow(stats.anonymousNew));
  metric("psy_sync_visitors_stored", "gauge", "Browser rows stored, signed in or not.", single(stats.visitors));
  metric("psy_sync_visitors_max", "gauge", "New browser rows stop at this many.", single(limits.maxVisitors));

  const total = stats.sizes.reduce((sum, n) => sum + n, 0);
  metric("psy_sync_workspaces", "gauge", "Accounts with a saved workspace.", single(stats.sizes.length));
  metric("psy_sync_workspace_bytes_total", "gauge", "Bytes of saved workspaces, all accounts.", single(total));
  metric("psy_sync_workspace_bytes_limit", "gauge", "Largest workspace the API accepts, in bytes.", single(limits.maxBytes));
  metric(
    "psy_sync_workspaces_by_size",
    "gauge",
    "Workspaces at or under `le` bytes (cumulative).",
    [...SIZE_BUCKETS.map((le) => [{ le }, stats.sizes.filter((n) => n <= le).length]), [{ le: "+Inf" }, stats.sizes.length]],
  );
  metric(
    "psy_sync_user_workspace_bytes",
    "gauge",
    "Workspace size of the largest accounts, in bytes.",
    stats.top.map(({ email, bytes }) => [{ email }, bytes]),
  );

  metric(
    "psy_sync_db_bytes",
    "gauge",
    "SQLite files on the data volume, in bytes.",
    Object.entries(files).map(([file, bytes]) => [{ file }, bytes]),
  );
  metric("psy_sync_volume_request_bytes", "gauge", "Size requested by the data PVC.", single(limits.volumeRequest));
  if (volume) {
    metric("psy_sync_volume_size_bytes", "gauge", "Filesystem holding the data volume: size.", single(volume.size));
    metric("psy_sync_volume_avail_bytes", "gauge", "Filesystem holding the data volume: available to the pod.", single(volume.avail));
  }

  metric(
    "psy_sync_http_requests_total",
    "counter",
    "API requests by route and status since the pod started.",
    requests.entries().map(([route, status, n]) => [{ route, status }, n]),
  );
  return `${out.join("\n")}\n`;
}
