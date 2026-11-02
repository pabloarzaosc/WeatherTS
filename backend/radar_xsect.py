"""
Vertical cross-sections through a NEXRAD Level II volume.

A line drawn on the map, A to B, and every tilt of the volume sampled under it:
what the storm looks like from the side -- the core's height, a hail shaft,
the bounded weak echo region over an inflow notch, a velocity couplet's depth.

The volume nearest the frame on screen is used, from the live chunk bucket for
the last two days and the Level II archive before that, and it is read whole:
a section needs every tilt, where the map's Level II reads one. The moment's
sweeps are pulled out once per volume and kept, so dragging the line's ends
costs only the sampling (~0.1 s), not the decode (1-3 s).

Geometry is the radar's own: the 4/3-earth beam model the WSR-88D products are
computed with. For each point of the section -- distance along the line, height
above sea level -- the elevation angle and slant range from the radar say which
beam lights it and which gate. Inside a beam (half of its 0.95 deg width either
side of its centre) that beam's value is used; in the gap between two beams the
two are blended by angle for the smooth moments, and the nearer one is used for
velocity, where blending across a fold would make up a value.
"""
from __future__ import annotations

import io
import math
import threading
import time
from collections import OrderedDict
from typing import Any, Optional

import numpy as np
from metpy.io import Level2File

import level2_fast
import nexrad_level2 as l2
from nexrad_core import _KIND_DEFAULT_PALETTE, _mean_storm_motion, get_cmap, icao_for, site_id

RE_EFF_KM = 6371.0 * 4.0 / 3.0  # the 4/3-earth radius the beam model uses
HALF_BEAM = 0.95 / 2.0
# Beyond this the two beams either side are too far apart to blend: a column
# of nothing reads truer than a guess across 4 degrees.
MAX_BLEND_GAP = 3.0
# Moments blended across the gap between beams; the rest take the nearer beam.
_BLEND = {"ref", "cc", "zdr", "sw", "phi", "cfp"}

_STACKS: "OrderedDict[tuple, dict]" = OrderedDict()
_STACK_MAX = 4
_STACK_LOCK = threading.Lock()
_GATES: dict[tuple, threading.Lock] = {}


def _volume_for(site: str, at: Optional[float], key: str) -> tuple[str, Any]:
    """(key, volume id) of the Level II volume to slice: the one named, or the
    newest at or before `at`, or the newest of all."""
    if key.startswith("L2A:"):
        return key, key[4:]
    if key.startswith("L2:"):
        bits = key.split(":")
        if len(bits) >= 3 and bits[1].isdigit():
            return key, int(bits[1])
    live = l2.list_volumes(site, 30)
    if at is None:
        if not live:
            raise RuntimeError(f"No complete Level II volume for {icao_for(site)}.")
        v = live[-1]
        return v["key"], v["vol"]
    # The live bucket keeps about two days but its oldest volumes are losing
    # chunks; past the listing's reach the archive answers.
    if live and at >= live[0]["time"] - 60:
        best = [v for v in live if v["time"] <= at + 30] or live[:1]
        v = best[-1]
        return v["key"], v["vol"]
    arch = l2.archive_volumes(site, 6, int(at) - 900)
    best = [v for v in arch if v["time"] <= at + 30] or arch[:1]
    if not best:
        raise RuntimeError(f"No Level II volume near that time for {icao_for(site)}.")
    v = best[-1]
    return v["key"], v["key"][4:]


def _raw(site: str, vol: Any) -> tuple[bytes, str]:
    if isinstance(vol, str):
        raw = l2._kept(("archive", vol), lambda: l2._archive_get(l2._archive_path(vol)))
        return raw, f"{vol[4:12]}-{vol[13:19]}"
    return l2._volume_raw(icao_for(site), vol)


