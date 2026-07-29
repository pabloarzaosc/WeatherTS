"""
Model surface fields -> vectors. Today that means mean sea level pressure:
isobars plus the H/L centres a surface chart is actually read by.

Structure matters more than the one variable. Everything a model needs lives in
the MODELS table below -- which NOMADS filter script slices it, how its files
are named, how far out it runs -- so adding another is a table entry, not new
code. The frontend reads the same table through /api/model-fields/models, which
is what feeds the sidebar's model picker.

Two grid shapes are handled. Global models (GFS, GEFS) come on a regular
lat/lon grid, cheap to reconstruct with linspace and needing dateline care.
Regional models (NAM, HRRR, RAP) come on a Lambert grid, where eccodes hands
back per-point coordinates and no seam exists.
"""
from __future__ import annotations

import bz2
import json
import os
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

import eccodes as ec
import numpy as np
import requests
from matplotlib.figure import Figure
from matplotlib.path import Path as MplPath
from scipy.ndimage import gaussian_filter, maximum_filter, minimum_filter

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin"

# The MSLP variable has to be named per model, not guessed: grib-filter rejects
# the whole request with a 500 "invalid parameter" if you ask for a name the
# file does not carry, so PRMSL and MSLMA cannot simply both be requested.
MSLP_LEVEL = "&lev_mean_sea_level=on"

