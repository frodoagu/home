#!/usr/bin/env python3
"""Control CLI for the Candy simply-Fi washer-dryer over its local API.

Safe by default: `send` prints the URL and refuses to transmit unless --yes is
given, and refuses outright while a cycle is running unless --force.

  ./candyctl.py read                      # decrypted status snapshot
  ./candyctl.py learn                     # map dial positions to program numbers
  ./candyctl.py probe                     # does /http-write.json exist? (non-mutating)
  ./candyctl.py send "Write=1&PrNm=6"     # dry run: prints URL, sends nothing
  ./candyctl.py send "Write=1&PrNm=6&StSt=1" --yes
  ./candyctl.py stop --yes                # cancel the cycle / a delayed start
"""
import argparse
import json
import sys
import time
import urllib.request

# DHCP reservation name from charts/pihole (dhcp.reservations + dns.domain),
# so the washer-dryer can be renumbered without touching this script.
HOST = "lavarropas.lan"
KEY = b"aeaclekbgmjjcebg"
RUNNING = 2


def xor(data: bytes) -> bytes:
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))


def to_hex(plain: str) -> str:
    """Plaintext command -> uppercase hex, the form `data=` actually expects.

    Despite the mandatory `encrypted=1`, the appliance does NOT decrypt what it
    receives: it reads `data=` as hex of plain ASCII. Sending the XOR blob the
    read path uses is accepted with the usual SUCCESS and then ignored, which is
    what makes writing look impossible. `--xor` keeps that form available for
    comparison; it has never produced an effect here.
    """
    return plain.encode().hex().upper()


def decrypt(hexstr: str) -> str:
    """Decode a device reply, which may or may not actually be encrypted.

    The firmware is inconsistent: /http-read.json and /http-write.json XOR their
    payload, but /http-config.json and /http-getStatistics.json return hex-encoded
    PLAINTEXT even when asked with `encrypted=1`. XORing those yields garbage that
    looks like a decryption failure, so detect the plain case first.
    """
    raw = bytes.fromhex(hexstr.strip())
    try:
        plain = raw.decode("ascii")
        if plain.lstrip().startswith("{"):
            return plain
    except UnicodeDecodeError:
        pass
    return xor(raw).decode("ascii", "replace")


def fetch(url: str, attempts: int = 4) -> str:
    """The appliance serves one connection at a time; collisions are routine."""
    last = None
    for n in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read().decode().strip()
            if body:
                return body
        except Exception as err:  # noqa: BLE001 - any transport error is retryable
            last = err
        time.sleep(3)
    raise SystemExit(f"sin respuesta tras {attempts} intentos: {last}")


def read_status() -> dict:
    raw = fetch(f"http://{HOST}/http-read.json?encrypted=1")
    return json.loads(decrypt(raw))["statusLavatrice"]


def cmd_read(_args) -> None:
    st = read_status()
    print(json.dumps(st, indent=2))
    print(f"\nestado={st['MachMd']} fase={st['PrPh']} restante={st['RemTime']}min "
          f"WiFiStatus={st['WiFiStatus']}")


def cmd_learn(args) -> None:
    """Watch the dial-driven fields and print each change.

    Program numbers are model-specific — they map to positions on this machine's
    dial and are documented nowhere — so the only way to name them is to turn the
    dial and record what comes back.
    """
    WATCH = ("Pr", "SLevel", "Temp", "SpinSp", "DryT", "Opt1", "Opt2", "Opt3")
    print("Gira la perilla; cada cambio se imprime. Ctrl-C para terminar.\n")
    print(f"{'hora':8s}  " + "  ".join(f"{f:>7s}" for f in WATCH))
    prev = None
    seen = []
    off = False
    try:
        while True:
            # The Wi-Fi module powers down with the appliance, so "unreachable"
            # is a normal state here, not a reason to give up.
            try:
                st = read_status()
            except SystemExit:
                if not off:
                    print(f"{time.strftime('%H:%M:%S')}  -- equipo apagado / sin "
                          f"respuesta; sigo esperando --", flush=True)
                    off, prev = True, None
                time.sleep(args.interval)
                continue
            if off:
                print(f"{time.strftime('%H:%M:%S')}  -- equipo en linea --", flush=True)
                off = False
            cur = {f: st.get(f, "-") for f in WATCH}
            if cur != prev:
                ts = time.strftime("%H:%M:%S")
                print(f"{ts}  " + "  ".join(f"{cur[f]:>7s}" for f in WATCH), flush=True)
                seen.append(cur)
                prev = cur
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print(f"\n\n{len(seen)} combinaciones distintas observadas.")
        print("Anotar que programa mostraba la perilla en cada una y volcarlo al")
        print("mapeo de charts/home-assistant/packages/lavarropas.yaml.")


