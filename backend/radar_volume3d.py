"""
The whole radar volume as a box of voxels, for the 3D view.

Every tilt of the scan on screen is resampled onto a Cartesian grid -- around
the radar (256 x 256 columns, 64 levels up to 20 km by default) or over a box
drawn on the map (`box_spec`: cells of 0.5 km or more, 320 at most along a
side, levels every 250 m) -- so the app can ray-march it on the GPU: orbit a
supercell, see the core's height, the anvil spreading downwind, the rain
shafts under the base.

Geometry is the radar's own, the 4/3-earth beam model radar_xsect uses. Each
tilt is sampled once per column, where its beam centre crosses that column (a
ground distance s from the radar: slant range r = Ra sin(phi) / cos(e + phi),
phi = s / Re'). Each voxel then takes the beam it sits in (half the 0.95 deg
width either side of its centre) or, in the gap between two beams, a blend of
the two by angle for the smooth moments -- the nearer one for velocity, where a
blend across a fold would make up a value. Across a gap wider than 4.5 deg the
voxel stays empty. The cross-section stops at 3 deg; in 3D the top of a
precipitation VCP (15.6 to 19.5 deg) would otherwise slice every storm near the
radar into floating layers.

Above the highest tilt nothing is seen: the cone of silence. Those voxels carry
code 255 so the view can draw the hole for what it is. Asked to (`fill`
"neighbor"), the other NEXRAD nearest the box whose volume covers that air
fills it -- and the air under this radar's lowest beam, which far from the
radar is kilometres deep -- from its volume nearest in time, sampled with its
own geometry. Only for moments that do not depend on where the radar stands
(reflectivity, CC, ZDR, KDP, width): another radar's radial velocity is a
different wind component.

KDP is not in a NEXRAD Level II file; it is estimated here from the
differential phase it carries (half the range slope of PhiDP over a 5 km
least-squares window, noisy fits dropped).

The GOES lightning flashes over the volume's minutes come with it, each with
the height of the reflectivity echo top over it, so the view can hang them in
the cloud. Their files are sent for once the volume is in, and the volume does
not wait long for them: the header's glm.pending counts the files still on
their way, and part=glm asks again for the flashes alone.

A Level II volume is read (radar_xsect._stack) by level2_fast -- one moment
straight from the bytes, ~0.3 s -- rather than MetPy, which scales every
moment (~2.5 s), so another moment of a volume already here costs about
half a second.

Wire format: [u32 header length][JSON header][codes u8 nz*ny*nx, x fastest,
row 0 south, level 0 at the ground][float32 x5 per flash]. Code 0 is no echo,
1..254 a value (vmin + (code-1) * (vmax-vmin)/253), 255 the cone of silence.
"""
from __future__ import annotations

import gzip
import json
import math
import struct
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, wait
from typing import Any, Callable, Optional

import numpy as np

import glm
import nexrad_level2 as l2
import radar_xsect as xs
from nexrad_core import _KIND_DEFAULT_PALETTE, _iem_sites, _mean_storm_motion, get_cmap, icao_for, site_id

EARTH_KM = 6371.0
RE_EFF_KM = xs.RE_EFF_KM
HALF_BEAM = xs.HALF_BEAM
MAX_GAP_3D = 4.5
CONE = 255
TOP_CODE = 254
LEVEL_CHUNK = 16

# Moments another radar can fill the cone with: the same thing seen from
# anywhere. Velocity is the wind along the beam, a different one per radar.
_FILLABLE = {"ref", "cc", "zdr", "sw", "kdp"}
# A neighbour this close is the same place (a research radar beside the NEXRAD);
# past this far its lowest beam is over 8 km up above the radar.
_NEIGHBOUR_KM = (25.0, 330.0)
FLASH_FIELDS = ["xKm", "yKm", "tSec", "energyFJ", "topKm"]
# The reflectivity the echo top a flash hangs from is read at.
_FLASH_TOP_DBZ = 18.0

# A drawn box: cells no finer than this, no more than MAX_CELLS along a side,
# levels every BOX_DZ_KM to BOX_TOP_KM, and at most this wide.
BOX_MIN_CELL_KM = 0.5
BOX_MAX_CELLS = 320
BOX_DZ_KM = 0.25
BOX_TOP_KM = 20.0
BOX_MAX_KM = 420.0
BOX_MIN_KM = 4.0
# How far each moment reaches: reflectivity from the long-range surveillance
# cut, the Doppler and dual-pol moments from the shorter ones.
RANGE_KM = {"ref": 460.0}
DOPPLER_RANGE_KM = 300.0
# A volume this much older than now is past the live chunk bucket's two days:
# the archive answers without the live listing (8 s cold) being made first.
_LIVE_SPAN_S = 46 * 3600
# KDP from PhiDP: the least-squares window, the fit residual past which the
# phase is too noisy to read a slope from, and the share of the window that
# must hold a phase.
KDP_WINDOW_KM = 5.0
KDP_MAX_RESID_DEG = 10.0
KDP_MIN_SHARE = 0.6

_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_MAX = 6
_LOCK = threading.Lock()
_GATES: dict[tuple, threading.Lock] = {}
_POOL = ThreadPoolExecutor(max_workers=6, thread_name_prefix="vol3d")
# Derived KDP stacks, per volume.
_KDP: "OrderedDict[tuple, dict]" = OrderedDict()
_KDP_LOCK = threading.Lock()
# Finished payloads (gzip), when their lightning is complete.
_PAYLOADS: "OrderedDict[tuple, bytes]" = OrderedDict()
_PAYLOAD_MAX = 6


class BoxError(ValueError):
    """A box the 3D view cannot be built over: out of the radar's range, too
    big, too small. The route answers it with a 422 and this message."""


# ---------------------------------------------------------------------------
# Progress, for the view's loading pill
# ---------------------------------------------------------------------------
_PROGRESS: "OrderedDict[str, dict]" = OrderedDict()
_PLOCK = threading.Lock()


def _say(rid: str, **kw: Any) -> None:
    """Note where request `rid` is: its stage, the radars downloading, the
    building's steps."""
    if not rid:
        return
    with _PLOCK:
        p = _PROGRESS.get(rid)
        if p is None:
            p = _PROGRESS[rid] = {"t0": time.time(), "downloads": {}}
        downloads = kw.pop("downloads", None)
        if downloads:
            p["downloads"].update(downloads)
        p.update(kw)
        p["t"] = time.time()
        _PROGRESS.move_to_end(rid)
        while len(_PROGRESS) > 64:
            _PROGRESS.popitem(last=False)


def progress(rid: str) -> Optional[dict]:
    """Where request `rid` is, for the view to show while it waits."""
    with _PLOCK:
        p = _PROGRESS.get(rid)
        if p is None:
            return None
        out = {k: v for k, v in p.items() if k not in ("t0", "t", "downloads")}
        out["downloads"] = [{"site": s, "done": d} for s, d in p["downloads"].items()]
        out["elapsedMs"] = round((time.time() - p["t0"]) * 1000)
        return out


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def grid_axis(half_km: float, n: int) -> np.ndarray:
    """The km offsets of n cell centres from -half to +half."""
    return ((np.arange(n, dtype=np.float64) + 0.5) / n * 2.0 - 1.0) * half_km


