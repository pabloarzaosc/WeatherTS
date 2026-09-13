"""
Model surface fields -> vectors. Today that means mean sea level pressure:
isobars plus the H/L centres a surface chart is actually read by.

Where each model's pressure comes from lives in model_sources, which knows how
every centre publishes its fields and returns them decoded. This module only
turns a field into lines: smoothing, contouring, dateline care, and the centres.
The frontend reads the model table through /api/model-fields/models, which is
what feeds the sidebar's model picker.
"""
from __future__ import annotations

import threading
from datetime import timedelta
from typing import Any

import numpy as np
from matplotlib.figure import Figure
from matplotlib.path import Path as MplPath
from scipy.ndimage import gaussian_filter, maximum_filter, minimum_filter

from model_footprints import FOOTPRINTS

import model_sources as ms

MODELS = ms.MODELS
DEFAULT_MODEL = ms.DEFAULT_MODEL
forecast_hours = ms.forecast_hours

# Gaussian blur applied before contouring, in degrees of latitude, scaled by the
# caller's `smooth` factor. Just enough to stop the contour engine fraying on
# grid-scale noise, not enough to move a system.
SMOOTH_DEG = 0.35

# Above this, reducing surface pressure to sea level stops meaning anything --
# the Antarctic plateau reads as a 1075 hPa "high" and Tibet as a standing low.
OROG_MASK_M = 1000.0

# Icosahedral meshes (ICON) are contoured on a regular grid of this spacing.
MESH_STEP = 0.25

_RESULT_CACHE: dict[tuple, dict[str, Any]] = {}
_LOCK = threading.Lock()
_CACHE_LIMIT = 24


# ---------------------------------------------------------------- registry ---
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
                # What this model can drive: isobars need sea level pressure,
                # fronts need 850 hPa temperature, humidity and wind.
                "mslp": ms.has_mslp(mid),
                "fronts": ms.has_fronts(mid),
                "thickness": ms.has_thickness(mid),
                # Where a regional model has data, so a picker can offer it
                # only for the places it covers.
                "footprint": None if m["world"] else [list(t) for t in FOOTPRINTS[mid]],
            }
        )
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


def _isobars(lons, lats, field, interval: float, is_global: bool, *, unit: str = "hPa",
             divider: float = 1013.0, major_every: float = 20.0) -> list[dict[str, Any]]:
    """Contours of one field. `divider` splits the two families a forecaster
    reads by -- 1013 hPa for pressure, 540 dam for thickness -- and `major`
    marks the heavier lines."""
    lo = float(np.floor(np.nanmin(field) / interval) * interval)
    hi = float(np.ceil(np.nanmax(field) / interval) * interval)
    levels = np.arange(lo, hi + interval, interval)
    if len(levels) < 2:
        return []

    fig = Figure()  # OO API: no pyplot global state, safe under the server
    ax = fig.subplots()
    cs = ax.contour(lons, lats, np.ma.masked_invalid(field), levels=levels)
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
                            unit: round(level, 1),
                            "value": round(level, 1),
                            "label": f"{level:g}",
                            # The divider is the styling hook for the two
                            # families of line, and for the heavier one on it.
                            "band": "low" if level < divider else "high",
                            "major": bool(round(level) % major_every == 0),
                            "key": bool(abs(level - divider) < 1e-6),
                        },
                        "geometry": {"type": "LineString", "coordinates": line},
                    }
                )
    return features


