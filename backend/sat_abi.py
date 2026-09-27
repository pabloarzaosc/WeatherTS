"""
GOES-East (GOES-19) and GOES-West (GOES-18), read from NOAA's own files.

Every band of every scan, and the Level 2 products (cloud heights and phase,
fire, stability indices, water vapour, aerosols, land surface...), land in
NOAA's buckets minutes after the scan, as netCDF on the imager's fixed grid.
They are read from Google Cloud's copy (gcp-public-data-goes-19/-18: the same
keys, there ~45 s after the scan, and three times AWS's speed from here),
with AWS (noaa-goes19/-18) as the fallback. What matters on this link is how
few bytes and how few round trips a picture costs:

  * The multi-band files (MCMIP) carry all sixteen bands at 2 km in one file,
    each band stored in strips of whole rows (CONUS 52 rows, full disk 24,
    meso 262). Only the strips under the picture are fetched, in parallel
    ranges, and decompressed here -- h5py only walks the file's index.
    A CONUS band is ~3.5 MB whole; a Florida-sized box a fraction of it.
  * Zoomed in past what 2 km can show, the visible and near-IR bands switch to
    their native files (CMIP: 0.5 km red, 1 km blue / veggie / snow-ice), again
    only the strips under the view.
  * Strips are kept decoded in memory (by file and variable), so the sixteen
    bands an RGB and its neighbours share are fetched once.
  * A small file (most Level 2 products, a meso scan) is fetched whole in one
    parallel round and read from memory: walking its index by range cost two
    or three round trips before a single strip came.
"""
from __future__ import annotations

import io
import re
import threading
import time
import zlib
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import numpy as np

import sat_geo as geo
import sat_net as net
import sat_recipes as rx

BUCKETS = {"goes19": "gcp-public-data-goes-19", "goes18": "gcp-public-data-goes-18"}
S3 = {"gcp-public-data-goes-19": "noaa-goes19", "gcp-public-data-goes-18": "noaa-goes18"}
GCS = "https://storage.googleapis.com"
LETTER = {"conus": "C", "meso1": "M", "meso2": "M", "fd": "F"}
MESO_NUM = {"meso1": "1", "meso2": "2"}
CADENCE_S = {"conus": 300, "meso1": 60, "meso2": 60, "fd": 600}
# Native resolution of the reflective bands, km; the rest are 2 km.
NATIVE_KM = {1: 1.0, 2: 0.5, 3: 1.0, 5: 1.0}

_START = re.compile(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)")


# ---------------------------------------------------------------------------
# Listings
# ---------------------------------------------------------------------------
_LIST_LOCK = threading.Lock()
_LISTS: "OrderedDict[str, tuple[float, list[tuple[str, int]]]]" = OrderedDict()
_LIST_GATES: dict[str, threading.Lock] = {}


def _list_prefix(bucket: str, prefix: str, final: bool) -> list[tuple[str, int]]:
    """Keys and sizes under a prefix. An hour that is over never changes and
    is kept; the current one is asked again after 40 s."""
    ck = f"{bucket}/{prefix}"
    with _LIST_LOCK:
        hit = _LISTS.get(ck)
        if hit and (final or time.time() - hit[0] < 40):
            _LISTS.move_to_end(ck)
            return hit[1]
        gate = _LIST_GATES.setdefault(ck, threading.Lock())
    with gate:
        with _LIST_LOCK:
            hit = _LISTS.get(ck)
            if hit and (final or time.time() - hit[0] < 40):
                return hit[1]
        try:
            items = _list_gcs(bucket, prefix)
        except Exception:  # noqa: BLE001 - AWS has the same keys
            try:
                items = _list_s3(S3[bucket], prefix)
            except Exception:  # noqa: BLE001 - a listing that fails keeps what it had
                return hit[1] if hit else []
        with _LIST_LOCK:
            _LISTS[ck] = (time.time(), items)
            _LISTS.move_to_end(ck)
            while len(_LISTS) > 3000:
                _LISTS.popitem(last=False)
        return items


