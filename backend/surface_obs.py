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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
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


def fetch_surface_obs(bbox: str, cell: Optional[float] = None, networks: str = "metar,synop,mesonet",
                      at: Optional[float] = None) -> dict:
    """bbox = 'lat0,lon0,lat1,lon1'. Returns a GeoJSON FeatureCollection of
    every network asked for, a site reported by two of them once, and -- with
    `cell` (degrees) -- one station per cell, the best-ranked (see _rank).

    `at` (unix seconds) asks for the reports in force at that instant instead
    of the newest: each station's last report before it, as the timeline shows
    a radar or satellite frame from the past. A network that keeps no data that
    far back is named in `unavailable` rather than answered with today's."""
    import station_networks  # noqa: PLC0415

    want = {n.strip() for n in networks.split(",") if n.strip()}
    feats: list[dict] = []
    unavailable: list[str] = []
    if "metar" in want:
        if at is not None and time.time() - at > METAR_ARCHIVE_S:
            unavailable.append("metar")
        else:
            for f in _metar_features(bbox, at):
                f["properties"].setdefault("kind", "metar")
                f["properties"].setdefault("network", "METAR")
                feats.append(f)
    if want & {"synop", "mesonet"}:
        lat0, lon0, lat1, lon1 = (float(x) for x in bbox.split(","))
        extra, missing = station_networks.features_in_box(lat0, lon0, lat1, lon1, cell=cell,
                                                          synop="synop" in want, mesonet="mesonet" in want, at=at)
        feats.extend(extra)
        unavailable.extend(missing)
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
    pending = bool(want & {"synop", "mesonet"}) and station_networks.feeds_pending(at)
    return {"type": "FeatureCollection", "features": kept, "pending": pending,
            "at": at, "unavailable": unavailable}


# The AWC keeps about 15 days of METARs; asked for older, it answers nothing.
METAR_ARCHIVE_S = 14 * 86400
# A report older than this before the instant asked for no longer describes it:
# an airport reports hourly, and a special in between.
METAR_MAX_AGE_S = 75 * 60
# The AWC answers at most this many reports, whatever the box: a view of the
# whole US came back with 400 of its 2,000 airports, whichever came first.
AWC_ROW_CAP = 400
_AWC_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="awc")


