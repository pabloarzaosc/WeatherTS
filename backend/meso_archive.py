"""
The mesoanalysis archive: any hour since January 2005, drawn like the live
analyses.

SPC's mesoanalysis is the RAP's hourly analysis -- the RUC's before May 2012 --
with the severe-weather parameters worked out from its profiles. NOAA keeps
those analyses, on the same 13 km grid all along:

    from 23 Feb 2021   AWS (noaa-rap-pds), with .idx sidecars
    May 2012 - 2021    NCEI, RAP ("model-rap130anl-old", "model-rap130anl")
    2005 - Apr 2012    NCEI, RUC ("model-ruc130anl")

NCEI has no .idx and answers at about 3 MB/s, so an hour is read whole (13-20
MB), kept on disk, and indexed here (grib_index). Its fields are then read out
of the local copy, through the same `find_record` every other source uses.

The severe parameters are not taken from the files: the RUC lacks most of
them, and taking them where they exist would make 2008 and 2023 mean different
things by the same name. meso_profile works them all out from each hour's
37-level profile instead. A record "derived:NAME" is one of those.

The observations module reads an hour as "archive:YYYYMMDDHH" (see
obs_products' "rap-archive" source); everything else about drawing it --
regridding, colours, contours, loops, the readout -- is the live path's.
"""
from __future__ import annotations

import os
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np
import requests

import grib_index
import meso_profile
import model_sources as ms

FIRST = datetime(2005, 1, 1, tzinfo=timezone.utc)
_AWS_FROM = datetime(2021, 2, 23, tzinfo=timezone.utc)
_RAP_FROM = datetime(2012, 5, 1, 12, tzinfo=timezone.utc)
_OLD_UNTIL = datetime(2020, 6, 1, tzinfo=timezone.utc)

_AWS = "https://noaa-rap-pds.s3.amazonaws.com/rap.{ymd}/rap.t{hh}z.awp130pgrbf00.grib2"
_NCEI = "https://www.ncei.noaa.gov/thredds/fileServer/"
_RAP_NEW = _NCEI + "model-rap130anl/{ym}/{ymd}/rap_130_{ymd}_{hh}00_000.grb2"
_RAP_OLD = _NCEI + "model-rap130anl-old/{ym}/{ymd}/rap_130_{ymd}_{hh}00_000.grb2"
_RUC = _NCEI + "model-ruc130anl/{ym}/{ymd}/ruc2anl_130_{ymd}_{hh}00_000.grb2"

_DIR = Path(tempfile.gettempdir()) / "weatherts-meso"
# Two days of hours from the RUC years, more of the RAP's.
_BUDGET = 4 * 1024 ** 3
# NCEI is slow per connection but fine with a few: the loop's hours come down
# three at a time.
_SLOTS = threading.BoundedSemaphore(3)
_DEADLINE_S = 240.0

_LOCK = threading.Lock()
_GATES: dict[str, threading.Lock] = {}
_IDX: "OrderedDict[str, list[str]]" = OrderedDict()
_DERIVED: "OrderedDict[str, dict[str, np.ndarray]]" = OrderedDict()
_MISSING: dict[str, float] = {}
_MISSING_FOR = 600.0

# The surface fields and level fields the parameters are worked out from.
_SFC = {"psfc": "PRES:surface", "hgt": "HGT:surface", "t2m": "TMP:2 m above ground",
        "td2m": "DPT:2 m above ground", "u10": "UGRD:10 m above ground", "v10": "VGRD:10 m above ground"}
_LEV = {"hgt": "HGT", "tmp": "TMP", "rh": "RH", "u": "UGRD", "v": "VGRD"}
# Columns worked at a time: the interpolations hold levels x heights x columns.
_CHUNK = 16384
_WORKERS = ThreadPoolExecutor(max_workers=4, thread_name_prefix="meso")


