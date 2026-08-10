"""
ACARS / AMDAR aircraft soundings.

Source: NOAA MADIS's public archive of ACARS *profiles* — the vertical profiles
already assembled from an aircraft's ascent out of, or descent into, an airport.
No key, no registration:

    https://madis-data.ncep.noaa.gov/madisPublic1/data/point/acarsProfiles/netcdf/
        YYYYMMDD_HH00.gz        (gzipped NetCDF-3, one file per hour, ~5 days kept)

Per record: profileAirport (3-letter), profileTime (unix), profileType
(1 ascending / -1 descending), the airport's lat/lon/elevation, and the level
arrays altitude (m MSL, *pressure* altitude), temperature and dewpoint (K),
windDir (deg true) and windSpeed (m/s). 99999 is the fill value.

Aircraft report pressure ALTITUDE, not pressure, so the pressure each level sits
at is recovered by inverting the US Standard Atmosphere — which is exact here,
because that is the very relation the altimeter used to produce the number.
"""
from __future__ import annotations

import gzip
import io
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import numpy as np
import requests
from requests.adapters import HTTPAdapter
from scipy.io import netcdf_file
from urllib3.util.retry import Retry

BASE = "https://madis-data.ncep.noaa.gov/madisPublic1/data/point/acarsProfiles/netcdf/"

_HTTP_TIMEOUT = (8, 60)
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(total=3, connect=3, read=2, backoff_factor=0.5,
                          status_forcelist=(429, 500, 502, 503, 504),
                          allowed_methods=frozenset(["GET"]))
    ),
)

FILL = 99999.0
MAX_HOURS = 48
DEFAULT_HOURS = 8
MIN_LEVELS = 6
# The timeline must be able to step back 7 ascents, so a profile needs 8 frames.
# Most fields cannot supply that in 12 h -- of 55 airports reporting in a recent
# 12 h window, 45 had fewer than 8 ascents -- so the window for ONE airport
# expands backwards until it has enough, instead of being a fixed span.
TARGET_FRAMES = 8
# Hourly files fetched at once while walking back; the walk is latency-bound.
HOUR_WORKERS = 8

_HOUR_CACHE: dict[str, tuple[float, list[dict]]] = {}
_HOUR_TTL_LIVE = 300.0   # the current hour is still filling
_HOUR_TTL_PAST = 86400.0  # a closed hour never changes


class NoProfileError(RuntimeError):
    """Asked for a profile that isn't in the archive window."""


def _ok(v: float) -> bool:
    return v is not None and math.isfinite(v) and abs(v) < FILL - 1


def pressure_from_altitude(h_m: float) -> float:
    """US Standard Atmosphere pressure (hPa) at a pressure altitude in metres."""
    if h_m < 11000.0:
        return 1013.25 * (1.0 - 2.25577e-5 * h_m) ** 5.25588
    # Isothermal layer above the tropopause.
    return 226.32 * math.exp(-0.00015769 * (h_m - 11000.0))


def _txt(arr) -> str:
    """NetCDF char array -> str. scipy hands these back as dtype 'S1' bytes,
    not ints, so decode the buffer rather than the elements."""
    try:
        raw = bytes(np.asarray(arr).tobytes())
    except Exception:  # noqa: BLE001
        raw = bytes(bytearray(int(c) for c in arr))
    return raw.decode("ascii", "ignore").replace("\x00", " ").strip()


