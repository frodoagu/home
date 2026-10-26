#!/usr/bin/env python3
"""
phrase_cues.py - Hot cues N bars before every phrase change (rekordbox 6/7).

Flow:
  master.db (read-only, via pyrekordbox)
    -> tracks of a playlist
    -> PSSI (.EXT): phrases detected by rekordbox (start beat + kind)
    -> PQTZ (.DAT): the actual beatgrid (time of every beat)
    -> rekordbox.xml with hot cues in the free A-H slots

Never writes to master.db. The XML is imported into rekordbox by hand.
Runs on macOS and Windows, wherever rekordbox is installed.

Requirements:
  pip install pyrekordbox          (tested against 0.5.0)
  Phrase analysis enabled and tracks re-analysed.

Usage:
  python phrase_cues.py --playlist "Psy 2026" --dry-run
  python phrase_cues.py --playlist "Psy 2026" --out phrase_cues.xml
  python phrase_cues.py --inspect "Track title"     # check the Kind mapping
"""
from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("phrase_cues")

SLOTS = "ABCDEFGH"

# djmdCue.Kind -> slot index (0=A ... 7=H). Kind 0 = memory cue.
# pyrekordbox's docs only say "hot cue number"; the exact mapping to letters is
# NOT confirmed. Check it with --inspect on a track with known cues.
KIND_MAPS = {
    # A-C = 1-3, 4 skipped (the variant found in reverse-engineering notes)
    "skip4": {1: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7},
    # linear A-H = 1-8
    "linear": {i + 1: i for i in range(8)},
}

# Labels per PSSI mood (1=high, 2=mid, 3=low). Source: the ANLZ format docs.
PHRASE_LABELS = {
    1: {1: "Intro", 2: "Up", 3: "Down", 5: "Chorus", 6: "Outro"},
    2: {1: "Intro", 2: "Verse1", 3: "Verse2", 4: "Verse3", 5: "Verse4",
        6: "Verse5", 7: "Verse6", 8: "Bridge", 9: "Chorus", 10: "Outro"},
    3: {1: "Intro", 2: "Verse1", 3: "Verse1", 4: "Verse1", 5: "Verse2",
        6: "Verse2", 7: "Verse2", 8: "Bridge", 9: "Chorus", 10: "Outro"},
}

# Hot cue RGB by destination phrase (the one that starts after the cue).
PHRASE_COLORS = {
    "Intro": (40, 226, 20),
    "Up": (255, 166, 0),
    "Verse": (255, 166, 0),
    "Down": (48, 90, 255),
    "Bridge": (48, 90, 255),
    "Chorus": (230, 40, 40),
    "Outro": (165, 165, 165),
}


@dataclass(frozen=True)
class Phrase:
    beat: int        # start beat, 1-based on the beatgrid
    label: str


@dataclass(frozen=True)
class NewCue:
    slot: int        # 0..7
    start_s: float
    name: str
    rgb: tuple[int, int, int]


def phrase_color(label: str) -> tuple[int, int, int]:
    for key, rgb in PHRASE_COLORS.items():
        if label.startswith(key):
            return rgb
    return (255, 255, 255)


def plan_cues(
    phrases: list[Phrase],
    beat_times: list[float],
    free_slots: list[int],
    offset_beats: int,
    merge_same: bool = True,
) -> tuple[list[NewCue], list[str]]:
    """Plan a cue for every phrase change. Returns (cues, dropped)."""
    phrases = sorted(phrases, key=lambda p: p.beat)

    # Changes = the start of every phrase but the first.
    changes: list[tuple[Phrase, Phrase]] = []
    for prev, cur in zip(phrases, phrases[1:]):
        if merge_same and prev.label == cur.label:
            continue  # Up -> Up adds nothing and saves a slot
        changes.append((prev, cur))

    candidates: list[tuple[float, str, Phrase]] = []
    dropped: list[str] = []
    for prev, cur in changes:
        target = cur.beat - offset_beats
        name = f"{prev.label}>{cur.label}"
        if target < 1 or target > len(beat_times):
            dropped.append(f"{name} @beat {cur.beat}: fuera del grid con el offset")
            continue
        candidates.append((beat_times[target - 1], name, cur))

    cues: list[NewCue] = []
    for slot, (t, name, cur) in zip(free_slots, candidates):
        cues.append(NewCue(slot, round(t, 3), name, phrase_color(cur.label)))
    for t, name, _ in candidates[len(free_slots):]:
        dropped.append(f"{name} @{t:.1f}s: sin slots libres")
    return cues, dropped


