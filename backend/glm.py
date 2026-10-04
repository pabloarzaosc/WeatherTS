"""
Total lightning from the Geostationary Lightning Mappers (GLM) on GOES-East
(GOES-19, over 75.2 W) and GOES-West (GOES-18, over 137.0 W).

A GLM sees every flash, in-cloud and cloud-to-ground, day and night, over
most of the hemisphere under it: GOES-East from the eastern Pacific to Africa's
coast, Brazil and Argentina included; GOES-West from the US Plains to past
Hawaii. NOAA publishes a Level 2 file per satellite every 20 seconds (LCFA:
the events, the groups made of them and the flashes made of those), about half
a megabyte, some 25 s after its end. Only the flashes are kept -- where, when
the first light was, how much energy and how wide -- and only those NOAA's own
quality check passed: the flag weeds out sun glint and other false ones.

The files come whole from Google Cloud's copy, AWS when that fails: small
enough that one request beats walking the HDF5 index by ranges. Each is decoded
once into a few kilobytes of arrays, kept in memory and on disk; a file never
changes, so a window looked at once costs nothing the next time, and a loop
over an afternoon downloads each 20 seconds of it once.

Where both satellites see a flash (the Plains to Central America) the one
nearer overhead keeps it: GOES-East east of 106.1 W, halfway between the two,
GOES-West west of it and across the antimeridian -- not both, or every storm
there would count twice.
"""
from __future__ import annotations

import io
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from typing import Optional

import h5py
import numpy as np

import sat_abi
import sat_net as net

SATS = {
    "goes19": "gcp-public-data-goes-19",
    "goes18": "gcp-public-data-goes-18",
}
# Halfway between the two sub-satellite points (75.2 W and 137.0 W). GOES-East
# keeps from there east to 30 E, past the edge of its view at Africa's coast;
# GOES-West the rest, which runs west across the antimeridian to ~150 E.
SPLIT_LON = -106.1
EAST_EDGE = 30.0
FILE_S = 20
MAX_MINUTES = 180

FLASH = np.dtype([("lon", "<f4"), ("lat", "<f4"), ("t", "<f8"), ("energy", "<f4"), ("area", "<f4")])

# Reentrant: a download that finished before its callback was added runs the
# callback at once, on the thread that holds this lock while adding it.
_LOCK = threading.RLock()
_MEM: "OrderedDict[str, np.ndarray]" = OrderedDict()
MEM_FILES = 4000  # ~11 h of both satellites; ~20 kB each on a busy afternoon
_INFLIGHT: dict[str, Future] = {}
# Two queues: the window on screen now, and a loop's span read ahead. One FIFO
# for both put a frame's own files behind hours of read-ahead -- the first scan
# of a radar loop waited on every newer file of the afternoon. Their own pools,
# too, so neither holds up the satellite's tiles on sat_net's.
_NOW = ThreadPoolExecutor(max_workers=16, thread_name_prefix="glm-now")
_AHEAD = ThreadPoolExecutor(max_workers=6, thread_name_prefix="glm-ahead")


def _unsigned(ds: h5py.Dataset) -> np.ndarray:
    """A packed variable as its real values: NOAA stores most of them as int16
    marked _Unsigned, with a scale and an offset."""
    raw = ds[()]
    flag = ds.attrs.get("_Unsigned")
    if isinstance(flag, (bytes, np.bytes_)):
        flag = flag.decode()
    unsigned = raw.dtype.kind == "i" and flag == "true"
    if unsigned:
        raw = raw.view(raw.dtype.str.replace("i", "u"))
    out = raw.astype(np.float64)
    fill = ds.attrs.get("_FillValue")
    if fill is not None:
        f = np.asarray(fill, dtype=ds.dtype).ravel()[:1]
        out[raw == (f.view(raw.dtype)[0] if unsigned else f[0])] = np.nan
    scale = ds.attrs.get("scale_factor")
    offset = ds.attrs.get("add_offset")
    if scale is not None:
        out *= float(np.asarray(scale).ravel()[0])
    if offset is not None:
        out += float(np.asarray(offset).ravel()[0])
    return out