def _hour_keys(hours: int, end: Optional[datetime] = None) -> list[str]:
    end = (end or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    return [(end - timedelta(hours=k)).strftime("%Y%m%d_%H00") for k in range(hours)]


def _read_hour(stamp: str) -> list[dict]:
    """Every profile in one hourly file, as plain dicts (levels included)."""
    now = time.time()
    hit = _HOUR_CACHE.get(stamp)
    is_live = stamp >= datetime.now(timezone.utc).strftime("%Y%m%d_%H00")
    if hit and now - hit[0] < (_HOUR_TTL_LIVE if is_live else _HOUR_TTL_PAST):
        return hit[1]

    try:
        r = _SESSION.get(f"{BASE}{stamp}.gz", timeout=_HTTP_TIMEOUT)
    except requests.exceptions.RequestException as exc:
        raise RuntimeError(f"Could not reach MADIS: {exc}") from exc
    if r.status_code == 404:
        _HOUR_CACHE[stamp] = (now, [])
        return []
    r.raise_for_status()

    try:
        nc = gzip.decompress(r.content)
        f = netcdf_file(io.BytesIO(nc), "r", mmap=False)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"MADIS file {stamp} could not be read: {exc}") from exc

    out: list[dict] = []
    try:
        n = int(f.variables["profileTime"].shape[0])
    except (KeyError, IndexError):
        n = 0
    for i in range(n):
        try:
            n_levels = int(f.variables["nLevels"][i])
            airport = _txt(f.variables["profileAirport"][i])
            unix = float(f.variables["profileTime"][i])
            lat = float(f.variables["latitude"][i])
            lon = float(f.variables["longitude"][i])
            elev = float(f.variables["elevation"][i])
            kind = int(f.variables["profileType"][i])
        except Exception:  # noqa: BLE001 - a malformed record shouldn't kill the hour
            continue
        if not airport or n_levels < MIN_LEVELS or not (_ok(lat) and _ok(lon)):
            continue

        alt = np.asarray(f.variables["altitude"][i][:n_levels], dtype=float)
        tmp = np.asarray(f.variables["temperature"][i][:n_levels], dtype=float)
        dwp = np.asarray(f.variables["dewpoint"][i][:n_levels], dtype=float)
        wdr = np.asarray(f.variables["windDir"][i][:n_levels], dtype=float)
        wsp = np.asarray(f.variables["windSpeed"][i][:n_levels], dtype=float)

        levels: list[dict] = []
        for k in range(n_levels):
            h = float(alt[k])
            t = float(tmp[k])
            if not (_ok(h) and _ok(t)):
                continue
            td = float(dwp[k])
            wd = float(wdr[k])
            ws = float(wsp[k])
            levels.append({
                "p": round(pressure_from_altitude(h), 2),
                "h": round(h, 1),
                "t": round(t - 273.15, 2),
                # A dry level still belongs in the profile; SHARPpy needs *a*
                # dewpoint, and a deep depression is the honest stand-in.
                "td": round(td - 273.15, 2) if _ok(td) else round(t - 273.15 - 30.0, 2),
                "wd": round(wd, 1) if _ok(wd) else 0.0,
                "ws": round(ws * 1.943844, 1) if _ok(ws) else 0.0,  # m/s -> kt
            })
        if len(levels) < MIN_LEVELS:
            continue

        # Surface -> top, one level per pressure (an ascent can log the same
        # altitude twice while the aircraft levels off).
        levels.sort(key=lambda l: -l["p"])
        cleaned: list[dict] = []
        for lv in levels:
            if cleaned and lv["p"] >= cleaned[-1]["p"] - 0.5:
                continue
            if cleaned and lv["h"] <= cleaned[-1]["h"]:
                continue
            cleaned.append(lv)
        if len(cleaned) < MIN_LEVELS:
            continue

        out.append({
            "airport": airport,
            "unix": int(unix),
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "elevation": round(elev, 1) if _ok(elev) else round(cleaned[0]["h"], 1),
            "ascending": kind >= 0,
            "nLevels": len(cleaned),
            "topPressure": cleaned[-1]["p"],
            "levels": cleaned,
        })

    _HOUR_CACHE[stamp] = (now, out)
    # Must comfortably exceed MAX_HOURS: at 40 entries a 48 h walk evicted the
    # hours it had just read and re-downloaded them on the next airport.
    while len(_HOUR_CACHE) > MAX_HOURS + 16:
        _HOUR_CACHE.pop(next(iter(_HOUR_CACHE)))
    return out


def list_profiles(hours: int = DEFAULT_HOURS, end_unix: Optional[float] = None) -> dict:
    """Available aircraft profiles over a trailing window, newest first.

    One entry per airport+time. Airports repeat (a busy hub can log several
    ascents an hour), which is exactly what the map dot's "N profiles" means.
    """
    hours = max(1, min(int(hours), MAX_HOURS))
    end = datetime.fromtimestamp(end_unix, timezone.utc) if end_unix else None

    profiles: list[dict] = []
    errors: list[str] = []
    stamps = _hour_keys(hours, end)

    def safe(stamp: str):
        try:
            return stamp, _read_hour(stamp), None
        except Exception as exc:  # noqa: BLE001 - one bad hour shouldn't empty the map
            return stamp, [], str(exc)

    with ThreadPoolExecutor(max_workers=HOUR_WORKERS) as pool:
        for stamp, got, err in pool.map(safe, stamps):
            profiles.extend(got)
            if err:
                errors.append(f"{stamp}: {err}")

    profiles.sort(key=lambda p: p["unix"], reverse=True)

    # Airport roll-up for the map layer: one dot per field, carrying its newest
    # profile plus how many it has in the window.
    by_airport: dict[str, dict] = {}
    for p in profiles:
        cur = by_airport.get(p["airport"])
        if cur is None:
            by_airport[p["airport"]] = {
                "airport": p["airport"], "lat": p["lat"], "lon": p["lon"],
                "elevation": p["elevation"], "latestUnix": p["unix"], "count": 1,
                "ascending": p["ascending"], "nLevels": p["nLevels"],
                "topPressure": p["topPressure"],
            }
        else:
            cur["count"] += 1

    return {
        "airports": sorted(by_airport.values(), key=lambda a: -a["latestUnix"]),
        "profiles": [{k: v for k, v in p.items() if k != "levels"} for p in profiles],
        "meta": {
            "hours": hours,
            "count": len(profiles),
            "airportCount": len(by_airport),
            "errors": errors,
            "source": "NOAA MADIS aircraft (ACARS/AMDAR) profiles",
        },
    }


