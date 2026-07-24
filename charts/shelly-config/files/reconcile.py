#!/usr/bin/env python3
"""Reconcile declarative config onto Shelly Gen2+ devices over their local RPC.

Runs from the cluster (CronJob + PostSync hook, see charts/shelly-config). Pods
reach the LAN devices directly by IP -- no host networking needed.

Idempotent by design: it reads the live config, compares, and only writes on
drift. A no-op run prints "in sync" and touches nothing, so it is safe to run
every few minutes as self-heal (a factory-reset or hand-fiddled device comes
back on its own, same spirit as ArgoCD selfHeal).

What it reconciles, per device:
  1. `Switch.SetConfig` keys (in_mode, initial_state, ...) from values.yaml.
  2. The mJS scripts from charts/shelly-config/scripts/: created if missing,
     re-uploaded when the code differs, left alone when it matches, then
     enabled (autostart on boot) and started.

Two hard-won details, both load-bearing:
  * Script code MUST be pure ASCII. The device mangles multi-byte UTF-8 on
    upload and you end up with corrupted source that fails at runtime with a
    misleading ReferenceError pointing at an innocent line. We refuse to upload
    non-ASCII rather than let that happen silently.
  * `Script.PutCode` takes the code in chunks; we slice by BYTES and then read
    the code back and compare it to the source. Never trust the write.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

SCRIPTS_DIR = os.environ.get("SCRIPTS_DIR", "/scripts")
DEVICES = json.loads(os.environ["SHELLY_DEVICES"])
TIMEOUT = int(os.environ.get("RPC_TIMEOUT", "15"))
# Conservative: the device rejects oversized RPC bodies, and a rejected chunk
# would leave half a script behind.
CHUNK = 700


class DeviceError(Exception):
    pass


def rpc(host, method, params=None):
    """One JSON-RPC call to http://<host>/rpc. Raises DeviceError on failure."""
    payload = json.dumps({"id": 1, "method": method, "params": params or {}})
    req = urllib.request.Request(
        "http://%s/rpc" % host,
        data=payload.encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.load(resp)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise DeviceError("%s failed: %s" % (method, exc)) from exc
    if "error" in body:
        raise DeviceError("%s returned %s" % (method, body["error"]))
    return body.get("result", {})


def reconcile_switch(host, desired, changes):
    """Apply the desired Switch.SetConfig keys, writing only on drift."""
    if not desired:
        return
    live = rpc(host, "Switch.GetConfig", {"id": 0})
    drift = {k: v for k, v in desired.items() if live.get(k) != v}
    if not drift:
        return
    rpc(host, "Switch.SetConfig", {"id": 0, "config": dict(desired, id=0)})
    changes.append(
        "switch:0 %s" % ", ".join("%s %s->%s" % (k, live.get(k), v) for k, v in drift.items())
    )


def script_id(host, name):
    for script in rpc(host, "Script.List")["scripts"]:
        if script["name"] == name:
            return script["id"]
    return None


def upload(host, sid, code):
    """Replace a script's code and verify the device stored it verbatim."""
    rpc(host, "Script.Stop", {"id": sid})
    raw = code.encode("ascii")
    for offset in range(0, len(raw), CHUNK):
        rpc(host, "Script.PutCode", {
            "id": sid,
            "code": raw[offset:offset + CHUNK].decode("ascii"),
            "append": offset > 0,
        })
    stored = rpc(host, "Script.GetCode", {"id": sid})["data"]
    if stored != code:
        raise DeviceError(
            "script %d readback mismatch (%d bytes stored, %d expected) -- "
            "the device did not store what we sent" % (sid, len(stored), len(code))
        )


def reconcile_script(host, name, code, changes):
    if not code.isascii():
        raise DeviceError("script %s has non-ASCII characters; refusing to upload" % name)

    sid = script_id(host, name)
    if sid is None:
        sid = rpc(host, "Script.Create", {"name": name})["id"]
        changes.append("created script %s (id %d)" % (name, sid))
        stored = None
    else:
        stored = rpc(host, "Script.GetCode", {"id": sid})["data"]

    if stored != code:
        upload(host, sid, code)
        changes.append("uploaded %s (%d bytes)" % (name, len(code)))

    # `enable` is the autostart-on-boot flag; `running` is the live state. A
    # device that rebooted with enable=false would come up silent, so pin both.
    if not rpc(host, "Script.GetConfig", {"id": sid}).get("enable"):
        rpc(host, "Script.SetConfig", {"id": sid, "config": {"enable": True}})
        changes.append("enabled %s" % name)

    status = rpc(host, "Script.GetStatus", {"id": sid})
    if not status.get("running"):
        rpc(host, "Script.Start", {"id": sid})
        time.sleep(1)
        status = rpc(host, "Script.GetStatus", {"id": sid})
        changes.append("started %s" % name)

    if status.get("errors"):
        raise DeviceError("script %s is failing: %s" % (name, status.get("error_msg", status["errors"])))


def reconcile(device):
    host = device["host"]
    info = rpc(host, "Shelly.GetDeviceInfo")
    changes = []

    reconcile_switch(host, device.get("switch"), changes)
    for name in device.get("scripts", []):
        with open(os.path.join(SCRIPTS_DIR, name + ".js"), encoding="ascii") as handle:
            reconcile_script(host, name, handle.read(), changes)

    label = "%s (%s, %s fw %s)" % (device.get("name", host), host, info["model"], info["ver"])
    if changes:
        print("%s: %s" % (label, "; ".join(changes)), flush=True)
    else:
        print("%s: in sync" % label, flush=True)


def main():
    failed = []
    for device in DEVICES:
        try:
            reconcile(device)
        except DeviceError as exc:
            failed.append(device.get("name", device["host"]))
            print("%s: ERROR %s" % (device.get("name", device["host"]), exc), file=sys.stderr, flush=True)

    if failed:
        # Non-zero so the Job shows Failed and the failure is visible in the
        # cluster rather than buried in logs.
        print("reconcile failed for: %s" % ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