def _start_of(f: h5py.File) -> float:
    raw = f.attrs.get("time_coverage_start")
    s = raw.decode() if isinstance(raw, bytes) else str(raw)
    return datetime.strptime(s.rstrip("Z"), "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=timezone.utc).timestamp()


def decode(body: bytes) -> np.ndarray:
    """The good flashes of one LCFA file."""
    with h5py.File(io.BytesIO(body), "r") as f:
        n = f["flash_lat"].shape[0]
        out = np.zeros(n, FLASH)
        if n == 0:
            return out
        out["lat"] = f["flash_lat"][()]
        out["lon"] = f["flash_lon"][()]
        out["t"] = _start_of(f) + _unsigned(f["flash_time_offset_of_first_event"])
        out["energy"] = _unsigned(f["flash_energy"]) * 1e15  # femtojoules
        out["area"] = _unsigned(f["flash_area"]) / 1e6  # km2
        good = _unsigned(f["flash_quality_flag"]) == 0
    return out[good & np.isfinite(out["lat"]) & np.isfinite(out["lon"])]


def _fetch(bucket: str, key: str) -> np.ndarray:
    ck = f"{bucket}/{key}"
    cached = net.disk_get("glm", ck)
    if cached is not None and len(cached) % FLASH.itemsize == 0:
        return np.frombuffer(cached, FLASH).copy()
    try:
        body = net.get(f"{sat_abi.GCS}/{bucket}/{key}").content
    except Exception:  # noqa: BLE001 - the same file on AWS
        body = net.get(f"https://{sat_abi.S3[bucket]}.s3.amazonaws.com/{key}").content
    arr = decode(body)
    net.disk_put("glm", ck, arr.tobytes())
    return arr


def _done(ck: str, fut: Future) -> None:
    with _LOCK:
        if _INFLIGHT.get(ck) is fut:
            _INFLIGHT.pop(ck, None)
        if fut.cancelled():
            return
        if fut.exception() is None:
            _MEM[ck] = fut.result()
            while len(_MEM) > MEM_FILES:
                _MEM.popitem(last=False)


def _file(bucket: str, key: str, now: bool = True) -> tuple[Optional[np.ndarray], Optional[Future]]:
    """A file's flashes if they are here, else the download bringing them:
    on the queue for now, or for later (`now` False, a read-ahead). A file the
    screen wants that is still waiting in the read-ahead queue moves over."""
    ck = f"{bucket}/{key}"
    with _LOCK:
        hit = _MEM.get(ck)
        if hit is not None:
            _MEM.move_to_end(ck)
            return hit, None
        fut = _INFLIGHT.get(ck)
        if fut is not None and now and getattr(fut, "ahead", False) and fut.cancel():
            fut = None
        if fut is None:
            fut = (_NOW if now else _AHEAD).submit(_fetch, bucket, key)
            fut.ahead = not now  # type: ignore[attr-defined]
            _INFLIGHT[ck] = fut
            fut.add_done_callback(lambda f, ck=ck: _done(ck, f))
    return None, fut


def _files(bucket: str, start: float, end: float) -> list[tuple[float, str]]:
    """(file start, key) of every file overlapping start..end."""
    now = datetime.now(timezone.utc)
    t0 = datetime.fromtimestamp(start - FILE_S, timezone.utc).replace(minute=0, second=0, microsecond=0)
    t1 = datetime.fromtimestamp(end, timezone.utc)
    hours = []
    h = t0
    while h <= t1:
        hours.append(h)
        h += timedelta(hours=1)

    def one(hour: datetime):
        prefix = f"GLM-L2-LCFA/{hour:%Y}/{hour:%j}/{hour:%H}/"
        # An hour that is over never changes; the current one is listed again
        # after 40 s (sat_abi's rule), about two files' worth.
        return sat_abi._list_prefix(bucket, prefix, hour + timedelta(hours=1, minutes=5) < now)

    listings = list(net.POOL.map(one, hours)) if len(hours) > 1 else [one(h) for h in hours]
    out = []
    for items in listings:
        for key, _size in items:
            s = sat_abi.scan_time(key)
            if s is None:
                continue
            ts = s.timestamp()
            if ts + FILE_S > start and ts <= end:
                out.append((ts, key))
    out.sort()
    return out


def flashes(sats: list[str], start: float, end: float,
            bbox: Optional[tuple[float, float, float, float]] = None,
            wait_s: float = 2.0) -> tuple[np.ndarray, dict]:
    """The flashes from `start` to `end` (unix seconds) of the satellites named,
    inside bbox (west, south, east, north; west may be below -180 and east
    above 180 on a map panned across the antimeridian, and the longitudes come
    back in that same world copy).

    Files not here yet are sent for, and waited on up to `wait_s`: what came by
    then is returned, with `pending` counting the rest so the app asks again."""
    parts: list[np.ndarray] = []
    pending: list[Future] = []
    total = 0
    newest = 0.0
    both = len(sats) > 1
    for sat in sats:
        bucket = SATS[sat]
        got: list[np.ndarray] = []
        waiting: list[Future] = []
        for ts, key in _files(bucket, start, end):
            total += 1
            newest = max(newest, ts + FILE_S)
            arr, fut = _file(bucket, key)
            if arr is not None:
                got.append(arr)
            elif fut is not None:
                waiting.append(fut)
        if waiting and wait_s > 0:
            done, _ = wait(waiting, timeout=wait_s)
            for fut in done:
                if not fut.cancelled() and fut.exception() is None:
                    got.append(fut.result())
            waiting = [f for f in waiting if f not in done]
        pending.extend(waiting)
        if not got:
            continue
        arr = np.concatenate(got)
        keep = (arr["t"] >= start) & (arr["t"] <= end)
        if both:
            east = (arr["lon"] >= SPLIT_LON) & (arr["lon"] < EAST_EDGE)
            keep &= east if sat == "goes19" else ~east
        parts.append(arr[keep])

    out = np.concatenate(parts) if parts else np.zeros(0, FLASH)
    if bbox is not None and out.size:
        west, south, east, north = bbox
        out = out[(out["lat"] >= south) & (out["lat"] <= north)]
        if east - west < 360:
            # Into the map's world copy, then the box.
            lon = ((out["lon"] - west) % 360.0) + west
            inside = lon <= east
            out = out[inside]
            out["lon"] = lon[inside]
    out = out[np.argsort(out["t"], kind="stable")]
    info = {
        "start": start,
        "end": end,
        "sats": sats,
        "files": total,
        "pending": len(pending),
        # How far the published files reach: a live window ends a little
        # before now, as NOAA's files land ~25 s after their last flash.
        "latest": newest or None,
        "count": int(out.size),
    }
    return out, info


def pack(arr: np.ndarray, info: dict) -> bytes:
    """[4-byte header length][JSON header][float32 lon, lat, age s, energy fJ]
    per flash, oldest first; age counted back from the window's end."""
    import json
    import struct

    body = np.empty((arr.size, 4), "<f4")
    body[:, 0] = arr["lon"]
    body[:, 1] = arr["lat"]
    body[:, 2] = info["end"] - arr["t"]
    body[:, 3] = arr["energy"]
    head = json.dumps(info).encode("utf-8")
    return struct.pack("<I", len(head)) + head + body.tobytes()


def _sats(sat: str, bbox) -> list[str]:
    """The satellites a request needs. Both, unless the view lies wholly on
    one side of the split: then the other one's files are not even fetched --
    an afternoon's loop over Oklahoma or Brazil is GOES-East's alone, half the
    download."""
    if sat != "both":
        if sat not in SATS:
            raise ValueError(f"unknown satellite {sat}")
        return [sat]
    if bbox is not None and bbox[2] - bbox[0] < 360:
        west = ((bbox[0] + 180.0) % 360.0) - 180.0
        east = west + (bbox[2] - bbox[0])
        if west >= SPLIT_LON and east < EAST_EDGE:
            return ["goes19"]
        # West of the split, or from 30 E across the antimeridian to it.
        if east < SPLIT_LON or (west >= EAST_EDGE and east < 360.0 + SPLIT_LON):
            return ["goes18"]
    return ["goes19", "goes18"]


def window(sat: str, minutes: int, end: Optional[float], bbox, wait_s: Optional[float] = None) -> bytes:
    minutes = max(1, min(int(minutes), MAX_MINUTES))
    stop = float(end) if end else time.time()
    # Live, the window is worth waiting a moment for; a past one asked for
    # frame after frame by a playing loop comes back with what is here, and
    # the app asks again for the rest.
    if wait_s is None:
        wait_s = 2.0 if end is None else 0.4
    arr, info = flashes(_sats(sat, bbox), stop - minutes * 60, stop, bbox, wait_s)
    info["minutes"] = minutes
    info["live"] = end is None
    return pack(arr, info)


def prefetch(sat: str, start: float, end: float, bbox) -> dict:
    """Queue every file from start to end, in the order a play goes through
    them, and return at once: a loop's whole span, read ahead so each frame's
    window is here by the time the play reaches it."""
    start = max(start, end - 12 * 3600)
    queued = 0
    total = 0
    for s in _sats(sat, bbox):
        bucket = SATS[s]
        for _ts, key in _files(bucket, start, end):
            total += 1
            arr, fut = _file(bucket, key, now=False)
            if fut is not None:
                queued += 1
    return {"files": total, "queued": queued}