def airport_profiles(airport: str, hours: int = DEFAULT_HOURS,
                     min_frames: int = TARGET_FRAMES) -> list[dict]:
    """Every profile one airport has, newest first, walking back until it has
    at least `min_frames` of them (or the archive window runs out).

    Read in BATCHES, in parallel: the hourly files are tiny (~7 KB) and the walk
    is entirely latency-bound, so 48 sequential fetches cost ~12 s while eight at
    a time cost ~2 s. Batching rather than fetching all 48 keeps the early exit,
    so a busy hub still stops after the first batch. The files are shared between
    airports and cached, so the second airport asked about is nearly free.
    """
    airport = (airport or "").strip().upper()
    if not airport:
        raise ValueError("airport is required")

    stamps = _hour_keys(MAX_HOURS)
    found: list[dict] = []
    seen: set[int] = set()
    read = 0

    def safe_read(stamp: str) -> list[dict]:
        try:
            return _read_hour(stamp)
        except Exception:  # noqa: BLE001 - one unreachable hour must not end the walk
            return []

    with ThreadPoolExecutor(max_workers=HOUR_WORKERS) as pool:
        for i in range(0, len(stamps), HOUR_WORKERS):
            batch = stamps[i : i + HOUR_WORKERS]
            for hour_profiles in pool.map(safe_read, batch):
                for p in hour_profiles:
                    if p["airport"] == airport and p["unix"] not in seen:
                        seen.add(p["unix"])
                        found.append(p)
            read += len(batch)
            # Keep going past `hours` only while short of frames.
            if read >= max(hours, 1) and len(found) >= min_frames:
                break

    found.sort(key=lambda p: p["unix"], reverse=True)
    return found


def find_profile(airport: str, unix: Optional[int] = None,
                 hours: int = DEFAULT_HOURS) -> dict:
    """The profile for an airport at (or nearest before) a time."""
    profiles = airport_profiles(airport, hours)
    if not profiles:
        raise NoProfileError(
            f"No aircraft sounding for {airport} in the last {MAX_HOURS} h."
        )
    if unix is None:
        return profiles[0]
    return min(profiles, key=lambda p: abs(p["unix"] - unix))


def build_acars(airport: str, unix: Optional[int] = None,
                hours: int = DEFAULT_HOURS) -> dict:
    """An aircraft profile rendered through the same pipeline as every other
    sounding, so the viewer treats it exactly like a model or RAOB sounding."""
    import base64

    import sounding_core

    profiles = airport_profiles(airport, hours)
    if not profiles:
        raise NoProfileError(
            f"No aircraft sounding for {(airport or '').upper()} in the last {MAX_HOURS} h."
        )
    prof = profiles[0] if unix is None else min(profiles, key=lambda p: abs(p["unix"] - unix))
    levels = prof["levels"]
    if len(levels) < 4:
        raise RuntimeError("Not enough levels in this aircraft profile")

    result = sounding_core.compute(levels, lat=prof["lat"])

    # The time axis is this airport's own ascent history, oldest first, so the
    # global timeline steps between real ascents rather than a synthetic grid.
    times = sorted(p["unix"] for p in profiles)
    try:
        hour_index = times.index(prof["unix"])
    except ValueError:
        hour_index = max(len(times) - 1, 0)

    meta = {
        "lat": prof["lat"],
        "lon": prof["lon"],
        "model": "acars",
        "modelLabel": f"{airport} aircraft sounding",
        "modelGroup": "Aircraft",
        "requestedModel": "acars",
        "requestedModelLabel": f"{airport} aircraft sounding",
        "openMeteoModel": None,
        "fallbackReason": None,
        "hour": hour_index,
        "requestedHour": hour_index,
        "forecastMaxHour": max(len(times) - 1, 0),
        "validHours": list(range(len(times))),
        "elevation": prof["elevation"],
        "validUnix": prof["unix"],
        "times": times,
        "nTimes": len(times),
        "station": airport,
        "stationName": airport,
        "ascending": prof["ascending"],
        "source": "MADIS ACARS/AMDAR + SHARPpy SPCWidget",
    }

    image = None
    image_error = None
    try:
        from sharppy_renderer import render_spc_widget_png

        image = base64.b64encode(render_spc_widget_png(levels, meta)).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        image_error = str(exc)

    return {
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
