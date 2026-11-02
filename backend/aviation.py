"""
Aviation weather: what a pilot reads before a flight, on the map and per airport.

Everything is the Aviation Weather Center's (aviationweather.gov) except the
TFRs, which are the FAA's. Neither answers a browser from another origin, so
the app reads them through here, each kept for about as long as its source
takes to change:

    METARs      every airport's newest report worldwide, with its flight
                category (surface_obs already keeps the AWC's bulk file)
    TAFs        every TAF in force (the bulk file), worked into a timeline:
                what prevails when, and the TEMPO and PROB groups over it
    PIREPs      pilot reports and AIREPs (the bulk file: the API stops at 400)
    SIGMETs     the US ones (convective included) and the international ones
    G-AIRMETs   every forecast hour, 0 to 12
    CWAs        the centres' own advisories
    TCF         the TFM convective forecast
    TFRs        the FAA's temporary flight restrictions, with their shapes
    Winds aloft the FB forecasts, decoded onto their stations

and, for one airport, all of that at once: its runways and frequencies, its
METARs, its TAF, the PIREPs around it, the advisories over it and the winds
above it. What the AWC and the FAA give for the US alone -- airport records,
winds aloft, airspace -- aviation_world.py gives for every country.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import math
import tempfile
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import requests

AWC = "https://aviationweather.gov"
TFR_LIST = "https://tfr.faa.gov/tfrapi/getTfrList"
TFR_SHAPES = ("https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature"
              "&typeName=TFR:V_TFR_LOC&maxFeatures=2000&outputFormat=application/json&srsname=EPSG:4326")

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS (contact@weatherts.tech)"
_TIMEOUT = (10, 60)

_DISK = Path(tempfile.gettempdir()) / "weatherts-aviation"
_LOCK = threading.Lock()
_CACHE: dict[str, tuple[float, Any]] = {}
_GATES: dict[str, threading.Lock] = {}


def _cached(key: str, ttl: float, make: Callable[[], Any]) -> Any:
    """The value kept under `key`, made again once it is `ttl` seconds old --
    or, when making it fails, the old one, as long as there is one."""
    with _LOCK:
        hit = _CACHE.get(key)
        gate = _GATES.setdefault(key, threading.Lock())
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    with gate:
        with _LOCK:
            hit = _CACHE.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            value = make()
        except Exception:
            if hit:
                return hit[1]
            raise
        with _LOCK:
            _CACHE[key] = (time.time(), value)
        return value


def _get(url: str, **params: Any) -> requests.Response:
    r = _SESSION.get(url, params=params or None, timeout=_TIMEOUT)
    r.raise_for_status()
    return r


def _gz(url: str) -> bytes:
    body = _get(url).content
    return gzip.decompress(body) if body[:2] == b"\x1f\x8b" else body


def _json(url: str, **params: Any) -> Any:
    r = _get(url, **params)
    return r.json() if r.content.strip() else []


def _num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _unix(v: Any) -> Optional[int]:
    """An AWC time -- ISO 8601 or already seconds -- as unix seconds."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Flight category
# ---------------------------------------------------------------------------
def visibility(v: Any) -> Optional[float]:
    """Statute miles: '10+' and '6+' are 10 and 6, '1 1/2' and '3/4' are read."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().rstrip("+").replace("SM", "").strip()
    total = 0.0
    try:
        for part in s.split():
            if "/" in part:
                a, b = part.split("/", 1)
                total += float(a) / float(b)
            else:
                total += float(part)
    except (ValueError, ZeroDivisionError):
        return None
    return total


_CEILING_COVERS = ("BKN", "OVC", "OVX", "VV")


def ceiling(clouds: list[dict], vert_vis: Any = None) -> Optional[float]:
    """The lowest broken or overcast layer, or the vertical visibility, in feet."""
    bases = [c.get("base") for c in clouds if str(c.get("cover", "")).upper() in _CEILING_COVERS]
    bases = [b for b in (_num(b) for b in bases) if b is not None]
    vv = _num(vert_vis)
    if vv is not None:
        bases.append(vv)
    return min(bases) if bases else None


def category(ceil_ft: Optional[float], vis_sm: Optional[float]) -> Optional[str]:
    """VFR, MVFR, IFR or LIFR, by the FAA's limits: the worse of ceiling and
    visibility decides."""
    if ceil_ft is None and vis_sm is None:
        return None
    c = math.inf if ceil_ft is None else ceil_ft
    v = math.inf if vis_sm is None else vis_sm
    if c < 500 or v < 1:
        return "LIFR"
    if c < 1000 or v < 3:
        return "IFR"
    if c <= 3000 or v <= 5:
        return "MVFR"
    return "VFR"


_RANK = {"VFR": 0, "MVFR": 1, "IFR": 2, "LIFR": 3}


def worse(a: Optional[str], b: Optional[str]) -> Optional[str]:
    if a is None:
        return b
    if b is None:
        return a
    return a if _RANK[a] >= _RANK[b] else b


# ---------------------------------------------------------------------------
# METARs
# ---------------------------------------------------------------------------
def metars() -> dict:
    """Every airport's newest METAR, worldwide, as points with their category."""
    def make() -> dict:
        import surface_obs  # noqa: PLC0415 - its bulk reader, shared with the station plots
        feats = []
        for m in surface_obs._bulk_metars():  # noqa: SLF001
            lat, lon = _num(m.get("lat")), _num(m.get("lon"))
            if lat is None or lon is None or not m.get("icaoId"):
                continue
            clouds = [c for c in m.get("clouds") or [] if c.get("cover")]
            vis = visibility(m.get("visib"))
            ceil = ceiling(clouds)
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": m["icaoId"],
                    "cat": category(ceil, vis),
                    "ceil": ceil,
                    "vis": vis,
                    "wdir": m.get("wdir"),
                    "wspd": _num(m.get("wspd")),
                    "wgst": _num(m.get("wgst")),
                    "temp": _num(m.get("temp")),
                    "dewp": _num(m.get("dewp")),
                    "altim": _num(m.get("altim")),
                    "wx": m.get("wxString"),
                    "cover": clouds[-1]["cover"] if clouds else None,
                    "obs": m.get("obsTime"),
                    "raw": m.get("rawOb"),
                },
            })
        return {"type": "FeatureCollection", "features": feats}
    return _cached("metars", 120.0, make)


