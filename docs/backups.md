# Backups (restic → Cloudflare R2)

Everything else in this repo can be rebuilt from git, but a few PVCs hold state
git can't: [`charts/backups`](../charts/backups) copies them off the Pi every
night into one [restic](https://restic.net/) repository in the Cloudflare R2
bucket `agu-backups`. Restic encrypts, deduplicates and prunes it.

| Target | Namespace / claim | What | When |
|---|---|---|---|
| `wg-easy` | `wg-easy` / `wg-easy-data` | wg-easy's SQLite database (users, clients, keys), copied with `VACUUM INTO` | 04:00 |
| `home-assistant` | `home-assistant` / `home-assistant-config` | the newest of HA's own nightly backups (`/config/backups/Automatic_backup_*.tar`, written 04:30): config, `.storage`, recorder database | 05:30 |

Retention: 7 daily + 4 weekly snapshots per target (`retention` in values).
Snapshots are tagged `--host <target>`, and pruning groups by host only: HA's
archive is named after its day, and restic's default grouping (host + paths)
would keep every one of them forever.

## How it works

One CronJob per target, in the target's namespace (a pod can only mount a PVC
of its own namespace). On a single node the RWO claim mounts next to the app.

- `sqlite` targets: an init container (Python's `sqlite3`) runs
  `VACUUM INTO` into an emptyDir, a consistent snapshot taken inside a read
  transaction while the app keeps writing, and checks its `integrity_check`.
  Restic uploads that copy.
- `latest` targets: restic uploads the newest file matching a glob, with the
  claim mounted read-only.

All targets share the repository, so their schedules are spaced out and restic
waits up to 30 min for another target's lock (`--retry-lock`).

Adding a target: a `targets` entry in `charts/backups/values.yaml`, the
`backup-r2` secret sealed into its namespace (below), and its row in the table
above.

## Secrets

`backup-r2`, sealed **once per target namespace** with the same values
(`charts/backups/templates/backup-r2-<namespace>-sealed.yaml`):

| Key | Value |
|---|---|
| `RESTIC_REPOSITORY` | `s3:https://<account-id>.r2.cloudflarestorage.com/agu-backups` |
| `RESTIC_PASSWORD` | the repository's password. **Without it nothing can be restored**: keep a copy in a password manager, outside the cluster |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | an R2 API token, *Object Read & Write* on `agu-backups` only |

```bash
for ns in wg-easy home-assistant; do
  kubectl create secret generic backup-r2 -n "$ns" --from-env-file=r2.env \
    --dry-run=client -o yaml | kubeseal --format yaml \
    > "charts/backups/templates/backup-r2-$ns-sealed.yaml"
done
```

Home Assistant's archives may also be encrypted with HA's own backup key
(Settings > System > Backups). Keep that key outside the cluster too.

## Alerts

- `KubeJobFailed` (default rules) pages on any failed run.
- `BackupStale` (`charts/monitoring/templates/vmrules.yaml`): no successful run
  of a `backup-*` CronJob in two days, i.e. runs that never happen.
- R2 itself: `R2StorageNearFreeTier` and `R2OperationsNearFreeTier` at 80 % of
  the free tier, `CloudflarePaidPlan` on any billed plan; see
  [monitoring.md](monitoring.md#cloudflare-usage).

## Run, list, restore

From a workstation with the same four variables (the `r2.env` above):

```bash
set -a; . ./r2.env; set +a
restic snapshots                              # every target
restic snapshots --host wg-easy

# Run one now
kubectl -n wg-easy create job --from=cronjob/backup-wg-easy backup-now
```

**wg-easy**: restore the database into the PVC with the app stopped.

```bash
restic restore latest --host wg-easy --target ./restore     # → ./restore/stage/wg-easy.db
kubectl -n wg-easy scale deploy/wg-easy --replicas=0
kubectl -n wg-easy run restore --rm -i --restart=Never --image=busybox:1.37.0 \
  --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"wg-easy-data"}}],"containers":[{"name":"restore","image":"busybox:1.37.0","stdin":true,"command":["sh","-c","rm -f /d/wg-easy.db-wal /d/wg-easy.db-shm && cat > /d/wg-easy.db"],"volumeMounts":[{"name":"d","mountPath":"/d"}]}]}}' \
  < ./restore/stage/wg-easy.db
kubectl -n wg-easy scale deploy/wg-easy --replicas=1
```

The server keys are in the database, so restored clients reconnect unchanged.

**Home Assistant**: restore the archive through HA itself.

```bash
restic restore latest --host home-assistant --target ./restore   # → ./restore/data/backups/Automatic_backup_….tar
```

Then, on a fresh HA, choose *Restore from backup* during onboarding and upload
the `.tar` (or, on a running one, Settings > System > Backups > Upload backup).
