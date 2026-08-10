"""
Area-averaged sounding.

A point sounding tells you what the model thinks about one grid cell. Over a
mesoscale area — a warm sector, an outflow-boundary intersection, a lake — what
matters is the representative profile, not whichever cell the cursor landed in.
This samples the model at a grid of points inside a circle and averages the
profiles level by level.

Open-Meteo accepts comma-separated `latitude`/`longitude` lists and answers with
a JSON ARRAY of per-location objects (verified: 25 points, ~225 KB, ~1.5 s), so
the whole area costs one request rather than N.

Winds are averaged as u/v components, never as bearings: averaging 350° and 010°
numerically gives 180°, which is exactly backwards.
"""
from __future__ import annotations

import base64
import math
import time
from typing import Any, Optional

import requests

import sounding_core
from sounding_core import (
    MODELS,
    OM_LEVELS,
    NetworkError,
    _om_fields,
    _preflight_model,
    _model_meta,
    build_levels,
    compute,
)

EARTH_KM_PER_DEG = 111.32
MIN_SIDE = 2
MAX_SIDE = 7          # 49 points is the most one request should carry
DEFAULT_SIDE = 5
# A box smaller than this is a mis-drag, not an area; a box larger than this
# stops being one air mass and the mean stops meaning anything. Both gates are
# in KILOMETRES on purpose: an angular minimum is unusable at city zoom, where
# the whole visible map can be a small fraction of a degree, so 0.02 deg would
# reject every box the user is physically able to draw.
MIN_SIDE_KM = 1.0
MAX_SPAN_KM = 800.0

_CACHE: dict[tuple, tuple[float, dict]] = {}
# The raw multi-point download, keyed by the box itself. Every timeline step
# rebuilds the mean for a different hour from the SAME 4-day member profiles,
# so without this each step re-downloads all 25 members (~225 KB) again.
_RAW_CACHE: dict[tuple, tuple[float, list[dict]]] = {}
_TTL = 600.0


def normalise_box(lat0: float, lon0: float, lat1: float,
                  lon1: float) -> tuple[float, float, float, float]:
    """Corner pair in any order -> (south, west, north, east)."""
    return (min(lat0, lat1), min(lon0, lon1), max(lat0, lat1), max(lon0, lon1))


def box_size_km(south: float, west: float, north: float, east: float) -> tuple[float, float]:
    mid_lat = (south + north) / 2.0
    height = (north - south) * EARTH_KM_PER_DEG
    width = (east - west) * EARTH_KM_PER_DEG * math.cos(math.radians(mid_lat))
    return round(abs(width), 1), round(abs(height), 1)


def sample_points(south: float, west: float, north: float, east: float,
                  side: int) -> list[tuple[float, float]]:
    """An evenly spaced `side` x `side` grid inside the rectangle.

    The samples sit at cell CENTRES, not on the edges: a point exactly on the
    boundary is half outside the area the user drew, and the corners would
    dominate the mean. The rectangle's own centre is always included so the
    average is anchored on what the user aimed at.
    """
    side = max(MIN_SIDE, min(int(side), MAX_SIDE))
    pts: list[tuple[float, float]] = []
    for i in range(side):
        for j in range(side):
            fy = (i + 0.5) / side
            fx = (j + 0.5) / side
            p = (round(south + fy * (north - south), 4),
                 round(west + fx * (east - west), 4))
            if p not in pts:
                pts.append(p)
    centre = (round((south + north) / 2.0, 4), round((west + east) / 2.0, 4))
    if centre not in pts:
        pts.insert(0, centre)
    return pts


def _fetch_many(points: list[tuple[float, float]], om_model: str) -> list[dict]:
    """One Open-Meteo request for every sample point."""
    try:
        resp = sounding_core._SESSION.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": ",".join(f"{p[0]:.4f}" for p in points),
                "longitude": ",".join(f"{p[1]:.4f}" for p in points),
                "hourly": ",".join(_om_fields()),
                "models": om_model,
                "forecast_days": 4,
                "wind_speed_unit": "kn",
                "cell_selection": "nearest",
                "timeformat": "unixtime",
            },
            timeout=(8, 90),
        )
    except requests.exceptions.RequestException as exc:
        raise NetworkError(
            "Could not reach Open-Meteo after several tries - check the internet "
            "connection and try again."
        ) from exc

    try:
        data = resp.json()
    except ValueError:
        resp.raise_for_status()
        raise RuntimeError("Open-Meteo returned a non-JSON response")
    if not resp.ok:
        if isinstance(data, dict) and data.get("reason"):
            raise RuntimeError(data["reason"])
        resp.raise_for_status()
    # A single-location request answers with an object, a multi-location one
    # with an array; normalise so the caller only sees the list.
    if isinstance(data, dict):
        if data.get("error"):
            raise RuntimeError(data.get("reason", "Open-Meteo error"))
        return [data]
    return list(data)


