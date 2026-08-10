"""
NEXRAD storm-cell tracking (SCIT) and mesocyclone detections.

Level III graphic products off Unidata's public S3 archive:
  * NST (58)  — Storm Tracking Information: every tracked cell's current
                position plus its past and forecast tracks.
  * NMD (141) — Mesocyclone Detection Algorithm output.

Decode the SYMBOLOGY block, never the tabular one. MetPy garbles `tab_pages`
for these graphic products (it yields one character per line), while
`sym_block[0]` comes out clean. Verified live against KMPX, which returned
8 tracked cells with full past/forecast polylines.

Packet order inside the symbology block, per cell:
    {'current storm position': (x, y)}
    {'x': .., 'y': .., 'id': 'J1', 'type': 'Storm ID'}
    {'markers': [{'past storm position': ..}, ..],     'track': [(x, y), ..]}
    {'markers': [{'forecast storm position': ..}, ..], 'track': [(x, y), ..]}
Past and forecast are told apart by the word in `markers` -- there is no other
discriminator. Coordinates are kilometres relative to the radar (x east,
y north).
"""
from __future__ import annotations

import io
import math
import time
from typing import Any, Optional

from metpy.io import Level3File

from nexrad_core import (
    S3,
    _HTTP_TIMEOUT,
    _SESSION,
    _latest_key,
    _scans_for_day,
    _utc_unix,
    key_time,
)

KM_PER_DEG_LAT = 111.32
# SCIT forecasts every 15 minutes, a fixed interval, so the first leg of the
# forecast track gives speed without needing the (garbled) attribute table.
FORECAST_STEP_H = 0.25
_KT_PER_KMH = 0.539957
_MPH_PER_KMH = 0.621371

_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 60.0

COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _compass(deg: float) -> str:
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


def _to_lonlat(site_lat: float, site_lon: float, x_km: float, y_km: float) -> list[float]:
    lat = site_lat + y_km / KM_PER_DEG_LAT
    lon = site_lon + x_km / (KM_PER_DEG_LAT * math.cos(math.radians(lat)))
    return [round(lon, 4), round(lat, 4)]


def _track_points(pkt: dict, site_lat: float, site_lon: float) -> list[list[float]]:
    trk = pkt.get("track")
    if not isinstance(trk, (list, tuple)):
        return []
    out = []
    for pt in trk:
        try:
            out.append(_to_lonlat(site_lat, site_lon, float(pt[0]), float(pt[1])))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def _key_near(site: str, product: str, unix: int) -> Optional[str]:
    """The scan of `product` closest in time to `unix`.

    Storm products are published on the same ~4-6 minute volume cadence as the
    moments, but not at the identical second, so the radar frame's timestamp has
    to be matched by proximity rather than equality. The previous UTC day is
    searched too, or a frame just after 00Z finds nothing.
    """
    from datetime import datetime, timedelta, timezone

    when = datetime.fromtimestamp(unix, timezone.utc)
    best: Optional[tuple[int, str]] = None
    for day in (when, when - timedelta(days=1), when + timedelta(days=1)):
        if day > datetime.now(timezone.utc) + timedelta(days=1):
            continue
        for s in _scans_for_day(site, product, day.strftime("%Y_%m_%d")):
            if s["time"] is None:
                continue
            d = abs(int(s["time"]) - unix)
            if best is None or d < best[0]:
                best = (d, s["key"])
    # Beyond half an hour it is not the same weather; fall back to nothing so the
    # caller shows no tracks rather than tracks from an unrelated volume.
    if best is None or best[0] > 1800:
        return None
    return best[1]


def _fetch(site: str, product: str, key: Optional[str] = None,
           unix: Optional[int] = None):
    if not key:
        key = _key_near(site, product, unix) if unix is not None else _latest_key(site, product)
    if not key:
        return None, None
    raw = _SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content
    return Level3File(io.BytesIO(raw)), key