# ---------------------------------------------------------------------------
# rekordbox I/O
# ---------------------------------------------------------------------------

def read_phrases(db, content) -> list[Phrase] | None:
    ext = db.read_anlz_file(content, "EXT")
    if ext is None or "PSSI" not in ext:
        return None
    pssi = ext.get_tag("PSSI").content
    labels = PHRASE_LABELS.get(pssi.mood, {})
    return [
        Phrase(beat=e.beat, label=labels.get(e.kind, f"K{e.kind}"))
        for e in pssi.entries
    ]


def read_beat_times(db, content) -> list[float] | None:
    dat = db.read_anlz_file(content, "DAT")
    if dat is None or "PQTZ" not in dat:
        return None
    return [float(t) for t in dat.get_tag("PQTZ").get_times()]  # seconds


def existing_cues(db, content):
    from pyrekordbox.masterdb import models
    return (
        db.query(models.DjmdCue)
        .filter(models.DjmdCue.ContentID == content.ID)
        .order_by(models.DjmdCue.InMsec)
        .all()
    )


def copy_existing(track, cues, kind_map) -> set[int] | None:
    """Copy the existing cues into the XML so the import doesn't lose them.
    Returns the taken slots, or None on an unknown Kind."""
    used: set[int] = set()
    for c in cues:
        is_loop = c.OutMsec is not None and c.OutMsec > 0
        start = c.InMsec / 1000
        end = c.OutMsec / 1000 if is_loop else None
        mtype = "loop" if is_loop else "cue"
        if c.Kind == 0:
            track.add_mark(Name=c.Comment or "", Type=mtype, Start=start, End=end, Num=-1)
            continue
        slot = kind_map.get(c.Kind)
        if slot is None:
            return None
        used.add(slot)
        track.add_mark(Name=c.Comment or "", Type=mtype, Start=start, End=end, Num=slot)
    return used


def xml_location(folder_path: str) -> str:
    """Path to hand pyrekordbox for a track's Location.

    pyrekordbox prepends "file://localhost/" to the path as given, which suits
    Windows (C:/Music/x.mp3) but doubles the slash of a macOS absolute path
    (file://localhost//Users/...). rekordbox writes a single one, so drop it.
    """
    path = folder_path.replace("\\", "/")
    return path[1:] if path.startswith("/") else path


def get_playlist(db, name: str):
    pls = db.get_playlist(Name=name).all()
    if not pls:
        sys.exit(f"Playlist no encontrada: {name!r}")
    if len(pls) > 1:
        log.warning("Hay %d playlists llamadas %r, uso la primera", len(pls), name)
    return pls[0]


def cmd_inspect(db, title: str) -> int:
    rows = db.get_content(Title=title).all()
    if not rows:
        log.error("Track no encontrado: %r", title)
        return 1
    for content in rows:
        print(f"\n{content.Title}  ({content.FolderPath})")
        for c in existing_cues(db, content):
            print(f"  Kind={c.Kind:<2} t={c.InMsec / 1000:8.3f}s  comment={c.Comment!r}")
        phrases = read_phrases(db, content)
        if phrases:
            print("  Frases:", ", ".join(f"{p.label}@{p.beat}" for p in phrases))
    print("\nCompara Kind con las letras A-H que ves en rekordbox y elegi --kind-map.")
    return 0


