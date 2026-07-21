# Documentation

Deeper guides for this home-lab. Start with the top-level [README](../README.md)
for the stack overview and bootstrap; come here for per-topic detail.

| Doc | What it covers |
|---|---|
| [secrets.md](secrets.md) | Every secret committed as a `SealedSecret` (none in plaintext): controller-key bootstrap, minting/rotation/adoption, off-repo key backup |
| [tls.md](tls.md) | Let's Encrypt via the **DNS-01** Cloudflare challenge, and how `acme.json` is persisted |
| [monitoring.md](monitoring.md) | VictoriaMetrics + Grafana stack: custom dashboards, Telegram alerts, blackbox uptime/TLS probes, Traefik metrics, operating notes |
| [home-assistant.md](home-assistant.md) | Home Assistant chart specifics: config bootstrap, device discovery (host networking), Bluetooth, IR air conditioners (SmartIR + Broadlink) |
| [google-assistant.md](google-assistant.md) | End-to-end runbook for the Google Home / `google_assistant` integration |
| [agu-spa.md](agu-spa.md) | SPA chart: how `images/home-site/` ships via GHCR + Image Updater, image vs. placeholder content, SPA routing fallback |
| [pihole.md](pihole.md) | Pi-hole as DNS ad-blocker + LAN DHCP: hostNetwork, the static-IP cold-boot chicken-and-egg, phased rollout, MAC→IP reservations |
| [email-migration.md](email-migration.md) | **Design / migration runbook (not yet deployed)** — self-hosting `fede@agu.com.ar` off Google Workspace (Stalwart + AWS SES relay) |
