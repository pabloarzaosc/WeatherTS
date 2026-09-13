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
field of two million points is an image -- the same reasoning as mrms_core,
whose row warp this borrows so the four corners MapLibre places it by are exact.
"""
from __future__ import annotations

import io
import json
import math
import os
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

import numpy as np
from matplotlib.figure import Figure
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.spatial import cKDTree

import model_fields
import model_sources as ms

from obs_products import CONVERT, FORMATS, NOMADS, PAIRS, PRODUCTS, SOURCES, needs, recipe

NOMADS_HOST = urlsplit(NOMADS).netloc

DEFAULT_SOURCE = "hrrr-anl"
DEFAULT_FIELD = "t2m"
DEFAULT_WIDTH = 1200

# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------
_LOCK = threading.Lock()
_FRAMES: dict[str, tuple[float, list[dict]]] = {}
_FRAMES_TTL = 300.0
_RENDER: "OrderedDict[tuple, dict]" = OrderedDict()
_RENDER_MAX = 16
_VECTORS: "OrderedDict[tuple, dict]" = OrderedDict()
_VECTORS_MAX = 8
# The product in display units on the drawing grid, for the hover readout.
_SHADES: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_SHADES_MAX = 6
# Variables on the drawing grid, by bytes rather than by count: a RAP field is a
# megabyte and an RTMA one four and a half.
_VARS: "OrderedDict[tuple, np.ndarray]" = OrderedDict()
_VARS_BYTES = 0
_VARS_BUDGET = 96 * 1024 * 1024
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
_TLS = threading.local()

# Variables already on the drawing grid, kept on disk as well: an analysis hour
# never changes once published, and reading one back is a few hundredths of a
# second where downloading it again is one to three seconds.
_VAR_DIR = _MAP_DIR / "vars"
_VAR_DISK_BUDGET = 900 * 1024 * 1024
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
    sid: [pid for pid in PRODUCTS if _product_needs(sid, pid) is not None] for sid in SOURCES
}


def catalog() -> dict[str, Any]:
    """Every source, every product, and which sources can draw which."""
    return {
        "sources": [
            {"id": sid, "label": s["label"], "org": s["org"], "coverage": s["coverage"], "note": s["note"],
             "products": _OFFERS[sid]}
            for sid, s in SOURCES.items()
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
    have = frames(source)
    if not have:
        raise RuntimeError(f"No {SOURCES[source]['label']} hours are on the server right now")
    return have[-1]["key"]


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


def _when(key: str) -> datetime:
    return datetime.strptime(key, "%Y%m%d%H%M" if len(key) == 12 else "%Y%m%d%H").replace(tzinfo=timezone.utc)


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
    if hit and time.time() - hit[0] < _FRAMES_TTL:
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


def _frames_path(source: str) -> Path:
    return _MAP_DIR / f"{source}-frames-v2.json"


def _read_saved_frames(source: str) -> Optional[list[dict]]:
    try:
        data = json.loads(_frames_path(source).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if time.time() - float(data.get("saved", 0)) > 3600:
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
    s = SOURCES[source]
    cadence = _cadence(source)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % cadence)
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
    with _LOCK:
        _FRAMES[source] = (time.time(), out)
    try:
        _MAP_DIR.mkdir(parents=True, exist_ok=True)
        _frames_path(source).write_text(json.dumps({"saved": time.time(), "frames": out}), encoding="utf-8")
    except OSError:
        pass
    return out


# ---------------------------------------------------------------------------
# Colour
# ---------------------------------------------------------------------------
def _lut(stops: list[tuple[float, str]], stepped: bool = False, steps: int = 256) -> tuple[np.ndarray, float, float]:
    """A stop list -> an RGBA table, plus the range it spans."""
    lo, hi = stops[0][0], stops[-1][0]
    xs = np.array([v for v, _ in stops], dtype=np.float64)
    cols = []
    for _, hexcol in stops:
        h = hexcol.lstrip("#")
        cols.append([int(h[i:i + 2], 16) for i in (0, 2, 4)] + ([int(h[6:8], 16)] if len(h) == 8 else [255]))
    cols_arr = np.array(cols, dtype=np.float64)
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


def _mapping(source: str, shape: tuple[int, int], url: str, match: str) -> dict:
    """Where every cell of the drawing grid takes its value from.

    The analyses are on Lambert grids, so a regular lat/lon picture needs, for
    each output cell, the nearest source cell. That lookup is the expensive part
    and it never changes -- the grid is the same every hour -- so it is done
    once, kept as a plain index array, and saved to disk so a restart does not
    repeat it. Every variable after is one gather.
    """
    step = SOURCES[source]["step"]
    grid = _grid_id(source)
    with _LOCK:
        hit = _MAPS.get(grid)
    if hit and hit["shape"] == shape:
        return hit

    path = _MAP_DIR / f"{grid}-{shape[0]}x{shape[1]}-{step:g}.npz"
    if path.exists():
        try:
            with np.load(path) as z:
                entry = {"shape": shape, "lats": z["lats"], "lons": z["lons"], "nn": z["nn"], "inside": z["inside"]}
            with _LOCK:
                _MAPS[grid] = entry
            return entry
        except Exception:  # noqa: BLE001 - a damaged cache is rebuilt, not trusted
            pass

    field = ms.fetch_at(url, match)
    if field is None or field.lats.ndim != 2:
        raise RuntimeError(f"{SOURCES[source]['label']}: could not read the grid's coordinates")
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

    entry = {"shape": shape, "lats": lats, "lons": lons, "nn": nn, "inside": inside}
    try:
        _MAP_DIR.mkdir(parents=True, exist_ok=True)
        np.savez(path, lats=lats, lons=lons, nn=nn, inside=inside)
    except OSError:
        pass
    with _LOCK:
        _MAPS[grid] = entry
    return entry


def _grid_id(source: str) -> str:
    return SOURCES[source].get("grid", source)


def _saved_mapping(source: str) -> bool:
    """Load a mapping saved by an earlier run without knowing the grid's shape
    first -- which otherwise takes a download to learn."""
    grid = _grid_id(source)
    with _LOCK:
        if grid in _MAPS:
            return True
    step = SOURCES[source]["step"]
    for path in _MAP_DIR.glob(f"{grid}-*x*-{step:g}.npz"):
        try:
            nj, ni = (int(v) for v in path.stem[len(grid) + 1:].split("-")[0].split("x"))
            with np.load(path) as z:
                entry = {"shape": (nj, ni), "lats": z["lats"], "lons": z["lons"], "nn": z["nn"], "inside": z["inside"]}
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
    if (source, key[:8]) in _NOMADS_GONE:
        return ["aws"]
    room = ms.room(NOMADS_HOST)
    background = getattr(_TLS, "background", False)
    if room >= (30 if background else 4):
        return ["nomads", "aws"]
    return ["aws", "nomads"]


def _values(source: str, key: str, match: str) -> tuple[np.ndarray, str]:
    """One raw field, as (values shaped like the file's grid, the URL it came from)."""
    when = _when(key)
    last: Optional[Exception] = None
    for host in _hosts(source, key):
        url = _url(source, host, when)
        try:
            # Never sleep on the NOMADS budget: the mirror has the same file.
            with ms.no_wait():
                got = ms.values_at(url, match)
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
        if host == "nomads" and datetime.now(timezone.utc) - when > timedelta(hours=24):
            try:
                with ms.no_wait():
                    gone = not ms.has_idx(url)
            except ms.RateLimited:
                gone = False
            if gone:
                with _LOCK:
                    _NOMADS_GONE.add((source, key[:8]))
    detail = f" ({last})" if last else ""
    raise RuntimeError(f"{SOURCES[source]['label']} {when:%d %H:%MZ}: {match} is not available{detail}")


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
    return _VAR_DIR / f"{source}-{key}-{name}.npz"


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
        q = np.full(arr.shape, -32768, dtype=np.int16)
        q[good] = np.round((arr[good] - lo) / scale - 32500.0).astype(np.int16)
        _VAR_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez_compressed(tmp, q=q, lo=np.float64(lo), scale=np.float64(scale))
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
        if _saved_mapping(source):
            from_disk = [_disk_read(_var_path(source, n, key)) for n in names]
            if all(a is not None for a in from_disk):
                for n, arr in zip(names, from_disk):
                    _vars_put((source, n, key), arr)
                with _LOCK:
                    _GATES.pop(ck, None)
                return
        matches = [s["raw"][n] for n in names]
        if len(matches) == 1:
            parts = [_values(source, key, matches[0])]
        else:
            with ThreadPoolExecutor(max_workers=2) as pool:
                parts = list(pool.map(lambda m: _values(source, key, m), matches))

        shape = parts[0][0].shape
        m = _mapping(source, shape, parts[0][1], matches[0])
        drawn = []
        for values, _url_used in parts:
            d = values.ravel()[m["nn"]].astype(np.float32)
            d[~m["inside"]] = np.nan
            drawn.append(d.reshape(len(m["lats"]), len(m["lons"])))

        if len(drawn) == 2:
            # Grid-relative to north-relative. Verified against RTMA's own wind
            # direction field: 0.03 degrees median difference.
            angle = math.sin(math.radians(s["latin"])) * np.radians(((m["lons"] - s["lov"] + 180.0) % 360.0) - 180.0)
            cos_a, sin_a = np.cos(angle)[None, :].astype(np.float32), np.sin(angle)[None, :].astype(np.float32)
            ug, vg = drawn
            drawn = [cos_a * ug + sin_a * vg, -sin_a * ug + cos_a * vg]

        for n, arr in zip(names, drawn):
            _vars_put((source, n, key), arr)
            _DISKER.submit(_disk_write, _var_path(source, n, key), arr)
        with _LOCK:
            _GATES.pop(ck, None)


def _grid_of(source: str) -> tuple[np.ndarray, np.ndarray]:
    with _LOCK:
        m = _MAPS.get(_grid_id(source))
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
        lats, lons = _grid_of(self.source)
        return lats, lons, SOURCES[self.source]["step"]

    def __call__(self, name: str) -> np.ndarray:
        if name in self.memo:
            return self.memo[name]
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
    if not _saved_mapping(source):
        _load_raw(source, todo[0], key)
        todo = todo[1:]
    if not todo:
        return
    with ThreadPoolExecutor(max_workers=min(8, len(todo))) as pool:
        list(pool.map(lambda u: _load_raw(source, u, key), todo))


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
        mapped = _grid_id(source) in _MAPS
    if hit is not None and mapped:
        # Lines and barbs still read their variables through `get`, which
        # fetches any that were let go since.
        lats, lons = _grid_of(source)
        return lats, lons, hit, get
    _prefetch(source, key, _product_needs(source, pid) or set())
    lats, lons = _grid_of(source)
    grid = _convert(get(spec["shade"]), spec["convert"]).astype(np.float32)
    if spec["smooth_km"]:
        grid = _smooth(grid, spec["smooth_km"] / (111.0 * SOURCES[source]["step"]))
    with _LOCK:
        _SHADES[sk] = grid
        while len(_SHADES) > _SHADES_MAX:
            _SHADES.popitem(last=False)
    return lats, lons, grid, get


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def _merc_y(lat: np.ndarray | float) -> np.ndarray | float:
    lat = np.clip(np.asarray(lat, dtype=np.float64), -85.05, 85.05)
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def _mercator_rows(north: float, south: float, nj: int, out_h: int) -> np.ndarray:
    """Row index per output row, so the image is right between its corners.

    MapLibre stretches an image linearly between the four corners it is given,
    and latitude is not linear in Mercator: resampling onto an even Mercator
    axis here is what makes the corner placement exact.
    """
    src_y = _merc_y(np.linspace(north, south, nj))
    out_y = np.linspace(_merc_y(north), _merc_y(south), out_h)
    idx = np.searchsorted(src_y[::-1], out_y)
    return (nj - 1 - np.clip(idx, 0, nj - 1)).astype(np.int32)


def _valid(key: str) -> tuple[datetime, str]:
    when = _when(key)
    return when, when.strftime("%a %Y-%m-%d %H:%MZ")


def render(source: str = DEFAULT_SOURCE, field: str = DEFAULT_FIELD, key: str = "",
           width: int = DEFAULT_WIDTH, warm: bool = True) -> dict[str, Any]:
    """One hour of one product as a Mercator PNG, with the corners to place it at."""
    _check(source, field)
    key = key or _newest_key(source)
    width = max(400, min(int(width), 2400))

    ck = (source, field, key, width)
    with _LOCK:
        hit = _RENDER.get(ck)
    if hit is not None:
        # A warmed frame landed on: keep the warm-up a step ahead of the scrub.
        if warm:
            _warm_neighbours(source, field, key, width)
        return hit

    lats, lons, values, _get = _shade(source, field, key)
    north, south = float(lats[0]), float(lats[-1])
    west, east = float(lons[0]), float(lons[-1])

    span_x = east - west
    span_y = float(_merc_y(north) - _merc_y(south)) * 180.0 / np.pi
    height = int(max(200, min(2400, round(width * span_y / max(span_x, 1e-6)))))
    cols = np.clip(np.linspace(0, values.shape[1] - 1, width).astype(np.int32), 0, values.shape[1] - 1)
    rows = _mercator_rows(north, south, values.shape[0], height)
    warped = values[np.ix_(rows, cols)]

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
    with _LOCK:
        _RENDER[ck] = out
        while len(_RENDER) > _RENDER_MAX:
            _RENDER.popitem(last=False)
    if warm:
        _warm_neighbours(source, field, key, width)
    return out


_VIEWS: "OrderedDict[tuple, bytes]" = OrderedDict()
_VIEWS_MAX = 24


def render_view(source: str, field: str, key: str, west: float, south: float, east: float, north: float,
                width: int, height: int) -> bytes:
    """The part of one hour inside a box, as a PNG exactly `width` x `height`.

    The whole-domain picture is about 6 km a pixel: fine for a country, blocks
    once you zoom to a county. This one spends the pixels on what is on screen
    and interpolates the FIELD before colouring it -- blending dBZ, not already
    coloured pixels, so a 45 dBZ core fades through the palette's own 44, 43, 42
    instead of through whatever colours lie between two squares. It cannot add
    detail the drawing grid does not hold; it removes the squares.

    Categorical products (precipitation type) take the nearest value instead:
    halfway between rain and snow is not a third kind of weather.
    """
    _check(source, field)
    key = key or _newest_key(source)
    width = max(64, min(int(width), 2048))
    height = max(64, min(int(height), 2048))
    north, south = min(north, 85.0), max(south, -85.0)
    if not (east > west and north > south):
        raise ValueError("empty box")
    ck = (source, field, key, round(west, 3), round(south, 3), round(east, 3), round(north, 3), width, height)
    with _LOCK:
        hit = _VIEWS.get(ck)
    if hit is not None:
        return hit

    lats, lons, values, _get = _shade(source, field, key)
    step = SOURCES[source]["step"]
    spec = PRODUCTS[field]

    xs = np.linspace(west, east, width, endpoint=False) + (east - west) / (2 * width)
    ys = np.linspace(_merc_y(north), _merc_y(south), height, endpoint=False)
    ys = ys + (_merc_y(south) - _merc_y(north)) / (2 * height)
    row_lats = np.degrees(2.0 * np.arctan(np.exp(ys)) - np.pi / 2.0)
    jj = np.broadcast_to(((lats[0] - row_lats) / step)[:, None], (height, width))
    ii = np.broadcast_to(((xs - lons[0]) / step)[None, :], (height, width))

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

    good = np.isfinite(crop)
    if spec.get("fmt") == "ptype":
        out = map_coordinates(np.where(good, crop, np.nan), [jj, ii], order=0, mode="constant", cval=np.nan)
    else:
        # A light blur first: the drawing grid was filled by nearest neighbour,
        # and interpolating those repeated cells straight left rectangular
        # plateaus. Blurred as value-times-mask over mask, so the edge of the
        # data does not bleed towards zero.
        mask = good.astype(np.float32)
        filled = np.where(good, crop, 0.0).astype(np.float32)
        mask_s = gaussian_filter(mask, 0.6, mode="constant")
        filled_s = gaussian_filter(filled, 0.6, mode="constant")
        weight = map_coordinates(mask_s, [jj, ii], order=1, mode="constant", cval=0.0)
        summed = map_coordinates(filled_s, [jj, ii], order=1, mode="constant", cval=0.0)
        inside = map_coordinates(mask, [jj, ii], order=1, mode="constant", cval=0.0)
        with np.errstate(invalid="ignore", divide="ignore"):
            out = np.where((inside > 0.5) & (weight > 1e-3), summed / weight, np.nan)

    table, lo, hi = _lut_for(field)
    ok = np.isfinite(out)
    scaled = np.where(ok, (out - lo) / max(hi - lo, 1e-6), 0.0)
    idx = np.clip((scaled * (table.shape[0] - 1)).astype(np.int32), 0, table.shape[0] - 1)
    rgba = table[idx]
    rgba[~ok] = 0
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgba), mode="RGBA").save(buf, format="PNG", optimize=False, compress_level=1)
    png = buf.getvalue()
    with _LOCK:
        _VIEWS[ck] = png
        while len(_VIEWS) > _VIEWS_MAX:
            _VIEWS.popitem(last=False)
    return png