def metar_history(icao: str, hours: float) -> list[dict]:
    """One airport's METARs over the last `hours` (the AWC keeps about 15 days),
    oldest first, with each one's category worked out."""
    hours = max(1.0, min(float(hours), 360.0))

    def make() -> list[dict]:
        rows = _json(f"{AWC}/api/data/metar", ids=icao, hours=hours, format="json")
        out = []
        for r in rows if isinstance(rows, list) else []:
            clouds = [{"cover": c.get("cover"), "base": _num(c.get("base"))} for c in r.get("clouds") or []
                      if c.get("cover")]
            vis = visibility(r.get("visib"))
            ceil = ceiling(clouds, r.get("vertVis"))
            out.append({
                "t": _unix(r.get("obsTime")),
                "type": r.get("metarType"),
                "temp": _num(r.get("temp")), "dewp": _num(r.get("dewp")),
                "wdir": r.get("wdir"), "wspd": _num(r.get("wspd")), "wgst": _num(r.get("wgst")),
                "vis": vis, "visRaw": r.get("visib"), "altim": _num(r.get("altim")), "slp": _num(r.get("slp")),
                "clouds": clouds, "ceil": ceil, "cat": category(ceil, vis),
                "wx": r.get("wxString"), "precip": _num(r.get("precip")),
                "pcp3": _num(r.get("pcp3hr")), "pcp6": _num(r.get("pcp6hr")),
                "maxT": _num(r.get("maxT")), "minT": _num(r.get("minT")),
                "presTend": _num(r.get("presTend")), "pcp24": _num(r.get("pcp24hr")), "snow": _num(r.get("snow")),
                "vv": _num(r.get("vertVis")), "maxT24": _num(r.get("maxT24")), "minT24": _num(r.get("minT24")),
                "raw": r.get("rawOb"),
            })
        out = [o for o in out if o["t"] is not None]
        out.sort(key=lambda o: o["t"])
        return out
    return _cached(f"metar:{icao}:{hours}", 120.0, make)


# ---------------------------------------------------------------------------
# TAFs
# ---------------------------------------------------------------------------
def _period(p: dict) -> dict:
    """One TAF group, in the same shape whether read from the XML or the JSON."""
    clouds = p.get("clouds") or []
    vis = visibility(p.get("visib"))
    ceil = ceiling(clouds, p.get("vertVis"))
    return {
        "from": p.get("from"), "to": p.get("to"), "bec": p.get("bec"),
        "change": (p.get("change") or "").upper() or None,
        "prob": p.get("prob"),
        "wdir": p.get("wdir"), "wspd": _num(p.get("wspd")), "wgst": _num(p.get("wgst")),
        "vis": vis, "visRaw": p.get("visib"), "wx": p.get("wx") or None,
        "clouds": clouds, "vv": _num(p.get("vertVis")), "ceil": ceil,
        "shear": p.get("shear"), "altim": _num(p.get("altim")), "icgTurb": p.get("icgTurb") or [],
        "notDecoded": p.get("notDecoded") or None,
        "cat": category(ceil, vis) if (ceil is not None or vis is not None) else None,
    }


_KEYS = ("wdir", "wspd", "wgst", "vis", "visRaw", "wx", "clouds", "vv", "ceil", "shear", "altim", "icgTurb")


def timeline(periods: list[dict], valid_to: Optional[int]) -> dict:
    """What a TAF says prevails, segment by segment, and what it says may come
    and go over it.

    The opening group and each FM replace everything from their start; a BECMG
    changes only what it names, from the end of its transition; TEMPO and PROB
    groups are temporary and do not change what prevails.
    """
    base = [p for p in periods if p["change"] in (None, "FM") and not p["prob"]]
    becmg = [p for p in periods if p["change"] == "BECMG"]
    temp = [p for p in periods if p["change"] in ("TEMPO", "PROB") or (p["change"] or "").startswith("PROB")]
    for p in periods:
        if p["prob"] and p not in temp:
            temp.append(p)

    edges = sorted({t for p in base for t in (p["from"],) if t is not None}
                   | {p.get("bec") or p["to"] for p in becmg if (p.get("bec") or p["to"]) is not None})
    end = valid_to or max((p["to"] or 0 for p in periods), default=0)
    segs = []
    for i, start in enumerate(edges):
        stop = edges[i + 1] if i + 1 < len(edges) else end
        if stop is None or stop <= start:
            continue
        owner = max((p for p in base if p["from"] is not None and p["from"] <= start), key=lambda p: p["from"],
                    default=None)
        if owner is None:
            continue
        state = {k: owner.get(k) for k in _KEYS}
        for b in sorted(becmg, key=lambda p: p.get("bec") or p["to"] or 0):
            at = b.get("bec") or b["to"]
            if at is not None and owner["from"] <= (b["from"] or 0) and at <= start:
                for k in _KEYS:
                    if b.get(k) not in (None, [], ""):
                        state[k] = b[k]
                # New clouds are a new ceiling, even one that is no longer there.
                if b.get("clouds") or b.get("vv") is not None:
                    state["ceil"] = b.get("ceil")
        cat = category(state["ceil"], state["vis"])
        segs.append({"from": start, "to": stop, **state, "cat": cat})
    temps = []
    for p in temp:
        kind = "TEMPO" if p["change"] == "TEMPO" and not p["prob"] else (
            f"PROB{int(p['prob'])}{' TEMPO' if p['change'] == 'TEMPO' else ''}" if p["prob"] else p["change"])
        temps.append({**{k: p.get(k) for k in _KEYS}, "from": p["from"], "to": p["to"], "kind": kind,
                      "cat": p["cat"]})
    return {"segments": segs, "temporary": temps}