def _stack(site: str, key: str, vol: Any, fam: str, dealias: str = "off") -> dict:
    """Every sweep of one moment in a volume: elevation, azimuths (sorted),
    gate spacing and values (and the Nyquist velocity, m/s, where known), one
    sweep per cut (the longest-range one of a split cut), low to high.
    Velocity ("G") with `dealias` region | vad comes unfolded the way the
    map's Level II velocity is (radar_derived.unfold), sweep by sweep."""
    if fam == "G" and dealias in ("region", "vad"):
        return _unfolded_stack(site, key, vol, dealias)
    ck = (site, key, fam)
    with _STACK_LOCK:
        hit = _STACKS.get(ck)
        if hit is not None:
            _STACKS.move_to_end(ck)
            return hit
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _STACK_LOCK:
            hit = _STACKS.get(ck)
            if hit is not None:
                return hit
        spec = l2.L2_MOMENTS[fam]
        src = spec["src"]
        raw, stamp = _raw(site, vol)
        with l2._DECODE_SEM:
            # The one moment read straight from the bytes (level2_fast, ~0.3
            # s); MetPy, which scales every moment (~2.5 s), for what that
            # does not read -- a legacy volume.
            buf = level2_fast.plain(raw)
            fast = level2_fast.read_moment(buf, src, l2._MS_TO_KT if spec.get("kt") else None)
            if fast is not None:
                out = {"sweeps": fast["sweeps"], "lat": fast["lat"], "lon": fast["lon"],
                       "heightKm": (fast["siteAmslM"] + fast["feedhornM"]) / 1000.0,
                       "groundKm": fast["siteAmslM"] / 1000.0, "stamp": stamp, "vcp": fast["vcp"]}
                with _STACK_LOCK:
                    _STACKS[ck] = out
                    while len(_STACKS) > _STACK_MAX:
                        _STACKS.popitem(last=False)
                    _GATES.pop(ck, None)
                return out
            f = Level2File(io.BytesIO(buf))
            first = None  # a radial, for where the radar is
            by_angle: dict[float, tuple[int, int]] = {}
            for i, sw in enumerate(f.sweeps):
                if not sw or src not in l2._moments(sw[0]):
                    continue
                if first is None:
                    first = sw[0]
                angle = round(l2._sweep_angle(f, sw), 1)
                gates = int(l2._moments(sw[0])[src][0].num_gates)
                # A split cut flies the angle twice; the sweep reaching
                # furthest is the surveillance one (reflectivity to 460 km).
                if angle not in by_angle or gates > by_angle[angle][1]:
                    by_angle[angle] = (i, gates)
            if first is None:
                raise RuntimeError(f"This volume carries no {spec['label']}.")
            sweeps = []
            for angle in sorted(by_angle):
                idx, ngates = by_angle[angle]
                radials = sorted(f.sweeps[idx], key=lambda r: float(r[0].az_angle))
                h0 = l2._moments(radials[0])[src][0]
                vals = np.full((len(radials), ngates), np.nan, dtype=np.float32)
                az = np.empty(len(radials), dtype=np.float32)
                for k, r in enumerate(radials):
                    az[k] = float(r[0].az_angle)
                    blk = l2._moments(r).get(src)
                    if blk is None:
                        continue
                    d = np.asarray(blk[1], dtype=np.float32)
                    n = min(d.size, ngates)
                    vals[k, :n] = d[:n]
                if spec.get("kt"):
                    vals *= l2._MS_TO_KT
                r0 = radials[0]
                if len(r0) > 4 and r0[3] is not None:
                    nyq = float(getattr(r0[3], "nyq_vel", 0.0) or 0.0) or None
                else:
                    nyq = float(getattr(r0[0], "nyq_vel", 0.0) or 0.0) or None
                sweeps.append({
                    "elev": float(angle), "az": az, "first": float(h0.first_gate),
                    "width": float(h0.gate_width), "vals": vals.astype(np.float16), "nyq": nyq,
                })
            lat, lon, vcp = l2._site_of(first, site)
            # A legacy volume (before 2008) says nothing of the antenna's height.
            hdr = first[1] if len(first) > 4 else None
            site_amsl = float(getattr(hdr, "site_amsl", 0.0) or 0.0)
            feed = float(getattr(hdr, "feedhorn_agl", 0.0) or 0.0)
            out = {
                "sweeps": sweeps, "lat": lat, "lon": lon,
                "heightKm": (site_amsl + feed) / 1000.0, "groundKm": site_amsl / 1000.0,
                "stamp": stamp, "vcp": vcp,
            }
            del f
        with _STACK_LOCK:
            _STACKS[ck] = out
            while len(_STACKS) > _STACK_MAX:
                _STACKS.popitem(last=False)
            _GATES.pop(ck, None)
        return out