def _centres(lons, lats, field, spacing_deg: float, orog, world: bool | None = None,
             valid: np.ndarray | None = None) -> list[dict[str, Any]]:
    """
    H / L markers: grid points that are the extreme of their neighbourhood.

    The window is sized in degrees, not cells, so marker density stays the same
    when the model resolution changes -- ~10 deg keeps one marker per synoptic
    feature instead of one per wiggle. `world` wraps the window round the globe;
    it used to be inferred from 1-D coordinates, which also wrapped regional
    lat/lon grids like ICON-EU from one edge of Europe to the other.

    `valid` marks real data. HREF and the HiResW nests pad half their grid with
    missing values; filled in, that padding is one vast flat "extremum" that
    posted 863 markers and took a minute and a half to thin out.
    """
    win = max(3, int(round(10.0 / max(spacing_deg, 0.01))) | 1)  # odd, >= 3
    win = min(win, 121)  # a 3 km model would otherwise ask for a 333-cell window
    regular = lons.ndim == 1
    is_global = regular if world is None else world
    modes = ("nearest", "wrap") if is_global else "nearest"
    lo = minimum_filter(field, size=win, mode=modes)
    hi = maximum_filter(field, size=win, mode=modes)
    # A flat window is no extremum, and one reaching into missing data is not
    # the extreme of anything that was modelled.
    real = hi > lo
    if valid is not None and not valid.all():
        real &= minimum_filter(valid.astype(np.uint8), size=win, mode=modes) == 1

    def coord(j: int, i: int) -> tuple[float, float]:
        if regular:
            return _wrap_lon(float(lons[i])), float(lats[j])
        return float(lons[j, i]), float(lats[j, i])

    out: list[dict[str, Any]] = []
    for kind, mask in (("L", (field == lo) & real), ("H", (field == hi) & real)):
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