def _xml_period(f: ET.Element) -> dict:
    t = lambda tag: f.findtext(tag)  # noqa: E731
    clouds = [{"cover": s.get("sky_cover"), "base": _num(s.get("cloud_base_ft_agl")), "type": s.get("cloud_type")}
              for s in f.findall("sky_condition") if s.get("sky_cover")]
    prob = _num(t("probability"))
    shear = None
    if t("wind_shear_hgt_ft_agl"):
        shear = {"hgt": _num(t("wind_shear_hgt_ft_agl")), "dir": _num(t("wind_shear_dir_degrees")),
                 "spd": _num(t("wind_shear_speed_kt"))}
    return _period({
        "from": _unix(t("fcst_time_from")), "to": _unix(t("fcst_time_to")), "bec": _unix(t("time_becoming")),
        "change": t("change_indicator"), "prob": prob,
        "wdir": t("wind_dir_degrees"), "wspd": t("wind_speed_kt"), "wgst": t("wind_gust_kt"),
        "visib": t("visibility_statute_mi"), "wx": t("wx_string"), "clouds": clouds,
        "vertVis": t("vert_vis_ft"), "shear": shear,
    })


def _bulk_tafs() -> dict[str, dict]:
    """Every TAF in force, by station: its periods and its timeline."""
    def make() -> dict[str, dict]:
        root = ET.fromstring(_gz(f"{AWC}/data/cache/tafs.cache.xml.gz"))
        out: dict[str, dict] = {}
        for taf in root.iter("TAF"):
            sid = taf.findtext("station_id")
            lat, lon = _num(taf.findtext("latitude")), _num(taf.findtext("longitude"))
            if not sid or lat is None or lon is None:
                continue
            periods = [_xml_period(f) for f in taf.findall("forecast")]
            valid_to = _unix(taf.findtext("valid_time_to"))
            issue = _unix(taf.findtext("issue_time"))
            have = out.get(sid)
            if have and (have["issue"] or 0) >= (issue or 0):
                continue
            out[sid] = {
                "id": sid, "lat": lat, "lon": lon, "issue": issue,
                "from": _unix(taf.findtext("valid_time_from")), "to": valid_to,
                "raw": taf.findtext("raw_text"), **timeline(periods, valid_to),
            }
        return out
    return _cached("tafs", 600.0, make)


def _at(tl: dict, t: int) -> tuple[Optional[dict], list[dict]]:
    seg = next((s for s in tl["segments"] if s["from"] <= t < s["to"]), None)
    temps = [p for p in tl["temporary"] if p["from"] is not None and p["to"] is not None and p["from"] <= t < p["to"]]
    return seg, temps


def taf_points(at: Optional[int] = None) -> dict:
    """Each TAF's forecast at the instant `at` (now when left out): what
    prevails, and the worst a TEMPO or PROB group then allows."""
    t = int(at or time.time())

    def make() -> dict:
        feats = []
        for taf in _bulk_tafs().values():
            seg, temps = _at(taf, t)
            if seg is None:
                continue
            worst = seg["cat"]
            for p in temps:
                worst = worse(worst, p["cat"])
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [taf["lon"], taf["lat"]]},
                "properties": {
                    "id": taf["id"], "cat": seg["cat"], "worst": worst,
                    "temp": ",".join(p["kind"] for p in temps) or None,
                    "ceil": seg["ceil"], "vis": seg["vis"], "wdir": seg["wdir"], "wspd": seg["wspd"],
                    "wgst": seg["wgst"], "wx": seg["wx"], "issue": taf["issue"], "raw": taf["raw"],
                },
            })
        return {"type": "FeatureCollection", "features": feats, "at": t}
    return _cached(f"tafat:{t // 900}", 600.0, make)


