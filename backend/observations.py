"""
Observed analyses: what the atmosphere just did.

A forecast model says what the air will do; an analysis says what it is doing,
by fitting a grid to the observations that came in. Three are published openly
and hourly:

    RTMA 2.5 km     NCEP's Real-Time Mesoscale Analysis, the finest surface
                    analysis over CONUS -- surface fields only
    HRRR analysis   the HRRR's own initial hour, on its 3 km grid, from the
                    pressure-level file: surface, upper air, severe parameters
    RAP analysis    the same for the 13 km RAP, which reaches past CONUS

They are read the way the radar is: every hour becomes a frame on the app's one
timeline, so a chase day can be walked backwards through dew point, CAPE and
the 500 mb flow exactly as it is walked through reflectivity.

What is drawn is a PRODUCT: a shaded variable, optionally with contours of
another (heights over wind, isobars over temperature) and wind barbs. Products
are built from VARIABLES -- the raw GRIB fields and what is derived from them
(theta-e, the STP) -- and it is the variables that are cached, so switching
from SBCAPE to the STP to the 0-1 km EHI downloads only what the first did not.
The catalogue itself -- sources, variables, recipes, products -- lives in
obs_products.py.

The colours come out as a Mercator-warped PNG rather than vectors, because a
field of two million points is an image, not a pile of polygons,
whose row warp this borrows so the four corners MapLibre places it by are exact.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import os
import re
import tempfile
import threading
import time
import zipfile
import zlib
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional
from urllib.parse import urlsplit

import numpy as np
from contourpy import LineType, contour_generator
from PIL import Image, features
from scipy.ndimage import gaussian_filter, maximum_filter
from scipy.spatial import cKDTree

import atcf
import model_fields
import model_sources as ms
import mrms

from obs_products import CONVERT, FORMATS, KEEP, NOMADS, PAIRS, PRODUCTS, SOURCES, needs, recipe

NOMADS_HOST = urlsplit(NOMADS).netloc

DEFAULT_SOURCE = "hrrr-anl"
DEFAULT_FIELD = "t2m"
DEFAULT_WIDTH = 1600

# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------
_LOCK = threading.Lock()
_FRAMES: dict[str, tuple[float, list[dict]]] = {}
_FRAMES_TTL = 300.0
# A forecast model's list found with the NOMADS budget spent -- its newest
# runs, which often only NOMADS has yet, left unasked -- is looked for again
# this soon instead. See _short_frames.
_SHORT_TTL = 45.0
# NOMADS refusing this computer outright ("Over Rate Limit": it blocks an
# address for a quarter of an hour past about 120 requests a minute). Until
# this time (monotonic) no run is looked for there: every question would be
# refused, and might keep the block on. One question when it runs out.
_NOMADS_REFUSED = [0.0]
_REFUSED_FOR = 300.0
# A day's loop is 24 to 96 frames, and all of them are made before it plays:
# a cache smaller than the loop throws away frames the timeline is about to ask
# for. A picture is a few hundred KB of PNG, the lines their JSON, already
# serialised.
_RENDER: "OrderedDict[tuple, dict]" = OrderedDict()
_RENDER_MAX = 300
_VECTORS: "OrderedDict[tuple, bytes]" = OrderedDict()
_VECTORS_MAX = 300
# Work under way, so a second asker waits for it instead of doing it again.
_INFLIGHT: dict[tuple, threading.Event] = {}
# The product in display units on the drawing grid, for the hover readout.
_SHADES: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_SHADES_MAX = 12
# Variables on the drawing grid, by bytes rather than by count: a RAP field is a
# megabyte and an RTMA one four and a half.
_VARS: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_VARS_BYTES = 0
# A field on the 3 km drawing grid is 10 MB, not 3.7: at the old budget a
# ten-field product could not hold even one hour, and every frame evicted the
# one before it.
_VARS_BUDGET = 640 * 1024 * 1024
# One download of a variable at a time: the picture, the lines and a warm-up
# can all ask for the same hour at once.
_GATES: dict[tuple, threading.Lock] = {}

# Where each source's grid lands on the drawing grid -- see _mapping. Built
# once, kept on disk, so a restarted backend never builds it again.
_MAPS: dict[str, dict] = {}
_MAP_DIR = Path(tempfile.gettempdir()) / "weatherts-obs"

# One background worker warms the hours beside the one on screen, so stepping
# the timeline lands on a frame that is already made. One at a time on purpose:
# it must never compete with the frame someone is actually waiting for.
_WARMER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="obs-warm")
_WARMING: set[tuple] = set()
_WARM_AHEAD = 3
# The product the panel is on. Warming anything else is work nobody is waiting
# for: clicking through products left a queue of neighbouring hours for products
# already gone from the screen, and those downloads held the line -- and the
# thread pool -- while the picture someone was actually waiting for queued
# behind them. The loop has had this guard (_LOOP_GEN) all along; the warm-up
# never did.
_WANT: dict[str, str] = {"source": "", "field": ""}
# Per thread: .loop and .background say what a download is for; .short, set
# while a forecast model's runs are looked for, that NOMADS went unasked --
# for want of budget, or refusing us. NOMADS is asked on the thread itself:
# the pools _locate and _published use ask only the free copies.
_TLS = threading.local()

# Variables already on the drawing grid, kept on disk as well: an analysis hour
# never changes once published, and reading one back is a few hundredths of a
# second where downloading it again is one to three seconds.
_VAR_DIR = _MAP_DIR / "vars"
# A week of a three-field product is some 700 MB at ~1.4 MB a field-hour.
_VAR_DISK_BUDGET = 3 * 1024 * 1024 * 1024
_DISKER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="obs-disk")
_DISK_WRITES = 0

# Days NOMADS no longer holds, per source: asked of the mirror straight away.
_NOMADS_GONE: set[tuple[str, str]] = set()


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------
def _product_needs(source: str, pid: str) -> Optional[set[str]]:
    """Every raw variable a product comes down to in `source`, or None if the
    source cannot draw it."""
    spec = PRODUCTS[pid]
    names = [spec["shade"]]
    if spec["lines"] and spec["lines"].get("var"):
        names.append(spec["lines"]["var"])
    if spec.get("outline"):
        names.append(spec["outline"]["var"])
    if spec["barbs"]:
        names += list(spec["barbs"])
    out: set[str] = set()
    for n in names:
        got = needs(source, n)
        if got is None:
            return None
        out |= got
    return out


_OFFERS: dict[str, list[str]] = {
    sid: [pid for pid in PRODUCTS if pid not in SOURCES[sid].get("hide", ())
          and _product_needs(sid, pid) is not None] for sid in SOURCES
}
# Track sources draw tracks, not a shaded variable: their products are theirs alone.
for _sid, _s in SOURCES.items():
    if _s.get("tracks"):
        _OFFERS[_sid] = [pid for pid, p in PRODUCTS.items() if p["shade"] == "tracks"]


def _tracks(source: str) -> bool:
    return bool(SOURCES[source].get("tracks"))


def track_data(source: str, field: str, key: str) -> dict[str, Any]:
    """An ATCF source's tracks for one storm and cycle, as the map draws them."""
    _check(source, field)
    if not _tracks(source):
        raise ValueError(f"{source} has no tracks")
    rid = key.split("_f", 1)[0]
    out = atcf.tracks(rid, "gefs" if field == "trk_gefs" else "all" if field.endswith("_all") else "selected")
    out["intensity"] = "_int_" in field
    out["bar"] = colour_bar(field) if out["intensity"] else None
    return out


# The model menu's shelves, in the order it lists them; a source keeps its
# place in SOURCES within its shelf.
_GROUP_ORDER = ("Analyses", "Radar mosaic", "Convection-allowing", "CAM ensemble", "Regional", "Global", "Ensemble", "Tropical")


# Within a shelf, the order a model viewer lists them in; anything unlisted
# follows in the order SOURCES has it.
_MENU_ORDER = (
    "hrrr-fc", "hrrr-subh", "rrfs-fc", "rrfs-subh", "nam3-fc", "hrw-arw-fc", "hrw-arw2-fc", "hrw-fv3-fc", "href-fc", "refs-fc",
    "rap-fc", "nam-fc",
    "gfs-fc", "aigfs-fc", "ecmwf-fc", "aifs-fc", "icon-fc", "gdps-fc",
    "gefs-fc", "aigefs-fc", "hgefs-fc", "ecmwf-ens-fc", "aifs-ens-fc", "nbm-fc",
    "hafsa-fc", "hafsb-fc", "hwrf-fc", "hmon-fc", "ndfd-fc",
)


def _shelf(sid: str) -> tuple[int, int]:
    group = SOURCES[sid].get("group", "Analyses")
    shelf = _GROUP_ORDER.index(group) if group in _GROUP_ORDER else len(_GROUP_ORDER)
    return shelf, _MENU_ORDER.index(sid) if sid in _MENU_ORDER else len(_MENU_ORDER)


def catalog() -> dict[str, Any]:
    """Every source, every product, and which sources can draw which."""
    return {
        "sources": [
            {"id": sid, "label": s["label"], "org": s["org"], "coverage": s["coverage"], "note": s["note"],
             "products": _OFFERS[sid], "forecast": _is_fc(sid), "tracks": _tracks(sid),
             "group": s.get("group", "Analyses"), "cadence": _cadence(sid),
             **({"replay": s["replay"]} if s.get("replay") in SOURCES else {})}
            for sid, s in sorted(SOURCES.items(), key=lambda kv: _shelf(kv[0]))
        ],
        "products": [
            {
                "id": pid,
                "label": p["label"],
                "group": p["group"],
                "sub": p["sub"],
                "unit": p["unit"],
                "note": p["note"],
                "lines": bool(p["lines"]),
                "barbs": bool(p["barbs"]),
                "sources": [sid for sid in SOURCES if pid in _OFFERS[sid]],
            }
            for pid, p in PRODUCTS.items()
        ],
        "defaultSource": DEFAULT_SOURCE,
        "defaultField": DEFAULT_FIELD,
    }


def _check(source: str, field: str) -> None:
    if source not in SOURCES:
        raise ValueError(f"Unknown analysis source: {source}")
    if field not in PRODUCTS:
        raise ValueError(f"Unknown analysis product: {field}")
    if field not in _OFFERS[source]:
        raise ValueError(f"{SOURCES[source]['label']} does not carry {PRODUCTS[field]['label']}")


def _newest_key(source: str) -> str:
    """The frame a product opens on: the newest analysis, or -- for a
    forecast -- the hour nearest now, the way a model viewer lands on the run's
    present rather than on its first or last hour."""
    have = frames(source)
    if not have:
        raise RuntimeError(f"No {SOURCES[source]['label']} hours are on the server right now")
    if not _is_fc(source):
        return have[-1]["key"]
    now = time.time()
    return min(have, key=lambda f: abs(f["unix"] - now))["key"]


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------
def _url(source: str, host: str, when: datetime) -> str:
    return SOURCES[source]["urls"][host].format(
        ymd=when.strftime("%Y%m%d"), hh=when.strftime("%H"), mm=when.strftime("%M"))


def _cadence(source: str) -> int:
    return int(SOURCES[source].get("cadence", 60))


def _key(source: str, when: datetime) -> str:
    return when.strftime("%Y%m%d%H%M" if _cadence(source) < 60 else "%Y%m%d%H")


def _is_fc(source: str) -> bool:
    return "forecast" in SOURCES[source]