def _orography(model: str, run, hour: int, shape: tuple[int, ...], mesh: bool) -> np.ndarray | None:
    """Model surface height on the pressure field's grid, when the model publishes it."""
    if "orog" not in ms.fields_of(model):
        return None
    for h in dict.fromkeys((hour, 0)):
        try:
            f, _ = ms.fetch_field(model, "orog", h, run)
        except Exception:  # noqa: BLE001 - masking is a nicety, never fatal
            continue
        values = ms.regular(f, MESH_STEP, f"{model}:mesh")[2] if f.scattered else f.values
        return values if values.shape == shape else None
    return None


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
    if not ms.has_mslp(model):
        raise ValueError(f"{m['label']} does not publish sea level pressure")
    if not 0 <= hour <= m["max_hour"]:
        raise ValueError(f"{m['label']} does not run to f{hour:03d} (max f{m['max_hour']:03d})")
    if not 0 < interval <= 50:
        raise ValueError(f"Isobar interval out of range: {interval}")

    field, run = ms.fetch_field(model, "mslp", hour)
    run_id = run.strftime("%Y%m%d%H")
    key = (model, run_id, hour, interval, centres, round(smooth, 2))
    with _LOCK:
        cached = _RESULT_CACHE.get(key)
    if cached is not None:
        return cached

    spacing = m["spacing"]
    if field.scattered:
        lats, lons, raw = ms.regular(field, MESH_STEP, f"{model}:mesh")
        spacing, is_global = MESH_STEP, True
    else:
        lons, lats, raw, is_global = field.lons, field.lats, field.values, bool(field.world)

    # Blur is specified in *degrees* and converted to cells, so the same setting
    # means the same physical smoothing on a 1 deg grid and on a 3 km one.
    # SMOOTH_DEG is small on purpose: heavier blur rounds troughs off into
    # featureless ovals, and the detail in the wave pattern is the whole point.
    valid = np.isfinite(raw)
    filled = raw if valid.all() else np.where(valid, raw, np.nanmean(raw))
    if smooth > 0:
        sigma = min(max(SMOOTH_DEG * smooth / max(spacing, 0.01), 0.35), 12.0)
        values = gaussian_filter(filled, sigma=sigma, mode=("nearest", "wrap") if is_global else "nearest")
    else:
        values = filled
    if not valid.all():
        values = np.where(valid, values, np.nan)

    if is_global and lons.ndim == 1:
        # Repeat the first column one turn on, so lines run through the seam
        # instead of stopping dead at the grid edge.
        c_lons = np.append(lons, lons[0] + 360.0)
        c_values = np.concatenate([values, values[:, :1]], axis=1)
    else:
        c_lons, c_values = lons, values

    features = _isobars(c_lons, lats, c_values, interval, is_global)
    if centres:
        orog = _orography(model, run, hour, values.shape, field.scattered)
        centre_values = np.where(np.isfinite(values), values, np.nanmean(values))
        features.extend(_centres(lons, lats, centre_values, spacing, orog, world=is_global,
                                 valid=np.isfinite(values)))

    valid_dt = run + timedelta(hours=hour)
    result = {
        "source": f"{m['org']} {m['label']}",
        "model": model,
        "modelLabel": m["label"],
        "coverage": m["coverage"],
        "variable": "MSLP",
        "units": "hPa",
        "run": run.strftime("%a %Y-%m-%d %HZ"),
        "runIso": run.isoformat().replace("+00:00", "Z"),
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


# The rain/snow divider a forecaster reads a thickness chart by.
THICK_DIVIDER = 540.0


def build_thickness(
    model: str = DEFAULT_MODEL,
    hour: int = 0,
    interval: float = 6.0,
    smooth: float = 1.0,
) -> dict[str, Any]:
    """1000-500 hPa thickness in decametres, as contours.

    The depth of the lower half of the atmosphere is a measure of its mean
    temperature: cold air is shallow, warm air is deep. Drawn over the isobars,
    the two together are the classic surface chart -- and the 540 dam line,
    emitted with `key`, is the rough divide between rain and snow.
    """
    if model not in MODELS:
        raise ValueError(f"Unknown model: {model}")
    m = MODELS[model]
    if not ms.has_thickness(model):
        raise ValueError(f"{m['label']} does not publish the 500 and 1000 hPa heights thickness needs")
    if not 0 <= hour <= m["max_hour"]:
        raise ValueError(f"{m['label']} does not run to f{hour:03d} (max f{m['max_hour']:03d})")
    if not 0 < interval <= 30:
        raise ValueError(f"Thickness interval out of range: {interval}")

    upper, run = ms.fetch_field(model, "z500", hour)
    lower, _ = ms.fetch_field(model, "z1000", hour, run)
    run_id = run.strftime("%Y%m%d%H")
    key = ("thickness", model, run_id, hour, interval, round(smooth, 2))
    with _LOCK:
        cached = _RESULT_CACHE.get(key)
    if cached is not None:
        return cached

    spacing = m["spacing"]
    if upper.scattered:
        lats, lons, high = ms.regular(upper, MESH_STEP, f"{model}:mesh")
        low = ms.regular(lower, MESH_STEP, f"{model}:mesh")[2]
        spacing, is_global = MESH_STEP, True
    else:
        lons, lats, high, is_global = upper.lons, upper.lats, upper.values, bool(upper.world)
        low = lower.values
    if high.shape != low.shape:
        raise RuntimeError(f"{m['label']}: its 500 and 1000 hPa fields are on different grids")

    raw = (high - low) / 10.0  # metres -> decametres, the unit of the chart

    valid_mask = np.isfinite(raw)
    filled = raw if valid_mask.all() else np.where(valid_mask, raw, np.nanmean(raw))
    if smooth > 0:
        sigma = min(max(SMOOTH_DEG * smooth / max(spacing, 0.01), 0.35), 12.0)
        values = gaussian_filter(filled, sigma=sigma, mode=("nearest", "wrap") if is_global else "nearest")
    else:
        values = filled
    if not valid_mask.all():
        values = np.where(valid_mask, values, np.nan)

    if is_global and lons.ndim == 1:
        c_lons = np.append(lons, lons[0] + 360.0)
        c_values = np.concatenate([values, values[:, :1]], axis=1)
    else:
        c_lons, c_values = lons, values

    features = _isobars(
        c_lons, lats, c_values, interval, is_global,
        unit="dam", divider=THICK_DIVIDER, major_every=30.0,
    )

    valid_dt = run + timedelta(hours=hour)
    result = {
        "source": f"{m['org']} {m['label']}",
        "model": model,
        "modelLabel": m["label"],
        "coverage": m["coverage"],
        "variable": "Thickness 1000-500 hPa",
        "units": "dam",
        "run": run.strftime("%a %Y-%m-%d %HZ"),
        "runIso": run.isoformat().replace("+00:00", "Z"),
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
