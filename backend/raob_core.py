"""
RAOB (observed radiosonde) soundings.

Fetches an observed upper-air profile for a station at a synoptic time, parses
it into the same level list the model path uses, and runs it through the SAME
SHARPpy computation + SPCWidget renderer so the viewer gets an identical payload
(just observed instead of forecast).

Data source: Iowa Environmental Mesonet (IEM) JSON RAOB archive, which serves
clean upper-air profiles for North America. The global station *dots* come from
a bundled IGRA-derived station list; stations outside IEM's coverage report
"no observed data" until a global source is wired in.
"""
from __future__ import annotations

import base64
import math
import re
import time
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import sounding_core  # reuse compute() + level cleaning conventions

IEM_URL = "https://mesonet.agron.iastate.edu/json/raob.py"
# University of Wyoming BUFR archive — GLOBAL coverage, keyed by WMO number.
# (src=BUFR is worldwide; src=UNIWYO is North America only.)
WYO_URL = "https://weather.uwyo.edu/wsgi/sounding"

# Recent synoptic times to expose on the timeline (00Z/12Z), newest last.
SYNOPTIC_WINDOW = 8  # 4 days of 00/12Z
MISSING = -9999.0
MS2KT = 1.9438445  # Wyoming reports wind speed in m/s; SHARPpy wants knots.

_HTTP_TIMEOUT = (8, 30)
_SESSION = requests.Session()
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=4, connect=4, read=3, backoff_factor=0.6,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
            respect_retry_after_header=True,
        )
    ),
)

_CACHE: dict[tuple, tuple[float, Optional[dict]]] = {}
_RESULT_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 600.0


class NetworkError(RuntimeError):
    """IEM was unreachable after retries (distinct from 'no data for station')."""


class NoObservationError(RuntimeError):
    """The station has no observed sounding available (e.g. outside coverage)."""


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------
def _recent_synoptic(now: Optional[datetime] = None) -> list[int]:
    """Unix times of the last SYNOPTIC_WINDOW 00Z/12Z slots, ascending."""
    now = now or datetime.now(timezone.utc)
    hour = 0 if now.hour < 12 else 12
    latest = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    times = [latest - timedelta(hours=12 * k) for k in range(SYNOPTIC_WINDOW)]
    return sorted(int(t.timestamp()) for t in times)