def taf(icao: str) -> Optional[dict]:
    """One airport's TAF in force, decoded, with its timeline."""
    def make() -> Optional[dict]:
        rows = _json(f"{AWC}/api/data/taf", ids=icao, format="json")
        rows = [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
        if not rows:
            return None
        r = max(rows, key=lambda x: _unix(x.get("issueTime")) or 0)
        periods, temps = [], []
        for f in r.get("fcsts") or []:
            clouds = [{"cover": c.get("cover"), "base": _num(c.get("base")), "type": c.get("type")}
                      for c in f.get("clouds") or [] if c.get("cover")]
            shear = ({"hgt": _num(f.get("wshearHgt")), "dir": _num(f.get("wshearDir")),
                      "spd": _num(f.get("wshearSpd"))} if f.get("wshearHgt") else None)
            periods.append(_period({
                "from": _unix(f.get("timeFrom")), "to": _unix(f.get("timeTo")), "bec": _unix(f.get("timeBec")),
                "change": f.get("fcstChange"), "prob": _num(f.get("probability")),
                "wdir": f.get("wdir"), "wspd": f.get("wspd"), "wgst": f.get("wgst"),
                "visib": f.get("visib"), "wx": f.get("wxString"), "clouds": clouds,
                "vertVis": f.get("vertVis"), "shear": shear, "altim": f.get("altim"),
                "icgTurb": [{"kind": "ice" if str(g.get("var", "")).upper().startswith("IC") else "turb",
                             "intensity": g.get("intensity"), "lo": _num(g.get("minAlt")), "hi": _num(g.get("maxAlt"))}
                            for g in f.get("icgTurb") or []],
                "notDecoded": f.get("notDecoded"),
            }))
            for t in f.get("temp") or []:
                temps.append({"t": _unix(t.get("validTime")), "temp": _num(t.get("surfaceTemp")),
                              "kind": str(t.get("maxOrMin") or "").upper() or None})
        valid_to = _unix(r.get("validTimeTo"))
        return {
            "id": r.get("icaoId"), "issue": _unix(r.get("issueTime")), "from": _unix(r.get("validTimeFrom")),
            "to": valid_to, "raw": r.get("rawTAF"), "remarks": r.get("remarks"),
            "temps": sorted((t for t in temps if t["t"] is not None), key=lambda t: t["t"]),
            "periods": periods, **timeline(periods, valid_to),
        }
    return _cached(f"taf:{icao}", 300.0, make)


# ---------------------------------------------------------------------------
# PIREPs
# ---------------------------------------------------------------------------
_TURB = ["NEG", "SMTH-LGT", "SMTH", "LGT", "LGT-MOD", "MOD", "MOD-SEV", "SEV", "SEV-EXTM", "EXTM"]
_ICE = ["NEG", "NEGclr", "TRC", "TRC-LGT", "LGT", "LGT-MOD", "MOD", "MOD-SEV", "SEV", "HVY"]


def _level(value: str, scale: list[str]) -> int:
    """0 none, 1 light, 2 moderate, 3 severe, 4 extreme."""
    v = (value or "").upper()
    if not v or v.startswith("NEG") or v == "SMTH":
        return 0
    if "EXTM" in v:
        return 4
    if "SEV" in v or v == "HVY":
        return 3
    if "MOD" in v:
        return 2
    return 1


def pireps() -> dict:
    """Every pilot report and AIREP of the last hours, worldwide."""
    def make() -> dict:
        text = _gz(f"{AWC}/data/cache/aircraftreports.cache.csv.gz").decode("utf-8", "replace")
        lines = text.splitlines()
        start = next((i for i, l in enumerate(lines) if l.startswith("receipt_time")), None)
        if start is None:
            return {"type": "FeatureCollection", "features": []}
        reader = csv.reader(io.StringIO("\n".join(lines[start:])))
        head = next(reader)
        feats = []
        for r in reader:
            if len(r) < len(head) // 2:
                continue
            cols: dict[str, list[str]] = {}
            for k, v in zip(head, r):
                cols.setdefault(k, []).append(v)
            one = lambda k, i=0: (cols.get(k) or [""])[i] if len(cols.get(k) or []) > i else ""  # noqa: E731
            lat, lon = _num(one("latitude")), _num(one("longitude"))
            if lat is None or lon is None:
                continue
            turbs = [{"int": one("turbulence_intensity", i), "type": one("turbulence_type", i),
                      "base": _num(one("turbulence_base_ft_msl", i)), "top": _num(one("turbulence_top_ft_msl", i)),
                      "freq": one("turbulence_freq", i)} for i in range(2) if one("turbulence_intensity", i)]
            ices = [{"int": one("icing_intensity", i), "type": one("icing_type", i),
                     "base": _num(one("icing_base_ft_msl", i)), "top": _num(one("icing_top_ft_msl", i))}
                    for i in range(2) if one("icing_intensity", i)]
            skies = [{"cover": one("sky_cover", i), "base": _num(one("cloud_base_ft_msl", i)),
                      "top": _num(one("cloud_top_ft_msl", i))} for i in range(2) if one("sky_cover", i)]
            turb = max((_level(t["int"], _TURB) for t in turbs), default=-1)
            ice = max((_level(c["int"], _ICE) for c in ices), default=-1)
            raw = one("raw_text")
            kind = "turb" if turb >= 0 and turb >= ice else "ice" if ice >= 0 else "other"
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "type": one("report_type") or "PIREP",
                    "urgent": raw.startswith("UUA") or " UUA " in raw[:12],
                    "t": _unix(one("observation_time")),
                    "alt": _num(one("altitude_ft_msl")),
                    "ac": one("aircraft_ref") or None,
                    "kind": kind, "turb": turb, "ice": ice,
                    "level": max(turb, ice),
                    "turbs": turbs, "ices": ices, "skies": skies,
                    "wx": one("wx_string") or None, "vis": _num(one("visibility_statute_mi")),
                    "temp": _num(one("temp_c")), "wdir": _num(one("wind_dir_degrees")),
                    "wspd": _num(one("wind_speed_kt")), "raw": raw,
                },
            })
        return {"type": "FeatureCollection", "features": feats}
    return _cached("pireps", 120.0, make)


# ---------------------------------------------------------------------------
# Advisories: SIGMETs, G-AIRMETs, CWAs, TCF, TFRs
# ---------------------------------------------------------------------------
def _fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": [f for f in features if f.get("geometry")]}