def warm_newest(source: str, field: str, width: int = DEFAULT_WIDTH) -> None:
    """Start making the newest hour as soon as someone opens the panel.

    Opening it and switching the layer on are a second or two apart, and that
    second is most of the wait for a heavy product -- spent before the click,
    the picture is ready when it comes.
    """
    if source not in SOURCES or field not in _OFFERS.get(source, ()):
        return
    with _LOCK:
        have = _FRAMES.get(source)
    if not have or not have[1]:
        return
    job = (source, field, have[1][-1]["key"], width)
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


def _warm_one(job: tuple, background: bool = True) -> None:
    source, field, key, width = job
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


def _lines(lons: np.ndarray, lats: np.ndarray, grid: np.ndarray, levels: list[float]) -> list[dict]:
    """Contour `grid` at `levels`, as GeoJSON lines carrying their value."""
    if len(levels) == 0:
        return []
    fig = Figure()  # the OO API: no pyplot global state under the server
    ax = fig.subplots()
    cs = ax.contour(lons, lats, np.ma.masked_invalid(grid), levels=levels)
    out: list[dict] = []
    for i, path in enumerate(cs.get_paths()):
        if i >= len(cs.levels):
            break
        level = float(cs.levels[i])
        for poly in model_fields._subpaths(path):  # noqa: SLF001 - one contour splitter for the app
            # Speckle: a ten-point ring around one warm parking lot is noise.
            if len(poly) < 10:
                continue
            line = [[round(float(x), 2), round(float(y), 2)] for x, y in poly]
            out.append({
                "type": "Feature",
                "properties": {"value": round(level, 1), "label": f"{level:g}"},
                "geometry": {"type": "LineString", "coordinates": line},
            })
    return out