def _iso_z(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# IEM fetch + parse
# ---------------------------------------------------------------------------
def _fetch_iem(station: str, unix: int) -> Optional[dict]:
    """Return the raw IEM profile dict for a station+time, or None if absent."""
    key = (station.upper(), unix)
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    try:
        resp = _SESSION.get(
            IEM_URL,
            params={"ts": _iso_z(unix), "station": station},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException as exc:
        raise NetworkError(
            "Could not reach the RAOB data source after several tries - check the "
            "internet connection and try again."
        ) from exc
    if resp.status_code == 422:
        # IEM rejects the id form (e.g. a numeric-only international WMO id).
        _CACHE[key] = (now, None)
        return None
    try:
        data = resp.json()
    except ValueError:
        _CACHE[key] = (now, None)
        return None
    profiles = data.get("profiles") or []
    prof = profiles[0] if profiles else None
    _CACHE[key] = (now, prof)
    return prof


def _num(v) -> Optional[float]:
    try:
        if v is None:
            return None
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _levels_from_profile(prof: dict) -> list[dict]:
    """IEM profile rows -> surface->top level list (p,h,t,td,wd,ws)."""
    rows = prof.get("profile") or []
    levels: list[dict] = []
    for row in rows:
        p = _num(row.get("pres"))
        h = _num(row.get("hght"))
        t = _num(row.get("tmpc"))
        if p is None or h is None or t is None:
            continue
        td = _num(row.get("dwpc"))
        if td is None or td > t:
            td = t - 30.0  # upper-air dewpoint often missing -> mark very dry
        # RAOB reports wind only at mandatory + significant-wind levels; most
        # high-res levels have none. Marking those as MISSING (not 0/calm) makes
        # SHARPpy skip them, so the hodograph is a clean curve instead of a
        # starburst back to the origin at every windless level.
        wd = _num(row.get("drct"))
        ws = _num(row.get("sknt"))
        has_wind = wd is not None and ws is not None
        levels.append({
            "p": p, "h": h, "t": t, "td": td,
            "wd": wd if has_wind else MISSING,
            "ws": ws if has_wind else MISSING,
        })

    return _clean_levels(levels)


_THIN_DP = 5.0  # min hPa between kept levels (bounds SHARPpy render cost)


def _clean_levels(levels: list[dict]) -> list[dict]:
    """surface -> top, de-dupe, enforce monotonic height (same as the model path).
    High-res BUFR profiles (1000s of levels) are thinned to a ~5 hPa spacing so
    SHARPpy renders in ~1-2 s instead of ~20 s; the surface level always stays."""
    levels.sort(key=lambda d: -d["p"])
    cleaned: list[dict] = []
    for lv in levels:
        if cleaned and lv["p"] >= cleaned[-1]["p"]:
            continue
        if cleaned and lv["h"] <= cleaned[-1]["h"]:
            continue
        # keep the surface (first), then only levels >=_THIN_DP below the last kept
        if cleaned and (cleaned[-1]["p"] - lv["p"]) < _THIN_DP:
            continue
        cleaned.append(lv)
    return cleaned


def _parse_wyoming(html: str) -> list[dict]:
    """Parse a Wyoming BUFR TEXT:LIST <PRE> table into level dicts.
    Columns are fixed 7-char: PRES HGHT TEMP DWPT RELH MIXR DRCT SPED ..."""
    m = re.search(r"<PRE>(.*?)</PRE>", html, re.S | re.I)
    if not m:
        return []

    def col(line: str, a: int, b: int) -> Optional[float]:
        s = line[a:b].strip()
        try:
            return float(s) if s else None
        except ValueError:
            return None

    levels: list[dict] = []
    for line in m.group(1).splitlines():
        if not re.match(r"\s*-?\d", line) or len(line) < 21:
            continue
        p = col(line, 0, 7)
        h = col(line, 7, 14)
        t = col(line, 14, 21)
        if p is None or h is None or t is None:
            continue
        td = col(line, 21, 28)
        if td is None or td > t:
            td = t - 30.0
        drct = col(line, 42, 49)
        sped = col(line, 49, 56)  # m/s
        has_wind = drct is not None and sped is not None
        levels.append({
            "p": p, "h": h, "t": t, "td": td,
            "wd": drct if has_wind else MISSING,
            "ws": sped * MS2KT if has_wind else MISSING,
        })
    return _clean_levels(levels)


def _fetch_wyoming(wmo: str, unix: int) -> list[dict]:
    """Fetch a global RAOB from Wyoming's BUFR archive by WMO number."""
    key = ("wyo", wmo, unix)
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1] or []
    dt = datetime.fromtimestamp(unix, tz=timezone.utc)
    dtstr = f"{dt.year}-{dt.month:02d}-{dt.day:02d} {dt.hour}:00:00"
    try:
        resp = _SESSION.get(
            WYO_URL,
            params={"datetime": dtstr, "id": wmo, "src": "BUFR", "type": "TEXT:LIST"},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException as exc:
        raise NetworkError(
            "Could not reach the RAOB data source after several tries - check the "
            "internet connection and try again."
        ) from exc
    levels = _parse_wyoming(resp.text) if resp.ok else []
    _CACHE[key] = (now, levels)
    return levels


def _levels_at(station: str, wmo: Optional[str], unix: int) -> tuple[list[dict], Optional[str]]:
    """Best observed profile for a station at one time, trying each source.
    IEM (clean JSON) for North-American alpha idents; University of Wyoming
    BUFR (global) for WMO-numbered stations. Returns (levels, source_label)."""
    if station and not station.isdigit():
        prof = _fetch_iem(station, unix)
        if prof:
            lv = _levels_from_profile(prof)
            if len(lv) >= 4:
                return lv, "IEM radiosonde obs"
    number = wmo or (station if station and station.isdigit() else None)
    if number:
        lv = _fetch_wyoming(number, unix)
        if len(lv) >= 4:
            return lv, "U. Wyoming radiosonde obs"
    return [], None


def _find_available(
    station: str, wmo: Optional[str], times: list[int], want_index: int
) -> tuple[Optional[list[dict]], Optional[int], Optional[str]]:
    """Fetch the requested time; if empty, walk outward (prefer earlier) for the
    nearest time with a usable profile. Returns (levels, index, source_label)."""
    order = [want_index]
    for delta in range(1, len(times)):
        if want_index - delta >= 0:
            order.append(want_index - delta)
        if want_index + delta < len(times):
            order.append(want_index + delta)
    for idx in order:
        levels, source = _levels_at(station, wmo, times[idx])
        if len(levels) >= 4:
            return levels, idx, source
    return None, None, None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def build_raob(station: str, name: str, lat: float, lon: float, hour: int, wmo: str = "") -> dict:
    station = (station or "").strip()
    wmo = (wmo or "").strip() or None
    if not station and not wmo:
        raise NoObservationError("No station id was provided.")

    times = _recent_synoptic()
    requested_index = max(0, min(int(hour), len(times) - 1))

    cache_key = (station.upper(), wmo or "", requested_index)
    now = time.time()
    hit = _RESULT_CACHE.get(cache_key)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    levels, actual_index, source = _find_available(station, wmo, times, requested_index)
    if levels is None or actual_index is None:
        raise NoObservationError(
            f"No observed sounding was reported for {name or station} at any of the "
            "last few 00Z/12Z times. Not every station launches every cycle - try "
            "another station or come back later."
        )

    valid_unix = times[actual_index]
    label = f"{name or station}".strip()

    meta = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "model": f"raob:{station}",
        "requestedModel": f"raob:{station}",
        "modelLabel": f"{label} (RAOB)",
        "requestedModelLabel": f"{label} (RAOB)",
        "modelGroup": "Observed",
        "openMeteoModel": "iem_raob",
        "fallbackReason": (
            None if actual_index == requested_index
            else f"No observation at {_iso_z(times[requested_index])[:16]}Z; showing {_iso_z(valid_unix)[:16]}Z."
        ),
        "hour": actual_index,
        "requestedHour": requested_index,
        "forecastMaxHour": len(times) - 1,
        "validHours": list(range(len(times))),
        "elevation": round(levels[0]["h"], 1),
        "validUnix": valid_unix,
        "times": times,
        "nTimes": len(times),
        "source": source or "Radiosonde observation",
        "observed": True,
        "station": station,
        "stationName": label,
    }

    result = sounding_core.compute(levels)

    # Preserve missing winds. SHARPpy skips those levels; replacing them with
    # calm wind creates false segments back to the origin in the hodograph.
    render_levels = levels

    image = None
    image_error = None
    try:
        from sharppy_renderer import render_spc_widget_png

        image = base64.b64encode(render_spc_widget_png(render_levels, meta)).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        # If the main renderer fails, try in-process rendering directly
        image_error = str(exc)
        try:
            from sharppy_renderer import _render_spc_widget_png_serialized

            image = base64.b64encode(_render_spc_widget_png_serialized(render_levels, meta)).decode("ascii")
            image_error = None  # Clear error if in-process succeeded
        except Exception as exc2:  # noqa: BLE001
            image_error = f"{exc}; in-process also failed: {exc2}"

    payload = {
        "meta": meta,
        "levels": levels,
        "parcelTrace": result["parcelTrace"],
        "effBotP": result["effBotP"],
        "effTopP": result["effTopP"],
        "params": result["params"],
        "image": image,
        "imageRenderer": "SHARPpy SPCWidget",
        "imageError": image_error,
    }
    _RESULT_CACHE[cache_key] = (now, payload)
    return payload
