"""
River gauges and their hydrographs, from the NWS National Water Prediction
Service.

Every NWS river gauge -- some 11,000 across the US, Puerto Rico and Alaska --
with its stage now, the flood category that stage is in, and the category of
the highest stage the river forecast centres expect over their forecast. The
categories are the NWS's own, set per gauge from what floods at what stage:
action (prepare), minor, moderate and major flood. Those are the coloured
lines of an NWS hydrograph: yellow, orange, red, purple over the green of no
flooding.

  * The map's list comes from NWS's riv_gauges map service (observed stages,
    layer 0; the full forecast period, layer 15): one query, the fields asked
    for, in seconds. The NWPS API's own list is the same gauges at 9 MB and
    over a minute.
  * A gauge's hydrograph comes from the NWPS API (api.water.noaa.gov): the
    last 30 days observed and the official forecast, the category stages,
    the historic crests and what floods at which stage (impacts).
"""
from __future__ import annotations

import calendar
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from typing import Any, Optional

import requests

MAPSERVER = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer"
NWPS = "https://api.water.noaa.gov/nwps/v1"
GAUGES_TTL = 10 * 60
HYDRO_TTL = 5 * 60
_TIMEOUT = 45

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"

_LOCK = threading.Lock()
_GAUGES: Optional[tuple[float, dict]] = None
_HYDRO: dict[str, tuple[float, dict]] = {}

# The NWS's category names, worst first, and the ones that are not a category.
CATEGORIES = ["major", "moderate", "minor", "action", "no_flooding"]
_RANK = {c: i for i, c in enumerate(reversed(CATEGORIES))}  # no_flooding 0 .. major 4


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f <= -999 else f


def _query(layer: int, fields: str) -> list[dict]:
    """Every row of a riv_gauges layer, paged past the service's 10,000 cap."""
    rows: list[dict] = []
    offset = 0
    while True:
        r = _SESSION.get(f"{MAPSERVER}/{layer}/query", params={
            "where": "1=1", "outFields": fields, "returnGeometry": "false", "f": "json",
            "resultOffset": offset, "resultRecordCount": 10000, "orderByFields": "objectid",
        }, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"NWS river gauge service: {data['error'].get('message')}")
        batch = [f.get("attributes", {}) for f in data.get("features", [])]
        rows.extend(batch)
        if not data.get("exceededTransferLimit") or not batch:
            return rows
        offset += len(batch)


def gauges() -> dict:
    """Every gauge: where, the stage now and its category, the category stages,
    and the forecast's highest category and stage."""
    global _GAUGES
    with _LOCK:
        if _GAUGES and time.time() - _GAUGES[0] < GAUGES_TTL:
            return _GAUGES[1]
    obs = _query(0, "gaugelid,status,location,waterbody,state,wfo,obstime,observed,units,"
                    "action,flood,moderate,major,latitude,longitude")
    try:
        fc = {r.get("gaugelid"): r for r in _query(15, "gaugelid,status,forecast,fcsttime")}
    except Exception:  # noqa: BLE001 - the observed map stands on its own
        fc = {}
    out = []
    for r in obs:
        lid = r.get("gaugelid")
        lat, lon = _num(r.get("latitude")), _num(r.get("longitude"))
        if not lid or lat is None or lon is None:
            continue
        f = fc.get(lid) or {}
        fstatus = f.get("status") or None
        out.append({
            "lid": lid,
            "river": (r.get("waterbody") or "").strip(),
            "place": (r.get("location") or "").strip(),
            "state": r.get("state") or "",
            "wfo": r.get("wfo") or "",
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "status": r.get("status") or "not_defined",
            "stage": _num(r.get("observed")),
            "units": r.get("units") or "",
            "obsTime": r.get("obstime") or None,
            "action": _num(r.get("action")),
            "flood": _num(r.get("flood")),
            "moderate": _num(r.get("moderate")),
            "major": _num(r.get("major")),
            "fstatus": fstatus if fstatus in _RANK else None,
            "fstage": _num(f.get("forecast")),
            "fTime": f.get("fcsttime") or None,
        })
    result = {"gauges": out, "updated": time.time(), "count": len(out)}
    with _LOCK:
        _GAUGES = (time.time(), result)
    return result


