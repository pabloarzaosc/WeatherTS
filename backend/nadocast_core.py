"""
NadoCast -> native vector outlook.

The app used to paste NadoCast's CONUS PNG onto the map as a raster overlay. Here
we instead download NadoCast's GRIB2 probability grid, contour it at the SPC
probability thresholds, and return GeoJSON polygons so the frontend can render it
as a first-class vector outlook (same look/legend as the SPC layers).

GRIB2 is read with eccodes; filled contours come from matplotlib's contour engine
(via the thread-safe OO Figure API, no pyplot global state).
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
import requests
import eccodes as ec
from matplotlib.figure import Figure

from model_sources import EC_HANDLE_LOCK

NADOCAST_BASE = "http://data.nadocast.com"
RUNS = ("t18z", "t14z", "t12z", "t0z")
LOOKBACK_DAYS = 5

# SPC probability thresholds per hazard (percent). NadoCast is calibrated to the
# same scale, so we reuse the SPC contour breaks and colours for a consistent look.
THRESHOLDS: dict[str, list[int]] = {
    "tornado": [2, 5, 10, 15, 30, 45, 60],
    "wind": [5, 15, 30, 45, 60],
    "hail": [5, 15, 30, 45, 60],
    "sig-tornado": [2, 5, 10],
}
PROB_COLORS: dict[int, str] = {
    2: "#79BA7A",
    5: "#BD998A",
    10: "#FFE481",
    15: "#E89B38",
    30: "#D15F5F",
    45: "#C653C6",
    60: "#912CEE",
}

# url -> built response, so re-toggling a layer doesn't re-download/re-contour.
_CACHE: dict[str, dict[str, Any]] = {}


def _hazard_key(hazard: str) -> str:
    return "sig_tornado" if hazard == "sig-tornado" else hazard


def _model_fragments(model: str) -> list[str]:
    if model == "2024":
        return ["2024_preliminary_models"]
    if model == "2022":
        return ["2022_models"]
    return ["2024_preliminary_models", "2022_models"]


def _hrefs(html: str) -> list[str]:
    out = []
    for part in html.split('href="')[1:]:
        out.append(part.split('"')[0])
    return out


def find_latest_grib(hazard: str, model: str) -> tuple[str, str, str]:
    """Walk the NadoCast archive backward from today; return (url, run, yyyymmdd)."""
    key = _hazard_key(hazard)
    fragments = _model_fragments(model)
    now = datetime.now(timezone.utc)

    for offset in range(LOOKBACK_DAYS):
        day = now - timedelta(days=offset)
        yyyymm = f"{day.year}{day.month:02d}"
        yyyymmdd = f"{yyyymm}{day.day:02d}"
        day_url = f"{NADOCAST_BASE}/{yyyymm}/{yyyymmdd}/"
        try:
            day_html = requests.get(day_url, timeout=20).text
        except requests.RequestException:
            continue
        for run in RUNS:
            if f"/{yyyymm}/{yyyymmdd}/{run}/" not in day_html:
                continue
            run_url = f"{day_url}{run}/"
            try:
                run_html = requests.get(run_url, timeout=20).text
            except requests.RequestException:
                continue
            for fragment in fragments:
                needle = f"nadocast_{fragment}_conus_{key}_"
                for cand in _hrefs(run_html):
                    if (
                        cand.endswith(".grib2")
                        and needle in cand
                        and "_abs_calib" not in cand
                        and "life_risk" not in cand
                    ):
                        if cand.startswith("http"):
                            url = cand
                        elif cand.startswith("/"):
                            url = f"{NADOCAST_BASE}{cand}"
                        else:
                            url = f"{run_url}{cand}"
                        return url, run, yyyymmdd
    raise RuntimeError("No recent NadoCast GRIB2 found")


def _read_prob_grid(content: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (lons2d, lats2d, values2d) from a single-field NadoCast GRIB2."""
    fd, path = tempfile.mkstemp(suffix=".grib2")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        with open(path, "rb") as f:
            with EC_HANDLE_LOCK:  # see model_sources.EC_HANDLE_LOCK
                gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                raise RuntimeError("GRIB2 had no messages")
            ni = ec.codes_get(gid, "Ni")
            nj = ec.codes_get(gid, "Nj")
            values = ec.codes_get_values(gid).reshape(nj, ni)
            data = ec.codes_grib_get_data(gid)
            lats = np.fromiter((d.lat for d in data), dtype=float, count=nj * ni).reshape(nj, ni)
            lons = np.fromiter((d.lon for d in data), dtype=float, count=nj * ni).reshape(nj, ni)
            ec.codes_release(gid)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    lons = ((lons + 180.0) % 360.0) - 180.0  # 0..360 -> -180..180
    return lons, lats, values


def _signed_area(ring: np.ndarray) -> float:
    x, y = ring[:, 0], ring[:, 1]
    return 0.5 * float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))


def _point_in_ring(pt: np.ndarray, ring: np.ndarray) -> bool:
    x, y = float(pt[0]), float(pt[1])
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _path_to_polygons(path) -> list[list[np.ndarray]]:
    """matplotlib contourf compound path -> [ [exterior, *holes], ... ]."""
    rings = [np.asarray(r) for r in path.to_polygons() if len(r) >= 4]
    exteriors = [r for r in rings if _signed_area(r) > 0]
    holes = [r for r in rings if _signed_area(r) <= 0]
    polygons = []
    for ext in exteriors:
        my_holes = [h for h in holes if _point_in_ring(h[0], ext)]
        polygons.append([ext, *my_holes])
    return polygons


def _contour_features(lons, lats, values, thresholds) -> list[dict[str, Any]]:
    levels = [*thresholds, 100]
    fig = Figure()  # OO API: no pyplot global state, safe under the server
    ax = fig.subplots()
    cs = ax.contourf(lons, lats, values, levels=levels)
    features: list[dict[str, Any]] = []
    for i, path in enumerate(cs.get_paths()):
        lower = thresholds[i] if i < len(thresholds) else thresholds[-1]
        color = PROB_COLORS.get(lower, "#9ca3af")
        for poly in _path_to_polygons(path):
            coords = [
                [[round(float(x), 4), round(float(y), 4)] for x, y in ring] for ring in poly
            ]
            if not coords or len(coords[0]) < 4:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {"label": f"{lower}%", "dn": lower, "color": color, "prob": lower},
                    "geometry": {"type": "Polygon", "coordinates": coords},
                }
            )
    return features


def _legend(hazard: str) -> list[dict[str, str]]:
    return [
        {"label": f"{t}%", "color": PROB_COLORS.get(t, "#9ca3af"), "section": "Probability"}
        for t in THRESHOLDS.get(hazard, [])
    ]


def build_nadocast(hazard: str, model: str = "auto") -> dict[str, Any]:
    if hazard not in THRESHOLDS:
        raise ValueError(f"Unknown NadoCast hazard: {hazard}")

    url, run, yyyymmdd = find_latest_grib(hazard, model)
    if url in _CACHE:
        return _CACHE[url]

    content = requests.get(url, timeout=30).content
    lons, lats, values = _read_prob_grid(content)
    features = _contour_features(lons, lats, values, THRESHOLDS[hazard])

    valid = f"{yyyymmdd[:4]}-{yyyymmdd[4:6]}-{yyyymmdd[6:8]}"
    result = {
        "source": "NadoCast",
        "stale": False,
        "error": None,
        "run": f"{run} {yyyymmdd}",
        "valid": valid,
        "expire": None,
        "url": url,
        "legend": _legend(hazard),
        "geojson": {"type": "FeatureCollection", "features": features},
    }
    _CACHE[url] = result
    return result
