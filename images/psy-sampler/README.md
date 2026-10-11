# psy-sampler

The [psy.agu.com.ar](https://psy.agu.com.ar) psytrance layer sampler for ear
training (Vite + vanilla JS + Web Audio, no runtime dependencies) and the
Dockerfile that bakes it into an nginx image. Deployed by
[`charts/psy-sampler`](../../charts/psy-sampler); full guide in
[docs/psy-sampler.md](../../docs/psy-sampler.md).

## Layout

- `src/audio/`: the engine (lookahead scheduler, per-layer gain lanes), voices,
  and the pure timing/pattern/music logic. Every variant is data in
  `patterns.js` `DEFAULTS`.
- `src/ui/`: the DOM UI and editors.
- `src/autopilot.js`, `snapshots.js`, `tempo.js`, `workspace.js`, `share.js`,
  `cloud.js`: autopilot and seeds, snapshots, BPM ramps, persistence, share
  links, and the client for the cloud save ([`../psy-sync`](../psy-sync)).
- `src/import/`: sample import. `formats.js` is the one table of extensions
  (classification, the file dialog, the panel's format guide); `gather.js` turns
  files, folders and archives into candidates; `pcm.js` decodes WAV/RF64/AIFF/CAF/AU, `zip.js`,
  `soundfont.js` (SF2/SF3) and `projects.js` (Ableton, SFZ, Decent Sampler,
  REAPER references). Fixtures are built byte by byte in
  [`src/test/audioFiles.js`](src/test/audioFiles.js).
- `src/i18n/{es,en,pt}.js`: all UI text, same shape in every language.

Each module has its `*.test.js` beside it. Voice and engine tests run against a
fake `AudioContext` ([`src/test/fakeAudio.js`](src/test/fakeAudio.js));
`voices.test.js` checks that every audible source starts and ends at gain 0, so
keep it passing when adding a voice.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173, proxies /api to :8787
npm run lint
npm test         # Vitest
npm run build    # production bundle in dist/
```

The cloud save only appears with a local psy-sync running; see its
[README](../psy-sync/README.md). Without it the page hides that row.

Dev dependencies (Vite 8, Vitest 5, jsdom 29) are this app's own, newer than
home-site's.

## Image

Two stages: `node:24-alpine` builds `dist/`, `nginx:1.31-alpine` serves it. The
chart mounts its own nginx `default.conf` (SPA fallback, caching, `/healthz`)
and routes `/api/` to psy-sync.

## CI and deploy

- [`psy-sampler-test.yml`](../../.github/workflows/psy-sampler-test.yml): lint,
  tests and build on PRs and pushes.
- [`psy-sampler-image.yml`](../../.github/workflows/psy-sampler-image.yml): on
  push to `main`, builds `ghcr.io/frodoagu/psy-sampler:latest` for
  `linux/arm64`.
- Argo CD Image Updater pins the digest into `charts/psy-sampler/values.yaml`.

The GHCR package is **public** (`imagePullSecrets: []`): GHCR creates it
private on the first push, so it has to be flipped to public once by hand or the
pod sits in `ImagePullBackOff`.
