"""Europe's weather radars, single-site, from EUMETNET OPERA's Open Radar Data.

The open bucket (s3.waw3-1.cloudferro.com/openradar-24h, no key, CC BY 4.0) keeps 24
hours of what 21 countries' radars send in ODIM_H5. The names tell what is inside:

    <day>/<country>/<code>/SCAN/fianj@20261102T1655@1.5@DBZH_TH_VRADH.h5
    <day>/<country>/<code>/PVOL/nohur@20261102T1650@0.5_1.0_1.6@DBZH.h5

Mostly reflectivity and velocity; dual-pol only where a country already sends it (the
Netherlands, Estonia, Croatia, Denmark). A file is 50 kB to 27 MB, so nothing is fetched
until it is looked at.

To the viewer these are more radars like BR-PNV (brazil_radar.py reads ODIM and makes
every product): site "EU-FIANJ", key "L2BR:<stamp>". But no country's files add up to
a volume in five minutes. France flies one tilt a minute over a 15 minute cycle, low
tilts every 5; Norway alternates two sets of tilts, with velocity every 10 minutes and
its own tilts; Hungary sends velocity every 15; Spain a long range and a Doppler range
file of the same angles; Ireland reflectivity under SCAN and velocity under PVOL. So
this module, through brazil_radar.REMOTE:

- Keeps an index of the files from their names alone, per hour and folder (_entries).
  The product list comes from it, with nothing downloaded (inventory).
- Gives each elevation a slot for good, kept in STORE/<radar>/slots.json (_slot_of).
  The product code L2B3 means "that angle" on every frame, whatever the file it is in.
- Calls a 5 minute bin with a file in it a frame. The frame holds, of each kind of file
  seen in the 30 minutes up to the bin's end, the newest (_frame): every tilt and moment
  the radar is flying, some minutes older, the sweep's own time saying so. Thirty as a
  file can land long after the time in its name: Ireland's velocity, 13 minutes.
- Merges them so each moment has one source per tilt: the longest range, then the
  newest (volume). A loop on one tilt reads only that tilt's files, through
  _read_odim's filters: France's whole frame is 17 files, the Netherlands' one is 27 MB.

Files live once in STORE/<radar>/files/<folder>/ and are shared by frames. Radars gone
quiet are found by a light check in the background (_probe) and listed as offline.
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import statistics
import sys
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Collection, NamedTuple, Optional

import h5py
import numpy as np
import requests
from PIL import Image
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import brazil_radar
from brazil_radar import SLOTS, NoData, Sweep, Volume

BUCKET = "https://s3.waw3-1.cloudferro.com/openradar-24h"
PREFIX = "EU-"
BIN_S = 300
# How far back a frame looks for a kind of file: what must still be there when a frame
# opens. The slowest thing flown is a 15 minute cycle (France's high tilts, Ireland's and
# Hungary's velocity), and Ireland's velocity lands 13 minutes after the time in its name.
LOOKBACK_S = 30 * 60
# The bucket keeps a day; a file is dropped here a little after.
BUCKET_S = 24 * 3600
KEEP_S = 30 * 3600
# How long a listing of an unfinished hour stands, and when an hour counts as finished:
# files land some minutes after the time in their name, up to 20 (Lithuania).
LIST_TTL_S = 45
FINISHED_S = 3600 + 25 * 60
FOLDERS_TTL_S = 3600
# In a day's first half hour a folder the table does not know may just have nothing in it yet.
FOLDERS_EARLY_S = 1800
FOLDERS_EARLY_TTL_S = 60
# What the product list reads: a recent stretch, wide enough for the slowest cycle.
INVENTORY_S = 90 * 60
# Nothing for this long and a radar counts as offline.
QUIET_S = 3 * 3600
PROBE_EVERY_S = 600
PRUNE_EVERY_S = 600
# All the radars together: one Dutch file is 22 MB, a day of that radar alone about 6 GB.
# The oldest files go first; they come back from the bucket if asked for again.
MAX_STORE_BYTES = 4 * 1024 ** 3
# A .part this young is a download still on its way to os.replace.
PART_KEEP_S = 300
# Hungary's measured elevations jitter (0.01 0.0, 0.52 0.49, 1.15 1.08): one tilt.
SLOT_TOL = 0.15
# 90 degrees is a birdbath (Norway, France, the Netherlands, Ireland), not a map.
MAX_ELEV = 60.0
# Moments of one tilt this near in time are one sweep; further apart, each keeps its time.
SAME_SWEEP_S = 150
# Ranges this close are the same range (a gate more or less between files).
SAME_RANGE = 0.05
# A frame's files can still change this long after it began (kept from the browser's cache).
YOUNG_S = 25 * 60
# What a whole frame reads: the quality fields the viewer never shows stay on disk.
VIEWED = frozenset({"DBZH", "TH", "VRAD", "WRAD", "ZDR", "RHOHV", "KDP", "PHIDP"})
WORKERS = 6
LIST_WORKERS = 8
PROBE_WORKERS = 8

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app; https://weatherts.tech)"
# Every thread below keeps its connection: a new one costs a TLS handshake (fast_tls.py).
# The bucket drops an idle one now and then, and that is no reason to fail a product list.
_SESSION.mount("https://", HTTPAdapter(
    pool_connections=2, pool_maxsize=WORKERS + LIST_WORKERS + PROBE_WORKERS,
    max_retries=Retry(total=2, read=1, status=1, backoff_factor=0.2, status_forcelist=(500, 502, 503, 504), allowed_methods=("GET",),
                      raise_on_status=False),
))
_NAME = re.compile(r"^([a-z0-9]+)@(\d{8}T\d{4})@([^@]+)@([A-Z0-9_]+)\.h5$")
_LOCK = threading.Lock()
_POOL = ThreadPoolExecutor(WORKERS)
# Listings have their own threads: a product list must not queue behind a 27 MB download.
_LIST_POOL = ThreadPoolExecutor(LIST_WORKERS)


class Entry(NamedTuple):
    """One file of the bucket, as its name tells it."""
    name: str
    folder: str
    unix: int
    elevs: tuple[float, ...]    # without the birdbath
    moments: tuple[str, ...]    # brazil_radar's names: VRADH is VRAD


_HOURS: dict[tuple[str, str, str], tuple[float, list[Entry]]] = {}
_FOLDERS: dict[tuple[str, str], tuple[float, list[str]]] = {}
_SLOTS: dict[str, list[float]] = {}
_FETCHING: dict[Path, Future] = {}
_PRUNED: dict[str, float] = {}


def _table() -> dict[str, dict[str, Any]]:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "data" / "opera_radars.json"
    return {PREFIX + r["code"].upper(): r for r in json.loads(base.read_text(encoding="utf-8"))}


TABLE = _table()


def handles(radar: str) -> bool:
    return str(radar or "").upper().startswith(PREFIX)


def sites() -> list[dict]:
    _probe_soon()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = []
    for rid, r in TABLE.items():
        quiet = _QUIET.get(rid, False)
        out.append({
            "id": rid, "icao": rid[len(PREFIX):], "name": f"{r['name']} · {r['op']}".strip(" ·"), "lat": r["lat"], "lon": r["lon"],
            "country": r["cc"], "online": not quiet, "operator": r["op"], "band": r["band"], "live": not quiet, "type": "OPERA",
            "lastScanDay": (brazil_radar._day(_LAST.get(rid)) if quiet else None) or today,
        })
    return out


# ------------------------------------------------------------------ the file index ---

def _parse(folder: str, name: str) -> Optional[Entry]:
    m = _NAME.match(name)
    if not m:
        return None
    unix = int(datetime.strptime(m.group(2), "%Y%m%dT%H%M").replace(tzinfo=timezone.utc).timestamp())
    elevs = []
    for e in m.group(3).split("_"):
        try:
            elevs.append(float(e))
        except ValueError:
            pass
    elevs = [e for e in elevs if e < MAX_ELEV]
    if not elevs:
        return None
    moments = sorted({brazil_radar._ODIM_MOMENTS.get(q, q) for q in m.group(4).split("_")})
    return Entry(name, folder, unix, tuple(elevs), tuple(moments))


def _folders(radar: str, when: datetime) -> list[str]:
    """The folders a radar's files are in that day. Ireland has two, and any radar
    can gain one, so the table's list is only what to fall back on. A radar no longer
    in the table (a saved session's) has none: no files, nothing to raise."""
    r = TABLE.get(radar)
    if r is None:
        return []
    day = when.strftime("%Y/%m/%d")
    key = (radar, day)
    now = time.time()
    with _LOCK:
        hit = _FOLDERS.get(key)
    early = now - when.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() < FOLDERS_EARLY_S
    if hit and now - hit[0] < (FOLDERS_EARLY_TTL_S if early else FOLDERS_TTL_S):
        return hit[1]
    try:
        res = _SESSION.get(f"{BUCKET}/", params={"list-type": 2, "prefix": f"{day}/{r['cc']}/{r['code']}/", "delimiter": "/",
                                                 "max-keys": 20}, timeout=(8, 30))
        res.raise_for_status()
    except requests.RequestException:
        return hit[1] if hit else r["folders"]
    found = re.findall(r"<CommonPrefixes><Prefix>[^<]*/([^/<]+)/</Prefix>", res.text)
    # With the table's, not instead of them: Ireland's velocity lands 13 minutes late, so
    # at 00:03Z its folder is not there yet, and an empty folder costs one short listing.
    out = sorted({*found, *r["folders"]})
    with _LOCK:
        _FOLDERS[key] = (now, out)
        for k in [k for k, v in _FOLDERS.items() if now - v[0] > KEEP_S]:
            _FOLDERS.pop(k, None)
    return out


def _list_hour(radar: str, folder: str, hour: datetime) -> list[Entry]:
    """The files of one hour of one folder. A finished hour is read once."""
    r = TABLE[radar]
    code = r["code"]
    stamp = hour.strftime("%Y%m%dT%H")
    key = (radar, folder, stamp)
    now = time.time()
    with _LOCK:
        hit = _HOURS.get(key)
    if hit and (hit[0] - hour.timestamp() > FINISHED_S or now - hit[0] < LIST_TTL_S):
        return hit[1]
    prefix = f"{hour:%Y/%m/%d}/{r['cc']}/{code}/{folder}/{code}@{stamp}"
    entries: list[Entry] = []
    token = None
    try:
        while True:
            params: dict[str, Any] = {"list-type": 2, "prefix": prefix, "max-keys": 1000}
            if token:
                params["continuation-token"] = token
            res = _SESSION.get(f"{BUCKET}/", params=params, timeout=(8, 30))
            res.raise_for_status()
            for k in re.findall(r"<Key>([^<]+)</Key>", res.text):
                e = _parse(folder, k.rsplit("/", 1)[-1])
                if e:
                    entries.append(e)
            more = re.search(r"<NextContinuationToken>([^<]+)<", res.text)
            if not more:
                break
            token = more.group(1)
    except requests.RequestException:
        # The bucket out of reach: what was listed stands, as a frame whose files
        # are here needs nothing from it. Only an hour never seen has nothing to say.
        if hit:
            return hit[1]
        raise
    with _LOCK:
        _HOURS[key] = (now, entries)
        for k in [k for k, v in _HOURS.items() if now - v[0] > KEEP_S]:
            _HOURS.pop(k, None)
    return entries


def _entries(radar: str, start: float, end: Optional[float] = None) -> list[Entry]:
    """Every file from `start` to `end` (now), oldest first. No further back than the
    bucket reaches: a moment a year ago would list every hour from then to now, and
    hold up every other radar's list on these threads meanwhile."""
    now = time.time()
    end = end or now
    start = max(start, now - KEEP_S)
    if end < start:
        return []
    hours = [
        datetime.fromtimestamp(t, tz=timezone.utc)
        for t in range(int(start // 3600) * 3600, int(end // 3600) * 3600 + 1, 3600)
    ]
    jobs = [(folder, h) for h in hours for folder in _folders(radar, h)]
    out: list[Entry] = []
    for entries in _LIST_POOL.map(lambda j: _list_hour(radar, j[0], j[1]), jobs):
        out += [e for e in entries if start <= e.unix <= end]
    out.sort(key=lambda e: e.unix)
    return out


# ------------------------------------------------------------------------ the slots ---

def _slot_file(radar: str) -> Path:
    return brazil_radar.STORE / radar / "slots.json"


def _save_slots(radar: str, table: list[float]) -> None:
    path = _slot_file(radar)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.part")
        tmp.write_text(json.dumps(table), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def _first_slots(radar: str) -> list[float]:
    """A radar seen for the first time: the angles it has flown lately, low to high, so
    that slot 0, where the viewer opens, is its lowest tilt and not whatever France
    happened to fly first (7.5 degrees)."""
    now = time.time()
    entries = _entries(radar, now - QUIET_S) or _entries(radar, now - KEEP_S)
    table: list[float] = []
    group: list[float] = []
    # By the gap to the last angle, so that a jitter chain is one tilt: Toulouse's one
    # tilt is measured at 9.43, 9.48, 9.52 and 9.6 within three hours.
    for el in sorted(el for e in entries for el in e.elevs):
        if group and el - group[-1] > SLOT_TOL:
            table.append(round(statistics.median(group), 2))
            group = []
        group.append(el)
    if group:
        table.append(round(statistics.median(group), 2))
    return table[:len(SLOTS)]


def _slot_table(radar: str) -> list[float]:
    """The elevation of each slot of a radar. Only ever added to: a slot means one angle
    for good, on disk across restarts, as what the viewer holds is a product code."""
    with _LOCK:
        table = _SLOTS.get(radar)
    if table is not None:
        return table
    try:
        table = [float(e) for e in json.loads(_slot_file(radar).read_text(encoding="utf-8"))]
    except (OSError, ValueError, TypeError):
        table = _first_slots(radar)
        if not table:
            return []       # nothing to go on yet: asked again when something comes
    # Two threads can get here at once: only the table that stays goes to disk.
    with _LOCK:
        kept = _SLOTS.setdefault(radar, table)
    if kept is table:
        _save_slots(radar, table)
    return kept


def _nearest_slot(table: list[float], elev: float) -> Optional[int]:
    best = min(range(len(table)), key=lambda i: abs(table[i] - elev), default=None)
    return best if best is not None and abs(table[best] - elev) <= SLOT_TOL else None


def _slot_of(radar: str, elev: float) -> Optional[int]:
    """The slot of an elevation; an angle not seen before takes the next free one
    (at the end, as the others stay). None when all are taken: not shown."""
    table = _slot_table(radar)
    slot = _nearest_slot(table, elev)
    if slot is not None:
        return slot
    with _LOCK:
        table = _SLOTS.setdefault(radar, table)
        slot = _nearest_slot(table, elev)
        if slot is None and len(table) < len(SLOTS):
            table.append(round(elev, 2))
            slot = len(table) - 1
            _save_slots(radar, table)
    return slot


def _slots_of(radar: str, e: Entry) -> list[int]:
    return [s for s in (_slot_of(radar, el) for el in e.elevs) if s is not None]


# ------------------------------------------------------------------- what is flying ---

def _bins(radar: str, start: float, end: Optional[float] = None) -> list[int]:
    return sorted({e.unix // BIN_S * BIN_S for e in _entries(radar, start, end)})


def scans(radar: str, limit: int = 0, start: Optional[int] = None) -> list[dict]:
    now = time.time()
    keys = _bins(radar, float(start) if start else now - max(QUIET_S, limit * BIN_S))
    # Quiet: as the radar list says, nothing to loop over, however long the loop asked for.
    if not start and (not keys or now - keys[-1] > QUIET_S):
        return []
    # From a start the loop runs forward, so the first frames; the newest would be
    # hours past the window asked for.
    if limit:
        keys = keys[:limit] if start else keys[-limit:]
    return _rows(keys)


def _rows(keys: list[int]) -> list[dict]:
    return [{"key": f"L2BR:{brazil_radar._stamp(t)}", "time": t} for t in keys]


def day_scans(radar: str, date: str) -> list[dict]:
    """The frames of one UTC day ("2026-11-02") as far as the bucket reaches: none for a
    day outside it, for the viewer to say so rather than play today's under that date."""
    try:
        day = int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return []
    return _rows(_bins(radar, day, min(day + 86399, time.time())))


def nearest(radar: str, at: Optional[int] = None) -> Optional[str]:
    """The stamp of the newest frame, or of the one nearest `at`."""
    if at:
        keys = _bins(radar, at - 1800, at + 1800)
        return brazil_radar._stamp(min(keys, key=lambda t: abs(t - at))) if keys else None
    keys = _bins(radar, time.time() - QUIET_S)
    return brazil_radar._stamp(keys[-1]) if keys else None


def last_seen(radar: str) -> Optional[int]:
    """When a radar's newest file in the bucket was made; None when it has none."""
    now = time.time()
    for back in range(0, 30, 6):
        entries = _entries(radar, now - (back + 6) * 3600, now - back * 3600)
        if entries:
            return entries[-1].unix
    return None


def quiet_note(radar: str, last: Optional[int] = None, at: Optional[float] = None) -> str:
    """What to tell someone looking at a radar that has stopped sending. Of a past
    moment (`at`) with no frame, that says nothing about the radar: it may be sending
    now, and the bucket may just not reach back that far."""
    if at:
        if time.time() - at > BUCKET_S:
            return "The European radars' open data only reaches 24 hours back"
        return "No data from this radar at that time"
    last = last or last_seen(radar)
    if not last:
        return "No data from this radar in the last 24 hours"
    when = datetime.fromtimestamp(last, tz=timezone.utc)
    today = when.date() == datetime.now(timezone.utc).date()
    return f"No data from this radar since {when:%H:%M}Z" if today else f"No data from this radar since {when:%H:%M}Z yesterday"


def inventory(radar: str, at: Optional[int] = None) -> dict:
    """What a radar is flying, from the file names of a recent stretch and nothing
    else: {"tilts": [(slot, elevation, moments)] low to high, "newest": frame time or
    None, "lastSeen": unix or None, "note": why there is nothing}."""
    ref = float(at) if at else time.time()
    end = ref + 600 if at else ref
    # Slow to send of late but not quiet: what the radar list and the loop still show.
    entries = _entries(radar, ref - INVENTORY_S, end) or _entries(radar, ref - QUIET_S, end)
    if not entries:
        last = last_seen(radar)
        # Of a past moment this says nothing about now: the bucket may just not reach it.
        return {"tilts": [], "newest": None, "lastSeen": last, "note": None if at else quiet_note(radar, last)}
    flown: dict[int, set[str]] = {}
    for e in entries:
        for s in _slots_of(radar, e):
            flown.setdefault(s, set()).update(e.moments)
    table = _slot_table(radar)
    return {
        "tilts": [(s, table[s], flown[s]) for s in sorted(flown, key=lambda s: table[s])],
        "newest": entries[-1].unix // BIN_S * BIN_S, "lastSeen": entries[-1].unix, "note": None,
    }


# ----------------------------------------------------------------------- the frames ---

def _frame(radar: str, t: int) -> list[Entry]:
    """The files of the frame at `t`: of each kind of file (its tilts and moments) seen
    in the LOOKBACK_S up to the end of the bin, the newest."""
    end = t + BIN_S
    newest: dict[tuple, Entry] = {}
    for e in _entries(radar, end - LOOKBACK_S, end - 1):
        newest[(tuple(sorted(set(_slots_of(radar, e)))), e.moments)] = e
    return list(newest.values())


def _needed(radar: str, frame: list[Entry], slot: Optional[int], moments: Optional[Collection[str]]) -> list[Entry]:
    """The files of a frame that can hold this tilt (None: any) and these moments."""
    out = []
    for e in frame:
        if slot is not None and slot not in _slots_of(radar, e):
            continue
        if moments is not None and not set(moments) & set(e.moments):
            continue
        out.append(e)
    return out


def parts(radar: str, stamp: str, slot: Optional[int] = None, moments: Optional[Collection[str]] = None) -> tuple[str, ...]:
    """The file names `volume` would read now: asks nothing of the disk, and differs
    from one call to the next when a young frame has gained or replaced a file."""
    picked = _needed(radar, _frame(radar, brazil_radar._stamp_unix(stamp)), slot, moments)
    return tuple(sorted(e.name for e in picked))


def _path(radar: str, e: Entry) -> Path:
    return brazil_radar.STORE / radar / "files" / e.folder / e.name


def _download(url: str, target: Path) -> str:
    """"ok", "gone" (no longer in the bucket) or "failed"."""
    for attempt in (1, 2):
        try:
            r = _SESSION.get(url, timeout=(8, 90))
            if r.status_code == 404:
                return "gone"
            r.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 2:
                return "failed"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".part")
        tmp.write_bytes(r.content)
        os.replace(tmp, target)
    except OSError:
        return "failed"
    return "ok"


def _prune(radar: str) -> None:
    """Files past what the bucket keeps, and any folder of the layout before slots."""
    now = time.time()
    cut = now - KEEP_S
    root = brazil_radar.STORE / radar
    try:
        for d in root.iterdir():
            if d.is_dir() and re.fullmatch(r"\d{14}", d.name):
                shutil.rmtree(d, ignore_errors=True)
        folders = [d for d in (root / "files").iterdir() if d.is_dir()] if (root / "files").is_dir() else []
        for d in folders:
            for p in d.iterdir():
                # One file in use (Windows will not delete it) must not end the round.
                try:
                    if p.name.endswith(".part"):
                        if now - p.stat().st_mtime > PART_KEEP_S:
                            p.unlink(missing_ok=True)
                        continue
                    e = _parse(d.name, p.name)
                    if e is None or e.unix < cut:
                        p.unlink(missing_ok=True)
                except OSError:
                    continue
    except OSError:
        pass
    _cap_store(now)


_capped_at = 0.0


def _cap_store(now: float) -> None:
    """Time alone does not limit the disk. Past MAX_STORE_BYTES, the oldest files of all
    the radars go, by the time in their names, whichever radar they are of."""
    global _capped_at
    if now - _capped_at < PRUNE_EVERY_S:
        return
    _capped_at = now
    files: list[tuple[int, int, Path]] = []
    try:
        for d in brazil_radar.STORE.iterdir():
            if not d.name.startswith(PREFIX) or not (d / "files").is_dir():
                continue
            for p in (d / "files").glob("*/*.h5"):
                e = _parse(p.parent.name, p.name)
                files.append((e.unix if e else 0, p.stat().st_size, p))
    except OSError:
        return
    total = sum(f[1] for f in files)
    for _unix, size, p in sorted(files, key=lambda f: f[0]):
        if total <= MAX_STORE_BYTES:
            break
        try:
            p.unlink(missing_ok=True)
            total -= size
        except OSError:
            continue


def _fetch(radar: str, entries: list[Entry]) -> list[Entry]:
    """What these files have that is not here yet, on the download threads (a file
    asked for twice comes down once). Returns the ones now here. Raises when the
    network let one down: what is missing would change what is drawn, and would stay."""
    r = TABLE[radar]
    waiting: list[Future] = []
    for e in entries:
        path = _path(radar, e)
        if path.exists():
            continue
        day = datetime.fromtimestamp(e.unix, tz=timezone.utc)
        with _LOCK:
            fut = _FETCHING.get(path)
            if fut is None:
                fut = _POOL.submit(_download, f"{BUCKET}/{day:%Y/%m/%d}/{r['cc']}/{r['code']}/{e.folder}/{e.name}", path)
                _FETCHING[path] = fut
                fut.add_done_callback(lambda _f, k=path: _FETCHING.pop(k, None))
        waiting.append(fut)
    if any(f.result() == "failed" for f in waiting):
        raise RuntimeError(f"Could not download {radar}'s files from the OPERA bucket.")
    now = time.time()
    if waiting and now - _PRUNED.get(radar, 0.0) > PRUNE_EVERY_S:
        _PRUNED[radar] = now
        _prune(radar)
    return [e for e in entries if _path(radar, e).exists()]


def _read(path: Path, name: str, keep_elev: Any, moments: Collection[str]) -> Optional[Volume]:
    """The wanted sweeps and moments of one file. Opened through Python: reads only
    those, and takes any path Windows does (a user name with an accent)."""
    try:
        with open(path, "rb") as fh, h5py.File(fh, "r") as f:
            return brazil_radar._read_odim(f, name, keep_elev, moments)
    except Exception:  # noqa: BLE001 - one bad file leaves the rest
        return None


def _reach(sw: Sweep, moment: str) -> float:
    return sw.r0_km + sw.data[moment].shape[1] * sw.dr_km


def _beats(a: Sweep, b: Sweep, moment: str) -> bool:
    """Whether a tilt's moment should come from `a` rather than `b`: the longer range
    first (Spain's reflectivity must not jump to Doppler range between frames), then
    the newer."""
    ra, rb = _reach(a, moment), _reach(b, moment)
    if abs(ra - rb) > SAME_RANGE * max(ra, rb):
        return ra > rb
    return a.unix > b.unix


def volume(radar: str, stamp: str, slot: Optional[int] = None, moments: Optional[Collection[str]] = None) -> Volume:
    """A frame as one volume: all of it, or only what one product needs (one tilt, some
    moments). Each moment is there at most once per tilt. A tilt's moments share a
    Sweep when they share rays, gates and about a time; otherwise it has several, at one
    elevation, each with its real time. Sweeps are low to high, like any volume's."""
    t = brazil_radar._stamp_unix(stamp)
    frame = _frame(radar, t)
    picked = _needed(radar, frame, slot, moments)
    if not picked:
        raise NoData(f"Nothing from {radar} in the frame {stamp}.")
    here = _fetch(radar, picked)
    keep = VIEWED if moments is None else moments

    def keep_elev(el: float) -> bool:
        if el >= MAX_ELEV:
            return False
        s = _slot_of(radar, el)
        return s is not None and (slot is None or s == slot)

    best: dict[tuple[int, str], Sweep] = {}
    first: Optional[Volume] = None
    used: list[str] = []
    for e in here:
        part = _read(_path(radar, e), e.name, keep_elev, keep)
        if part is None or not part.sweeps:
            continue
        first = first or part
        used.append(e.name)
        for sw in part.sweeps:
            s = _slot_of(radar, sw.elev)
            for m in sw.data:
                have = best.get((s, m))
                if have is None or _beats(sw, have, m):
                    best[(s, m)] = sw
    if first is None:
        raise NoData(f"Nothing readable from {radar} in the frame {stamp}.")
    sweeps: list[Sweep] = []
    placed: list[tuple[int, Sweep]] = []
    for (s, m), src in best.items():
        shape = src.data[m].shape
        twin = next((w for at, w in placed if at == s and w.nrays == src.nrays and w.r0_km == src.r0_km
                     and w.dr_km == src.dr_km and next(iter(w.data.values())).shape == shape
                     and abs(w.unix - src.unix) <= SAME_SWEEP_S), None)
        if twin is None:
            twin = replace(src, data={})
            placed.append((s, twin))
            sweeps.append(twin)
        twin.data[m] = src.data[m]
        twin.nyquist = twin.nyquist or src.nyquist
    sweeps.sort(key=lambda w: w.elev)
    table = _slot_table(radar)
    flown = {s for e in frame for s in _slots_of(radar, e)}
    ladder = [{"elev": round(table[s], 2), "actual": round(table[s], 2), "slot": SLOTS[s]}
              for s in sorted(flown, key=lambda s: table[s])]
    known = TABLE[radar]
    return Volume(radar=radar, ident=first.ident, name=first.name, lat=first.lat or known["lat"], lon=first.lon or known["lon"],
                  alt_m=first.alt_m, unix=t, sweeps=sweeps, files=sorted(used), ladder=ladder)


def frame_paths(radar: str, stamp: str) -> list[Path]:
    """A frame's original files, for the raw-file export."""
    entries = _fetch(radar, _frame(radar, brazil_radar._stamp_unix(stamp)))
    return sorted(_path(radar, e) for e in entries)


def is_young(unix: int) -> bool:
    return time.time() - unix < YOUNG_S


# ---------------------------------------------------------------- which are sending ---

_QUIET: dict[str, bool] = {}
_LAST: dict[str, int] = {}
_PROBE_LOCK = threading.Lock()
_probe_at = 0.0
_probe_loaded = False


def _heard_since(radar: str, cut: float) -> bool:
    """Whether the bucket has a file of a radar's from `cut` on: one key per folder."""
    r = TABLE[radar]
    now = datetime.now(timezone.utc)
    since = datetime.fromtimestamp(cut, tz=timezone.utc)
    days = [now] if since.date() == now.date() else [now, since]
    for day in days:
        for folder in _folders(radar, day):
            prefix = f"{day:%Y/%m/%d}/{r['cc']}/{r['code']}/{folder}/"
            res = _SESSION.get(f"{BUCKET}/", params={"list-type": 2, "prefix": prefix, "max-keys": 1,
                                                     "start-after": f"{prefix}{r['code']}@{since:%Y%m%dT%H%M}"}, timeout=(8, 30))
            res.raise_for_status()
            if "<Key>" in res.text:
                return True
    return False


def _heard_file() -> Path:
    return brazil_radar.STORE / "opera_heard.json"


def _probe() -> None:
    """The radars with no file in the last 3 hours, a radar at a time on a few threads.
    A radar the check could not reach stays as it was. Also the moment to clear what
    earlier sessions left of radars not looked at since."""
    global _probe_at
    cut = time.time() - QUIET_S

    def one(radar: str) -> None:
        try:
            quiet = not _heard_since(radar, cut)
            last = last_seen(radar) if quiet else None
        except Exception:  # noqa: BLE001 - the list stands as it was
            return
        _QUIET[radar] = quiet
        if last:
            _LAST[radar] = last

    try:
        with ThreadPoolExecutor(PROBE_WORKERS) as ex:
            list(ex.map(one, list(TABLE)))
        store = brazil_radar.STORE
        for d in store.iterdir() if store.is_dir() else ():
            if d.is_dir() and d.name.startswith(PREFIX) and time.time() - _PRUNED.get(d.name, 0.0) > PRUNE_EVERY_S:
                _PRUNED[d.name] = time.time()
                _prune(d.name)
        tmp = _heard_file().with_suffix(".part")
        tmp.write_text(json.dumps({"quiet": sorted(k for k, v in _QUIET.items() if v), "last": _LAST}), encoding="utf-8")
        os.replace(tmp, _heard_file())
    except OSError:
        pass
    finally:
        _probe_at = time.time()
        _PROBE_LOCK.release()


def _probe_soon() -> None:
    """Never in the caller's way: the first listing goes by what the last session found."""
    global _probe_loaded
    if not _probe_loaded:
        _probe_loaded = True
        try:
            kept = json.loads(_heard_file().read_text(encoding="utf-8"))
            _QUIET.update({k: True for k in kept.get("quiet", []) if k in TABLE})
            _LAST.update({k: int(v) for k, v in kept.get("last", {}).items() if k in TABLE})
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    if time.time() - _probe_at > PROBE_EVERY_S and _PROBE_LOCK.acquire(blocking=False):
        threading.Thread(target=_probe, name="opera-probe", daemon=True).start()


# ------------------------------------------------------------------ the mosaic ---

# OPERA's maximum reflectivity composite: all of Europe every 5 minutes, 3800 x 4400
# at 1 km on a Lambert equal-area grid. Drawn onto Web Mercator here, as MapLibre
# takes an image with four corners. No pyproj in the backend bundle, hence the formulas
# (Snyder, Map Projections, 24-1 and on).
MOSAIC_BOUNDS = (-40.0, 30.0, 60.0, 72.0)  # west, south, east, north
MOSAIC_W = 2000
_MOSAIC_SIZE = (3800, 4400)
_LAEA = {"lat0": 55.0, "lon0": 10.0, "x0": 1950000.0, "y0": -2100000.0, "a": 6378137.0, "e2": 0.00669437999014}
# Reflectivity from 5 dBZ, one colour per 5 dBZ: the usual NWS steps.
_DBZ_COLORS = np.array([
    (4, 233, 231), (1, 159, 244), (3, 0, 244), (2, 253, 2), (1, 197, 1), (0, 142, 0), (253, 248, 2), (229, 188, 0),
    (253, 149, 0), (253, 0, 0), (212, 0, 0), (188, 0, 0), (248, 0, 253), (152, 84, 198), (255, 255, 255),
], dtype=np.uint8)
_MOSAIC_LOCK = threading.Lock()
_mosaic_lut: Optional[tuple[np.ndarray, np.ndarray, int]] = None
_mosaic_png: dict[str, bytes] = {}


def _authalic(lat_rad: np.ndarray) -> np.ndarray:
    e2 = _LAEA["e2"]
    e = float(np.sqrt(e2))
    s = np.sin(lat_rad)
    return (1 - e2) * (s / (1 - e2 * s * s) - np.log((1 - e * s) / (1 + e * s)) / (2 * e))


def _mosaic_lookup() -> tuple[np.ndarray, np.ndarray, int]:
    """For each output pixel, its cell of OPERA's grid (-1 outside)."""
    global _mosaic_lut
    if _mosaic_lut is not None:
        return _mosaic_lut
    west, south, east, north = MOSAIC_BOUNDS
    merc = lambda lat: np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))  # noqa: E731
    height = int(round(MOSAIC_W * (merc(north) - merc(south)) / np.radians(east - west)))
    lons = np.radians(np.linspace(west, east, MOSAIC_W, endpoint=False) + (east - west) / MOSAIC_W / 2)
    ys = merc(north) - (np.arange(height) + 0.5) * (merc(north) - merc(south)) / height
    lats = 2 * np.arctan(np.exp(ys)) - np.pi / 2
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    a, e2 = _LAEA["a"], _LAEA["e2"]
    lat0, lon0 = np.radians(_LAEA["lat0"]), np.radians(_LAEA["lon0"])
    qp = _authalic(np.array(np.pi / 2))
    q1 = _authalic(np.array(lat0))
    q = _authalic(lat_grid)
    rq = a * np.sqrt(qp / 2)
    beta1 = np.arcsin(q1 / qp)
    beta = np.arcsin(np.clip(q / qp, -1, 1))
    m1 = np.cos(lat0) / np.sqrt(1 - e2 * np.sin(lat0) ** 2)
    d = a * m1 / (rq * np.cos(beta1))
    dl = lon_grid - lon0
    b = rq * np.sqrt(2 / (1 + np.sin(beta1) * np.sin(beta) + np.cos(beta1) * np.cos(beta) * np.cos(dl)))
    x = b * d * np.cos(beta) * np.sin(dl) + _LAEA["x0"]
    y = (b / d) * (np.cos(beta1) * np.sin(beta) - np.sin(beta1) * np.cos(beta) * np.cos(dl)) + _LAEA["y0"]
    # The file's first row is the north edge; x_0, y_0 put its corner at the origin.
    col = np.floor(x / 1000.0).astype(np.int32)
    row = np.floor(-y / 1000.0).astype(np.int32)
    bad = (col < 0) | (col >= _MOSAIC_SIZE[0]) | (row < 0) | (row >= _MOSAIC_SIZE[1])
    col[bad] = -1
    row[bad] = -1
    _mosaic_lut = (row, col, height)
    return _mosaic_lut


def mosaic_times(hours: float = 3.0) -> list[int]:
    now = time.time()
    out: set[int] = set()
    days = {datetime.fromtimestamp(now - k * hours * 3600, tz=timezone.utc).strftime("%Y/%m/%d") for k in (0, 1)}
    for day in days:
        res = _SESSION.get(f"{BUCKET}/", params={"list-type": 2, "prefix": f"{day}/OPERA/COMP/OPERA@", "max-keys": 1000}, timeout=(8, 30))
        res.raise_for_status()
        token = None
        keys = re.findall(r"<Key>([^<]+)</Key>", res.text)
        token = re.search(r"<NextContinuationToken>([^<]+)<", res.text)
        while token:
            res = _SESSION.get(f"{BUCKET}/", params={"list-type": 2, "prefix": f"{day}/OPERA/COMP/OPERA@", "max-keys": 1000, "continuation-token": token.group(1)}, timeout=(8, 30))
            keys += re.findall(r"<Key>([^<]+)</Key>", res.text)
            token = re.search(r"<NextContinuationToken>([^<]+)<", res.text)
        for key in keys:
            m = re.search(r"OPERA@(\d{8}T\d{4})@0@DBZH\.h5$", key)
            if m:
                t = int(datetime.strptime(m.group(1), "%Y%m%dT%H%M").replace(tzinfo=timezone.utc).timestamp())
                if t >= now - hours * 3600:
                    out.add(t)
    return sorted(out)


def mosaic_png(t: int) -> bytes:
    """One composite as a transparent PNG over MOSAIC_BOUNDS."""
    stamp = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y%m%dT%H%M")
    with _MOSAIC_LOCK:
        hit = _mosaic_png.get(stamp)
    if hit:
        return hit
    day = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y/%m/%d")
    res = _SESSION.get(f"{BUCKET}/{day}/OPERA/COMP/OPERA@{stamp}@0@DBZH.h5", timeout=(8, 60))
    res.raise_for_status()
    with h5py.File(io.BytesIO(res.content), "r") as f:
        data = f["dataset1"]["data1"]["data"][()]
    with _MOSAIC_LOCK:
        row, col, height = _mosaic_lookup()
    values = data[row, col]
    index = np.floor((values - 5.0) / 5.0).astype(np.int32)
    # nodata and undetect are huge negatives; anything under 5 dBZ is left clear too.
    show = (row >= 0) & (values >= 5.0) & (values < 200.0)
    rgba = np.zeros((height, MOSAIC_W, 4), dtype=np.uint8)
    rgba[show, :3] = _DBZ_COLORS[np.clip(index[show], 0, len(_DBZ_COLORS) - 1)]
    rgba[show, 3] = 255
    out = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(out, "PNG", optimize=False, compress_level=6)
    png = out.getvalue()
    with _MOSAIC_LOCK:
        _mosaic_png[stamp] = png
        for key in sorted(_mosaic_png)[:-40]:
            _mosaic_png.pop(key, None)
    return png


def install() -> None:
    """Into the radar viewer's table, and as the store's way to the bucket."""
    for rid, r in TABLE.items():
        brazil_radar.RADARS.setdefault(rid, {"name": r["name"], "op": r["op"], "lat": r["lat"], "lon": r["lon"], "band": r["band"]})
    brazil_radar.REMOTE = sys.modules[__name__]
