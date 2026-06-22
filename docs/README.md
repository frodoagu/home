# Documentation

Deeper guides for this home-lab. Start with the top-level [README](../README.md)
for the stack overview and bootstrap; come here for per-topic detail.

| Doc | What it covers |
|---|---|
| [secrets.md](secrets.md) | Every out-of-band Secret the stack needs (none live in git) and how to create them |
| [tls.md](tls.md) | Let's Encrypt via the **DNS-01** Cloudflare challenge, and how `acme.json` is persisted |
| [home-assistant.md](home-assistant.md) | Home Assistant chart specifics: config bootstrap, device discovery (host networking), Bluetooth |
| [google-assistant.md](google-assistant.md) | End-to-end runbook for the Google Home / `google_assistant` integration |
| [nginx-spa.md](nginx-spa.md) | Static SPA chart: shipping a real build via image vs. the placeholder ConfigMap, SPA routing fallback |
