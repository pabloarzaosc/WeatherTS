"""
Himawari-9, read from the files JMA's data reach NOAA's bucket as (noaa-himawari9).

Three kinds of file, one per region type:

  * Full disk: AHI-L2-FLDK-ISatSS/YYYY/MM/DD/HHMM/ -- NOAA's "sectorized" netCDF,
    each band cut into 88 tiles of a 10 x 10 grid (the 12 corner tiles are all
    space and left out), every 10 minutes. Only the tiles under a picture come.
    x / y are stored as whole-disk pixel indices with a scale and offset, in
    microradians; the view sweeps about y (as Meteosat), not x (as GOES).
  * Target: the same folder tree, in the folders between the ten-minute marks
    (OR_HR3-...), one 1000 km box every 2.5 minutes that JMA points at typhoons.
  * Japan: AHI-L1b-Japan/ -- JMA's own Himawari Standard Data (HSD), bzip2ed,
    four 2.5-minute scans per ten-minute folder (JP01-JP04). Counts in the
    file, calibration and navigation in its header blocks.

The link to this bucket is slower than to the GOES ones (about 10 Mbit/s), so
every file fetched is kept on disk.
"""
from __future__ import annotations

import bz2
import io
import re
import struct
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

import sat_geo as geo
import sat_net as net
import sat_recipes as rx

BUCKET = "https://noaa-himawari9.s3.amazonaws.com/"
GEOS = geo.Geos(140.7, 35785831.0, 6378137.0, 6356752.31414, "y")
_HSD_GEOS = geo.Geos(140.7, 35785863.0, 6378137.0, 6356752.3, "y")

# Tile number -> (grid row, grid column) of the full disk's 10 x 10 cut.
FD_TILES: dict[int, tuple[int, int]] = {}
_n = 1
for _r in range(10):
    _cols = range(2, 8) if _r in (0, 9) else range(1, 9) if _r in (1, 8) else range(10)
    for _c in _cols:
        FD_TILES[_n] = (_r, _c)
        _n += 1
FD_GRID = {v: k for k, v in FD_TILES.items()}
# Full-disk pixels per side at each band's resolution.
FD_SIZE = {1: 11000, 2: 11000, 3: 22000, 4: 11000}


def _fd_size(band: int) -> int:
    return FD_SIZE.get(band, 5500)


# ---------------------------------------------------------------------------
# Listings
# ---------------------------------------------------------------------------
_LIST_LOCK = threading.Lock()
_LISTS: "OrderedDict[str, tuple[float, list, list]]" = OrderedDict()


def _list(prefix: str, delimiter: bool, final: bool) -> tuple[list[str], list[tuple[str, int]]]:
    with _LIST_LOCK:
        hit = _LISTS.get(prefix)
        if hit and (final or time.time() - hit[0] < 40):
            return hit[1], hit[2]
    prefixes: list[str] = []
    keys: list[tuple[str, int]] = []
    token = None
    try:
        while True:
            params = {"list-type": "2", "prefix": prefix}
            if delimiter:
                params["delimiter"] = "/"
            if token:
                params["continuation-token"] = token
            text = net.get(BUCKET, params=params).text
            prefixes += re.findall(r"<Prefix>([^<]+)</Prefix>", text)
            keys += list(zip(re.findall(r"<Key>([^<]+)</Key>", text),
                             (int(s) for s in re.findall(r"<Size>(\d+)</Size>", text))))
            m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
            if not m:
                break
            token = m.group(1)
    except Exception:  # noqa: BLE001
        if hit:
            return hit[1], hit[2]
        return [], []
    prefixes = [p for p in prefixes if p != prefix]
    with _LIST_LOCK:
        _LISTS[prefix] = (time.time(), prefixes, keys)
        while len(_LISTS) > 800:
            _LISTS.popitem(last=False)
    return prefixes, keys


def _folders(product: str, since: datetime, until: datetime) -> list[datetime]:
    """Folder times (HHMM) of a product folder tree between two instants."""
    out = []
    day = since.replace(hour=0, minute=0, second=0, microsecond=0)
    now = datetime.now(timezone.utc)
    while day <= until:
        final = day + timedelta(days=1, hours=1) < now
        prefixes, _ = _list(f"{product}/{day:%Y/%m/%d}/", True, final)
        for p in prefixes:
            m = re.search(r"/(\d{4})/(\d{2})/(\d{2})/(\d{2})(\d{2})/$", p)
            if m:
                t = datetime(*(int(g) for g in m.groups()), tzinfo=timezone.utc)
                if since <= t <= until:
                    out.append(t)
        day += timedelta(days=1)
    return sorted(out)