# id -> everything needed to locate and read one model.
#   kind        how it is fetched: "nomads" (grib-filter), "direct" (one URL per
#               field), or "ecmwf" (byte range picked out of a .index sidecar)
#   category    Global | Regional | Mesoscale | AI | Ensemble -- the picker's
#               top level, mirroring how forecasters group them
#   region      USA | European | Canadian -- the picker's second level
#   cycles      which UTC hours the model runs at
#   fine_step   hourly (or whatever) resolution out to fine_until
#   step        the coarser spacing used beyond that, up to max_hour
#   grid        "latlon" (regular) or "projected" (Lambert &c, 2-D coordinates)
#   world       whether it wraps the globe -- decides dateline handling
MODELS: dict[str, dict[str, Any]] = {
    # ---- Global -----------------------------------------------------------
    "gfs-0p25": {
        "kind": "nomads", "category": "Global", "region": "USA", "var": "PRMSL",
        "label": "GFS 0.25°", "org": "NOAA/NCEP", "coverage": "Global",
        "script": "filter_gfs_0p25.pl", "dir": "/gfs.{ymd}/{cc}/atmos",
        "file": "gfs.t{cc}z.pgrb2.0p25.f{fff}", "grid": "latlon", "world": True, "spacing": 0.25,
        "cycles": (0, 6, 12, 18), "fine_step": 1, "fine_until": 120, "step": 3, "max_hour": 384,
    },
    "gfs-0p50": {
        "kind": "nomads", "category": "Global", "region": "USA", "var": "PRMSL",
        "label": "GFS 0.5°", "org": "NOAA/NCEP", "coverage": "Global",
        "script": "filter_gfs_0p50.pl", "dir": "/gfs.{ymd}/{cc}/atmos",
        "file": "gfs.t{cc}z.pgrb2full.0p50.f{fff}", "grid": "latlon", "world": True, "spacing": 0.5,
        "cycles": (0, 6, 12, 18), "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
    },
    "gfs-1p00": {
        "kind": "nomads", "category": "Global", "region": "USA", "var": "PRMSL",
        "label": "GFS 1.0°", "org": "NOAA/NCEP", "coverage": "Global",
        "script": "filter_gfs_1p00.pl", "dir": "/gfs.{ymd}/{cc}/atmos",
        "file": "gfs.t{cc}z.pgrb2.1p00.f{fff}", "grid": "latlon", "world": True, "spacing": 1.0,
        "cycles": (0, 6, 12, 18), "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
    },
    "gdas-0p25": {
        "kind": "nomads", "category": "Global", "region": "USA", "var": "PRMSL",
        "label": "GDAS 0.25° (analysis)", "org": "NOAA/NCEP", "coverage": "Global",
        "script": "filter_gdas_0p25.pl", "dir": "/gdas.{ymd}/{cc}/atmos",
        "file": "gdas.t{cc}z.pgrb2.0p25.f{fff}", "grid": "latlon", "world": True, "spacing": 0.25,
        "cycles": (0, 6, 12, 18), "fine_step": 3, "fine_until": 9, "step": 3, "max_hour": 9,
    },
    "gdps-15km": {
        "kind": "direct", "category": "Global", "region": "Canadian", "var": "PRMSL",
        "label": "GDPS 15 km", "org": "ECCC (Canada)", "coverage": "Global",
        "url": ("https://dd.weather.gc.ca/{ymd}/WXO-DD/model_gdps/15km/{cc}/{fff}/"
                "{ymd}T{cc}Z_MSC_GDPS_Pressure_MSL_LatLon0.15_PT{fff}H.grib2"),
        "grid": "latlon", "world": True, "spacing": 0.15,
        "cycles": (0, 12), "fine_step": 3, "fine_until": 240, "step": 3, "max_hour": 240,
    },

    # ---- Regional ---------------------------------------------------------
    "nam-12km": {
        "kind": "nomads", "category": "Regional", "region": "USA", "var": "PRMSL",
        "label": "NAM 12 km", "org": "NOAA/NCEP", "coverage": "North America",
        "script": "filter_nam.pl", "dir": "/nam.{ymd}",
        "file": "nam.t{cc}z.awphys{ff}.tm00.grib2", "grid": "projected", "world": False, "spacing": 0.11,
        "cycles": (0, 6, 12, 18), "fine_step": 1, "fine_until": 36, "step": 3, "max_hour": 84,
    },
    "rap-13km": {
        "kind": "nomads", "category": "Regional", "region": "USA", "var": "MSLMA",
        "label": "RAP 13 km", "org": "NOAA/NCEP", "coverage": "North America",
        "script": "filter_rap.pl", "dir": "/rap.{ymd}",
        "file": "rap.t{cc}z.awp130pgrbf{ff}.grib2", "grid": "projected", "world": False, "spacing": 0.12,
        "cycles": tuple(range(24)), "fine_step": 1, "fine_until": 51, "step": 1, "max_hour": 51,
    },
    "icon-eu": {
        "kind": "direct", "category": "Regional", "region": "European", "var": "PMSL",
        "label": "ICON-EU 7 km", "org": "DWD (Germany)", "coverage": "Europe",
        "url": ("https://opendata.dwd.de/weather/nwp/icon-eu/grib/{cc}/pmsl/"
                "icon-eu_europe_regular-lat-lon_single-level_{ymd}{cc}_{fff}_PMSL.grib2.bz2"),
        "bz2": True, "grid": "latlon", "world": False, "spacing": 0.0625,
        "cycles": (0, 6, 12, 18), "fine_step": 1, "fine_until": 78, "step": 3, "max_hour": 120,
    },

    # ---- Mesoscale --------------------------------------------------------
    "hrrr-3km": {
        "kind": "nomads", "category": "Mesoscale", "region": "USA", "var": "MSLMA",
        "label": "HRRR 3 km", "org": "NOAA/NCEP", "coverage": "CONUS",
        "script": "filter_hrrr_2d.pl", "dir": "/hrrr.{ymd}/conus",
        "file": "hrrr.t{cc}z.wrfsfcf{ff}.grib2", "grid": "projected", "world": False, "spacing": 0.03,
        "cycles": tuple(range(24)), "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
    },
    "nam-3km": {
        "kind": "nomads", "category": "Mesoscale", "region": "USA", "var": "PRMSL",
        "label": "NAM 3 km CONUS", "org": "NOAA/NCEP", "coverage": "CONUS",
        "script": "filter_nam_conusnest.pl", "dir": "/nam.{ymd}",
        "file": "nam.t{cc}z.conusnest.hiresf{ff}.tm00.grib2",
        "grid": "projected", "world": False, "spacing": 0.03,
        "cycles": (0, 6, 12, 18), "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
    },
    "icon-d2": {
        "kind": "direct", "category": "Mesoscale", "region": "European", "var": "PMSL",
        "label": "ICON-D2 2.2 km", "org": "DWD (Germany)", "coverage": "Central Europe",
        "url": ("https://opendata.dwd.de/weather/nwp/icon-d2/grib/{cc}/pmsl/"
                "icon-d2_germany_regular-lat-lon_single-level_{ymd}{cc}_{fff}_2d_pmsl.grib2.bz2"),
        "bz2": True, "grid": "latlon", "world": False, "spacing": 0.02,
        "cycles": (0, 3, 6, 9, 12, 15, 18, 21), "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
    },

    # ---- AI ---------------------------------------------------------------
    "ecmwf-aifs": {
        "kind": "ecmwf", "category": "AI", "region": "European", "var": "msl",
        "label": "ECMWF AIFS 0.25°", "org": "ECMWF", "coverage": "Global",
        "url": ("https://data.ecmwf.int/forecasts/{ymd}/{cc}z/aifs-single/0p25/oper/"
                "{ymd}{cc}0000-{h}h-oper-fc.grib2"),
        "grid": "latlon", "world": True, "spacing": 0.25,
        "cycles": (0, 6, 12, 18), "fine_step": 6, "fine_until": 360, "step": 6, "max_hour": 360,
    },

    # ---- Ensemble ---------------------------------------------------------
    "gefs-mean": {
        "kind": "nomads", "category": "Ensemble", "region": "USA", "var": "PRMSL",
        "label": "GEFS mean 0.5°", "org": "NOAA/NCEP", "coverage": "Global",
        "script": "filter_gefs_atmos_0p50a.pl", "dir": "/gefs.{ymd}/{cc}/atmos/pgrb2ap5",
        "file": "geavg.t{cc}z.pgrb2a.0p50.f{fff}", "grid": "latlon", "world": True, "spacing": 0.5,
        "cycles": (0, 6, 12, 18), "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
    },
}