def latest() -> datetime:
    """The newest hour the archive offers: an hour or two behind, as AWS has it."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return now - timedelta(hours=2)


def hour_of(url: str) -> datetime:
    """'archive:2013053123' -> its hour."""
    stamp = url.rsplit(":", 1)[1]
    return datetime.strptime(stamp[:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)


def candidates(when: datetime) -> list[str]:
    """Where an hour may be, likeliest first. The collections overlap at their
    edges (NCEI kept March-May 2020 in both), so the neighbour is tried too."""
    if when >= _AWS_FROM:
        order = [_AWS, _RAP_NEW]
    elif when >= _OLD_UNTIL:
        order = [_RAP_NEW, _RAP_OLD]
    elif when >= _RAP_FROM:
        order = [_RAP_OLD, _RAP_NEW]
    elif when >= _RAP_FROM - timedelta(days=1):
        order = [_RUC, _RAP_OLD]
    else:
        order = [_RUC]
    return [t.format(ym=when.strftime("%Y%m"), ymd=when.strftime("%Y%m%d"), hh=when.strftime("%H")) for t in order]


def _path(when: datetime) -> Path:
    return _DIR / f"{when:%Y%m%d%H}.grb2"


def _gate(stamp: str) -> threading.Lock:
    with _LOCK:
        return _GATES.setdefault(stamp, threading.Lock())


def _download(url: str, dest: Path) -> bool:
    """The whole file to `dest`; False when the server does not have it."""
    part = dest.with_suffix(".part")
    with _SLOTS:
        r = ms._SESSION.get(url, timeout=(10, 60), stream=True)  # noqa: SLF001 - the app's one session
        try:
            if r.status_code != 200:
                return False
            deadline = time.monotonic() + _DEADLINE_S
            first = True
            with open(part, "wb") as fh:
                for chunk in r.iter_content(1 << 18):
                    if first:
                        if not chunk.startswith(b"GRIB"):
                            return False  # an error page served as 200
                        first = False
                    fh.write(chunk)
                    if time.monotonic() > deadline:
                        raise requests.Timeout(f"{url.split('/')[2]} took over {_DEADLINE_S:.0f} s")
        finally:
            r.close()
    os.replace(part, dest)
    return True


def local(when: datetime) -> Path:
    """The hour's file on this machine, fetched the first time it is asked for."""
    path = _path(when)
    if path.exists():
        _touch(path)
        return path
    stamp = f"{when:%Y%m%d%H}"
    with _LOCK:
        gone = _MISSING.get(stamp)
    if gone and time.time() - gone < _MISSING_FOR:
        raise RuntimeError(f"NOAA has no RAP or RUC analysis archived for {when:%d %b %Y %HZ}")
    with _gate(stamp):
        if path.exists():
            return path
        _DIR.mkdir(parents=True, exist_ok=True)
        last: Optional[Exception] = None
        for url in candidates(when):
            try:
                if _download(url, path):
                    break
            except (requests.RequestException, OSError) as exc:
                last = exc
        else:
            if last is not None:
                raise RuntimeError(f"The archive could not be reached for {when:%d %b %Y %HZ} ({last})")
            with _LOCK:
                _MISSING[stamp] = time.time()
            raise RuntimeError(f"NOAA has no RAP or RUC analysis archived for {when:%d %b %Y %HZ}")
    _trim()
    return path


def has(url: str) -> bool:
    try:
        when = hour_of(url)
    except ValueError:
        return False
    if _path(when).exists():
        return True
    for u in candidates(when):
        try:
            r = ms._SESSION.head(u, timeout=(10, 30), allow_redirects=True)  # noqa: SLF001
        except requests.RequestException:
            continue
        if r.status_code == 200:
            return True
    return False


def _touch(path: Path) -> None:
    try:
        os.utime(path)
    except OSError:
        pass


