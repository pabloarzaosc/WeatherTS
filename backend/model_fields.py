"""
The model registry, and the H/L centre finder a surface chart is read by.

The standalone pressure and thickness charts that lived here are gone: the
pressure map now rides on the analysis products that carry sea-level pressure
(observations.py calls _centres for it), and fronts_model uses it for the
centres on model-derived fronts. Where each model's fields come from lives in
model_sources; the table is served at /api/model-fields/models.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy.ndimage import maximum_filter, minimum_filter

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