DEFAULT_MODEL = "gfs-0p25"

# Gaussian blur applied before contouring, in degrees of latitude, scaled by the
# caller's `smooth` factor. Just enough to stop the contour engine fraying on
# grid-scale noise, not enough to move a system.
SMOOTH_DEG = 0.35

LOOKBACK_RUNS = 8
# Above this, reducing surface pressure to sea level stops meaning anything --
# the Antarctic plateau reads as a 1075 hPa "high" and Tibet as a standing low.
OROG_MASK_M = 1000.0

_GRID_CACHE: dict[tuple[str, str, int], tuple[np.ndarray, np.ndarray, np.ndarray]] = {}
_RESULT_CACHE: dict[tuple[str, str, int, float, bool], dict[str, Any]] = {}
_OROG_CACHE: dict[str, np.ndarray | None] = {}
_LOCK = threading.Lock()
_CACHE_LIMIT = 24


# ---------------------------------------------------------------- registry ---
def forecast_hours(model_id: str) -> list[int]:
    m = MODELS[model_id]
    hours = list(range(0, min(m["fine_until"], m["max_hour"]) + 1, m["fine_step"]))
    hours += list(range(m["fine_until"] + m["step"], m["max_hour"] + 1, m["step"]))
    return sorted(set(h for h in hours if h <= m["max_hour"]))


def list_models() -> list[dict[str, Any]]:
    """The picker's menu: one entry per model, with what the UI needs to label it."""
    out = []
    for mid, m in MODELS.items():
        hours = forecast_hours(mid)
        out.append(
            {
                "id": mid,
                "label": m["label"],
                "org": m["org"],
                "coverage": m["coverage"],
                "maxHour": m["max_hour"],
                "cycles": list(m["cycles"]),
                "hours": hours,
                "global": bool(m["world"]),
                "category": m["category"],
                "region": m["region"],
            }
        )
    return out