def _trim() -> None:
    try:
        files = sorted(_DIR.glob("*.grb2"), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    total = 0
    for f in files:
        try:
            total += f.stat().st_size
            if total > _BUDGET:
                f.unlink()
                f.with_suffix(".idx").unlink(missing_ok=True)
        except OSError:
            pass


def index(when: datetime) -> list[str]:
    """The hour's .idx lines: written beside the file the first time."""
    stamp = f"{when:%Y%m%d%H}"
    with _LOCK:
        hit = _IDX.get(stamp)
        if hit is not None:
            _IDX.move_to_end(stamp)
            return hit
    path = local(when)
    side = path.with_suffix(".idx")
    lines: Optional[list[str]] = None
    if side.exists():
        try:
            lines = side.read_text(encoding="ascii").splitlines()
        except OSError:
            lines = None
    if not lines:
        lines = grib_index.idx_lines(path.read_bytes())
        try:
            side.write_text("\n".join(lines) + "\n", encoding="ascii")
        except OSError:
            pass
    with _LOCK:
        _IDX[stamp] = lines
        while len(_IDX) > 96:
            _IDX.popitem(last=False)
    return lines


def _record(when: datetime, match: str) -> Optional[tuple[bytes, int]]:
    """A record's message out of the local copy, and which field of it."""
    lines = index(when)
    i = ms.find_record(lines, match)
    if i is None:
        return None
    parts = lines[i].split(":")
    nth = int(parts[0].split(".")[1]) if "." in parts[0] else 1
    start = int(parts[1])
    end = None
    for nxt in lines[i + 1:]:
        p = nxt.split(":")
        if len(p) > 1 and p[1].isdigit() and int(p[1]) > start:
            end = int(p[1])
            break
    with open(_path(when), "rb") as fh:
        fh.seek(start)
        raw = fh.read(end - start) if end is not None else fh.read()
    return (raw, nth) if raw[:4] == b"GRIB" else None


def _values(when: datetime, match: str) -> np.ndarray:
    got = _record(when, match)
    values = ms._values_of(*got) if got else None  # noqa: SLF001 - the shared decoder
    if values is None:
        raise RuntimeError(f"The {when:%d %b %Y %HZ} analysis has no {match}")
    return values


def derived(when: datetime) -> dict[str, np.ndarray]:
    """Every parameter meso_profile makes, for one hour, on the file's grid."""
    stamp = f"{when:%Y%m%d%H}"
    with _LOCK:
        hit = _DERIVED.get(stamp)
        if hit is not None:
            _DERIVED.move_to_end(stamp)
            return hit
    with _gate("derived" + stamp):
        with _LOCK:
            hit = _DERIVED.get(stamp)
        if hit is not None:
            return hit
        sfc = {k: _values(when, m) for k, m in _SFC.items()}
        shape = sfc["t2m"].shape
        lev = {k: np.stack([_values(when, f"{name}:{p} mb") for p in meso_profile.LEVELS])
               for k, name in _LEV.items()}
        flat_sfc = {k: v.reshape(-1) for k, v in sfc.items()}
        flat_lev = {k: v.reshape(v.shape[0], -1) for k, v in lev.items()}
        del sfc, lev
        n = flat_sfc["t2m"].size

        def chunk(a: int) -> tuple[int, dict[str, np.ndarray]]:
            b = min(n, a + _CHUNK)
            with np.errstate(invalid="ignore", divide="ignore", over="ignore"):
                return a, meso_profile.compute({k: v[:, a:b] for k, v in flat_lev.items()},
                                               {k: v[a:b] for k, v in flat_sfc.items()})

        out: dict[str, np.ndarray] = {}
        # numpy lets go of the GIL inside its loops: the column blocks share the cores.
        for a, part in _WORKERS.map(chunk, range(0, n, _CHUNK)):
            for k, v in part.items():
                out.setdefault(k, np.empty(n, dtype=np.float32))[a:a + v.size] = v
        result = {k: v.reshape(shape) for k, v in out.items()}
        with _LOCK:
            _DERIVED[stamp] = result
            while len(_DERIVED) > 4:
                _DERIVED.popitem(last=False)
        return result


def values_at(url: str, match: str) -> Optional[np.ndarray]:
    """A record's numbers on the file's grid, (Nj, Ni)."""
    when = hour_of(url)
    if match.startswith("derived:"):
        got = derived(when).get(match[len("derived:"):])
        return None if got is None else got.copy()
    got = _record(when, match)
    return ms._values_of(*got) if got else None  # noqa: SLF001


def fetch_at(url: str, match: str) -> Optional["ms.Field"]:
    """A record with its coordinates. A derived one is on the file's own grid,
    so the grid is read from a field the file has."""
    when = hour_of(url)
    if match.startswith("derived:"):
        match = _SFC["t2m"]
    got = _record(when, match)
    return ms._decode(got[0], None, False, nth=got[1]) if got else None  # noqa: SLF001


def window(at: Optional[int]) -> list[datetime]:
    """The hours a picked moment opens: its convective day, 12Z to 11Z (SPC's
    day), clipped to what the archive holds."""
    newest = latest()
    when = datetime.fromtimestamp(at, tz=timezone.utc) if at else newest - timedelta(days=1)
    when = min(max(when.replace(minute=0, second=0, microsecond=0), FIRST), newest)
    start = when.replace(hour=12)
    if when.hour < 12:
        start -= timedelta(days=1)
    hours = [start + timedelta(hours=h) for h in range(24)]
    return [h for h in hours if FIRST <= h <= newest]