def _series(block: Optional[dict], step_s: int = 0) -> tuple[list[list], dict]:
    """[[unix, stage, flow], ...] of an NWPS stageflow block, oldest first,
    thinned to one point per `step_s` when asked; and its names and units."""
    if not block:
        return [], {}
    pts: list[list] = []
    last = None
    for d in block.get("data") or []:
        stage = _num(d.get("primary"))
        flow = _num(d.get("secondary"))
        if stage is None and flow is None:
            continue
        try:
            t = calendar.timegm(time.strptime(d["validTime"], "%Y-%m-%dT%H:%M:%SZ"))
        except (KeyError, ValueError):
            continue
        if step_s and last is not None and t - last < step_s:
            continue
        pts.append([t, stage, flow])
        last = t
    pts.sort(key=lambda p: p[0])
    meta = {
        "primaryName": block.get("primaryName") or "Stage",
        "primaryUnits": block.get("primaryUnits") or "",
        "secondaryName": block.get("secondaryName") or "Flow",
        "secondaryUnits": block.get("secondaryUnits") or "",
        "issued": block.get("issuedTime"),
    }
    return pts, meta


_INFO: dict[str, tuple[float, dict]] = {}
INFO_TTL = 6 * 3600


def _info(lid: str, fresh: bool = False) -> dict:
    """NWPS's record of a gauge: its levels, impacts, crests, neighbours. The
    parts the river's chain needs (names, upstream and downstream) change
    rarely, so a walk along the river reuses them for hours."""
    with _LOCK:
        hit = _INFO.get(lid)
        if hit and not fresh and time.time() - hit[0] < INFO_TTL:
            return hit[1]
    g = _SESSION.get(f"{NWPS}/gauges/{lid}", timeout=_TIMEOUT)
    if g.status_code == 404:
        raise ValueError(f"No NWS gauge {lid}.")
    g.raise_for_status()
    info = g.json()
    with _LOCK:
        _INFO[lid] = (time.time(), info)
        while len(_INFO) > 400:
            _INFO.pop(next(iter(_INFO)))
    return info


def hydrograph(lid: str) -> dict:
    """One gauge: its observed stages (30 days, thinned to 15 min past the last
    day and hourly before), the official forecast, the category stages, the
    record and highest crests, and what floods at which stage."""
    lid = lid.strip().upper()
    with _LOCK:
        hit = _HYDRO.get(lid)
        if hit and time.time() - hit[0] < HYDRO_TTL:
            return hit[1]
    info = _info(lid, fresh=True)
    sf = _SESSION.get(f"{NWPS}/gauges/{lid}/stageflow", timeout=_TIMEOUT)
    sf.raise_for_status()
    flow = sf.json()

    obs_all, obs_meta = _series(flow.get("observed"))
    # The last day as reported; before that one point an hour is plenty for a
    # 30-day line and keeps the reply small.
    cut = obs_all[-1][0] - 86400 if obs_all else 0
    obs = [p for p in obs_all if p[0] < cut]
    thinned: list[list] = []
    for p in obs:
        if not thinned or p[0] - thinned[-1][0] >= 3600:
            thinned.append(p)
    observed = thinned + [p for p in obs_all if p[0] >= cut]
    forecast, fc_meta = _series(flow.get("forecast"))

    fl = info.get("flood") or {}
    cats = fl.get("categories") or {}
    stages = {k: _num((cats.get(k) or {}).get("stage")) for k in ("action", "minor", "moderate", "major")}
    flows = {k: _num((cats.get(k) or {}).get("flow")) for k in ("action", "minor", "moderate", "major")}
    # The series' flow is in its own units (kcfs on most gauges); the
    # categories' flows are in the gauge's (cfs). One unit for both.
    flow_units = obs_meta.get("secondaryUnits") or fc_meta.get("secondaryUnits") or fl.get("flowUnits") or ""
    if (fl.get("flowUnits") or "").lower() == "cfs" and flow_units.lower() == "kcfs":
        flows = {k: (v / 1000 if v is not None else None) for k, v in flows.items()}
    crests = (fl.get("crests") or {}).get("historic") or []
    crests = sorted(
        ({"time": c.get("occurredTime"), "stage": _num(c.get("stage")), "preliminary": c.get("preliminary")}
         for c in crests if _num(c.get("stage")) is not None),
        key=lambda c: -c["stage"],
    )
    impacts = sorted(
        ({"stage": _num(i.get("stage")), "statement": (i.get("statement") or "").strip()}
         for i in (fl.get("impacts") or []) if _num(i.get("stage")) is not None),
        key=lambda i: i["stage"],
    )
    status = info.get("status") or {}
    # The chance of minor, moderate and major flooding over the next three
    # months, from the RFC's long-range outlook ("OND": Oct-Nov-Dec).
    lro = fl.get("lro") or {}
    outlook = None
    if lro.get("interval") and any(_num(lro.get(k)) is not None for k in ("minorCS", "moderateCS", "majorCS")):
        outlook = {
            "interval": lro.get("interval"),
            "issued": lro.get("producedTime"),
            "minor": _num(lro.get("minorCS")),
            "moderate": _num(lro.get("moderateCS")),
            "major": _num(lro.get("majorCS")),
        }
    prob = (info.get("images") or {}).get("probability") or {}
    images = {
        "shortrange": prob.get("shortrange") or None,
        "weekly": ((prob.get("weekint") or {}).get("stage")) or None,
        "season": ((prob.get("entperiod") or {}).get("stage")) or None,
    }
    result = {
        "lid": lid,
        "net": "nws",
        "name": info.get("name") or lid,
        "usgsId": info.get("usgsId") or None,
        "state": (info.get("state") or {}).get("abbreviation"),
        "wfo": (info.get("wfo") or {}).get("abbreviation"),
        "rfc": (info.get("rfc") or {}).get("abbreviation"),
        "lat": info.get("latitude"),
        "lon": info.get("longitude"),
        "units": fl.get("stageUnits") or obs_meta.get("primaryUnits") or "ft",
        "flowUnits": flow_units,
        "stages": stages,
        "flows": flows,
        "observed": observed,
        "observedMeta": obs_meta,
        "forecast": forecast,
        "forecastMeta": fc_meta,
        "crests": crests[:8],
        "record": crests[0] if crests else None,
        "impacts": impacts,
        "status": {
            "observed": (status.get("observed") or {}).get("floodCategory"),
            "forecast": (status.get("forecast") or {}).get("floodCategory"),
        },
        "reliability": info.get("forecastReliability"),
        "county": info.get("county") or None,
        "upstream": (info.get("upstreamLid") or "").strip().upper() or None,
        "downstream": (info.get("downstreamLid") or "").strip().upper() or None,
        "notes": [n.get("statement", "").strip() for n in (info.get("hydronotes") or []) if n.get("statement")],
        "outlook": outlook,
        "images": images,
        "rain": [],
    }
    with _LOCK:
        _HYDRO[lid] = (time.time(), result)
        while len(_HYDRO) > 64:
            _HYDRO.pop(next(iter(_HYDRO)))
    return result