def grid_lonlat(clat: float, clon: float, half_km: float, n: int, half_y_km: Optional[float] = None,
                ny: Optional[int] = None) -> tuple[np.ndarray, np.ndarray]:
    """Latitude and longitude of every column centre of an n x n box (or n
    wide and ny tall, half_km and half_y_km from the centre), azimuthal
    equidistant about (clat, clon): x east, y north, row 0 the southern edge."""
    cx = grid_axis(half_km, n)
    cy = grid_axis(half_y_km if half_y_km is not None else half_km, ny or n)
    x, y = np.meshgrid(cx, cy)
    rho = np.hypot(x, y)
    delta = rho / EARTH_KM
    theta = np.arctan2(x, y)
    p1, l1 = math.radians(clat), math.radians(clon)
    lat = np.arcsin(np.clip(math.sin(p1) * np.cos(delta) + math.cos(p1) * np.sin(delta) * np.cos(theta), -1, 1))
    lon = l1 + np.arctan2(np.sin(theta) * np.sin(delta) * math.cos(p1), np.cos(delta) - math.sin(p1) * np.sin(lat))
    return np.degrees(lat), (np.degrees(lon) + 540.0) % 360.0 - 180.0


def to_grid_km(clat: float, clon: float, lat: Any, lon: Any) -> tuple[np.ndarray, np.ndarray]:
    """The forward of grid_lonlat: km east and north of the box's centre."""
    p1, p2 = math.radians(clat), np.radians(np.asarray(lat, dtype=np.float64))
    dl = np.radians(np.asarray(lon, dtype=np.float64) - clon)
    c = np.arccos(np.clip(math.sin(p1) * np.sin(p2) + math.cos(p1) * np.cos(p2) * np.cos(dl), -1, 1))
    az = np.arctan2(np.sin(dl) * np.cos(p2), math.cos(p1) * np.sin(p2) - math.sin(p1) * np.cos(p2) * np.cos(dl))
    d = c * EARTH_KM
    return d * np.sin(az), d * np.cos(az)


def beam_range_km(s_km: Any, elev_deg: float, radar_km: float) -> np.ndarray:
    """Slant range at which a beam's centre crosses the vertical at ground
    distance s: the triangle earth centre - antenna - point, angle phi = s/Re'
    at the centre and 90 + e at the antenna."""
    phi = np.asarray(s_km, dtype=np.float64) / RE_EFF_KM
    ra = RE_EFF_KM + radar_km
    den = np.cos(math.radians(elev_deg) + phi)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(den > 1e-6, ra * np.sin(phi) / den, np.nan)
    return r


def beam_height_km(s_km: Any, elev_deg: float, radar_km: float) -> np.ndarray:
    """Height (km MSL) of a beam's centre over ground distance s."""
    r = beam_range_km(s_km, elev_deg, radar_km)
    ra = RE_EFF_KM + radar_km
    e = math.radians(elev_deg)
    return np.sqrt(r * r + ra * ra + 2.0 * r * ra * math.sin(e)) - RE_EFF_KM


def elevation_deg(s_km: Any, z_msl_km: Any, radar_km: float) -> np.ndarray:
    """The elevation angle from the antenna to a point s km away (ground
    distance) and z km above sea level, on the 4/3 earth."""
    phi = np.asarray(s_km, dtype=np.float32) / np.float32(RE_EFF_KM)
    z = np.asarray(z_msl_km, dtype=np.float32)
    rp = np.float32(RE_EFF_KM) + z
    x = rp * np.sin(phi)
    # rp cos(phi) - ra, written so float32 does not subtract two 8500 km radii:
    # near the radar that difference is metres, and lost to rounding.
    half = np.sin(phi * np.float32(0.5))
    y = (z - np.float32(radar_km)) - rp * np.float32(2.0) * half * half
    return np.degrees(np.arctan2(y, x)).astype(np.float32)


def _km_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return EARTH_KM * math.acos(max(-1.0, min(1.0, c)))


def reach_km(kind: str) -> float:
    return RANGE_KM.get(kind, DOPPLER_RANGE_KM)


def box_spec(bbox: tuple[float, float, float, float], site_lat: float, site_lon: float, kind: str,
             site_label: str, product_label: str = "") -> dict:
    """The grid over a box drawn on the map, (west, south, east, north): its
    centre, half sizes, cells and levels -- or a BoxError saying why not."""
    west, south, east, north = (float(v) for v in bbox)
    if not all(math.isfinite(v) for v in (west, south, east, north)):
        raise BoxError("The box's corners are not numbers.")
    if east < west:
        east += 360.0  # across the antimeridian
    if not (-85.0 <= south < north <= 85.0) or east - west <= 0 or east - west > 60:
        raise BoxError("The box needs a west, south, east and north edge, in that order.")
    clat, clon = (south + north) / 2.0, (west + east) / 2.0
    clon = (clon + 540.0) % 360.0 - 180.0
    half_x = _km_between(clat, clon - (east - west) / 2.0, clat, clon + (east - west) / 2.0) / 2.0
    half_y = _km_between(south, clon, north, clon) / 2.0
    wide = 2.0 * max(half_x, half_y)
    if wide > BOX_MAX_KM:
        raise BoxError(f"The box is {wide:.0f} km across; the 3D view takes boxes up to 400 km.")
    if 2.0 * min(half_x, half_y) < BOX_MIN_KM:
        raise BoxError("The box is too small: draw it at least 4 km on a side.")
    rx, ry = (float(v) for v in to_grid_km(clat, clon, site_lat, site_lon))
    nearest = math.hypot(rx - min(max(rx, -half_x), half_x), ry - min(max(ry, -half_y), half_y))
    rng = reach_km(kind)
    what = product_label or "this product"
    if nearest > rng:
        raise BoxError(f"The box is out of {site_label}'s range: its nearest edge is {nearest:.0f} km from the "
                       f"radar, and {what} reaches {rng:.0f} km.")
    cell = max(BOX_MIN_CELL_KM, wide / BOX_MAX_CELLS)
    nx = max(16, int(math.ceil(2.0 * half_x / cell)))
    ny = max(16, int(math.ceil(2.0 * half_y / cell)))
    nz = int(round(BOX_TOP_KM / BOX_DZ_KM))
    return {"center": (clat, clon), "half_km": half_x, "half_y_km": half_y, "n": nx, "ny": ny, "nz": nz,
            "top_km": BOX_TOP_KM, "cellKm": round(cell, 3), "nearestKm": round(nearest, 1)}


# ---------------------------------------------------------------------------
# Sampling
# ---------------------------------------------------------------------------
def _distinct(sweeps: list[dict]) -> list[dict]:
    """One sweep per angle, the furthest-reaching of a split cut, low to high."""
    best: dict[float, dict] = {}
    for sw in sweeps:
        a = round(float(sw["elev"]), 1)
        reach = sw["vals"].shape[1] * float(sw["width"]) + float(sw["first"])
        held = best.get(a)
        if held is None or reach > held["vals"].shape[1] * float(held["width"]) + float(held["first"]):
            best[a] = sw
    return [best[a] for a in sorted(best)]


def beam_fields(st: dict, s: np.ndarray, az: np.ndarray,
                motion: Optional[tuple[float, float]] = None) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Each tilt's value where its beam centre crosses each column: (tilts,
    columns) float32, the tilts' angles, and the sweeps used."""
    sweeps = _distinct(st["sweeps"])
    h0 = float(st["heightKm"])
    fields = np.empty((len(sweeps), s.size), dtype=np.float32)
    for k, sw in enumerate(sweeps):
        r = beam_range_km(s, sw["elev"], h0)
        r = np.where(np.isfinite(r), r, -1.0)
        fields[k] = xs._sample(sw, az, r[None, :])[0]
    if motion is not None and motion[0]:
        speed_kt, toward = motion
        fields -= (speed_kt * np.cos(np.radians(az - toward))).astype(np.float32)[None, :]
    elevs = np.array([float(sw["elev"]) for sw in sweeps], dtype=np.float32)
    return fields, elevs, sweeps