def _run_fh(key: str) -> tuple[datetime, Optional[int]]:
    """A key's run and forecast hour: '2026092118_f004' is the 18Z run's hour
    four, '2026092118_f1.25' a sub-hourly model's hour and a quarter (a float,
    even on the hour: '_f2.00'); a plain '2026092118' is an analysis, which has
    no hour."""
    if "_f" in key:
        run, fh = key.split("_f", 1)
        when = datetime.strptime(run.split("~")[0], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        return when, (float(fh) if "." in fh else int(fh))
    stamp = "%Y%m%d%H%M" if len(key) == 12 else "%Y%m%d%H"
    return datetime.strptime(key, stamp).replace(tzinfo=timezone.utc), None


def _subh(source: str) -> bool:
    return bool(SOURCES[source].get("subhourly"))


def _fkey(run: datetime, fh: float, sub: bool = False) -> str:
    """A forecast frame's key (see _run_fh)."""
    return f"{run:%Y%m%d%H}_f{fh:.2f}" if sub else f"{run:%Y%m%d%H}_f{int(fh):03d}"


def _storm_of(key: str) -> str:
    """The storm a tropical model's key is for: '2026092212~polo17e_f024' ->
    'polo17e'; '' for everything else."""
    head = key.split("_f", 1)[0]
    return head.split("~", 1)[1] if "~" in head else ""


def _with_fh(key: str, fh: float, sub: bool = False) -> str:
    """The same run (and storm) at another forecast hour."""
    return key.split("_f", 1)[0] + (f"_f{fh:.2f}" if sub else f"_f{int(fh):03d}")


def _fh_label(fh: float) -> str:
    """'F004', or 'F01:15' for a sub-hourly frame."""
    if isinstance(fh, float):
        return f"F{int(fh):02d}:{round((fh % 1) * 60):02d}"
    return f"F{fh:03d}"


def _when(key: str) -> datetime:
    """The instant a key shows: the analysis time, or a forecast's valid time."""
    run, fh = _run_fh(key)
    return run + timedelta(hours=fh) if fh is not None else run


def _url_for(source: str, host: str, key: str, file: Optional[str] = None) -> str:
    """The URL of an hour's file on `host`; `file` names another file of the
    same hour, for a model that splits its fields between two (RRFS: surface
    and pressure levels)."""
    template = SOURCES[source]["files"][file][host] if file else SOURCES[source]["urls"][host]
    return _fill(template, key)


def _fill(template: str, key: str) -> str:
    """A URL or record with an hour's run and forecast hour written in. A
    sub-hourly frame reads the file of the hour it falls in (1:15 is in f02)
    and names its minute ({fmin})."""
    run, fh = _run_fh(key)
    fh = fh or 0
    hour = math.ceil(fh - 1e-9)
    return template.format(
        ymd=run.strftime("%Y%m%d"), hh=run.strftime("%H"), mm=run.strftime("%M"),
        ff=f"{hour:02d}", fff=f"{hour:03d}", h=hour, fmin=round(fh * 60), var="{var}", mem="{mem}",
        vp="{vp}", storm=_storm_of(key), vunix=int((run + timedelta(hours=fh)).timestamp()))


def _scan_urls(url: str, where: str) -> tuple[list[str], datetime]:
    """An NDFD record 'temp|1790035200' -> the element's files (days 1-3 and
    4-7) and the valid time to find in them."""
    element, _, vunix = where.partition("|")
    urls = [url.replace("{var}", element).replace("{vp}", vp) for vp in ("VP.001-003", "VP.004-007")]
    return urls, datetime.fromtimestamp(int(vunix), tz=timezone.utc)


# How each kind of file is read: the NCEP .idx (a "VAR:LEVEL" per record),
# ECMWF's JSON .index ("param=t,levelist=850"), or a file per variable whose
# name the record fills in (the MSC's "AirTemp_AGL-2m" in place of {var}).
_READERS: dict[str, Callable[[str, str], Optional[np.ndarray]]] = {
    "idx": lambda url, m: ms.values_at(url, m),
    "ecmwf": lambda url, m: ms.ecmwf_values_at(url, m),
    "file": lambda url, m: ms.file_values_at(url.replace("{var}", m)),
    "scan": lambda url, m: ms.scan_values_at(*_scan_urls(url, m)),
    # MRMS: a file per product per time, found in the product's own listing.
    "mrms": lambda url, m: mrms.values_at(url.replace("{var}", m)),
}
_FIELDS: dict[str, Callable[[str, str], Optional["ms.Field"]]] = {
    "idx": lambda url, m: ms.fetch_at(url, m),
    "ecmwf": lambda url, m: ms.ecmwf_fetch_at(url, m),
    "file": lambda url, m: ms.file_fetch_at(url.replace("{var}", m)),
    "scan": lambda url, m: ms.scan_fetch_at(*_scan_urls(url, m)),
    "mrms": lambda url, m: mrms.field_at(url.replace("{var}", m)),
}


def _reader(source: str) -> str:
    return SOURCES[source].get("reader", "idx")


def _is_out(source: str, url: str, key: str) -> bool:
    """Whether the file an hour is read from is published yet. A model with a
    file per variable is asked about the one variable it names as its probe."""
    reader = _reader(source)
    if reader == "mrms":
        return mrms.has(url.replace("{var}", SOURCES[source]["probe"]))
    if reader == "ecmwf":
        return ms.has_index(url)
    if reader == "file":
        return ms.has_file(url.replace("{var}", _fill(SOURCES[source]["probe"], key)))
    return ms.has_idx(url)


def _windowed(match: str) -> bool:
    """Whether a record is a total or extreme over a time window -- which has
    nothing in it yet at a run's first hour."""
    select = match.partition("|")[2].partition("|")[0]
    return select == "tot" or select.startswith("bkt") or bool(re.fullmatch(r"\d+h", select))


class _Address(NamedTuple):
    where: str               # the record itself, as the reader finds it
    scale: float             # multiply the values by this
    first: bool              # read from the run's first hour
    above: Optional[float]   # blank values at or over this
    file: Optional[str]      # another file of the hour, by its name in "files"


def _address(match: str) -> _Address:
    """A raw record's address less its modifiers: 'name>' reads it from another
    of the hour's files, '*k' scales the values (ECMWF gives precipitation in
    metres of water, not kg/m2), '@0' reads it from the run's first hour
    (ECMWF files terrain only there) and '!v' blanks values of v and above (the
    MSC writes 9999 for a CAPE it has no parcel for)."""
    # Only a plain name before ">" is a file: a record's own text can hold one
    # too ("APCP:surface|6h|prob >12.7").
    named = re.match(r"^([A-Za-z0-9_]+)>(.*)$", match)
    file, rest = (named.group(1), named.group(2)) if named else (None, match)
    first = rest.endswith("@0")
    if first:
        rest = rest[:-2]
    rest, _, above = rest.partition("!")
    rest, _, k = rest.partition("*")
    return _Address(rest, float(k) if k else 1.0, first, float(above) if above else None, file)


def frames(source: str = DEFAULT_SOURCE) -> list[dict]:
    """Every analysis time on the timeline, oldest first.

    Only the newest is looked for -- the last few .idx files, side by side --
    and the list reaches back `days` from it at the source's cadence. NOMADS keeps about two
    days; the older hours come from NOAA's copy on AWS, which keeps years, so
    the timeline is not cut off where NOMADS happens to prune.
    """
    if source not in SOURCES:
        raise ValueError(f"Unknown analysis source: {source}")
    with _LOCK:
        hit = _FRAMES.get(source)
    if hit and time.time() - hit[0] < SOURCES[source].get("frames_ttl", _FRAMES_TTL):
        return hit[1]

    # A restarted backend answers from the last list it found, at once, when
    # that list is recent, and finds the real one behind the answer.
    if hit is None:
        saved = _read_saved_frames(source)
        if saved is not None:
            with _LOCK:
                _FRAMES[source] = (time.time() - _FRAMES_TTL + 60.0, saved)
            _WARMER.submit(_refresh_frames, source)
            return saved
    return _discover_frames(source)


# A loop longer than this many frames plays every k-th hour instead: a week of
# RTMA-RU is 672 quarter-hours, and each one is several fields to download.
MAX_LOOP_FRAMES = 240


def frames_for(source: str, hours: float) -> list[dict]:
    """The frames of the last `hours`, oldest first -- no more than
    MAX_LOOP_FRAMES of them. Over a longer span it keeps one frame per k
    cadences, the last of each, so the newest frame is always in the loop.

    The k-cadence stretches are fixed to the clock, not counted back from the
    newest frame. Counted back, a source publishing every two minutes (the MRMS
    mosaic) moved every kept frame each time a new one came in: the loop being
    downloaded became a different loop every minute and never finished."""
    every = frames(source)
    if not every or _is_fc(source):
        return every
    span = max(1.0, min(float(hours), SOURCES[source]["days"] * 24.0)) * 3600.0
    newest = every[-1]["unix"]
    inside = [f for f in every if f["unix"] > newest - span]
    k = max(1, math.ceil(len(inside) / MAX_LOOP_FRAMES))
    if k == 1:
        return inside
    stretch = k * _cadence(source) * 60
    last: dict[int, dict] = {}
    for f in inside:
        last[int(f["unix"]) // stretch] = f
    return [last[b] for b in sorted(last)][-MAX_LOOP_FRAMES:]


def _frames_path(source: str) -> Path:
    return _MAP_DIR / f"{source}-frames-v4.json"


def _read_saved_frames(source: str, max_age: Optional[float] = 3600.0) -> Optional[list[dict]]:
    try:
        data = json.loads(_frames_path(source).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if max_age is not None and time.time() - float(data.get("saved", 0)) > max_age:
        return None
    return data.get("frames") or None


def _refresh_frames(source: str) -> None:
    # After the first picture, not alongside it: the probes and a field download
    # share one connection, and the picture is what someone is waiting for.
    time.sleep(3.0)
    try:
        _discover_frames(source)
    except Exception:  # noqa: BLE001 - the saved list keeps serving meanwhile
        pass


def _discover_frames(source: str) -> list[dict]:
    if _is_fc(source):
        return _discover_forecast(source)
    s = SOURCES[source]
    if _reader(source) == "mrms":
        # The listing is the index: every time the probe product has a file.
        return _keep_frames(source, mrms.frames(s["region"], s["probe"], s["days"], _cadence(source)))
    cadence = _cadence(source)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    # Round down to the cadence within the day, not within the hour: a source
    # published every six hours runs at 00/06/12/18Z, and stripping only the
    # minutes would have gone looking for 16Z.
    now -= timedelta(minutes=(now.hour * 60 + now.minute) % cadence)
    # Six hours back for an hourly analysis, two for a quarter-hourly one.
    recent = [now - timedelta(minutes=cadence * k) for k in range(0, 6 if cadence >= 60 else 8)]

    def probe(host: str) -> Optional[datetime]:
        def there(when: datetime) -> bool:
            try:
                with ms.no_wait():
                    return ms.has_idx(_url(source, host, when))
            except Exception:  # noqa: BLE001 - rate limits included: try the mirror
                return False
        with ThreadPoolExecutor(max_workers=6) as pool:
            found = list(pool.map(there, recent))
        return next((t for t, ok in zip(recent, found) if ok), None)

    newest = probe("nomads") if ms.room(NOMADS_HOST) >= 10 else None
    if newest is None:
        newest = probe("aws")
    if newest is None:
        with _LOCK:
            _FRAMES[source] = (time.time(), [])
        return []

    out: list[dict] = []
    count = s["days"] * 24 * 60 // cadence
    label = "%d %HZ" if cadence >= 60 else "%d %H:%MZ"
    for k in range(count - 1, -1, -1):
        when = newest - timedelta(minutes=cadence * k)
        out.append({"key": _key(source, when), "unix": int(when.timestamp()), "label": when.strftime(label)})
    return _keep_frames(source, out)


def _keep_frames(source: str, out: list[dict]) -> list[dict]:
    """Hold a source's frame list, and save it for the next start."""
    with _LOCK:
        _FRAMES[source] = (time.time(), out)
    try:
        _MAP_DIR.mkdir(parents=True, exist_ok=True)
        _frames_path(source).write_text(json.dumps({"saved": time.time(), "frames": out}), encoding="utf-8")
    except OSError:
        pass
    return out


# Recent cycles tried when looking for the newest run, and the fewest hours a
# run still arriving must have before it is shown instead of the one before
# (half the run's hours, when that is more).
_RUN_LOOKBACK = 8
_MIN_RUN_HOURS = 6


def _cycle_runs(source: str, most: int, within_hours: int = 96) -> list[datetime]:
    """The model's run times, newest first, as its cycles fall -- whether
    published or not."""
    cycles = set(SOURCES[source]["forecast"]["cycles"])
    t = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    runs: list[datetime] = []
    for _ in range(within_hours):
        if t.hour in cycles:
            runs.append(t)
            if len(runs) >= most:
                break
        t -= timedelta(hours=1)
    return runs


def _there(source: str, run: datetime, fh: int, host: str) -> bool:
    if host == "nomads" and time.monotonic() < _NOMADS_REFUSED[0]:
        _TLS.short = True
        return False
    try:
        with ms.no_wait():
            k = _fkey(run, fh, _subh(source))
            return _is_out(source, _url_for(source, host, k), k)
    except ms.RateLimited as exc:
        # Not asked -- this minute's budget spent, or NOMADS refusing us --
        # which is not the same as not there.
        if host == "nomads":
            _TLS.short = True
            if not isinstance(exc, ms.Throttled):
                _NOMADS_REFUSED[0] = time.monotonic() + _REFUSED_FOR
        return False
    except Exception:  # noqa: BLE001 - unreachable reads as not there yet
        return False


# The hours a search asks about at once on a mirror. Its own pool: the search
# runs inside _COMPARE_POOL tasks, which must not wait on their own pool.
_PROBES = 8
_PROBE_POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix="obs-probe")


def _published(source: str, run: datetime, host: str) -> int:
    """How many of the run's hours are out, counted from the first.

    Hours come out in order, so this searches for where they stop. On NOMADS,
    one question at a time (its budget is sixty a minute). On a mirror, eight
    at a time: a question is cheap there and slow only in its round trip, and
    three rounds of eight answer a 49-hour run that took seven in a row."""
    hours = SOURCES[source]["forecast"]["hours"]
    lo, hi = 0, len(hours) - 1
    if host == "nomads":
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _there(source, run, hours[mid], host):
                lo = mid
            else:
                hi = mid - 1
        return lo + 1
    while lo < hi:
        step = max(1, -(-(hi - lo) // _PROBES))
        probes = list(range(lo + step, hi + 1, step))
        if probes[-1] != hi:
            probes.append(hi)
        out = list(_PROBE_POOL.map(lambda i: _there(source, run, hours[i], host), probes))
        new_lo, new_hi = lo, hi
        for i, ok in zip(probes, out):
            if ok:
                new_lo = i
            else:
                new_hi = i - 1
                break
        lo, hi = new_lo, new_hi
    return lo + 1


def _published_any(source: str, run: datetime, host: str, need: int = 0) -> int:
    """How many of the run's hours are out, on the host it was found on -- and
    on the others when that one stops short: a mirror can hold part of a run.
    AWS had 5 hours of a NAM Nest run that NOMADS had whole, so the run opened
    cut short, or an older one was opened in its place.

    Short of `need` hours, another host is searched only if it has that many:
    fewer would change nothing for the caller. The GFS run still coming out,
    a little behind on AWS, cost a full NOMADS search at every look, only to
    find it not yet at half its hours."""
    hours = SOURCES[source]["forecast"]["hours"]
    n = _published(source, run, host)
    for other in SOURCES[source]["urls"]:
        if n >= len(hours):
            break
        if other == host:
            continue
        if other == "nomads" and ms.room(NOMADS_HOST) < 20:
            _TLS.short = True
            continue
        if _there(source, run, hours[min(max(n, need - 1), len(hours) - 1)], other):
            n = max(n, _published(source, run, other))
    return n


def _locate(source: str, runs: list[datetime], nomads_runs: int) -> dict[datetime, str]:
    """Which copy has each run that exists: every copy that costs nothing, in
    the order listed (a run the first lacks is looked for on the next), then
    NOMADS for the newest `nomads_runs` still missing, while its budget allows
    -- when it does not, _TLS.short says so."""
    first = SOURCES[source]["forecast"]["hours"][0]
    host_of: dict[datetime, str] = {}
    urls = SOURCES[source]["urls"]
    for host in [h for h in urls if h != "nomads"]:
        todo = [r for r in runs if r not in host_of]
        with ThreadPoolExecutor(max_workers=8) as pool:
            found = list(pool.map(lambda r: _there(source, r, first, host), todo))
        host_of.update({r: host for r, ok in zip(todo, found) if ok})
    for run in runs[:nomads_runs] if "nomads" in urls else []:
        if run in host_of:
            continue
        # A binary search is up to ten requests; leave NOMADS room for pictures.
        if ms.room(NOMADS_HOST) < 20:
            _TLS.short = True
            break
        if _there(source, run, first, "nomads"):
            host_of[run] = "nomads"
    return host_of


def _frames_of(source: str, run: datetime, count: int) -> list[dict]:
    out = []
    for fh in SOURCES[source]["forecast"]["hours"][:count]:
        valid = run + timedelta(hours=fh)
        sub = _subh(source)
        out.append({"key": _fkey(run, fh, sub), "unix": int(valid.timestamp()),
                    "label": f"{_fh_label(float(fh) if sub else fh)} {valid:%a %H:%MZ}" if sub
                    else f"{_fh_label(fh)} {valid:%a %HZ}",
                    "fh": fh, "run": f"{run:%Y%m%d%H}"})
    return out


# The run picker: which runs of a model can be opened, and one run's hours.
# A run's hours are looked at again after a few minutes while it may still be
# coming in; the list of runs, likewise.
_RUNS: dict[str, tuple[float, list[dict]]] = {}
_RUN_FRAMES: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_RUNS_TTL = 300.0
# How far back the picker reaches: two days of runs, and no more than 24 of
# them for a model that runs every hour.
_PICKER_HOURS = 48
_PICKER_MOST = 24


def runs(source: str) -> list[dict]:
    """The model's runs that can be opened, newest first."""
    if source not in SOURCES or not _is_fc(source):
        raise ValueError(f"{source} is not a forecast model")
    with _LOCK:
        hit = _RUNS.get(source)
    if hit and time.time() - hit[0] < _RUNS_TTL:
        return hit[1]
    if SOURCES[source].get("storms"):
        return _storm_runs(source)
    if _tracks(source):
        return atcf.storm_runs()
    if _reader(source) == "scan":
        fr = frames(source)
        return [{"run": fr[0]["run"], "unix": int(datetime.strptime(fr[0]["run"], "%Y%m%d%H")
                                                   .replace(tzinfo=timezone.utc).timestamp())}] if fr else []
    candidates = _cycle_runs(source, _PICKER_MOST, within_hours=_PICKER_HOURS)
    host_of = _locate(source, candidates, nomads_runs=len(candidates))
    fc = SOURCES[source]["forecast"]
    long, last = set(fc.get("long", ())), fc["hours"][-1]
    out = [{"run": f"{r:%Y%m%d%H}", "unix": int(r.timestamp()),
            "hours": int(last if not long or r.hour in long else fc["short"])}
           for r in candidates if r in host_of]
    with _LOCK:
        _RUNS[source] = (time.time(), out)
    return out


# A run whose every hour is out does not change again; its list is kept longer.
_RUN_DONE_TTL = 6 * 3600.0


def run_frames(source: str, run: str) -> list[dict]:
    """One run's hours, as frames."""
    if source not in SOURCES or not _is_fc(source):
        raise ValueError(f"{source} is not a forecast model")
    with _LOCK:
        hit = _RUN_FRAMES.get((source, run))
    if hit and time.time() < hit[0]:
        return hit[1]
    if _reader(source) == "scan":
        return [f for f in frames(source) if f["run"] == run]
    if SOURCES[source].get("storms") or _tracks(source):
        out = _storm_frames(source, run) if SOURCES[source].get("storms") else atcf.frames(run)
        with _LOCK:
            _RUN_FRAMES[(source, run)] = (time.time() + _RUNS_TTL, out)
        return out
    when = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    host_of = _locate(source, [when], nomads_runs=1)
    if when not in host_of:
        raise RuntimeError(f"{SOURCES[source]['label']}: the {when:%d %b %HZ} run is not available")
    out = _frames_of(source, when, _published_any(source, when, host_of[when]))
    fc = SOURCES[source]["forecast"]
    long = set(fc.get("long", ()))
    reach = fc["hours"][-1] if not long or when.hour in long else fc["short"]
    whole = len(out) >= sum(1 for h in fc["hours"] if h <= reach)
    with _LOCK:
        _RUN_FRAMES[(source, run)] = (time.time() + (_RUN_DONE_TTL if whole else _RUNS_TTL), out)
    return out


# ---------------------------------------------------------------------------
# Compare: one valid time from several runs of a model, or from every model
# that has the product.
# ---------------------------------------------------------------------------
# Mostly waiting on small requests (is this hour out?), so eight at once.
_COMPARE_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="obs-compare")


# Compare runs: one moment, forecast by run after run. How far back the strip
# reaches, and the recent stretch in which every run is listed (older ones only
# where they are a model's full-length runs, the way model viewers show it).
_STRIP_HOURS = 48
_STRIP_ALL_RUNS_HOURS = 6
_STRIP_TTL = 180.0
_STRIP: dict[tuple[str, str], tuple[float, list[dict]]] = {}


def _settled(run: datetime, reach: float) -> bool:
    """Whether a run is surely out whole by now: an hour and a half after it
    starts, and about another 36 minutes per day of forecast (HRRR's 48 h runs
    at 2.7 h, NAM at 3.6, the GFS at 11 and ECMWF at 10.5 -- each later than it
    really finishes). Such a run's hours are its schedule; asking the server
    for each one, as for a run still coming out, made the strip take ten
    seconds."""
    age = (datetime.now(timezone.utc) - run).total_seconds() / 3600.0
    return age >= 1.5 + reach * 0.025


def _make_strip(source: str, storm: str, run: str, quick: bool = False) -> tuple[list[dict], bool]:
    """The strip's runs, asking the servers as little as possible: at about a
    second a question to the AWS copy from here, checking every run took the
    strip seven seconds. A run surely finished is its schedule -- no question
    at all; a run still coming out is found, and its hours counted on the host
    it is on (no search of the others: the strip is made again every few
    minutes, and a run behind on the mirror catches up by then).

    `quick` asks no question at all: the runs still coming out are left out,
    and the second value says so -- the page shows the rest at once and asks
    again when the whole strip is made."""
    fc = SOURCES[source]["forecast"]
    long = set(fc.get("long", ()))

    def reach(r: datetime) -> float:
        return fc["hours"][-1] if not long or r.hour in long else fc["short"]

    if SOURCES[source].get("storms"):
        chosen: list[tuple[str, Optional[datetime], Optional[str]]] = [
            (r["run"], None, None) for r in runs(source) if r["run"].split("~", 1)[1] == storm]
    else:
        candidates = _cycle_runs(source, 200, within_hours=_STRIP_HOURS)
        recent = candidates[0] - timedelta(hours=_STRIP_ALL_RUNS_HOURS) if candidates else None
        picked = [r for r in candidates if not long or r.hour in long or (recent is not None and r >= recent)]
        young = [r for r in picked if not _settled(r, reach(r))]
        if quick and young:
            chosen = [(f"{r:%Y%m%d%H}", r, None) for r in picked if r not in young]
        else:
            host_of = _locate(source, young, nomads_runs=len(young))
            chosen = [(f"{r:%Y%m%d%H}", r, None if r not in young else host_of.get(r, "")) for r in picked]

    def hours_of(item: tuple[str, Optional[datetime], Optional[str]]) -> tuple[str, list[dict]]:
        rid, start, host = item
        try:
            if start is None:
                return rid, run_frames(source, rid)  # a storm model's run
            if host is None:
                return rid, _frames_of(source, start, sum(1 for h in fc["hours"] if h <= reach(start)))
            if not host:
                return rid, []  # not out anywhere yet
            return rid, _frames_of(source, start, _published(source, start, host))
        except Exception:  # noqa: BLE001 - a run that cannot be listed is left out
            return rid, []

    out = [{"run": rid, "title": f"{datetime.strptime(rid[:10], '%Y%m%d%H'):%d %b %HZ}", "frames": fr}
           for rid, fr in _COMPARE_POOL.map(hours_of, chosen) if fr]
    out.sort(key=lambda r: r["run"][:10])
    partial = quick and not SOURCES[source].get("storms") and len(chosen) < len(picked)
    if not partial:
        with _LOCK:
            _STRIP[(source, storm)] = (time.time(), out)
    return out, partial


# One strip made ahead at a time, off the requests: its own thread, since the
# strip itself fans out on _COMPARE_POOL.
_STRIP_WARMER = ThreadPoolExecutor(max_workers=1, thread_name_prefix="obs-strip")
_STRIP_BUSY: dict[tuple[str, str], threading.Event] = {}


def _strip_able(source: str) -> bool:
    return source in SOURCES and _is_fc(source) and not _tracks(source) and _reader(source) != "scan"


def warm_strip(source: str, run: str = "") -> None:
    """Make a model's strip ahead: opening Compare runs then finds it ready."""
    if not _strip_able(source):
        return
    storm = run.split("~", 1)[1] if "~" in run else ""
    ck = (source, storm)
    with _LOCK:
        hit = _STRIP.get(ck)
        if (hit and time.time() - hit[0] < _STRIP_TTL) or ck in _STRIP_BUSY:
            return
        done = _STRIP_BUSY[ck] = threading.Event()

    def job() -> None:
        try:
            _make_strip(source, storm, run)
        except Exception:  # noqa: BLE001 - asked for again by the page
            pass
        finally:
            with _LOCK:
                _STRIP_BUSY.pop(ck, None)
            done.set()

    _STRIP_WARMER.submit(job)


def strip(source: str, run: str = "") -> tuple[list[dict], bool]:
    """The runs a Compare runs strip picks from, oldest first, each with the
    hours of it that are out: every full-length run of the last two days and
    every run of the last six hours -- for a storm model, the runs made for the
    storm on screen (`run`). The page works out which of them reach whatever
    moment the timeline is on, so the strip follows the timeline, playing
    included, without asking again.

    Answered at once: from the list already made (a few minutes old at most;
    an older one is made again behind the answer), or else from the runs that
    need no question, with the runs still coming out added once the whole list
    is made in the background -- the second value says the page should ask
    again for them."""
    if source not in SOURCES or not _is_fc(source):
        raise ValueError(f"{source} is not a forecast model")
    if not _strip_able(source):
        return [], False  # one issuance at a time: nothing earlier to compare with
    storm = run.split("~", 1)[1] if "~" in run else ""
    with _LOCK:
        hit = _STRIP.get((source, storm))
    if hit:
        if time.time() - hit[0] >= _STRIP_TTL:
            warm_strip(source, run)
        return hit[1], False
    runs_now, partial = _make_strip(source, storm, run, quick=True)
    if partial:
        warm_strip(source, run)
    return runs_now, partial


def compare(source: str, field: str, unix: int, mode: str, run: str = "") -> list[dict]:
    """Every forecast model that draws `field` and has the instant `unix` in its
    newest run: the "All models" of the Compare models grid. (Compare runs
    reads `strip` instead.)"""
    _check(source, field)
    if mode != "models":
        raise ValueError("mode is models")

    def model(sid: str) -> Optional[dict]:
        try:
            fr = frames(sid)
        except Exception:  # noqa: BLE001 - a model that cannot list its hours is left out
            return None
        f = next((x for x in fr if x["unix"] == unix), None)
        if f is None:
            return None
        run = datetime.strptime(f["run"], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        return {"source": sid, "key": f["key"], "run": f["run"], "title": SOURCES[sid]["label"],
                "sub": f"{f['label'].split(' ')[0]} · {run:%HZ} run"}

    candidates = [sid for sid in sorted(SOURCES, key=_shelf)
                  if _is_fc(sid) and not _subh(sid) and not SOURCES[sid].get("storms") and not _tracks(sid)
                  and field in _OFFERS[sid]]
    return [c for c in _COMPARE_POOL.map(model, candidates) if c]


# A custom grid's window is any model on any product. It shows that model's
# hour nearest the timeline's valid time, no further off than this: a 3-hourly
# GFS beside an hourly HRRR shows its nearest hour, marked as such.
_WINDOW_SLACK = 3 * 3600


def window_at(source: str, field: str, unix: int, run: str = "") -> Optional[dict]:
    """One window of a custom compare grid: `source`'s picture of `field` at
    the instant `unix`, or the nearest hour within three. It comes from `run`
    when one is given and still reaches it, else from the newest run -- or,
    when the newest starts after `unix`, from the newest run that started
    before it. None when the model has nothing that close."""
    _check(source, field)
    if _tracks(source):
        raise ValueError("A compare window draws a product, not tracks")
    fc = _is_fc(source)

    def near(fr: list[dict]) -> Optional[dict]:
        best = min(fr, key=lambda f: abs(f["unix"] - unix), default=None)
        return best if best is not None and abs(best["unix"] - unix) <= _WINDOW_SLACK else None

    def closer(a: Optional[dict], b: Optional[dict]) -> Optional[dict]:
        if a is None or b is None:
            return a or b
        return b if abs(b["unix"] - unix) < abs(a["unix"] - unix) else a

    best = None
    if run and fc:
        try:
            best = near(run_frames(source, run))
        except Exception:  # noqa: BLE001 - a run no longer kept: the newest instead
            best = None
    if best is None or best["unix"] != unix:
        fr = frames(source)
        best = closer(best, near(fr))
        # The newest run starts after this instant: the one before it reaches back.
        plain = fc and not SOURCES[source].get("storms") and _reader(source) != "scan"
        if plain and (best is None or best["unix"] != unix) and (not fr or unix < fr[0]["unix"]):
            for r in [r for r in runs(source) if r["unix"] <= unix][:2]:
                try:
                    best = closer(best, near(run_frames(source, r["run"])))
                except Exception:  # noqa: BLE001 - not reachable: the next older one
                    continue
                if best is not None and best["unix"] == unix:
                    break
    if best is None:
        return None
    valid = datetime.fromtimestamp(best["unix"], tz=timezone.utc)
    if fc:
        start = datetime.strptime(best["run"][:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        sub = f"{best['label'].split(' ')[0]} · {start:%a %HZ} run"
    else:
        sub = "Analysis"
    if best["unix"] != unix:
        sub += f" · valid {valid:%H:%MZ}" if valid.minute else f" · valid {valid:%HZ}"
    return {"source": source, "key": best["key"], "run": best.get("run", ""), "title": SOURCES[source]["label"],
            "sub": sub, "unix": best["unix"]}


# ---------------------------------------------------------------------------
# Tropical models: each run is several storms, each on its own domain. A run
# id is 'YYYYMMDDHH~storm' ('2026092212~polo17e'); the picker lists storm and
# cycle together.
# ---------------------------------------------------------------------------
_STORMS: dict[str, tuple[float, list[dict]]] = {}
_STORM_NAMES: dict[str, str] = {}
_STORM_NAMES_AT = [0.0]


def _storm_names() -> dict[str, str]:
    """Current storm names by id ('17e' -> 'POLO'), from the bulletins the
    HAFS reads its storms from."""
    if time.time() - _STORM_NAMES_AT[0] < 1800:
        return _STORM_NAMES
    _STORM_NAMES_AT[0] = time.time()
    for n in range(1, 11):
        try:
            with ms.no_wait():
                r = ms._get(f"{NOMADS}/hafs/prod/inphfsa/message{n}")
        except Exception:  # noqa: BLE001 - names are a nicety
            break
        if r is None:
            break
        parts = r.text.split()
        if len(parts) >= 3:
            _STORM_NAMES[parts[1].lower()] = parts[2].upper()
    return _STORM_NAMES


def _storm_label(token: str) -> str:
    """'polo17e' -> '17E POLO'; '17e' -> '17E' and its name if known."""
    m = re.match(r"^([a-z]*)(\d\d[a-z])$", token)
    if not m:
        return token.upper()
    name = m.group(1).upper() or _storm_names().get(m.group(2), "")
    if name in ("INVEST", "NONAME", ""):
        name = "INVEST" if m.group(2)[0] == "9" else name
    return f"{m.group(2).upper()} {name}".strip()


def _storm_runs(source: str) -> list[dict]:
    """The storms of the model's last few cycles, newest cycle first."""
    with _LOCK:
        hit = _STORMS.get(source)
    if hit and time.time() - hit[0] < _RUNS_TTL:
        return hit[1]
    cfg = SOURCES[source]["storms"]
    out: list[dict] = []
    for run in _cycle_runs(source, 4):
        try:
            with ms.no_wait():
                r = ms._get(_fill(cfg["dir"], _fkey(run, 0)))
        except Exception:  # noqa: BLE001 - a cycle that cannot be listed is left out
            continue
        if r is None:
            continue
        for token in sorted(set(re.findall(cfg["file"], r.text))):
            out.append({"run": f"{run:%Y%m%d%H}~{token}", "unix": int(run.timestamp()),
                        "label": f"{_storm_label(token)} · {run:%a %d %b %HZ}"})
    with _LOCK:
        _STORMS[source] = (time.time(), out)
    return out


def _storm_frames(source: str, rid: str) -> list[dict]:
    """One storm run's hours, as frames."""
    hours = SOURCES[source]["forecast"]["hours"]
    run = datetime.strptime(rid[:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)
    host = next(iter(SOURCES[source]["urls"]))

    def there(fh: int) -> bool:
        key = f"{rid}_f{fh:03d}"
        try:
            with ms.no_wait():
                return _is_out(source, _url_for(source, host, key), key)
        except Exception:  # noqa: BLE001
            return False

    if not there(hours[0]):
        return []
    lo, hi = 0, len(hours) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if there(hours[mid]):
            lo = mid
        else:
            hi = mid - 1
    return [{"key": f"{rid}_f{fh:03d}", "unix": int((run + timedelta(hours=fh)).timestamp()),
             "label": f"F{fh:03d} {run + timedelta(hours=fh):%a %HZ}", "fh": fh, "run": rid}
            for fh in hours[:lo + 1]]


def _discover_storm(source: str) -> list[dict]:
    """The newest storm run with a few hours out; the others are in the picker."""
    out: list[dict] = []
    for r in _storm_runs(source):
        out = _storm_frames(source, r["run"])
        if len(out) >= _MIN_RUN_HOURS:
            break
    with _LOCK:
        _FRAMES[source] = (time.time(), out)
    return out


def _discover_scan(source: str) -> list[dict]:
    """The NDFD: the current issuance only (the files are replaced every hour),
    its hours the valid times of the element it names as its clock."""
    template = SOURCES[source]["urls"]["aws"]
    urls, _ = _scan_urls(template, f"{SOURCES[source]['probe']}|0")
    msgs = [m for u in urls for m in ms.scan_messages(u)]
    out: list[dict] = []
    if msgs:
        run = max(m["ref"] for m in msgs).replace(minute=0, second=0, microsecond=0)
        for valid in sorted({m["valid"] for m in msgs}):
            fh = int((valid - run).total_seconds() // 3600)
            if fh >= 0:
                out.append({"key": f"{run:%Y%m%d%H}_f{fh:03d}", "unix": int(valid.timestamp()),
                            "label": f"F{fh:03d} {valid:%a %HZ}", "fh": fh, "run": f"{run:%Y%m%d%H}"})
    with _LOCK:
        _FRAMES[source] = (time.time(), out)
    return out


def _discover_forecast(source: str) -> list[dict]:
    """The hours of the newest usable run, as frames.

    A run is published hour by hour, in order, so which hours exist is a
    matter of where the published ones stop: a binary search finds that in
    about eight lookups even for the GFS's 209. The same search copes with runs
    of different lengths -- an hourly HRRR run stops at 18 h, a synoptic one at
    48 -- without being told which is which.

    The mirror is asked first, because it is free; NOMADS only for the newest
    runs the mirror does not have yet, and only while its budget allows. Some
    mirrors lag badly: the NAM's was over twelve hours behind NOMADS. What is
    found without that budget is only the best for now -- see _short_frames.
    """
    if SOURCES[source].get("storms"):
        return _discover_storm(source)
    if _reader(source) == "scan":
        return _discover_scan(source)
    if _tracks(source):
        rid = next((r["run"] for r in atcf.storm_runs()), None)
        out = atcf.frames(rid) if rid else []
        with _LOCK:
            _FRAMES[source] = (time.time(), out)
        return out
    fc = SOURCES[source]["forecast"]
    long = set(fc.get("long", ()))
    runs = _cycle_runs(source, _RUN_LOOKBACK)
    if long:
        # Only the runs that go the whole way (see obs_products._LONG_RUNS).
        runs = [r for r in _cycle_runs(source, 96, within_hours=48) if r.hour in long][:4] or runs
    _TLS.short = False
    host_of = _locate(source, runs, nomads_runs=3)
    candidates = [r for r in runs if r in host_of][:3]
    # A run still coming in takes over once half its hours are out; until then
    # the run before it reaches further ahead.
    need = max(_MIN_RUN_HOURS, len(fc["hours"]) // 2)
    chosen: Optional[datetime] = None
    count = 0
    for run in candidates:
        n = _published_any(source, run, host_of[run], need)
        if n > count:
            chosen, count = run, n
        if n >= need:
            chosen, count = run, n
            break

    out = _frames_of(source, chosen, count) if chosen is not None else []
    if _TLS.short:
        return _short_frames(source, out, runs[-1])
    with _LOCK:
        _FRAMES[source] = (time.time(), out)
    try:
        _MAP_DIR.mkdir(parents=True, exist_ok=True)
        _frames_path(source).write_text(json.dumps({"saved": time.time(), "frames": out}), encoding="utf-8")
    except OSError:
        pass
    return out


def _short_frames(source: str, out: list[dict], oldest: datetime) -> list[dict]:
    """A forecast list found while NOMADS was out of budget or refusing us, and
    so perhaps without the newest runs: after a fourteen-model compare grid, the
    NAM and NAM Nest opened AWS's copy of a run a day old and the RRFS,
    NOMADS-only, had no hours at all -- for the five minutes of the cache, and
    past a restart from disk. Under a NOMADS block the NAM Nest settled on the
    17 hours AWS had of its 06Z run, the 18Z whole on NOMADS.

    So this list is looked for again in _SHORT_TTL, is never saved, and gives
    way to one already had, in memory or on disk, of a newer run or of the same
    run further along -- while that run is still among those looked for, from
    `oldest` on, and so still published."""
    def rank(fr: list[dict]) -> tuple[str, int]:
        return (fr[0]["run"], len(fr)) if fr else ("", 0)

    with _LOCK:
        hit = _FRAMES.get(source)
    floor = f"{oldest:%Y%m%d%H}"
    best = out
    for had in (hit[1] if hit else None, _read_saved_frames(source, max_age=None)):
        if had and had[0].get("run", "") >= floor and rank(had) > rank(best):
            best = had
    with _LOCK:
        _FRAMES[source] = (time.time() - _FRAMES_TTL + _SHORT_TTL, best)
    return best

# ---------------------------------------------------------------------------
# Colour
# ---------------------------------------------------------------------------
# How much livelier the maps draw than the palettes are written: a model's
# colours sit over the basemap at some transparency, which dulls them.
_VIVID = 1.22


def _vivid(rgb: np.ndarray) -> np.ndarray:
    """Colours (n x 3, 0-255) with their saturation raised by _VIVID in HSL,
    lightness kept -- so a palette's order of light and dark is untouched and
    greys stay grey."""
    c = rgb.astype(np.float64) / 255.0
    mx, mn = c.max(axis=1), c.min(axis=1)
    light = (mx + mn) / 2.0
    chroma = mx - mn
    with np.errstate(invalid="ignore", divide="ignore"):
        sat = np.where(chroma > 1e-9, chroma / (1.0 - np.abs(2.0 * light - 1.0)), 0.0)
    new_sat = np.clip(sat * _VIVID, 0.0, 1.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        k = np.where(sat > 1e-9, new_sat / sat, 1.0)
    # Scaling each channel's distance from the lightness scales chroma, and so
    # saturation, by the same factor while the lightness stays put.
    out = light[:, None] + (c - light[:, None]) * k[:, None]
    return np.clip(np.round(out * 255.0), 0, 255)


def _lut(stops: list[tuple[float, str]], stepped: bool = False, steps: int = 256) -> tuple[np.ndarray, float, float]:
    """A stop list -> an RGBA table, plus the range it spans."""
    lo, hi = stops[0][0], stops[-1][0]
    xs = np.array([v for v, _ in stops], dtype=np.float64)
    cols = []
    for _, hexcol in stops:
        h = hexcol.lstrip("#")
        cols.append([int(h[i:i + 2], 16) for i in (0, 2, 4)] + ([int(h[6:8], 16)] if len(h) == 8 else [255]))
    cols_arr = np.array(cols, dtype=np.float64)
    cols_arr[:, :3] = _vivid(cols_arr[:, :3])
    grid = np.linspace(lo, hi, steps)
    table = np.empty((steps, 4), dtype=np.uint8)
    if stepped:
        which = np.clip(np.searchsorted(xs, grid, side="right") - 1, 0, len(xs) - 1)
        table[:] = cols_arr[which].astype(np.uint8)
    else:
        for c in range(4):
            table[:, c] = np.clip(np.interp(grid, xs, cols_arr[:, c]), 0, 255).astype(np.uint8)
    return table, lo, hi


_LUTS: dict[str, tuple[np.ndarray, float, float]] = {}


def _lut_for(pid: str) -> tuple[np.ndarray, float, float]:
    if pid not in _LUTS:
        spec = PRODUCTS[pid]
        _LUTS[pid] = _lut(spec["palette"], spec["stepped"], spec.get("lut_steps", 256))
    return _LUTS[pid]


def _nice_ticks(lo: float, hi: float, most: int = 7) -> list[float]:
    """Round numbers across [lo, hi] -- 0, 40, 80 rather than 0, 33.3, 66.7. The
    legend places each at its own position, so they need not reach both ends."""
    span = hi - lo
    if span <= 0:
        return [lo]
    raw = span / (most - 1)
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    first = math.ceil(lo / step - 1e-9) * step
    return [round(float(v), 2) for v in np.arange(first, hi + step * 1e-6, step)]


def colour_bar(pid: str, steps: int = 32) -> dict[str, Any]:
    """What the legend draws: evenly spaced swatches across the palette."""
    table, lo, hi = _lut_for(pid)
    idx = np.linspace(0, table.shape[0] - 1, steps).astype(int)
    return {
        "unit": PRODUCTS[pid]["unit"],
        "min": lo,
        "max": hi,
        "colors": ["#%02x%02x%02x%02x" % tuple(table[i]) for i in idx],
        "ticks": [] if PRODUCTS[pid].get("labels") else _nice_ticks(lo, hi),
        "labels": PRODUCTS[pid].get("labels"),
    }


# ---------------------------------------------------------------------------
# Reading variables
# ---------------------------------------------------------------------------
def _xyz(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    lo, la = np.radians(lon), np.radians(lat)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def _regular_mapping(field: "ms.Field", shape: tuple[int, int], step: float) -> dict:
    """The mapping for a plain lat/lon grid, by arithmetic rather than search.

    Longitudes are published 0..360 by the NCEP global files; the drawing grid
    is -180..180 like the map, so the column is taken modulo the row length --
    which also makes the seam at the antimeridian join instead of tearing.
    """
    src_lat = np.asarray(field.lats, dtype=np.float64)
    src_lon = np.asarray(field.lons, dtype=np.float64)
    nj, ni = shape

    # Mercator has no pole: the map places an image by its corners, and a corner
    # at 90 degrees is infinitely far up. A global file is therefore cut at the
    # latitude the projection can actually draw.
    top = min(float(src_lat.max()), 85.0)
    bottom = max(float(src_lat.min()), -85.0)
    lats = np.arange(math.floor(top / step) * step, bottom - 1e-9, -step)
    west = ((src_lon.min() + 180.0) % 360.0) - 180.0
    span = float(src_lon.max() - src_lon.min())
    if span >= 360.0 - 2 * abs(float(src_lon[1] - src_lon[0])):
        lons = np.arange(-180.0, 180.0 - 1e-9, step)   # goes all the way round
    else:
        lons = np.arange(math.ceil(west / step) * step, west + span + 1e-9, step)

    dlat = float(src_lat[1] - src_lat[0])
    dlon = float(src_lon[1] - src_lon[0])
    rows = np.rint((lats - src_lat[0]) / dlat).astype(np.int64)
    cols = np.rint((((lons - src_lon[0]) % 360.0) / dlon)).astype(np.int64) % ni
    good_rows = (rows >= 0) & (rows < nj)
    rows = np.clip(rows, 0, nj - 1)

    nn = (rows[:, None] * ni + cols[None, :]).ravel().astype(np.int32)
    inside = np.broadcast_to(good_rows[:, None], (len(lats), len(lons))).ravel().copy()
    return {"shape": shape, "lats": lats, "lons": lons, "nn": nn, "inside": inside}


def _cell_mapping(source: str, key: str) -> dict:
    """The mapping for ICON's icosahedral mesh: no rows or columns, so every
    drawing cell takes the nearest of the 2.9 million cell centres, whose
    coordinates are published beside the run as fields of their own."""
    cells = SOURCES[source]["cells"]
    coords = []
    for name in ("lat", "lon"):
        vals = ms.file_values_at(_fill(cells[name], key))
        if vals is None:
            raise RuntimeError(f"{SOURCES[source]['label']}: the cell {name}itudes are not published")
        vals = vals.astype(np.float64).ravel()
        coords.append(np.degrees(vals) if np.nanmax(np.abs(vals)) <= math.pi + 0.01 else vals)
    lat_c, lon_c = coords
    step = SOURCES[source]["step"]
    lats = np.arange(math.floor(85.0 / step) * step, -85.0 - 1e-9, -step)
    lons = np.arange(-180.0, 180.0 - 1e-9, step)
    glon, glat = np.meshgrid(lons, lats)
    tree = cKDTree(_xyz(lon_c, lat_c))
    _dist, nn = tree.query(_xyz(glon.ravel(), glat.ravel()), k=1, workers=-1)
    del tree
    return {"lats": lats, "lons": lons, "nn": nn.astype(np.int32), "inside": np.ones(nn.shape, dtype=bool)}


def _curvilinear(source: str) -> bool:
    """On a projected grid (Lambert: the CAMs, NAM, RAP, RTMA, NBM, NDFD), whose
    cells are read onto the drawing grid by interpolation rather than by the
    nearest one."""
    return "lov" in SOURCES[source] or _reader(source) == "scan"


# The saved mappings of projected grids carry the interpolation positions from
# this version on; the older ones held only the nearest cell.
_MAP_V = "-v2"


def _map_file(source: str, shape: tuple[int, ...], key: Optional[str] = None) -> Path:
    grid, step = _grid_id(source, key), SOURCES[source]["step"]
    dims = f"{shape[0]}x{shape[1]}" if len(shape) == 2 else f"{shape[0]}x0"
    return _MAP_DIR / f"{grid}-{dims}-{step:g}{_MAP_V if _curvilinear(source) else ''}.npz"


def _map_entry(z, shape: tuple[int, ...]) -> dict:
    entry = {"shape": shape, "lats": z["lats"], "lons": z["lons"], "nn": z["nn"], "inside": z["inside"]}
    if "fi" in z:
        entry["fj"], entry["fi"] = z["fj"], z["fi"]
    return entry


def _fractional(lat2: np.ndarray, lon2: np.ndarray, nn: np.ndarray, glat: np.ndarray, glon: np.ndarray,
                inside: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where each drawing cell falls between the source's cells, as fractional
    row and column. The nearest cell is where it starts; the grid's own
    spacing around it (the local Jacobian of latitude and longitude against
    row and column) says how far and which way to go, twice over.

    Taking just the nearest cell, as before, read a 3 km grid onto a 3.3 km
    drawing grid with a cell repeated or skipped every few: stair steps, which
    a blur then hid along with the detail."""
    nj, ni = lat2.shape
    j = (nn // ni).astype(np.float64)
    i = (nn % ni).astype(np.float64)
    tlat, tlon = glat.ravel(), glon.ravel()
    for _ in range(2):
        j0 = np.clip(np.floor(j), 0, nj - 2).astype(np.int64)
        i0 = np.clip(np.floor(i), 0, ni - 2).astype(np.int64)
        p_lat, p_lon = lat2[j0, i0], lon2[j0, i0]
        a_lat, a_lon = lat2[j0, i0 + 1] - p_lat, lon2[j0, i0 + 1] - p_lon
        b_lat, b_lon = lat2[j0 + 1, i0] - p_lat, lon2[j0 + 1, i0] - p_lon
        d_lat, d_lon = tlat - p_lat, tlon - p_lon
        det = a_lat * b_lon - a_lon * b_lat
        with np.errstate(invalid="ignore", divide="ignore"):
            di = (d_lat * b_lon - d_lon * b_lat) / det
            dj = (a_lat * d_lon - a_lon * d_lat) / det
        ok = np.isfinite(di) & np.isfinite(dj)
        i = np.where(ok, i0 + di, i)
        j = np.where(ok, j0 + dj, j)
    j = np.clip(j, 0, nj - 1)
    i = np.clip(i, 0, ni - 1)
    j[~inside], i[~inside] = 0, 0
    return j.astype(np.float32), i.astype(np.float32)


# How a projected grid is read onto the drawing grid. Pablo picked the nearest
# cell, unblurred, in a side-by-side of the same HRRR hour (2026-09-23): every
# cell keeps its own value, the crispest picture there is -- at the price of a
# cell repeated or skipped now and then where the two grids' spacings beat,
# visible as small steps only zoomed well in. True reads between the four cells
# around instead (smoother, no steps, a little of the detail averaged away).
_INTERPOLATE_PROJECTED = False

# Categorical fields: a code, not an amount. Halfway between rain and snow is
# not a third kind of weather, so these keep the nearest cell.
_NEAREST = {"crain", "csnow", "cicep", "cfrzr", "ptype_code", "mr_pflag", "mr_jump", "mr_jump5"}
# Products whose values are kinds, not amounts: resampled by the nearest cell,
# since halfway between rain and snow is not a third kind of weather.
_CATEGORICAL_FMTS = ("ptype", "rms", "pflag", "jump")


def _weights_of(m: dict, ni: int) -> tuple[np.ndarray, list[np.ndarray]]:
    """The four source cells around each drawing cell (as the index of the
    first) and their weights, worked out once per grid and kept with it."""
    if "w4" not in m:
        fj, fi = m["fj"], m["fi"]
        nj = m["shape"][0]
        j0 = np.clip(np.floor(fj), 0, nj - 2).astype(np.int32)
        i0 = np.clip(np.floor(fi), 0, ni - 2).astype(np.int32)
        wj = np.clip(fj - j0, 0.0, 1.0).astype(np.float32)
        wi = np.clip(fi - i0, 0.0, 1.0).astype(np.float32)
        m["base"] = (j0.astype(np.int64) * ni + i0).astype(np.int32)
        m["w4"] = [(1 - wj) * (1 - wi), (1 - wj) * wi, wj * (1 - wi), wj * wi]
    return m["base"], m["w4"]


def _onto_grid(values: np.ndarray, m: dict, nearest: bool) -> np.ndarray:
    """One field on the drawing grid: interpolated between the four source cells
    around each drawing cell where the mapping has their positions, and a cell
    beside missing data leans on its neighbours that have some."""
    if nearest or not _INTERPOLATE_PROJECTED or "fi" not in m or values.ndim != 2:
        return values.ravel()[m["nn"]].astype(np.float32)
    ni = values.shape[1]
    base, w4 = _weights_of(m, ni)
    flat = values.astype(np.float32, copy=False).ravel()
    offsets = (0, 1, ni, ni + 1)
    if np.isfinite(flat).all():
        out = flat[base] * w4[0]
        for off, w in zip(offsets[1:], w4[1:]):
            out += flat[base + off] * w
        return out
    total = np.zeros(base.shape, dtype=np.float32)
    weight = np.zeros(base.shape, dtype=np.float32)
    for off, w in zip(offsets, w4):
        v = flat[base + off]
        good = np.isfinite(v)
        total += np.where(good, v, 0.0) * w
        weight += np.where(good, w, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(weight > 1e-6, total / weight, np.nan).astype(np.float32)


def _mapping(source: str, shape: tuple[int, ...], url: str, match: str, key: str = "") -> dict:
    """Where every cell of the drawing grid takes its value from.

    The analyses are on Lambert grids, so a regular lat/lon picture needs, for
    each output cell, the nearest source cell. That lookup is the expensive part
    and it never changes -- the grid is the same every hour -- so it is done
    once, kept as a plain index array, and saved to disk so a restart does not
    repeat it. Every variable after is one gather.
    """
    step = SOURCES[source]["step"]
    grid = _grid_id(source, key)
    with _LOCK:
        hit = _MAPS.get(grid)
    if hit and hit["shape"] == shape:
        return hit

    path = _map_file(source, shape, key)
    if path.exists():
        try:
            with np.load(path) as z:
                entry = _map_entry(z, shape)
            with _LOCK:
                _MAPS[grid] = entry
            return entry
        except Exception:  # noqa: BLE001 - a damaged cache is rebuilt, not trusted
            pass

    if len(shape) == 1:
        entry = {"shape": shape, **_cell_mapping(source, key)}
        try:
            _MAP_DIR.mkdir(parents=True, exist_ok=True)
            np.savez(path, lats=entry["lats"], lons=entry["lons"], nn=entry["nn"], inside=entry["inside"])
        except OSError:
            pass
        with _LOCK:
            _MAPS[grid] = entry
        return entry

    field = _FIELDS[_reader(source)](url, _fill(_plain(_address(match).where), key) if key else _plain(_address(match).where))
    if field is None or field.lats.ndim not in (1, 2):
        raise RuntimeError(f"{SOURCES[source]['label']}: could not read the grid's coordinates")

    if field.lats.ndim == 1:
        # A plain lat/lon grid -- the global models. Nearest neighbour is which
        # row and column the cell falls in, so there is no tree to build: the
        # axes are regular and the answer is arithmetic.
        entry = _regular_mapping(field, shape, step)
        try:
            _MAP_DIR.mkdir(parents=True, exist_ok=True)
            np.savez(path, lats=entry["lats"], lons=entry["lons"],
                     nn=entry["nn"], inside=entry["inside"])
        except OSError:
            pass
        with _LOCK:
            _MAPS[grid] = entry
        return entry

    lat2 = field.lats.astype(np.float64)
    lon2 = field.lons.astype(np.float64)

    lats = np.arange(math.floor(np.nanmax(lat2) / step) * step, np.nanmin(lat2) - 1e-9, -step)
    lons = np.arange(math.ceil(np.nanmin(lon2) / step) * step, np.nanmax(lon2) + 1e-9, step)
    glon, glat = np.meshgrid(lons, lats)

    # Thin the source to about the drawing grid's spacing: nearest-neighbour
    # onto 5 km cells gains nothing from every 2.5 km point.
    native = float(np.nanmedian(np.abs(np.diff(lat2[:, lat2.shape[1] // 2]))))
    stride = max(1, int(round(step / max(native, 1e-6))))
    full_index = np.arange(lat2.size, dtype=np.int64).reshape(shape)[::stride, ::stride].ravel()
    tree = cKDTree(_xyz(lon2.ravel()[full_index], lat2.ravel()[full_index]))
    dist, nn = tree.query(_xyz(glon.ravel(), glat.ravel()), k=1, workers=-1)
    del tree

    # Further than a cell and a half from any source point is outside the domain.
    inside = dist <= math.radians(max(native * stride, step) * 1.5)
    nn = full_index[nn].astype(np.int32)
    nn[~inside] = 0
    fj, fi = _fractional(lat2, lon2, nn, glat, glon, inside)

    entry = {"shape": shape, "lats": lats, "lons": lons, "nn": nn, "inside": inside, "fj": fj, "fi": fi}
    try:
        _MAP_DIR.mkdir(parents=True, exist_ok=True)
        np.savez(path, lats=lats, lons=lons, nn=nn, inside=inside, fj=fj, fi=fi)
    except OSError:
        pass
    with _LOCK:
        _MAPS[grid] = entry
    return entry


def _grid_id(source: str, key: Optional[str] = None) -> str:
    """Which regrid mapping a source reads through. A tropical model's domain
    is centred on its storm when the run starts, so there it is the run's."""
    grid = SOURCES[source].get("grid", source)
    if SOURCES[source].get("storms"):
        if not key:
            raise RuntimeError("a storm model's grid moves with each run")
        return f"{grid}-{key.split('_f', 1)[0]}"
    return grid


def _saved_mapping(source: str, key: Optional[str] = None) -> bool:
    """Load a mapping saved by an earlier run without knowing the grid's shape
    first -- which otherwise takes a download to learn."""
    grid = _grid_id(source, key)
    with _LOCK:
        if grid in _MAPS:
            return True
    step = SOURCES[source]["step"]
    for path in _MAP_DIR.glob(f"{grid}-*x*-{step:g}{_MAP_V if _curvilinear(source) else ''}.npz"):
        try:
            nj, ni = (int(v) for v in path.stem[len(grid) + 1:].split("-")[0].split("x"))
            with np.load(path) as z:
                entry = _map_entry(z, (nj, ni) if ni else (nj,))
        except Exception:  # noqa: BLE001 - not a usable map; the download path builds one
            continue
        with _LOCK:
            _MAPS[grid] = entry
        return True
    return False


def _hosts(source: str, key: str) -> list[str]:
    """Which copy to read an hour from, first choice first.

    NOMADS is about twice as quick from here but allows sixty requests a minute
    across the whole app, and a severe-weather product is six fields an hour.
    So the hour someone is waiting for goes to NOMADS while there is room, the
    warm-up of neighbouring hours goes to the mirror unless NOMADS is idle, and
    an hour NOMADS has already pruned goes straight to the mirror.
    """
    have = SOURCES[source]["urls"]
    if "nomads" not in have:
        return list(have)  # a centre's own servers and mirrors, first listed first
    if "aws" not in have:
        return ["nomads"]  # no public mirror: NOMADS or nothing
    if (source, key[:8]) in _NOMADS_GONE:
        return ["aws"]
    room = ms.room(NOMADS_HOST)
    background = getattr(_TLS, "background", False)
    # A loop someone pressed play on sits between the two: it may use NOMADS
    # while it is well clear of the limit, and leaves the rest for the frame
    # on screen.
    need = 12 if getattr(_TLS, "loop", False) else 30 if background else 4
    if room >= need:
        return ["nomads", "aws"]
    return ["aws", "nomads"]


# ---------------------------------------------------------------------------
# Ensemble statistics worked out here from the members, for the ensembles that
# publish their members but not the statistic: ECMWF's 50, the GEFS's 31.
# A record "ens:STAT:RECORD" is RECORD read from every member and combined:
#   mean, max, min      at each point
#   p>V, p<V            the share of members above or below V, in percent
# and "ens:STAT:dN:RECORD" first takes each member's change over N hours (a
# 24-hour total out of a run total), "ens:STAT:sN:RECORD" each member's sum of
# N/6 six-hour buckets.
# ---------------------------------------------------------------------------
_ENS_POOL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="obs-ens")


class _EnsStat:
    """A statistic gathered one member at a time: fifty global fields held at
    once would be 200 MB."""

    def __init__(self, stat: str):
        self.kind = stat[:2] if stat[:2] in ("p>", "p<") else stat
        self.thr = float(stat[2:]) if self.kind in ("p>", "p<") else 0.0
        self.acc: Optional[np.ndarray] = None
        self.count: Optional[np.ndarray] = None

    def add(self, v: np.ndarray) -> None:
        v = v.astype(np.float32, copy=False)
        seen = np.isfinite(v)
        if self.acc is None:
            self.count = np.zeros(v.shape, dtype=np.float32)
            self.acc = (np.full(v.shape, np.nan, dtype=np.float32) if self.kind in ("max", "min")
                        else np.zeros(v.shape, dtype=np.float32))
        self.count += seen
        if self.kind == "mean":
            self.acc += np.where(seen, v, 0.0)
        elif self.kind == "max":
            self.acc = np.fmax(self.acc, v)
        elif self.kind == "min":
            self.acc = np.fmin(self.acc, v)
        else:
            hit = (v > self.thr) if self.kind == "p>" else (v < self.thr)
            self.acc += seen & hit

    def result(self) -> np.ndarray:
        if self.acc is None:
            raise RuntimeError("no ensemble member could be read")
        if self.kind in ("max", "min"):
            return self.acc
        with np.errstate(invalid="ignore", divide="ignore"):
            out = self.acc / self.count
        return (out * 100.0 if self.kind in ("p>", "p<") else out).astype(np.float32)


def _ens_parts(where: str) -> tuple[str, Optional[tuple[str, int]], str]:
    """'ens:p>25.4:d24:param=tp' -> ('p>25.4', ('d', 24), 'param=tp')."""
    _, stat, rest = where.split(":", 2)
    m = re.match(r"^([ds])(\d+):(.*)$", rest)
    return (stat, (m.group(1), int(m.group(2))), m.group(3)) if m else (stat, None, rest)


def _plain(where: str) -> str:
    """The record behind an ensemble statistic, for reading one member's grid."""
    return _ens_parts(where)[2] if where.startswith("ens:") else where


def _member_readers(source: str, host: str, key: str, record: str) -> dict[str, Callable[[], Optional[np.ndarray]]]:
    """For each member, a way to read `record` at `key`, by member name."""
    if _reader(source) == "ecmwf":
        url = _url_for(source, host, key)
        out = {}
        for e in ms._ecmwf_entries(url, ms.ecmwf_match(record)):
            def read(e=e):
                raw = ms._ecmwf_range(url, e)
                return ms._values_of(raw) if raw else None
            out[str(e.get("number", 0))] = read
        return out
    members = SOURCES[source]["members"]
    template = _fill(members["urls"][host], key)
    return {m: (lambda url=template.replace("{mem}", m): ms.values_at(url, record)) for m in members["ids"]}


def _ens_values(source: str, key: str, where: str, scale: float, above: Optional[float]) -> tuple[np.ndarray, str]:
    stat, window, record = _ens_parts(where)
    run, fh = _run_fh(key)
    if fh is None:
        raise RuntimeError("ensemble statistics are for forecasts")
    hours = SOURCES[source]["forecast"]["hours"]
    # The hours each member's value is made of, with the sign each is taken at.
    parts: list[tuple[int, float]] = [(fh, 1.0)]
    if window and window[0] == "d" and fh - window[1] > 0:
        if fh - window[1] not in hours:
            raise RuntimeError(f"a {window[1]} h change needs the hour {window[1]} h before, and this run skips it")
        parts.append((fh - window[1], -1.0))
    elif window and window[0] == "s":
        parts = [(h, 1.0) for h in range(fh, max(fh - window[1], 0), -6)]
        if any(h not in hours for h, _ in parts):
            raise RuntimeError(f"a {window[1]} h total is made every six hours: not at this hour")

    members_of = SOURCES[source].get("members", {}).get("urls", SOURCES[source]["urls"])
    host = "aws" if "aws" in members_of else next(iter(members_of))
    readers = [_member_readers(source, host, _fkey(run, h), record) for h, _ in parts]
    names = [m for m in readers[0] if all(m in r for r in readers[1:])]
    if not names:
        raise RuntimeError(f"{SOURCES[source]['label']} {_valid(key)[1]}: no members published for {record}")

    def one(name: str) -> Optional[np.ndarray]:
        total: Optional[np.ndarray] = None
        for (_h, sign), r in zip(parts, readers):
            v = r[name]()
            if v is None:
                return None
            v = v * np.float32(sign * scale)
            total = v if total is None else total + v
        if above is not None and total is not None:
            total = np.where(total >= above, np.nan, total)
        return total

    acc = _EnsStat(stat)
    got = 0
    for v in _ENS_POOL.map(one, names):
        if v is not None:
            acc.add(v)
            got += 1
    if got < 0.9 * len(names):
        raise RuntimeError(f"{SOURCES[source]['label']} {_valid(key)[1]}: only {got} of {len(names)} members read")
    if _reader(source) == "ecmwf":
        return acc.result(), _url_for(source, host, key)
    return acc.result(), _fill(SOURCES[source]["members"]["urls"][host], key).replace("{mem}", names[0])


def _values(source: str, key: str, match: str) -> tuple[np.ndarray, str]:
    """One raw field, as (values shaped like the file's grid, the URL it came from)."""
    run, _fh = _run_fh(key)
    where, scale, first, above, file = _address(match)
    if first and _fh is not None:
        key = _with_fh(key, 0, _subh(source))
    read = _READERS[_reader(source)]
    last: Optional[Exception] = None
    where = _fill(where, key)
    if where.startswith("ens:"):
        return _ens_values(source, key, where, scale, above)
    hosts = _hosts(source, key)
    for host in hosts:
        url = _url_for(source, host, key, file)
        if "{var}" in url and _reader(source) == "file":
            url = url.replace("{var}", where)  # a file per variable: the record is the file
        try:
            # Never sleep on the NOMADS budget when a mirror has the same file.
            # A model NOMADS alone publishes waits its turn instead: failing
            # would only show an error where the picture comes a minute later.
            with ms.no_wait() if len(hosts) > 1 else contextlib.nullcontext():
                got = read(url, where)
                if got is not None and above is not None:
                    got = np.where(got >= above, np.nan, got).astype(np.float32)
                if got is not None and scale != 1.0:
                    got = got * np.float32(scale)
        except ms.RateLimited as exc:
            last = exc
            continue
        except Exception as exc:  # noqa: BLE001 - a dropped connection: try the other copy
            last = exc
            continue
        if got is not None:
            return got, url
        # A whole day NOMADS has let go of: do not ask it again for that day. Only
        # for hours a day old -- a recent hour missing is late, not pruned.
        if host == "nomads" and datetime.now(timezone.utc) - run > timedelta(hours=24):
            try:
                with ms.no_wait():
                    gone = not ms.has_idx(url)
            except ms.RateLimited:
                gone = False
            if gone:
                with _LOCK:
                    _NOMADS_GONE.add((source, key[:8]))
    if last is None:
        raise RuntimeError(f"{SOURCES[source]['label']} does not publish this for {_valid(key)[1]} "
                           f"({where}) -- it may come only at some hours")
    raise RuntimeError(f"{SOURCES[source]['label']} {_valid(key)[1]}: {where} is not available ({last})")


def _vars_put(ck: tuple, arr: np.ndarray) -> None:
    global _VARS_BYTES
    with _LOCK:
        old = _VARS.pop(ck, None)
        if old is not None:
            _VARS_BYTES -= old.nbytes
        _VARS[ck] = arr
        _VARS_BYTES += arr.nbytes
        while _VARS_BYTES > _VARS_BUDGET and len(_VARS) > 1:
            _, dropped = _VARS.popitem(last=False)
            _VARS_BYTES -= dropped.nbytes


def _vars_get(ck: tuple) -> Optional[np.ndarray]:
    with _LOCK:
        hit = _VARS.get(ck)
        if hit is not None:
            _VARS.move_to_end(ck)
        return hit


def _var_path(source: str, name: str, key: str) -> Path:
    # The record's address is part of the name: change what a variable is read
    # from -- another time window, another scale -- and the copies read the old
    # way are simply never found again, instead of being served as the new.
    # So is a source's `reread`, bumped when the reading itself changed: the
    # NBM's copies from before its backwards rows were turned round.
    record = SOURCES[source]["raw"].get(name, "") + (f"#{SOURCES[source]['reread']}" if SOURCES[source].get("reread") else "")
    # And projected grids read by interpolation are kept apart; read by the
    # nearest cell they are the same arrays as always, and those are reused.
    record += _MAP_V if _curvilinear(source) and _INTERPOLATE_PROJECTED else ""
    tag = zlib.crc32(record.encode("utf-8")) & 0xFFFF
    return _VAR_DIR / f"{source}-{key}-{name}-{tag:04x}.npz"


def _disk_write(path: Path, arr: np.ndarray) -> None:
    """Sixteen-bit steps across the field's own range: a sixty-fifth of a
    thousandth of it, finer than any colour or contour drawn from it, at half
    the bytes of float32 before zlib takes most of the rest."""
    global _DISK_WRITES
    try:
        good = np.isfinite(arr)
        lo = float(arr[good].min()) if good.any() else 0.0
        hi = float(arr[good].max()) if good.any() else 1.0
        scale = max(hi - lo, 1e-30) / 65000.0
        # Whole-array arithmetic, the gaps patched after: gathering and
        # scattering the good cells cost more than the sums on a 25-million-cell
        # MRMS field.
        q = np.rint((np.where(good, arr, lo) - lo) / scale - 32500.0).astype(np.int16)
        q[~good] = -32768
        _VAR_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        # The .npz np.savez_compressed writes, at zlib's fastest level: 0.12 s
        # instead of 0.28 for an MRMS field, 1.6 MB instead of 1.4, and quicker
        # to read back. Every frame of a loop is written once.
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
            for name, value in (("q", q), ("lo", np.float64(lo)), ("scale", np.float64(scale))):
                with zf.open(name + ".npy", "w", force_zip64=True) as fh:
                    np.lib.format.write_array(fh, np.asanyarray(value), allow_pickle=False)
        os.replace(tmp, path)
    except OSError:
        return
    _DISK_WRITES += 1
    if _DISK_WRITES % 25 == 0:
        _disk_trim()


def _disk_trim() -> None:
    try:
        files = sorted(_VAR_DIR.glob("*.npz"), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    total = 0
    for f in files:
        try:
            total += f.stat().st_size
            if total > _VAR_DISK_BUDGET:
                f.unlink()
        except OSError:
            pass


def _disk_read(path: Path) -> Optional[np.ndarray]:
    try:
        with np.load(path) as z:
            q, lo, scale = z["q"], float(z["lo"]), float(z["scale"])
    except (OSError, ValueError, KeyError):
        return None
    out = (q.astype(np.float32) + 32500.0) * np.float32(scale) + np.float32(lo)
    out[q == -32768] = np.nan
    try:
        os.utime(path)  # recently used: the trim keeps it
    except OSError:
        pass
    return out


def _load_raw(source: str, name: str, key: str) -> None:
    """Fetch one raw variable -- or a u/v pair -- onto the drawing grid, cached."""
    s = SOURCES[source]
    first = name if name not in PAIRS.values() else next(u for u, v in PAIRS.items() if v == name)
    names = (first, PAIRS[first]) if first in PAIRS else (first,)
    ck = (source, names[0], key)
    if all(_vars_get((source, n, key)) is not None for n in names):
        return
    with _LOCK:
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        if all(_vars_get((source, n, key)) is not None for n in names):
            return
        if _saved_mapping(source, key):
            from_disk = [_disk_read(_var_path(source, n, key)) for n in names]
            # A cached variable is only usable while the drawing grid it was
            # regridded onto is still the one in use: change a source's step or
            # extent in a release and every warm cache would otherwise serve
            # arrays of the wrong shape.
            want = _grid_of(source, key)
            shape = (len(want[0]), len(want[1]))
            if any(a is not None and a.shape != shape for a in from_disk):
                from_disk = [None] * len(names)
            if all(a is not None for a in from_disk):
                for n, arr in zip(names, from_disk):
                    _vars_put((source, n, key), arr)
                with _LOCK:
                    _GATES.pop(ck, None)
                return
        matches = [s["raw"][n] for n in names]
        if _run_fh(key)[1] == 0 and all(_windowed(m) for m in matches):
            # A run's first hour has no record of what fell or peaked since it
            # began -- nothing has yet. Zeros, on the drawing grid, which the
            # first plain variable is fetched to learn if it is not known.
            if not _saved_mapping(source, key):
                plain = next(n for n, m in s["raw"].items() if "|" not in m and n not in PAIRS
                             and n not in PAIRS.values())
                _load_raw(source, plain, key)
            lats, lons = _grid_of(source, key)
            for n in names:
                _vars_put((source, n, key), np.zeros((len(lats), len(lons)), dtype=np.float32))
            with _LOCK:
                _GATES.pop(ck, None)
            return
        if len(matches) == 1:
            parts = [_values(source, key, matches[0])]
        else:
            with ThreadPoolExecutor(max_workers=2) as pool:
                parts = list(pool.map(lambda m: _values(source, key, m), matches))

        shape = parts[0][0].shape
        m = _mapping(source, shape, parts[0][1], matches[0], key)
        drawn = []
        nearest = any(n in _NEAREST for n in names)
        for values, _url_used in parts:
            d = _onto_grid(values, m, nearest)
            d[~m["inside"]] = np.nan
            drawn.append(d.reshape(len(m["lats"]), len(m["lons"])))

        if len(drawn) == 2 and "lov" in s:
            # Grid-relative to north-relative. Verified against RTMA's own wind
            # direction field: 0.03 degrees median difference. A plain lat/lon
            # grid has no central meridian and needs none of this.
            angle = math.sin(math.radians(s["latin"])) * np.radians(((m["lons"] - s["lov"] + 180.0) % 360.0) - 180.0)
            cos_a, sin_a = np.cos(angle)[None, :].astype(np.float32), np.sin(angle)[None, :].astype(np.float32)
            ug, vg = drawn
            drawn = [cos_a * ug + sin_a * vg, -sin_a * ug + cos_a * vg]

        for n, arr in zip(names, drawn):
            _vars_put((source, n, key), arr)
            _DISKER.submit(_disk_write, _var_path(source, n, key), arr)
        with _LOCK:
            _GATES.pop(ck, None)


def _grid_of(source: str, key: Optional[str] = None) -> tuple[np.ndarray, np.ndarray]:
    with _LOCK:
        m = _MAPS.get(_grid_id(source, key))
    if m is None:
        raise RuntimeError("the grid is not known yet")
    return m["lats"], m["lons"]


class _Getter:
    """Hands a derived variable its ingredients, working out derived ones in turn."""

    def __init__(self, source: str, key: str):
        self.source, self.key = source, key
        self.memo: dict[str, np.ndarray] = {}

    @property
    def grid(self) -> tuple[np.ndarray, np.ndarray, float]:
        lats, lons = _grid_of(self.source, self.key)
        return lats, lons, SOURCES[self.source]["step"]

    @property
    def fh(self) -> Optional[int]:
        """The forecast hour, or None for an analysis."""
        return _run_fh(self.key)[1]

    def at(self, fh: int) -> "_Getter":
        """The same run at another forecast hour: for what a product adds up,
        or keeps the most of, across the run."""
        return _Getter(self.source, _with_fh(self.key, fh, _subh(self.source)))

    def previous(self) -> Optional["_Getter"]:
        """The run's forecast hour before this one, or None at its first."""
        fh = self.fh
        if not fh:
            return None
        earlier = [h for h in SOURCES[self.source]["forecast"]["hours"] if h < fh]
        return self.at(earlier[-1]) if earlier else None

    def kept(self, name: str) -> Optional[np.ndarray]:
        """A running total or maximum already worked out for this hour, if still held."""
        return _vars_get((self.source, name, self.key))

    def keep(self, name: str, arr: np.ndarray) -> None:
        _vars_put((self.source, name, self.key), arr)

    def warm(self, name: str, fhs: list[int]) -> None:
        """Fetch a variable's raw ingredients for many hours of the run side by
        side, before a running total or maximum walks back through them one at
        a time: forty-eight hours in sequence is forty-eight round trips."""
        raw = needs(self.source, name) or set()
        keys = [_with_fh(self.key, h, _subh(self.source)) for h in fhs]
        todo = [(n, k) for k in keys for n in raw
                if _vars_get((self.source, n, k)) is None]
        if not todo:
            return
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda nk: _load_raw(self.source, nk[0], nk[1]), todo))

    def __call__(self, name: str) -> np.ndarray:
        if name in self.memo:
            return self.memo[name]
        if name in KEEP:
            # A running total or maximum: the next hour's is built from this
            # one, so it is kept rather than worked out again from the start.
            got = _vars_get((self.source, name, self.key))
            if got is not None:
                self.memo[name] = got
                return got
        how = recipe(self.source, name)
        if how is None:
            raise RuntimeError(f"{SOURCES[self.source]['label']} cannot supply {name}")
        if how[0] == "raw":
            got = _vars_get((self.source, name, self.key))
            if got is None:
                _load_raw(self.source, name, self.key)
                got = _vars_get((self.source, name, self.key))
            if got is None:
                raise RuntimeError(f"{name} was evicted before it could be used")
        else:
            with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
                got = np.asarray(how[1](self), dtype=np.float32)
            if name in KEEP:
                _vars_put((self.source, name, self.key), got)
        self.memo[name] = got
        return got


def _prefetch(source: str, key: str, names: set[str]) -> None:
    """Every raw ingredient of a product at once, rather than one after another."""
    units: dict[str, str] = {}
    for n in names:
        first = next((u for u, v in PAIRS.items() if v == n), n)
        units[first] = first
    todo = [u for u in units if _vars_get((source, u, key)) is None
            or (u in PAIRS and _vars_get((source, PAIRS[u], key)) is None)]
    if not todo:
        return
    # The grid mapping is built by the first variable; the rest wait for it
    # rather than all building it at once on a cold start.
    if not _saved_mapping(source, key):
        _load_raw(source, todo[0], key)
        todo = todo[1:]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(todo))) as pool:
        list(pool.map(lambda u: _load_raw(source, u, key), todo))


def _once(cache: "OrderedDict", limit: int, ck: tuple, make: Callable[[], Any]) -> Any:
    """The cached value for `ck`, made at most once however many ask at a time.

    Playing a loop asks for the same hour three ways at once -- the loop's
    prefetch, the picture, and its lines -- and each made it from scratch,
    fighting over the GIL. The first asker makes it; the rest wait and read it.
    If the maker fails, the next waiter tries in its place.
    """
    # Keyed by the cache as well as the entry: the lines and the shading are
    # both held under (source, product, hour), so sharing one in-flight map let
    # a call that owned the lines wait on itself for the shading beneath them.
    ik = (id(cache), ck)
    while True:
        with _LOCK:
            hit = cache.get(ck)
            if hit is not None:
                cache.move_to_end(ck)
                return hit
            ev = _INFLIGHT.get(ik)
            owner = ev is None
            if owner:
                ev = _INFLIGHT[ik] = threading.Event()
        if not owner:
            ev.wait(180)
            continue
        try:
            out = make()
            with _LOCK:
                cache[ck] = out
                while len(cache) > limit:
                    cache.popitem(last=False)
            return out
        finally:
            with _LOCK:
                _INFLIGHT.pop(ik, None)
            ev.set()


def _convert(values: np.ndarray, how: Optional[str]) -> np.ndarray:
    return CONVERT[how](values) if how else values


def _smooth(grid: np.ndarray, sigma_cells: float) -> np.ndarray:
    good = np.isfinite(grid)
    if not good.any():
        return grid
    filled = np.where(good, grid, np.nanmean(grid[good]))
    return np.where(good, gaussian_filter(filled, sigma=sigma_cells, mode="nearest"), np.nan).astype(np.float32)


def _shade(source: str, pid: str, key: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, _Getter]:
    """(lats north->south, lons west->east, the product in display units, getter)."""
    spec = PRODUCTS[pid]
    sk = (source, pid, key)
    get = _Getter(source, key)
    with _LOCK:
        hit = _SHADES.get(sk)
        mapped = _grid_id(source, key) in _MAPS
    if hit is not None and mapped:
        # Lines and barbs still read their variables through `get`, which
        # fetches any that were let go since.
        lats, lons = _grid_of(source, key)
        return lats, lons, hit, get

    def make() -> np.ndarray:
        _prefetch(source, key, _product_needs(source, pid) or set())
        grid = _convert(get(spec["shade"]), spec["convert"]).astype(np.float32)
        if spec["smooth_km"]:
            grid = _smooth(grid, spec["smooth_km"] / (111.0 * SOURCES[source]["step"]))
        return grid

    if hit is not None:
        # Cached, but its grid mapping was let go since: make it again, which
        # rebuilds the mapping on the way.
        with _LOCK:
            _SHADES.pop(sk, None)
    grid = _once(_SHADES, _SHADES_MAX, sk, make)
    lats, lons = _grid_of(source, key)
    return lats, lons, grid, get


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def _merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    lat = np.clip(np.asarray(lat, dtype=np.float64), -85.05, 85.05)
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def _mercator_row_axis(north: float, south: float, nj: int, out_h: int) -> np.ndarray:
    """Source row per output row, fractional, so rows are interpolated between.

    MapLibre stretches an image linearly between the four corners it is given,
    and latitude is not linear in Mercator: resampling onto an even Mercator
    axis here is what makes the corner placement exact.
    """
    src_y = _merc_y(np.linspace(north, south, nj))
    out_y = np.linspace(_merc_y(north), _merc_y(south), out_h)
    return np.interp(out_y, src_y[::-1], np.arange(nj - 1, -1, -1, dtype=np.float64))


def _lerp_rows(a: np.ndarray, rows: np.ndarray) -> np.ndarray:
    j0 = np.clip(np.floor(rows), 0, a.shape[0] - 1).astype(np.int32)
    j1 = np.clip(j0 + 1, 0, a.shape[0] - 1)
    w = (rows - j0).astype(np.float32)[:, None]
    return a[j0] * (1.0 - w) + a[j1] * w


def _lerp_cols(a: np.ndarray, cols: np.ndarray) -> np.ndarray:
    i0 = np.clip(np.floor(cols), 0, a.shape[1] - 1).astype(np.int32)
    i1 = np.clip(i0 + 1, 0, a.shape[1] - 1)
    w = (cols - i0).astype(np.float32)[None, :]
    return a[:, i0] * (1.0 - w) + a[:, i1] * w


def _cubic_taps(pos: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """The four cells around each fractional position and their Catmull-Rom
    weights. The curve passes through every cell's value, like the straight
    line, but meets the next piece with the same slope: no creases at the
    cells, which is what made a zoomed-in global model look faceted."""
    i1 = np.floor(pos).astype(np.int64)
    t = (pos - i1).astype(np.float32)
    t2 = t * t
    t3 = t2 * t
    w = np.stack([
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ])
    idx = np.clip(np.stack([i1 - 1, i1, i1 + 1, i1 + 2]), 0, n - 1)
    return idx, w


def _cubic_rows(a: np.ndarray, rows: np.ndarray) -> np.ndarray:
    idx, w = _cubic_taps(rows, a.shape[0])
    out = a[idx[0]] * w[0][:, None]
    for k in range(1, 4):
        out += a[idx[k]] * w[k][:, None]
    return out


def _cubic_cols(a: np.ndarray, cols: np.ndarray) -> np.ndarray:
    idx, w = _cubic_taps(cols, a.shape[1])
    out = a[:, idx[0]] * w[0][None, :]
    for k in range(1, 4):
        out += a[:, idx[k]] * w[k][None, :]
    return out


def _blur_of(source: str) -> float:
    """How much to soften a source's drawing grid before it is resampled. A
    projected grid is drawn unblurred, every cell sharp (see
    _INTERPOLATE_PROJECTED); the others keep a light blur over the plateaus
    their nearest-cell mapping repeats."""
    return 0.0 if _curvilinear(source) or SOURCES[source].get("sharp") else 0.6


def _resample(vals: np.ndarray, rows: np.ndarray, cols: np.ndarray, spec: dict, blur: float = 0.6) -> np.ndarray:
    """Values at fractional grid positions, interpolating the FIELD itself.

    Blending dBZ and colouring after is not the same as blending colours: a
    45 dBZ core has to fade through the palette's own 44, 43, 42, not through
    whatever lies between two squares. Categorical products take the nearest
    value instead -- halfway between rain and snow is not a third kind of
    weather.

    Both pictures sample a row axis that depends only on latitude and a column
    axis that depends only on longitude, so this goes along one axis and then
    the other. The general two-dimensional lookup cost about four times as much
    for the same answer, which a whole loop of frames feels. Each axis is a
    cubic through four cells rather than a line between two, so gradients stay
    smooth when a coarse model is looked at close up; the result is held to
    the range of the values it came from, as a cubic can overshoot a step.
    """
    # Past the grid's last row or column there is no data. The taps are held to
    # the grid, so without this a picture reaching beyond it repeated the edge
    # row or column outward: a band of the HRRR's northern edge standing over
    # Manitoba, its eastern edge drawn as a line out past Newfoundland.
    beyond = ~(((rows >= -0.5) & (rows <= vals.shape[0] - 0.5))[:, None]
               & ((cols >= -0.5) & (cols <= vals.shape[1] - 0.5))[None, :])
    if spec.get("fmt") in _CATEGORICAL_FMTS:
        # Picture coarser than the grid: the nearest cell, as each pixel spans
        # several and no square can show.
        step = min(abs(float(rows[1] - rows[0])) if rows.size > 1 else 1.0,
                   abs(float(cols[1] - cols[0])) if cols.size > 1 else 1.0)
        if step >= 0.9:
            j = np.clip(np.round(rows), 0, vals.shape[0] - 1).astype(np.int32)
            i = np.clip(np.round(cols), 0, vals.shape[1] - 1).astype(np.int32)
            out = vals[np.ix_(j, i)].astype(np.float32)
            out[beyond] = np.nan
            return out
        return _resample_kinds(vals, rows, cols, spec, blur, beyond)
    # A light blur first: the drawing grid was filled by nearest neighbour, and
    # interpolating those repeated cells straight left rectangular plateaus.
    # Blurred as value-times-mask over mask, so the edge of the data does not
    # bleed towards zero.
    good = np.isfinite(vals)
    mask = good.astype(np.float32)
    filled = np.where(good, vals, 0.0).astype(np.float32)
    mask_s = gaussian_filter(mask, blur, mode="constant") if blur > 0 else mask
    filled_s = gaussian_filter(filled, blur, mode="constant") if blur > 0 else filled
    weight = _cubic_cols(_cubic_rows(mask_s, rows), cols)
    summed = _cubic_cols(_cubic_rows(filled_s, rows), cols)
    inside = _lerp_cols(_lerp_rows(mask, rows), cols)
    if not good.any():
        return np.full((rows.size, cols.size), np.nan, dtype=np.float32)
    lo, hi = float(vals[good].min()), float(vals[good].max())
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.clip(summed / weight, lo, hi)
        return np.where((inside > 0.5) & (weight > 0.05) & ~beyond, out, np.nan)


# Formats whose value carries a kind and an amount: 100 per kind, the amount
# (the reflectivity of precipitation type) in the rest.
_KIND_AND_AMOUNT = ("ptype", "rms")


def _resample_kinds(vals: np.ndarray, rows: np.ndarray, cols: np.ndarray, spec: dict, blur: float,
                    beyond: np.ndarray) -> np.ndarray:
    """A categorical field zoomed in past its grid, drawn smoothly.

    Taking the nearest cell kept the kinds apart but drew every cell as a
    square: a 3 km model's precipitation type at county zoom was a wall of
    blocks. Here the edge of what is falling is the interpolated edge of the
    data, each pixel takes the kind with the largest share of its neighbourhood
    -- each kind's share interpolated like any field -- so the line between rain
    and snow runs smoothly through the cells instead of along their sides, and
    the amount carried with the kind is interpolated on its own."""
    good = np.isfinite(vals)
    if not good.any():
        return np.full((rows.size, cols.size), np.nan, dtype=np.float32)
    paired = spec.get("fmt") in _KIND_AND_AMOUNT
    kind = np.where(good, np.floor(np.where(good, vals, 0.0) / (100.0 if paired else 1.0)), -1).astype(np.int16)
    soft = max(blur, 0.8)

    def share(mask: np.ndarray) -> np.ndarray:
        m = gaussian_filter(mask.astype(np.float32), soft, mode="constant")
        return np.clip(_cubic_cols(_cubic_rows(m, rows), cols), 0.0, 1.0)

    inside = share(good) > 0.5
    best = np.full((rows.size, cols.size), -1, dtype=np.int16)
    most = np.zeros((rows.size, cols.size), dtype=np.float32)
    rep: dict[int, float] = {}
    for k in (int(v) for v in np.unique(kind) if v >= 0):
        here = kind == k
        rep[k] = float(vals[here].flat[0])
        w = share(here)
        take = w > most
        best[take] = k
        most[take] = w[take]
    out = np.full((rows.size, cols.size), np.nan, dtype=np.float32)
    if paired:
        amount = np.where(good, vals - kind * 100.0, np.nan).astype(np.float32)
        amt = _resample(amount, rows, cols, {}, blur)
        ok = inside & (best >= 0) & np.isfinite(amt) & ~beyond
        out[ok] = best[ok] * 100.0 + np.clip(amt[ok], 0.0, 99.9)
    else:
        for k, v in rep.items():
            out[inside & (best == k) & ~beyond] = v
    return out


def _valid(key: str) -> tuple[datetime, str]:
    when = _when(key)
    _run, fh = _run_fh(key)
    text = when.strftime("%a %Y-%m-%d %H:%MZ")
    return when, (f"{_fh_label(fh)} · {text}" if fh is not None else text)


def render(source: str = DEFAULT_SOURCE, field: str = DEFAULT_FIELD, key: str = "",
           width: int = DEFAULT_WIDTH, warm: bool = True) -> dict[str, Any]:
    """One hour of one product as a Mercator PNG, with the corners to place it at."""
    _check(source, field)
    key = key or _newest_key(source)
    width = max(400, min(int(width), 2400))

    if warm:
        _focus(source, field)
    out = _once(_RENDER, _RENDER_MAX, (source, field, key, width),
                lambda: _make_render(source, field, key, width))
    if warm:
        # Keep the warm-up a step ahead of the scrub.
        _warm_neighbours(source, field, key, width)
    return out


def _peaks(values: np.ndarray, cells_per_pixel: float) -> np.ndarray:
    """Each cell as the largest around it, over as many cells as a pixel spans.

    A hail swath, a rotation track or a lightning flash is a cell or two of the
    radar mosaic's 1 km grid. A picture coarser than the grid samples it, and
    most of those cells fall between the samples: a swath broke into dots, and
    the lightning over a whole country came down to a few specks. Products
    marked `peaks` keep their strongest value instead."""
    k = int(round(cells_per_pixel))
    if k < 2:
        return values
    filled = np.where(np.isfinite(values), values, -np.inf).astype(np.float32)
    out = maximum_filter(filled, size=k, mode="nearest")
    return np.where(np.isfinite(out), out, np.nan).astype(np.float32)


def _make_render(source: str, field: str, key: str, width: int) -> dict[str, Any]:
    lats, lons, values, _get = _shade(source, field, key)
    north, south = float(lats[0]), float(lats[-1])
    west, east = float(lons[0]), float(lons[-1])
    if PRODUCTS[field].get("peaks"):
        values = _peaks(values, values.shape[1] / width)

    span_x = east - west
    span_y = float(_merc_y(north) - _merc_y(south)) * 180.0 / np.pi
    height = int(max(200, min(2400, round(width * span_y / max(span_x, 1e-6)))))
    rows = _mercator_row_axis(north, south, values.shape[0], height)
    cols = np.linspace(0, values.shape[1] - 1, width)
    warped = _resample(values, rows, cols, PRODUCTS[field], _blur_of(source))

    table, lo, hi = _lut_for(field)
    good = np.isfinite(warped)
    scaled = np.where(good, (warped - lo) / max(hi - lo, 1e-6), 0.0)
    idx = np.clip((scaled * (table.shape[0] - 1)).astype(np.int32), 0, table.shape[0] - 1)
    rgba = table[idx]
    rgba[~good] = 0  # outside the domain is nothing, not a colour

    buf = io.BytesIO()
    # Level 1: a third larger than level 6 and four times quicker to make, and
    # the picture only ever crosses the local machine.
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=False, compress_level=1)

    when, valid = _valid(key)
    out = {
        "png": buf.getvalue(),
        "source": source,
        "sourceLabel": SOURCES[source]["label"],
        "field": field,
        "fieldLabel": PRODUCTS[field]["label"],
        "unit": PRODUCTS[field]["unit"],
        "key": key,
        "unix": int(when.timestamp()),
        "valid": valid,
        "bounds": {"west": west, "east": east, "north": north, "south": south},
        "width": width,
        "height": height,
        "bar": colour_bar(field),
    }
    return out


# Views are kept by size, not count: a loop made for the view on screen keeps
# every frame's view here, and a day of HRRR simulated IR is ~220 MB of them.
_VIEWS: "OrderedDict[tuple, bytes]" = OrderedDict()
_VIEWS_BYTES = 384 * 1024 * 1024
_VIEWS_SIZE = {"n": 0}
# A view being made, so a second ask for it (the loop making it while the map
# asks) waits for that one rather than loading the field again.
_VIEW_JOBS: dict[tuple, threading.Event] = {}
# Lossless WebP: a third the size of the PNG for a detailed field (simulated IR
# 2.9 -> 0.9 MB), a seventh for radar, the same pixels -- what makes a loop of
# sharp views fit in memory and down the wire.
_VIEW_WEBP = features.check("webp")
VIEW_MEDIA = "image/webp" if _VIEW_WEBP else "image/png"


def render_view(source: str, field: str, key: str, west: float, south: float, east: float, north: float,
                width: int, height: int) -> bytes:
    """The part of one hour inside a box, as a PNG exactly `width` x `height`.

    The whole-domain picture is about 6 km a pixel: fine for a country, blocks
    once you zoom to a county. This one spends the pixels on what is on screen
    and interpolates the FIELD before colouring it -- blending dBZ, not already
    coloured pixels, so a 45 dBZ core fades through the palette's own 44, 43, 42
    instead of through whatever colours lie between two squares. It cannot add
    detail the drawing grid does not hold; it removes the squares.

    Categorical products (precipitation type) are not blended: halfway between
    rain and snow is not a third kind of weather. Each pixel takes the kind with
    the largest share of its neighbourhood (_resample_kinds).
    """
    _check(source, field)
    key = key or _newest_key(source)
    width = max(64, min(int(width), 3072))
    height = max(64, min(int(height), 3072))
    north, south = min(north, 85.0), max(south, -85.0)
    if not (east > west and north > south):
        raise ValueError("empty box")
    ck = (source, field, key, round(west, 3), round(south, 3), round(east, 3), round(north, 3), width, height)
    with _LOCK:
        hit = _VIEWS.get(ck)
        other = _VIEW_JOBS.get(ck) if hit is None else None
        if hit is not None:
            _VIEWS.move_to_end(ck)
        elif other is None:
            mine = _VIEW_JOBS[ck] = threading.Event()
    if hit is not None:
        return hit
    if other is not None:
        other.wait(90)
        with _LOCK:
            hit = _VIEWS.get(ck)
        if hit is not None:
            return hit
        return _make_view(source, field, key, west, south, east, north, width, height, ck)
    try:
        return _make_view(source, field, key, west, south, east, north, width, height, ck)
    finally:
        with _LOCK:
            _VIEW_JOBS.pop(ck, None)
        mine.set()


def _make_view(source: str, field: str, key: str, west: float, south: float, east: float, north: float,
               width: int, height: int, ck: tuple) -> bytes:
    lats, lons, values, _get = _shade(source, field, key)
    step = SOURCES[source]["step"]
    spec = PRODUCTS[field]

    xs = np.linspace(west, east, width, endpoint=False) + (east - west) / (2 * width)
    ys = np.linspace(_merc_y(north), _merc_y(south), height, endpoint=False)
    ys = ys + (_merc_y(south) - _merc_y(north)) / (2 * height)
    row_lats = np.degrees(2.0 * np.arctan(np.exp(ys)) - np.pi / 2.0)
    jj = (lats[0] - row_lats) / step
    ii = (xs - lons[0]) / step

    # Only the rows and columns under the box (and a margin for the blur) are
    # worked on: a county view is a few hundred cells, not the whole country.
    pad = 4
    j0 = int(max(0, np.floor(jj.min()) - pad))
    j1 = int(min(values.shape[0], np.ceil(jj.max()) + pad + 1))
    i0 = int(max(0, np.floor(ii.min()) - pad))
    i1 = int(min(values.shape[1], np.ceil(ii.max()) + pad + 1))
    if j1 <= j0 or i1 <= i0:
        crop = np.full((1, 1), np.nan, dtype=np.float32)
        j0 = i0 = 0
    else:
        crop = values[j0:j1, i0:i1]
    jj, ii = jj - j0, ii - i0
    if spec.get("peaks"):
        crop = _peaks(crop, (i1 - i0) / width)

    out = _resample(crop, jj, ii, spec, _blur_of(source))

    table, lo, hi = _lut_for(field)
    ok = np.isfinite(out)
    scaled = np.where(ok, (out - lo) / max(hi - lo, 1e-6), 0.0)
    idx = np.clip((scaled * (table.shape[0] - 1)).astype(np.int32), 0, table.shape[0] - 1)
    rgba = table[idx]
    rgba[~ok] = 0
    buf = io.BytesIO()
    image = Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA")
    if _VIEW_WEBP:
        # method 1: a tenth of the default's encode time for ~2% more bytes.
        image.save(buf, format="WEBP", lossless=True, method=1, quality=20)
    else:
        image.save(buf, format="PNG", optimize=False, compress_level=1)
    data = buf.getvalue()
    with _LOCK:
        if ck not in _VIEWS:
            _VIEWS[ck] = data
            _VIEWS_SIZE["n"] += len(data)
        while _VIEWS_SIZE["n"] > _VIEWS_BYTES and len(_VIEWS) > 1:
            _, old = _VIEWS.popitem(last=False)
            _VIEWS_SIZE["n"] -= len(old)
    return data


# Loops: a day of frames made ahead of the timeline playing it.
# Twelve at once: a download from the AWS copy is held back per connection more
# than by the line, so a cold 49-hour HRRR run took 39 s six at a time and 24 s
# twelve at a time.
_LOOP_POOL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="obs-loop")
_LOOP_GEN = {"n": 0}
# Frames of a loop that could not be made, so the timeline stops waiting on them.
_LOOP_FAILED: set[tuple] = set()


# The most frames one loop makes: a whole GFS run is 209, a week of hourly
# analyses 168. The picture and line caches above hold a loop this long.
_LOOP_MOST = 300


def _view_box(view: Any) -> Optional[dict[str, Any]]:
    """The map's view box from a loop request, or None when there is none."""
    if not isinstance(view, dict):
        return None
    try:
        box = {k: float(view[k]) for k in ("west", "south", "east", "north")}
        box["width"] = max(64, min(int(round(float(view["width"]))), 3072))
        box["height"] = max(64, min(int(round(float(view["height"]))), 3072))
    except (KeyError, TypeError, ValueError):
        return None
    if not (box["east"] > box["west"] and box["north"] > box["south"]):
        return None
    return box


def prefetch(source: str, field: str, keys: list[str], view: Any = None) -> dict[str, Any]:
    """Make every frame of a loop -- picture and lines -- twelve at a time, in
    the order given. A new loop outdates the one before: its frames still
    waiting are skipped. Downloads are the limit, so a product already on disk
    plays at once and a cold HRRR day takes as long as its fields take to arrive.

    With `view` (the map's box and pixel size), each frame's sharp picture of
    that box is made too, while its field is in memory: the timeline plays those
    pictures, and made on their own later each meant loading its field again --
    two seconds a frame for the MRMS mosaic."""
    _check(source, field)
    _LOOP_GEN["n"] += 1
    generation = _LOOP_GEN["n"]
    keys = [k for k in keys if isinstance(k, str)][:_LOOP_MOST]
    box = _view_box(view)
    with _LOCK:
        _LOOP_FAILED.difference_update((source, field, k) for k in keys)
    for key in keys:
        _LOOP_POOL.submit(_loop_one, source, field, key, generation, box)
    return {"queued": len(keys), "generation": generation}


def shutdown() -> None:
    """Drop the loop and warm-up queues on the way out: a queued day of frames
    kept the process alive long after the server had stopped."""
    _LOOP_GEN["n"] += 1
    _LOOP_POOL.shutdown(wait=False, cancel_futures=True)
    _WARMER.shutdown(wait=False, cancel_futures=True)
    _STRIP_WARMER.shutdown(wait=False, cancel_futures=True)
    _PROBE_POOL.shutdown(wait=False, cancel_futures=True)


def cancel_loop() -> dict[str, Any]:
    """Skip every frame of the loop still waiting to be made: someone closed it."""
    _LOOP_GEN["n"] += 1
    return {"generation": _LOOP_GEN["n"]}


def loop_status(source: str, field: str, keys: list[str]) -> dict[str, list[str]]:
    """Which frames of a loop are made -- picture and lines both -- and which
    failed. The map pulls a frame only once it is ready: asking early held one
    of the browser's six connections to this machine open for as long as the
    download took, and the rest of the app queued behind them."""
    _check(source, field)
    ready: list[str] = []
    failed: list[str] = []
    with _LOCK:
        for k in keys[:_LOOP_MOST]:
            if (source, field, k) in _VECTORS and (source, field, k, DEFAULT_WIDTH) in _RENDER:
                ready.append(k)
            elif (source, field, k) in _LOOP_FAILED:
                failed.append(k)
    return {"ready": ready, "failed": failed}


def _loop_one(source: str, field: str, key: str, generation: int, box: Optional[dict[str, Any]] = None) -> None:
    if generation != _LOOP_GEN["n"]:
        return
    _TLS.loop = True
    try:
        render(source, field, key, DEFAULT_WIDTH, warm=False)
        # Before the lines: a frame counts as made once both are, so the map
        # asks for its view only after it is here.
        if box is not None:
            with contextlib.suppress(Exception):
                render_view(source, field, key, **box)
        vectors(source, field, key)
    except Exception:  # noqa: BLE001 - the timeline asks for it again when it gets there
        with _LOCK:
            _LOOP_FAILED.add((source, field, key))
    finally:
        _TLS.loop = False


def warm_newest(source: str, field: str, width: int = DEFAULT_WIDTH) -> None:
    if _tracks(source):
        return  # tracks come whole with the frame
    """Start making the newest hour as soon as someone opens the panel.

    Opening it and switching the layer on are a second or two apart, and that
    second is most of the wait for a heavy product -- spent before the click,
    the picture is ready when it comes.
    """
    if source not in SOURCES or field not in _OFFERS.get(source, ()):
        return
    _focus(source, field)
    with _LOCK:
        have = _FRAMES.get(source)
    if not have or not have[1]:
        return
    job = (source, field, _newest_key(source), width)
    with _LOCK:
        if job in _RENDER or job in _WARMING:
            return
        _WARMING.add(job)
    # Not the single warm-up worker: that one may be busy with older hours, and
    # this is the frame about to be asked for. Foreground, so it may use NOMADS.
    threading.Thread(target=_warm_one, args=(job, False), daemon=True, name="obs-newest").start()


def _warm_neighbours(source: str, field: str, key: str, width: int) -> None:
    """Queue the hours just before this one, and the one after: scrubbing a
    timeline goes back through the day far more often than forward."""
    with _LOCK:
        have = _FRAMES.get(source)
    if not have:
        return
    keys = [f["key"] for f in have[1]]
    if key not in keys:
        return
    i = keys.index(key)
    for k in keys[max(0, i - _WARM_AHEAD):i][::-1] + keys[i + 1:i + 2]:
        job = (source, field, k, width)
        with _LOCK:
            if job in _RENDER or job in _WARMING:
                continue
            _WARMING.add(job)
        _WARMER.submit(_warm_one, job, True)


def _focus(source: str, field: str) -> None:
    """Say what the panel is showing, so stale warm-up work can be dropped."""
    with _LOCK:
        _WANT["source"], _WANT["field"] = source, field


def _wanted(source: str, field: str) -> bool:
    with _LOCK:
        want = (_WANT["source"], _WANT["field"])
    return want == ("", "") or want == (source, field)


def _warm_one(job: tuple, background: bool = True) -> None:
    source, field, key, width = job
    if not _wanted(source, field):
        # Queued for a product the panel has since left.
        with _LOCK:
            _WARMING.discard(job)
        return
    _TLS.background = background
    try:
        # warm=False: warming one hour must not queue its own neighbours, or a
        # single look at the map would walk the whole archive.
        render(source, field, key, width, warm=False)
        vectors(source, field, key)
    except Exception:  # noqa: BLE001 - a frame that fails to warm is fetched when asked for
        pass
    finally:
        _TLS.background = False
        with _LOCK:
            _WARMING.discard(job)


# ---------------------------------------------------------------------------
# Reading the numbers: a point under the pointer, lines over the colours, wind
# barbs, and the edge of what was analysed at all.
# ---------------------------------------------------------------------------
def _fmt(v: float, decimals: int) -> str:
    return f"{v:.{decimals}f}" if decimals else f"{round(v):d}"


_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _names_ready(source: str, key: str, names: set[str]) -> bool:
    """Whether every raw variable is in memory or on disk -- readable without a download."""
    for n in names:
        if _vars_get((source, n, key)) is None and not _var_path(source, n, key).exists():
            return False
    return True


def _ready(source: str, pid: str, key: str, names: Optional[list[str]] = None) -> bool:
    if names is None:
        with _LOCK:
            if (source, pid, key) in _SHADES:
                return True
        need = _product_needs(source, pid) or set()
    else:
        need = set()
        for n in names:
            need |= needs(source, n) or set()
    return _names_ready(source, key, need)


def value_at(source: str, field: str, key: str, lat: float, lon: float) -> dict[str, Any]:
    """The analysed value at one point, for the readout that follows the cursor.

    Never downloads. Every pointer move is a request, and one that waited on a
    cold hour's download held a server thread for as long as the download took:
    moving the mouse while a frame loaded queued dozens of them, which starved
    the requests drawing that very frame. Until the product is readable locally
    the answer is "pending", and the readout simply waits for the map.
    """
    _check(source, field)
    key = key or _newest_key(source)
    spec = PRODUCTS[field]
    if not _ready(source, field, key):
        return {"source": source, "field": field, "key": key, "unit": spec["unit"], "label": spec["label"],
                "value": None, "text": None, "extra": None, "pending": True, "lat": lat, "lon": lon}

    lats, lons, values, get = _shade(source, field, key)
    j = int(np.argmin(np.abs(lats - lat)))
    i = int(np.argmin(np.abs(lons - lon)))
    inside = abs(float(lats[j]) - lat) < 0.2 and abs(float(lons[i]) - lon) < 0.2
    v = float(values[j, i]) if inside else float("nan")
    ok = np.isfinite(v)

    extra: list[str] = []
    if ok and spec["barbs"] and _ready(source, field, key, list(spec["barbs"])):
        u = float(get(spec["barbs"][0])[j, i])
        w = float(get(spec["barbs"][1])[j, i])
        if np.isfinite(u) and np.isfinite(w):
            kt = math.hypot(u, w) * 1.943844
            deg = (math.degrees(math.atan2(-u, -w)) + 360.0) % 360.0
            point = _COMPASS[int((deg + 11.25) // 22.5) % 16]
            # Where the shading already is the wind speed, the direction is the news.
            if spec["shade"].startswith(("wspd", "shr", "stm")):
                extra.append("Calm" if kt < 2.5 else f"from {point}")
            else:
                extra.append("Calm" if kt < 2.5 else f"{point} {round(kt)} kt")
    lines = spec["lines"]
    if ok and lines and lines.get("var") and _ready(source, field, key, [lines["var"]]):
        lv = float(_convert(get(lines["var"])[j, i], lines.get("convert")))
        if np.isfinite(lv):
            extra.append(f"{round(lv)} {lines['unit']}")

    unit = spec["unit"]
    text = None
    if ok and spec.get("fmt"):
        text = FORMATS[spec["fmt"]](v)
    elif ok:
        text = _fmt(v, spec["decimals"]) + ("" if not unit else ("%" if unit == "%" else f" {unit}"))
    return {
        "source": source,
        "field": field,
        "key": key,
        "unit": unit,
        "label": spec["label"],
        "value": round(v, 2) if ok else None,
        "text": text,
        "extra": " · ".join(extra) or None,
        "lat": round(float(lats[j]), 4) if inside else lat,
        "lon": round(float(lons[i]), 4) if inside else lon,
    }


def _compact(spec: dict, v: float) -> str:
    """A value short enough to sit under a town's name: 91°, 63%, 2500, Snow.
    The unit is in the legend; only the ones that cost a character stay."""
    if spec.get("fmt") == "ptype":
        return FORMATS["ptype"](v).split(" · ")[0]
    text = _fmt(v, spec["decimals"])
    if spec["unit"] in ("°F", "°C"):
        return f"{text}°"
    if spec["unit"] == "%":
        return f"{text}%"
    return text


def _clear(colour: str) -> bool:
    return len(colour) == 9 and colour.endswith("00")


_QUIET: dict[str, list[tuple[float, float]]] = {}


def _quiet(pid: str) -> list[tuple[float, float]]:
    """The ranges a product's palette leaves transparent: no echo, no rotation,
    no rain, clear sky. A place there gets its name without a number -- a map
    of "-20" at every town says nothing the empty colour does not."""
    if pid in _QUIET:
        return _QUIET[pid]
    stops = PRODUCTS[pid]["palette"]
    out: list[tuple[float, float]] = []
    if stops and _clear(stops[0][1]):
        out.append((-math.inf, float(stops[0][0])))
    for (v1, c1), (v2, c2) in zip(stops, stops[1:]):
        if _clear(c1) and _clear(c2):
            out.append((float(v1), float(v2)))
    if stops and _clear(stops[-1][1]):
        out.append((float(stops[-1][0]), math.inf))
    _QUIET[pid] = out
    return out


def points_at(source: str, field: str, key: str, points: list[list[float]]) -> dict[str, Any]:
    """The analysed value at many points at once, for the place labels.

    Like value_at, it never downloads: until the product is readable locally it
    answers "pending" and the labels show names alone. Nearest cell, as the
    readout does; a point outside the analysis gets null.
    """
    _check(source, field)
    key = key or _newest_key(source)
    spec = PRODUCTS[field]
    points = points[:2000]
    if not _ready(source, field, key):
        return {"key": key, "field": field, "pending": True, "values": [None] * len(points)}
    lats, lons, values, _get = _shade(source, field, key)
    if not points:
        return {"key": key, "field": field, "pending": False, "values": []}
    step = SOURCES[source]["step"]
    arr = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    j = np.rint((lats[0] - arr[:, 0]) / step).astype(np.int64)
    i = np.rint((arr[:, 1] - lons[0]) / step).astype(np.int64)
    inside = (j >= 0) & (j < len(lats)) & (i >= 0) & (i < len(lons))
    quiet = _quiet(field)
    out: list[Optional[str]] = []
    for k in range(len(arr)):
        if not inside[k]:
            out.append(None)
            continue
        v = float(values[j[k], i[k]])
        if not np.isfinite(v) or any(lo <= v <= hi for lo, hi in quiet):
            out.append(None)
            continue
        out.append(_compact(spec, v))
    return {"key": key, "field": field, "pending": False, "values": out}


def _chaikin(poly: np.ndarray, rounds: int = 2) -> np.ndarray:
    """Round a traced line's corners (Chaikin's corner cutting).

    Contours come off a regular grid, so every line is made of steps one cell
    long; zoomed in they read as a staircase. Each round replaces a corner with
    two points a quarter of the way along its segments. A closed ring stays
    closed; an open line keeps its two ends where they were.
    """
    pts = np.asarray(poly, dtype=np.float64)
    if len(pts) < 3:
        return pts
    closed = bool(np.abs(pts[0] - pts[-1]).max() < 1e-9)
    for _ in range(rounds):
        if closed:
            ring = pts[:-1]
            nxt = np.roll(ring, -1, axis=0)
            q = 0.75 * ring + 0.25 * nxt
            r = 0.25 * ring + 0.75 * nxt
            body = np.empty((len(ring) * 2, 2))
            body[0::2], body[1::2] = q, r
            pts = np.vstack([body, body[:1]])
        else:
            a, b = pts[:-1], pts[1:]
            q = 0.75 * a + 0.25 * b
            r = 0.25 * a + 0.75 * b
            body = np.empty((len(a) * 2, 2))
            body[0::2], body[1::2] = q, r
            pts = np.vstack([pts[:1], body, pts[-1:]])
    return pts


def _thin(pts: np.ndarray, spacing: float) -> np.ndarray:
    """One point per `spacing` degrees travelled along the line, plus both ends.
    Rounding corners quadruples the points; most of them are not needed to stay
    round, and a day's loop carries every hour's lines. Done on whole arrays: a
    Python loop over the points was most of the time a frame's lines took."""
    if len(pts) < 3:
        return pts
    run = np.concatenate(([0.0], np.cumsum(np.abs(np.diff(pts, axis=0)).sum(axis=1))))
    bucket = np.floor(run / spacing)
    first = np.flatnonzero(np.diff(bucket, prepend=-1.0) > 0)
    if first[-1] != len(pts) - 1:
        first = np.append(first, len(pts) - 1)
    return pts[first]


def _lines(lons: np.ndarray, lats: np.ndarray, grid: np.ndarray, levels: list[float]) -> list[dict]:
    """Contour `grid` at `levels`, as GeoJSON lines carrying their value."""
    if len(levels) == 0:
        return []
    # contourpy directly, with matplotlib's own algorithm: the same lines
    # without building a figure and an axes for every frame.
    gen = contour_generator(lons, lats, np.ma.masked_invalid(grid), name="mpl2014",
                            corner_mask=True, line_type=LineType.SeparateCode)
    out: list[dict] = []
    for level in levels:
        for poly in gen.lines(level)[0]:  # one array per line; its codes are not needed
            # Speckle: a ten-point ring around one warm parking lot is noise.
            if len(poly) < 10:
                continue
            line = np.round(_thin(_chaikin(poly), 0.05), 2).tolist()
            out.append({
                "type": "Feature",
                "properties": {"value": round(float(level), 1), "label": f"{float(level):g}"},
                "geometry": {"type": "LineString", "coordinates": line},
            })
    return out


def _barbs(source: str, lats: np.ndarray, lons: np.ndarray, u: np.ndarray, v: np.ndarray) -> dict[str, list]:
    """Wind barbs on a half-degree lattice, each with the coarsest spacing it
    belongs to -- 4, 2, 1 or 0.5 degrees -- so the map can thin them by zoom
    into an even pattern instead of letting label collision pick at random."""
    step = SOURCES[source]["step"]
    fine = max(1, int(round(0.5 / step)))
    # Half a degree suits a country; over the whole world it is a quarter of a
    # million barbs, nearly all of them thinned away by the map before anyone
    # sees them. Double the lattice until there are about as many as a regional
    # field carries -- doubling, so the 4/2/1 ranks below stay aligned.
    while (len(lats) // fine) * (len(lons) // fine) > 20000:
        fine *= 2
    # Anchored to whole multiples of the lattice, so a barb stays put from hour to hour.
    r0 = int(round((lats[0] % (fine * step)) / step)) % fine
    c0 = (fine - int(round((lons[0] % (fine * step)) / step))) % fine
    rows = np.arange(r0, len(lats), fine)
    cols = np.arange(c0, len(lons), fine)
    su = u[np.ix_(rows, cols)]
    sv = v[np.ix_(rows, cols)]
    ok = np.isfinite(su) & np.isfinite(sv)

    ri = np.round(lats[rows] / (fine * step)).astype(np.int64)[:, None]
    ci = np.round(lons[cols] / (fine * step)).astype(np.int64)[None, :]
    rank = np.full(su.shape, 3, dtype=np.int8)
    rank[(ri % 2 == 0) & (ci % 2 == 0)] = 2
    rank[(ri % 4 == 0) & (ci % 4 == 0)] = 1
    rank[(ri % 8 == 0) & (ci % 8 == 0)] = 0

    kt = np.hypot(su, sv) * 1.943844
    deg = (np.degrees(np.arctan2(-su, -sv)) + 360.0) % 360.0
    glat = np.broadcast_to(lats[rows][:, None], su.shape)
    glon = np.broadcast_to(lons[cols][None, :], su.shape)
    return {
        "lon": np.round(glon[ok], 2).tolist(),
        "lat": np.round(glat[ok], 2).tolist(),
        "s": (np.round(kt[ok] / 5.0) * 5).astype(int).tolist(),
        "d": np.round(deg[ok]).astype(int).tolist(),
        "r": rank[ok].astype(int).tolist(),
    }


def vectors(source: str = DEFAULT_SOURCE, field: str = DEFAULT_FIELD, key: str = "") -> bytes:
    """Wind barbs and the outline of the analysed area.

    The outline is traced on a coarsened copy and comes from the data mask
    itself, so it follows the real edge of the domain instead of the box
    around it.
    """
    _check(source, field)
    key = key or _newest_key(source)

    return _once(_VECTORS, _VECTORS_MAX, (source, field, key), lambda: _make_vectors(source, field, key))


def _make_vectors(source: str, field: str, key: str) -> bytes:
    """vectors(), as the JSON the map reads: serialised once here rather than
    walked by the web framework on every request -- a busy analysis is tens of
    thousands of points.

    Labelled contours used to be drawn over the colours as well. They were
    taken out: the shading already says the value, and the lines crossed the
    readings people actually look at."""
    spec = PRODUCTS[field]
    lats, lons, values, get = _shade(source, field, key)
    stride = max(1, int(round(0.1 / max(SOURCES[source]["step"], 1e-6))))
    # About a tenth of a degree is the right spacing for a regional field, but a
    # global one is some fifteen times the area: traced at that spacing it ran
    # to megabytes of JSON and seconds of work for lines nobody can tell apart
    # at world zoom. Cap the cells traced, so the cost follows the picture
    # rather than the size of the domain.
    while max(values.shape[0] // stride, values.shape[1] // stride) > 800:
        stride += 1
    sub_lat, sub_lon = lats[::stride], lons[::stride]
    good = np.isfinite(values[::stride, ::stride])

    # The pressure map, on the products that carry sea-level pressure: isobars
    # every few hectopascals with the highs and lows a surface chart is
    # actually read by. It used to be a category of its own; it belongs on the
    # products that have the field.
    isobars: list[dict] = []
    centres: list[dict] = []
    line_var = (lines.get("var") or spec["shade"]) if (lines := spec["lines"]) else None
    if lines and line_var == "mslp":
        src = _convert(get(lines["var"]), lines.get("convert")) if lines.get("var") else values
        smooth = _smooth(np.asarray(src[::stride, ::stride], dtype=np.float32), 1.2)
        step = float(lines["step"])
        finite = smooth[np.isfinite(smooth)]
        if finite.size:
            lo = float(np.floor(finite.min() / step) * step)
            hi = float(np.ceil(finite.max() / step) * step)
            isobars = _lines(sub_lon, sub_lat, smooth,
                             [float(v) for v in np.arange(lo, hi + step / 2, step)])
            # A surface chart is read by the 1013 divider: lows one colour,
            # highs the other, so the pattern shows without reading a number.
            for f in isobars:
                f["properties"]["band"] = "low" if f["properties"]["value"] < 1013 else "high"
            filled = np.where(np.isfinite(smooth), smooth, float(np.nanmean(finite)))
            # A grid that goes all the way round wraps its window across the
            # antimeridian and merges markers within 6 degrees rather than 2;
            # treated as regional, the global GFS posted over a hundred H and L.
            world = float(sub_lon[-1] - sub_lon[0]) >= 359.0
            # Sea-level pressure over high ground is extrapolation, not
            # observation: unmasked, the Andes, Tibet and Antarctica posted a
            # third of the global field's H and L.
            orog = (np.asarray(get("hgt_sfc")[::stride, ::stride], dtype=np.float32)
                    if "hgt_sfc" in SOURCES[source]["raw"] else None)
            centres = model_fields._centres(
                sub_lon, sub_lat, filled, SOURCES[source]["step"] * stride, orog,
                world=world, valid=np.isfinite(smooth))

    # The radar mosaic has no edge worth drawing: with every "no echo" cell
    # blank, the line only ringed each storm.
    edge = _lines(sub_lon, sub_lat, good.astype(np.float32), [0.5]) if SOURCES[source].get("edge", True) else []
    for f in edge:
        f["properties"] = {"kind": "edge"}

    # Where another variable crosses a level, traced at full resolution: a
    # supercell's helicity swath is a few cells wide and would vanish at the
    # tenth-of-a-degree spacing the rest is traced at.
    outline: list[dict] = []
    if spec.get("outline"):
        o = spec["outline"]
        over = np.asarray(get(o["var"]), dtype=np.float32)
        fine = max(1, stride // 3)
        outline = _lines(lons[::fine], lats[::fine], np.nan_to_num(over[::fine, ::fine], nan=0.0), [float(o["level"])])
        for f in outline:
            f["properties"] = {"kind": "outline"}

    barbs = None
    if spec["barbs"]:
        barbs = _barbs(source, lats, lons, get(spec["barbs"][0]), get(spec["barbs"][1]))

    _when, valid = _valid(key)
    out = {
        "source": source,
        "field": field,
        "key": key,
        "unit": spec["unit"],
        "valid": valid,
        "isobars": {"type": "FeatureCollection", "features": isobars},
        "centres": {"type": "FeatureCollection", "features": centres},
        "edge": {"type": "FeatureCollection", "features": edge},
        "outline": {"type": "FeatureCollection", "features": outline},
        "barbs": barbs,
    }
    return json.dumps(out, separators=(",", ":"), allow_nan=False).encode("utf-8")