def _cells_from_key(site: str, key: str) -> tuple[list[dict], dict]:
    return _cells(site, key=key)


def _cells(site: str, unix: Optional[int] = None,
           key: Optional[str] = None) -> tuple[list[dict], dict]:
    f, key = _fetch(site, "NST", key=key, unix=unix)
    if f is None:
        return [], {}
    site_lat, site_lon = float(f.lat), float(f.lon)
    block = f.sym_block[0] if getattr(f, "sym_block", None) else []

    cells: list[dict] = []
    for i, p in enumerate(block):
        if not (isinstance(p, dict) and p.get("type") == "Storm ID"):
            continue
        try:
            x, y = float(p["x"]), float(p["y"])
        except (KeyError, TypeError, ValueError):
            continue

        past: list[list[float]] = []
        forecast: list[list[float]] = []
        # The two track packets follow the id packet directly; stop at the next
        # cell rather than scanning the whole block.
        for q in block[i + 1: i + 4]:
            if not (isinstance(q, dict) and "track" in q):
                continue
            marker = str(q.get("markers", ""))
            if "forecast" in marker:
                forecast = _track_points(q, site_lat, site_lon)
            elif "past" in marker:
                past = _track_points(q, site_lat, site_lon)

        heading = speed_mph = None
        speed_kt = None
        raw_fc = None
        for q in block[i + 1: i + 4]:
            if isinstance(q, dict) and "track" in q and "forecast" in str(q.get("markers", "")):
                raw_fc = q["track"]
                break
        if isinstance(raw_fc, (list, tuple)) and len(raw_fc) >= 2:
            try:
                dx = float(raw_fc[1][0]) - float(raw_fc[0][0])
                dy = float(raw_fc[1][1]) - float(raw_fc[0][1])
                heading = math.degrees(math.atan2(dx, dy)) % 360.0
                kmh = math.hypot(dx, dy) / FORECAST_STEP_H
                speed_mph = kmh * _MPH_PER_KMH
                speed_kt = kmh * _KT_PER_KMH
            except (TypeError, ValueError, IndexError):
                heading = speed_mph = speed_kt = None

        lon, lat = _to_lonlat(site_lat, site_lon, x, y)
        cells.append({
            "id": str(p.get("id") or "?"),
            "lon": lon,
            "lat": lat,
            "xKm": round(x, 2),
            "yKm": round(y, 2),
            "rangeKm": round(math.hypot(x, y), 1),
            "azimuthDeg": round(math.degrees(math.atan2(x, y)) % 360.0, 1),
            "headingDeg": round(heading, 1) if heading is not None else None,
            "headingCompass": _compass(heading) if heading is not None else None,
            "speedMph": round(speed_mph) if speed_mph is not None else None,
            "speedKt": round(speed_kt, 1) if speed_kt is not None else None,
            "past": past,
            "forecast": forecast,
        })

    meta = {
        "site": f"K{site}",
        "siteLat": site_lat,
        "siteLon": site_lon,
        "maxRangeKm": float(f.max_range),
        "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key or ""),
        "key": key,
    }
    return cells, meta


