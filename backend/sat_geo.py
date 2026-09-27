"""
Where a satellite pixel is on the map, and pictures of a map box.

Every geostationary imager looks at the Earth on its own "fixed grid": two scan
angles, one per axis, from a point 35,786 km over the equator. GOES files give
those angles for every column and row; SLIDER's tiles, the full disks of
Himawari and Meteosat, are laid out on the same grids. This module turns a Web
Mercator box of the map into scan angles, so any of them can be sampled into a
picture the map lays straight over its own tiles.

No pyproj: the backend bundle does not ship it, and the geostationary view is
two short formulas (the GOES-R PUG, vol. 4, section 7.1.2.8, and the same with
the other sweep axis for the imagers built in Europe and Japan).
"""
from __future__ import annotations

import io
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass(frozen=True)
class Geos:
    """A geostationary view: sub-satellite longitude, height over the surface
    (metres), the ellipsoid, and which scan axis sweeps (GOES "x", the rest "y")."""
    lon0: float
    h: float
    a: float = 6378137.0
    b: float = 6356752.31414
    sweep: str = "x"


def scan_angles(g: Geos, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Scan angles (radians) of points on the ground; NaN where the satellite
    cannot see them (behind the limb). Remembered for the kept picture grids."""
    if not lon.flags.writeable and lon.size > 4096:
        key = (g, id(lon), id(lat))
        with _GRID_LOCK:
            hit = _SCANS.get(key)
            if hit is not None and hit[0] is lon and hit[1] is lat:
                _SCANS.move_to_end(key)
                return hit[2], hit[3]
        x, y = _scan_angles(g, lon, lat)
        x.flags.writeable = False
        y.flags.writeable = False
        with _GRID_LOCK:
            _SCANS[key] = (lon, lat, x, y)
            while len(_SCANS) > 12:
                _SCANS.popitem(last=False)
        return x, y
    return _scan_angles(g, lon, lat)


def _scan_angles(g: Geos, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lam = np.radians(lon - g.lon0)
    # Longitudes an ocean away wrap: -179 seen from 140.7 E is 40 degrees east.
    lam = (lam + np.pi) % (2 * np.pi) - np.pi
    phi = np.radians(lat)
    rp2 = (g.b / g.a) ** 2
    phic = np.arctan(rp2 * np.tan(phi))
    e2 = 1.0 - rp2
    rc = g.b / np.sqrt(1.0 - e2 * np.cos(phic) ** 2)
    H = g.h + g.a
    vx = rc * np.cos(phic) * np.cos(lam)
    vy = rc * np.cos(phic) * np.sin(lam)
    vz = rc * np.sin(phic)
    tmp = H - vx
    seen = (H * tmp - vy * vy - vz * vz * (g.a * g.a) / (g.b * g.b)) > 0
    seen &= np.abs(lam) < np.pi / 2
    if g.sweep == "x":
        x = np.arctan(vy / np.hypot(vz, tmp))
        y = np.arctan(vz / tmp)
    else:
        x = np.arctan(vy / tmp)
        y = np.arctan(vz / np.hypot(vy, tmp))
    x = np.where(seen, x, np.nan)
    y = np.where(seen, y, np.nan)
    return x, y


def lonlat_of(g: Geos, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Ground point (degrees) of scan angles; NaN off the Earth."""
    H = g.h + g.a
    x = np.asarray(x, dtype="float64")
    y = np.asarray(y, dtype="float64")
    if g.sweep == "x":
        sx, cx, sy, cy = np.sin(x), np.cos(x), np.sin(y), np.cos(y)
        a = sx * sx + cx * cx * (cy * cy + (g.a * g.a) / (g.b * g.b) * sy * sy)
        bb = -2.0 * H * cx * cy
        c = H * H - g.a * g.a
        disc = bb * bb - 4 * a * c
        ok = disc >= 0
        rs = (-bb - np.sqrt(np.where(ok, disc, 0.0))) / (2 * a)
        s_x = rs * cx * cy
        s_y = -rs * sx
        s_z = rs * cx * sy
    else:
        # Sweep about y: the direction vector is (cos x cos y, sin x cos y, sin y).
        dx, dy, dz = np.cos(x) * np.cos(y), np.sin(x) * np.cos(y), np.sin(y)
        a = dx * dx + dy * dy + (g.a * g.a) / (g.b * g.b) * dz * dz
        bb = -2.0 * H * dx
        c = H * H - g.a * g.a
        disc = bb * bb - 4 * a * c
        ok = disc >= 0
        rs = (-bb - np.sqrt(np.where(ok, disc, 0.0))) / (2 * a)
        s_x = rs * dx
        s_y = -rs * dy
        s_z = rs * dz
    lat = np.degrees(np.arctan((g.a * g.a) / (g.b * g.b) * s_z / np.hypot(H - s_x, s_y)))
    lon = g.lon0 - np.degrees(np.arctan2(s_y, H - s_x))
    lon = (lon + 180.0) % 360.0 - 180.0
    return np.where(ok, lon, np.nan), np.where(ok, lat, np.nan)


def merc_y(lat: float | np.ndarray) -> float | np.ndarray:
    lat = np.clip(lat, -85.05, 85.05)
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


_GRID_LOCK = threading.Lock()
_GRIDS: "OrderedDict[tuple, tuple[np.ndarray, np.ndarray]]" = OrderedDict()
_SCANS: "OrderedDict[tuple, tuple]" = OrderedDict()


def mercator_grid(west: float, south: float, east: float, north: float,
                  width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Pixel centres of a Web Mercator picture of the box, as lon/lat grids.
    Kept (read-only) for the next frame of the same loop, with the scan angles
    worked out from them -- half a second of trigonometry a frame otherwise."""
    key = (round(west, 6), round(south, 6), round(east, 6), round(north, 6), width, height)
    with _GRID_LOCK:
        hit = _GRIDS.get(key)
        if hit is not None:
            _GRIDS.move_to_end(key)
            return hit
    lon, lat = _mercator_grid(west, south, east, north, width, height)
    lon.flags.writeable = False
    lat.flags.writeable = False
    with _GRID_LOCK:
        _GRIDS[key] = (lon, lat)
        while len(_GRIDS) > 6:
            _GRIDS.popitem(last=False)
    return lon, lat


def _mercator_grid(west: float, south: float, east: float, north: float,
                   width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    xs = west + (np.arange(width) + 0.5) / width * (east - west)
    y_top, y_bottom = merc_y(north), merc_y(south)
    ys = y_top + (np.arange(height) + 0.5) / height * (y_bottom - y_top)
    lats = np.degrees(2 * np.arctan(np.exp(ys)) - np.pi / 2)
    lon, lat = np.meshgrid(xs, lats)
    return lon, lat


def box_bounds(g: Geos, x_min: float, x_max: float, y_min: float, y_max: float,
               steps: int = 24) -> Optional[dict[str, float]]:
    """The lon/lat box a rectangle of scan angles covers, walked round its edge
    (and through its middle, for a box that holds the whole disk)."""
    t = np.linspace(0.0, 1.0, steps)
    xs = np.concatenate([x_min + (x_max - x_min) * t, np.full(steps, x_max),
                         x_max - (x_max - x_min) * t, np.full(steps, x_min)])
    ys = np.concatenate([np.full(steps, y_max), y_max - (y_max - y_min) * t,
                         np.full(steps, y_min), y_min + (y_max - y_min) * t])
    gx, gy = np.meshgrid(x_min + (x_max - x_min) * t, y_min + (y_max - y_min) * t)
    xs = np.concatenate([xs, gx.ravel()])
    ys = np.concatenate([ys, gy.ravel()])
    lon, lat = lonlat_of(g, xs, ys)
    ok = np.isfinite(lon) & np.isfinite(lat)
    if not ok.any():
        return None
    lon, lat = lon[ok], lat[ok]
    # A box across the date line: measure the longitudes round the satellite.
    rel = (lon - g.lon0 + 180.0) % 360.0 - 180.0
    return {"west": float(g.lon0 + rel.min()), "east": float(g.lon0 + rel.max()),
            "south": float(max(-85.0, lat.min())), "north": float(min(85.0, lat.max()))}


# ---------------------------------------------------------------------------
# Sampling a grid
# ---------------------------------------------------------------------------

def bilinear(img: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """Values of a 2-D array (or H x W x C) at fractional column/row positions,
    bilinearly; NaN outside it or where the neighbours are NaN."""
    ny, nx = img.shape[:2]
    ok = np.isfinite(fx) & np.isfinite(fy) & (fx > -0.5) & (fx < nx - 0.5) & (fy > -0.5) & (fy < ny - 0.5)
    fx = np.clip(np.where(ok, fx, 0.0), 0.0, nx - 1.0)
    fy = np.clip(np.where(ok, fy, 0.0), 0.0, ny - 1.0)
    x0 = np.minimum(np.floor(fx).astype(np.int64), max(nx - 2, 0))
    y0 = np.minimum(np.floor(fy).astype(np.int64), max(ny - 2, 0))
    x1 = np.minimum(x0 + 1, nx - 1)
    y1 = np.minimum(y0 + 1, ny - 1)
    tx = (fx - x0).astype("float32")
    ty = (fy - y0).astype("float32")
    if img.ndim == 3:
        tx = tx[..., None]
        ty = ty[..., None]
    a = img[y0, x0].astype("float32")
    b = img[y0, x1].astype("float32")
    c = img[y1, x0].astype("float32")
    d = img[y1, x1].astype("float32")
    top = a + (b - a) * tx
    bottom = c + (d - c) * tx
    out = top + (bottom - top) * ty
    # Where a neighbour is missing, the nearest pixel rather than a hole.
    if img.dtype.kind == "f":
        near = img[np.rint(fy).astype(np.int64), np.rint(fx).astype(np.int64)].astype("float32")
        out = np.where(np.isfinite(out), out, near)
    mask = ok if img.ndim == 2 else ok[..., None]
    return np.where(mask, out, np.nan)


def _catmull_rom(t: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    t2 = t * t
    t3 = t2 * t
    return (-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0,
            -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2)


def bicubic(img: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """Catmull-Rom interpolation of a 2-D array (or H x W x C) at fractional
    column/row positions: smooth where bilinear leaves diamonds when a 2 km
    pixel covers ten screen pixels, yet sharp. Clamped to the four nearest
    values so an edge never rings (no halo of a colour that is not there).
    Where a neighbour is missing it falls back to bilinear."""
    ny, nx = img.shape[:2]
    if ny < 4 or nx < 4:
        return bilinear(img, fx, fy)
    ok = np.isfinite(fx) & np.isfinite(fy) & (fx > -0.5) & (fx < nx - 0.5) & (fy > -0.5) & (fy < ny - 0.5)
    x = np.clip(np.where(ok, fx, 0.0), 0.0, nx - 1.0)
    y = np.clip(np.where(ok, fy, 0.0), 0.0, ny - 1.0)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    tx = (x - x0).astype("float32")
    ty = (y - y0).astype("float32")
    wx = _catmull_rom(tx)
    wy = _catmull_rom(ty)
    chan = img.ndim == 3
    src = img.astype("float32", copy=False)
    # Gathers through flat indices: several times faster than 2-D fancy
    # indexing on a picture of a few million pixels.
    flat = src.reshape(ny * nx, -1) if chan else src.reshape(-1)
    xs = [np.clip(x0 + k - 1, 0, nx - 1) for k in range(4)]
    rows_ = [np.clip(y0 + k - 1, 0, ny - 1) * nx for k in range(4)]
    taps = {}
    out = None
    for j in range(4):
        row = None
        for i in range(4):
            idx = rows_[j] + xs[i]
            v = np.take(flat, idx, axis=0)
            if (i, j) in ((1, 1), (2, 1), (1, 2), (2, 2)):
                taps[(i, j)] = v
            w = wx[i][..., None] if chan else wx[i]
            row = v * w if row is None else row + v * w
        wj = wy[j][..., None] if chan else wy[j]
        out = row * wj if out is None else out + row * wj
    # No overshoot past the 2 x 2 cell the point sits in (clipped edges make
    # these the same pixels as the inner taps).
    a, b, c, d = taps[(1, 1)], taps[(2, 1)], taps[(1, 2)], taps[(2, 2)]
    lo = np.fmin(np.fmin(a, b), np.fmin(c, d))
    hi = np.fmax(np.fmax(a, b), np.fmax(c, d))
    out = np.clip(out, lo, hi)
    if img.dtype.kind == "f":
        bad = ~np.isfinite(out if not chan else out[..., 0]) & ok
        if bad.any():
            out[bad] = bilinear(img, fx[bad], fy[bad])
    mask = ok if not chan else ok[..., None]
    return np.where(mask, out, np.nan).astype("float32")


def _step(fx: np.ndarray) -> float:
    """Data pixels per picture pixel across the middle row."""
    h = fx.shape[0] if fx.ndim == 2 else 1
    mid = fx[h // 2] if fx.ndim == 2 else fx
    good = np.isfinite(mid)
    return float(np.nanmedian(np.abs(np.diff(mid[good])))) if good.sum() > 3 else 1.0


def shrink_filter(img: np.ndarray, step: float) -> np.ndarray:
    """A Gaussian as wide as the shrink, NaN-aware: what a GPU's mipmaps do
    before a big picture is drawn small. Without it every picture pixel is
    one data pixel picked from several -- grain and jagged cloud edges."""
    from scipy.ndimage import gaussian_filter  # noqa: PLC0415

    sigma = 0.42 * step
    sig = (sigma, sigma, 0) if img.ndim == 3 else sigma
    src = img.astype("float32", copy=False)
    ok = np.isfinite(src)
    if ok.all():
        return gaussian_filter(src, sig, mode="nearest", truncate=2.5)
    num = gaussian_filter(np.where(ok, src, 0.0), sig, mode="nearest", truncate=2.5)
    den = gaussian_filter(ok.astype("float32"), sig, mode="nearest", truncate=2.5)
    return np.where(ok, num / np.maximum(den, 1e-6), np.nan).astype("float32")


def smooth(img: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """Bicubic where the picture magnifies the data (a data pixel over more
    than about 1.3 picture pixels: zoomed in, where bilinear shows its
    diamonds); bilinear near one to one; filtered first, then bilinear, where
    the picture shrinks the data."""
    step = _step(fx)
    if step < 0.77:
        return bicubic(img, fx, fy)
    if step > 1.25:
        img = shrink_filter(img, step)
    return bilinear(img, fx, fy)


def nearest(img: np.ndarray, fx: np.ndarray, fy: np.ndarray, fill: float = np.nan) -> np.ndarray:
    """Nearest-pixel values: for categories (cloud phase, fire masks), which
    must not be blended."""
    ny, nx = img.shape[:2]
    ok = np.isfinite(fx) & np.isfinite(fy) & (fx > -0.5) & (fx < nx - 0.5) & (fy > -0.5) & (fy < ny - 0.5)
    ix = np.clip(np.rint(np.where(ok, fx, 0)).astype(np.int64), 0, nx - 1)
    iy = np.clip(np.rint(np.where(ok, fy, 0)).astype(np.int64), 0, ny - 1)
    out = img[iy, ix].astype("float32")
    mask = ok if img.ndim == 2 else ok[..., None]
    return np.where(mask, out, fill)


# ---------------------------------------------------------------------------
# Pictures
# ---------------------------------------------------------------------------

def encode(rgba: np.ndarray, quality: int = 86) -> tuple[bytes, str]:
    """WebP: lossy for imagery (a tenth of a PNG's bytes, and a loop is bound by
    bytes), with the alpha kept exact so the map shows round the scan."""
    from PIL import Image  # noqa: PLC0415

    img = Image.fromarray(rgba, "RGBA" if rgba.shape[2] == 4 else "RGB")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, method=2, alpha_quality=100)
    return buf.getvalue(), "image/webp"


def encode_lossless(rgba: np.ndarray) -> tuple[bytes, str]:
    """Lossless, for colour-table products whose colours are a legend. The
    fastest setting: 0.07 s for a 2 MP picture against 0.37 s at quality 20,
    for a file half again as big -- which only crosses to the local machine."""
    from PIL import Image  # noqa: PLC0415

    img = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True, quality=0, method=0)
    return buf.getvalue(), "image/webp"


# Where a geostationary picture fades out: past a view angle of ~77 degrees
# one pixel covers a strip of ground many times its size at nadir, and on a
# Mercator map the last ten degrees before the limb -- smeared, with the
# black of space bled in -- drew as grey and dark rings round the disk once
# zoomed out (Pablo, 2026-09-26). Gone by 81 degrees.
VIEW_FADE_DEG = (77.0, 81.0)
_R_OVER_ORBIT = 6378.137 / 42164.16
_FADES: "OrderedDict[tuple, tuple]" = OrderedDict()


def view_fade(lon: np.ndarray, lat: np.ndarray, lon0: float) -> np.ndarray:
    """0-1 per point: 1 where the satellite at `lon0` sees the ground well,
    fading to 0 towards its limb. Remembered for the kept picture grids."""
    key = (id(lon), id(lat), lon0)
    with _GRID_LOCK:
        hit = _FADES.get(key)
        if hit is not None and hit[0] is lon and hit[1] is lat:
            return hit[2]
    cos_g = np.cos(np.radians(lat)) * np.cos(np.radians(lon - lon0))
    sin_g = np.sqrt(np.clip(1.0 - cos_g * cos_g, 0.0, 1.0))
    # Angle from the satellite's straight down to the point, seen from the point.
    vza = np.degrees(np.arctan2(sin_g, cos_g - _R_OVER_ORBIT))
    lo, hi = VIEW_FADE_DEG
    fade = np.clip((hi - vza) / (hi - lo), 0.0, 1.0).astype("float32")
    fade[cos_g <= _R_OVER_ORBIT] = 0.0
    if not lon.flags.writeable:
        fade.flags.writeable = False
        with _GRID_LOCK:
            _FADES[key] = (lon, lat, fade)
            while len(_FADES) > 12:
                _FADES.popitem(last=False)
    return fade


def solar_zenith(lon: np.ndarray, lat: np.ndarray, when) -> np.ndarray:
    """Sun's zenith angle (degrees) at each point, NOAA's low-accuracy formula:
    enough to fade a day product into night across the terminator."""
    doy = when.timetuple().tm_yday
    hour = when.hour + when.minute / 60.0 + when.second / 3600.0
    gamma = 2 * math.pi / 365.0 * (doy - 1 + (hour - 12) / 24.0)
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
            - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
            - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
                       - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    tst = hour * 60.0 + eqtime + 4.0 * lon
    ha = np.radians(tst / 4.0 - 180.0)
    phi = np.radians(lat)
    cosz = np.sin(phi) * math.sin(decl) + np.cos(phi) * math.cos(decl) * np.cos(ha)
    return np.degrees(np.arccos(np.clip(cosz, -1.0, 1.0)))