def sigmets() -> dict:
    """US SIGMETs (convective ones included) and international SIGMETs."""
    def make() -> dict:
        out = []
        us = _json(f"{AWC}/api/data/airsigmet", format="geojson")
        for f in (us or {}).get("features", []):
            p = f.get("properties") or {}
            conv = str(p.get("hazard", "")).upper() == "CONVECTIVE"
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "kind": "convective" if conv else ("airmet" if p.get("airSigmetType") == "AIRMET" else "sigmet"),
                "region": "US", "id": f"{p.get('icaoId')}-{p.get('seriesId') or p.get('alphaChar')}",
                "series": p.get("seriesId"), "hazard": str(p.get("hazard", "")).upper(),
                "issuer": p.get("icaoId"), "from": _unix(p.get("validTimeFrom")), "to": _unix(p.get("validTimeTo")),
                "lo": _num(p.get("altitudeLow1")), "hi": _num(p.get("altitudeHi1")),
                "severity": p.get("severity"), "dir": p.get("movementDir"), "spd": p.get("movementSpd"),
                "raw": p.get("rawAirSigmet"),
            }})
        intl = _json(f"{AWC}/api/data/isigmet", format="geojson")
        for f in (intl or {}).get("features", []):
            p = f.get("properties") or {}
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "kind": "intl", "region": p.get("firId"), "id": f"{p.get('firId')}-{p.get('seriesId')}",
                "series": p.get("seriesId"), "hazard": str(p.get("hazard", "")).upper(),
                "qualifier": p.get("qualifier"), "issuer": p.get("icaoId"), "fir": p.get("firName"),
                "from": _unix(p.get("validTimeFrom")), "to": _unix(p.get("validTimeTo")),
                "lo": _num(p.get("base")), "hi": _num(p.get("top")),
                "dir": p.get("dir"), "spd": p.get("spd"), "chng": p.get("chng"), "raw": p.get("rawSigmet"),
            }})
        return _fc(out)
    return _cached("sigmets", 180.0, make)


def gairmets() -> dict:
    """The G-AIRMETs (Sierra, Tango, Zulu) for every forecast hour, 0 to 12."""
    def make() -> dict:
        out = []
        for fore in (0, 3, 6, 9, 12):
            g = _json(f"{AWC}/api/data/gairmet", format="geojson", fore=fore)
            for f in (g or {}).get("features", []):
                p = f.get("properties") or {}
                out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                    "product": p.get("product"), "hazard": str(p.get("hazard", "")).upper(), "tag": p.get("tag"),
                    "fore": int(_num(p.get("forecast")) or fore), "valid": _unix(p.get("validTime")),
                    "issue": _unix(p.get("issueTime")), "severity": p.get("severity"),
                    "top": p.get("top"), "base": p.get("base"), "level": p.get("level"),
                    "dueTo": p.get("dueTo"),
                }})
        return _fc(out)
    return _cached("gairmets", 600.0, make)


def cwas() -> dict:
    def make() -> dict:
        g = _json(f"{AWC}/api/data/cwa", format="geojson")
        out = []
        for f in (g or {}).get("features", []):
            p = f.get("properties") or {}
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "cwsu": p.get("cwsu"), "name": p.get("name"), "series": p.get("seriesId"),
                "hazard": str(p.get("hazard", "")).upper(), "qualifier": p.get("qualifier"),
                "from": _unix(p.get("validTimeFrom")), "to": _unix(p.get("validTimeTo")),
                "lo": _num(p.get("base")), "hi": _num(p.get("top")), "raw": p.get("cwaText"),
            }})
        return _fc(out)
    return _cached("cwas", 180.0, make)


def tcf() -> dict:
    def make() -> dict:
        g = _json(f"{AWC}/api/data/tcf", format="geojson")
        out = []
        for f in (g or {}).get("features", []):
            p = f.get("properties") or {}
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "valid": _unix(p.get("validTime")), "issue": _unix(p.get("issueTime")),
                "coverage": p.get("coverage"), "confidence": p.get("confidence"), "tops": p.get("tops"),
            }})
        return _fc(out)
    return _cached("tcf", 600.0, make)


def tfrs() -> dict:
    """The FAA's TFRs with their shapes, and the list's words for each."""
    def make() -> dict:
        listing = {}
        try:
            for t in _json(TFR_LIST) or []:
                listing[str(t.get("notam_id"))] = t
        except requests.RequestException:
            pass
        shapes = _json(TFR_SHAPES)
        out = []
        for f in (shapes or {}).get("features", []):
            p = f.get("properties") or {}
            key = str(p.get("NOTAM_KEY") or "")
            nid = key.split("-", 1)[0]
            info = listing.get(nid, {})
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "id": nid, "title": p.get("TITLE"), "state": p.get("STATE") or info.get("state"),
                "facility": p.get("CNS_LOCATION_ID") or info.get("facility"),
                "type": info.get("type") or p.get("LEGAL"), "legal": p.get("LEGAL"),
                "description": info.get("description") or p.get("TITLE"),
                "modified": p.get("LAST_MODIFICATION_DATETIME"),
            }})
        return _fc(out)
    return _cached("tfrs", 900.0, make)


