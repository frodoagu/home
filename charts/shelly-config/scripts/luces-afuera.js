// Shelly script: gang the two outdoor lights, so either wall switch drives both.
// Runs ON THE DEVICES (mJS), not in Home Assistant.
//
// ASCII ONLY -- no accents, no non-ASCII anywhere in this file. The device
// mangles multi-byte UTF-8 on upload and you get a corrupted script that fails
// with a bogus ReferenceError. See docs/home-assistant.md.
//
// The same file is uploaded to BOTH devices unedited: each one matches its own
// MAC against DEVICES and derives who the peer is.
//
// Device config requirement: `in_mode: "detached"` (Switch.SetConfig), so the
// wall switch does NOT drive its own relay and the whole decision lands here.
// Both are reconciled by the shelly-config CronJob (charts/shelly-config).
//
// Logic (idempotent toggle, same shape as `aires_toggle_calor` in the climate
// package): if BOTH are on, a flip turns both off; in any other state (mixed or
// both off) it turns both on. So a mixed state left by the app is normalised to
// "both on" and the next flip turns them off.
//
// Home Assistant and Google Home do not take part: they still see two
// independent `switch` entities and can drive each light separately. That is why
// this survives HA being down -- the whole point of running it here.

// The two devices in the gang. MAC as returned by Shelly.GetDeviceInfo
// (uppercase, no separators). IPs are DHCP reservations in Pi-hole.
let DEVICES = [
  { mac: "7C2C67672C90", ip: "192.168.0.215" }, // Luz Puerta Escalera
  { mac: "7C2C67609438", ip: "192.168.0.222" }  // Luz Puerta Principal
];

// Both are Shelly 1 Mini Gen4: single channel, always id 0.
let SWITCH = "switch:0";
let INPUT = "input:0";
let ID = 0;
let TIMEOUT = 4; // seconds to wait for the peer RPC

// The decision reads the relays and then writes them, with an async peer RPC in
// between, so a second event arriving mid-flight would read the half-applied
// state and undo the first one. `busy` covers that window; the timestamp covers
// contact bounce on the mechanical wall switch right after it. Measured on the
// real hardware, one actuation delivers exactly ONE `toggle` event, so neither
// guard fires in normal use -- they are there so a bouncing contact or a jammed
// RPC degrades into "nothing happens" instead of "the lights fight themselves".
let DEBOUNCE_MS = 400;

let peer = null;
let busy = false;
let last = 0;
let i;

for (i = 0; i < DEVICES.length; i++) {
  if (DEVICES[i].mac !== Shelly.getDeviceInfo().mac) peer = DEVICES[i].ip;
}

function setPeer(on) {
  let arg = "false";
  if (on) arg = "true";
  Shelly.call("HTTP.GET", { url: "http://" + peer + "/rpc/Switch.Set?id=0&on=" + arg, timeout: TIMEOUT });
}

// Degraded mode when the peer does not answer (powered off, no network,
// rebooting): this wall switch drives ITS light and that is it. Worst case
// behaviour equals a plain wall switch, never a dead one.
function toggleLocalOnly(mine) {
  print("luces-afuera: peer unreachable, toggling local only");
  Shelly.call("Switch.Set", { id: ID, on: !mine });
}

function onFlip() {
  let now = Date.now();
  if (busy || (now - last) < DEBOUNCE_MS) return;
  busy = true;
  last = now;

  Shelly.call("HTTP.GET", { url: "http://" + peer + "/rpc/Switch.GetStatus?id=0", timeout: TIMEOUT },
    function (res, err) {
      let mine = Shelly.getComponentStatus(SWITCH).output;

      if (err !== 0 || res === null || res.code !== 200) {
        toggleLocalOnly(mine);
        busy = false;
        return;
      }

      // Turn off only when BOTH are on; in any other case turn both on.
      let target = !(mine && JSON.parse(res.body).output);

      Shelly.call("Switch.Set", { id: ID, on: target });
      setPeer(target);
      busy = false;
    });
}

// Wall switch (input `type: "switch"`): every actuation emits a `toggle` event,
// in either direction. No need to look at the position, only at the change.
Shelly.addEventHandler(function (e) {
  if (e.component === INPUT && e.info.event === "toggle") onFlip();
});

if (peer === null) {
  print("luces-afuera: THIS MAC IS NOT IN DEVICES, the gang will not work");
} else {
  print("luces-afuera: ready, peer = " + peer);
}