def cmd_probe(_args) -> None:
    """Ask the write endpoint for nothing.

    Answers SUCCESS, like every other request it gets - so this only proves the
    endpoint is routed, never that a command was understood. Only a field diff
    against http-read does that.
    """
    url = f"http://{HOST}/http-write.json?encrypted=1"
    print(f"GET {url}\n")
    body = fetch(url)
    print(f"crudo      : {body[:160]}")
    try:
        print(f"descifrado : {decrypt(body)}")
        print("\n=> el endpoint existe; SUCCESS aca no significa nada mas que eso")
    except Exception:
        print("\n=> respondio algo no descifrable")


def cmd_send(args) -> None:
    # This appliance honours exactly one form: `encrypted=1` with `data=` set to
    # the hex of the plain command. The other two are kept to re-check that.
    if args.plain:
        # encrypted=0 is rejected outright (BAD REQUEST) on both paths here.
        url = f"http://{HOST}/http-write.json?encrypted=0&{args.command}"
        print(f"comando  : {args.command}  (encrypted=0)")
    else:
        payload = xor(args.command.encode()).hex().upper() if args.xor else to_hex(args.command)
        url = f"http://{HOST}/http-write.json?encrypted=1&data={payload}"
        print(f"comando  : {args.command}")
        print(f"hex      : {payload}{'  (XOR - inerte)' if args.xor else ''}")
    print(f"URL      : {url}\n")

    # A dry run transmits nothing, so it stays available at any time.
    if not args.yes:
        print("DRY RUN - no se envio nada. Agregar --yes para transmitir.")
        return

    st = read_status()
    if int(st["MachMd"]) == RUNNING and not args.force:
        raise SystemExit(
            f"ABORTADO: la maquina esta EN MARCHA (quedan {st['RemTime']} min).\n"
            "Esperar a que termine, o forzar con --force si sabes lo que haces."
        )

    print(f"estado antes : MachMd={st['MachMd']} PrPh={st['PrPh']} RemTime={st['RemTime']}")
    # The reply is ALWAYS {"response":"SUCCESS"} - empty request, bogus
    # parameters, anything - so only the field diff below witnesses an effect.
    body = fetch(url)
    print(f"respuesta    : {body[:160]}")
    try:
        print(f"descifrada   : {decrypt(body)}")
    except Exception:
        pass
    time.sleep(4)
    after = read_status()
    print(f"estado despues: MachMd={after['MachMd']} PrPh={after['PrPh']} "
          f"RemTime={after['RemTime']}")
    changed = {k: (st[k], after[k]) for k in st if st[k] != after[k]}
    print(f"cambios      : {changed or 'ninguno'}")


def cmd_stop(args) -> None:
    """Cancel whatever is armed. --force is implied: stopping is always safe."""
    args.force = True
    cmd_send(args)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("read").set_defaults(fn=cmd_read)
    sub.add_parser("probe").set_defaults(fn=cmd_probe)
    l = sub.add_parser("learn", help="mapear la perilla a numeros de programa")
    l.add_argument("--interval", type=float, default=5.0)
    l.set_defaults(fn=cmd_learn)
    s = sub.add_parser("send")
    s.add_argument("command", help='e.g. "Write=1&StSt=1"')
    s.add_argument("--yes", action="store_true", help="actually transmit")
    s.add_argument("--force", action="store_true", help="allow while running")
    s.add_argument("--plain", action="store_true",
                   help="mandar los parametros como query (encrypted=0; el equipo lo rechaza)")
    s.add_argument("--xor", action="store_true",
                   help="hexear con XOR en vez de texto plano (inerte aca)")
    s.set_defaults(fn=cmd_send)
    t = sub.add_parser("stop", help="cancelar ciclo o inicio diferido (Write=1&StSt=0)")
    t.add_argument("--yes", action="store_true", help="actually transmit")
    t.add_argument("--force", action="store_true", help="allow while running")
    t.add_argument("--plain", action="store_true", help=argparse.SUPPRESS)
    t.add_argument("--xor", action="store_true", help=argparse.SUPPRESS)
    t.set_defaults(fn=cmd_stop, command="Write=1&StSt=0")
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
