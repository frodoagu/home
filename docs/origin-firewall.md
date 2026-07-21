# Cloudflare-only origin firewall (nftables)

Blocks direct hits to the Pi's public IP: inbound `tcp/80` and `tcp/443` are
accepted only from **Cloudflare's edge ranges** and the **local LAN/cluster**,
and dropped for everyone else. All `*.agu.com.ar` services are Cloudflare-proxied
(`charts/cloudflare-ddns`, `proxied: true`), so legitimate internet traffic only
ever comes from Cloudflare; anything hitting the raw IP is bypassing Cloudflare
(and any per-service auth/rate-limit that trusts CF-supplied headers).

Files live in [`host/nftables/`](../host/nftables/):

- `origin-firewall.nft` — the ruleset (own `inet origin_fw` table)
- `origin-firewall.service` — systemd unit that loads it at boot

## Why this is a host firewall and not a Traefik middleware

k3s's klipper `svclb` SNATs every external connection to the node's CNI bridge
(`10.42.0.1`) **before** Traefik sees it, so at Traefik, Cloudflare traffic and a
direct-IP attacker are indistinguishable (both appear as `10.42.0.1`), and the
only thing carrying the real client is the `Cf-Connecting-Ip` / `X-Forwarded-For`
headers — which a direct attacker can forge. An `IPAllowList` middleware therefore
cannot block direct hits.

nftables at `prerouting priority raw` (-300) runs **before** klipper's `dstnat`
(-100) and any POSTROUTING masquerade, so it still sees the real source IP and the
original destination port. That's the only layer on the box that can tell the two
apart.

## ⚠️ Router caveat — verify before trusting it

This only works if your router **preserves the internet source IP** when it
port-forwards 80/443 (plain DNAT). If the router SNATs forwarded traffic to its
own LAN IP, every external request arrives at the Pi as `192.168.0.x`, matches
`@local_v4`, and is accepted — the block does nothing. The counters below tell you
which case you're in. If it's the SNAT case, filter at the router instead (allow
WAN 80/443 only from the Cloudflare ranges).

## Safe rollout (do this over SSH, with console/keyboard access as a backup)

The ruleset only ever touches tcp/80,443 — SSH (22) and the k8s API (6443) are
never matched, so this cannot lock you out of SSH. Still, roll out in two steps.

### 1. Install in observe-only mode first

Copy the files but make the last rule observe instead of drop, so nothing is
blocked yet:

```bash
sudo install -D -m 0644 host/nftables/origin-firewall.nft /etc/nftables.d/origin-firewall.nft
# temporarily neuter the drop: log what WOULD be dropped, but let it through
sudo sed -i 's/^        counter drop$/        counter log prefix "origin-fw-would-drop " /' \
    /etc/nftables.d/origin-firewall.nft
sudo install -D -m 0644 host/nftables/origin-firewall.service /etc/systemd/system/origin-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable --now origin-firewall.service
```

### 2. Verify source IPs really reach the Pi

From a device **off your LAN** (phone on mobile data), open a couple of services,
e.g. `https://grafana.agu.com.ar`. Then check the per-rule counters:

```bash
sudo nft list table inet origin_fw
```

- ✅ **Working as intended:** the `@cloudflare_v4 … accept` counter climbs when you
  browse via Cloudflare, and the LAN counter climbs from on-LAN devices. Any
  `origin-fw-would-drop` lines in `journalctl -k` are real direct-IP probes.
- ❌ **Router is SNATing:** external browsing makes the **`@local_v4`** counter
  climb (everything looks like `192.168.0.x`) and `@cloudflare_v4` stays at 0.
  Stop here (`sudo systemctl disable --now origin-firewall.service && sudo nft
  delete table inet origin_fw`) and block at the router instead.

### 3. Arm it (enable the drop)

Once step 2 confirms real Cloudflare IPs are seen, restore the drop and reload:

```bash
sudo cp host/nftables/origin-firewall.nft /etc/nftables.d/origin-firewall.nft
sudo systemctl reload origin-firewall.service
```

Re-run the off-LAN test against a raw-IP URL to confirm a direct hit is now
refused while `https://<host>.agu.com.ar` (via Cloudflare) still works.

## Rollback

```bash
sudo systemctl disable --now origin-firewall.service
sudo nft delete table inet origin_fw      # remove immediately, no reboot
```

## Maintenance

Cloudflare's ranges change rarely. When they do, update the `cloudflare_v4` /
`cloudflare_v6` sets from <https://www.cloudflare.com/ips/> and
`sudo systemctl reload origin-firewall.service`. If your LAN isn't
`192.168.0.0/24`, adjust `@local_v4`; add a `local_v6` set if you use IPv6 on the
LAN.