def _list_gcs(bucket: str, prefix: str) -> list[tuple[str, int]]:
    items: list[tuple[str, int]] = []
    token = None
    while True:
        params = {"prefix": prefix, "fields": "items(name,size),nextPageToken", "maxResults": "1000"}
        if token:
            params["pageToken"] = token
        data = net.get(f"{GCS}/storage/v1/b/{bucket}/o", params=params).json()
        items.extend((it["name"], int(it["size"])) for it in data.get("items", []))
        token = data.get("nextPageToken")
        if not token:
            return items


def _list_s3(bucket: str, prefix: str) -> list[tuple[str, int]]:
    items: list[tuple[str, int]] = []
    token = None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        text = net.get(f"https://{bucket}.s3.amazonaws.com/", params=params).text
        items.extend(zip(re.findall(r"<Key>([^<]+)</Key>", text),
                         (int(s) for s in re.findall(r"<Size>(\d+)</Size>", text))))
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        if not m:
            return items
        token = m.group(1)


# ---------------------------------------------------------------------------
# Bytes of a file: Google's copy, AWS if that fails; small files whole
# ---------------------------------------------------------------------------
WHOLE_MAX = 16 * 1024 ** 2
_BODY_LOCK = threading.Lock()
_BODIES: "OrderedDict[str, bytes]" = OrderedDict()
_BODY_BYTES = 0
BODY_BUDGET = 400 * 1024 ** 2
_BODY_GATES: dict[str, threading.Lock] = {}


def _remote(bucket: str, key: str, start: int, end: int) -> bytes:
    try:
        return net.get_range(f"{GCS}/{bucket}/{key}", start, end)
    except Exception:  # noqa: BLE001 - the same file on AWS
        return net.get_range(f"https://{S3[bucket]}.s3.amazonaws.com/{key}", start, end)


def _body(bucket: str, key: str) -> Optional[bytes]:
    with _BODY_LOCK:
        body = _BODIES.get(f"{bucket}/{key}")
        if body is not None:
            _BODIES.move_to_end(f"{bucket}/{key}")
        return body


