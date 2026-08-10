"""
Live lightning from the GOES Geostationary Lightning Mapper.

GLM watches the full disc continuously and NOAA publishes Level-2 flash files to
open S3 in 20-second granules, a couple of minutes behind real time. That is the
authoritative source and needs no key -- unlike the community networks, whose
endpoints are undocumented and move.

A granule is immutable once written, so every one that has been decoded is kept
in a small cache. The first call for a long window pays for the whole backlog;
after that a poll only fetches the two or three granules that are new.
"""
from __future__ import annotations

import io
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any

import numpy as np
import requests
import xarray as xr

# G19 sits at 75.2W (East: the Americas and the Atlantic), G18 at 137W (West:
# the Pacific and the western states). Together they cover most of a hemisphere.
SATELLITES: dict[str, dict[str, str]] = {
    "east": {"bucket": "noaa-goes19", "code": "G19", "label": "GOES-East"},
    "west": {"bucket": "noaa-goes18", "code": "G18", "label": "GOES-West"},
}
DEFAULT_SAT = "east"

MAX_MINUTES = 60
# One granule is 20 s, so an hour is 180 files. Fetching those serially would
# take minutes; the bucket is happy with a modest amount of parallelism.
FETCH_WORKERS = 10
# Granules decoded and kept. 60 min x 2 satellites = 360, plus slack.
CACHE_LIMIT = 420

# S3 key -> list of (lat, lon, unix_seconds, energy_joules)
_FLASHES: dict[str, list[tuple[float, float, float, float]]] = {}
# (bucket, hour prefix) -> keys, so a poll does not re-list a settled hour.
_LISTINGS: dict[tuple[str, str], list[str]] = {}
_LOCK = threading.Lock()

_KEY_TIME = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)")


def _key_start(key: str) -> datetime | None:
    """Granule start time, straight out of the filename -- no fetch needed."""
    m = _KEY_TIME.search(key)
    if not m:
        return None
    year, doy, hh, mm, ss, tenth = (int(g) for g in m.groups())
    return (
        datetime(year, 1, 1, tzinfo=timezone.utc)
        + timedelta(days=doy - 1, hours=hh, minutes=mm, seconds=ss, milliseconds=tenth * 100)
    )


def _list_hour(bucket: str, when: datetime) -> list[str]:
    """Every GLM key in one UTC hour."""
    prefix = f"GLM-L2-LCFA/{when.year}/{when.timetuple().tm_yday:03d}/{when.hour:02d}/"
    ck = (bucket, prefix)
    # An hour that is fully in the past can never gain keys; the current one can.
    settled = when < datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    with _LOCK:
        hit = _LISTINGS.get(ck)
    if hit is not None and settled:
        return hit

    keys: list[str] = []
    token = ""
    for _ in range(6):  # 180 keys per hour, 1000 per page -- one page in practice
        url = f"https://{bucket}.s3.amazonaws.com/?list-type=2&prefix={prefix}&max-keys=1000"
        if token:
            url += f"&continuation-token={requests.utils.quote(token, safe='')}"
        r = requests.get(url, timeout=45)
        if r.status_code != 200:
            break
        keys.extend(re.findall(r"<Key>([^<]+)</Key>", r.text))
        nxt = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
        if not nxt:
            break
        token = nxt.group(1)

    with _LOCK:
        _LISTINGS[ck] = keys
    return keys