def pick(elevs: np.ndarray, fields: np.ndarray, theta: np.ndarray, cols: np.ndarray, kind: str,
         max_gap: float = MAX_GAP_3D) -> np.ndarray:
    """The value at voxels of elevation angle `theta` over columns `cols` (flat
    arrays of the same length): the beam each sits in, or the two it is
    between."""
    k = len(elevs)
    if k == 0:
        return np.full(theta.shape, np.nan, dtype=np.float32)
    if k > 1:
        hi = np.clip(np.searchsorted(elevs, theta), 1, k - 1)
        lo = hi - 1
    else:
        hi = lo = np.zeros(theta.shape, dtype=np.int64)
    e_lo, e_hi = elevs[lo], elevs[hi]
    v_lo = fields[lo, cols]
    v_hi = fields[hi, cols]
    d_lo, d_hi = np.abs(theta - e_lo), np.abs(theta - e_hi)
    near_v = np.where(d_lo <= d_hi, v_lo, v_hi)
    inside = np.minimum(d_lo, d_hi) <= HALF_BEAM
    gap = e_hi - e_lo
    between = (theta > e_lo) & (theta < e_hi) & (gap <= max_gap) & ~inside
    out = np.where(inside, near_v, np.float32(np.nan))
    if kind in xs._BLEND or kind == "kdp":
        w = np.clip((theta - e_lo) / np.where(gap > 0, gap, 1.0), 0.0, 1.0)
        both = np.isfinite(v_lo) & np.isfinite(v_hi)
        blend = np.where(both, v_lo * (1 - w) + v_hi * w, np.where(np.isfinite(v_lo), v_lo, v_hi))
        out = np.where(between, blend, out)
    else:
        out = np.where(between, near_v, out)
    return out.astype(np.float32)


# The storm look: the value an echo fades toward across a gap where the next
# tilt saw nothing, and the value under which that fade counts as air.
_EDGE_FADE = {"ref": (-8.0, -4.0)}
# Over the top tilt the storm look fades out over this many degrees: wider
# than half a beam so the fade spans a few voxels (a half-beam fade is
# thinner than one 0.25 km level near the radar, and the cone's surface
# shows as rings where it crosses the levels). Near the radar even 1.5
# degrees is under a level, so the fade is also at least _TOP_FADE_KM tall.
_TOP_FADE_DEG = 1.5
_TOP_FADE_KM = 0.8


def pick_smooth(elevs: np.ndarray, fields: np.ndarray, theta: np.ndarray, cols: np.ndarray, kind: str,
                max_gap: float = MAX_GAP_3D, top_fade: Optional[np.ndarray] = None) -> np.ndarray:
    """The storm look of `pick`: values run linearly in elevation angle from
    one tilt's centre to the next (no flat beam-wide plateaus), and an echo
    edge -- a tilt with echo beside one without -- fades toward "nothing"
    across the gap, so the edge lands part-way: higher over strong echo,
    lower over weak, sloping from one tilt's top to the next instead of
    stepping at a beam's edge. Above the top tilt the echo fades out over
    _TOP_FADE_DEG (or `top_fade`, degrees per sample), under the lowest over half a beam. Moments with no "nothing" value (CC,
    ZDR...) blend where both tilts saw echo and keep a one-sided edge at the
    gap's middle."""
    k = len(elevs)
    base = pick(elevs, fields, theta, cols, kind, max_gap)
    if k < 2 or (kind not in xs._BLEND and kind != "kdp"):
        return base
    hi = np.clip(np.searchsorted(elevs, theta), 1, k - 1)
    lo = hi - 1
    e_lo, e_hi = elevs[lo], elevs[hi]
    gap = e_hi - e_lo
    within = (theta >= e_lo) & (theta <= e_hi) & (gap <= max_gap)
    v_lo = fields[lo, cols]
    v_hi = fields[hi, cols]
    f_lo, f_hi = np.isfinite(v_lo), np.isfinite(v_hi)
    w = np.clip((theta - e_lo) / np.where(gap > 0, gap, 1.0), 0.0, 1.0)
    fade = _EDGE_FADE.get(kind)
    nan = np.float32(np.nan)
    if fade is None:
        both = v_lo * (1 - w) + v_hi * w
        out = np.where(f_lo & f_hi, both, nan)
        out = np.where(f_lo & ~f_hi & (w <= 0.5), v_lo, out)
        out = np.where(~f_lo & f_hi & (w > 0.5), v_hi, out)
        return np.where(within, out, base).astype(np.float32)
    floor, air = fade
    a = np.where(f_lo, v_lo, floor)
    b = np.where(f_hi, v_hi, floor)
    val = a * (1 - w) + b * w
    out = np.where(f_lo & f_hi, val, np.where((f_lo | f_hi) & (val >= air), val, nan))
    out = np.where(within, out, base)
    # Over the top tilt and under the lowest: a fade, not a step.
    e_top, e_bot = float(elevs[-1]), float(elevs[0])
    v_top, v_bot = fields[k - 1, cols], fields[0, cols]
    tf = _TOP_FADE_DEG if top_fade is None else top_fade
    up = (theta > e_top) & (theta <= e_top + tf) & np.isfinite(v_top)
    wu = (theta - e_top) / tf
    top_val = v_top * (1 - wu) + floor * wu
    out = np.where(up, np.where(top_val >= air, top_val, nan), out)
    down = (theta < e_bot) & (theta >= e_bot - HALF_BEAM) & np.isfinite(v_bot)
    wd = (e_bot - theta) / HALF_BEAM
    bot_val = v_bot * (1 - wd) + floor * wd
    out = np.where(down, np.where(bot_val >= air, bot_val, nan), out)
    return out.astype(np.float32)


