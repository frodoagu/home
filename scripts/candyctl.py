#!/usr/bin/env python3
"""Control CLI for the Candy simply-Fi washer-dryer over its local API.

Safe by default: `send` prints the URL and refuses to transmit unless --yes is
given, and refuses outright while a cycle is running unless --force.

  ./candyctl.py read                      # decrypted status snapshot
  ./candyctl.py probe                     # does /http-write.json exist? (non-mutating)
  ./candyctl.py send "Write=1&StSt=1"     # dry run: prints URL, sends nothing
  ./candyctl.py send "Write=1&StSt=1" --yes
"""
import argparse
import json
import sys
import time
import urllib.request

IP = "192.168.0.164"
KEY = b"aeaclekbgmjjcebg"
RUNNING = 2


def xor(data: bytes) -> bytes:
    return bytes(b ^ KEY[i % len(KEY)] for i, b in enumerate(data))


def encrypt(plain: str) -> str:
    """Plaintext command -> XOR -> uppercase hex, the form `data=` expects."""
    return xor(plain.encode()).hex().upper()


def decrypt(hexstr: str) -> str:
    return xor(bytes.fromhex(hexstr.strip())).decode("ascii", "replace")


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
    raw = fetch(f"http://{IP}/http-read.json?encrypted=1")
    return json.loads(decrypt(raw))["statusLavatrice"]


def cmd_read(_args) -> None:
    st = read_status()
    print(json.dumps(st, indent=2))
    print(f"\nestado={st['MachMd']} fase={st['PrPh']} restante={st['RemTime']}min "
          f"WiFiStatus={st['WiFiStatus']}")


def cmd_probe(_args) -> None:
    """Ask the write endpoint for nothing. Should error, not act."""
    url = f"http://{IP}/http-write.json?encrypted=1"
    print(f"GET {url}\n")
    body = fetch(url)
    print(f"crudo      : {body[:160]}")
    try:
        print(f"descifrado : {decrypt(body)}")
        print("\n=> el endpoint EXISTE y responde con nuestra clave")
    except Exception:
        print("\n=> respondio algo no descifrable con la clave de lectura")


def cmd_send(args) -> None:
    payload = encrypt(args.command)
    url = f"http://{IP}/http-write.json?encrypted=1&data={payload}"
    print(f"comando  : {args.command}")
    print(f"cifrado  : {payload}")
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


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("read").set_defaults(fn=cmd_read)
    sub.add_parser("probe").set_defaults(fn=cmd_probe)
    s = sub.add_parser("send")
    s.add_argument("command", help='e.g. "Write=1&StSt=1"')
    s.add_argument("--yes", action="store_true", help="actually transmit")
    s.add_argument("--force", action="store_true", help="allow while running")
    s.set_defaults(fn=cmd_send)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