def _mesos(site: str, cells: list[dict], site_lat: float, site_lon: float,
           unix: Optional[int] = None) -> list[dict]:
    """Mesocyclone / TVS detections, linked to the nearest tracked cell.

    Deliberately forgiving: MDA output is sparse (an all-quiet volume returns an
    empty symbology block, which is the normal case) and the packet vocabulary
    varies between builds, so anything with a position and a recognised type is
    accepted rather than matched against a fixed schema.
    """
    try:
        f, _key = _fetch(site, "NMD", unix=unix)
    except Exception:
        return []
    if f is None:
        return []
    block = f.sym_block[0] if getattr(f, "sym_block", None) else []

    raw: list[dict] = []
    for p in block:
        if not isinstance(p, dict):
            continue
        kind = str(p.get("type") or "")
        if not kind:
            continue
        low = kind.lower()
        is_meso = "meso" in low or low in ("mda", "3d correlated shear")
        is_tvs = "tvs" in low or "tornado" in low
        if not (is_meso or is_tvs):
            continue
        xs, ys = p.get("x"), p.get("y")
        pairs: list[tuple[float, float]] = []
        if isinstance(xs, (list, tuple)) and isinstance(ys, (list, tuple)):
            for a, b in zip(xs, ys):
                try:
                    pairs.append((float(a), float(b)))
                except (TypeError, ValueError):
                    continue
        else:
            try:
                pairs.append((float(xs), float(ys)))
            except (TypeError, ValueError):
                continue
        for x, y in pairs:
            raw.append({"x": x, "y": y, "tvs": is_tvs})

    out: list[dict] = []
    for i, m in enumerate(raw):
        lon, lat = _to_lonlat(site_lat, site_lon, m["x"], m["y"])
        # Link to the closest cell so the popup can say "cell G8 has a meso".
        storm_id = None
        best = 20.0  # km
        for c in cells:
            d = math.hypot(c["xKm"] - m["x"], c["yKm"] - m["y"])
            if d < best:
                best = d
                storm_id = c["id"]
        # A TVS packet within 5 km promotes the detection.
        tvs = m["tvs"] or any(
            o["tvs"] and math.hypot(o["x"] - m["x"], o["y"] - m["y"]) < 5.0 for o in raw
        )
        out.append({
            "id": f"M{i + 1}",
            "lon": lon,
            "lat": lat,
            "stormId": storm_id,
            "tvs": bool(tvs),
            "rangeKm": round(math.hypot(m["x"], m["y"]), 1),
        })
    return out


def build_storms(site: str, unix: Optional[int] = None) -> dict:
    """Tracked cells + mesocyclones for one radar.

    `unix` selects the storm scan nearest that instant so the tracks follow a
    scrubbed radar loop; without it the latest volume is used.
    """
    site = (site or "").upper().strip()
    if len(site) != 3:
        raise ValueError("site must be the 3-letter radar id, e.g. 'MPX'")

    now = time.time()
    # Resolve which scan we are answering about FIRST, then cache on that key.
    # Radar frames come every ~4 min and storm scans every ~6, so a loop asks
    # about many timestamps that all resolve to the same NST scan -- keying the
    # cache on the timestamp would re-download and re-decode it for each one.
    if unix is not None:
        key = _key_near(site, "NST", int(unix))
    else:
        key = _latest_key(site, "NST")

    ck = (site, key)
    hit = _CACHE.get(ck)
    # A decoded scan never changes; only the "what is latest" answer expires.
    if hit and (unix is not None or now - hit[0] < _TTL):
        return hit[1]

    cells, meta = _cells(site, unix) if key is None else _cells_from_key(site, key)
    if not meta:
        # A frame with no storm scan within half an hour is a legitimate answer:
        # report it as empty rather than as an error, so playback keeps running.
        if unix is not None:
            out = {"meta": {"site": f"K{site}", "siteLat": None, "siteLon": None,
                            "maxRangeKm": None, "validUnix": None, "key": None,
                            "cellCount": 0, "mesoCount": 0},
                   "cells": [], "mesos": []}
            _CACHE[ck] = (now, out)
            return out
        raise RuntimeError(f"No recent storm-tracking scan for K{site}.")
    mesos = _mesos(site, cells, meta["siteLat"], meta["siteLon"], unix)

    # Strongest first: the cell a forecaster cares about should top the list.
    cells.sort(key=lambda c: (c["speedMph"] or 0), reverse=True)
    out = {"meta": {**meta, "cellCount": len(cells), "mesoCount": len(mesos)},
           "cells": cells, "mesos": mesos}
    _CACHE[ck] = (now, out)
    while len(_CACHE) > 200:
        _CACHE.pop(next(iter(_CACHE)))
    return out
