"""
MRMS -- NOAA's Multi-Radar Multi-Sensor mosaic -- read for the analyses.

MRMS merges every radar in the country, with the lightning network, the rain
gauges and the model's temperatures, onto one 0.01 degree grid every two
minutes: composite and 3-D reflectivity, hail size and swaths, rotation tracks,
echo tops, VIL, lightning density and probability, precipitation rate and
totals, flash-flood recurrence intervals and modelled streamflow.

This module is only the reading. observations.py draws it like any other
analysis -- the timeline, the loops, the sharp picture when zoomed, the value
under the pointer and at each town, Compare, the animation export -- through
three sources declared in obs_products (`reader: "mrms"`).

From NOAA's bucket on AWS (noaa-mrms-pds), not from mrms.ncep.noaa.gov: the same
files, no rate limit to share with NOMADS, and years of archive where the NCEP
server keeps a day.

What makes MRMS different from the model files:
  * A file per product per time, gzipped GRIB2, named for the instant it
    describes -- to the second, and not the same second from product to product
    (the reflectivity family lands at :39-:41, the hybrid-scan and rate family on
    :00, rotation at :17). So a frame is a minute, and each product's file for it
    is the nearest one in that product's own listing (`resolve`).
  * The listing IS the index. Nothing to probe: a day's folder lists every time.
  * Its GRIB uses NOAA's local tables, which eccodes does not know, so every
    field decodes as "unknown". What a file holds is known from its folder alone.
  * Missing values are numbers: -999 outside the radars' reach, -99 scanned and
    empty, -3 / -1 / -9999 / -99900 in the derived products. All of those become
    NaN here. A product that is never negative takes "~0" in its record, and
    every value below zero goes too.
  * The rotation products are on a 0.005 degree grid, twice as fine: they are
    taken back to 0.01 by the largest of each 2x2 block, so a track two cells
    wide is not halved by sampling.
"""
from __future__ import annotations

import gzip
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np
import requests
from requests.adapters import HTTPAdapter

import model_sources as ms

BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com/"
_TIMEOUT = (8, 45)
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_SESSION.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=2))

# A frame asks a product for the file nearest its minute: up to this long before
# it (two cycles, so a product whose newest file is a few seconds late still
# draws), and this long after (the reflectivity family's :39-:41).
TOL_BEFORE_S = 150
TOL_AFTER_S = 60

_NAME = re.compile(r"_(\d{8})-(\d{6})\.grib2\.gz$")
_LOCK = threading.Lock()
# (region, folder, day) -> (listed at, [(unix, key), ...] oldest first).
_LISTS: "OrderedDict[tuple[str, str, str], tuple[float, list[tuple[int, str]]]]" = OrderedDict()
_LISTS_MAX = 600
_TODAY_TTL = 45.0
_GATES: dict[tuple[str, str, str], threading.Lock] = {}


# ---------------------------------------------------------------------------
# Listings
# ---------------------------------------------------------------------------
def _list_day(region: str, folder: str, day: str) -> list[tuple[int, str]]:
    """Every file of one product on one UTC day, oldest first. A past day never
    changes and is kept; today's is asked again after _TODAY_TTL."""
    ck = (region, folder, day)
    today = day == datetime.now(timezone.utc).strftime("%Y%m%d")
    with _LOCK:
        hit = _LISTS.get(ck)
        if hit and (not today or time.time() - hit[0] < _TODAY_TTL):
            _LISTS.move_to_end(ck)
            return hit[1]
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _LOCK:
            hit = _LISTS.get(ck)
            if hit and (not today or time.time() - hit[0] < _TODAY_TTL):
                return hit[1]
        out: list[tuple[int, str]] = []
        token: Optional[str] = None
        while True:
            params = {"list-type": "2", "prefix": f"{region}/{folder}/{day}/", "max-keys": "1000"}
            if token:
                params["continuation-token"] = token
            r = _SESSION.get(BUCKET, params=params, timeout=_TIMEOUT)
            r.raise_for_status()
            text = r.text
            for key in re.findall(r"<Key>([^<]+)</Key>", text):
                m = _NAME.search(key)
                if not m:
                    continue
                when = datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
                out.append((int(when.timestamp()), key))
            nxt = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
            if "<IsTruncated>true</IsTruncated>" not in text or not nxt:
                break
            token = nxt.group(1)
        out.sort()
        with _LOCK:
            _LISTS[ck] = (time.time(), out)
            _LISTS.move_to_end(ck)
            while len(_LISTS) > _LISTS_MAX:
                _LISTS.popitem(last=False)
        return out


def _days_around(unix: int, before_s: int, after_s: int) -> list[str]:
    lo = datetime.fromtimestamp(unix - before_s, timezone.utc).date()
    hi = datetime.fromtimestamp(unix + after_s, timezone.utc).date()
    days = [lo]
    while days[-1] < hi:
        days.append(days[-1] + timedelta(days=1))
    return [d.strftime("%Y%m%d") for d in days]


def resolve(region: str, folder: str, unix: int, before_s: int = TOL_BEFORE_S,
            after_s: int = TOL_AFTER_S) -> Optional[str]:
    """The key of the product's file nearest `unix` inside [-before_s, +after_s]."""
    best: Optional[tuple[int, str]] = None
    for day in _days_around(unix, before_s, after_s):
        try:
            listed = _list_day(region, folder, day)
        except requests.RequestException:
            continue
        for t, key in listed:
            if t < unix - before_s or t > unix + after_s:
                continue
            if best is None or abs(t - unix) < abs(best[0] - unix):
                best = (t, key)
    return best[1] if best else None


