"""
Surface fronts found automatically in any model that publishes 850 hPa fields.

Only North America publishes its fronts as data -- WPC's coded bulletin, read by
fronts_core. Everywhere else a surface analysis exists only as a picture, so the
fronts are found here the way research climatologies of fronts are built:
Hewson's (1998) thermal front parameter on 850 hPa equivalent potential
temperature.

    n    = grad(theta_e) / |grad(theta_e)|         points into the warm air
    TFP  = -grad(|grad(theta_e)|) . n
    front line where grad(TFP) . n = 0             TFP peaks: the warm-side edge
                                                   of the baroclinic zone, which
                                                   is where a surface front goes
    kept where TFP > TFP_MIN and |grad(theta_e)| > GRAD_MIN

The type comes from the wind a little way into the cold air, resolved across
the line. Blowing toward the warm side, the cold air is advancing: cold front.
Blowing away from it hard enough, the warm air is: warm front. Neither: the
boundary is holding still. Occlusions and troughs are a forecaster's judgement
and are not attempted.

The constants were calibrated on GFS 0.5 deg against the live WPC analysis
(valid 2026-09-11 15Z, GFS 12Z f003): 70% of the length of WPC's fronts had a
detected front within 300 km, 65% of the detected length lay within 300 km of a
WPC front, and where the two matched the type agreed 77% of the time.

Every other model is first put on that same half-degree grid, so a 3 km model
and a 1 degree one are held to the same definition of a front. A finer model
adds detail to where its fronts are, not more fronts made of its small-scale
noise.
"""
from __future__ import annotations

import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any, Optional

import contourpy
import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates

import model_fields
import model_sources as ms

STEP = 0.5
R_EARTH = 6371e3

# ---- detection (calibrated; see the module docstring) -----------------------
SIGMA_CELLS = 4.5        # Gaussian blur of theta-e before differentiating
TFP_MIN = 0.1            # K per (100 km)^2
GRAD_MIN = 1.5           # K per 100 km
MIN_LENGTH_KM = 600.0    # shorter zero-lines are grid noise, not synoptic fronts
MIN_RUN_KM = 300.0       # a change of type shorter than this is absorbed
LAT_TROPICS = 20.0       # equatorward of this, theta-e gradients are moisture, not air masses
LAT_NORTH = 75.0
LAT_SOUTH = 65.0         # beyond it the Antarctic coast and sea-ice edge read as fronts
TERRAIN_MAX_M = 1500.0   # 850 hPa is underground on the plateaus

# ---- classification ---------------------------------------------------------
COLD_SIDE_DEG = 1.5      # where the wind is read, behind the line
COLD_MS = 1.0            # across-front wind toward the warm side above this: cold
WARM_MS = 4.0            # away from it beyond this: warm (the bias WPC's charts showed)

PROG_HOURS = (12, 24)    # the same progs WPC issues
DEFAULT_MODEL = "gfs-0p50"

_KINDS = {1: ("cold", "Cold front"), -1: ("warm", "Warm front"), 0: ("stationary", "Stationary front")}

_FRAME_CACHE: dict[tuple[str, str, int], dict] = {}
_RESULT_CACHE: dict[tuple[str, int, bool], tuple[float, dict]] = {}
_LATEST: dict[tuple[str, int], tuple[float, datetime]] = {}
_LOCK = threading.Lock()
_TTL = 600.0


# ----------------------------------------------------------------- physics ---
def _es(t: np.ndarray) -> np.ndarray:
    """Saturation vapour pressure over water, hPa (Bolton)."""
    tc = t - 273.15
    return 6.112 * np.exp(17.67 * tc / (tc + 243.5))