def _to_xyz(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def _line(a: tuple[float, float], b: tuple[float, float], n: int) -> tuple[np.ndarray, np.ndarray, float]:
    """n points on the great circle from a to b (lat, lon), and its length (km)."""
    pa, pb = _to_xyz(np.array(a[0]), np.array(a[1])), _to_xyz(np.array(b[0]), np.array(b[1]))
    omega = float(np.arccos(np.clip(np.dot(pa, pb), -1.0, 1.0)))
    t = np.linspace(0.0, 1.0, n)
    if omega < 1e-9:
        p = np.repeat(pa[None, :], n, axis=0)
    else:
        p = (np.sin((1 - t) * omega)[:, None] * pa + np.sin(t * omega)[:, None] * pb) / math.sin(omega)
    lat = np.degrees(np.arcsin(np.clip(p[:, 2], -1, 1)))
    lon = np.degrees(np.arctan2(p[:, 1], p[:, 0]))
    return lat, lon, omega * 6371.0


def _from_radar(rlat: float, rlon: float, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Ground distance (km) and azimuth (deg) of each point from the radar."""
    p1, p2 = math.radians(rlat), np.radians(lat)
    dl = np.radians(lon - rlon)
    s = 6371.0 * np.arccos(np.clip(math.sin(p1) * np.sin(p2) + math.cos(p1) * np.cos(p2) * np.cos(dl), -1, 1))
    az = np.degrees(np.arctan2(np.sin(dl) * np.cos(p2), math.cos(p1) * np.sin(p2) - math.sin(p1) * np.cos(p2) * np.cos(dl)))
    return s, az % 360.0


def _unfolded_stack(site: str, key: str, vol: Any, alg: str) -> dict:
    """The velocity stack unfolded by `alg`, cached beside the raw one: what
    the map draws as Level II velocity, so the 3D view, the cross-section and
    their SRV agree with it. Region unfolding gets the cut's reflectivity
    (the surveillance sweep's, regridded) as the map's does."""
    import radar_derived as rdv  # noqa: PLC0415 - radar_derived imports this module

    ck = (site, key, "G", alg)
    with _STACK_LOCK:
        hit = _STACKS.get(ck)
        if hit is not None:
            _STACKS.move_to_end(ck)
            return hit
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _STACK_LOCK:
            hit = _STACKS.get(ck)
            if hit is not None:
                return hit
        raw = _stack(site, key, vol, "G")
        ref = None
        if alg == "region":
            try:
                ref = _stack(site, key, vol, "B")
            except Exception:  # noqa: BLE001 - unfolded without it
                ref = None
        sweeps = []
        for sw in raw["sweeps"]:
            nyq = sw.get("nyq")
            if not nyq:
                sweeps.append(sw)
                continue
            v = sw["vals"].astype(np.float32) / np.float32(l2._MS_TO_KT)
            r = (sw["first"] + np.arange(v.shape[1], dtype=np.float64) * sw["width"])
            dbz = None
            if ref is not None:
                b = next((x for x in ref["sweeps"] if abs(x["elev"] - sw["elev"]) < 0.05), None)
                if b is not None:
                    rb = b["first"] + np.arange(b["vals"].shape[1], dtype=np.float64) * b["width"]
                    dbz = rdv.regrid(b["vals"].astype(np.float32), b["az"].astype(np.float64), rb,
                                     sw["az"].astype(np.float64), r)
            u = rdv.unfold(v, nyq, r, sw["az"].astype(np.float64), float(sw["elev"]), alg, dbz)
            sweeps.append(dict(sw, vals=(u * np.float32(l2._MS_TO_KT)).astype(np.float16)))
        out = dict(raw, sweeps=sweeps, dealias=alg)
        with _STACK_LOCK:
            _STACKS[ck] = out
            while len(_STACKS) > _STACK_MAX:
                _STACKS.popitem(last=False)
            _GATES.pop(ck, None)
        return out


def _sample(sw: dict, az: np.ndarray, rng: np.ndarray) -> np.ndarray:
    """A sweep's value at each (azimuth of the column, slant range of the pixel)."""
    azs = sw["az"].astype(np.float64)
    n = azs.size
    # The radial nearest each column's azimuth, across the 360/0 seam.
    j = np.searchsorted(azs, az) % n
    i = (j - 1) % n
    dj = np.abs(((azs[j] - az) + 180.0) % 360.0 - 180.0)
    di = np.abs(((azs[i] - az) + 180.0) % 360.0 - 180.0)
    rad = np.where(dj < di, j, i)
    g = np.floor((rng - sw["first"]) / sw["width"]).astype(np.int64)
    vals = sw["vals"]
    ok = (g >= 0) & (g < vals.shape[1])
    out = np.full(rng.shape, np.nan, dtype=np.float32)
    rows = np.broadcast_to(rad[None, :], rng.shape)
    out[ok] = vals[rows[ok], g[ok]]
    return out


def cross_section(site: str, a: tuple[float, float], b: tuple[float, float], fam: str = "B",
                  at: Optional[float] = None, key: str = "", top_km: float = 16.0,
                  cols: int = 0, rows: int = 320, dealias: str = "off", motion: str = "") -> dict:
    """The section from a to b (lat, lon) of moment `fam` (an L2 family code).
    Velocity and SRV unfolded by `dealias`; SRV takes out `motion` (auto |
    sti | <from>/<kt>, the map's storm-motion setting), or with none given
    the NWS cells' mean motion as before."""
    site = site_id(site)
    if fam not in l2.L2_MOMENTS:
        raise ValueError(f"Unknown moment {fam}")
    spec = l2.L2_MOMENTS[fam]
    src_fam = "G" if fam == "S" else fam  # storm-relative rides on velocity
    t0 = time.time()
    vkey, vol = _volume_for(site, at, key)
    st = _stack(site, vkey, vol, src_fam, dealias)
    how, motion = motion, None
    if fam == "S":
        if how:
            import radar_derived as rdv  # noqa: PLC0415

            mo = rdv.motion_for(site, vkey, how, l2._stamp_unix(st["stamp"]))
            motion = (float(mo["speedKt"]), float(mo["towardDeg"]))
        else:
            speed_kt, toward = _mean_storm_motion(site)
            motion = (speed_kt, toward)
    out = section(st, a, b, fam=fam, label=spec["label"], units=spec["units"], kind=spec["kind"],
                  site_label=icao_for(site), key=vkey, scan_unix=l2._stamp_unix(st["stamp"]), motion=motion,
                  top_km=top_km, cols=cols, rows=rows)
    out["meta"]["ms"] = round((time.time() - t0) * 1000)
    return out


# Moments a non-NEXRAD volume can be sliced in, by the viewer's family code.
SECTION_SPECS = {
    "B": ("Reflectivity", "dBZ", "ref"), "U": ("Unfiltered Reflectivity", "dBZ", "ref"),
    "G": ("Velocity", "kt", "vel"), "S": ("Storm Relative Velocity", "kt", "srv"), "W": ("Spectrum Width", "kt", "sw"),
    "C": ("Correlation Coefficient", "", "cc"), "X": ("Differential Reflectivity", "dB", "zdr"),
    "P": ("Differential Phase", "°", "phi"), "K": ("Specific Differential Phase", "°/km", "kdp"),
}


def section(st: dict, a: tuple[float, float], b: tuple[float, float], *, fam: str, label: str, units: str,
            kind: str, site_label: str, key: str, scan_unix: Optional[int],
            motion: Optional[tuple[float, float]] = None, top_km: float = 16.0, cols: int = 0,
            rows: int = 320) -> dict:
    """The section from a to b through a stack of sweeps (see _stack): the
    part every radar shares, whatever its volume came from."""
    t0 = time.time()
    length_guess = _line(a, b, 2)[2]
    if cols <= 0:
        cols = int(min(900, max(240, length_guess / 0.25)))
    rows = int(min(600, max(120, rows)))
    top_km = float(min(25.0, max(4.0, top_km)))
    lat, lon, length = _line(a, b, cols)
    s, az = _from_radar(st["lat"], st["lon"], lat, lon)

    # Elevation angle and slant range from the radar to each (height, column).
    z = np.linspace(top_km, 0.0, rows)[:, None]  # top row first, km MSL
    h0 = st["heightKm"]
    phi = (s / RE_EFF_KM)[None, :]
    ra, rp = RE_EFF_KM + h0, RE_EFF_KM + z
    x = rp * np.sin(phi)
    y = rp * np.cos(phi) - ra
    theta = np.degrees(np.arctan2(y, x))
    rng = np.sqrt(x * x + y * y)

    sweeps = st["sweeps"]
    elevs = np.array([sw["elev"] for sw in sweeps])
    samples = np.stack([_sample(sw, az, rng) for sw in sweeps])  # tilts x rows x cols
    if fam == "S" and motion is not None:
        speed_kt, toward = motion
        samples = samples - (speed_kt * np.cos(np.radians(az - toward)))[None, None, :]

    # The beam each pixel sits in, or the two either side of it.
    hi = np.clip(np.searchsorted(elevs, theta), 1, len(elevs) - 1) if len(elevs) > 1 else np.zeros_like(theta, dtype=int)
    lo = hi - 1 if len(elevs) > 1 else hi
    e_lo, e_hi = elevs[lo], elevs[hi]
    v_lo = np.take_along_axis(samples, lo[None], 0)[0]
    v_hi = np.take_along_axis(samples, hi[None], 0)[0]
    d_lo, d_hi = np.abs(theta - e_lo), np.abs(theta - e_hi)
    near_v = np.where(d_lo <= d_hi, v_lo, v_hi)
    near_d = np.minimum(d_lo, d_hi)
    inside = near_d <= HALF_BEAM
    gap = e_hi - e_lo
    between = (theta > e_lo) & (theta < e_hi) & (gap <= MAX_BLEND_GAP)
    out = np.where(inside, near_v, np.nan)
    if kind in _BLEND:
        w = np.clip((theta - e_lo) / np.where(gap > 0, gap, 1.0), 0.0, 1.0)
        blend = np.where(np.isfinite(v_lo) & np.isfinite(v_hi), v_lo * (1 - w) + v_hi * w,
                         np.where(np.isfinite(v_lo), v_lo, v_hi))
        out = np.where(between & ~inside, blend, out)
    else:
        out = np.where(between & ~inside, near_v, out)
    # Under the ground, and under the lowest beam, nothing is seen.
    out[z[:, 0] < st["groundKm"] - 0.05, :] = np.nan

    pid = _KIND_DEFAULT_PALETTE.get(kind, "REF")
    _, vmin, vmax = get_cmap(pid)
    tq = (out - vmin) / ((vmax - vmin) or 1.0)
    codes = np.clip(np.rint(tq * 254.0) + 1.0, 1, 255)
    codes[~np.isfinite(out)] = 0
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)

    meta = {
        "site": site_label, "siteLat": st["lat"], "siteLon": st["lon"],
        "radarHeightKm": round(h0, 3), "groundKm": round(st["groundKm"], 3),
        "product": f"L2{fam}", "productLabel": label, "units": units, "kind": kind,
        "family": fam, "defaultPalette": pid, "vmin": vmin, "vmax": vmax,
        "rows": rows, "cols": cols, "topKm": top_km, "lengthKm": round(length, 3),
        "a": [a[0], a[1]], "b": [b[0], b[1]],
        # Distance from the radar under each column, for the beams' heights.
        "rangeKm": [round(float(v), 2) for v in s],
        "elevations": [round(float(e), 2) for e in elevs],
        "key": key, "scanUnix": scan_unix, "vcp": st["vcp"],
        # What SRV took out (speed kt, toward deg) and how velocity was unfolded.
        "motion": [round(float(motion[0]), 1), round(float(motion[1]), 1)] if fam == "S" and motion else None,
        "dealias": st.get("dealias", "off") if fam in ("G", "S") else None,
        "lut": [None if not np.isfinite(v) else round(float(v), 4) for v in lut],
        "ms": round((time.time() - t0) * 1000),
    }
    return {"meta": meta, "codes": codes.astype(np.uint8)}
