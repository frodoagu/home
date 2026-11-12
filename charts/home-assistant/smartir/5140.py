# Rebuilds SmartIR's 5140 code table (Mitsubishi112, the bedroom AC) from its
# protocol, run by the smartir-codes init container before HA starts. 35 of the
# upstream captures are broken: no leader (cool 25 at fan and swing auto, among
# others) or the setpoint or fan shifted by one. The other 1309 decode to exactly
# these frames, the layout `dormitorio_led` builds in packages/climate.yaml.
# Modes, fans, swings, temperatures and the `off` command stay the file's own; a
# key it doesn't know keeps its capture. It never fails the pod: HA must start.
import base64
import json
import os
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "/config/custom_components/smartir/codes/climate/5140.json"
MODES = {"heat": 1, "dry": 2, "cool": 3}
FANS = {"auto": 0, "level1": 2, "level2": 3, "level3": 5}
SWINGS = {"auto": 0, "top": 1, "high": 2, "mid": 3, "low": 4, "bottom": 5, "swing": 7}


def frame(mode, fan, swing, temp):
    y = [0x23, 0xCB, 0x26, 0x01, 0x00, 0x24, MODES[mode],
         7 if mode == "dry" else 31 - temp, SWINGS[swing] * 8 + FANS[fan], 0, 0, 0, 0]
    y.append(sum(y) % 256)
    # Broadlink units of ~32.8 us, LSB first; the trailer is a mark and a 109 ms gap.
    t = [114, 56]
    for b in y:
        for i in range(8):
            t += [15, 41 if b >> i & 1 else 13]
    t += [15, 0, 13, 5]
    return base64.b64encode(bytes([0x26, 0, len(t) & 255, len(t) >> 8] + t)).decode()


def main():
    if not os.path.exists(PATH):
        print(f"{PATH} missing, skipped")
        return
    with open(PATH) as f:
        code = json.load(f)
    before = json.dumps(code, sort_keys=True)
    for mode, fans in code["commands"].items():
        if mode not in MODES:
            continue
        for fan, swings in fans.items():
            for swing, temps in swings.items():
                if fan not in FANS or swing not in SWINGS:
                    continue
                for temp in temps:
                    if temp.isdigit():
                        temps[temp] = frame(mode, fan, swing, int(temp))
    if json.dumps(code, sort_keys=True) == before:
        print(f"{PATH} already rebuilt")
        return
    with open(PATH + ".tmp", "w") as f:
        json.dump(code, f, indent=2)
    os.replace(PATH + ".tmp", PATH)
    print(f"{PATH} rebuilt")


try:
    main()
except Exception as e:
    print(f"{PATH} left as is: {e!r}")