# --- around a gauge: the river's other gauges, the normal flow, the rain -----

USGS_STAT = "https://waterservices.usgs.gov/nwis/stat/"
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
NORMALS_TTL = 7 * 86400
RAIN_TTL = 30 * 60
CHAIN_STEPS = 4
_NORMALS: dict[str, tuple[float, Optional[dict]]] = {}
_RAIN: dict[tuple, tuple[float, dict]] = {}


def flow_normals(usgs_id: str) -> Optional[dict]:
    """USGS's daily statistics of a site's mean daily flow: for each day of the
    year the minimum, the 10th, 25th, 50th, 75th and 90th percentiles and the
    maximum over the site's record -- what is normal for the date. cfs."""
    with _LOCK:
        hit = _NORMALS.get(usgs_id)
        if hit and time.time() - hit[0] < NORMALS_TTL:
            return hit[1]
    # The service answers a 503 now and then to a request it serves the next
    # second.
    for attempt in range(3):
        r = _SESSION.get(USGS_STAT, params={
            "format": "rdb", "sites": usgs_id, "statReportType": "daily", "statTypeCd": "all", "parameterCd": "00060",
        }, timeout=_TIMEOUT)
        if r.status_code < 500:
            break
        time.sleep(1 + attempt)
    if r.status_code >= 500:
        raise RuntimeError(f"USGS statistics service: HTTP {r.status_code}")
    result: Optional[dict] = None
    if r.status_code == 200:
        rows = [ln.split("\t") for ln in r.text.splitlines() if ln and not ln.startswith("#")]
        if len(rows) > 2:
            head = rows[0]
            col = {name: i for i, name in enumerate(head)}
            days: dict[str, list] = {}
            ts = None
            years = [9999, 0]
            for row in rows[2:]:
                if len(row) < len(head):
                    continue
                # A site with two flow series lists both; the first is the main one.
                ts = ts or row[col["ts_id"]]
                if row[col["ts_id"]] != ts:
                    continue
                key = f"{int(row[col['month_nu']]):02d}-{int(row[col['day_nu']]):02d}"
                days[key] = [_num(row[col[c]]) for c in ("min_va", "p10_va", "p25_va", "p50_va", "p75_va", "p90_va", "max_va")]
                try:
                    years = [min(years[0], int(row[col["begin_yr"]])), max(years[1], int(row[col["end_yr"]]))]
                except ValueError:
                    pass
            if days:
                result = {"days": days, "years": years, "units": "cfs", "site": usgs_id}
    with _LOCK:
        _NORMALS[usgs_id] = (time.time(), result)
    return result