def _barbs(source: str, lats: np.ndarray, lons: np.ndarray, u: np.ndarray, v: np.ndarray) -> dict[str, list]:
    """Wind barbs on a half-degree lattice, each with the coarsest spacing it
    belongs to -- 4, 2, 1 or 0.5 degrees -- so the map can thin them by zoom
    into an even pattern instead of letting label collision pick at random."""
    step = SOURCES[source]["step"]
    fine = max(1, int(round(0.5 / step)))
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


def vectors(source: str = DEFAULT_SOURCE, field: str = DEFAULT_FIELD, key: str = "") -> dict[str, Any]:
    """Labelled contours, wind barbs, and the outline of the analysed area.

    The lines are traced on a coarsened, lightly blurred copy: at full
    resolution every eddy in the boundary layer becomes its own closed loop.
    The outline comes from the data mask itself, so it follows the real edge of
    the domain instead of the box around it.
    """
    _check(source, field)
    key = key or _newest_key(source)

    vk = (source, field, key)
    with _LOCK:
        cached = _VECTORS.get(vk)
    if cached is not None:
        return cached

    spec = PRODUCTS[field]
    lats, lons, values, get = _shade(source, field, key)
    stride = max(1, int(round(0.1 / max(SOURCES[source]["step"], 1e-6))))
    sub_lat, sub_lon = lats[::stride], lons[::stride]
    good = np.isfinite(values[::stride, ::stride])

    contours: list[dict] = []
    interval: Optional[float] = None
    lines_unit = spec["unit"]
    lines = spec["lines"]
    if lines:
        if lines.get("var"):
            src = _convert(get(lines["var"]), lines.get("convert"))
            lines_unit = lines["unit"]
        else:
            src = values
        smooth = _smooth(np.asarray(src[::stride, ::stride], dtype=np.float32), 1.2)
        step = float(lines["step"])
        finite = smooth[np.isfinite(smooth)]
        if finite.size:
            lo = float(np.floor(finite.min() / step) * step)
            hi = float(np.ceil(finite.max() / step) * step)
            if lines.get("lo") is not None:
                lo = max(lo, float(lines["lo"]))
            if lines.get("hi") is not None:
                hi = min(hi, float(lines["hi"]))
            levels = [float(v) for v in np.arange(lo, hi + step / 2, step)]
            contours = _lines(sub_lon, sub_lat, smooth, levels)
        interval = step

    edge = _lines(sub_lon, sub_lat, good.astype(np.float32), [0.5])
    for f in edge:
        f["properties"] = {"kind": "edge"}

    barbs = None
    if spec["barbs"]:
        barbs = _barbs(source, lats, lons, get(spec["barbs"][0]), get(spec["barbs"][1]))

    _when, valid = _valid(key)
    out = {
        "source": source,
        "field": field,
        "key": key,
        "unit": spec["unit"],
        "interval": interval,
        "linesUnit": lines_unit,
        "valid": valid,
        "contours": {"type": "FeatureCollection", "features": contours},
        "edge": {"type": "FeatureCollection", "features": edge},
        "barbs": barbs,
    }
    with _LOCK:
        _VECTORS[vk] = out
        while len(_VECTORS) > _VECTORS_MAX:
            _VECTORS.popitem(last=False)
    return out