# ---------------------------------------------------------------------------
# Airspace (the FAA's ADDS service): classes B, C and D, special use, ARTCCs
# ---------------------------------------------------------------------------
_FAA = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
_AIRSPACE = {
    "class": ("Class_Airspace", "CLASS IN ('B','C','D')",
              ("CLASS", "NAME", "IDENT", "ICAO_ID", "LOCAL_TYPE")),
    "sua": ("Special_Use_Airspace", "1=1", ("NAME", "TYPE_CODE", "CITY", "STATE", "TIMESOFUSE", "CONT_AGENT")),
    "artcc": ("Boundary_Airspace", "TYPE_CODE='ARTCC' AND LEVEL_='L'", ("NAME", "IDENT")),
}
_LIMITS = ("UPPER_VAL", "UPPER_UOM", "UPPER_CODE", "LOWER_VAL", "LOWER_UOM", "LOWER_CODE")


def airspace(kind: str) -> dict:
    """US airspace outlines, a day at a time: they change with the 56-day cycle."""
    if kind not in _AIRSPACE:
        raise ValueError(f"Unknown airspace {kind}")
    service, where, fields = _AIRSPACE[kind]

    path = _DISK / f"airspace-{kind}.json"

    def make() -> dict:
        # Kept on disk as well: the class outlines are a minute's download.
        try:
            if time.time() - path.stat().st_mtime < 86400:
                return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        out, offset = [], 0
        while True:
            page = _json(f"{_FAA}/{service}/FeatureServer/0/query", where=where, outFields="*",
                         outSR=4326, maxAllowableOffset=0.001, geometryPrecision=4, resultOffset=offset,
                         resultRecordCount=1000, f="geojson")
            feats = (page or {}).get("features", [])
            for f in feats:
                p = f.get("properties") or {}
                keep = {k.lower(): p.get(k) for k in fields + _LIMITS if k in p}
                out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": keep})
            if len(feats) < 1000 or not (page or {}).get("properties", {}).get("exceededTransferLimit", True):
                break
            offset += 1000
        fc = _fc(out)
        try:
            _DISK.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(fc), encoding="utf-8")
        except OSError:
            pass
        return fc
    return _cached(f"airspace:{kind}", 86400.0, make)


# ---------------------------------------------------------------------------
# Winds and temperatures aloft (FB)
# ---------------------------------------------------------------------------
def _stations() -> dict[str, dict]:
    """The AWC's station list, by every id it goes by (ICAO, FAA, IATA)."""
    def make() -> dict[str, dict]:
        rows = json.loads(_gz(f"{AWC}/data/cache/stations.cache.json.gz"))
        out: dict[str, dict] = {}
        for s in rows:
            lat, lon = _num(s.get("lat")), _num(s.get("lon"))
            if lat is None or lon is None:
                continue
            for k in ("faaId", "iataId", "icaoId"):
                v = s.get(k)
                if v and v not in out:
                    out[v] = s
        return out
    return _cached("stations", 86400.0, make)


def _fb_group(g: str, level: int) -> Optional[dict]:
    """'2735+05' or '731960' or '9900' -> direction, speed (kt) and temperature (C)."""
    g = g.strip()
    if not g or not g[:4].isdigit():
        return None
    d, s = int(g[:2]), int(g[2:4])
    temp: Optional[float] = None
    rest = g[4:]
    if rest:
        try:
            temp = float(rest) if rest[0] in "+-" else -float(rest)
        except ValueError:
            temp = None
    if d == 99 and s == 0:
        return {"dir": None, "spd": 0, "temp": temp, "lv": True}
    if d > 36:  # 100 kt and more: 50 added to the direction
        d -= 50
        s += 100
    return {"dir": d * 10, "spd": s, "temp": temp, "lv": False}


def winds_aloft(level: str = "low", fcst: str = "06") -> dict:
    """The FB forecast for every station of a cycle, decoded onto its station."""
    level = "high" if level == "high" else "low"
    fcst = fcst if fcst in ("06", "12", "24") else "06"

    def make() -> dict:
        text = _get(f"{AWC}/api/data/windtemp", region="all", level=level, fcst=fcst).text
        stations = _stations()
        feats, meta, heights = [], {}, []
        for line in text.splitlines():
            m = re.match(r"\s*VALID\s+(\d{6})Z\s+FOR USE\s+(\d{4})-(\d{4})Z", line)
            if m:
                meta = {"valid": m.group(1), "use": f"{m.group(2)}-{m.group(3)}Z"}
                continue
            if line.startswith("FT"):
                heights = [int(h) for h in line.split()[1:]]
                cols = [m.start() for m in re.finditer(r"\d+", line)]
                continue
            if not heights or not re.match(r"^[A-Z0-9]{3}\s", line):
                continue
            sid = line[:3]
            # Columns end where each height's label ends; a group may be blank.
            groups = []
            for i, h in enumerate(heights):
                end = cols[i] + len(str(h))
                start = end - (4 if h == 3000 else 7)
                groups.append(line[max(start, 4):end].strip() if len(line) > start else "")
            s = stations.get(sid) or stations.get("K" + sid) or stations.get("P" + sid)
            if s is None:
                continue
            lv = {}
            for h, g in zip(heights, groups):
                got = _fb_group(g, h)
                if got:
                    lv[str(h)] = got
            feats.append({"type": "Feature",
                          "geometry": {"type": "Point", "coordinates": [_num(s["lon"]), _num(s["lat"])]},
                          "properties": {"id": sid, "name": s.get("site"), "levels": lv}})
        return {"type": "FeatureCollection", "features": feats, "heights": heights, "level": level,
                "fcst": fcst, **meta}
    return _cached(f"fb:{level}:{fcst}", 1800.0, make)


