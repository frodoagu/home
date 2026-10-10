# origin-firewall

Base image for the Cloudflare-only origin firewall DaemonSet
([`charts/origin-firewall`](../../charts/origin-firewall)): Debian with
`nftables`, `curl` and CA certificates, so the pod installs nothing at start.
How the firewall works is in [docs/origin-firewall.md](../../docs/origin-firewall.md).

The image holds **only the tools**. The ruleset and the entrypoint script come
from the chart's ConfigMap at runtime, so changes to the Cloudflare ranges or
the firewall logic ship through git with no rebuild. Rebuild only to change the
base or the installed packages.

- **Debian, not Alpine**: Alpine's musl `nft` segfaults on aarch64 when loading
  a ruleset.
- The build only checks that `nft` and `curl` are on `PATH`; running `nft`
  under QEMU fails because the build sandbox has no Netlink. The entrypoint
  checks that `nft` works at runtime.

## CI and deploy

[`origin-firewall-image.yml`](../../.github/workflows/origin-firewall-image.yml)
builds `ghcr.io/frodoagu/origin-firewall:latest` (plus `sha-<commit>`) for
`linux/arm64` on every push to `main` that touches this directory. Argo CD
Image Updater pins the digest into `charts/origin-firewall/values.yaml`, which
rolls the DaemonSet.