def _dir_spd(u: float, v: float) -> tuple[float, float]:
    spd = math.hypot(u, v)
    d = (270.0 - math.degrees(math.atan2(v, u))) % 360.0
    return d, spd


def _average(members: list[dict]) -> tuple[list[dict], float]:
    """Average member level lists onto the model's own pressure levels.

    Members disagree about which levels exist: a point 300 m higher has fewer
    levels below ground. Each pressure is therefore averaged over the members
    that actually reported it, and a level fewer than half the members carry is
    dropped rather than being represented by a couple of outliers.
    """
    need = max(1, len(members) // 2)

    # Surface: its pressure varies with terrain, so it is averaged as its own
    # level rather than being snapped onto the standard grid.
    sfc_acc = {"p": 0.0, "h": 0.0, "t": 0.0, "td": 0.0, "u": 0.0, "v": 0.0, "n": 0}
    for m in members:
        lv = m["levels"][0] if m["levels"] else None
        if lv is None:
            continue
        u = -lv["ws"] * math.sin(math.radians(lv["wd"]))
        v = -lv["ws"] * math.cos(math.radians(lv["wd"]))
        sfc_acc["p"] += lv["p"]; sfc_acc["h"] += lv["h"]; sfc_acc["t"] += lv["t"]
        sfc_acc["td"] += lv["td"]; sfc_acc["u"] += u; sfc_acc["v"] += v
        sfc_acc["n"] += 1

    out: list[dict] = []
    elevation = 0.0
    if sfc_acc["n"]:
        n = sfc_acc["n"]
        d, s = _dir_spd(sfc_acc["u"] / n, sfc_acc["v"] / n)
        elevation = sfc_acc["h"] / n
        out.append({
            "p": round(sfc_acc["p"] / n, 2),
            "h": round(elevation, 1),
            "t": round(sfc_acc["t"] / n, 2),
            "td": round(sfc_acc["td"] / n, 2),
            "wd": round(d, 1),
            "ws": round(s, 1),
        })

    for target in OM_LEVELS:
        acc = {"h": 0.0, "t": 0.0, "td": 0.0, "u": 0.0, "v": 0.0, "n": 0}
        for m in members:
            for lv in m["levels"]:
                if abs(lv["p"] - target) > 0.51:
                    continue
                acc["h"] += lv["h"]; acc["t"] += lv["t"]; acc["td"] += lv["td"]
                acc["u"] += -lv["ws"] * math.sin(math.radians(lv["wd"]))
                acc["v"] += -lv["ws"] * math.cos(math.radians(lv["wd"]))
                acc["n"] += 1
                break
        if acc["n"] < need:
            continue
        n = acc["n"]
        d, s = _dir_spd(acc["u"] / n, acc["v"] / n)
        out.append({
            "p": float(target),
            "h": round(acc["h"] / n, 1),
            "t": round(acc["t"] / n, 2),
            "td": round(acc["td"] / n, 2),
            "wd": round(d, 1),
            "ws": round(s, 1),
        })

    out.sort(key=lambda l: -l["p"])
    cleaned: list[dict] = []
    for lv in out:
        if cleaned and lv["p"] >= cleaned[-1]["p"]:
            continue
        if cleaned and lv["h"] <= cleaned[-1]["h"]:
            continue
        cleaned.append(lv)
    return cleaned, elevation


def build_area_sounding(lat0: float, lon0: float, lat1: float, lon1: float,
                        model: str = sounding_core.DEFAULT_MODEL, hour: int = 0,
                        side: int = DEFAULT_SIDE) -> dict:
    """Average the model's profile over a rectangle and render it like any sounding.

    The area is the box the user dragged on the map, given as any two opposite
    corners.
    """
    for v, lo, hi, name in ((lat0, -90, 90, "latitude"), (lat1, -90, 90, "latitude"),
                            (lon0, -360, 360, "longitude"), (lon1, -360, 360, "longitude")):
        if not math.isfinite(v) or not (lo <= v <= hi):
            raise ValueError(f"bbox {name} out of range: {v}")
    # MapLibre hands back unwrapped longitudes once the user pans past the
    # antimeridian (e.g. -190), which Open-Meteo rejects with an opaque error.
    lon0 = ((lon0 + 180.0) % 360.0) - 180.0
    lon1 = ((lon1 + 180.0) % 360.0) - 180.0

    south, west, north, east = normalise_box(lat0, lon0, lat1, lon1)
    width_km, height_km = box_size_km(south, west, north, east)
    if width_km < MIN_SIDE_KM or height_km < MIN_SIDE_KM:
        raise ValueError(
            f"The selected area is too small ({width_km:.1f} x {height_km:.1f} km); "
            f"drag a box at least {MIN_SIDE_KM:.0f} km across."
        )
    if width_km > MAX_SPAN_KM or height_km > MAX_SPAN_KM:
        raise ValueError(
            f"The selected area is too large ({width_km:.0f} x {height_km:.0f} km); "
            f"keep each side under {MAX_SPAN_KM:.0f} km."
        )

    side = max(MIN_SIDE, min(int(side), MAX_SIDE))
    requested_hour = max(0, int(hour))
    if model not in MODELS:
        model = sounding_core.DEFAULT_MODEL

    lat = (south + north) / 2.0
    lon = (west + east) / 2.0
    ck = (round(south, 3), round(west, 3), round(north, 3), round(east, 3),
          model, requested_hour, side)
    now = time.time()
    hit = _CACHE.get(ck)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    requested_model = model
    actual, reason = _preflight_model(lat, lon, model)
    points = sample_points(south, west, north, east, side)

    raw_key = (round(south, 3), round(west, 3), round(north, 3), round(east, 3), side, actual)
    raw_hit = _RAW_CACHE.get(raw_key)
    if raw_hit and now - raw_hit[0] < _TTL:
        raws = raw_hit[1]
    else:
        raws = _fetch_many(points, MODELS[actual]["om"])
        _RAW_CACHE[raw_key] = (now, raws)
        while len(_RAW_CACHE) > 8:  # each entry is ~25 x 4-day profiles
            _RAW_CACHE.pop(next(iter(_RAW_CACHE)))

    # Drop members with no usable profile (points outside a regional model's
    # domain answer 200 with all-null pressure fields).
    members: list[dict] = []
    used: list[tuple[float, float]] = []
    n_times = 0
    times: list[int] = []
    valid_hours: list[int] = []
    for raw, pt in zip(raws, points):
        hours_ok = sounding_core._valid_hour_indices(raw)
        if not hours_ok:
            continue
        if not valid_hours:
            valid_hours = hours_ok
            times = raw.get("hourly", {}).get("time", [])
            n_times = len(times)
        members.append(raw)
        used.append(pt)

    if not members:
        raise RuntimeError(
            f"{MODELS[actual]['label']} has no vertical profile anywhere in this area"
        )

    max_valid_hour = max(valid_hours)
    hour_i = min(requested_hour, max(n_times - 1, 0))
    if hour_i not in valid_hours:
        hour_i = sounding_core._nearest_valid_hour(valid_hours, hour_i)
        reason = sounding_core._append_notice(
            reason, f"No complete vertical profile at F{requested_hour:03d}; using F{hour_i:03d}."
        )

    # Keep each assembled profile paired with the point it came from, so the
    # dots the map draws are exactly the members that survived into the mean.
    # Reporting `used` here while drawing the pre-filter list made the overlay
    # claim contributions that were dropped.
    pairs = [(pt, build_levels(raw, hour_i)) for pt, raw in zip(used, members)]
    pairs = [(pt, a) for pt, a in pairs if len(a["levels"]) >= 4]
    used = [pt for pt, _ in pairs]
    assembled = [a for _, a in pairs]
    if not assembled:
        raise RuntimeError("Not enough valid levels anywhere in this area")

    levels, elevation = _average(assembled)
    if len(levels) < 4:
        raise RuntimeError("The averaged profile has too few levels to analyse")

    result = compute(levels, lat=lat)
    model_info = _model_meta(requested_model, actual, reason)
    valid_unix = assembled[0]["valid_unix"]

    meta = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "model": model_info["model"],
        "requestedModel": model_info["requestedModel"],
        "modelLabel": f"{model_info['modelLabel']} — area mean",
        "requestedModelLabel": model_info["requestedModelLabel"],
        "modelGroup": model_info["modelGroup"],
        "openMeteoModel": model_info["openMeteoModel"],
        "fallbackReason": model_info["fallbackReason"],
        "hour": hour_i,
        "requestedHour": requested_hour,
        "forecastMaxHour": max_valid_hour,
        "validHours": valid_hours,
        "elevation": round(elevation, 1),
        "validUnix": valid_unix,
        "times": times[: max_valid_hour + 1],
        "nTimes": max_valid_hour + 1,
        "area": {
            "bbox": [round(south, 4), round(west, 4), round(north, 4), round(east, 4)],
            "widthKm": width_km,
            "heightKm": height_km,
            "side": side,
            "requested": len(points),
            "used": len(assembled),
            "points": [[p[1], p[0]] for p in used],  # lon/lat, ready for GeoJSON
        },
        "source": "Open-Meteo area mean + SHARPpy SPCWidget",
    }

    image = None
    image_error = None
    try:
        from sharppy_renderer import render_spc_widget_png

        image = base64.b64encode(render_spc_widget_png(levels, meta)).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        image_error = str(exc)

    payload = {
        "meta": meta,
        "levels": levels,
        "parcelTrace": result["parcelTrace"],
        "effBotP": result["effBotP"],
        "effTopP": result["effTopP"],
        "params": result["params"],
        "image": image,
        "imageRenderer": "sharppy",
        "imageError": image_error,
    }
    _CACHE[ck] = (now, payload)
    while len(_CACHE) > 32:
        _CACHE.pop(next(iter(_CACHE)))
    return payload