# ---------------------------------------------------------------------------
# One airport
# ---------------------------------------------------------------------------
def _contains(geom: dict, lon: float, lat: float) -> bool:
    def ring_has(ring: list) -> bool:
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i][0], ring[i][1]
            xj, yj = ring[j][0], ring[j][1]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
                inside = not inside
            j = i
        return inside
    t = (geom or {}).get("type")
    if t == "Polygon":
        rings = geom["coordinates"]
        return bool(rings) and ring_has(rings[0]) and not any(ring_has(h) for h in rings[1:])
    if t == "MultiPolygon":
        return any(_contains({"type": "Polygon", "coordinates": p}, lon, lat) for p in geom["coordinates"])
    return False


def _nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    return 3440.065 * 2 * math.asin(math.sqrt(min(1.0, a)))


def _runways(rows: list[dict], magdec: Optional[str]) -> list[dict]:
    """Each runway with both ends' true headings: the runway number is magnetic,
    and the airport's declination turns it to true (the wind's frame)."""
    dec = 0.0
    if magdec:
        m = re.match(r"(\d+)([EW])", str(magdec))
        if m:
            dec = float(m.group(1)) * (1 if m.group(2) == "E" else -1)
    out = []
    for r in rows or []:
        ends = []
        for name in str(r.get("id", "")).split("/"):
            m = re.match(r"(\d{1,2})([LRC]?)", name)
            if not m:
                continue
            mag = int(m.group(1)) * 10
            ends.append({"name": name, "mag": mag, "true": (mag + dec) % 360})
        length = width = None
        if r.get("dimension"):
            dims = str(r["dimension"]).split("x")
            length = _num(dims[0])
            width = _num(dims[1]) if len(dims) > 1 else None
        out.append({"id": r.get("id"), "ends": ends, "length": length, "width": width, "surface": r.get("surface"),
                    "alignment": _num(r.get("alignment"))})
    return out


def _freqs(text: Any) -> list[dict]:
    out = []
    for part in str(text or "").split(";"):
        if "," in part:
            name, mhz = part.rsplit(",", 1)
            out.append({"name": name.strip(), "mhz": mhz.strip()})
    return out


def _declination(magdec: Any) -> Optional[float]:
    """'21W' -> -21, '8E' -> 8, '0' -> 0 (east positive)."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([EW]?)\s*$", str(magdec or ""))
    if not m:
        return None
    return float(m.group(1)) * (-1.0 if m.group(2) == "W" else 1.0)


def _magdec_text(dec: Optional[float]) -> Optional[str]:
    if dec is None:
        return None
    return "0" if abs(dec) < 0.5 else f"{abs(dec):.0f}{'E' if dec > 0 else 'W'}"


def airport_info(icao: str) -> Optional[dict]:
    """One airport: OurAirports' record (any country, runways placed and true,
    every frequency) with what the AWC adds -- its tower, its traffic, the
    official declination -- or the AWC's alone where OurAirports has nothing."""
    def make() -> Optional[dict]:
        import aviation_world as world  # noqa: PLC0415 - it imports this module
        try:
            rows = _json(f"{AWC}/api/data/airport", ids=icao, format="json")
        except (requests.RequestException, ValueError):
            rows = []
        a = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
        try:
            oa = world.lookup(icao)
        except Exception:  # noqa: BLE001 - OurAirports out of reach: the AWC's record alone
            oa = None
        if not a and not oa:
            s = _stations().get(icao)
            if not s:
                return None
            return {"icao": icao, "iata": s.get("iataId"), "faa": s.get("faaId"), "name": s.get("site"),
                    "lat": _num(s.get("lat")), "lon": _num(s.get("lon")), "elevFt": _num(s.get("elev")),
                    "state": s.get("state"), "country": s.get("country"), "runways": [], "freqs": [],
                    "magdec": None, "declination": None}
        dec = _declination(a.get("magdec")) if a else None
        dec_source = "AWC" if dec is not None else None
        if dec is None and oa:
            try:
                dec = world.declination_near(oa["lat"], oa["lon"])
                dec_source = "navaid" if dec is not None else None
            except Exception:  # noqa: BLE001
                dec = None
        if oa:
            out = world.info(oa, dec)
            out["state"] = (a or {}).get("state") or out.get("region")
        else:
            out = {"icao": a.get("icaoId") or icao, "iata": a.get("iataId"), "name": (a.get("name") or "").strip(),
                   "lat": _num(a.get("lat")), "lon": _num(a.get("lon")), "elevFt": _num(a.get("elev")),
                   "state": a.get("state"), "country": a.get("country"), "runways": [], "freqs": []}
        if a:
            out["faa"] = a.get("faaId")
            out["tower"] = a.get("tower") == "T"
            out["passengers"] = _num(a.get("passengers"))
            out["awcName"] = (a.get("name") or "").strip() or None
            if not out["runways"]:
                out["runways"] = _runways(a.get("runways") or [], a.get("magdec"))
            if not out["freqs"]:
                out["freqs"] = _freqs(a.get("freqs"))
        out["icao"] = icao
        out["magdec"] = _magdec_text(dec)
        out["declination"] = dec
        out["declinationSource"] = dec_source
        return out
    return _cached(f"apt:{icao}", 86400.0, make)