def whole(bucket: str, key: str, size: int) -> bytes:
    """A small file in one round: a dozen ranges at once (one stream gets a
    fraction of the link), kept in memory for the strips read from it."""
    global _BODY_BYTES
    ck = f"{bucket}/{key}"
    body = _body(bucket, key)
    if body is not None:
        return body
    with _BODY_LOCK:
        gate = _BODY_GATES.setdefault(ck, threading.Lock())
    with gate:
        body = _body(bucket, key)
        if body is not None:
            return body
        part = max(256 * 1024, -(-size // 12))
        spans = [(s0, min(size, s0 + part) - 1) for s0 in range(0, size, part)]
        body = b"".join(net.POOL.map(lambda se: _remote(bucket, key, se[0], se[1]), spans))
        with _BODY_LOCK:
            _BODIES[ck] = body
            _BODY_BYTES += len(body)
            while _BODY_BYTES > BODY_BUDGET and len(_BODIES) > 1:
                _k, old = _BODIES.popitem(last=False)
                _BODY_BYTES -= len(old)
            _BODY_GATES.pop(ck, None)
        return body


def _bytes(bucket: str, key: str, start: int, end: int) -> bytes:
    body = _body(bucket, key)
    if body is not None:
        return body[start:end + 1]
    return _remote(bucket, key, start, end)


def scan_time(key: str) -> Optional[datetime]:
    m = _START.search(key)
    if not m:
        return None
    y, doy, hh, mm, ss, _tenth = (int(g) for g in m.groups())
    return datetime(y, 1, 1, tzinfo=timezone.utc) + timedelta(days=doy - 1, hours=hh, minutes=mm, seconds=ss)


def _files(sat: str, folder: str, sector: str, since: datetime, until: datetime,
           band: Optional[int] = None) -> dict[datetime, tuple[str, int]]:
    """scan start -> (key, size) of one product folder (e.g. "MCMIP", "ACHA")."""
    bucket = BUCKETS[sat]
    letter = LETTER[sector]
    tag = f"-{folder}{letter}{MESO_NUM.get(sector, '')}-"
    out: dict[datetime, tuple[str, int]] = {}
    hours = []
    h = since.replace(minute=0, second=0, microsecond=0)
    now = datetime.now(timezone.utc)
    while h <= until:
        hours.append(h)
        h += timedelta(hours=1)

    def one(hour: datetime):
        prefix = f"ABI-L2-{folder}{letter}/{hour:%Y}/{hour:%j}/{hour:%H}/"
        final = hour + timedelta(hours=1, minutes=20) < now
        return _list_prefix(bucket, prefix, final)

    results = list(net.POOL.map(one, hours)) if len(hours) > 1 else [one(hours[0])] if hours else []
    for items in results:
        for key, size in items:
            if tag not in key:
                continue
            if band is not None and f"C{band:02d}_" not in key:
                continue
            t = scan_time(key)
            if t is not None and since <= t <= until:
                out[t] = (key, size)
    return out


def times(sat: str, sector: str, folder: str, count: int) -> list[datetime]:
    """The newest `count` scans of a product folder, oldest first. Level 2
    products run slower than the sector's scans (the meso cloud layers every
    five minutes, land surface temperature hourly), so the window widens until
    it holds `count` of them or two days."""
    now = datetime.now(timezone.utc)
    span = timedelta(seconds=CADENCE_S[sector] * (count + 3))
    if folder in ("LST", "FSC"):
        span = timedelta(hours=count + 2)
    while True:
        found = _files(sat, folder, sector, now - span, now)
        if len(found) >= count or span >= timedelta(days=2):
            return sorted(found)[-count:]
        # Scale by the cadence seen so far rather than blindly.
        have = max(1, len(found))
        span = min(timedelta(days=2), span * min(8.0, max(2.0, 1.2 * count / have)))


# ---------------------------------------------------------------------------
# File index: where each strip of each variable sits
# ---------------------------------------------------------------------------
@dataclass
class Var:
    name: str
    shape: tuple[int, int]
    dtype: Any
    chunk: tuple[int, int]
    filters: tuple[int, ...]         # HDF5 filter ids in pipeline order
    chunks: dict[tuple[int, int], tuple[int, int]]  # (row, col) -> (offset, size)
    scale: float
    offset: float
    fill: Optional[float]
    unsigned: bool


@dataclass
class FileMeta:
    bucket: str
    key: str
    size: int
    x: np.ndarray                    # scan angle of each column, radians
    y: np.ndarray                    # of each row
    geos: geo.Geos
    vars: dict[str, Var]


_META_LOCK = threading.Lock()
_META: "OrderedDict[str, FileMeta]" = OrderedDict()
_META_GATES: dict[str, threading.Lock] = {}


def _attr(a, name, default=None):
    v = a.get(name)
    if v is None:
        return default
    v = np.asarray(v).ravel()
    if v.size == 0:
        return default
    x = v[0]
    if isinstance(x, bytes):
        return x.decode()
    return x.item() if hasattr(x, "item") else x


def meta(bucket: str, key: str, size: int) -> FileMeta:
    """The file's grid and the byte ranges of every 2-D variable (kept): from
    the whole file when it is small, else from its head and tail by range."""
    ck = f"{bucket}/{key}"
    with _META_LOCK:
        hit = _META.get(ck)
        if hit:
            _META.move_to_end(ck)
            return hit
        gate = _META_GATES.setdefault(ck, threading.Lock())
    with gate:
        with _META_LOCK:
            hit = _META.get(ck)
            if hit:
                return hit
        import h5py  # noqa: PLC0415

        if size <= WHOLE_MAX:
            f = h5py.File(io.BytesIO(whole(bucket, key, size)), "r")
        else:
            rf = net.RangeFile(f"{GCS}/{bucket}/{key}", size,
                               fetch=lambda start, end: _remote(bucket, key, start, end))
            # The index of these files sits in their first few hundred kB and
            # their last blocks: both at once, then h5py reads from memory.
            rf.preload([(0, 768 * 1024), (size - 256 * 1024, size)])
            f = h5py.File(rf, "r")
        try:
            def scaled(name: str) -> np.ndarray:
                v = f[name]
                s = float(_attr(v.attrs, "scale_factor", 1.0))
                o = float(_attr(v.attrs, "add_offset", 0.0))
                return v[:].astype("float64") * s + o

            x = scaled("x")
            y = scaled("y")
            pa = f["goes_imager_projection"].attrs
            g = geo.Geos(lon0=float(_attr(pa, "longitude_of_projection_origin")),
                         h=float(_attr(pa, "perspective_point_height")),
                         a=float(_attr(pa, "semi_major_axis")), b=float(_attr(pa, "semi_minor_axis")),
                         sweep=str(_attr(pa, "sweep_angle_axis", "x")))
            vars_: dict[str, Var] = {}
            for name, v in f.items():
                if not isinstance(v, h5py.Dataset) or v.ndim != 2 or v.shape != (len(y), len(x)):
                    continue
                if v.chunks is None:
                    # Small files (the meso stability and water-vapour
                    # products) store a variable in one uncompressed block.
                    off = v.id.get_offset()
                    if off is None:
                        continue
                    filters: tuple[int, ...] = ()
                    chunk_shape = v.shape
                    chunks = {(0, 0): (int(off), int(v.id.get_storage_size()))}
                else:
                    plist = v.id.get_create_plist()
                    filters = tuple(plist.get_filter(i)[0] for i in range(plist.get_nfilters()))
                    chunk_shape = v.chunks
                    chunks = {}
                    for i in range(v.id.get_num_chunks()):
                        info = v.id.get_chunk_info(i)
                        chunks[tuple(info.chunk_offset)] = (info.byte_offset, info.size)
                a = v.attrs
                fill = _attr(a, "_FillValue")
                vars_[name] = Var(
                    name=name, shape=v.shape, dtype=v.dtype, chunk=chunk_shape, filters=filters, chunks=chunks,
                    scale=float(_attr(a, "scale_factor", 1.0)), offset=float(_attr(a, "add_offset", 0.0)),
                    fill=None if fill is None else float(fill),
                    unsigned=str(_attr(a, "_Unsigned", "false")).lower() == "true",
                )
        finally:
            f.close()
        m = FileMeta(bucket=bucket, key=key, size=size, x=x, y=y, geos=g, vars=vars_)
        with _META_LOCK:
            _META[ck] = m
            while len(_META) > 1500:
                _META.popitem(last=False)
        return m


# ---------------------------------------------------------------------------
# Strips, fetched and decoded
# ---------------------------------------------------------------------------
_STRIP_LOCK = threading.Lock()
# (bucket/key, var) -> {(row, col): decoded raw array}
_STRIPS: "OrderedDict[tuple[str, str], dict[tuple[int, int], np.ndarray]]" = OrderedDict()
_STRIP_BYTES = 0
STRIP_BUDGET = 900 * 1024 ** 2
_INFLIGHT: dict[tuple[str, str, tuple[int, int]], threading.Event] = {}


def _decode_chunk(v: Var, raw: bytes) -> np.ndarray:
    data = raw
    # Undo the pipeline back to front: checksum, deflate, shuffle.
    for fid in reversed(v.filters):
        if fid == 3:          # fletcher32
            data = data[:-4]
        elif fid == 1:        # deflate
            data = zlib.decompress(data)
        elif fid == 2:        # shuffle
            k = np.dtype(v.dtype).itemsize
            if k > 1:
                b = np.frombuffer(data, dtype=np.uint8)
                data = b.reshape(k, -1).T.copy().tobytes()
    arr = np.frombuffer(data, dtype=v.dtype).reshape(v.chunk)
    return arr


GROUP_BYTES = 1024 * 1024


def _groups(v: Var, wanted: list[tuple[int, int]]) -> list[list[tuple[int, int, tuple[int, int]]]]:
    """Chunks to fetch, as runs of neighbours up to a megabyte: about the
    best request size on this link (Google Cloud, 2026-09-26: 400 kB requests
    spent their time in TCP's slow start, 10-24 Mbit/s against 22-35)."""
    spans = sorted((v.chunks[c][0], v.chunks[c][1], c) for c in wanted if c in v.chunks)
    groups: list[list[tuple[int, int, tuple[int, int]]]] = []
    for off, size, c in spans:
        if groups:
            last = groups[-1]
            end = last[-1][0] + last[-1][1]
            if off - end < 48 * 1024 and (off + size - last[0][0]) < GROUP_BYTES:
                last.append((off, size, c))
                continue
        groups.append([(off, size, c)])
    return groups


def _fetch_group(m: FileMeta, v: Var, group) -> dict[tuple[int, int], np.ndarray]:
    start = group[0][0]
    end = group[-1][0] + group[-1][1] - 1
    body = _bytes(m.bucket, m.key, start, end)
    return {c: _decode_chunk(v, body[off - start: off - start + size]) for off, size, c in group}


def _store(m: FileMeta, v: Var, got: dict[tuple[int, int], np.ndarray]) -> None:
    global _STRIP_BYTES
    ck = (f"{m.bucket}/{m.key}", v.name)
    with _STRIP_LOCK:
        store = _STRIPS.setdefault(ck, {})
        for c, arr in got.items():
            if c not in store:
                store[c] = arr
                _STRIP_BYTES += arr.nbytes
        _STRIPS.move_to_end(ck)
        while _STRIP_BYTES > STRIP_BUDGET and len(_STRIPS) > 1:
            _k, old = _STRIPS.popitem(last=False)
            _STRIP_BYTES -= sum(a.nbytes for a in old.values())


def _needed(v: Var, r0: int, r1: int) -> list[tuple[int, int]]:
    ny, nx = v.shape
    ch_r, ch_c = v.chunk
    r0 = max(0, r0)
    r1 = min(ny, r1)
    return [(r, c) for r in range((r0 // ch_r) * ch_r, r1, ch_r) for c in range(0, nx, ch_c)]


def ensure(jobs: list[tuple[FileMeta, str, int, int]]) -> None:
    """Fetch every strip these (file, variable, rows) need that is not here,
    all at once across the variables -- one fetch per chunk however many
    pictures want it."""
    mine: list[tuple[FileMeta, Var, list[tuple[int, int]]]] = []
    waits: list[threading.Event] = []
    keys: list[tuple[str, str, tuple[int, int]]] = []
    with _STRIP_LOCK:
        for m, name, r0, r1 in jobs:
            v = m.vars[name]
            ck = (f"{m.bucket}/{m.key}", name)
            have = _STRIPS.get(ck, {})
            todo = []
            for c in _needed(v, r0, r1):
                if c in have or c not in v.chunks:
                    continue
                ik = (ck[0], name, c)
                ev = _INFLIGHT.get(ik)
                if ev is not None:
                    waits.append(ev)
                else:
                    _INFLIGHT[ik] = threading.Event()
                    keys.append(ik)
                    todo.append(c)
            if todo:
                mine.append((m, v, todo))
    try:
        futures = [(m, v, net.POOL.submit(_fetch_group, m, v, g)) for m, v, todo in mine for g in _groups(v, todo)]
        err: Optional[BaseException] = None
        for m, v, fut in futures:
            try:
                _store(m, v, fut.result())
            except BaseException as e:  # noqa: BLE001 - the rest still land
                err = e
        if err is not None:
            raise err
    finally:
        with _STRIP_LOCK:
            for ik in keys:
                ev = _INFLIGHT.pop(ik, None)
                if ev:
                    ev.set()
    for ev in waits:
        ev.wait(timeout=90)


def rows(m: FileMeta, name: str, r0: int, r1: int) -> np.ndarray:
    """Rows r0..r1 (exclusive) of a variable in physical units, NaN for fill."""
    v = m.vars[name]
    ny, nx = v.shape
    r0 = max(0, r0)
    r1 = min(ny, r1)
    ensure([(m, name, r0, r1)])
    ch_r, ch_c = v.chunk
    ck = (f"{m.bucket}/{m.key}", name)
    raw = np.empty((r1 - r0, nx), dtype=v.dtype)
    raw.fill(np.array(v.fill).astype(v.dtype) if v.fill is not None else 0)
    with _STRIP_LOCK:
        have = _STRIPS.get(ck, {})
        if ck in _STRIPS:
            _STRIPS.move_to_end(ck)
        for (cr, cc) in _needed(v, r0, r1):
            arr = have.get((cr, cc))
            if arr is None:
                continue
            a0 = max(r0, cr)
            a1 = min(r1, cr + ch_r)
            c1 = min(nx, cc + ch_c)
            raw[a0 - r0: a1 - r0, cc:c1] = arr[a0 - cr: a1 - cr, : c1 - cc]
    data = raw
    if v.unsigned and data.dtype.kind == "i":
        data = data.view(np.dtype(f"u{data.dtype.itemsize}"))
        fill_u = None if v.fill is None else int(v.fill) & ((1 << (8 * data.dtype.itemsize)) - 1)
    else:
        fill_u = v.fill
    out = data.astype("float32")
    if fill_u is not None:
        out[data == np.array(fill_u).astype(data.dtype)] = np.nan
    if v.scale != 1.0 or v.offset != 0.0:
        out = out * np.float32(v.scale) + np.float32(v.offset)
    return out


# ---------------------------------------------------------------------------
# Sampling onto a map picture
# ---------------------------------------------------------------------------
@dataclass
class Grid:
    fx: np.ndarray
    fy: np.ndarray
    r0: int
    r1: int


def grid_for(m: FileMeta, lon: np.ndarray, lat: np.ndarray) -> Optional[Grid]:
    sx, sy = geo.scan_angles(m.geos, lon, lat)
    dx = m.x[1] - m.x[0]
    dy = m.y[1] - m.y[0]
    fx = (sx - m.x[0]) / dx
    fy = (sy - m.y[0]) / dy
    ny, nx = len(m.y), len(m.x)
    inside = np.isfinite(fx) & np.isfinite(fy) & (fx > -1) & (fx < nx) & (fy > -1) & (fy < ny)
    if not inside.any():
        return None
    r0 = int(np.floor(np.nanmin(fy[inside]))) - 1
    r1 = int(np.ceil(np.nanmax(fy[inside]))) + 2
    return Grid(fx=fx, fy=fy - max(0, r0), r0=max(0, r0), r1=min(ny, r1))


def sample(m: FileMeta, name: str, g: Grid, categorical: bool = False) -> np.ndarray:
    block = rows(m, name, g.r0, g.r1)
    if categorical:
        return geo.nearest(block, g.fx, g.fy)
    return geo.smooth(block, g.fx, g.fy)


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
def _file_at(sat: str, folder: str, sector: str, when: datetime, band: Optional[int] = None,
             tolerance_s: int = 45) -> Optional[tuple[str, int]]:
    found = _files(sat, folder, sector, when - timedelta(seconds=tolerance_s),
                   when + timedelta(seconds=tolerance_s), band=band)
    if not found:
        return None
    best = min(found, key=lambda t: abs((t - when).total_seconds()))
    return found[best]


def _picture_km(lon: np.ndarray, lat: np.ndarray) -> float:
    """Ground size of one picture pixel at the middle of the box, km."""
    h, w = lon.shape
    mid = lat[h // 2, w // 2]
    dlon = abs(lon[h // 2, min(w - 1, w // 2 + 1)] - lon[h // 2, w // 2])
    return max(0.05, dlon * 111.32 * np.cos(np.radians(mid)))


def band_values(sat: str, sector: str, when: datetime, bands: list[int],
                lon: np.ndarray, lat: np.ndarray) -> dict[int, np.ndarray]:
    """Each band sampled onto the picture's pixels, physical units. The strips
    of every band are fetched together first."""
    found = _file_at(sat, "MCMIP", sector, when)
    if found is None:
        raise net.Missing(f"No GOES scan at {when:%H:%M:%S}Z")
    mm = meta(BUCKETS[sat], *found)
    g2 = grid_for(mm, lon, lat)
    km = _picture_km(lon, lat)
    plan: dict[int, tuple[FileMeta, str, Optional[Grid]]] = {}
    for b in bands:
        native = NATIVE_KM.get(b)
        # Finer than 2 km on screen, the visible bands come from their own files.
        if native and sector != "fd" and km < 1.6:
            nf = _file_at(sat, "CMIP", sector, when, band=b, tolerance_s=30)
            if nf is not None:
                nm = meta(BUCKETS[sat], *nf)
                gn = grid_for(nm, lon, lat)
                if gn is not None:
                    plan[b] = (nm, "CMI", gn)
                    continue
        plan[b] = (mm, f"CMI_C{b:02d}", g2)
    ensure([(m, name, g.r0, g.r1) for m, name, g in plan.values() if g is not None])
    out: dict[int, np.ndarray] = {}
    for b, (m, name, g) in plan.items():
        out[b] = np.full(lon.shape, np.nan, dtype="float32") if g is None else sample(m, name, g)
    return out


def render_band_or_rgb(sat: str, sector: str, pid: str, when: datetime,
                       lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """RGBA for a band ("c13") or an RGB recipe id, over a lon/lat grid."""
    if pid.startswith("c") and pid[1:].isdigit():
        b = int(pid[1:])
        vals = band_values(sat, sector, when, [b], lon, lat)
        img = rx.band_image(rx.ABI_ROLES[b], vals[b])
        valid = np.isfinite(vals[b])
    else:
        roles_avail = set(rx.ABI_ROLES.values())
        need = rx.recipe_roles(pid, roles_avail)
        if need is None:
            raise net.Missing(f"{pid} needs a band GOES does not carry")
        by_role = {r: b for b, r in rx.ABI_ROLES.items()}
        bands = sorted(by_role[r] for r in need)
        vals = band_values(sat, sector, when, bands, lon, lat)
        v = {rx.ABI_ROLES[b]: vals[b] for b in bands}
        sza = geo.solar_zenith(lon, lat, when) if rx.RECIPES[pid].needs_sun else None
        img = rx.RECIPES[pid].draw(v, sza)
        valid = np.ones(lon.shape, dtype=bool)
        for a in v.values():
            valid &= np.isfinite(a)
    rgb8 = (np.clip(np.nan_to_num(img, nan=0.0), 0.0, 1.0) * 255.0 + 0.5).astype("uint8")
    alpha = np.where(valid, 255.0, 0.0)
    fade = rx.night_alpha(pid, sza) if not (pid.startswith(("c", "b")) and pid[1:].isdigit()) else None
    if fade is not None:
        alpha = alpha * fade
    return np.dstack([rgb8, alpha.astype("uint8")])


# Products whose few pixels a picture must not lose between its samples: a
# fire is one 2 km pixel, and a CONUS picture's pixel is ten of them.
_SPARSE = {"fire_mask", "fire_power", "fire_temperature", "fire_area", "smoke", "dust_detection"}


def _sample_sparse(m: FileMeta, p: rx.L2, g: Grid) -> np.ndarray:
    """Nearest sampling after a maximum filter as wide as a picture pixel, so
    every fire and smoke pixel under the picture shows."""
    from scipy.ndimage import maximum_filter  # noqa: PLC0415

    block = rows(m, p.var, g.r0, g.r1)
    h, w = g.fx.shape
    mid = g.fx[h // 2]
    ok = np.isfinite(mid)
    step = float(np.nanmedian(np.abs(np.diff(mid[ok])))) if ok.sum() > 2 else 1.0
    size = int(np.ceil(step))
    if p.id == "fire_mask":
        # Rank the fire classes (good fire highest) so the filter keeps the surest.
        code = np.nan_to_num(block, nan=0.0)
        code = np.where((code >= 30) & (code <= 35), code - 20, code)
        rank = np.where((code >= 10) & (code <= 15), 16 - code, 0).astype("float32")
        if size > 1:
            rank = maximum_filter(rank, size=size)
        block = np.where(rank > 0, 16 - rank, np.nan).astype("float32")
    else:
        filled = np.nan_to_num(block, nan=-1e30)
        if size > 1:
            filled = maximum_filter(filled, size=size)
        block = np.where(filled > -1e29, filled, np.nan).astype("float32")
    out = geo.nearest(block, g.fx, g.fy)
    if p.id.startswith("fire") and step > 1.5:
        # A fire is a point: at least three picture pixels across, or it is
        # lost among the map's own lines.
        grown = maximum_filter(np.nan_to_num(out, nan=-1e30), size=3)
        out = np.where(np.isfinite(out), out, np.where(grown > -1e29, grown, np.nan)).astype("float32")
    return out


def l2_folder_sector(p: rx.L2, sector: str) -> str:
    """The sector whose files carry an L2 product: the meso boxes fall back to
    the full disk for the two the mesos do not publish."""
    letter = LETTER[sector]
    if letter in p.sectors:
        return sector
    return "fd" if "F" in p.sectors else "conus"


def l2_times(sat: str, sector: str, pid: str, count: int) -> list[datetime]:
    p = rx.L2_PRODUCTS[pid]
    return times(sat, l2_folder_sector(p, sector), p.folder, count)


def render_l2(sat: str, sector: str, pid: str, when: datetime,
              lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    p = rx.L2_PRODUCTS[pid]
    src = l2_folder_sector(p, sector)
    tol = 90 if src == sector else 400
    found = _file_at(sat, p.folder, src, when, tolerance_s=tol)
    if found is None:
        raise net.Missing(f"No {p.label} at {when:%H:%M}Z")
    m = meta(BUCKETS[sat], *found)
    g = grid_for(m, lon, lat)
    if g is None or p.var not in m.vars:
        return np.zeros(lon.shape + (4,), dtype="uint8")
    if p.id in _SPARSE:
        vals = _sample_sparse(m, p, g)
    else:
        vals = sample(m, p.var, g, categorical=p.kind == "category")
    vals = vals * p.scale + p.offset
    # The 10 km products carry a row and a column of edge values at the rim of
    # the sector (a line of "low cloud" along a meso box's edge): drop the rim.
    ny, nx = len(m.y), len(m.x)
    fyg = g.fy + g.r0
    rim = (g.fx < 0.5) | (g.fx > nx - 1.5) | (fyg < 0.5) | (fyg > ny - 1.5)
    vals = np.where(rim, np.nan, vals)
    if p.id in ("smoke", "dust_detection"):
        vals = np.where(vals == 1, 1.0, np.nan)
    elif p.id == "cloud_layer_flag":
        # A bit per layer (1 lowest ... 16 highest); 128 is no retrieval.
        code = np.nan_to_num(vals, nan=0.0).astype(np.int64)
        code = np.where(code >= 128, 0, code & 31)
        bits = sum(((code >> b) & 1) for b in range(5))
        top = np.zeros_like(code)
        for b in range(5):
            top = np.where((code >> b) & 1, b + 1, top)
        vals = np.where(bits == 0, np.nan, np.where(bits > 1, 6, top)).astype("float32")
    elif p.id == "clear_sky_mask":
        vals = np.where(vals >= 1, vals, np.nan)
    elif p.id == "cloud_top_phase":
        vals = np.where(vals >= 1, vals, np.nan)
    elif p.id == "cloud_layer_flag":
        vals = np.where(vals >= 1, vals, np.nan)
    elif p.id in ("fire_power", "fire_temperature", "fire_area"):
        vals = np.where(vals > 0, vals, np.nan)
    elif p.id == "snow_cover":
        vals = np.where((vals >= 0) & (vals <= 100), vals, np.nan)
    return rx.l2_colour(p, vals)


# ---------------------------------------------------------------------------
# Where the sectors are
# ---------------------------------------------------------------------------
_BOUNDS: dict[tuple[str, str], tuple[float, dict]] = {}


def sector_bounds(sat: str, sector: str) -> Optional[dict[str, float]]:
    """Lon/lat box of CONUS or a meso box now (the mesos move with the weather)."""
    ck = (sat, sector)
    hit = _BOUNDS.get(ck)
    ttl = 90 if sector.startswith("meso") else 86400
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    ts = times(sat, sector, "MCMIP", 2)
    if not ts:
        return hit[1] if hit else None
    found = _file_at(sat, "MCMIP", sector, ts[-1])
    if not found:
        return hit[1] if hit else None
    m = meta(BUCKETS[sat], *found)
    half = abs(m.x[1] - m.x[0]) / 2
    b = geo.box_bounds(m.geos, m.x.min() - half, m.x.max() + half, m.y.min() - half, m.y.max() + half)
    if b:
        _BOUNDS[ck] = (time.time(), b)
    return b


def meso_box_at(sat: str, sector: str, when: datetime) -> Optional[tuple[FileMeta, dict]]:
    found = _file_at(sat, "MCMIP", sector, when, tolerance_s=40)
    if not found:
        return None
    m = meta(BUCKETS[sat], *found)
    return m, {}
