# TLS / Let's Encrypt

The k3s-bundled Traefik terminates TLS for every service and obtains
certificates from Let's Encrypt using the **DNS-01 challenge via Cloudflare**.
This is configured by `charts/traefik-config` (a `HelmChartConfig` that overrides
the bundled Traefik's values — Traefik itself is installed by k3s, not this repo).

## Why DNS-01 (not HTTP-01)

`charts/traefik-config` redirects **all** HTTP (`:80`/web) traffic to HTTPS at the
entrypoint level. That global redirect would bounce the ACME HTTP-01 challenge
(`/.well-known/acme-challenge/...`) to `:443`, where it 404s — so HTTP-01 can't
complete. DNS-01 sidesteps this entirely: it proves domain ownership by writing a
TXT record via the Cloudflare API and needs **no inbound port** for issuance.

## Configuration

In [charts/traefik-config/values.yaml](../charts/traefik-config/values.yaml):

```yaml
acme:
  email: federico.nicolas.agu@gmail.com
  storage: /data/acme.json
  dnsChallenge:
    provider: cloudflare
    existingSecret: traefik-cloudflare-token   # created out-of-band
    tokenKey: CF_DNS_API_TOKEN
```

The token is injected into the Traefik pod as the `CF_DNS_API_TOKEN` env var from
the `traefik-cloudflare-token` Secret (lego, Traefik's ACME library, reads it for
the Cloudflare provider). Create the secret:

```bash
kubectl create secret generic traefik-cloudflare-token -n kube-system \
  --from-literal=CF_DNS_API_TOKEN='your-cloudflare-token'
```

The token needs **Zone:DNS:Edit** on the `agu.com.ar` zone.

## Certificate persistence

ACME state (account key + issued certs) is stored in `acme.json` on a
PersistentVolume mounted at `/data`, so certificates survive Traefik restarts and
aren't re-issued on every redeploy (which would quickly hit Let's Encrypt rate
limits). An init container `chmod 600`s `acme.json` on startup because Traefik
refuses to use it with looser permissions.

## Ports

Because issuance uses DNS-01, **port 80 is not required for certificates**. You
still forward:

- **TCP 443** → RPi — serves all the apps over HTTPS.
- **TCP 80** → RPi — optional; only used to redirect plain-HTTP visitors to HTTPS.

## Troubleshooting

- **Cert stuck / not issued:** check Traefik logs in `kube-system` for lego/ACME
  errors; the most common cause is a Cloudflare token missing `Zone:DNS:Edit` or
  scoped to the wrong zone.
- **`acme.json` permission errors:** confirm the `volume-permissions` init
  container ran and the file is mode `0600`.
- **Rate limits:** Let's Encrypt limits issuance per domain per week. If you're
  iterating, point `acme.caServer` at the staging endpoint first.
