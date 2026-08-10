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
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import h5py

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
# 24 measured best on a 60-minute window (30.6 s vs 35.7 s at 10 and 38.3 s at
# 32 -- past ~24 the extra connections cost more than they win).
FETCH_WORKERS = 24
# Granules decoded and kept. 60 min x 2 satellites = 360, plus slack.
CACHE_LIMIT = 420

# S3 key -> list of (lat, lon, unix_seconds, energy_joules)
_FLASHES: dict[str, list[tuple[float, float, float, float]]] = {}
# (bucket, hour prefix) -> keys, so a poll does not re-list a settled hour.
_LISTINGS: dict[tuple[str, str], list[str]] = {}
_LOCK = threading.Lock()

# One pooled session for every granule fetch. `requests.get` opens a new TCP+TLS
# connection each call, which is pure overhead when 179 files come from one
# host; the pool must be at least as large as FETCH_WORKERS or the threads
# queue on it.
_S3 = requests.Session()
_S3.mount("https://", HTTPAdapter(pool_connections=4, pool_maxsize=FETCH_WORKERS + 8,
                                  max_retries=Retry(total=2, connect=2, read=1,
                                                    backoff_factor=0.3,
                                                    status_forcelist=(429, 500, 502, 503, 504),
                                                    allowed_methods=frozenset(["GET"]))))

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


_UINT_OF = {1: "u1", 2: "u2", 4: "u4", 8: "u8"}


def _decode_var(f: "h5py.File", name: str) -> np.ndarray:
    """One NetCDF-in-HDF5 variable, with the conventions xarray would apply.

    `_Unsigned: "true"` on a signed integer means the bits are really unsigned;
    `_FillValue` marks missing and MUST be masked before scaling, or a fill of
    -1 read as uint16 becomes 65535 and scales into an enormous value.
    """
    d = f[name]
    raw = d[:]
    a = d.attrs
    fill = a.get("_FillValue")
    missing = None
    if fill is not None:
        missing = raw == np.asarray(fill).ravel()[0]
    if a.get("_Unsigned", b"") in (b"true", "true") and raw.dtype.kind == "i":
        raw = raw.astype(_UINT_OF.get(raw.dtype.itemsize, "u4"))
    vals = raw.astype("float64")
    if "scale_factor" in a:
        vals = vals * float(np.asarray(a["scale_factor"]).ravel()[0])
    if "add_offset" in a:
        vals = vals + float(np.asarray(a["add_offset"]).ravel()[0])
    if missing is not None and missing.any():
        vals[missing] = np.nan
    return vals


def _decode_time(f: "h5py.File", name: str) -> np.ndarray:
    """A time variable -> unix seconds, using its own `units` epoch."""
    offs = _decode_var(f, name)
    units = f[name].attrs.get("units", b"")
    if isinstance(units, bytes):
        units = units.decode("ascii", "ignore")
    base = 0.0
    if "since" in str(units):
        stamp = str(units).split("since", 1)[1].strip()
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
            try:
                base = datetime.strptime(stamp, fmt).replace(tzinfo=timezone.utc).timestamp()
                break
            except ValueError:
                continue
    return base + offs


def _read_granule(bucket: str, key: str) -> list[tuple[float, float, float, float]]:
    """Decode one granule to (lat, lon, unix, energy) per flash."""
    with _LOCK:
        hit = _FLASHES.get(key)
    if hit is not None:
        return hit

    out: list[tuple[float, float, float, float]] = []
    try:
        raw = _S3.get(f"https://{bucket}.s3.amazonaws.com/{key}", timeout=60).content
        if not raw:
            return out
        # h5py directly, NOT xarray. Building an xarray Dataset costs ~0.27 s per
        # granule against ~0.001 s for the four arrays we actually read -- and
        # since the decode holds the GIL, that cost does not parallelise, which
        # is why a 60-minute window took nearly two minutes. Verified against
        # xarray's own output: lat, lon and time are bit-identical, energy
        # differs by 1e-7 relative (we scale in float64, xarray in float32) and
        # is identical once rounded for display.
        with h5py.File(io.BytesIO(raw), "r") as f:
            if "flash_lat" not in f:
                return out
            lat = _decode_var(f, "flash_lat")
            lon = _decode_var(f, "flash_lon")
            energy = _decode_var(f, "flash_energy")
            t_arr = _decode_time(f, "flash_time_offset_of_first_event")
            n = min(len(lat), len(lon), len(energy), len(t_arr))
            if not n:
                return out
            good = np.isfinite(lat[:n]) & np.isfinite(lon[:n]) & np.isfinite(t_arr[:n])
            for la, lo, tt, en in zip(lat[:n][good], lon[:n][good],
                                      t_arr[:n][good], energy[:n][good]):
                out.append((float(la), float(lo), float(tt),
                            float(en) if np.isfinite(en) else 0.0))
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