def _theta_e(t: np.ndarray, rh: np.ndarray, p: float = 850.0) -> np.ndarray:
    """Bolton (1980) equivalent potential temperature, K."""
    e = np.clip(rh, 1.0, 100.0) / 100.0 * _es(t)
    r = 0.622 * e / (p - e)
    tl = 2840.0 / (3.5 * np.log(t) - np.log(e) - 4.805) + 55.0
    return t * (1000.0 / p) ** (0.2854 * (1 - 0.28 * r)) * np.exp(
        (3.376 / tl - 0.00254) * r * 1000.0 * (1 + 0.81 * r)
    )


def _relative_humidity(name: str, t: np.ndarray, h: np.ndarray, p: float = 850.0) -> np.ndarray:
    """Whatever humidity a centre publishes, as relative humidity in %."""
    if name == "rh850":
        return h
    if name == "q850":
        e = h * p / (0.622 + 0.378 * h)
        return 100.0 * e / _es(t)
    td = h if name == "td850" else t - h  # dew point, or dew point depression
    return 100.0 * _es(td) / _es(t)


def _earth_winds(u: ms.Field, v: ms.Field) -> tuple[np.ndarray, np.ndarray]:
    """u, v relative to east and north.

    Lambert and rotated grids publish their wind along the grid's own axes, and
    across CONUS those axes turn by 20 degrees or more from true east. The
    grid's local orientation is read off its own coordinates, so one rule
    serves every projection.
    """
    if not getattr(u, "grid_relative", False) or u.lons.ndim != 2:
        return u.values, v.values
    lon = np.radians(u.lons.astype(np.float64))
    lat = np.radians(u.lats.astype(np.float64))
    dlon = np.gradient(np.unwrap(lon, axis=1), axis=1)
    dlat = np.gradient(lat, axis=1)
    angle = np.arctan2(dlat, dlon * np.cos(lat))  # the grid's i-axis, from east
    c, s = np.cos(angle), np.sin(angle)
    return (u.values * c - v.values * s).astype(np.float32), (u.values * s + v.values * c).astype(np.float32)


def _smooth(a: np.ndarray, sigma: float, world: bool) -> np.ndarray:
    """Gaussian blur that leaves missing data missing instead of smearing it."""
    mode = ("nearest", "wrap") if world else "nearest"
    valid = np.isfinite(a)
    if valid.all():
        return gaussian_filter(a, sigma=sigma, mode=mode)
    num = gaussian_filter(np.where(valid, a, 0.0), sigma=sigma, mode=mode)
    den = gaussian_filter(valid.astype(np.float32), sigma=sigma, mode=mode)
    out = num / np.maximum(den, 1e-6)
    out[den < 0.6] = np.nan
    return out


def _km(line: np.ndarray) -> np.ndarray:
    lon1, lat1 = np.radians(line[:-1, 0]), np.radians(line[:-1, 1])
    lon2, lat2 = np.radians(line[1:, 0]), np.radians(line[1:, 1])
    h = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(h, 0.0, 1.0)))