def times(region: str, count: int) -> list[datetime]:
    now = datetime.now(timezone.utc)
    if region == "japan":
        folders = _folders("AHI-L1b-Japan", now - timedelta(minutes=10 * (count // 4 + 3)), now)
        out = []
        for f in folders[:-1]:
            out += [f + timedelta(seconds=150 * k) for k in range(4)]
        # The newest folder fills slot by slot.
        if folders:
            last = folders[-1]
            _, keys = _list(f"AHI-L1b-Japan/{last:%Y/%m/%d/%H%M}/", False, False)
            slots = {int(m.group(1)) for k, _ in keys if "_B13_" in k and (m := re.search(r"_JP0(\d)_", k))}
            out += [last + timedelta(seconds=150 * (s - 1)) for s in sorted(slots)]
        return out[-count:]
    folders = _folders("AHI-L2-FLDK-ISatSS", now - timedelta(minutes=(10 if region != "target" else 3) * (count + 4)), now)
    if region == "target":
        # Target scans live in the folders between the ten-minute marks, and
        # the newest is only whole once all sixteen bands have landed.
        tf = [f for f in folders if f.minute % 10 != 0]
        if tf:
            _, keys = _list(f"AHI-L2-FLDK-ISatSS/{tf[-1]:%Y/%m/%d/%H%M}/", False, False)
            if len(keys) < 16:
                tf = tf[:-1]
        return tf[-count:]
    fd = [f for f in folders if f.minute % 10 == 0]
    if fd:
        # The newest full disk is complete only once its last tiles land.
        _, keys = _list(f"AHI-L2-FLDK-ISatSS/{fd[-1]:%Y/%m/%d/%H%M}/", False, False)
        if len(keys) < 88 * 16:
            fd = fd[:-1]
    return fd[-count:]


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------
def _fetch(key: str) -> bytes:
    data = net.disk_get("ahi", key)
    if data is None:
        data = net.get(BUCKET + key, tries=3, timeout=(8, 60)).content
        net.disk_put("ahi", key, data)
    return data


@dataclass
class Piece:
    """One decoded array with the scan angles of its pixel centres."""
    values: np.ndarray          # physical units, NaN missing
    x: np.ndarray               # radians, per column
    y: np.ndarray               # radians, per row


_PIECE_LOCK = threading.Lock()
_PIECES: "OrderedDict[str, Optional[Piece]]" = OrderedDict()
_PIECE_BYTES = 0
PIECE_BUDGET = 700 * 1024 ** 2
_PIECE_FLIGHT: dict[str, threading.Event] = {}


def _decode_isatss(data: bytes) -> Piece:
    import h5py  # noqa: PLC0415

    f = h5py.File(io.BytesIO(data), "r")
    try:
        v = f["Sectorized_CMI"]
        raw = v[:]
        s = float(np.asarray(v.attrs.get("scale_factor", [1.0])).ravel()[0])
        o = float(np.asarray(v.attrs.get("add_offset", [0.0])).ravel()[0])
        fill = v.attrs.get("_FillValue")
        vals = raw.astype("float32") * np.float32(s) + np.float32(o)
        if fill is not None:
            vals[raw == np.asarray(fill).ravel()[0]] = np.nan
        vals[raw < 0] = np.nan

        def coord(name: str) -> np.ndarray:
            c = f[name]
            cs = float(np.asarray(c.attrs["scale_factor"]).ravel()[0])
            co = float(np.asarray(c.attrs["add_offset"]).ravel()[0])
            return (c[:].astype("float64") * cs + co) * 1e-6

        # NOAA's sectorized files put pixel r at the angle of pixel r - 1 (their
        # full-disk centre is index 2750.5 where JMA's navigation, COFF 2750.5
        # counted from 1, puts it at 2749.5 counted from 0): everything lands a
        # pixel north-west, and the 0.5 km band half a kilometre off the 1 km
        # ones -- colour fringes on every cloud in true colour. One pixel east
        # and south puts it where JMA's own HSD files and the coast agree.
        x = coord("x")
        y = coord("y")
        return Piece(values=vals, x=x + (x[1] - x[0]), y=y + (y[1] - y[0]))
    finally:
        f.close()


# HSD calibration: radiance to brightness temperature.
_H = 6.62606957e-34
_C = 299792458.0
_K = 1.3806488e-23


def _decode_hsd(data: bytes) -> Piece:
    raw = bz2.decompress(data)
    p = struct.unpack("<H", raw[1:3])[0]
    b2 = raw[p:]
    ncol, nline = struct.unpack("<HH", b2[5:9])
    p += struct.unpack("<H", b2[1:3])[0]
    b3 = raw[p:]
    cfac, lfac = struct.unpack("<II", b3[11:19])
    coff, loff = struct.unpack("<ff", b3[19:27])
    p += struct.unpack("<H", b3[1:3])[0]
    p += struct.unpack("<H", raw[p + 1:p + 3])[0]                     # block 4
    b5 = raw[p:]
    band = struct.unpack("<H", b5[3:5])[0]
    wl_um = struct.unpack("<d", b5[5:13])[0]
    vbits, err, out = struct.unpack("<HHH", b5[13:19])
    gain, off = struct.unpack("<dd", b5[19:35])
    extra = struct.unpack("<9d", b5[35:107])
    total_hdr = struct.unpack("<I", raw[70:74])[0]
    counts = np.frombuffer(raw, dtype="<u2", count=ncol * nline, offset=total_hdr).reshape(nline, ncol)
    bad = (counts >= err) | (counts == out) | (counts >= (1 << vbits))
    if band <= 6:
        slope, icpt = (extra[2], extra[3]) if extra[2] else (gain, off)
        rad = counts.astype("float64") * slope + icpt
        vals = rad * extra[0]                                           # albedo, 0-1
    else:
        rad = counts.astype("float64") * gain + off                    # W m-2 sr-1 um-1
        lam = wl_um * 1e-6
        rad_si = np.maximum(rad, 1e-9) * 1e6
        te = _H * _C / (_K * lam * np.log(2 * _H * _C * _C / (lam ** 5 * rad_si) + 1.0))
        vals = extra[0] + extra[1] * te + extra[2] * te * te
    vals = vals.astype("float32")
    vals[bad] = np.nan
    cols = np.arange(1, ncol + 1, dtype="float64")
    lines = np.arange(1, nline + 1, dtype="float64")
    x = np.radians((cols - coff) * 65536.0 / cfac)
    # CGMS lines run south; the projection's y runs north.
    y = -np.radians((lines - loff) * 65536.0 / lfac)
    return Piece(values=vals, x=x, y=y)


def _piece(key: str, kind: str) -> Optional[Piece]:
    global _PIECE_BYTES
    while True:
        with _PIECE_LOCK:
            if key in _PIECES:
                _PIECES.move_to_end(key)
                return _PIECES[key]
            ev = _PIECE_FLIGHT.get(key)
            if ev is None:
                _PIECE_FLIGHT[key] = threading.Event()
                break
        ev.wait(timeout=120)
    piece: Optional[Piece] = None
    try:
        try:
            data = _fetch(key)
            piece = _decode_hsd(data) if kind == "hsd" else _decode_isatss(data)
        except net.Missing:
            piece = None
    finally:
        with _PIECE_LOCK:
            _PIECES[key] = piece
            if piece is not None:
                _PIECE_BYTES += piece.values.nbytes
            while _PIECE_BYTES > PIECE_BUDGET and len(_PIECES) > 1:
                _k, old = _PIECES.popitem(last=False)
                if old is not None:
                    _PIECE_BYTES -= old.values.nbytes
            ev = _PIECE_FLIGHT.pop(key, None)
        if ev:
            ev.set()
    return piece


def _sample_piece(pc: Piece, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    fx = (sx - pc.x[0]) / (pc.x[1] - pc.x[0])
    fy = (sy - pc.y[0]) / (pc.y[1] - pc.y[0])
    return geo.smooth(pc.values, fx, fy)


# The whole-disk pixel of a scan angle, per resolution: read off tile 45's
# coordinates once (all tiles share one scale and offset).
_FD_AXES: dict[int, tuple[float, float, float, float]] = {}


def _fd_axes(when: datetime, band: int, keys: dict[int, str]) -> Optional[tuple[float, float, float, float]]:
    n = _fd_size(band)
    if n in _FD_AXES:
        return _FD_AXES[n]
    key = keys.get(45) or next(iter(keys.values()), None)
    if key is None:
        return None
    pc = _piece(key, "isatss")
    if pc is None:
        return None
    tile = n // 10
    r, c = FD_TILES[int(re.search(r"-T(\d{3})_", key).group(1))]
    dx = pc.x[1] - pc.x[0]
    dy = pc.y[1] - pc.y[0]
    x0 = pc.x[0] - c * tile * dx
    y0 = pc.y[0] - r * tile * dy
    _FD_AXES[n] = (x0, dx, y0, dy)
    return _FD_AXES[n]


def _band_keys(folder_keys: list[tuple[str, int]], band: int, prefix: str) -> dict[int, str]:
    out = {}
    tag = f"-M1C{band:02d}-T"
    for k, _s in folder_keys:
        name = k.rsplit("/", 1)[-1]
        if name.startswith(prefix) and tag in name:
            m = re.search(r"-T(\d{3})_", name)
            if m:
                out[int(m.group(1))] = k
    return out


def _fd_band(when: datetime, band: int, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    folder = f"AHI-L2-FLDK-ISatSS/{when:%Y/%m/%d/%H%M}/"
    _, keys = _list(folder, False, when < datetime.now(timezone.utc) - timedelta(minutes=40))
    bkeys = _band_keys(keys, band, "OR_HFD-")
    if not bkeys:
        raise net.Missing(f"No Himawari full disk band {band} at {when:%H:%M}Z")
    axes = _fd_axes(when, band, bkeys)
    out = np.full(sx.shape, np.nan, dtype="float32")
    if axes is None:
        return out
    x0, dx, y0, dy = axes
    n = _fd_size(band)
    tile = n // 10
    col = (sx - x0) / dx
    row = (sy - y0) / dy
    ok = np.isfinite(col) & np.isfinite(row)
    if not ok.any():
        return out
    tr = np.clip(np.floor(row[ok] / tile), 0, 9).astype(int)
    tc = np.clip(np.floor(col[ok] / tile), 0, 9).astype(int)
    wanted = sorted({(int(a), int(b)) for a, b in zip(tr, tc)} & set(FD_GRID))
    todo = [(rc, bkeys[FD_GRID[rc]]) for rc in wanted if FD_GRID[rc] in bkeys]
    pieces = dict(zip([rc for rc, _ in todo], net.POOL.map(lambda t: _piece(t[1], "isatss"), todo)))
    for rc, pc in pieces.items():
        if pc is None:
            continue
        v = _sample_piece(pc, sx, sy)
        take = np.isfinite(v)
        out[take] = v[take]
    return out


def _target_band(when: datetime, band: int, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    folder = f"AHI-L2-FLDK-ISatSS/{when:%Y/%m/%d/%H%M}/"
    _, keys = _list(folder, False, when < datetime.now(timezone.utc) - timedelta(minutes=40))
    bkeys = _band_keys(keys, band, "OR_HR3-")
    if not bkeys:
        raise net.Missing(f"No Himawari target band {band} at {when:%H:%M}Z")
    pc = _piece(next(iter(bkeys.values())), "isatss")
    if pc is None:
        raise net.Missing("Himawari target file unreadable")
    return _sample_piece(pc, sx, sy)


def _japan_band(when: datetime, band: int, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    folder_t = when.replace(minute=(when.minute // 10) * 10, second=0)
    slot = int((when - folder_t).total_seconds() // 150) + 1
    folder = f"AHI-L1b-Japan/{folder_t:%Y/%m/%d/%H%M}/"
    _, keys = _list(folder, False, when < datetime.now(timezone.utc) - timedelta(minutes=40))
    key = next((k for k, _ in keys if f"_B{band:02d}_JP0{slot}_" in k), None)
    if key is None:
        raise net.Missing(f"No Himawari Japan band {band} at {when:%H:%M}Z")
    pc = _piece(key, "hsd")
    if pc is None:
        raise net.Missing("Himawari Japan file unreadable")
    return _sample_piece(pc, sx, sy)


def band_values(region: str, when: datetime, bands: list[int], lon: np.ndarray, lat: np.ndarray) -> dict[int, np.ndarray]:
    g = _HSD_GEOS if region == "japan" else GEOS
    sx, sy = geo.scan_angles(g, lon, lat)
    fn = _japan_band if region == "japan" else _target_band if region == "target" else _fd_band
    results = list(net.BANDS.map(lambda b: fn(when, b, sx, sy), bands)) if len(bands) > 1 else [fn(when, bands[0], sx, sy)]
    return dict(zip(bands, results))


def render(region: str, pid: str, when: datetime, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    if pid.startswith("b") and pid[1:].isdigit():
        b = int(pid[1:])
        v = band_values(region, when, [b], lon, lat)[b]
        img = rx.band_image(rx.AHI_ROLES[b], v)
        valid = np.isfinite(v)
    else:
        need = rx.recipe_roles(pid, set(rx.AHI_ROLES.values()))
        if need is None:
            raise net.Missing(f"{pid} needs a band Himawari does not carry")
        by_role = {r: b for b, r in rx.AHI_ROLES.items()}
        bands = sorted(by_role[r] for r in need)
        vals = band_values(region, when, bands, lon, lat)
        v = {rx.AHI_ROLES[b]: vals[b] for b in bands}
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


_BOUNDS: dict[str, tuple[float, dict]] = {}


def region_bounds(region: str) -> Optional[dict[str, float]]:
    """Where the target box is now (it moves); Japan is fixed in the catalogue."""
    if region != "target":
        return None
    hit = _BOUNDS.get(region)
    if hit and time.time() - hit[0] < 120:
        return hit[1]
    ts = times("target", 1)
    if not ts:
        return hit[1] if hit else None
    folder = f"AHI-L2-FLDK-ISatSS/{ts[-1]:%Y/%m/%d/%H%M}/"
    _, keys = _list(folder, False, False)
    bkeys = _band_keys(keys, 13, "OR_HR3-")
    if not bkeys:
        return hit[1] if hit else None
    pc = _piece(next(iter(bkeys.values())), "isatss")
    if pc is None:
        return hit[1] if hit else None
    b = geo.box_bounds(GEOS, float(pc.x.min()), float(pc.x.max()), float(pc.y.min()), float(pc.y.max()))
    if b:
        _BOUNDS[region] = (time.time(), b)
    return b


def target_layout(when: datetime):
    """SLIDER's target tiles (500 px at 2 km, zoom 0) placed with the grid of
    NOAA's file of the nearest target scan."""
    import sat_slider as sl  # noqa: PLC0415

    folders = [f for f in _folders("AHI-L2-FLDK-ISatSS", when - timedelta(minutes=6), when + timedelta(minutes=4))
               if f.minute % 10 != 0]
    if not folders:
        raise net.Missing(f"No Himawari target scan near {when:%H:%M}Z to place the picture")
    best = min(folders, key=lambda f: abs((f - when).total_seconds()))
    _, keys = _list(f"AHI-L2-FLDK-ISatSS/{best:%Y/%m/%d/%H%M}/", False, True)
    bkeys = _band_keys(keys, 13, "OR_HR3-")
    if not bkeys:
        raise net.Missing("Himawari target file not listed yet")
    pc = _piece(next(iter(bkeys.values())), "isatss")
    if pc is None:
        raise net.Missing("Himawari target file unreadable")
    dx = pc.x[1] - pc.x[0]
    dy = pc.y[1] - pc.y[0]
    ext = (float(pc.x[0] - dx / 2), float(pc.x[-1] + dx / 2), float(pc.y[0] - dy / 2), float(pc.y[-1] + dy / 2))
    return sl.Layout(500, 2, GEOS, ext, 500, 500)


_JAPAN_MASK: Optional[Piece] = None


def japan_mask():
    """Where JMA's Japan area has data: two rectangles offset from each other,
    inside the rectangle its files and SLIDER's tiles span (the rest is fill,
    black in SLIDER's pictures). Read once from a small band 13 file."""
    global _JAPAN_MASK
    if _JAPAN_MASK is None:
        now = datetime.now(timezone.utc)
        for f in reversed(_folders("AHI-L1b-Japan", now - timedelta(hours=2), now)):
            _, keys = _list(f"AHI-L1b-Japan/{f:%Y/%m/%d/%H%M}/", False, True)
            key = next((k for k, _ in keys if "_B13_JP01_" in k), None)
            if key:
                pc = _piece(key, "hsd")
                if pc is not None:
                    _JAPAN_MASK = Piece(values=np.isfinite(pc.values).astype("float32"), x=pc.x, y=pc.y)
                    break
    m = _JAPAN_MASK

    def inside(sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
        if m is None:
            return np.ones(sx.shape, dtype=bool)
        fx = (sx - m.x[0]) / (m.x[1] - m.x[0])
        fy = (sy - m.y[0]) / (m.y[1] - m.y[0])
        return geo.nearest(m.values, fx, fy, fill=0.0) > 0.5

    return inside