def quantize(vals: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    """Values as codes 1..254 across vmin..vmax; NaN as 0."""
    t = (vals - vmin) / ((vmax - vmin) or 1.0)
    codes = np.clip(np.rint(t * (TOP_CODE - 1)) + 1.0, 1, TOP_CODE)
    codes[~np.isfinite(vals)] = 0
    return codes.astype(np.uint8)


def resample(st: dict, lat: np.ndarray, lon: np.ndarray, levels_km: np.ndarray, kind: str,
             vmin: float, vmax: float, motion: Optional[tuple[float, float]] = None,
             on_step: Optional[Callable[[int, int], None]] = None,
             smooth: bool = False) -> tuple[np.ndarray, dict]:
    """A stack of sweeps (radar_xsect._stack's shape) on the box: codes
    (levels, rows, cols) with the cone of silence as 255. `levels_km` are
    heights above the radar's ground. `smooth` = the storm look (pick_smooth)."""
    picker = pick_smooth if smooth else pick
    ny, nx = lat.shape
    n = ny * nx
    s, az = xs._from_radar(st["lat"], st["lon"], lat.ravel(), lon.ravel())
    fields, elevs, _ = beam_fields(st, s, az, motion)
    h0 = float(st["heightKm"])
    z_msl = float(st["groundKm"]) + np.asarray(levels_km, dtype=np.float32)
    codes = np.empty((len(z_msl), n), dtype=np.uint8)
    top = float(elevs[-1]) + HALF_BEAM if len(elevs) else 90.0
    cols_all = np.arange(n, dtype=np.int64)
    s32 = s.astype(np.float32)
    extra: dict = {}
    if smooth:
        # The fade over the top tilt in degrees per column: _TOP_FADE_DEG, or
        # whatever is _TOP_FADE_KM tall at that range if more.
        fade_col = np.maximum(_TOP_FADE_DEG, np.degrees(np.arctan2(_TOP_FADE_KM, np.maximum(s32, 0.1)))).astype(np.float32)
    steps = (len(z_msl) + LEVEL_CHUNK - 1) // LEVEL_CHUNK
    for k, a in enumerate(range(0, len(z_msl), LEVEL_CHUNK)):
        zs = z_msl[a:a + LEVEL_CHUNK]
        theta = elevation_deg(s32[None, :], zs[:, None], h0)
        cols = np.broadcast_to(cols_all[None, :], theta.shape)
        if smooth:
            extra = {"top_fade": fade_col[cols.ravel()]}
        vals = picker(elevs, fields, theta.ravel(), cols.ravel(), kind, **extra).reshape(theta.shape)
        c = quantize(vals, vmin, vmax)
        c[(c == 0) & (theta > top)] = CONE
        codes[a:a + LEVEL_CHUNK] = c
        if on_step is not None:
            on_step(k + 1, steps)
    info = {"elevations": [round(float(e), 2) for e in elevs], "topElev": round(top - HALF_BEAM, 2)}
    return codes.reshape(len(z_msl), ny, nx), info


def under_beam(st: dict, lat: np.ndarray, lon: np.ndarray, levels_km: np.ndarray) -> np.ndarray:
    """Voxels under the radar's lowest beam (and above its ground) out to the
    reach of its sweeps: air it does not see, which another radar nearer may."""
    sweeps = _distinct(st["sweeps"])
    nz = len(levels_km)
    if not sweeps:
        return np.zeros((nz,) + lat.shape, dtype=bool)
    s, _ = xs._from_radar(st["lat"], st["lon"], lat.ravel(), lon.ravel())
    low = float(sweeps[0]["elev"]) - HALF_BEAM
    reach = max(float(sw["first"]) + sw["vals"].shape[1] * float(sw["width"]) for sw in sweeps)
    z_msl = float(st["groundKm"]) + np.asarray(levels_km, dtype=np.float32)
    theta = elevation_deg(s.astype(np.float32)[None, :], z_msl[:, None], float(st["heightKm"]))
    return ((theta < low) & (s[None, :] <= reach)).reshape((nz,) + lat.shape)


def fill_cone(codes: np.ndarray, st: dict, lat: np.ndarray, lon: np.ndarray, levels_km: np.ndarray,
              ground_km: float, kind: str, vmin: float, vmax: float) -> int:
    """Fill the cone voxels (255) in place from another radar's stack; returns
    how many it filled. A voxel that radar does not see stays 255."""
    nz, ny, nx = codes.shape
    flat = codes.reshape(nz, ny * nx)
    lv, col = np.nonzero(flat == CONE)
    if lv.size == 0:
        return 0
    s, az = xs._from_radar(st["lat"], st["lon"], lat.ravel(), lon.ravel())
    fields, elevs, sweeps = beam_fields(st, s, az)
    z_msl = (ground_km + np.asarray(levels_km, dtype=np.float32))[lv]
    s_vox = s.astype(np.float32)[col]
    theta = elevation_deg(s_vox, z_msl, float(st["heightKm"]))
    vals = pick(elevs, fields, theta, col, kind)
    got = np.isfinite(vals)
    flat[lv[got], col[got]] = quantize(vals[got], vmin, vmax)
    # What the neighbour sees as empty air is empty: a 0, not a hole.
    reach = max((float(sw["first"]) + sw["vals"].shape[1] * float(sw["width"]) for sw in sweeps), default=0.0)
    seen_empty = ~got & covered(theta, elevs) & (s_vox <= reach)
    flat[lv[seen_empty], col[seen_empty]] = 0
    return int(got.sum() + seen_empty.sum())


def covered(theta: np.ndarray, elevs: np.ndarray, max_gap: float = MAX_GAP_3D) -> np.ndarray:
    """Voxels a radar's tilts look at: inside a beam, or in a gap narrow
    enough to blend across."""
    if len(elevs) == 0:
        return np.zeros(theta.shape, dtype=bool)
    inside = (theta >= float(elevs[0]) - HALF_BEAM) & (theta <= float(elevs[-1]) + HALF_BEAM)
    if len(elevs) == 1:
        return inside
    k = np.clip(np.searchsorted(elevs, theta), 1, len(elevs) - 1)
    near = np.minimum(np.abs(theta - elevs[k - 1]), np.abs(theta - elevs[k]))
    return inside & ((near <= HALF_BEAM) | ((elevs[k] - elevs[k - 1]) <= max_gap))


# ---------------------------------------------------------------------------
# KDP from the differential phase
# ---------------------------------------------------------------------------
def _window_sum(a: np.ndarray, length: int) -> np.ndarray:
    """Centred running sums of `length` (odd) gates along each ray."""
    half = length // 2
    c = np.cumsum(np.pad(a, ((0, 0), (half + 1, half))), axis=1)
    return c[:, length:] - c[:, :a.shape[1]]


def kdp_from_phi(phi: np.ndarray, gate_km: float, window_km: float = KDP_WINDOW_KM) -> np.ndarray:
    """KDP (deg/km) along each ray of a PhiDP sweep (rays x gates, degrees):
    half the least-squares slope of the phase over a window of `window_km`,
    NaN where the window holds too little phase or the fit is too noisy."""
    length = max(5, int(round(window_km / max(gate_km, 1e-3))) | 1)
    m = np.isfinite(phi)
    p = np.where(m, phi, 0.0).astype(np.float64)
    mf = m.astype(np.float64)
    g = np.broadcast_to(np.arange(phi.shape[1], dtype=np.float64)[None, :], phi.shape)
    n = _window_sum(mf, length)
    sx = _window_sum(mf * g, length)
    sy = _window_sum(p, length)
    sxx = _window_sum(mf * g * g, length)
    sxy = _window_sum(p * g, length)
    syy = _window_sum(p * p, length)
    with np.errstate(divide="ignore", invalid="ignore"):
        den = n * sxx - sx * sx
        slope = (n * sxy - sx * sy) / den
        icpt = (sy - slope * sx) / n
        sse = syy - icpt * sy - slope * sxy
        resid = np.sqrt(np.maximum(sse, 0.0) / n)
    ok = m & (n >= KDP_MIN_SHARE * length) & (den > 0) & (resid <= KDP_MAX_RESID_DEG)
    kdp = 0.5 * slope / gate_km
    out = np.where(ok, np.clip(kdp, -2.0, 10.0), np.nan)
    return out.astype(np.float32)


def kdp_stack(st_phi: dict) -> dict:
    """A PhiDP stack (radar_xsect._stack) as the KDP estimated from it."""
    sweeps = []
    for sw in st_phi["sweeps"]:
        k = kdp_from_phi(sw["vals"].astype(np.float32), float(sw["width"]))
        sweeps.append({**sw, "vals": k.astype(np.float16)})
    return {**st_phi, "sweeps": sweeps}


# ---------------------------------------------------------------------------
# Volumes: the scan on screen, a neighbour's, the lightning
# ---------------------------------------------------------------------------
def _is_br(site: str) -> bool:
    return (site or "").upper().startswith("BR-")


def _key_unix(key: str) -> Optional[int]:
    """When a volume key's scan started."""
    if key.startswith("L2A:"):
        return l2._volume_unix(key[4:])
    bits = key.split(":")
    if key.startswith("L2:") and len(bits) >= 3:
        return l2._stamp_unix(bits[2])
    if key.startswith("L2BR:") and len(bits) >= 2:
        import brazil_radar  # noqa: PLC0415

        return brazil_radar._stamp_unix(bits[1])
    return None


# The moments the 3D view offers on a NEXRAD, by family code: Level II's own,
# and KDP estimated from PhiDP.
KDP_SPEC = {"label": "Specific Differential Phase (from PhiDP)", "units": "°/km", "kind": "kdp"}


def _source_fam(fam: str) -> str:
    """The Level II moment a family is read from."""
    return {"S": "G", "K": "P"}.get(fam, fam)


def _download(rid: str, label: str, fetch: Callable[[], Any]) -> None:
    _say(rid, stage="download", downloads={label: False})
    try:
        fetch()
    finally:
        _say(rid, downloads={label: True})


def motion_at(sid: str, unix: Optional[float]) -> tuple[float, float]:
    """Mean SCIT storm motion (speed kt, bearing toward) for a scan: the
    latest storm scan for a live volume; for an archived one, the storm scan
    nearest its time -- today's motion has nothing to do with a storm years
    ago. Calm when there is none within half an hour (Level III's archive is
    not that deep everywhere), and SRV is then base velocity."""
    live = unix is None or unix >= time.time() - 1800
    # A live answer is kept two minutes (storm scans come every ~5), an
    # archived one for good.
    ck = (sid, int(time.time() // 120)) if live else (sid, int(unix))
    if ck in _MOTIONS:
        return _MOTIONS[ck]
    out = _mean_storm_motion(sid) if live else _archive_motion(sid, int(unix))
    out = (round(float(out[0]), 1), round(float(out[1]), 1))
    _MOTIONS[ck] = out
    while len(_MOTIONS) > 32:
        _MOTIONS.popitem(last=False)
    return out


_MOTIONS: "OrderedDict[tuple, tuple[float, float]]" = OrderedDict()


def _archive_motion(sid: str, unix: int) -> tuple[float, float]:
    import nexrad_storms  # noqa: PLC0415

    try:
        nst = nexrad_storms._key_near(sid, "NST", int(unix))
        cells = nexrad_storms._cells_from_key(sid, nst)[0] if nst else []
    except Exception:  # noqa: BLE001 - calm
        return (0.0, 0.0)
    us, vs = [], []
    for c in cells:
        if c.get("speedKt") is None or c.get("headingDeg") is None:
            continue
        r = math.radians(float(c["headingDeg"]))
        us.append(float(c["speedKt"]) * math.sin(r))
        vs.append(float(c["speedKt"]) * math.cos(r))
    if not us:
        return (0.0, 0.0)
    u, v = sum(us) / len(us), sum(vs) / len(vs)
    return (math.hypot(u, v), math.degrees(math.atan2(u, v)) % 360.0)


def _nexrad_volume(sid: str, vkey: str, vol: Any, fam: str, rid: str = "",
                   motion_fut: Optional[Future] = None, dealias: str = "off") -> dict:
    """radar_xsect's stack of one Level II volume, and what it shows. The
    download is its own step so the view can say which radar it waits on."""
    spec = KDP_SPEC if fam == "K" else l2.L2_MOMENTS[fam]
    src = _source_fam(fam)
    with xs._STACK_LOCK:
        have = (sid, vkey, src) in xs._STACKS
    if not have:
        _download(rid, icao_for(sid), lambda: xs._raw(sid, vol))
    _say(rid, stage="decode", site=icao_for(sid))
    st = xs._stack(sid, vkey, vol, src, dealias if src == "G" else "off")
    if fam == "K":
        ck = (sid, vkey)
        with _KDP_LOCK:
            hit = _KDP.get(ck)
        if hit is None:
            hit = kdp_stack(st)
            with _KDP_LOCK:
                _KDP[ck] = hit
                while len(_KDP) > 3:
                    _KDP.popitem(last=False)
        st = hit
    motion, msrc = None, None
    if fam == "S":
        try:
            got = motion_fut.result(timeout=30) if motion_fut else srv_motion(sid, vkey, "")
            motion, msrc = (got[0], got[1]), got[2]
        except Exception:  # noqa: BLE001 - calm: SRV is then base velocity
            motion, msrc = (0.0, 0.0), "none"
    return {"st": st, "key": vkey, "unix": l2._stamp_unix(st["stamp"]), "label": spec["label"],
            "units": spec["units"], "kind": spec["kind"], "site": icao_for(sid), "vcp": st.get("vcp"),
            "motion": motion, "motionSource": msrc, "dealias": st.get("dealias", "off") if src == "G" else None}


def _br_volume(site: str, vkey: str, fam: str, rid: str = "") -> dict:
    import brazil_radar  # noqa: PLC0415 - h5py and the readers only when a BR radar is asked for

    _say(rid, stage="decode", site=site.upper())
    st = brazil_radar.stack(site.upper(), vkey, None, fam)
    label, units, kind = xs.SECTION_SPECS[fam]
    mo = st.get("motion") if fam == "S" else None
    return {"st": st, "key": st["key"], "unix": int(st["unix"]), "label": label, "units": units, "kind": kind,
            "site": site.upper()[3:], "vcp": None, "motion": (mo["speedKt"], mo["toward"]) if mo else None}


def _volume_key(sid: str, at: Optional[float], key: str) -> tuple[str, Any]:
    """radar_xsect._volume_for, without the live listing for a time the live
    bucket no longer keeps (a cold listing is ~8 s): the archive answers."""
    if at is not None and not key and at < time.time() - _LIVE_SPAN_S:
        arch = l2.archive_volumes(sid, 6, int(at) - 900)
        best = [v for v in arch if v["time"] <= at + 30] or arch[:1]
        if not best:
            raise RuntimeError(f"No Level II volume near that time for {icao_for(sid)}.")
        v = best[-1]
        return v["key"], v["key"][4:]
    return xs._volume_for(sid, at, key)


def site_position(site: str) -> tuple[Optional[float], Optional[float]]:
    """Where a radar stands, from the site list (no volume read)."""
    if _is_br(site):
        import brazil_radar  # noqa: PLC0415

        known = brazil_radar.RADARS.get(site.upper()) or {}
        return known.get("lat"), known.get("lon")
    sid = site_id(site)
    where = next((s for s in _iem_sites() if s["id"] == sid), None) or {}
    return where.get("lat"), where.get("lon")


def srv_motion(sid: str, vkey: str, how: str) -> tuple[float, float, str]:
    """(speed kt, toward deg, source) SRV takes out of a volume. `how` is the
    map's storm-motion setting (auto | sti | <from>/<kt>, as the derived SRV
    reads it: radar_derived.motion_for), so 3D SRV and map SRV agree; with
    none given, the NWS cells nearest the volume's time (motion_at)."""
    if how:
        import radar_derived as rdv  # noqa: PLC0415

        mo = rdv.motion_for(sid, vkey, how, _key_unix(vkey))
        return float(mo["speedKt"]), float(mo["towardDeg"]), str(mo.get("source") or "")
    spd, toward = motion_at(sid, _key_unix(vkey))
    return spd, toward, "sti" if spd > 0 else "none"


def resolve(site: str, at: Optional[float], key: str, fam: str, rid: str = "",
            dealias: str = "off", motion: str = "") -> dict:
    """Which volume, without reading it: {"key", "unix", "lat", "lon", "opt",
    "load": () -> the volume}. A listing at most, so a cached box is found
    before any sweep is decoded. Velocity and SRV are unfolded by `dealias`
    (region | vad | off) and SRV takes out `motion` (see srv_motion); "opt"
    names those for the caches."""
    fam = fam.upper()
    dealias = dealias if dealias in ("region", "vad") else "off"
    opt = f"{dealias}|{motion if fam == 'S' else ''}" if fam in ("G", "S") else ""
    if _is_br(site):
        import brazil_radar  # noqa: PLC0415

        if fam not in xs.SECTION_SPECS:
            raise ValueError(f"Unknown moment {fam}")
        sid = site.upper()
        stamp = key.split(":", 1)[1] if key.startswith("L2BR:") else brazil_radar._newest_stamp(
            sid, int(at) if at else None)
        if not stamp:
            raise ValueError(f"No volume kept for {sid}")
        vkey = f"L2BR:{stamp}"
        known = brazil_radar.RADARS.get(sid) or {}
        return {"key": vkey, "unix": brazil_radar._stamp_unix(stamp), "lat": known.get("lat"),
                "lon": known.get("lon"), "load": lambda: _br_volume(sid, vkey, fam, rid)}
    sid = site_id(site)
    if fam not in l2.L2_MOMENTS and fam != "K":
        raise ValueError(f"Unknown moment {fam}")
    _say(rid, stage="find", site=icao_for(sid))
    vkey, vol = _volume_key(sid, at, key)
    # The storm motion SRV takes out is looked up while the volume downloads.
    mfut = _POOL.submit(srv_motion, sid, vkey, motion) if fam == "S" else None
    lat, lon = site_position(sid)
    return {"key": vkey, "unix": _key_unix(vkey), "lat": lat, "lon": lon, "opt": opt,
            "load": lambda: _nexrad_volume(sid, vkey, vol, fam, rid, mfut, dealias)}


def load_volume(site: str, at: Optional[float], key: str, fam: str) -> dict:
    return resolve(site, at, key, fam)["load"]()


def neighbours(site: str, lat: float, lon: float, limit: int = 3,
               near: Optional[tuple[float, float]] = None) -> list[dict]:
    """The other NEXRADs a cone can be filled from, nearest first: within
    reach of (lat, lon) -- or, given `near` (a box's centre), the ones nearest
    it, which see that box lowest. One standing beside this radar is the same
    view and is left out."""
    me = site_id(site)
    out = []
    for s in _iem_sites():
        if s["id"] == me:
            continue
        d = _km_between(lat, lon, float(s["lat"]), float(s["lon"]))
        if d < _NEIGHBOUR_KM[0]:
            continue
        if near is None:
            if d <= _NEIGHBOUR_KM[1]:
                out.append({**s, "km": d})
            continue
        dn = _km_between(near[0], near[1], float(s["lat"]), float(s["lon"]))
        if dn <= _NEIGHBOUR_KM[1]:
            out.append({**s, "km": dn})
    out.sort(key=lambda s: s["km"])
    return out[:limit]


def nearest_key(sid: str, unix: float) -> str:
    """The key of a radar's Level II volume starting nearest `unix` -- before
    or after it: a neighbour's volume two minutes later is a better match than
    one four minutes earlier."""
    if unix >= time.time() - _LIVE_SPAN_S:
        live = l2.list_volumes(sid, 30)
        if live and unix >= live[0]["time"] - 60:
            return min(live, key=lambda v: abs(v["time"] - unix))["key"]
    arch = l2.archive_volumes(sid, 8, int(unix) - 900)
    if not arch:
        raise RuntimeError(f"No Level II volume near that time for {icao_for(sid)}.")
    return min(arch, key=lambda v: abs(v["time"] - unix))["key"]


def _neighbour_volume(site: str, lat: float, lon: float, unix: int, fam: str, rid: str = "",
                      near: Optional[tuple[float, float]] = None) -> Optional[dict]:
    """The first neighbour with a volume near `unix`: its stack and where it is."""
    errors = []
    for nb in neighbours(site, lat, lon, near=near):
        try:
            v = resolve(nb["id"], None, nearest_key(nb["id"], float(unix)), fam, rid)["load"]()
            if abs(v["unix"] - unix) > 20 * 60:
                errors.append(f"{nb['icao']}: nearest volume {abs(v['unix'] - unix) // 60} min off")
                continue
            v["km"] = nb["km"]
            return v
        except Exception as exc:  # noqa: BLE001 - try the next one
            errors.append(f"{nb.get('icao', nb['id'])}: {exc}")
    return {"error": "; ".join(errors) or "No NEXRAD near enough to fill from."}


# GLM satellites by era: GOES-16 was GOES-East until 2025-04-07, GOES-17
# GOES-West from 2019-02-12 to 2023-01-04. glm.py follows only the current two.
_GOES19_FROM = 1744041600   # 2025-04-07
_GOES18_FROM = 1672790400   # 2023-01-04
_GOES17_FROM = 1549929600   # 2019-02-12
_GLM_FROM = 1495584000      # 2017-05-24, GOES-16's first GLM data in the archive


def glm_buckets(unix: float) -> tuple[Optional[str], Optional[str]]:
    east = "gcp-public-data-goes-19" if unix >= _GOES19_FROM else (
        "gcp-public-data-goes-16" if unix >= _GLM_FROM else None)
    west = "gcp-public-data-goes-18" if unix >= _GOES18_FROM else (
        "gcp-public-data-goes-17" if unix >= _GOES17_FROM else None)
    return east, west


# How far from the point under its satellite (great-circle degrees) a GLM
# sees: the Americas and the oceans either side -- not Guam, not Europe.
_GLM_VIEW_DEG = 66.0
_GLM_SUB_LON = {"east": -75.2, "west": -137.2}


def _glm_sees(side: str, lat: float, lon: float) -> bool:
    c = math.cos(math.radians(lat)) * math.cos(math.radians(lon - _GLM_SUB_LON[side]))
    return math.degrees(math.acos(max(-1.0, min(1.0, c)))) <= _GLM_VIEW_DEG


def glm_sides(start: float, bbox: tuple[float, float, float, float]) -> list[tuple[str, str]]:
    """(side, bucket) of each GOES whose flashes a box (west, south, east,
    north) takes: flying at `start`, on its side of glm.py's split (East from
    SPLIT_LON to EAST_EDGE, West the rest of the globe), and seeing the box."""
    east_b, west_b = glm_buckets(start)
    west, south, east, north = (float(v) for v in bbox)
    w = (west + 180.0) % 360.0 - 180.0
    e = w + ((east - west) % 360.0 if east != west else 0.0)
    clat = (south + north) / 2.0
    clon = ((w + e) / 2.0 + 180.0) % 360.0 - 180.0
    out = []
    if east_b and e >= glm.SPLIT_LON and w < glm.EAST_EDGE and _glm_sees("east", clat, clon):
        out.append(("east", east_b))
    if west_b and (w < glm.SPLIT_LON or e >= glm.EAST_EDGE) and _glm_sees("west", clat, clon):
        out.append(("west", west_b))
    return out


def flashes_in(start: float, end: float, bbox: tuple[float, float, float, float],
               wait_s: float) -> tuple[np.ndarray, dict]:
    """GLM flashes from start to end inside bbox (west, south, east, north),
    from whichever GOES pair was flying then and sees the box, East east of
    glm.SPLIT_LON."""
    west, south, eastl, north = bbox
    wants = glm_sides(start, bbox)
    info = {"start": start, "end": end, "sats": [b.rsplit("-", 2)[-2] + "-" + b.rsplit("-", 1)[-1] for _, b in wants],
            "files": 0, "pending": 0, "available": bool(wants)}
    if not wants:
        info["reason"] = ("GOES lightning (GLM) starts in 2017." if glm_buckets(start) == (None, None)
                          else "No GOES lightning mapper (GLM) sees this area.")
        return np.zeros(0, glm.FLASH), info
    parts = []
    pending: list[Future] = []
    for side, bucket in wants:
        got, waiting = [], []
        for _ts, k in glm._files(bucket, start, end):
            info["files"] += 1
            arr, fut = glm._file(bucket, k)
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
        keep &= (arr["lat"] >= south) & (arr["lat"] <= north) & (arr["lon"] >= west) & (arr["lon"] <= eastl)
        if len(wants) > 1:
            is_east = (arr["lon"] >= glm.SPLIT_LON) & (arr["lon"] < glm.EAST_EDGE)
            keep &= is_east if side == "east" else ~is_east
        parts.append(arr[keep])
    out = np.concatenate(parts) if parts else np.zeros(0, glm.FLASH)
    info["pending"] = len(pending)
    info["count"] = int(out.size)
    return out[np.argsort(out["t"], kind="stable")], info


def flash_rows(arr: np.ndarray, codes: np.ndarray, clat: float, clon: float, half_km: float,
               levels_km: np.ndarray, vmin: float, vmax: float, t0: float,
               half_y_km: Optional[float] = None) -> np.ndarray:
    """Per flash: x and y (km in the box), seconds after the scan's start,
    energy (fJ), and the echo top over it (km above the radar's ground; 0
    when there is no echo there)."""
    out = np.zeros((arr.size, 5), dtype="<f4")
    if arr.size == 0:
        return out
    hy = half_y_km if half_y_km is not None else half_km
    x, y = to_grid_km(clat, clon, arr["lat"], arr["lon"])
    nz, ny, nx = codes.shape
    i = np.floor((x + half_km) / (2 * half_km) * nx).astype(int)
    j = np.floor((y + hy) / (2 * hy) * ny).astype(int)
    inside = (i >= 0) & (i < nx) & (j >= 0) & (j < ny)
    out[:, 0], out[:, 1] = x, y
    out[:, 2] = arr["t"] - t0
    out[:, 3] = arr["energy"]
    thr = int(quantize(np.array([_FLASH_TOP_DBZ], np.float32), vmin, vmax)[0])
    # The highest echo in the 3 x 3 columns around each flash: GLM places a
    # flash to within a few km, and a core's edge is often beside it.
    echo = (codes >= thr) & (codes != CONE)
    lvl = np.arange(nz, dtype=np.int16)[:, None, None]
    top_idx = np.where(echo, lvl, -1).max(axis=0)
    pad = np.pad(top_idx, 1, constant_values=-1)
    near = np.max(np.stack([pad[dj:dj + ny, di:di + nx] for dj in range(3) for di in range(3)]), axis=0)
    ii, jj = np.clip(i, 0, nx - 1), np.clip(j, 0, ny - 1)
    top = near[jj, ii]
    dz = float(levels_km[1] - levels_km[0]) if len(levels_km) > 1 else 0.0
    out[:, 4] = np.where(inside & (top >= 0), np.asarray(levels_km)[np.clip(top, 0, nz - 1)] + dz / 2, 0.0)
    return out[inside]


# ---------------------------------------------------------------------------
# The volume
# ---------------------------------------------------------------------------
def _spec(kind: str) -> tuple[str, float, float]:
    pid = _KIND_DEFAULT_PALETTE.get(kind, "REF")
    _, vmin, vmax = get_cmap(pid)
    if kind == "ref":
        vmin = min(vmin, -20.0)
    return pid, float(vmin), float(vmax)


def _kind_of(site: str, fam: str) -> str:
    if _is_br(site):
        return xs.SECTION_SPECS[fam][2] if fam in xs.SECTION_SPECS else "ref"
    if fam == "K":
        return "kdp"
    return l2.L2_MOMENTS[fam]["kind"] if fam in l2.L2_MOMENTS else "ref"


def label_of(site: str, fam: str) -> str:
    fam = fam.upper()
    if _is_br(site):
        return xs.SECTION_SPECS[fam][0] if fam in xs.SECTION_SPECS else fam
    if fam == "K":
        return KDP_SPEC["label"]
    return l2.L2_MOMENTS[fam]["label"] if fam in l2.L2_MOMENTS else fam


def build(site: str, *, fam: str = "B", at: Optional[float] = None, key: str = "", fill: str = "none",
          center: Optional[tuple[float, float]] = None, half_km: float = 160.0, n: int = 256, nz: int = 64,
          top_km: float = 20.0, half_y_km: Optional[float] = None, ny: Optional[int] = None,
          handle: Optional[dict] = None, resolver: Callable[..., dict] = resolve,
          neighbour_loader: Optional[Callable[..., Optional[dict]]] = None, rid: str = "",
          look: str = "beams") -> dict:
    """The volume on the box: {"meta", "codes" (nz, ny, n) uint8}. Cached by
    the volume and the box; a box already made costs only the listing that
    names its volume."""
    fam = fam.upper()
    t0 = time.time()
    h = handle or resolver(site, at, key, fam)
    hy = float(half_y_km) if half_y_km is not None else float(half_km)
    nrows = int(ny) if ny else int(n)
    where = ("c", round(center[0], 3), round(center[1], 3)) if center else ("radar",)
    ck = (site.upper(), h["key"], fam, h.get("opt", ""), where, round(half_km, 1), round(hy, 1), n, nrows, nz,
          round(top_km, 2), fill, look)
    with _LOCK:
        hit = _CACHE.get(ck)
        if hit is not None:
            _CACHE.move_to_end(ck)
            return hit
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _LOCK:
            hit = _CACHE.get(ck)
            if hit is not None:
                return hit
        kind = _kind_of(site, fam)
        want_fill = fill == "neighbor" and kind in _FILLABLE and not _is_br(site)
        nb_fut: Optional[Future] = None
        nb_load = neighbour_loader or _neighbour_volume

        def nb_submit(rlat: float, rlon: float, unix: int) -> Future:
            if neighbour_loader is not None:
                return _POOL.submit(nb_load, site_id(site), rlat, rlon, unix, fam)
            return _POOL.submit(_neighbour_volume, site_id(site), rlat, rlon, unix, fam, rid, center)

        # The neighbour's volume downloads while this one does, when the radar
        # and the scan time are known from the listing alone.
        if want_fill and h.get("lat") is not None and h.get("unix"):
            nb_fut = nb_submit(float(h["lat"]), float(h["lon"]), int(h["unix"]))
        vol = h["load"]()
        st = vol["st"]
        if want_fill and nb_fut is None:
            nb_fut = nb_submit(float(st["lat"]), float(st["lon"]), vol["unix"])
        t_load = time.time() - t0
        kind = vol["kind"]
        pid, vmin, vmax = _spec(kind)
        clat, clon = center if center else (float(st["lat"]), float(st["lon"]))
        lat, lon = grid_lonlat(clat, clon, half_km, n, hy, nrows)
        dz = top_km / nz
        levels = (np.arange(nz, dtype=np.float32) + 0.5) * dz
        t1 = time.time()
        _say(rid, stage="build", step=0, steps=0, tilts=len(_distinct(st["sweeps"])))
        codes, info = resample(st, lat, lon, levels, kind, vmin, vmax, vol.get("motion"),
                               on_step=lambda k, m: _say(rid, stage="build", step=k, steps=m),
                               smooth=look == "smooth")
        t_resample = time.time() - t1
        cone_voxels = int((codes == CONE).sum())
        fill_info: dict[str, Any] = {"mode": fill}
        if fill == "neighbor" and not want_fill:
            fill_info["status"] = "off"
            fill_info["reason"] = ("Another radar's velocity is a different wind component."
                                   if kind in ("vel", "srv") else "No neighbouring radar to fill from.")
        t2 = time.time()
        if nb_fut is not None:
            # The air under the lowest beam is filled too where the neighbour
            # sees it; where it does not, it goes back to empty.
            under = under_beam(st, lat, lon, levels) & (codes == 0)
            codes[under] = CONE
            try:
                if not nb_fut.done():
                    _say(rid, stage="download")
                nb = nb_fut.result(timeout=120)
            except Exception as exc:  # noqa: BLE001
                nb = {"error": str(exc)}
            if nb and "st" in nb:
                _say(rid, stage="fill", fillSite=nb["site"])
                filled = fill_cone(codes, nb["st"], lat, lon, levels, float(st["groundKm"]), kind, vmin, vmax)
                fill_info.update({"status": "filled", "site": nb["site"], "siteLat": nb["st"]["lat"],
                                  "siteLon": nb["st"]["lon"], "scanUnix": nb["unix"], "key": nb["key"],
                                  "km": round(nb.get("km", 0.0), 1), "voxels": filled,
                                  "underVoxels": int(under.sum())})
            else:
                fill_info.update({"status": "failed", "reason": (nb or {}).get("error", "No neighbour volume.")})
            codes[under & (codes == CONE)] = 0
        t_fill = time.time() - t2
        rx, ry = to_grid_km(clat, clon, st["lat"], st["lon"])
        lut = [None] + [round(vmin + (c - 1) * (vmax - vmin) / (TOP_CODE - 1), 4) for c in range(1, TOP_CODE + 1)] + [None]
        meta = {
            "site": vol["site"], "siteLat": float(st["lat"]), "siteLon": float(st["lon"]),
            "radarHeightKm": round(float(st["heightKm"]), 3), "groundKm": round(float(st["groundKm"]), 3),
            "product": f"3D{fam}", "productLabel": vol["label"], "units": vol["units"], "kind": kind,
            "family": fam, "defaultPalette": pid, "vmin": vmin, "vmax": vmax,
            "nx": n, "ny": nrows, "nz": nz, "halfKm": half_km, "halfXKm": half_km, "halfYKm": hy,
            "topKm": top_km, "dzKm": dz, "centerLat": clat, "centerLon": clon,
            "radarXKm": round(float(rx), 3), "radarYKm": round(float(ry), 3),
            "bbox": [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())],
            "elevations": info["elevations"], "topElev": info["topElev"], "halfBeam": HALF_BEAM,
            "key": vol["key"], "scanUnix": vol["unix"], "vcp": vol.get("vcp"),
            "motion": list(vol["motion"]) if vol.get("motion") else None,
            "motionSource": vol.get("motionSource"), "dealias": vol.get("dealias"),
            "cone": {"voxels": cone_voxels, "left": int((codes == CONE).sum())},
            "fill": fill_info, "look": look,
            "lut": lut,
            "msBuild": {"load": round(t_load * 1000), "resample": round(t_resample * 1000),
                        "fill": round(t_fill * 1000)},
        }
        out = {"meta": meta, "codes": codes}
        with _LOCK:
            _CACHE[ck] = out
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
            _GATES.pop(ck, None)
        return out


def _glm_window(unix: float, minutes: float) -> tuple[float, float]:
    """A minute before the volume starts to its end: a Level II volume takes
    four to ten minutes to fly."""
    start = float(unix) - 60.0
    return start, start + minutes * 60.0


# How long a request waits for lightning files still on their way. A volume's
# six minutes of GLM are whole-disk files, 9 MB of them in May 2024 and 21 MB
# on a busy evening in 2026 -- more than the radar volume -- so they are sent
# for only once the volume is in (sharing the line, they held a 2024 KDMX
# volume back from 8 to 12.7 s), and the volume answers with what is here
# ("pending" says how many are not); part=glm then asks again for the rest.
GLM_WAIT_S = {"all": 1.0, "glm": 3.0}


def volume3d(site: str, *, fam: str = "B", at: Optional[float] = None, key: str = "", fill: str = "none",
             center: Optional[tuple[float, float]] = None, half_km: float = 160.0, n: int = 256, nz: int = 64,
             top_km: float = 20.0, lightning: bool = True, glm_minutes: float = 6.0,
             part: str = "all", bbox: Optional[tuple[float, float, float, float]] = None,
             rid: str = "", compress: bool = False, dealias: str = "off", motion: str = "",
             look: str = "beams") -> bytes:
    """The wire payload (see the module's docstring), uncompressed -- or
    gzipped (`compress`), kept when its lightning is complete. With `bbox`
    (west, south, east, north) the grid is the box's (box_spec), checked
    against the radar's range before any volume is read."""
    t0 = time.time()
    fam = fam.upper()
    h = resolve(site, at, key, fam, rid, dealias, motion)
    half_y_km: Optional[float] = None
    ny: Optional[int] = None
    box: Optional[dict] = None
    if bbox is not None:
        if h.get("lat") is None:
            raise BoxError("Where this radar stands is not known, so a box cannot be placed.")
        kind = _kind_of(site, fam)
        label = icao_for(site) if not _is_br(site) else site.upper()[3:]
        box = box_spec(bbox, float(h["lat"]), float(h["lon"]), kind, label, label_of(site, fam))
        center, half_km, n, nz, top_km = box["center"], box["half_km"], box["n"], box["nz"], box["top_km"]
        half_y_km, ny = box["half_y_km"], box["ny"]
    pk = (site.upper(), h["key"], fam, h.get("opt", ""), fill, bool(lightning), part,
          tuple(round(v, 4) for v in bbox) if bbox else None, center, round(half_km, 2), n, nz, look)
    if compress:
        with _LOCK:
            hit = _PAYLOADS.get(pk)
        if hit is not None:
            _say(rid, stage="done")
            return hit
    v = build(site, fam=fam, at=at, key=key, fill=fill, center=center, half_km=half_km, n=n, nz=nz,
              top_km=top_km, half_y_km=half_y_km, ny=ny, handle=h, rid=rid, look=look)
    meta = dict(v["meta"])
    codes = v["codes"]
    rows = np.zeros((0, 5), dtype="<f4")
    if lightning:
        _say(rid, stage="lightning")
        start, end = _glm_window(meta["scanUnix"], glm_minutes)
        b = meta["bbox"]
        try:
            arr, ginfo = flashes_in(start, end, (b[0], b[1], b[2], b[3]), GLM_WAIT_S.get(part, 1.0))
            top_codes, tmin, tmax = codes, meta["vmin"], meta["vmax"]
            if arr.size and meta["kind"] != "ref":
                # A flash hangs from the reflectivity echo top whatever moment
                # is on show (18 kt of velocity is no echo top): the same box
                # in reflectivity, kept for when the view switches to it.
                try:
                    ref = build(site, fam="B", at=at, key=meta["key"], fill="none", center=center, half_km=half_km,
                                n=n, nz=nz, top_km=top_km, half_y_km=half_y_km, ny=ny, look=look)
                    top_codes, tmin, tmax = ref["codes"], ref["meta"]["vmin"], ref["meta"]["vmax"]
                except Exception:  # noqa: BLE001 - then the top of any echo of this moment
                    tmin, tmax = _FLASH_TOP_DBZ, _FLASH_TOP_DBZ + 1.0
            rows = flash_rows(arr, top_codes, meta["centerLat"], meta["centerLon"], meta["halfXKm"],
                              (np.arange(meta["nz"], dtype=np.float32) + 0.5) * meta["dzKm"],
                              tmin, tmax, float(meta["scanUnix"]), meta["halfYKm"])
            ginfo["count"] = int(rows.shape[0])
        except Exception as exc:  # noqa: BLE001 - the volume without its lightning
            ginfo = {"available": False, "reason": f"GLM: {exc}", "count": 0, "pending": 0}
        meta["glm"] = ginfo
    else:
        meta["glm"] = {"available": False, "count": 0, "pending": 0, "reason": "off"}
    if box is not None:
        meta["box"] = {"bbox": list(bbox), "cellKm": box["cellKm"], "nearestKm": box["nearestKm"]}
    body = b"" if part == "glm" else codes.tobytes()
    meta["volumeBytes"] = len(body)
    meta["flashFields"] = FLASH_FIELDS
    meta["flashCount"] = int(rows.shape[0])
    meta["ms"] = round((time.time() - t0) * 1000)
    head = json.dumps(meta).encode("utf-8")
    payload = struct.pack("<I", len(head)) + head + body + rows.tobytes()
    _say(rid, stage="done")
    if not compress:
        return payload
    packed = gz(payload)
    if not meta["glm"].get("pending"):
        with _LOCK:
            _PAYLOADS[pk] = packed
            while len(_PAYLOADS) > _PAYLOAD_MAX:
                _PAYLOADS.popitem(last=False)
    return packed


def gz(payload: bytes) -> bytes:
    """Mostly empty air: ~4 MB of codes come down to a few hundred kB."""
    return gzip.compress(payload, compresslevel=4)