class _Grid:
    """The half-degree grid a detection runs on."""

    def __init__(self, lats: np.ndarray, lons: np.ndarray, world: bool):
        self.lats, self.lons, self.world = lats, lons, world
        self.cosl = np.maximum(np.cos(np.radians(lats)), 0.05)[:, None]
        self.dy = R_EARTH * math.radians(STEP)

    def ddx(self, f: np.ndarray) -> np.ndarray:
        if self.world:
            return (np.roll(f, -1, 1) - np.roll(f, 1, 1)) / (2 * self.dy * self.cosl)
        g = np.full_like(f, np.nan)
        g[:, 1:-1] = (f[:, 2:] - f[:, :-2]) / (2 * self.dy * self.cosl)
        return g

    def ddy(self, f: np.ndarray) -> np.ndarray:  # northward; rows run north -> south
        g = np.full_like(f, np.nan)
        g[1:-1] = (f[:-2] - f[2:]) / (2 * self.dy)
        return g

    def sample(self, arr: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        jj = (self.lats[0] - lat) / STEP
        if self.world:
            ii = (lon % 360.0) / STEP
            return map_coordinates(arr, np.vstack([jj, ii]), order=1, mode="grid-wrap")
        ii = (lon - self.lons[0]) / STEP
        return map_coordinates(arr, np.vstack([jj, ii]), order=1, mode="nearest")


def _detect(grid: _Grid, te: np.ndarray, orog: Optional[np.ndarray]):
    ts = _smooth(te, SIGMA_CELLS, grid.world)
    gx, gy = grid.ddx(ts), grid.ddy(ts)
    mag = np.hypot(gx, gy)
    safe = np.maximum(np.nan_to_num(mag), 1e-12)
    nx, ny = gx / safe, gy / safe
    tfp = _smooth(-(grid.ddx(mag) * nx + grid.ddy(mag) * ny), 1.0, grid.world)
    locator = grid.ddx(tfp) * nx + grid.ddy(tfp) * ny

    lat2d = np.broadcast_to(grid.lats[:, None], te.shape)
    with np.errstate(invalid="ignore"):
        ok = (
            np.isfinite(locator)
            & (tfp * 1e10 > TFP_MIN)
            & (mag * 1e5 > GRAD_MIN)
            & (np.abs(lat2d) >= LAT_TROPICS)
            & (lat2d <= LAT_NORTH)
            & (lat2d >= -LAT_SOUTH)
        )
        if orog is not None:
            ok &= ~(orog >= TERRAIN_MAX_M)

    z = np.ma.masked_array(np.nan_to_num(locator), mask=~ok)[::-1]
    lons = grid.lons
    if grid.world:
        # First column repeated at 360, so a front crossing the prime meridian
        # is traced whole rather than cut there.
        z = np.ma.concatenate([z, z[:, :1]], axis=1)
        lons = np.append(lons, 360.0)
    gen = contourpy.contour_generator(x=lons, y=grid.lats[::-1], z=z, line_type=contourpy.LineType.Separate)
    lines = [ln for ln in gen.lines(0.0) if len(ln) >= 3 and _km(ln).sum() >= MIN_LENGTH_KM]
    return lines, np.nan_to_num(nx), np.nan_to_num(ny)


def _classify(grid: _Grid, line: np.ndarray, nx, ny, u, v) -> np.ndarray:
    """Per vertex: 1 cold, -1 warm, 0 stationary."""
    lon, lat = line[:, 0], line[:, 1]
    snx, sny = grid.sample(nx, lon, lat), grid.sample(ny, lon, lat)
    norm = np.maximum(np.hypot(snx, sny), 1e-6)
    snx, sny = snx / norm, sny / norm
    cosl = np.maximum(np.cos(np.radians(lat)), 0.2)
    clon, clat = lon - snx * COLD_SIDE_DEG / cosl, lat - sny * COLD_SIDE_DEG
    across = np.nan_to_num(grid.sample(u, clon, clat) * snx + grid.sample(v, clon, clat) * sny)
    k = max(1, min(9, len(across) // 3))
    across = np.convolve(across, np.ones(k) / k, mode="same")
    return np.where(across > COLD_MS, 1, np.where(across < -WARM_MS, -1, 0))


def _typed_runs(line: np.ndarray, kinds: np.ndarray) -> list[tuple[np.ndarray, int]]:
    """Cut a line where its type changes, absorbing changes too short to mean
    anything -- a front that flips type every 100 km is one front, not five."""
    seg_km = _km(line)
    seg_kind = kinds[:-1]
    runs: list[list[int]] = []
    start = 0
    for i in range(1, len(seg_kind) + 1):
        if i == len(seg_kind) or seg_kind[i] != seg_kind[start]:
            runs.append([start, i, int(seg_kind[start])])
            start = i

    def length(r: list[int]) -> float:
        return float(seg_km[r[0]:r[1]].sum())

    while len(runs) > 1:
        j = min(range(len(runs)), key=lambda k: length(runs[k]))
        if length(runs[j]) >= MIN_RUN_KM:
            break
        left = runs[j - 1] if j > 0 else None
        right = runs[j + 1] if j + 1 < len(runs) else None
        if right is None or (left is not None and length(left) >= length(right)):
            left[1] = runs[j][1]
        else:
            right[0] = runs[j][0]
        runs.pop(j)
        k = 0
        while k < len(runs) - 1:
            if runs[k][2] == runs[k + 1][2]:
                runs[k][1] = runs[k + 1][1]
                runs.pop(k + 1)
            else:
                k += 1
    return [(line[r[0]:r[1] + 1], r[2]) for r in runs]


def _geo(line: np.ndarray) -> list[list[list[float]]]:
    """-180..180 coordinates, cut where a line crosses the antimeridian so it is
    not drawn the long way round the map."""
    out: list[list[list[float]]] = []
    run: list[list[float]] = []
    prev: Optional[float] = None
    for x, y in line:
        lon = ((float(x) + 180.0) % 360.0) - 180.0
        if prev is not None and abs(lon - prev) > 180.0:
            if len(run) >= 2:
                out.append(run)
            run = []
        run.append([round(lon, 2), round(float(y), 2)])
        prev = lon
    if len(run) >= 2:
        out.append(run)
    return out


_TERRAIN: list[np.ndarray] = []


def _terrain(lats: np.ndarray, lons: np.ndarray) -> Optional[np.ndarray]:
    """Terrain height on a detection grid, for a model that does not publish its
    own. GFS's serves: at half a degree the mountains are the same ones."""
    if not _TERRAIN:
        try:
            field, _ = ms.fetch_field(DEFAULT_MODEL, "orog", 0)
        except Exception:  # noqa: BLE001 - masking terrain is a refinement
            return None
        world = ms.regular(field, STEP, "terrain")[2]
        with _LOCK:
            if not _TERRAIN:
                _TERRAIN.append(world)
    shape = (lats.size, lons.size)
    jj = np.broadcast_to(((90.0 - lats) / STEP)[:, None], shape)
    ii = np.broadcast_to(((lons % 360.0) / STEP)[None, :], shape)
    return map_coordinates(_TERRAIN[0], [jj, ii], order=1, mode="grid-wrap").astype(np.float32)


# ------------------------------------------------------------------ frames ---
def _centres(model: str, run: datetime, hour: int) -> list[dict]:
    """H and L from the model's own pressure field, at its own resolution."""
    if not ms.has_mslp(model):
        return []
    try:
        field, _ = ms.fetch_field(model, "mslp", hour, run)
    except Exception:  # noqa: BLE001 - fronts without centres beat no fronts
        return []
    m = ms.MODELS[model]
    spacing = m["spacing"]
    orog = None
    if field.scattered:
        lats, lons, values = ms.regular(field, 0.25, f"{model}:mesh")
        spacing, world = 0.25, True
    else:
        lons, lats, values, world = field.lons, field.lats, field.values, field.world
    if "orog" in ms.fields_of(model):
        try:
            of, _ = ms.fetch_field(model, "orog", hour, run)
            ov = ms.regular(of, 0.25, f"{model}:mesh")[2] if of.scattered else of.values
            orog = ov if ov.shape == values.shape else None
        except Exception:  # noqa: BLE001
            orog = None
    valid = np.isfinite(values)
    if not valid.all():
        values = np.where(valid, values, np.nanmean(values))
    sigma = model_fields.SMOOTH_DEG / max(spacing, 0.01)
    smooth = gaussian_filter(values, sigma=sigma, mode=("nearest", "wrap") if world else "nearest")
    out = []
    for c in model_fields._centres(lons, lats, smooth, spacing, orog, world=world, valid=valid):
        high = c["properties"]["kind"] == "H"
        hpa = int(c["properties"]["hPa"])
        out.append({
            "type": "Feature",
            "geometry": c["geometry"],
            "properties": {
                "kind": "high" if high else "low",
                "symbol": "H" if high else "L",
                "pressure": hpa,
                "label": f"{'High' if high else 'Low'} {hpa} hPa",
            },
        })
    return out


def _analyse(model: str, run: datetime, hour: int) -> Optional[dict]:
    key = (model, run.strftime("%Y%m%d%H"), hour)
    with _LOCK:
        hit = _FRAME_CACHE.get(key)
    if hit is not None:
        return hit
    fields = ms.fields_of(model)
    humidity = next(h for h in ms.HUMIDITY if h in fields)
    try:
        t_field, _ = ms.fetch_field(model, "t850", hour, run)
    except ms.RateLimited:
        raise
    except RuntimeError:
        return None  # not published (yet); not cached, it may appear
    h_field, _ = ms.fetch_field(model, humidity, hour, run)
    u_field, _ = ms.fetch_field(model, "u850", hour, run)
    v_field, _ = ms.fetch_field(model, "v850", hour, run)
    u_earth, v_earth = _earth_winds(u_field, v_field)
    u_field = ms.Field(u_field.lons, u_field.lats, u_earth, u_field.world)
    v_field = ms.Field(v_field.lons, v_field.lats, v_earth, v_field.world)

    grid_key = f"{model}:fronts"
    lats, lons, t = ms.regular(t_field, STEP, grid_key)
    h = ms.regular(h_field, STEP, grid_key)[2]
    u = ms.regular(u_field, STEP, grid_key)[2]
    v = ms.regular(v_field, STEP, grid_key)[2]
    orog = None
    if "orog" in fields:
        try:
            orog = ms.regular(ms.fetch_field(model, "orog", hour, run)[0], STEP, grid_key)[2]
        except Exception:  # noqa: BLE001 - masking terrain is a refinement
            orog = None
    if orog is None:
        orog = _terrain(lats, lons)

    grid = _Grid(lats, lons, t_field.world)
    with np.errstate(invalid="ignore", divide="ignore"):
        te = _theta_e(t, _relative_humidity(humidity, t, h))

    features: list[dict] = []
    counts: dict[str, int] = {}
    lines, nx, ny = _detect(grid, te, orog)
    for line in lines:
        for piece, cls in _typed_runs(line, _classify(grid, line, nx, ny, u, v)):
            kind, label = _KINDS[cls]
            for coords in _geo(piece):
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {"kind": kind, "label": label, "strength": "", "points": len(coords)},
                })
                counts[kind] = counts.get(kind, 0) + 1
    for c in _centres(model, run, hour):
        features.append(c)
        counts[c["properties"]["kind"]] = counts.get(c["properties"]["kind"], 0) + 1

    valid = run + timedelta(hours=hour)
    frame = {
        "id": f"{model}-{key[1]}-f{hour:03d}",
        # A model with no f000 (HREF) has its earliest hour stand in.
        "kind": "analysis" if hour == ms.forecast_hours(model)[0] else "forecast",
        "label": "Analysis" if hour == 0 else f"{hour} h forecast",
        "valid": valid.strftime("%Y-%m-%dT%H:%MZ"),
        "validUnix": int(valid.timestamp()),
        "issuedUnix": int(run.timestamp()),
        "counts": counts,
        "features": features,
    }
    with _LOCK:
        _FRAME_CACHE[key] = frame
        while len(_FRAME_CACHE) > 64:
            _FRAME_CACHE.pop(next(iter(_FRAME_CACHE)))
    return frame


def _latest_run(model: str, need_hour: int) -> datetime:
    """The newest run that already carries `need_hour` (the last prog wanted)."""
    with _LOCK:
        hit = _LATEST.get((model, need_hour))
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    for run in ms.candidate_runs(model):
        try:
            ms.fetch_field(model, "t850", need_hour, run)
        except ms.RateLimited:
            raise
        except RuntimeError:
            continue
        with _LOCK:
            _LATEST[(model, need_hour)] = (time.time(), run)
        return run
    raise RuntimeError(f"No recent {ms.MODELS[model]['label']} run carries f{need_hour:03d}")


def _safe(model: str, run: datetime, hour: int):
    try:
        return _analyse(model, run, hour)
    except Exception as exc:  # noqa: BLE001 - one bad frame must not sink the rest
        return exc


_FAILED: dict[tuple[str, int, bool], tuple[float, str]] = {}
_FAIL_TTL = 90.0
_GATES: dict[tuple[str, int, bool], threading.Lock] = {}


def build_fronts(model: str = DEFAULT_MODEL, history: int = 0, forecast: bool = True) -> dict:
    """Analyses back through `history` and the 12 h / 24 h progs, oldest first.

    `history` counts WPC's 3-hourly analyses, so the stretch of time back is
    3 h per step; within it one run every 6 hours is used, where the model
    runs then.

    One build per model at a time, and a failure is remembered for a minute and
    a half: requests arriving together, or straight after a failure, get the
    same answer instead of each fetching every field again -- from a server
    that is often why it failed.
    """
    if model not in ms.MODELS:
        raise ValueError(f"Unknown model: {model}")
    if not ms.has_fronts(model):
        raise ValueError(f"{ms.MODELS[model]['label']} does not publish the 850 hPa fields fronts need")
    ck = (model, max(0, min(int(history), 24)), bool(forecast))
    with _LOCK:
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _LOCK:
            hit = _RESULT_CACHE.get(ck)
            failed = _FAILED.get(ck)
        if hit and time.time() - hit[0] < _TTL:
            return hit[1]
        if failed and time.time() - failed[0] < _FAIL_TTL:
            raise RuntimeError(failed[1])
        try:
            return _build(model, ck)
        except Exception as exc:
            with _LOCK:
                _FAILED[ck] = (time.time(), str(exc))
            raise


def _build(model: str, ck: tuple[str, int, bool]) -> dict:
    forecast = ck[2]
    m = ms.MODELS[model]
    hours = ms.forecast_hours(model)
    first = hours[0]
    progs = [h for h in PROG_HOURS if h in hours and h > first] if forecast else []
    latest = _latest_run(model, progs[-1] if progs else first)
    span = ck[1] * 3
    runs = [latest - timedelta(hours=k) for k in range(0, span + 1, 6)]
    runs = [r for r in runs if r.hour in m["cycles"]]
    jobs = [(r, first) for r in reversed(runs)] + [(latest, h) for h in progs]

    frames: list[dict] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for (run, hour), res in zip(jobs, pool.map(lambda j: _safe(model, *j), jobs)):
            if isinstance(res, Exception):
                errors.append(f"{run:%d %HZ} f{hour:03d}: {res}")
            elif res is None:
                errors.append(f"{run:%d %HZ} f{hour:03d}: not published")
            else:
                frames.append(res)
    if not frames:
        raise RuntimeError(f"No {m['label']} frame could be analysed" + (f" ({errors[0]})" if errors else ""))

    frames.sort(key=lambda f: f["validUnix"])
    out = {
        "frames": frames,
        "meta": {
            "count": len(frames),
            "analyses": sum(1 for f in frames if f["kind"] == "analysis"),
            "forecasts": sum(1 for f in frames if f["kind"] == "forecast"),
            "errors": errors,
            "model": model,
            "modelLabel": m["label"],
            "source": f"{m['label']} ({m['org']}) -- fronts found automatically from 850 hPa theta-e",
        },
    }
    with _LOCK:
        _RESULT_CACHE[ck] = (time.time(), out)
        while len(_RESULT_CACHE) > 16:
            _RESULT_CACHE.pop(next(iter(_RESULT_CACHE)))
    return out