def airport(icao: str, hours: float = 24, model: str = "gfs") -> dict:
    """Everything about one airport's weather, for its page."""
    import aviation_world as world  # noqa: PLC0415 - it imports this module
    icao = icao.strip().upper()
    # Every source at once: one after another they were twenty seconds.
    jobs = {
        "info": lambda: airport_info(icao), "obs": lambda: metar_history(icao, hours), "taf": lambda: taf(icao),
        "pireps": pireps, "sigmets": sigmets, "gairmets": gairmets, "cwas": cwas, "tfrs": tfrs, "metars": metars,
        **{f"fb{lv}{h}": (lambda lv=lv, h=h: winds_aloft(lv, h))
           for lv, h in (("low", "06"), ("low", "12"), ("low", "24"), ("high", "06"))},
    }
    got: dict[str, Any] = {}
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=len(jobs) + 3) as pool:
        futures = {k: pool.submit(fn) for k, fn in jobs.items()}
        try:
            first = futures["info"].result()
        except Exception:  # noqa: BLE001
            first = None
        # What needs the airport's place starts as soon as it is known.
        if first is not None:
            lat0, lon0 = first["lat"], first["lon"]
            futures["profile"] = pool.submit(world.profile, lat0, lon0, first.get("elevFt"), model)
            futures["fir"] = pool.submit(world.fir_at, lat0, lon0)
            futures["navaids"] = pool.submit(world.navaids_near, lat0, lon0, 60.0, 14, first.get("declination"))
        for k, fut in futures.items():
            try:
                got[k] = fut.result()
            except Exception as e:  # noqa: BLE001 - a missing piece leaves its section empty
                got[k] = None
                errors[k] = str(e) or e.__class__.__name__
    info = got["info"]
    if info is None:
        raise ValueError(f"No airport {icao}")
    lat, lon = info["lat"], info["lon"]
    obs = got["obs"] or []
    forecast = got["taf"]
    now = time.time()

    near = []
    try:
        for f in (got["pireps"] or {"features": []})["features"]:
            p = f["properties"]
            plon, plat = f["geometry"]["coordinates"]
            d = _nm(lat, lon, plat, plon)
            if d <= 100 and p["t"] and now - p["t"] <= 6 * 3600:
                near.append({**p, "nm": round(d), "lat": plat, "lon": plon})
    except requests.RequestException:
        pass
    near.sort(key=lambda p: -(p["t"] or 0))

    over = []
    for kind, key in (("sigmet", "sigmets"), ("gairmet", "gairmets"), ("cwa", "cwas"), ("tfr", "tfrs")):
        fc = got[key]
        if not fc:
            continue
        for f in fc["features"]:
            p = f["properties"]
            if kind == "gairmet" and p.get("fore") != 0:
                continue
            if p.get("to") and p["to"] < now:
                continue
            if _contains(f.get("geometry") or {}, lon, lat):
                over.append({**p, "kind": kind, "sub": p.get("kind")})

    aloft = {}
    for lvl, fc_hr in (("low", "06"), ("low", "12"), ("low", "24"), ("high", "06")):
        fb = got[f"fb{lvl}{fc_hr}"]
        if not fb:
            continue
        best = min(fb["features"], key=lambda f: _nm(lat, lon, f["geometry"]["coordinates"][1],
                                                     f["geometry"]["coordinates"][0]), default=None)
        # The FB network is the US's: farther than this, it says nothing of here.
        if best and _nm(lat, lon, best["geometry"]["coordinates"][1], best["geometry"]["coordinates"][0]) <= 150:
            c = best["geometry"]["coordinates"]
            aloft[f"{lvl}{fc_hr}"] = {"id": best["properties"]["id"], "name": best["properties"].get("name"),
                                      "nm": round(_nm(lat, lon, c[1], c[0])), "levels": best["properties"]["levels"],
                                      "valid": fb.get("valid"), "use": fb.get("use")}

    nearby = []
    if got.get("metars"):
        try:
            by_id = {f["properties"]["id"]: f for f in got["metars"]["features"]}
            nearby = world.nearby_airports(lat, lon, 120.0, icao, by_id)
        except Exception as e:  # noqa: BLE001
            errors["nearby"] = str(e)

    return {"info": info, "metars": obs, "taf": forecast, "pireps": near[:60], "advisories": over,
            "aloft": aloft, "profile": got.get("profile"), "fir": got.get("fir"), "navaids": got.get("navaids") or [],
            "nearby": nearby, "hours": hours, "errors": errors}


def search(query: str, limit: int = 20) -> list[dict]:
    """Airports anywhere by code (ICAO, IATA, GPS, local) or by words of the
    name, town or country -- the ones that report weather first."""
    q = query.strip().upper()
    if not q:
        return []
    have = {f["properties"]["id"]: f for f in metars()["features"]}
    try:
        import aviation_world as world  # noqa: PLC0415
        hits = world.search(query, set(have), limit)
        for h in hits:
            m = have.get(h["icao"])
            h["cat"] = m["properties"]["cat"] if m else None
        return hits
    except Exception:  # noqa: BLE001 - OurAirports out of reach: the AWC's station list
        pass
    stations = _stations()
    out, seen = [], set()

    def add(s: dict) -> None:
        icao = s.get("icaoId")
        if not icao or icao in seen:
            return
        seen.add(icao)
        m = have.get(icao)
        out.append({"icao": icao, "iata": s.get("iataId"), "faa": s.get("faaId"), "name": s.get("site"),
                    "state": s.get("state"), "country": s.get("country"),
                    "lat": _num(s.get("lat")), "lon": _num(s.get("lon")),
                    "cat": m["properties"]["cat"] if m else None})

    for k in (q, "K" + q):
        if k in stations:
            add(stations[k])
    for s in {id(v): v for v in stations.values()}.values():
        if len(out) >= limit:
            break
        name = str(s.get("site") or "").upper()
        if q in name and s.get("icaoId") in have:
            add(s)
    return out[:limit]