def rain(lat: float, lon: float) -> dict:
    """Hourly rain at a point over the last 31 days and the next 7, from
    Open-Meteo's best model mix: [[unix s at the end of the hour, mm]]."""
    key = (round(lat, 2), round(lon, 2))
    with _LOCK:
        hit = _RAIN.get(key)
        if hit and time.time() - hit[0] < RAIN_TTL:
            return hit[1]
    for attempt in range(3):
        r = _SESSION.get(OPEN_METEO, params={
            "latitude": key[0], "longitude": key[1], "hourly": "precipitation",
            "past_days": 31, "forecast_days": 7, "timezone": "GMT",
        }, timeout=_TIMEOUT)
        if r.status_code < 500:
            break
        time.sleep(1 + attempt)  # a busy moment of the free service
    r.raise_for_status()
    h = r.json().get("hourly") or {}
    out = []
    for stamp, mm in zip(h.get("time") or [], h.get("precipitation") or []):
        if mm is None:
            continue
        try:
            t = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M"))
        except ValueError:
            continue
        out.append([t, round(float(mm), 2)])
    result = {"hourly": out, "source": "Open-Meteo (best model mix)"}
    with _LOCK:
        _RAIN[key] = (time.time(), result)
        while len(_RAIN) > 100:
            _RAIN.pop(next(iter(_RAIN)))
    return result


def _walk(lid: str, key: str, steps: int) -> list[str]:
    out: list[str] = []
    seen = {lid}
    cur = lid
    for _ in range(steps):
        try:
            nxt = (_info(cur).get(key) or "").strip().upper()
        except Exception:  # noqa: BLE001 - the chain stops where NWPS does
            break
        if not nxt or nxt in seen:
            break
        out.append(nxt)
        seen.add(nxt)
        cur = nxt
    return out


def chain(lid: str) -> list[dict]:
    """The gauges up and down the river from this one, upstream first, each
    with its stage and category now: NWPS's upstream and downstream links,
    followed a few steps each way."""
    with ThreadPoolExecutor(max_workers=2) as ex:
        up_f = ex.submit(_walk, lid, "upstreamLid", CHAIN_STEPS)
        down_f = ex.submit(_walk, lid, "downstreamLid", CHAIN_STEPS)
        up, down = up_f.result(), down_f.result()
    try:
        by = {g["lid"]: g for g in gauges()["gauges"]}
    except Exception:  # noqa: BLE001
        by = {}
    nodes = []
    for node in list(reversed(up)) + [lid] + down:
        g = by.get(node) or {}
        info = (_INFO.get(node) or (0, {}))[1]
        nodes.append({
            "lid": node,
            "river": g.get("river") or "",
            "place": g.get("place") or info.get("name") or node,
            "status": g.get("status") or "not_defined",
            "stage": g.get("stage"),
            "units": g.get("units") or "",
            "fstatus": g.get("fstatus"),
            "self": node == lid,
        })
    return nodes


def context(lid: str) -> dict:
    """What the hydrograph screen shows around the gauge, asked for after the
    hydrograph so it never holds it up: the river's chain of gauges, the
    normal flow for each date (USGS), the rain past and forecast (Open-Meteo)."""
    lid = lid.strip().upper()
    info = _info(lid)
    lat, lon = _num(info.get("latitude")), _num(info.get("longitude"))
    usgs = (info.get("usgsId") or "").strip()
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        chain_f = ex.submit(chain, lid)
        normals_f = ex.submit(flow_normals, usgs) if usgs else None
        rain_f = ex.submit(rain, lat, lon) if lat is not None and lon is not None else None
        nodes, normals, rain_data = [], None, None
        try:
            nodes = chain_f.result()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"river chain: {exc}")
        if normals_f:
            try:
                normals = normals_f.result()
            except Exception as exc:  # noqa: BLE001
                errors.append(f"USGS statistics: {exc}")
        if rain_f:
            try:
                rain_data = rain_f.result()
            except Exception as exc:  # noqa: BLE001
                errors.append(f"rain: {exc}")
    # The normals in the series' own flow units (kcfs on most gauges).
    hydro = (_HYDRO.get(lid) or (0, {}))[1]
    if normals and (hydro.get("flowUnits") or "").lower() == "kcfs":
        normals = {**normals, "units": "kcfs",
                   "days": {k: [(v / 1000 if v is not None else None) for v in vals] for k, vals in normals["days"].items()}}
    return {"lid": lid, "chain": nodes, "normals": normals, "rain": rain_data, "errors": errors}
