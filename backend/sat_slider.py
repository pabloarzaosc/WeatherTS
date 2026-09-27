"""
Imagery from RAMMB/CIRA SLIDER (slider.cira.colostate.edu), redrawn onto the map.

SLIDER is NOAA-funded research imagery from CIRA at Colorado State: every band
and most RGB composites of GOES-19, GOES-18, Himawari-9, Meteosat-12 (MTG),
Meteosat-9 and Meteosat-10, as tile pyramids in each satellite's own fixed
grid. Two things make it the cheapest way to show those products here:

  * The pyramid. A whole disk at zoom 0 is one 680 px tile; zoomed in, only the
    tiles under the view come. The same picture from the raw files would cost
    the whole scan's strips (see sat_abi) -- five to ten times the bytes on a
    link that tops out at 25 Mbit/s.
  * The tiles are on the satellites' fixed grids exactly (a GOES full disk at
    zoom 5 is 21696 px, the ABI's 0.5 km grid; Meteosat-12's is FCI's 22272), so
    they go back onto the map through the same projection as the raw data.

It has no CORS headers, which is why the map could not use it directly; the
backend fetches the tiles, keeps them, and draws Web Mercator pictures.
"""
from __future__ import annotations

import io
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import numpy as np

import sat_geo as geo
import sat_net as net

BASE = "https://slider.cira.colostate.edu"


@dataclass(frozen=True)
class Layout:
    """How a SLIDER sector's image sits on its satellite's fixed grid.

    At zoom z the image is `tile * 2**z` pixels square; the data fill
    `rows` x `cols` of it at zoom 0 (scaled by 2**z), starting `top` rows down.
    `extent` gives the scan angles (radians) of the data's outer edges:
    x_min, x_max, y_max (top), y_min (bottom)."""
    tile: int
    max_zoom: int
    geos: geo.Geos
    extent: tuple[float, float, float, float]
    cols: float
    rows: float
    top: float = 0.0
    left: float = 0.0


# Fixed grids (satpy's area definitions, and the GOES files' own x/y).
_ABI_H = 35786023.0
_ABI_FD = 0.151872
LAYOUTS: dict[tuple[str, str], Layout] = {
    ("goes-19", "full_disk"): Layout(678, 5, geo.Geos(-75.0, _ABI_H), (-_ABI_FD, _ABI_FD, _ABI_FD, -_ABI_FD), 678, 678),
    ("goes-18", "full_disk"): Layout(678, 5, geo.Geos(-137.0, _ABI_H), (-_ABI_FD, _ABI_FD, _ABI_FD, -_ABI_FD), 678, 678),
    ("himawari", "full_disk"): Layout(
        688, 5, geo.Geos(140.7, 35785863.0, 6378137.0, 6356752.3, "y"),
        tuple(v / 35785863.0 for v in (-5500000.0355, 5500000.0355, 5500000.0355, -5500000.0355)), 687.5, 687.5,
        top=0.25, left=0.25),
    ("meteosat-12", "full_disk"): Layout(
        696, 5, geo.Geos(0.0, 35786400.0, 6378137.0, 6356752.314, "y"),
        tuple(v / 35786400.0 for v in (-5567999.9942, 5567999.9942, 5567999.9942, -5567999.9942)), 696, 696),
    ("meteosat-9", "full_disk"): Layout(
        464, 3, geo.Geos(45.5, 35785831.0, 6378169.0, 6356583.8, "y"),
        tuple(v / 35785831.0 for v in (-5570248.6867, 5567248.2834, 5570248.6867, -5567248.2834)), 464, 464),
}


def conus_layout(sat: str, x: tuple[float, float], y: tuple[float, float]) -> Layout:
    """GOES CONUS: 10000 x 6000 at zoom 4 (the 0.5 km grid), centred in the
    625 px squares -- 125 rows of padding at zoom 0 above it."""
    lon0 = -75.0 if sat == "goes-19" else -137.0
    return Layout(625, 4, geo.Geos(lon0, _ABI_H), (x[0], x[1], y[0], y[1]), 625, 375, top=125)