def _awc_rows(bbox: tuple[float, float, float, float], params: dict, depth: int = 0) -> list[dict]:
    """Every report the AWC has for the box, the box split in four and asked
    again (in parallel) where one request came back full."""
    lat0, lon0, lat1, lon1 = bbox
    resp = _SESSION.get(AWC_URL, params={**params, "bbox": f"{lat0:.3f},{lon0:.3f},{lat1:.3f},{lon1:.3f}"},
                        timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    try:
        rows = resp.json()
    except ValueError:
        rows = []
    if not isinstance(rows, list):
        return []
    if len(rows) < AWC_ROW_CAP or depth >= 3:
        return rows
    mid_lat, mid_lon = (lat0 + lat1) / 2, (lon0 + lon1) / 2
    quads = [(lat0, lon0, mid_lat, mid_lon), (lat0, mid_lon, mid_lat, lon1),
             (mid_lat, lon0, lat1, mid_lon), (mid_lat, mid_lon, lat1, lon1)]
    parts = list(_AWC_POOL.map(lambda q: _awc_rows(q, params, depth + 1), quads)) if depth == 0 else \
        [_awc_rows(q, params, depth + 1) for q in quads]
    seen: set[tuple] = set()
    out: list[dict] = []
    for part in parts:
        for r in part:
            k = (r.get("icaoId"), r.get("obsTime"))
            if k not in seen:
                seen.add(k)
                out.append(r)
    return out


# Every airport's newest METAR, worldwide, in one file the AWC rewrites each
# minute (250 kB). The API's box query stood in for it and fell short twice
# over: at most 400 reports a request, and without `hours` only the stations
# that had reported in the last few minutes -- 320 of the 812 airports in the
# northeastern US on 28 Sep. The file has them all.
AWC_CACHE_URL = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
_BULK: dict[str, Any] = {"at": 0.0, "rows": []}
_BULK_TTL = 120.0


def _bulk_metars() -> list[dict]:
    """The AWC's current METARs, as API-shaped rows (see _feature_from_metar)."""
    now = time.time()
    if now - _BULK["at"] < _BULK_TTL and _BULK["rows"]:
        return _BULK["rows"]
    import csv  # noqa: PLC0415
    import gzip  # noqa: PLC0415
    import io  # noqa: PLC0415

    resp = _SESSION.get(AWC_CACHE_URL, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    body = resp.content
    text = (gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body).decode("utf-8", "replace")
    reader = csv.reader(io.StringIO(text))
    head = next(reader, [])
    col = {k: i for i, k in enumerate(head) if k not in ("sky_cover", "cloud_base_ft_agl")}
    sky = [i for i, k in enumerate(head) if k == "sky_cover"]

    def get(r: list[str], k: str) -> str:
        i = col.get(k)
        return r[i] if i is not None and i < len(r) else ""

    rows: list[dict] = []
    for r in reader:
        if len(r) < len(head) // 2:
            continue
        try:
            t = datetime.fromisoformat(get(r, "observation_time").replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        alt_in = _num(get(r, "altim_in_hg"))
        wdir = get(r, "wind_dir_degrees")
        rows.append({
            "icaoId": get(r, "station_id"),
            "name": None,
            "lat": get(r, "latitude"),
            "lon": get(r, "longitude"),
            "temp": get(r, "temp_c"),
            "dewp": get(r, "dewpoint_c"),
            "wdir": int(float(wdir)) if wdir.replace(".", "", 1).isdigit() else wdir or None,
            "wspd": get(r, "wind_speed_kt"),
            "wgst": get(r, "wind_gust_kt"),
            "altim": None if alt_in is None else round(alt_in * 33.8639, 1),
            "visib": get(r, "visibility_statute_mi") or None,
            "clouds": [{"cover": r[i], "base": _num(r[i + 1]) if i + 1 < len(r) else None}
                       for i in sky if i < len(r) and r[i]],
            "wxString": get(r, "wx_string") or None,
            "rawOb": get(r, "raw_text"),
            "precip": get(r, "precip_in") or None,
            "obsTime": int(t),
        })
    _BULK.update({"at": now, "rows": rows})
    return rows


def _metar_features(bbox: str, at: Optional[float] = None) -> list[dict]:
    """The newest report of each airport in the box -- or, with `at`, the last
    one each made before that instant (within METAR_MAX_AGE_S)."""
    # A past instant is read to the quarter hour: a loop's frames share
    # requests, and an airport reports hourly anyway.
    at = None if at is None else int(at // 900 * 900)
    box = tuple(float(x) for x in bbox.split(","))
    if at is None:
        lat0, lon0, lat1, lon1 = box
        rows = [m for m in _bulk_metars()
                if (la := _num(m["lat"])) is not None and (lo := _num(m["lon"])) is not None
                and lat0 <= la <= lat1 and lon0 <= lo <= lon1]
        return [f for f in (_feature_from_metar(m) for m in rows) if f is not None]

    key = f"{bbox}@{at}"
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < (_TTL if now - at < 3 * 3600 else 6 * 3600):
        return [dict(f, properties=dict(f["properties"])) for f in hit[1]["features"]]
    params: dict[str, Any] = {
        "format": "json",
        "date": datetime.fromtimestamp(at, timezone.utc).strftime("%Y%m%d_%H%M"),
        "hours": 1.25,
    }
    rows = _awc_rows(box, params)
    newest: dict[str, dict] = {}
    for r in rows:
        t = _timestamp_value(r.get("obsTime"))
        if t is None or t > at or at - t > METAR_MAX_AGE_S:
            continue
        have = newest.get(r.get("icaoId"))
        if have is None or t > (_timestamp_value(have.get("obsTime")) or 0):
            newest[r.get("icaoId")] = r
    rows = list(newest.values())

    features = [_feature_from_metar(m) for m in rows]
    features = [f for f in features if f is not None]
    fc = {"type": "FeatureCollection", "features": features}
    _CACHE[key] = (now, fc)
    if len(_CACHE) > 200:
        for old in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:60]:
            _CACHE.pop(old, None)
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
    precip_mm, trace = _metar_precip(m)
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
            # Rain since the last hourly report (mm): what the report's P group
            # says. A special mid-hour carries the hour so far.
            "precip": precip_mm,
            "precipHours": 1 if precip_mm is not None else None,
            "precipTrace": trace,
            "rh": _rh(temp, dewp),
            "thetae": _theta_e(temp, dewp, altim),
            "obsTime": m.get("obsTime"),
        },
    }


def _metar_precip(m: dict) -> tuple[Optional[float], bool]:
    """Precipitation since the last hourly report, in mm, and whether it was a
    trace. The P group is sent only when some fell, so an automated station
    with a gauge (AO2) and no P group had none; a station without one (AO1),
    or with its gauge out (PNO), says nothing either way."""
    raw = m.get("rawOb") or ""
    inches = _num(m.get("precip"))
    if inches is not None:
        # The AWC gives P0000, a trace, as 0.005 in.
        if inches < 0.01:
            return 0.0, True
        return round(inches * 25.4, 1), False
    rmk = raw.split(" RMK ", 1)[1] if " RMK " in raw else ""
    if (" AO2" in f" {rmk}" or " AO2A" in f" {rmk}") and "PNO" not in rmk:
        return 0.0, False
    return None, False


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
    # The bulk file's other words for the same skies.
    alias = {"CAVOK": "CLR", "NCD": "CLR", "NSC": "CLR", "OVX": "OVC"}
    best = None
    for c in clouds:
        cov = (c or {}).get("cover")
        cov = alias.get(cov, cov)
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