# ------------------------------------------------------------------ fetch ---
def _candidate_runs(model_id: str) -> list[datetime]:
    """Plausible recent runs for this model, newest first."""
    m = MODELS[model_id]
    cycles = set(m["cycles"])
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    out: list[datetime] = []
    probe = now
    for _ in range(LOOKBACK_RUNS * 24):
        if probe.hour in cycles:
            out.append(probe)
            if len(out) >= LOOKBACK_RUNS:
                break
        probe -= timedelta(hours=1)
    return out


def _url(model_id: str, run: datetime, hour: int, extra: str) -> str:
    m = MODELS[model_id]
    ymd, cc = run.strftime("%Y%m%d"), run.strftime("%H")
    fname = m["file"].format(cc=cc, ff=f"{hour:02d}", fff=f"{hour:03d}")
    directory = m["dir"].format(ymd=ymd, cc=cc).replace("/", "%2F")
    return f"{NOMADS}/{m['script']}?dir={directory}&file={fname}{extra}"


def _read_message(content: bytes, grid: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(lons, lats, values) -- 1-D coordinate axes for latlon, 2-D for projected."""
    fd, path = tempfile.mkstemp(suffix=".grib2")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        with open(path, "rb") as f:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                raise RuntimeError("GRIB2 had no messages")
            ni, nj = ec.codes_get(gid, "Ni"), ec.codes_get(gid, "Nj")
            values = ec.codes_get_values(gid).reshape(nj, ni)
            if grid == "latlon":
                lat0 = ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
                lat1 = ec.codes_get(gid, "latitudeOfLastGridPointInDegrees")
                lon0 = ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                lon1 = ec.codes_get(gid, "longitudeOfLastGridPointInDegrees")
                lats = np.linspace(lat0, lat1, nj)
                # The last column sits one step short of 360, not on it.
                lons = np.linspace(lon0, lon1 if lon1 > lon0 else lon1 + 360.0, ni)
            else:
                # Lambert and friends: ask eccodes for the coordinates. The array
                # form matters -- the per-point generator takes ~20 s on HRRR.
                lats = ec.codes_get_array(gid, "latitudes").reshape(nj, ni)
                lons = ec.codes_get_array(gid, "longitudes").reshape(nj, ni)
                lons = ((lons + 180.0) % 360.0) - 180.0
            ec.codes_release(gid)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return lons, lats, values


def _direct_url(m: dict[str, Any], run: datetime, hour: int) -> str:
    return m["url"].format(
        ymd=run.strftime("%Y%m%d"), cc=run.strftime("%H"), fff=f"{hour:03d}", ff=f"{hour:02d}", h=hour
    )


def _get_nomads(m: dict[str, Any], model_id: str, run: datetime, hour: int) -> bytes | None:
    r = requests.get(_url(model_id, run, hour, f"&var_{m['var']}=on{MSLP_LEVEL}"), timeout=120)
    # grib-filter answers 200 with an HTML error page when the run or the hour
    # is not up yet, so the magic number is the only real check.
    return r.content if r.status_code == 200 and r.content.startswith(b"GRIB") else None


def _get_direct(m: dict[str, Any], run: datetime, hour: int) -> bytes | None:
    """One URL per field (DWD, ECCC). Some of them ship bzip2-compressed."""
    r = requests.get(_direct_url(m, run, hour), timeout=120)
    if r.status_code != 200 or len(r.content) < 512:
        return None
    data = bz2.decompress(r.content) if m.get("bz2") else r.content
    return data if data.startswith(b"GRIB") else None


def _get_ecmwf(m: dict[str, Any], run: datetime, hour: int) -> bytes | None:
    """
    ECMWF ships one ~100 MB file per step, but also a `.index` sidecar: one JSON
    line per field carrying its byte offset and length. Reading the index and
    issuing a ranged GET pulls out the single MSLP record instead of the lot.
    """
    base = _direct_url(m, run, hour)
    # The sidecar *replaces* the .grib2 suffix rather than appending to it --
    # `...-0h-oper-fc.index`, not `...-0h-oper-fc.grib2.index`.
    idx = requests.get(base.removesuffix(".grib2") + ".index", timeout=90)
    if idx.status_code != 200:
        return None
    for line in idx.text.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("param") != m["var"]:
            continue
        off, length = int(entry["_offset"]), int(entry["_length"])
        r = requests.get(
            base, headers={"Range": f"bytes={off}-{off + length - 1}"}, timeout=120
        )
        if r.content.startswith(b"GRIB"):
            return r.content
        return None
    return None


def _fetch(model_id: str, hour: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, str]:
    """(lons, lats, hPa, run_id), trying recent runs until one has the hour."""
    m = MODELS[model_id]
    grid = m["grid"]
    getter = {"nomads": lambda r, h: _get_nomads(m, model_id, r, h),
              "direct": lambda r, h: _get_direct(m, r, h),
              "ecmwf": lambda r, h: _get_ecmwf(m, r, h)}[m["kind"]]
    last: Exception | None = None
    for run in _candidate_runs(model_id):
        run_id = run.strftime("%Y%m%d%H")
        key = (model_id, run_id, hour)
        with _LOCK:
            hit = _GRID_CACHE.get(key)
        if hit is not None:
            return hit[0], hit[1], hit[2], run_id
        try:
            content = getter(run, hour)
            if content is None:
                continue
            lons, lats, values = _read_message(content, grid)
        except Exception as exc:  # noqa: BLE001 - try the next run
            last = exc
            continue
        values = values / 100.0  # Pa -> hPa
        with _LOCK:
            if len(_GRID_CACHE) >= _CACHE_LIMIT:
                _GRID_CACHE.pop(next(iter(_GRID_CACHE)))
            _GRID_CACHE[key] = (lons, lats, values)
        return lons, lats, values, run_id
    raise RuntimeError(
        f"No recent {MODELS[model_id]['label']} run carries f{hour:03d}"
        + (f" ({last})" if last else "")
    )


def _orography(model_id: str) -> np.ndarray | None:
    """Model surface height. Terrain outlives runs, so this is fetched once."""
    with _LOCK:
        if model_id in _OROG_CACHE:
            return _OROG_CACHE[model_id]
    m = MODELS[model_id]
    if m["kind"] != "nomads":
        # These sources publish one file per field, with no surface-height
        # companion to key the mask on.
        with _LOCK:
            _OROG_CACHE[model_id] = None
        return None
    grid = m["grid"]
    out: np.ndarray | None = None
    for run in _candidate_runs(model_id):
        try:
            r = requests.get(_url(model_id, run, 0, "&var_HGT=on&lev_surface=on"), timeout=120)
            if r.status_code != 200 or not r.content.startswith(b"GRIB"):
                continue
            out = _read_message(r.content, grid)[2]
            break
        except Exception:  # noqa: BLE001 - masking is a nicety, never fatal
            continue
    with _LOCK:
        _OROG_CACHE[model_id] = out
    return out


# --------------------------------------------------------------- geometry ---
def _wrap_lon(lon: float) -> float:
    return ((lon + 180.0) % 360.0) - 180.0


# Web Mercator sends the poles to infinity, and a single vertex at +/-90 does
# not merely vanish -- it poisons the whole tile index, so the client silently
# renders *nothing*. A global grid runs to the pole, so every emitted latitude
# is clamped just inside the projection's limit (85.0511...).
MERC_LIMIT = 85.0


def _clamp_lat(lat: float) -> float:
    return max(-MERC_LIMIT, min(MERC_LIMIT, lat))


def _split_at_dateline(pts: np.ndarray) -> list[list[list[float]]]:
    """
    Global contours are traced on a 0..360 grid so they stay whole across the
    prime meridian; converting back to -180..180 makes any line crossing +/-180
    jump the width of the map. Cut it there instead of drawing a streak.
    """
    out: list[list[list[float]]] = []
    run: list[list[float]] = []
    prev: float | None = None
    for lon_raw, lat in pts:
        lon = _wrap_lon(float(lon_raw))
        if prev is not None and abs(lon - prev) > 180.0:
            if len(run) >= 2:
                out.append(run)
            run = []
        run.append([round(lon, 3), round(_clamp_lat(float(lat)), 3)])
        prev = lon
    if len(run) >= 2:
        out.append(run)
    return out


def _plain(pts: np.ndarray) -> list[list[list[float]]]:
    line = [[round(float(x), 3), round(_clamp_lat(float(y)), 3)] for x, y in pts]
    return [line] if len(line) >= 2 else []


def _subpaths(path: MplPath) -> list[np.ndarray]:
    """Split a compound contour path into its individual polylines."""
    verts, codes = path.vertices, path.codes
    if codes is None:
        return [verts] if len(verts) >= 2 else []
    out: list[np.ndarray] = []
    start = 0
    for i, code in enumerate(codes):
        if code == MplPath.MOVETO and i > start:
            if i - start >= 2:
                out.append(verts[start:i])
            start = i
    if len(verts) - start >= 2:
        out.append(verts[start:])
    return out


def _isobars(lons, lats, field, interval: float, is_global: bool) -> list[dict[str, Any]]:
    lo = float(np.floor(np.nanmin(field) / interval) * interval)
    hi = float(np.ceil(np.nanmax(field) / interval) * interval)
    levels = np.arange(lo, hi + interval, interval)
    if len(levels) < 2:
        return []

    fig = Figure()  # OO API: no pyplot global state, safe under the server
    ax = fig.subplots()
    cs = ax.contour(lons, lats, field, levels=levels)
    cut = _split_at_dateline if is_global else _plain

    features: list[dict[str, Any]] = []
    for i, path in enumerate(cs.get_paths()):
        if i >= len(cs.levels):
            break
        level = float(cs.levels[i])
        for poly in _subpaths(path):
            for line in cut(poly):
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "hPa": round(level, 1),
                            "label": f"{level:g}",
                            # 1013 is the divider a forecaster reads by, and the
                            # styling hook for the heavier "standard" isobar.
                            "band": "low" if level < 1013 else "high",
                            "major": bool(round(level) % 20 == 0),
                        },
                        "geometry": {"type": "LineString", "coordinates": line},
                    }
                )
    return features


def _centres(lons, lats, field, spacing_deg: float, orog) -> list[dict[str, Any]]:
    """
    H / L markers: grid points that are the extreme of their neighbourhood.

    The window is sized in degrees, not cells, so marker density stays the same
    when the model resolution changes -- ~10 deg keeps one marker per synoptic
    feature instead of one per wiggle.
    """
    win = max(3, int(round(10.0 / max(spacing_deg, 0.01))) | 1)  # odd, >= 3
    win = min(win, 121)  # a 3 km model would otherwise ask for a 333-cell window
    is_global = lons.ndim == 1
    modes = ("nearest", "wrap") if is_global else "nearest"
    lo = minimum_filter(field, size=win, mode=modes)
    hi = maximum_filter(field, size=win, mode=modes)

    def coord(j: int, i: int) -> tuple[float, float]:
        if is_global:
            return _wrap_lon(float(lons[i])), float(lats[j])
        return float(lons[j, i]), float(lats[j, i])

    out: list[dict[str, Any]] = []
    for kind, mask in (("L", field == lo), ("H", field == hi)):
        for j, i in zip(*np.nonzero(mask)):
            lon, lat = coord(int(j), int(i))
            # Meridian convergence turns every polar grid row into a cluster of
            # "extrema" stacked on top of each other.
            if abs(lat) > 82.0:
                continue
            # Sea-level pressure under an ice cap or a plateau is extrapolation,
            # not observation: unmasked, Antarctica posts a 1075 hPa high.
            if orog is not None and orog[j, i] > OROG_MASK_M:
                continue
            value = float(field[j, i])
            out.append(
                {
                    "type": "Feature",
                    "properties": {"kind": kind, "hPa": round(value), "label": str(int(round(value)))},
                    "geometry": {"type": "Point", "coordinates": [round(lon, 3), round(lat, 3)]},
                }
            )

    # A flat extremum lights up several adjacent cells; keep one per cluster so
    # one low is one marker.
    near = 6.0 if is_global else 2.0
    kept: list[dict[str, Any]] = []
    for f in sorted(out, key=lambda f: f["properties"]["hPa"]):
        x, y = f["geometry"]["coordinates"]
        if any(
            f["properties"]["kind"] == k["properties"]["kind"]
            and abs(y - k["geometry"]["coordinates"][1]) < near
            and abs(_wrap_lon(x - k["geometry"]["coordinates"][0])) < near
            for k in kept
        ):
            continue
        kept.append(f)
    return kept


# ------------------------------------------------------------------ build ---
def build_mslp(
    model: str = DEFAULT_MODEL,
    hour: int = 0,
    interval: float = 4.0,
    centres: bool = True,
    smooth: float = 1.0,
) -> dict[str, Any]:
    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}")
    m = MODELS[model]
    if not 0 <= hour <= m["max_hour"]:
        raise ValueError(f"{m['label']} does not run to f{hour:03d} (max f{m['max_hour']:03d})")
    if not 0 < interval <= 50:
        raise ValueError(f"Isobar interval out of range: {interval}")

    lons, lats, raw, run_id = _fetch(model, hour)
    key = (model, run_id, hour, interval, centres, round(smooth, 2))
    with _LOCK:
        cached = _RESULT_CACHE.get(key)
    if cached is not None:
        return cached

    is_global = bool(m["world"])
    # Blur is specified in *degrees* and converted to cells, so the same setting
    # means the same physical smoothing on a 1 deg grid and on a 3 km one.
    # SMOOTH_DEG is small on purpose: heavier blur rounds troughs off into
    # featureless ovals, and the detail in the wave pattern is the whole point.
    if smooth > 0:
        sigma = min(max(SMOOTH_DEG * smooth / max(m["spacing"], 0.01), 0.35), 12.0)
        field = gaussian_filter(
            raw, sigma=sigma, mode=("nearest", "wrap") if is_global else "nearest"
        )
    else:
        field = raw

    if is_global:
        # Repeat the first column at 360 so lines run through the prime meridian
        # instead of stopping dead at the grid edge.
        c_lons = np.append(lons, lons[0] + 360.0)
        c_field = np.concatenate([field, field[:, :1]], axis=1)
    else:
        c_lons, c_field = lons, field

    features = _isobars(c_lons, lats, c_field, interval, is_global)
    if centres:
        features.extend(_centres(lons, lats, field, m["spacing"], _orography(model)))

    run_dt = datetime.strptime(run_id, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    valid_dt = run_dt + timedelta(hours=hour)
    result = {
        "source": f"{m['org']} {m['label']} (NOMADS)",
        "model": model,
        "modelLabel": m["label"],
        "coverage": m["coverage"],
        "variable": "MSLP",
        "units": "hPa",
        "run": run_dt.strftime("%a %Y-%m-%d %HZ"),
        "runIso": run_dt.isoformat().replace("+00:00", "Z"),
        "valid": valid_dt.strftime("%a %Y-%m-%d %H:%MZ"),
        "validIso": valid_dt.isoformat().replace("+00:00", "Z"),
        "hour": hour,
        "interval": interval,
        "geojson": {"type": "FeatureCollection", "features": features},
    }
    with _LOCK:
        if len(_RESULT_CACHE) >= _CACHE_LIMIT:
            _RESULT_CACHE.pop(next(iter(_RESULT_CACHE)))
        _RESULT_CACHE[key] = result
    return result