def _read_granule(bucket: str, key: str) -> list[tuple[float, float, float, float]]:
    """Decode one granule to (lat, lon, unix, energy) per flash."""
    with _LOCK:
        hit = _FLASHES.get(key)
    if hit is not None:
        return hit

    out: list[tuple[float, float, float, float]] = []
    try:
        raw = requests.get(f"https://{bucket}.s3.amazonaws.com/{key}", timeout=60).content
        if not raw:
            return out
        with xr.open_dataset(io.BytesIO(raw), engine="h5netcdf") as ds:
            n = int(ds.sizes.get("number_of_flashes", 0))
            if n:
                lat = np.asarray(ds["flash_lat"].values, dtype=float)
                lon = np.asarray(ds["flash_lon"].values, dtype=float)
                energy = np.asarray(ds["flash_energy"].values, dtype=float)
                # Flash times are an offset from the granule's product_time.
                base = np.datetime64(ds["product_time"].values).astype("datetime64[ms]")
                base_unix = base.astype("int64") / 1000.0
                off = np.asarray(ds["flash_time_offset_of_first_event"].values, dtype="datetime64[ms]")
                # The offset variable is itself absolute once decoded; fall back
                # to the granule time for anything that comes through unset.
                t = off.astype("int64") / 1000.0
                bad = ~np.isfinite(t) | (t <= 0)
                if bad.any():
                    t = np.where(bad, base_unix, t)
                good = np.isfinite(lat) & np.isfinite(lon)
                for la, lo, tt, en in zip(lat[good], lon[good], t[good], energy[good]):
                    out.append((float(la), float(lo), float(tt), float(en) if np.isfinite(en) else 0.0))
    except Exception:  # noqa: BLE001 - one bad granule must not sink the window
        return []

    with _LOCK:
        if len(_FLASHES) >= CACHE_LIMIT:
            for k in list(_FLASHES)[: CACHE_LIMIT // 4]:
                _FLASHES.pop(k, None)
        _FLASHES[key] = out
    return out


def _keys_in_window(bucket: str, code: str, start: datetime, end: datetime) -> list[str]:
    hours = {start.replace(minute=0, second=0, microsecond=0)}
    hours.add(end.replace(minute=0, second=0, microsecond=0))
    keys: list[str] = []
    for h in sorted(hours):
        for k in _list_hour(bucket, h):
            if f"_{code}_" not in k:
                continue
            ts = _key_start(k)
            if ts and start <= ts <= end:
                keys.append(k)
    return sorted(keys)


def build_lightning(
    minutes: int = 15,
    sat: str = DEFAULT_SAT,
    bbox: tuple[float, float, float, float] | None = None,
    end_unix: float | None = None,
) -> dict[str, Any]:
    """
    Flashes over the last `minutes`, ending now or at `end_unix`.

    `sat` is "east", "west" or "both". `bbox` is (lat0, lon0, lat1, lon1) and only
    trims the response -- the granules cover the whole disc either way.
    """
    if not 1 <= minutes <= MAX_MINUTES:
        raise ValueError(f"Window must be 1-{MAX_MINUTES} minutes")
    wanted = ["east", "west"] if sat == "both" else [sat]
    for s in wanted:
        if s not in SATELLITES:
            raise ValueError(f"Unknown satellite: {sat}")

    end = datetime.now(timezone.utc) if end_unix is None else datetime.fromtimestamp(end_unix, timezone.utc)
    end = min(end, datetime.now(timezone.utc))
    start = end - timedelta(minutes=minutes)

    jobs: list[tuple[str, str, str]] = []
    for s in wanted:
        meta = SATELLITES[s]
        for k in _keys_in_window(meta["bucket"], meta["code"], start, end):
            jobs.append((meta["bucket"], k, s))
    if not jobs:
        raise RuntimeError("No GLM granules published for that window yet")

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        decoded = list(pool.map(lambda j: (_read_granule(j[0], j[1]), j[2]), jobs))

    lo_t = start.timestamp()
    features: list[dict[str, Any]] = []
    newest = 0.0
    # Rate history: one bucket per minute of the window, oldest first.
    buckets = [0] * minutes
    for flashes, source in decoded:
        for la, lo, t, en in flashes:
            if t < lo_t:
                continue
            if bbox and not (bbox[0] <= la <= bbox[2] and bbox[1] <= lo <= bbox[3]):
                continue
            newest = max(newest, t)
            idx = min(minutes - 1, max(0, int((t - lo_t) // 60)))
            buckets[idx] += 1
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        # Unix seconds: the client grades colour by age off this.
                        "t": round(t, 1),
                        # Joules, and vanishingly small -- femtojoule keeps the
                        # number readable in a popup and the styling expression.
                        "fJ": round(en * 1e15, 2),
                        "sat": source,
                    },
                    "geometry": {"type": "Point", "coordinates": [round(lo, 4), round(la, 4)]},
                }
            )

    span_min = max(minutes, 1)
    return {
        "source": "NOAA GOES GLM (Level 2 flashes)",
        "satellites": [SATELLITES[s]["label"] for s in wanted],
        "minutes": minutes,
        "count": len(features),
        # Averaged over the window; the per-minute series is what a spark line wants.
        "perMinute": round(len(features) / span_min, 1),
        "rateSeries": buckets,
        "newestUnix": round(newest, 1) if newest else None,
        "granules": len(jobs),
        "geojson": {"type": "FeatureCollection", "features": features},
    }