def cmd_run(db, args) -> int:
    from pyrekordbox import RekordboxXml

    kind_map = KIND_MAPS[args.kind_map]
    offset_beats = args.offset_bars * 4
    xml = RekordboxXml(name="rekordbox", version="6.0.0", company="AlphaTheta")
    playlist = get_playlist(db, args.playlist)
    contents = db.get_playlist_contents(playlist).all()
    log.info("Playlist %r: %d tracks, offset %d compases", args.playlist, len(contents), args.offset_bars)

    stats = {"ok": 0, "repetidos": 0, "sin_frases": 0, "sin_grid": 0, "sin_slots": 0, "kind_raro": 0}
    seen: set[str] = set()
    for content in contents:
        title = f"{content.Title or '?'} [{content.ID}]"
        # The XML holds one entry per file, so a track listed twice is done once.
        if content.FolderPath in seen:
            log.info("%s: repetido en la playlist, ya procesado", title)
            stats["repetidos"] += 1
            continue
        seen.add(content.FolderPath)

        phrases = read_phrases(db, content)
        if not phrases:
            log.warning("%s: sin phrase analysis (PSSI), salteo", title)
            stats["sin_frases"] += 1
            continue
        beat_times = read_beat_times(db, content)
        if not beat_times:
            log.warning("%s: sin beatgrid (PQTZ), salteo", title)
            stats["sin_grid"] += 1
            continue

        track = xml.add_track(xml_location(content.FolderPath), Name=content.Title or "")
        used = copy_existing(track, existing_cues(db, content), kind_map)
        if used is None:
            log.error("%s: Kind de cue desconocido, salteo para no pisar nada", title)
            xml.remove_track(track)
            stats["kind_raro"] += 1
            continue

        free = [s for s in range(8) if s not in used]
        if not free:
            log.info("%s: A-H ocupados, nada que hacer", title)
            xml.remove_track(track)
            stats["sin_slots"] += 1
            continue

        cues, dropped = plan_cues(phrases, beat_times, free, offset_beats, not args.keep_same)
        for cue in cues:
            mark = track.add_mark(Name=cue.name, Type="cue", Start=cue.start_s, Num=cue.slot)
            r, g, b = cue.rgb
            mark._element.set("Red", str(r))   # add_mark doesn't take a colour
            mark._element.set("Green", str(g))
            mark._element.set("Blue", str(b))
            log.info("%s: %s @ %.2fs -> %s", title, cue.name, cue.start_s, SLOTS[cue.slot])
        for d in dropped:
            log.debug("%s: descartada %s", title, d)
        if dropped:
            log.info("%s: %d cambios sin cue (ver --verbose)", title, len(dropped))
        stats["ok"] += 1

    # An XML playlist, to select every track at once from the "rekordbox xml" tree
    node = xml.add_playlist("phrase_cues")
    for t in xml.get_tracks():
        node.add_track(t.TrackID)

    log.info("Resumen: %s", stats)
    if args.dry_run:
        log.info("Dry run: no se escribio el XML")
        return 0
    xml.save(args.out)
    log.info("XML escrito en %s", Path(args.out).resolve())
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--playlist", help="Playlist a procesar")
    mode.add_argument("--inspect", metavar="TITLE", help="Mostrar cues y frases de un track")
    p.add_argument("--offset-bars", type=int, default=4, help="Compases antes del cambio (default 4)")
    p.add_argument("--kind-map", choices=KIND_MAPS, default="skip4", help="Mapeo djmdCue.Kind -> A-H")
    p.add_argument("--keep-same", action="store_true", help="No fusionar frases iguales consecutivas")
    p.add_argument("--out", default="phrase_cues.xml")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        from pyrekordbox import MasterDatabase
    except ImportError:
        sys.exit("Falta pyrekordbox: pip install pyrekordbox")

    try:
        db = MasterDatabase()
    except Exception as exc:  # SQLCipher key, path, rekordbox running, etc.
        log.error("No pude abrir master.db: %s", exc)
        return 2

    try:
        return cmd_inspect(db, args.inspect) if args.inspect else cmd_run(db, args)
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())