"""
Surface observations for the station plots.

The airports come from the Aviation Weather Center METAR API (global, free, no
key); the stations away from them from station_networks (WMO SYNOP and NOAA
MADIS's mesonets). For a map box this returns one GeoJSON FeatureCollection
with the decoded fields a station-plot renderer needs: temp/dewpoint (C), wind
dir/speed/gust (kt), pressure (mb), visibility, sky cover, plus derived values
-- each feature marked with its `kind` ("metar", "synop", "mesonet").
"""
from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

AWC_URL = "https://aviationweather.gov/api/data/metar"

_HTTP_TIMEOUT = (8, 25)
_SESSION = requests.Session()
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=3, connect=3, read=2, backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
        )
    ),
)

_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 120.0  # obs update ~hourly; a short cache is plenty and spares the API
_HISTORY_TTL = 180.0


def _num(v) -> Optional[float]:
    try:
        if v is None:
            return None
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _wdir(v) -> Optional[int]:
    # AWC returns an int, 0 (calm), or "VRB" (variable) -> no fixed direction.
    if isinstance(v, (int, float)):
        return int(v)
    return None


def _rh(temp: Optional[float], dewp: Optional[float]) -> Optional[float]:
    if temp is None or dewp is None:
        return None
    try:
        e = math.exp((17.625 * dewp) / (243.04 + dewp))
        es = math.exp((17.625 * temp) / (243.04 + temp))
        return round(100.0 * e / es, 0)
    except (ValueError, ZeroDivisionError):
        return None


def _theta_e(temp: Optional[float], dewp: Optional[float], pres_mb: Optional[float]) -> Optional[float]:
    # Simple equivalent potential temperature estimate (K); good enough for a plot.
    if temp is None or pres_mb is None:
        return None
    tk = temp + 273.15
    theta = tk * (1000.0 / pres_mb) ** 0.2854
    if dewp is None:
        return round(theta, 0)
    # mixing ratio from dewpoint
    e = 6.112 * math.exp((17.67 * dewp) / (dewp + 243.5))
    w = 0.622 * e / max(pres_mb - e, 1e-3)
    lv = 2.5e6
    cp = 1004.0
    return round(theta * math.exp(lv * w / (cp * tk)), 0)


# Which kind of station wins a crowded spot: an airport's full report, then a
# synoptic station, then the mesonets (the complete ones first).
_KIND_RANK = {"metar": 0, "inmet": 1, "synop": 1, "mesonet": 2}
# Stations closer than this (degrees, ~2 km) are the same site in two feeds.
_SAME_SITE = 0.02


def _rank(f: dict) -> tuple:
    p = f["properties"]
    have = sum(p.get(k) is not None for k in ("temp", "dewp", "wspd", "altim"))
    t = _timestamp_value(p.get("obsTime")) or 0
    return (_KIND_RANK.get(p.get("kind"), 3), -have, -t)


def fetch_surface_obs(bbox: str, cell: Optional[float] = None, networks: str = "metar,synop,mesonet") -> dict:
    """bbox = 'lat0,lon0,lat1,lon1'. Returns a GeoJSON FeatureCollection of
    every network asked for, a site reported by two of them once, and -- with
    `cell` (degrees) -- one station per cell, the best-ranked (see _rank)."""
    import station_networks  # noqa: PLC0415

    want = {n.strip() for n in networks.split(",") if n.strip()}
    feats: list[dict] = []
    if "metar" in want:
        for f in _metar_features(bbox):
            f["properties"].setdefault("kind", "metar")
            f["properties"].setdefault("network", "METAR")
            feats.append(f)
    if want & {"synop", "mesonet"}:
        lat0, lon0, lat1, lon1 = (float(x) for x in bbox.split(","))
        extra = station_networks.features_in_box(lat0, lon0, lat1, lon1, cell=cell,
                                                 synop="synop" in want, mesonet="mesonet" in want)
        feats.extend(extra)
    feats.sort(key=_rank)
    kept: list[dict] = []
    sites: dict[tuple[int, int], list[tuple[float, float]]] = {}
    cells: set[tuple[int, int]] = set()
    for f in feats:
        lon, lat = f["geometry"]["coordinates"]
        key = (int(math.floor(lat / _SAME_SITE)), int(math.floor(lon / _SAME_SITE)))
        near = any(
            abs(lat - a) < _SAME_SITE and abs(lon - b) < _SAME_SITE
            for dy in (-1, 0, 1) for dx in (-1, 0, 1)
            for a, b in sites.get((key[0] + dy, key[1] + dx), ())
        )
        if near:
            continue
        if cell:
            c = (int(math.floor(lat / cell)), int(math.floor(lon / cell)))
            if c in cells:
                continue
            cells.add(c)
        sites.setdefault(key, []).append((lat, lon))
        kept.append(f)
    pending = bool(want & {"synop", "mesonet"}) and station_networks.feeds_pending()
    return {"type": "FeatureCollection", "features": kept, "pending": pending}


