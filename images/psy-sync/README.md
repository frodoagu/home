# psy-sync

Cloud save for [psy.agu.com.ar](https://psy.agu.com.ar): any Google account
signs in, and each user gets one opaque JSON workspace stored in SQLite. Bun
with no dependencies (`bun:sqlite`, WebCrypto). Deployed by
[`charts/psy-sampler`](../../charts/psy-sampler) (`sync.*` values) as its own
Deployment + PVC behind `/api/`. Full story in
[docs/psy-sampler.md](../../docs/psy-sampler.md).

## How it works

- The page sends a Google ID token to `POST /api/session`; the server verifies
  it against Google's keys and issues its own HMAC-signed cookie.
- `GET` / `PUT /api/state` read and write the workspace. A `PUT` carries the
  `updatedAt` it was based on; if the stored copy has moved on, it gets a 409
  with that copy instead, unless it sets `force`.
- `DELETE /api/session` signs out, `DELETE /api/account` deletes the user and
  their workspace, `GET /api/health` is the probe.
- Non-`GET` requests must come from an `ALLOWED_ORIGINS` origin.

It is deliberately **not** behind google-auth/oauth2-proxy: that allowlist
opens the dashboards. The server never inspects the workspace; the page's
`normalize()` is the only validation.

## Configuration

| Env var | Default | |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | (required) | OAuth client the ID tokens must be issued for |
| `ALLOWED_ORIGINS` | (required) | Comma-separated origins allowed to write |
| `DATA_DIR` | `/data` | Holds `psy-sync.db` and `session.key` |
| `PORT` | `8787` | |
| `MAX_USERS` | `5000` | New sign-ins get a 503 once this many accounts exist |

`session.key` is generated on first boot, so there is no Secret to create.
The PVC has **no backup**: losing it loses every account and every session.

## Develop

```bash
bun test
DATA_DIR=/tmp/psd GOOGLE_CLIENT_ID=<client> ALLOWED_ORIGINS=http://localhost:5173 bun src/server.js
```

Then run `npm run dev` in [`../psy-sampler`](../psy-sampler); Vite proxies
`/api` to `:8787`.

## Image and deploy

`oven/bun:1.3-alpine` plus `src/`, running as `bun` with `/data` as the volume.
[`psy-sync-test.yml`](../../.github/workflows/psy-sync-test.yml) runs
`bun test`;
[`psy-sync-image.yml`](../../.github/workflows/psy-sync-image.yml) builds
`ghcr.io/frodoagu/psy-sync:latest` for `linux/arm64` on push to `main`, and
Argo CD Image Updater pins the digest into `sync.image.tag` in
`charts/psy-sampler/values.yaml`. The GHCR package must be public, like
psy-sampler's.