def meso_layout(sat: str, x: tuple[float, float], y: tuple[float, float]) -> Layout:
    lon0 = -75.0 if sat == "goes-19" else -137.0
    return Layout(500, 2, geo.Geos(lon0, _ABI_H), (x[0], x[1], y[0], y[1]), 500, 500)


# ---------------------------------------------------------------------------
# Times
# ---------------------------------------------------------------------------
_TIMES_LOCK = threading.Lock()
_TIMES: dict[str, tuple[float, list[int]]] = {}


def _json(url: str, ttl: float) -> Optional[dict]:
    with _TIMES_LOCK:
        hit = _TIMES.get(url)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]  # type: ignore[return-value]
    try:
        data = net.get(url, tries=2).json()
    except Exception:  # noqa: BLE001 - keep the last answer
        return hit[1] if hit else None  # type: ignore[return-value]
    with _TIMES_LOCK:
        _TIMES[url] = (time.time(), data)  # type: ignore[assignment]
    return data


def _ts(i: int) -> datetime:
    return datetime.strptime(str(i), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def times(sat: str, sector: str, product: str, count: int) -> list[datetime]:
    """The newest `count` times of a product, oldest first. SLIDER lists its
    last hundred; past that, day by day."""
    latest = _json(f"{BASE}/data/json/{sat}/{sector}/{product}/latest_times.json", 60) or {}
    got = sorted({int(t) for t in latest.get("timestamps_int", [])})
    if len(got) < count:
        dates = _json(f"{BASE}/data/json/{sat}/{sector}/{product}/available_dates.json", 600) or {}
        for d in sorted(dates.get("dates_int", []), reverse=True)[:6]:
            today = str(d) == datetime.now(timezone.utc).strftime("%Y%m%d")
            day = _json(f"{BASE}/data/json/{sat}/{sector}/{product}/{d}_by_hour.json", 60 if today else 86400) or {}
            for hour in (day.get("timestamps_int") or {}).values():
                got.extend(int(t) for t in hour)
            got = sorted(set(got))
            if len(got) >= count:
                break
    return [_ts(t) for t in got[-count:]]


# ---------------------------------------------------------------------------
# Tiles
# ---------------------------------------------------------------------------
_TILE_LOCK = threading.Lock()
_TILES: "OrderedDict[str, Optional[np.ndarray]]" = OrderedDict()
_TILE_BYTES = 0
TILE_BUDGET = 600 * 1024 ** 2
_TILE_FLIGHT: dict[str, threading.Event] = {}


def _tile_url(sat: str, sector: str, product: str, when: datetime, z: int, r: int, c: int) -> str:
    ts = when.strftime("%Y%m%d%H%M%S")
    return (f"{BASE}/data/imagery/{ts[:4]}/{ts[4:6]}/{ts[6:8]}/{sat}---{sector}/{product}/{ts}/"
            f"{z:02d}/{r:03d}_{c:03d}.png")


class Tile:
    """A SLIDER tile: palette indices and the palette for the band products
    (the index is the data), plain RGB for the composites."""
    __slots__ = ("idx", "pal", "rgb", "nbytes", "shape")

    def __init__(self, idx=None, pal=None, rgb=None):
        self.idx = idx
        self.pal = pal
        self.rgb = rgb
        arr = idx if idx is not None else rgb
        self.nbytes = arr.nbytes
        self.shape = arr.shape


def _decode_tile(data: bytes) -> Tile:
    from PIL import Image  # noqa: PLC0415

    img = Image.open(io.BytesIO(data))
    if img.mode == "P":
        pal = np.array(img.getpalette()[: 256 * 3], dtype="uint8").reshape(-1, 3)
        if len(pal) < 256:
            pal = np.vstack([pal, np.zeros((256 - len(pal), 3), dtype="uint8")])
        return Tile(idx=np.asarray(img), pal=pal)
    return Tile(rgb=np.asarray(img.convert("RGB")))


def tile(sat: str, sector: str, product: str, when: datetime, z: int, r: int, c: int) -> Optional[Tile]:
    """One tile (None where SLIDER has no tile)."""
    global _TILE_BYTES
    url = _tile_url(sat, sector, product, when, z, r, c)
    while True:
        with _TILE_LOCK:
            if url in _TILES:
                _TILES.move_to_end(url)
                return _TILES[url]
            ev = _TILE_FLIGHT.get(url)
            if ev is None:
                _TILE_FLIGHT[url] = threading.Event()
                break
        ev.wait(timeout=60)
    arr: Optional[Tile] = None
    try:
        data = net.disk_get("slider", url)
        if data is None:
            try:
                data = net.get(url, tries=3).content
                net.disk_put("slider", url, data)
            except net.Missing:
                data = b""
        if data:
            arr = _decode_tile(data)
    finally:
        with _TILE_LOCK:
            _TILES[url] = arr
            if arr is not None:
                _TILE_BYTES += arr.nbytes
            while _TILE_BYTES > TILE_BUDGET and len(_TILES) > 1:
                _u, old = _TILES.popitem(last=False)
                if old is not None:
                    _TILE_BYTES -= old.nbytes
            ev = _TILE_FLIGHT.pop(url, None)
        if ev:
            ev.set()
    return arr


# ---------------------------------------------------------------------------
# Drawing a map picture
# ---------------------------------------------------------------------------
# How much finer than the picture the tiles are taken, in zoom levels: at 0 a
# picture pixel covers one to two data pixels, shrunk with an anti-alias
# filter (sat_geo.smooth) the way a GPU's mipmaps draw a big texture small.
# One level finer (2 km on the default CONUS view) looked the same side by
# side at the screen's density and cost four times the bytes -- 16 s instead
# of 6 for a GeoColor frame on SLIDER's ~14 Mbit/s (measured 2026-09-26).
ZOOM_BIAS = 0.0


def pick_zoom(layout: Layout, u: np.ndarray, w: int, zoom_adjust: int) -> int:
    """The pyramid level for a picture `w` pixels wide; `u` is each picture
    pixel's place across the data (0-1). A 2 km band stops `zoom_adjust`
    levels short of the sector's deepest zoom (SLIDER's own limit)."""
    h = u.shape[0]
    need = w / layout.cols
    # Picture pixels per data pixel at zoom 0, across the middle row -- over
    # the pixels the satellite sees, not the whole row: zoomed out to the
    # world, the disk is under half the picture's width, and counting the
    # whole row fetched a level finer (four times the tiles) than it shows.
    for r in (h // 2, h // 3, (2 * h) // 3):
        row = u[r]
        seen = np.isfinite(row)
        n = int(seen.sum())
        if n > 2:
            uu = row[seen]
            span0 = (uu.max() - uu.min()) * layout.cols
            if span0 > 0:
                need = n / span0
                break
    need = max(1.0, need)
    return int(np.clip(np.ceil(np.log2(need) + ZOOM_BIAS), 0, max(0, layout.max_zoom - zoom_adjust)))


def plan(layout: Layout, lon: np.ndarray, lat: np.ndarray, zoom_adjust: int = 0,
         coarse: bool = False) -> tuple[int, list[tuple[int, int]]]:
    """The level and the tiles (row, column) `render` and `values` read for
    this picture -- for a loop to fetch them all ahead of the drawing."""
    sx, sy = geo.scan_angles(layout.geos, lon, lat)
    x0, x1, ytop, ybot = layout.extent
    u = (sx - x0) / (x1 - x0)
    v = (ytop - sy) / (ytop - ybot)
    inside = np.isfinite(u) & np.isfinite(v) & (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    if not inside.any():
        return 0, []
    z = pick_zoom(layout, u, lon.shape[1], zoom_adjust)
    if coarse:
        z = max(0, z - 1)
    scale = 2 ** z
    px = (layout.left + u[inside] * layout.cols) * scale - 0.5
    py = (layout.top + v[inside] * layout.rows) * scale - 0.5
    c0 = max(0, int(np.floor(px.min() / layout.tile)))
    c1 = min(scale - 1, int(np.floor(px.max() / layout.tile)))
    r0 = max(0, int(np.floor(py.min() / layout.tile)))
    r1 = min(scale - 1, int(np.floor(py.max() / layout.tile)))
    return z, [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


def zoom_at(layout: Layout, lon: np.ndarray, lat: np.ndarray, zoom_adjust: int = 0) -> int:
    """The level `render` would take for this picture."""
    sx, _sy = geo.scan_angles(layout.geos, lon, lat)
    x0, x1, _yt, _yb = layout.extent
    return pick_zoom(layout, (sx - x0) / (x1 - x0), lon.shape[1], zoom_adjust)


def _padding(layout: Layout, scale: int, r0: int, c0: int, hh: int, ww: int) -> np.ndarray:
    """True where a mosaic of tiles r0.., c0.. holds the pyramid's padding
    rather than data -- NaN there, so the shrink filter does not smear a dark
    rim along the sector's edge."""
    rows = np.arange(hh) + r0 * layout.tile
    cols = np.arange(ww) + c0 * layout.tile
    in_r = (rows >= layout.top * scale) & (rows < (layout.top + layout.rows) * scale)
    in_c = (cols >= layout.left * scale) & (cols < (layout.left + layout.cols) * scale)
    return ~(in_r[:, None] & in_c[None, :])


def render(sat: str, sector: str, product: str, when: datetime, layout: Layout,
           lon: np.ndarray, lat: np.ndarray, zoom_adjust: int = 0,
           mask: Optional[Callable] = None, coarse: bool = False) -> np.ndarray:
    """RGBA of the product over a lon/lat grid, from the pyramid level
    `pick_zoom` chooses -- or one level down for a quick first picture (a
    quarter of the bytes), which the sharp one replaces."""
    sx, sy = geo.scan_angles(layout.geos, lon, lat)
    x0, x1, ytop, ybot = layout.extent
    # Position within the data, 0-1 across and down.
    u = (sx - x0) / (x1 - x0)
    v = (ytop - sy) / (ytop - ybot)
    inside = np.isfinite(u) & np.isfinite(v) & (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    h, w = lon.shape
    out = np.zeros((h, w, 4), dtype="uint8")
    if not inside.any():
        return out
    z = pick_zoom(layout, u, w, zoom_adjust)
    if coarse:
        z = max(0, z - 1)
    scale = 2 ** z
    size = layout.tile * scale
    px = (layout.left + u * layout.cols) * scale - 0.5
    py = (layout.top + v * layout.rows) * scale - 0.5
    ok = inside
    c0 = int(np.floor(np.nanmin(px[ok]) / layout.tile)) if ok.any() else 0
    c1 = int(np.floor(np.nanmax(px[ok]) / layout.tile))
    r0 = int(np.floor(np.nanmin(py[ok]) / layout.tile))
    r1 = int(np.floor(np.nanmax(py[ok]) / layout.tile))
    n = size // layout.tile
    c0, c1 = max(0, c0), min(n - 1, c1)
    r0, r1 = max(0, r0), min(n - 1, r1)
    jobs = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    tiles = dict(zip(jobs, net.POOL.map(lambda rc: tile(sat, sector, product, when, z, rc[0], rc[1]), jobs)))
    if all(t is None for t in tiles.values()):
        raise net.Missing(f"SLIDER has no {product} at {when:%H:%M}Z")
    present = [t for t in tiles.values() if t is not None]
    paletted = all(t.idx is not None for t in present)
    hh = (r1 - r0 + 1) * layout.tile
    ww = (c1 - c0 + 1) * layout.tile
    have = np.zeros((hh, ww), dtype=bool)
    if paletted:
        # A band: its tiles hold the data (McIDAS counts) and a colour table.
        # Interpolating the data and colouring afterwards keeps each colour
        # band's edge a smooth curve; blending the colours themselves smeared
        # navy into green and left 2 km steps at every edge.
        mosaic = np.full((hh, ww), np.nan, dtype="float32")
    else:
        mosaic = np.full((hh, ww, 3), np.nan, dtype="float32")
    for (r, c), t in tiles.items():
        if t is None:
            continue
        th, tw = t.shape[:2]
        th, tw = min(th, layout.tile), min(tw, layout.tile)
        y0 = (r - r0) * layout.tile
        x0_ = (c - c0) * layout.tile
        src = t.idx if paletted else t.rgb
        mosaic[y0:y0 + th, x0_:x0_ + tw] = src[:th, :tw]
        have[y0:y0 + th, x0_:x0_ + tw] = True
    mosaic[_padding(layout, scale, r0, c0, hh, ww)] = np.nan
    fx = np.where(ok, px - c0 * layout.tile, np.nan)
    fy = np.where(ok, py - r0 * layout.tile, np.nan)
    sampled = geo.smooth(mosaic, fx, fy)
    if paletted:
        # Between two counts, between their two colours: the counts are whole
        # kelvin (half a kelvin above 242 K), and rounding them showed as
        # terraces of flat colour once zoomed in.
        pal = present[0].pal.astype("float32")
        fi = np.clip(np.nan_to_num(sampled, nan=0.0), 0.0, 255.0)
        i0 = np.floor(fi).astype(np.int64)
        i1 = np.minimum(i0 + 1, 255)
        f = (fi - i0)[..., None].astype("float32")
        rgb = pal[i0] * (1.0 - f) + pal[i1] * f
        finite = np.isfinite(sampled)
    else:
        rgb = sampled
        finite = np.isfinite(rgb[..., 0])
    got = geo.nearest(have.astype("float32"), fx, fy, fill=0.0) > 0.5
    valid = ok & got & finite
    if mask is not None:
        valid &= mask(sx, sy)
    out[..., :3] = np.clip(np.nan_to_num(rgb, nan=0.0) + 0.5, 0, 255).astype("uint8")
    out[..., 3] = np.where(valid, 255, 0)
    return out


# ---------------------------------------------------------------------------
# Values, not colours: SLIDER's band tiles as brightness temperature and
# reflectance, for the RGBs it does not make itself
# ---------------------------------------------------------------------------
#
# A band tile is an 8-bit palette image whose index is the scaled data, the
# colour table only dresses it. Measured 2026-09-26 against the raw GOES and
# Himawari files on the same pixels (and against each other where Meteosat-12
# overlaps GOES-19 and Meteosat-9 overlaps Himawari -- within 1.5 K):
#
#   infrared   McIDAS brightness counts: T = 330 - i/2 above 242 K, 418 - i below
#   water vap. the same above 242 K, 416.5 - i below
#   3.9 um     T = 347.5 - 0.6 i, steeper (0.85 K a count) under 251 K
#   visible    a curve per band class (the red band has its own), below
#
# So an RGB from them is good to half a kelvin in warm scenes and one in cold,
# plenty for a picture; the differences with the narrowest ranges (24-hour
# microphysics) show a little banding.

_RED = np.array([[0, 0.0], [20, 0.034], [40, 0.066], [60, 0.107], [80, 0.155], [100, 0.212], [120, 0.272],
                 [140, 0.354], [160, 0.438], [180, 0.535], [200, 0.651], [220, 0.776], [240, 0.899],
                 [255, 1.0]], dtype="float32")
_VIS = np.array([[0, 0.0], [5, 0.019], [20, 0.033], [40, 0.06], [60, 0.092], [80, 0.132], [100, 0.18],
                 [120, 0.234], [140, 0.295], [160, 0.36], [180, 0.44], [200, 0.527], [220, 0.618],
                 [240, 0.728], [255, 0.82]], dtype="float32")


def _lut(kind: str) -> np.ndarray:
    i = np.arange(256, dtype="float32")
    if kind == "ir":
        v = np.where(i <= 176, 330.0 - i / 2.0, 418.0 - i)
    elif kind == "wv":
        v = np.where(i <= 176, 330.0 - i / 2.0, 416.5 - i)
    elif kind == "swir":
        v = np.where(i <= 160, 347.5 - 0.6 * i, 251.5 - 0.85 * (i - 160))
    elif kind == "red":
        v = np.interp(i, _RED[:, 0], _RED[:, 1])
    else:
        v = np.interp(i, _VIS[:, 0], _VIS[:, 1])
    out = v.astype("float32")
    # Off the disk is index 0 too. For the infrared that is 330 K, which no
    # scene reaches; for the visible it is also a dark night, which is data
    # (the disk's edge is found from the geometry instead).
    if kind in ("ir", "wv", "swir"):
        out[0] = np.nan
    return out


_LUTS = {k: _lut(k) for k in ("ir", "wv", "swir", "red", "vis")}


def values(sat: str, sector: str, product: str, kind: str, when: datetime, layout: Layout,
           lon: np.ndarray, lat: np.ndarray, zoom_adjust: int = 0, coarse: bool = False) -> np.ndarray:
    """A band in physical units (K, or reflectance 0-1) over a lon/lat grid."""
    sx, sy = geo.scan_angles(layout.geos, lon, lat)
    x0, x1, ytop, ybot = layout.extent
    u = (sx - x0) / (x1 - x0)
    v = (ytop - sy) / (ytop - ybot)
    inside = np.isfinite(u) & np.isfinite(v) & (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    h, w = lon.shape
    out = np.full((h, w), np.nan, dtype="float32")
    if not inside.any():
        return out
    z = pick_zoom(layout, u, w, zoom_adjust)
    if coarse:
        z = max(0, z - 1)
    scale = 2 ** z
    px = (layout.left + u * layout.cols) * scale - 0.5
    py = (layout.top + v * layout.rows) * scale - 0.5
    n = (layout.tile * scale) // layout.tile
    c0 = max(0, int(np.floor(np.nanmin(px[inside]) / layout.tile)))
    c1 = min(n - 1, int(np.floor(np.nanmax(px[inside]) / layout.tile)))
    r0 = max(0, int(np.floor(np.nanmin(py[inside]) / layout.tile)))
    r1 = min(n - 1, int(np.floor(np.nanmax(py[inside]) / layout.tile)))
    jobs = [(r, c) for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]
    def idx_of(rc):
        t = tile(sat, sector, product, when, z, rc[0], rc[1])
        return None if t is None else t.idx

    tiles = dict(zip(jobs, net.POOL.map(idx_of, jobs)))
    if all(t is None for t in tiles.values()):
        raise net.Missing(f"SLIDER has no {product} at {when:%H:%M}Z")
    lut = _LUTS[kind]
    mosaic = np.full(((r1 - r0 + 1) * layout.tile, (c1 - c0 + 1) * layout.tile), np.nan, dtype="float32")
    for (r, c), t in tiles.items():
        if t is None:
            continue
        th, tw = t.shape[:2]
        y0 = (r - r0) * layout.tile
        x0_ = (c - c0) * layout.tile
        mosaic[y0:y0 + th, x0_:x0_ + tw] = lut[t[: layout.tile, : layout.tile]]
    mosaic[_padding(layout, scale, r0, c0, mosaic.shape[0], mosaic.shape[1])] = np.nan
    if kind in ("ir", "wv", "swir"):
        # Half-kelvin steps turn to grain once two bands are subtracted; a
        # touch of smoothing (NaN-aware) takes the steps out, not the detail.
        from scipy.ndimage import gaussian_filter  # noqa: PLC0415

        ok = np.isfinite(mosaic)
        num = gaussian_filter(np.where(ok, mosaic, 0.0), 0.7)
        den = gaussian_filter(ok.astype("float32"), 0.7)
        mosaic = np.where(ok, num / np.maximum(den, 1e-6), np.nan).astype("float32")
    fx = np.where(inside, px - c0 * layout.tile, np.nan)
    fy = np.where(inside, py - r0 * layout.tile, np.nan)
    return geo.smooth(mosaic, fx, fy)