def frames(region: str, probe: str, days: int, cadence_min: int) -> list[dict]:
    """The timeline: one frame per file of the probe product over the last
    `days`, oldest first, keyed by its minute ("YYYYMMDDHHMM"). A product
    published more often than the source's cadence (the FLASH ratios every two
    minutes, the source every ten) keeps one frame per cadence step."""
    now = datetime.now(timezone.utc)
    stamps: list[int] = []
    for k in range(days, -1, -1):
        day = (now - timedelta(days=k)).strftime("%Y%m%d")
        try:
            stamps += [t for t, _ in _list_day(region, probe, day)]
        except requests.RequestException:
            continue
    oldest = int((now - timedelta(days=days)).timestamp())
    out: list[dict] = []
    seen: set[str] = set()
    step = cadence_min * 60
    for t in sorted(stamps):
        if t < oldest:
            continue
        when = datetime.fromtimestamp(t, timezone.utc).replace(second=0)
        if cadence_min > 2 and (when.hour * 60 + when.minute) % cadence_min:
            continue
        key = when.strftime("%Y%m%d%H%M")
        if key in seen:
            continue
        seen.add(key)
        out.append({"key": key, "unix": int(when.timestamp()), "label": when.strftime("%d %H:%MZ")})
    if step > 120 and len(out) > 1:
        # One per cadence step even where a product came twice inside one.
        thinned = [out[0]]
        for f in out[1:]:
            if f["unix"] - thinned[-1]["unix"] >= step - 30:
                thinned.append(f)
        out = thinned
    return out


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
class _Record:
    """A raw variable's record: 'FOLDER[~floor][+before]' alternatives joined
    by ';' -- the first one that has a file for the frame is read. `~0` blanks
    values below 0, `+3900` looks up to 3900 s back for a product published
    less often than the frame (the hourly model temperatures)."""

    def __init__(self, text: str):
        self.options: list[tuple[str, Optional[float], int]] = []
        for part in text.split(";"):
            part = part.strip()
            m = re.match(r"^([^~+]+)(?:~(-?[\d.]+))?(?:\+(\d+))?$", part)
            if not m:
                raise ValueError(f"bad MRMS record {part!r}")
            self.options.append((m.group(1), float(m.group(2)) if m.group(2) else None,
                                 int(m.group(3)) if m.group(3) else TOL_BEFORE_S))


def _split(url: str) -> tuple[str, int, _Record]:
    """'mrms:CONUS|202609242346|FOLDER~0' -> region, frame unix, record."""
    body = url[len("mrms:"):] if url.startswith("mrms:") else url
    region, stamp, record = body.split("|", 2)
    when = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return region, int(when.timestamp()), _Record(record)


def _find(url: str) -> Optional[tuple[str, Optional[float]]]:
    region, unix, rec = _split(url)
    for folder, floor, before in rec.options:
        key = resolve(region, folder, unix, before_s=before)
        if key:
            return key, floor
    return None


def has(url: str) -> bool:
    return _find(url) is not None


# The files as downloaded (gzipped, 0.05-3 MB), by their key. A frame is two
# minutes and many products are not: the hourly model temperatures, the
# half-hourly swaths and the five-minute dual-pol mosaics serve many frames
# from one file, which was downloaded again for each of them.
_FILES: "OrderedDict[str, bytes]" = OrderedDict()
_FILES_BYTES = 0
_FILES_BUDGET = 256 * 1024 * 1024


def _download(key: str) -> bytes:
    global _FILES_BYTES
    with _LOCK:
        hit = _FILES.get(key)
        if hit is not None:
            _FILES.move_to_end(key)
    if hit is None:
        r = _SESSION.get(BUCKET + key, timeout=_TIMEOUT)
        r.raise_for_status()
        hit = r.content
        with _LOCK:
            if key not in _FILES:
                _FILES[key] = hit
                _FILES_BYTES += len(hit)
                while _FILES_BYTES > _FILES_BUDGET and len(_FILES) > 1:
                    _k, old = _FILES.popitem(last=False)
                    _FILES_BYTES -= len(old)
    return gzip.decompress(hit)


def _pool2(a: np.ndarray) -> np.ndarray:
    """A 0.005 degree grid back to 0.01 by the largest of each 2x2 block."""
    nj, ni = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    blocks = a[:nj, :ni].reshape(nj // 2, 2, ni // 2, 2)
    with np.errstate(invalid="ignore"), _quiet_nan():
        return np.nanmax(np.nanmax(blocks, axis=3), axis=1)


class _quiet_nan:
    """np.nanmax over an all-NaN block warns; that block is just empty here."""

    def __enter__(self):
        import warnings
        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", RuntimeWarning)

    def __exit__(self, *exc):
        self._w.__exit__(*exc)


def _clean(values: np.ndarray, floor: Optional[float]) -> np.ndarray:
    v = values.astype(np.float32, copy=True)
    v[v <= -99.0] = np.nan
    if floor is not None:
        v[v < floor] = np.nan
    return v


def field_at(url: str) -> Optional["ms.Field"]:
    """The frame's file for this record, decoded onto the 0.01 degree grid."""
    found = _find(url)
    if found is None:
        return None
    key, floor = found
    field = ms._decode(_download(key), None, False)  # noqa: SLF001 - the shared eccodes path
    if field is None:
        return None
    values = _clean(field.values, floor)
    lats, lons = np.asarray(field.lats, dtype=np.float64), np.asarray(field.lons, dtype=np.float64)
    if values.shape[0] > 5000:  # the rotation products' 0.005 degree grid
        values = _pool2(values)
        lats = lats[: lats.size // 2 * 2].reshape(-1, 2).mean(axis=1)
        lons = lons[: lons.size // 2 * 2].reshape(-1, 2).mean(axis=1)
    return ms.Field(lons, lats, values, False)


def values_at(url: str) -> Optional[np.ndarray]:
    field = field_at(url)
    return None if field is None else field.values
