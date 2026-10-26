# scripts/

Standalone CLIs run **by hand** from a workstation. Nothing here is deployed by
Argo CD or called by a chart.

| Script | What it does | Runs against |
|---|---|---|
| [`candyctl.py`](#candyctlpy) | Read and drive the Candy washer-dryer over its local HTTP API | `lavarropas.lan` on the LAN |
| [`phrase_cues.py`](#phrase_cuespy) | Write rekordbox hot cues N bars before every phrase change | rekordbox's local `master.db` |

Both are single-file Python 3 scripts. `candyctl.py` uses only the standard
library; `phrase_cues.py` needs [`pyrekordbox`](https://github.com/dylanljones/pyrekordbox).

---

## candyctl.py

Control CLI for the Candy simply-Fi washer-dryer. It reads the appliance's
status, maps the dial to program numbers, and sends write commands. The
protocol, the program table and the device's quirks are in
[docs/lavarropas-candy.md](../docs/lavarropas-candy.md) (§2 for the XOR layer,
§8 for writing).

### Requirements

- Python 3, no third-party packages.
- A machine on the LAN that resolves `lavarropas.lan` (Pi-hole's DHCP
  reservation, see [docs/pihole.md](../docs/pihole.md)).
- The appliance powered on with Wi-Fi enabled (`WiFiStatus: 1`). Its Wi-Fi
  module powers down with it.

### Usage

```text
candyctl.py read
candyctl.py probe
candyctl.py learn [--interval SECONDS]
candyctl.py send COMMAND [--yes] [--force] [--plain] [--xor]
candyctl.py stop [--yes] [--force]
```

| Subcommand | Effect | Transmits a write? |
|---|---|---|
| `read` | Prints the decoded `statusLavatrice` JSON plus a one-line summary (state, phase, minutes left, Wi-Fi status). | No |
| `probe` | Sends an empty request to `/http-write.json` and prints the reply. Proves only that the endpoint is routed. | Empty request |
| `learn` | Polls the status and prints a row every time a dial-driven field changes (`Pr`, `SLevel`, `Temp`, `SpinSp`, `DryT`, `Opt1-3`). Survives the appliance turning off. Ctrl-C to finish. | No |
| `send COMMAND` | Builds the write URL for `COMMAND`. Without `--yes` it prints the URL and stops. With `--yes` it snapshots the status, sends, waits 4 s, reads again and prints the field diff. | Only with `--yes` |
| `stop` | `send "Write=1&StSt=0"` with `--force` implied: cancels a running cycle or an armed delayed start. | Only with `--yes` |

| Option | Applies to | Meaning |
|---|---|---|
| `--interval SECONDS` | `learn` | Poll period, default `5.0`. |
| `--yes` | `send`, `stop` | Actually transmit. Without it the command is a dry run. |
| `--force` | `send` | Allow a write while a cycle is running (`MachMd=2`). `stop` always allows it. |
| `--plain` | `send` | Send the parameters as a query string with `encrypted=0`. The appliance answers `BAD REQUEST`; kept for re-checking. |
| `--xor` | `send` | XOR the command under the read key before hex-encoding. Accepted and ignored by the appliance; kept for re-checking. |

The default form, the only one that works, is `encrypted=1&data=<hex of the
plain command>`.

### Examples

```bash
# Current status
scripts/candyctl.py read

# Map the dial: run this, turn the dial through every program, note what the
# panel shows on each printed row, then Ctrl-C
scripts/candyctl.py learn --interval 2

# Dry run: show the URL for "long cottons, 30 °C, 800 rpm" without sending it
scripts/candyctl.py send "Write=1&PrNm=6&TmpTgt=30&SpdTgt=8"

# Select that program (no start) and check the diff
scripts/candyctl.py send "Write=1&PrNm=6&TmpTgt=30&SpdTgt=8" --yes

# Select and start in one command
scripts/candyctl.py send "Write=1&PrNm=6&TmpTgt=30&SpdTgt=8&StSt=1" --yes

# Cancel the running cycle or a delayed start
scripts/candyctl.py stop --yes
```

Output of `send --yes` ends with the field diff, which is the only proof the
command landed:

```text
estado antes : MachMd=1 PrPh=0 RemTime=117
respuesta    : 1A47...
descifrada   : {"response":"SUCCESS"}
estado despues: MachMd=1 PrPh=0 RemTime=232
cambios      : {'Pr': ('2', '6'), 'RemTime': ('117', '232'), ...}
```

### Things to know

- **`SUCCESS` means nothing.** `/http-write.json` answers `SUCCESS` to every
  request, valid or not. Trust the `cambios` line, not the reply.
- **Overrides ride in the same command as `PrNm`.** `PrNm` loads the program's
  default recipe and overwrites temperature, spin and soil level, so
  `TmpTgt`/`SpdTgt`/`Dry` must come after it in one `send`.
- **Write names differ from read names** (`PrNm`→`Pr`, `TmpTgt`→`Temp`,
  `SpdTgt`→`SpinSp`, `Dry`→`DryT`). Table in
  [docs/lavarropas-candy.md §8.2](../docs/lavarropas-candy.md#82-parameters).
- **Don't fire writes in a burst.** Back-to-back writes wedge the Wi-Fi module
  until a power cycle. Space them out.
- **One connection at a time.** The appliance drops concurrent requests, so
  every fetch retries 4× with a 3 s pause. Home Assistant's
  `packages/lavarropas.yaml` polls the same endpoint and can collide with it.
- Replies may come back XOR'd or as plain hex depending on the endpoint and the
  firmware's mood; `decrypt()` checks for a plain `{` first.

---

## phrase_cues.py

Adds a hot cue **N bars before every phrase change** in the tracks of a
rekordbox playlist, using rekordbox's own phrase analysis. The result is a
`rekordbox.xml` file that you import by hand; the script never writes to
`master.db`.

Each cue is named `<from>><to>` (e.g. `Up>Down`) and coloured by the phrase it
leads into, so on the deck you see what's coming before it arrives.

### How it works

```text
master.db (read-only, via pyrekordbox)
  -> tracks of the playlist
  -> PSSI tag (.EXT file): phrases detected by rekordbox (start beat + kind)
  -> PQTZ tag (.DAT file): the beatgrid (time of every beat)
  -> rekordbox.xml with hot cues in the free A-H slots
```

1. For each track, read the phrases (PSSI) and the beatgrid (PQTZ). Tracks
   missing either are skipped.
2. Copy the track's existing memory cues, hot cues and loops into the XML, so
   the import doesn't drop them. Their slots count as taken.
3. Every phrase start except the first is a change. Consecutive phrases with
   the same label are merged (`Up` → `Up` gets no cue) unless `--keep-same`.
4. The cue goes `--offset-bars × 4` beats before the change (4/4 assumed),
   snapped to the beatgrid. Changes that land before the first beat are dropped.
5. Cues fill the free slots in order. Once A-H are full, the remaining changes
   are dropped (listed with `-v`).
6. All processed tracks also go into an XML playlist named `phrase_cues`.

Phrase labels depend on the track's mood as rekordbox detected it:

| Mood | Labels |
|---|---|
| High | Intro, Up, Down, Chorus, Outro |
| Mid | Intro, Verse1-6, Bridge, Chorus, Outro |
| Low | Intro, Verse1-2, Bridge, Chorus, Outro |

Cue colour by destination phrase:

| Leads into | Colour |
|---|---|
| Intro | green |
| Up, Verse* | orange |
| Down, Bridge | blue |
| Chorus | red |
| Outro | grey |

rekordbox only has a fixed hot cue palette, so it may snap these RGB values to
the nearest colour it offers.

### Requirements

- rekordbox 6 or 7 installed on the same machine (macOS or Windows), with
  **phrase analysis enabled** and the playlist's tracks **re-analysed** after
  turning it on. Without that, tracks have no PSSI tag and are skipped.
- Python 3.11+ (pyrekordbox's minimum) and `pip install pyrekordbox` (tested
  against 0.5.0).
  pyrekordbox finds `master.db` through rekordbox's own settings and needs the
  database key; see its docs if opening the database fails.

### Usage

Run it on the machine where rekordbox is installed. The examples say `python`;
on macOS that's usually `python3`.

```text
phrase_cues.py (--playlist NAME | --inspect TITLE)
               [--offset-bars N] [--kind-map {skip4,linear}]
               [--keep-same] [--out FILE] [--dry-run] [-v]
```

| Option | Default | Meaning |
|---|---|---|
| `--playlist NAME` | — | Playlist to process. If several share the name, the first one is used (with a warning). |
| `--inspect TITLE` | — | Print the existing cues (`Kind`, time, comment) and the phrases of every track titled `TITLE`, then exit. Writes nothing. |
| `--offset-bars N` | `4` | Bars before the phrase change where the cue goes. |
| `--kind-map MAP` | `skip4` | How `djmdCue.Kind` maps to slots A-H (see below). |
| `--keep-same` | off | Also cue changes between phrases with the same label. |
| `--out FILE` | `phrase_cues.xml` | Where to write the XML. |
| `--dry-run` | off | Do everything and log the planned cues, but don't write the XML. |
| `-v`, `--verbose` | off | Debug logging, including every dropped change and why. |

Exactly one of `--playlist` or `--inspect` is required.

Exit codes: `0` on success, `1` if `--inspect` finds no track, `2` if
`master.db` can't be opened.

### First run: pick the right `--kind-map`

> [!WARNING]
> **The `Kind` → letter mapping is unconfirmed.** Check it before importing
> anything, or the import can move your existing hot cues and overwrite them.

In `master.db`, every cue is a row of the `djmdCue` table, and its `Kind`
column says what it is: `0` is a memory cue, any other number is a hot cue and
names its slot. Which number is which letter isn't documented anywhere. The
script ships two candidates:

| Map | Kind → slot |
|---|---|
| `skip4` (default) | 1,2,3 → A,B,C; 5,6,7,8,9 → D,E,F,G,H (4 unused). The variant found in reverse-engineering notes. |
| `linear` | 1-8 → A-H |

The mapping matters because the XML import replaces a track's cues with the
ones in the XML. The script copies your existing cues into the XML under the
letter the map gives them, and puts new cues only in the letters it believes
are free. With the wrong map:

- an existing hot cue lands in the XML under another letter, so after the
  import it has moved (e.g. your D shows up on E);
- a new phrase cue goes into a letter the map thinks is free but that holds
  one of yours, and replaces it.

Confirm it once:

1. In rekordbox, pick a track and set hot cues on known slots, e.g. A, D and H.
2. Run `--inspect` on it and compare the `Kind` numbers with those letters.
3. Use the map that matches. A track whose cues have a `Kind` the map doesn't
   know is skipped entirely, never overwritten.

```bash
python phrase_cues.py --inspect "Test Track"
```

```text
Test Track  (/Users/me/Music/Test Track.mp3)
  Kind=1  t=   0.512s  comment='Drop'
  Kind=5  t=  64.110s  comment=''
  Kind=9  t= 180.004s  comment=''
  Frases: Intro@1, Up@65, Down@193, Chorus@257, Outro@513
```

With cues on A, D and H, output like this (A→1, D→5, H→9) means `skip4`;
1, 4, 8 would mean `linear`.

### Examples

```bash
# See what would be added, without writing anything
python phrase_cues.py --playlist "Psy 2026" --dry-run

# Same, with every dropped change explained
python phrase_cues.py --playlist "Psy 2026" --dry-run -v

# Write the XML with the default 4-bar lead
python phrase_cues.py --playlist "Psy 2026" --out phrase_cues.xml

# 8 bars of warning, linear Kind mapping
python phrase_cues.py --playlist "Psy 2026" --offset-bars 8 --kind-map linear

# Don't merge repeated labels (Verse1 > Verse1 gets a cue too)
python phrase_cues.py --playlist "Psy 2026" --keep-same
```

A run logs one line per cue and a summary:

```text
14:02:11 INFO    Playlist 'Psy 2026': 24 tracks, offset 4 compases
14:02:11 INFO    Track A [123456]: Intro>Up @ 19.86s -> B
14:02:11 INFO    Track A [123456]: Up>Down @ 72.83s -> D
14:02:11 INFO    Track A [123456]: 2 cambios sin cue (ver --verbose)
14:02:12 WARNING Track B [234567]: sin phrase analysis (PSSI), salteo
14:02:13 INFO    Resumen: {'ok': 22, 'repetidos': 0, 'sin_frases': 1, 'sin_grid': 0, 'sin_slots': 1, 'kind_raro': 0}
14:02:13 INFO    XML escrito en /Users/me/phrase_cues.xml
```

Summary counters: `ok` processed, `repetidos` listed more than once in the
playlist (processed once), `sin_frases` no phrase analysis, `sin_grid` no
beatgrid, `sin_slots` A-H already full, `kind_raro` unknown cue `Kind` (skipped
to avoid overwriting).

### Importing into rekordbox

1. **Back up** your rekordbox library first (File > Library > Backup Library).
2. Preferences > View > Layout: enable **rekordbox xml** in the tree.
3. Preferences > Advanced > Database > rekordbox xml: point **Imported Library**
   at the generated XML.
4. In the tree, open **rekordbox xml > Playlists > phrase_cues**, select all
   tracks, right-click > **Import To Collection**, and accept if rekordbox asks
   to overwrite the tracks already in the collection.
5. Check a couple of tracks on the deck. The new cues sit in the slots that
   were free; your existing cues are unchanged.

### Things to know

- The script only reads `master.db`. If something looks wrong, delete the XML
  and run again; nothing in rekordbox changed until you import.
- Re-running on a playlist that already has phrase cues treats them as existing
  cues: they're copied, their slots are taken, and new cues only go in what's
  left. To redo them, delete the old ones in rekordbox first.
- Track locations are written the way rekordbox writes them on each OS
  (`file://localhost/Users/...` on macOS, `file://localhost/C:/...` on
  Windows), so the import matches the tracks already in the collection.
- The 4-beats-per-bar assumption suits psytrance and most dance music; tracks
  in another meter get cues at the wrong distance.
