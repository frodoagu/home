# Cloudflare-only origin firewall (`charts/origin-firewall`)

Blocks direct hits to the Pi's public IP: inbound `tcp/80` and `tcp/443` are
accepted only from **Cloudflare's edge ranges** and the **local LAN/cluster**,
and dropped for everyone else. All `*.agu.com.ar` services are Cloudflare-proxied
(`charts/cloudflare-ddns`, `proxied: true`), so legitimate internet traffic only
ever comes from Cloudflare; anything hitting the raw IP is bypassing Cloudflare
(and any per-service auth/rate-limit that trusts CF-supplied headers).

Deployed like everything else in this repo — an ArgoCD `Application`
(`apps/origin-firewall.yaml`) syncing a chart. No manual SSH steps.

## How it works

A privileged, `hostNetwork` **DaemonSet** in `kube-system` runs on every node. It
uses a **prebuilt image** (`images/origin-firewall/Dockerfile` → GHCR, built by
CI) with `nftables`/`curl` baked in — nothing is installed at pod start. Debian
base, not Alpine (Alpine's musl `nft` segfaults on aarch64). Argo CD Image Updater
pins the image digest into `values.yaml`, like the SPA. On start it loads a small
ruleset into its own
`inet origin_fw` table, then self-heals (re-applies only if the table vanishes,
so per-rule counters keep accumulating). The ruleset and an entrypoint script are
rendered from `values.yaml` into a ConfigMap; a `checksum/config` annotation rolls
the pods when you change it. The `preStop` hook deletes the table when the app is
pruned, so disabling the ArgoCD app cleanly removes the firewall.

Because the pod shares the host network namespace, `nft` programs the **host's**
ruleset, not a pod-local one.

### Auto-updating the Cloudflare ranges

With `cloudflareAutoUpdate.enabled: true` (default), the DaemonSet also polls
Cloudflare's published lists (`https://www.cloudflare.com/ips-v4` / `-v6`) every
`interval` seconds (12h default) and **atomically replaces** the `cloudflare_v4` /
`cloudflare_v6` nftables sets in place. It's fail-safe:

- The static `cloudflareIPv4` / `cloudflareIPv6` lists in `values.yaml` are baked
  into the ConfigMap and applied at boot, so the firewall has a known-good
  allowlist **before** any fetch and whenever egress is down.
- A fetch is only applied after validation (well-formed CIDRs, at least a few
  entries). A network error, an HTML error page, or a suspiciously short list
  **changes nothing** — the last-known-good set is kept.
- Only the two CF sets are touched; `@local_v4/v6` and the chains are untouched.

Set `cloudflareAutoUpdate.enabled: false` to pin to the static lists instead. The
firewall never blocks its own egress (it only filters inbound 80/443), so the
fetch always has a path out.

## Why a DaemonSet and not a Traefik `IPAllowList`

k3s's klipper `svclb` SNATs every external connection to the node's CNI bridge
(`10.42.0.1`) **before** Traefik sees it, so at Traefik, Cloudflare traffic and a
direct-IP attacker are indistinguishable (both appear as `10.42.0.1`), and the
only thing carrying the real client is the `Cf-Connecting-Ip` / `X-Forwarded-For`
headers — which a direct attacker can forge. An `IPAllowList` middleware therefore
cannot block direct hits.

The nftables rule runs at `prerouting priority -300` — **before** klipper's
`dstnat` (-100) and any POSTROUTING masquerade — where the real source IP and the
original destination port are still visible. That's the only layer on the box that
can tell the two apart, and a DaemonSet is how we program it under GitOps.

## Safety

- The ruleset **only ever matches `tcp/80,443`**. SSH (22), the k8s API (6443),
  and everything else are never touched — a bad ruleset can't lock you out.
- If the pod dies after applying, the kernel rules persist (fail-closed, still
  blocking). If it never starts (e.g. image pull fails), no rules exist and
  services stay reachable (fail-open) — same exposure as not having the firewall.
- `NET_ADMIN`+`NET_RAW` on a hostNetwork pod is enough to program nftables. If the
  DaemonSet logs show `nft` permission errors on your kernel, set
  `privileged: true` in `values.yaml`.

## ⚠️ Router caveat — verify it actually sees real source IPs

This only works if your router **preserves the internet source IP** when it
port-forwards 80/443 (plain DNAT). If the router SNATs forwarded traffic to its
own LAN IP, every external request arrives at the Pi as `192.168.0.x`, matches
`@local_v4`, and is accepted — the block does nothing. Verify:

```bash
# 1. pods healthy on every node
kubectl -n kube-system rollout status ds/origin-firewall

# 2. from a device OFF your LAN (phone on mobile data), open a couple of
#    services, e.g. https://grafana.agu.com.ar, then read the counters:
kubectl -n kube-system exec ds/origin-firewall -- nft list table inet origin_fw
```

- ✅ **Working:** the `@cloudflare_v4 … counter accept` packet count climbs when
  you browse via Cloudflare; `@local_v4` climbs from on-LAN devices; `counter drop`
  climbs from real direct-IP probes.
- ❌ **Router is SNATing:** external browsing makes **`@local_v4`** climb (all
  traffic looks like `192.168.0.x`) and `@cloudflare_v4` stays at 0. The firewall
  is a no-op — block at the router instead (allow WAN 80/443 only from the
  Cloudflare ranges).

> `nft` lives inside the pod, so query counters via `kubectl exec` as above rather
> than on the host.

## Rollback

Remove `apps/origin-firewall.yaml` (or disable the ArgoCD app). The `preStop` hook
runs `nft delete table inet origin_fw` on pod termination, removing the block
immediately — no reboot. (A DaemonSet has no replica count to scale to zero, so
deleting the app is the clean off switch.)

## Maintenance

With auto-update on (default), Cloudflare range changes are picked up
automatically — no action needed. The static `cloudflareIPv4` / `cloudflareIPv6`
lists only need a manual refresh (from <https://www.cloudflare.com/ips/>) if you
**disable** auto-update, since they're then the sole source. If your LAN isn't
`192.168.0.0/24`, adjust `localIPv4`; drop `localIPv6` if you don't use IPv6.
Editing any of these in `values.yaml` and committing rolls the pods (ConfigMap
checksum), which re-apply.
