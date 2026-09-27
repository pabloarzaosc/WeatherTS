"""
The ASOS/AWOS station directory and one station's recent history.

The plots on the map come from the AWC METAR feed, which answers "what is being
reported inside this box right now". A station page needs the other two answers:
which stations exist at all -- with the state, county and WFO you would search
them by -- and what one of them has been doing for the last few days.

Both come from the Iowa Environmental Mesonet, public and key-free:
  * /geojson/network/{ST}_ASOS.geojson  -- the directory, one file per state
  * /cgi-bin/request/asos.py            -- the observations, every reported
    field including the raw METAR; /api/1/obhistory.json stands in for it when
    that service sheds load, which it does under its own weight.

The directory is the same for everyone and changes a few times a year, so it is
cached on disk; the observations are cached in memory for a few minutes, which
is shorter than a station's own reporting interval.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

IEM = "https://mesonet.agron.iastate.edu"

_HTTP_TIMEOUT = (8, 40)
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.5 (storm chasing app)"
_SESSION.mount(
    "https://",
    HTTPAdapter(
        pool_maxsize=16,
        max_retries=Retry(
            # 503 is in the list because the bulk service sheds load with one
            # ("ERROR: server over capacity") and usually answers a moment
            # later; without the retry every busy minute drops us to the
            # slower per-day fallback.
            # Two quick tries, not a long wait: the per-day fallback answers
            # in about a second and gives finer data, so it is not worth
            # sitting on a backoff for six.
            total=2, connect=2, read=1, backoff_factor=0.4,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
        ),
    ),
)

# The 50 states plus the territories IEM files separately. DC has no ASOS of its
# own -- National and Dulles are Virginia, BWI is Maryland.
NETWORKS = [
    f"{st}_ASOS"
    for st in (
        "AK AL AR AS AZ CA CO CT DE FL GA GU HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT "
        "NC ND NE NH NJ NM NV NY OH OK OR PA PR RI SC SD TN TX UT VA VI VT WA WI WV WY"
    ).split()
]

DIRECTORY_COLS = ["id", "name", "state", "county", "wfo", "lat", "lon", "elev", "network", "tz"]

_DIR_PATH = Path(tempfile.gettempdir()) / "weatherts-stations" / "directory.json"
_DIR_TTL = 3 * 24 * 3600.0
_dir_lock = threading.Lock()
_dir_cache: Optional[dict] = None

_SERIES_TTL = 240.0
_series_lock = threading.Lock()
_series_cache: dict[str, tuple[float, dict]] = {}


# ---------------------------------------------------------------- directory


def station_directory(force: bool = False) -> dict:
    """Every reporting ASOS/AWOS site, as compact rows rather than objects.

    2,600-odd stations as JSON objects is most of a megabyte of repeated key
    names; as rows it is a fifth of that, and the client searches it locally
    instead of asking us on every keystroke.
    """
    global _dir_cache
    now = time.time()
    with _dir_lock:
        if not force and _dir_cache and now - _dir_cache["updated"] < _DIR_TTL:
            return _dir_cache
        if not force:
            disk = _read_disk_directory()
            if disk and now - disk["updated"] < _DIR_TTL:
                _dir_cache = disk
                return disk

    rows: list[list[Any]] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for part in pool.map(_network_rows, NETWORKS):
            rows.extend(part)
    if not rows:
        # Nothing fetched: an out-of-date directory beats no directory at all.
        stale = _dir_cache or _read_disk_directory()
        if stale:
            return stale
        raise RuntimeError("station directory unavailable")

    rows.sort(key=lambda r: (r[2] or "", r[0] or ""))
    out = {"updated": now, "cols": DIRECTORY_COLS, "rows": rows}
    with _dir_lock:
        _dir_cache = out
    _write_disk_directory(out)
    return out


def _network_rows(network: str) -> list[list[Any]]:
    try:
        resp = _SESSION.get(f"{IEM}/geojson/network/{network}.geojson", timeout=_HTTP_TIMEOUT)
        resp.raise_for_status()
        features = resp.json().get("features") or []
    except Exception:  # noqa: BLE001 -- one missing state must not lose the rest
        return []

    out: list[list[Any]] = []
    for f in features:
        props = f.get("properties") or {}
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2 or props.get("archive_end") or props.get("online") is False:
            continue
        lon, lat = _num(coords[0]), _num(coords[1])
        sid = f.get("id") or props.get("sid")
        if lat is None or lon is None or not sid:
            continue
        out.append([
            str(sid),
            _title(props.get("sname"), str(sid)),
            (props.get("state") or "").strip(),
            (props.get("county") or "").strip(),
            props.get("wfo") or "",
            round(lat, 4),
            round(lon, 4),
            None if _num(props.get("elevation")) is None else round(float(props["elevation"])),
            network,
            props.get("tzname") or "",
        ])
    return out


def _title(name: Any, sid: str = "") -> str:
    """IEM names arrive shouted, underscored, or both: "ADA_MUNICIPAL_AIRPORT"."""
    s = str(name or "").replace("_", " ").strip()
    if not s:
        return ""
    if s.upper() != s:
        return s
    small = {"of", "the", "at", "in", "on", "and"}
    # The station's own id often appears in its name ("OKC - YUKON"), and so do
    # a handful of abbreviations that are read as letters, not as words.
    keep = {"AFB", "ANG", "AAF", "NAS", "AAP", "ARB", "US", "NE", "NW", "SE", "SW"}
    if sid:
        keep.add(sid.upper())

    def cap(match: "re.Match[str]") -> str:
        word = match.group(0)
        upper = word.upper()
        if upper in keep:
            return upper
        if word in small and match.start():
            return word
        return word[:1].upper() + word[1:]

    # Words are whatever runs of letters and digits the name has, so a slash or
    # a dash starts a new one: "OKLAHOMA CITY/WILEY POST" reads properly.
    return re.sub(r"[A-Za-z0-9]+", cap, s.lower())


def _read_disk_directory() -> Optional[dict]:
    try:
        data = json.loads(_DIR_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("rows"):
            return data
    except Exception:  # noqa: BLE001
        pass
    return None


def _write_disk_directory(data: dict) -> None:
    try:
        _DIR_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _DIR_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(_DIR_PATH)
    except Exception:  # noqa: BLE001 -- the cache is an optimisation, not a promise
        pass


# ------------------------------------------------------------------ history

# What we keep from a report, in the order a meteogram reads them.
SERIES_FIELDS = (
    "tmpf", "dwpf", "relh", "feel", "drct", "sknt", "gust", "vsby", "alti", "mslp", "p01i",
)


def _row_from_props(p: dict) -> dict:
    """A SYNOP or mesonet reading (station_networks' plot properties, metric)
    in the shape of an ASOS row: the charts read one kind of row."""
    def f(c):
        return None if c is None else c * 1.8 + 32
    altim = p.get("altim")
    rec = {
        "valid": float(p.get("obsTime") or 0),
        "tmpf": f(p.get("temp")),
        "dwpf": f(p.get("dewp")),
        "relh": p.get("rh"),
        "feel": None,
        "drct": p.get("wdir"),
        "sknt": p.get("wspd"),
        "gust": p.get("wgst"),
        "vsby": p.get("visib"),
        "alti": None if altim is None or p.get("kind") in ("synop", "inmet") else altim / 33.8638866667,
        "mslp": p.get("mslp"),
        "p01i": (p["precip"] / 25.4) if p.get("precip") is not None and p.get("precipHours") == 1 else None,
        "skies": [],
        "wx": p.get("wx"),
        "raw": None,
        "ceiling": None,
        "cover": p.get("cover"),
        "cat": None,
        # What these stations add over an airport's report.
        "precipMm": p.get("precip"),
        "precipHours": p.get("precipHours"),
        "tmaxC": p.get("tmax"),
        "tminC": p.get("tmin"),
        "extremesHours": p.get("extremesHours"),
        "oktas": p.get("oktas"),
        "cloudBaseM": p.get("cloudBase"),
        "synop": p.get("synop"),
    }
    return rec


def _network_series(station: str, hours: int, network: str) -> dict:
    """A SYNOP station's reports (OGIMET) or a mesonet station's (the MADIS
    hours this backend has read), as series rows."""
    import station_networks as sn  # noqa: PLC0415

    sid = station.strip()
    key = f"{network}:{sid}:{hours}"
    now = time.time()
    with _series_lock:
        hit = _series_cache.get(key)
        if hit and now - hit[0] < _SERIES_TTL:
            return hit[1]
    if network == "SYNOP":
        info = sn.wmo_stations().get(sid) or (0.0, 0.0, sid, "", None)
        rows = [_row_from_props(sn.synop_props(sid, r, info)) for r in sn.synop_history(sid, hours)]
        source = "synop"
    elif network == "INMET":
        rows = [_row_from_props(p) for p in sn.inmet_history(sid, hours)]
        source = "inmet"
    else:
        rows = [_row_from_props(p) for p in sn.madis_history(sid, hours)]
        source = "madis"
    out = {"station": sid, "hours": hours, "source": source, "updated": now, "observations": rows}
    with _series_lock:
        _series_cache[key] = (now, out)
    return out


def station_series(station: str, hours: int = 24, network: str = "") -> dict:
    """Normalised observations for one station, oldest first."""
    if network.upper() in ("SYNOP", "MESONET", "INMET"):
        return _network_series(station, max(6, min(int(hours), 168)), network.upper())
    sid = re.sub(r"[^A-Za-z0-9_]", "", station).upper()
    if not sid:
        raise ValueError("station required")
    hours = max(6, min(int(hours), 168))
    key = f"{sid}:{hours}:{network}"
    now = time.time()
    with _series_lock:
        hit = _series_cache.get(key)
        if hit and now - hit[0] < _SERIES_TTL:
            return hit[1]

    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    obs: list[dict] = []
    source = "asos"
    try:
        obs = _fetch_asos(sid, start, end)
    except Exception:  # noqa: BLE001
        obs = []
    if not obs and network:
        try:
            obs = _fetch_obhistory(sid, network, start, end)
            source = "obhistory"
        except Exception:  # noqa: BLE001
            obs = []

    out = {
        "station": sid,
        "hours": hours,
        "source": source,
        "updated": now,
        "observations": obs,
    }
    with _series_lock:
        _series_cache[key] = (now, out)
        if len(_series_cache) > 120:
            for old in sorted(_series_cache, key=lambda k: _series_cache[k][0])[:40]:
                _series_cache.pop(old, None)
    return out


def _fetch_asos(sid: str, start: datetime, end: datetime) -> list[dict]:
    params = [
        ("station", sid),
        ("data", "all"),
        ("tz", "UTC"),
        ("format", "onlycomma"),
        ("latlon", "no"),
        ("elev", "no"),
        ("missing", "empty"),
        ("trace", "0.0001"),
        ("direct", "no"),
        # Routine hourly reports and the specials in between: a station that
        # goes IFR mid-hour says so in a SPECI, and that is exactly the report
        # someone opening this page is looking for.
        ("report_type", "3"),
        ("report_type", "4"),
        ("sts", start.strftime("%Y-%m-%dT%H:%MZ")),
        ("ets", end.strftime("%Y-%m-%dT%H:%MZ")),
    ]
    resp = _SESSION.get(f"{IEM}/cgi-bin/request/asos.py", params=params, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    text = resp.text
    if text.startswith("ERROR") or "," not in text.split("\n", 1)[0]:
        raise RuntimeError(text.strip()[:120] or "empty response")

    out: list[dict] = []
    for row in csv.DictReader(io.StringIO(text)):
        valid = _parse_utc(row.get("valid"))
        if valid is None:
            continue
        rec = {"valid": valid}
        for field in SERIES_FIELDS:
            rec[field] = _num(row.get(field))
        rec["skies"] = _skies(row)
        rec["wx"] = (row.get("wxcodes") or "").strip() or None
        rec["raw"] = (row.get("metar") or "").strip() or None
        _derive(rec)
        out.append(rec)
    out.sort(key=lambda r: r["valid"])
    return out


def _fetch_obhistory(sid: str, network: str, start: datetime, end: datetime) -> list[dict]:
    """IEM's per-day JSON, used when the bulk service is shedding load."""
    out: list[dict] = []
    day = start.date()
    while day <= end.date():
        try:
            resp = _SESSION.get(
                f"{IEM}/api/1/obhistory.json",
                params={"network": network, "station": sid, "date": day.isoformat(), "full": "true"},
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            rows = resp.json().get("data") or []
        except Exception:  # noqa: BLE001
            rows = []
        for row in rows:
            valid = _parse_utc(row.get("utc_valid"))
            if valid is None or not (start.timestamp() <= valid <= end.timestamp()):
                continue
            rec = {"valid": valid}
            for field in SERIES_FIELDS:
                rec[field] = _num(row.get("phour" if field == "p01i" else field))
            rec["skies"] = _skies(row)
            rec["wx"] = (row.get("wxcodes") or "").strip() or None
            rec["raw"] = (row.get("raw") or "").strip() or None
            _derive(rec)
            out.append(rec)
        day += timedelta(days=1)
    out.sort(key=lambda r: r["valid"])
    return out


_COVER_RANK = {"CLR": 0, "SKC": 0, "NCD": 0, "NSC": 0, "FEW": 1, "SCT": 2, "BKN": 3, "OVC": 4, "VV": 5}


def _skies(row: dict) -> list[dict]:
    """The reported cloud layers, lowest first."""
    out = []
    for i in (1, 2, 3, 4):
        cover = (row.get(f"skyc{i}") or "").strip().upper()
        if not cover or cover in {"M", "///"}:
            continue
        out.append({"cover": cover, "base": _num(row.get(f"skyl{i}"))})
    out.sort(key=lambda c: (c["base"] is None, c["base"] or 0))
    return out


def _derive(rec: dict) -> None:
    """Ceiling, densest cover and flight category -- what the sky columns mean."""
    skies = rec.get("skies") or []
    ceiling = None
    for layer in skies:
        if layer["cover"] in {"BKN", "OVC", "VV"} and layer["base"] is not None:
            ceiling = layer["base"]
            break
    cover = None
    for layer in skies:
        if cover is None or _COVER_RANK.get(layer["cover"], 0) > _COVER_RANK.get(cover, 0):
            cover = layer["cover"]
    rec["ceiling"] = ceiling
    rec["cover"] = cover
    rec["cat"] = _flight_category(ceiling, rec.get("vsby"))


def _flight_category(ceiling: Optional[float], vis: Optional[float]) -> Optional[str]:
    if ceiling is None and vis is None:
        return None
    c = ceiling if ceiling is not None else 1e9
    v = vis if vis is not None else 1e9
    if c < 500 or v < 1:
        return "LIFR"
    if c < 1000 or v < 3:
        return "IFR"
    if c <= 3000 or v <= 5:
        return "MVFR"
    return "VFR"


def _parse_utc(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    text = str(value).strip().replace("Z", "+00:00")
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(text[:16], fmt).replace(tzinfo=timezone.utc).timestamp()
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def _num(value: Any) -> Optional[float]:
    if value in (None, "", "M", "T"):
        # A trace of rain is reported as "T"; asos.py already turns it into the
        # 0.0001 we asked for, so anything left here is genuinely missing.
        return 0.0 if value == "T" else None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None