def _metar_features(bbox: str) -> list[dict]:
    key = bbox
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return [dict(f, properties=dict(f["properties"])) for f in hit[1]["features"]]

    resp = _SESSION.get(AWC_URL, params={"bbox": bbox, "format": "json"}, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    try:
        rows = resp.json()
    except ValueError:
        rows = []
    if not isinstance(rows, list):
        rows = []

    features = [_feature_from_metar(m) for m in rows]
    features = [f for f in features if f is not None]
    fc = {"type": "FeatureCollection", "features": features}
    _CACHE[key] = (now, fc)
    return [dict(f, properties=dict(f["properties"])) for f in fc["features"]]


def fetch_surface_history(station: str, hours: int = 24) -> list[dict]:
    """Return recent normalized METAR observations for one station."""
    station = station.strip().upper()
    hours = max(1, min(int(hours), 48))
    key = f"history:{station}:{hours}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _HISTORY_TTL:
        return hit[1].get("observations", [])
    resp = _SESSION.get(
        AWC_URL,
        params={"ids": station, "hours": hours, "format": "json"},
        timeout=_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not isinstance(rows, list):
        rows = []
    observations = [_feature_from_metar(m) for m in rows]
    observations = [f["properties"] | {"lat": f["geometry"]["coordinates"][1],
                                       "lon": f["geometry"]["coordinates"][0]}
                    for f in observations if f is not None]
    observations.sort(key=lambda item: _timestamp_value(item.get("obsTime")) or 0)
    result = {"observations": observations}
    _CACHE[key] = (now, result)
    return observations


def _feature_from_metar(m: dict) -> Optional[dict]:
    if not isinstance(m, dict):
        return None
    lat = _num(m.get("lat"))
    lon = _num(m.get("lon"))
    if lat is None or lon is None:
        return None
    temp = _num(m.get("temp"))
    dewp = _num(m.get("dewp"))
    wspd = _num(m.get("wspd"))
    wgst = _num(m.get("wgst"))
    altim = _num(m.get("altim"))
    visib = m.get("visib")
    cover = m.get("cover") or _top_cover(m.get("clouds"))
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": m.get("icaoId"),
            "name": m.get("name"),
            "temp": temp,
            "dewp": dewp,
            "wdir": _wdir(m.get("wdir")),
            "wspd": wspd,
            "wgst": wgst,
            "altim": altim,
            "visib": _visib_num(visib),
            "cover": cover,
            # The individual layers, not just the densest one: "SCT 4500 /
            # SCT 6500" is what a forecaster reads, and the single worst cover
            # throws the bases away.
            "clouds": _clouds(m.get("clouds")),
            # Present weather (rain, snow, fog...) as reported.
            "wx": m.get("wxString") or None,
            # The untouched report. Everything above is derived from it, so
            # having it on hand is what lets someone check our decoding.
            "raw": m.get("rawOb") or None,
            "rh": _rh(temp, dewp),
            "thetae": _theta_e(temp, dewp, altim),
            "obsTime": m.get("obsTime"),
        },
    }


def _timestamp_value(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        number = float(value)
        return number / 1000 if number > 10_000_000_000 else number
    except (TypeError, ValueError):
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None


def _clouds(clouds) -> list[dict]:
    """Reported cloud layers, lowest first, dropping anything without a cover."""
    if not isinstance(clouds, list):
        return []
    out = []
    for c in clouds:
        if not isinstance(c, dict):
            continue
        cov = c.get("cover")
        if not cov:
            continue
        out.append({"cover": cov, "base": _num(c.get("base"))})
    out.sort(key=lambda c: (c["base"] is None, c["base"] or 0))
    return out


def _top_cover(clouds) -> Optional[str]:
    if not isinstance(clouds, list) or not clouds:
        return None
    order = {"SKC": 0, "CLR": 0, "FEW": 1, "SCT": 2, "BKN": 3, "OVC": 4}
    best = None
    for c in clouds:
        cov = (c or {}).get("cover")
        if cov in order and (best is None or order[cov] > order[best]):
            best = cov
    return best


def _visib_num(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace("+", "").strip()
    try:
        return float(s)
    except ValueError:
        return None
