# Prebuilt base image for the origin-firewall DaemonSet (charts/origin-firewall).
#
# Bakes in nftables + curl + CA certs so the pod doesn't apt-install them on
# every (re)start. Debian, NOT Alpine: Alpine's musl `nft` segfaults on aarch64
# when loading a ruleset (verified on the Pi).
#
# The firewall ruleset and entrypoint script are NOT baked here — they're mounted
# at runtime from the chart's ConfigMap, so CF-range/logic changes ship via git
# with no image rebuild. This image only provides the tools.
#
# Built for linux/arm64 (the k3s node is a Raspberry Pi) and pushed to GHCR by
# .github/workflows/origin-firewall-image.yml.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Sanity-check the tools are INSTALLED — but don't execute nft here: under QEMU
# (arm64 cross-build) `nft --version` opens a Netlink socket the build sandbox
# doesn't support ("Protocol not supported"), which fails the build. Checking
# they're on PATH is enough; the entrypoint verifies nft works at runtime.
RUN command -v nft && command -v curl

# The DaemonSet overrides this with the ConfigMap entrypoint; kept as a hint.
CMD ["/bin/sh", "-c", "echo 'run via the origin-firewall chart (mounts entrypoint.sh)'; sleep infinity"]
