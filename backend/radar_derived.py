"""
Products computed from a Level II volume, served as Level II product codes
through /api/nexrad/data: nexrad_level2.polar_data_l2 hands every code this
module `handles` to `polar`, and the answer is the same polar wire format.

Volume products (no tilt), from every reflectivity cut:
  L2CREF  composite reflectivity: the strongest echo of any cut over each point
  L2ET    echo top: the highest beam CENTRE with >= 18 dBZ, kft above sea level
          (no interpolation between cuts -- what the radar saw, not a guess)
  L2VIL   vertically integrated liquid (Greene & Clark 1972), kg/m^2, from the
          layers between successive cuts, reflectivity capped at 56 dBZ so hail
          does not count as water
  L2DVIL  VIL density (Amburn & Wolf 1997): VIL over the echo's depth, g/m^3;
          3.5 and up is the classic severe-hail signal

Tilted products, at every cut that carries what they are made of:
  L2G<slot>     velocity, unfolded (dealiased)
  L2S<slot>     storm-relative velocity, from unfolded velocity
  L2VROT<slot>  rotational velocity: half the velocity difference across a
                ~5 km window (2.5 km either side along the arc), kt
  L2PTDS<slot>  tornado debris score, 0-100, on every dual-pol cut (see
                `ptds_score`)

Options ride on the code as suffixes, so every cache -- this one, the
browser's, the client's frame cache -- tells them apart:
  _D<alg>  unfolding: R region-based (radar_detect.dealias, the default),
           V VAD-seeded (`vad_unfold`), 0 off. Velocity, SRV, VROT and PTDS.
  _M<how>  storm motion for SRV: A auto (echo tracking between this volume and
           the one before, else the NWS cells' mean), S the NWS cells' mean
           motion (STI), <from deg>-<kt> manual (M240-30: from 240 at 30 kt).
`L2G<slot>_D0` is the raw velocity and goes the plain Level II way.

Range-folded gates keep their own code (meta.rfCode, 255) on velocity and SRV,
unfolded or not, so the client can draw them purple.
"""
from __future__ import annotations

import math
import re
import threading
import time
import warnings
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np
from scipy import ndimage

import nexrad_level2 as l2
import radar_detect as rd
import radar_xsect as xs
from nexrad_core import TILT_SLOTS, _KIND_DEFAULT_PALETTE, get_cmap, icao_for, site_id

KT_PER_MS = 1.943844
KFT_PER_KM = 3.28084

# Echo top threshold, and the VIL reflectivity cap (Greene & Clark's hail cap).
ET_DBZ = 18.0
VIL_CAP_DBZ = 56.0
# DVIL only where there is a column worth dividing.
DVIL_MIN_VIL = 1.0
# Under this VIL is stratiform drizzle: a grey wash over every rain shield.
VIL_MIN = 1.0
DVIL_MIN_DEPTH_KM = 1.5

# Rotational velocity: half the velocity spread across this half-width of arc
# either side of a gate, over +-VROT_HALF_GATES along the beam.
VROT_HALF_KM = 2.5
VROT_MAX_HALF_RADIALS = 30
VROT_HALF_GATES = 2
VROT_MIN_RANGE_KM = 5.0

# A gate unfolded past this is a fold gone wrong, not a wind: it goes back to
# the fold that fits its neighbours. (Higher than radar_detect's 55 m/s: a
# hurricane's eyewall at 1-2 km is 60-75 m/s.)
MAX_UNFOLDED_MS = 85.0

ALGORITHMS = {"R": "region", "V": "vad", "0": "off"}
_ALG_CODE = {v: k for k, v in ALGORITHMS.items()}
DEFAULT_ALG = "region"

VOLUME = ("CREF", "ET", "VIL", "DVIL")
TILTED = ("VROT", "PTDS", "G", "S")
_CODE = re.compile(r"^L2(CREF|DVIL|VIL|ET|VROT|PTDS|G|S)([0-9A-Z]?)((?:_[0-9A-Z.\-]+)*)$")

# id, short, label, units, kind, the moment its tilts need (None: a volume product)
_FAMILIES: list[tuple[str, str, str, str, str, Optional[str]]] = [
    ("CREF", "CREF", "Composite Reflectivity", "dBZ", "ref", None),
    # Named apart from Level III's Enhanced Echo Tops / VIL rows above them.
    ("ET", "ET", "Echo Tops, every tilt (18 dBZ)", "kft", "tops", None),
    ("VIL", "VIL", "VIL, every tilt", "kg/m²", "vil", None),
    ("DVIL", "DVIL", "VIL Density", "g/m³", "dvil", None),
    ("VROT", "VROT", "Rotational Velocity", "kt", "vrot", "G"),
    ("PTDS", "PTDS", "Tornado Debris Score", "", "ptds", "C"),
    ("S", "SRV", "Storm Relative Velocity (every tilt)", "kt", "srv", "G"),
]
_LABELS = {name: (label, units, kind) for name, _s, label, units, kind, _n in _FAMILIES}
_LABELS["G"] = ("Super-Res Velocity", "kt", "vel")


# ---------------------------------------------------------------------------
# Codes
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Code:
    name: str
    slot: str
    dealias: str = DEFAULT_ALG
    motion: str = "auto"                              # auto | sti | manual
    manual: Optional[tuple[float, float]] = None      # (from deg, kt)

    @property
    def canonical(self) -> str:
        """One spelling per meaning: the cache key."""
        s = f"L2{self.name}{self.slot}"
        if self.name in TILTED:
            s += f"_D{_ALG_CODE[self.dealias]}"
        if self.name == "S":
            if self.motion == "manual" and self.manual:
                s += f"_M{self.manual[0]:g}-{self.manual[1]:g}"
            else:
                s += "_MS" if self.motion == "sti" else "_MA"
        return s


def parse(product: str) -> Optional[Code]:
    """A derived product code, or None when it is not one."""
    m = _CODE.match((product or "").upper())
    if not m:
        return None
    name, slot, opts = m.groups()
    if (name in VOLUME) == bool(slot):
        return None
    if slot and slot not in l2._ELEV:  # noqa: SLF001
        return None
    alg, motion, manual = DEFAULT_ALG, "auto", None
    for tok in (t for t in opts.split("_") if t):
        head, body = tok[0], tok[1:]
        if head == "D" and body in ALGORITHMS:
            alg = ALGORITHMS[body]
        elif head == "M" and body in ("A", "S"):
            motion = "auto" if body == "A" else "sti"
        elif head == "M":
            mm = re.fullmatch(r"(\d{1,3}(?:\.\d+)?)-(\d{1,3}(?:\.\d+)?)", body)
            if not mm:
                return None
            motion = "manual"
            manual = (round(float(mm.group(1)) % 360.0, 1), round(min(float(mm.group(2)), 150.0), 1))
        else:
            return None
    return Code(name, slot, alg, motion, manual)


def handles(product: str) -> bool:
    """Whether polar_data_l2 should hand this code here. Raw velocity
    (`_D0`) stays on the plain Level II path, which this module reads from."""
    c = parse(product)
    return c is not None and not (c.name == "G" and c.dealias == "off")


def with_options(product: str, dealias: str = "", motion: str = "") -> str:
    """Fold the request's `dealias` / `motion` query parameters into the code.
    dealias: region | vad | off; motion: auto | sti | <from deg>/<kt>."""
    product = (product or "").upper()
    c = parse(product)
    if c is None or c.name in VOLUME:
        return product
    alg = (dealias or "").strip().lower()
    if alg in _ALG_CODE:
        c = Code(c.name, c.slot, alg, c.motion, c.manual)
    mo = (motion or "").strip().lower()
    if mo in ("auto", "sti"):
        c = Code(c.name, c.slot, c.dealias, mo, None)
    elif mo:
        mm = re.fullmatch(r"(\d{1,3}(?:\.\d+)?)\s*[/,\-]\s*(\d{1,3}(?:\.\d+)?)", mo)
        if mm:
            c = Code(c.name, c.slot, c.dealias, "manual",
                     (round(float(mm.group(1)) % 360.0, 1), round(min(float(mm.group(2)), 150.0), 1)))
    return c.canonical


def catalog() -> list[dict]:
    """The derived families for the product picker (group "derived")."""
    out = []
    for name, short, label, units, kind, needs in _FAMILIES:
        if needs is None:
            tilts = [{"code": f"L2{name}", "tilt": None, "elev": None, "source": "level2"}]
        else:
            tilts = [{"code": f"L2{name}{slot}", "tilt": slot, "elev": nominal, "source": "level2",
                      "superRes": slot in l2.SUPER_RES_SLOTS} for slot, nominal in TILT_SLOTS]
        out.append({"id": f"L2{name}", "short": short, "label": label, "units": units, "kind": kind,
                    "source": "level2", "group": "derived", "derived": True, "needs": needs,
                    "codeBase": name, "tilts": tilts})
    return out


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def pack(vals: np.ndarray, kind: str, rf: Optional[np.ndarray] = None) -> tuple[np.ndarray, np.ndarray, Optional[int], str, float, float]:
    """Values -> the 256-code wire format of nexrad_level2._extract (0 = no
    data; 255 = range folded when `rf` has any)."""
    pid = _KIND_DEFAULT_PALETTE.get(kind, "REF")
    _, vmin, vmax = get_cmap(pid)
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)
    with np.errstate(invalid="ignore"):
        t = (vals - vmin) / ((vmax - vmin) or 1.0)
        codes = np.clip(np.rint(t * 254.0) + 1.0, 1, 255)
    codes[~np.isfinite(vals)] = 0
    rf_code = None
    if rf is not None and rf.any():
        codes[codes == 255] = 254
        codes[rf] = 255
        lut[255] = np.nan
        rf_code = 255
    return codes.astype(np.uint8), lut, rf_code, pid, float(vmin), float(vmax)


def values(grid: dict) -> tuple[np.ndarray, Optional[np.ndarray]]:
    """A wire grid back to values (float32, NaN = none) and its range-folded mask."""
    vals = grid["lut"][grid["codes"]].astype(np.float32)
    rfc = grid["meta"].get("rfCode")
    rf = (grid["codes"] == rfc) if rfc is not None else None
    return vals, rf


def geometry(grid: dict) -> tuple[np.ndarray, np.ndarray]:
    """Radial azimuths (deg) and gate-centre ranges (km) of a wire grid."""
    m = grid["meta"]
    az = np.asarray(grid["az"][:-1], dtype=np.float64) % 360.0
    r = float(m["rangeStartKm"]) + np.arange(int(m["nGates"]), dtype=np.float64) * float(m["gateWidthKm"])
    return az, r


def empty(grid: dict) -> bool:
    """A 'not scanned' frame (nexrad_level2._not_scanned): one gate, no data."""
    return int(grid["meta"].get("nGates", 0)) <= 1 or not grid["codes"].any()


def nearest_radials(az_src: np.ndarray, az_dst: np.ndarray, max_deg: float = 2.0) -> tuple[np.ndarray, np.ndarray]:
    """For each destination azimuth, the nearest source radial (az_src sorted
    ascending in [0, 360)), and whether it is within `max_deg`."""
    n = az_src.size
    i = np.searchsorted(az_src, az_dst)
    i0, i1 = (i - 1) % n, i % n
    d0 = np.abs((az_dst - az_src[i0] + 180.0) % 360.0 - 180.0)
    d1 = np.abs((az_dst - az_src[i1] + 180.0) % 360.0 - 180.0)
    pick = np.where(d0 <= d1, i0, i1)
    return pick, np.minimum(d0, d1) <= max_deg


def regrid(vals: np.ndarray, az_src: np.ndarray, r_src: np.ndarray, az_dst: np.ndarray,
           r_dst: np.ndarray) -> np.ndarray:
    """Nearest-gate copy of one sweep's field onto another sweep's geometry
    (the two halves of a split cut, say)."""
    ii, ok_i = nearest_radials(az_src, az_dst)
    w = float(r_src[1] - r_src[0]) if r_src.size > 1 else 0.25
    jj = np.rint((r_dst - r_src[0]) / w).astype(np.int64)
    ok_j = (jj >= 0) & (jj < vals.shape[1])
    out = vals[ii][:, np.clip(jj, 0, vals.shape[1] - 1)].astype(np.float32)
    out[~ok_i] = np.nan
    out[:, ~ok_j] = np.nan
    return out


def _wrap(v: np.ndarray, nyq: float) -> np.ndarray:
    return (v + nyq) % (2.0 * nyq) - nyq


def _local_mean(v: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Mean of the finite gates around each gate (azimuth wraps, range does not)."""
    ok = np.isfinite(v)
    num = ndimage.uniform_filter(np.where(ok, v, 0.0).astype(np.float32), size=size, mode=("wrap", "nearest"))
    den = ndimage.uniform_filter(ok.astype(np.float32), size=size, mode=("wrap", "nearest"))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[den < 0.08] = np.nan
    return out


# ---------------------------------------------------------------------------
# Unfolding
# ---------------------------------------------------------------------------
def unfold(v_ms: np.ndarray, nyq_ms: Optional[float], r_km: np.ndarray, az: np.ndarray, elev: float,
           alg: str = DEFAULT_ALG, dbz: Optional[np.ndarray] = None) -> np.ndarray:
    """One sweep's radial velocity (m/s, NaN = none) unfolded by `alg`.

    Every observed gate comes back with a value: gates the algorithm leaves
    out (radar_detect's region method drops speckle) or unfolds past
    MAX_UNFOLDED_MS go back as observed, on the fold that fits their
    neighbours -- unfolding moves values by whole Nyquist intervals, it does
    not erase data."""
    v = np.asarray(v_ms, dtype=np.float32)
    if alg == "off" or not nyq_ms or nyq_ms <= 0 or np.isfinite(v).sum() < 10:
        return v.copy()
    nyq = float(nyq_ms)
    if alg == "vad":
        out = vad_unfold(v, nyq, r_km, az, elev)
    else:
        out = rd.dealias(v, nyq, r_km=r_km.astype(np.float64), az=az.astype(np.float64), dbz=dbz)
    out = np.asarray(out, dtype=np.float32)
    with np.errstate(invalid="ignore"):
        out[np.abs(out) > max(MAX_UNFOLDED_MS, 2.0 * nyq)] = np.nan
    return restore(out, v, nyq)


def restore(out: np.ndarray, raw: np.ndarray, nyq: float) -> np.ndarray:
    """Put back observed gates the unfolding left empty, each on the fold
    nearest the mean of its unfolded neighbours (as observed where it has none)."""
    miss = ~np.isfinite(out) & np.isfinite(raw)
    if not miss.any():
        return out
    loc = _local_mean(out, (9, 11))
    two = 2.0 * nyq
    base = _wrap(raw, nyq)
    with np.errstate(invalid="ignore"):
        k = np.where(np.isfinite(loc), np.rint((loc - base) / two), 0.0)
    out = out.copy()
    out[miss] = (base + two * k)[miss]
    return out


# VAD-seeded continuity unfolding. Per 5 km ring, the horizontal wind that
# best explains the FOLDED velocities -- a fit on the unit circle, where a fold
# is no change at all (exp(i pi v / Vn) is the same either side of one). That
# wind only SEEDS each radial: the unfolding then marches outward gate by gate,
# every gate taking the fold nearest the running value of its own radial and
# the radials beside it -- the wind may change along the way (a hurricane's
# vortex is not one uniform wind across a ring, which a VAD assumes). A
# radial with no echo yet starts from the VAD wind at that range (else calm).
# A median continuity pass then settles single gates that took a wrong fold.
VAD_RING_KM = 5.0
VAD_MAX_KM = 230.0
VAD_MAX_WIND = 80.0          # m/s searched either way
VAD_COARSE = 4.0             # m/s grid step, then refined at 0.5
VAD_MIN_COVER = 0.3          # of the azimuths
VAD_MIN_OCTANTS = 5
VAD_MIN_COHERENCE = 0.45     # mean cos of the residual phase
TIDY_SIZE = (9, 15)          # radials x gates
TIDY_SHARE = 1.2             # of a Nyquist off the local median: a wrong fold
TIDY_PASSES = 2


def vad_rings(v: np.ndarray, nyq: float, r_km: np.ndarray, az: np.ndarray,
              elev: float) -> list[tuple[float, float, float, float]]:
    """(ring centre km, u, v, coherence) for every ring seen well enough."""
    ok = np.isfinite(v)
    ce = math.cos(math.radians(elev))
    if ce < 0.2:
        return []
    ph = np.where(ok, np.pi * _wrap(np.where(ok, v, 0.0), nyq) / nyq, 0.0)
    cr, ci = np.where(ok, np.cos(ph), 0.0), np.where(ok, np.sin(ph), 0.0)
    nbin = 180
    b = (np.floor((az % 360.0) / (360.0 / nbin))).astype(np.int64) % nbin
    bc = np.radians((np.arange(nbin) + 0.5) * (360.0 / nbin))
    sb, cb = np.sin(bc), np.cos(bc)
    coarse = np.arange(-VAD_MAX_WIND, VAD_MAX_WIND + 0.1, VAD_COARSE)
    cu, cv = [a.ravel() for a in np.meshgrid(coarse, coarse)]
    fine = np.arange(-VAD_COARSE, VAD_COARSE + 0.01, 0.5)
    fu0, fv0 = [a.ravel() for a in np.meshgrid(fine, fine)]
    k = np.pi * ce / nyq
    rings = []
    for lo in np.arange(max(2.0, float(r_km[0])), min(VAD_MAX_KM, float(r_km[-1])), VAD_RING_KM):
        cols = np.nonzero((r_km >= lo) & (r_km < lo + VAD_RING_KM))[0]
        if cols.size == 0:
            continue
        c0, c1 = cols[0], cols[-1] + 1
        cnt_r = ok[:, c0:c1].sum(axis=1)
        if (cnt_r > 0).sum() < VAD_MIN_COVER * az.size:
            continue
        zr = np.bincount(b, weights=cr[:, c0:c1].sum(axis=1), minlength=nbin)
        zi = np.bincount(b, weights=ci[:, c0:c1].sum(axis=1), minlength=nbin)
        cnt = np.bincount(b, weights=cnt_r, minlength=nbin)
        have = cnt > 0
        if np.unique((np.nonzero(have)[0] * 8) // nbin).size < VAD_MIN_OCTANTS:
            continue
        zr, zi, s_, c_ = zr[have], zi[have], sb[have], cb[have]

        def score(u: np.ndarray, w: np.ndarray) -> np.ndarray:
            phi = k * (u[:, None] * s_[None, :] + w[:, None] * c_[None, :])
            return (np.cos(phi) * zr[None, :] + np.sin(phi) * zi[None, :]).sum(axis=1)

        sc = score(cu, cv)
        j = int(np.argmax(sc))
        fu, fv = cu[j] + fu0, cv[j] + fv0
        sf = score(fu, fv)
        jf = int(np.argmax(sf))
        coh = float(sf[jf] / cnt.sum())
        if coh >= VAD_MIN_COHERENCE:
            rings.append((lo + VAD_RING_KM / 2.0, float(fu[jf]), float(fv[jf]), coh))
    if len(rings) >= 3:
        # A ring off its neighbours by more than 10 m/s is noise, not a jet.
        arr = np.array(rings)
        med_u = ndimage.median_filter(arr[:, 1], size=3, mode="nearest")
        med_v = ndimage.median_filter(arr[:, 2], size=3, mode="nearest")
        keep = np.hypot(arr[:, 1] - med_u, arr[:, 2] - med_v) <= 10.0
        rings = [r for r, k_ in zip(rings, keep) if k_]
    return rings


CONT_KEEP = 0.6              # running value: this much of the new gate
CONT_NEIGHBOURS = 2          # radials either side that vote


def vad_reference(v: np.ndarray, nyq: float, r_km: np.ndarray, az: np.ndarray, elev: float) -> Optional[np.ndarray]:
    """The VAD wind's radial velocity at every gate (NaN beyond the fitted
    rings), or None when no ring was seen well enough."""
    rings = vad_rings(v, nyq, r_km, az, elev)
    if not rings:
        return None
    rc = np.array([r[0] for r in rings])
    uu = np.interp(r_km, rc, [r[1] for r in rings])
    vv = np.interp(r_km, rc, [r[2] for r in rings])
    far = (r_km < rc[0] - 2 * VAD_RING_KM) | (r_km > rc[-1] + 4 * VAD_RING_KM)
    uu[far], vv[far] = np.nan, np.nan
    ce = math.cos(math.radians(elev))
    a = np.radians(az)
    return (ce * (np.sin(a)[:, None] * uu[None, :] + np.cos(a)[:, None] * vv[None, :])).astype(np.float32)


def vad_unfold(v: np.ndarray, nyq: float, r_km: np.ndarray, az: np.ndarray, elev: float) -> np.ndarray:
    ok = np.isfinite(v)
    two = np.float32(2.0 * nyq)
    vw = np.where(ok, _wrap(np.where(ok, v, 0.0), nyq), np.nan).astype(np.float32)
    seed = vad_reference(v, nyq, r_km, az, elev)
    nrad, ngate = vw.shape
    out = np.full(vw.shape, np.nan, dtype=np.float32)
    last = np.full(nrad, np.nan, dtype=np.float32)     # running unfolded value per radial
    shifts = [k for k in range(-CONT_NEIGHBOURS, CONT_NEIGHBOURS + 1) if k]
    for j in range(ngate):
        col = vw[:, j]
        have = np.isfinite(col)
        if not have.any():
            continue
        own = np.isfinite(last)
        # The radials beside: their running values, averaged where they have one.
        nb_sum = np.zeros(nrad, dtype=np.float32)
        nb_n = np.zeros(nrad, dtype=np.float32)
        for k in shifts:
            o = np.roll(last, k)
            f = np.isfinite(o)
            nb_sum += np.where(f, o, 0.0)
            nb_n += f
        with np.errstate(invalid="ignore", divide="ignore"):
            nb = np.where(nb_n > 0, nb_sum / nb_n, np.nan)
        # A radial a fold off the radials beside it has been derailed (one bad
        # gate carried forward): it takes their value back.
        with np.errstate(invalid="ignore"):
            astray = own & np.isfinite(nb) & (np.abs(last - nb) > 0.8 * nyq)
        ref = np.where(own & np.isfinite(nb), 0.65 * last + 0.35 * nb, np.where(own, last, nb))
        ref = np.where(astray, nb, ref)
        if seed is not None:
            ref = np.where(np.isfinite(ref), ref, seed[:, j])
        ref = np.where(np.isfinite(ref), ref, 0.0).astype(np.float32)
        u = col + two * np.rint((ref - col) / two)
        out[have, j] = u[have]
        upd = np.where(own, CONT_KEEP * u + (1.0 - CONT_KEEP) * last, u)
        last = np.where(have, upd, last).astype(np.float32)
    return tidy(out, nyq)


def local_median(v: np.ndarray, size: tuple[int, int] = (3, 5), min_n: int = 4) -> np.ndarray:
    """The median of the finite gates in a (radials x gates) window around
    each gate; NaN under `min_n` of them. Azimuth wraps."""
    ha, hg = size[0] // 2, size[1] // 2
    layers = []
    for da in range(-ha, ha + 1):
        va = np.roll(v, da, axis=0) if da else v
        for dg in range(-hg, hg + 1):
            if dg == 0:
                layers.append(va)
                continue
            s = np.full_like(va, np.nan)
            if dg > 0:
                s[:, :-dg] = va[:, dg:]
            else:
                s[:, -dg:] = va[:, :dg]
            layers.append(s)
    st = np.stack(layers)
    fin = np.isfinite(st)
    n = fin.sum(axis=0)
    st = np.sort(np.where(fin, st, np.inf), axis=0)
    lo = np.take_along_axis(st, np.maximum((n - 1) // 2, 0)[None], axis=0)[0]
    hi = np.take_along_axis(st, (n // 2)[None].clip(max=st.shape[0] - 1), axis=0)[0]
    with np.errstate(invalid="ignore"):
        med = 0.5 * (lo + hi)
    med[n < min_n] = np.nan
    return med.astype(np.float32)


def tidy(out: np.ndarray, nyq: float, passes: int = TIDY_PASSES) -> np.ndarray:
    """Continuity: a gate more than TIDY_SHARE Nyquist intervals off the
    MEDIAN of its close neighbours took a wrong fold (a median, so the far
    side of a couplet does not drag the reference across), then whole patches
    off the wider mean by more than 1.5 intervals; each moves by whole folds."""
    two = 2.0 * nyq
    out = out.copy()
    for p in range(passes + 1):
        wide = p == 1
        # (the last pass looks across 7 radials: a streak along one radial)
        loc = _local_mean(out, TIDY_SIZE) if wide else local_median(out, (7, 3) if p == passes else (3, 5))
        with np.errstate(invalid="ignore"):
            d = loc - out
            bad = np.isfinite(d) & (np.abs(d) > (1.5 if wide else TIDY_SHARE) * nyq)
        if bad.any():
            out[bad] += (two * np.rint(d[bad] / two)).astype(np.float32)
    return out


# ---------------------------------------------------------------------------
# Volume products: CREF, ET, VIL, DVIL
# ---------------------------------------------------------------------------
def slant_and_height(s_km: np.ndarray, elev_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Slant range and beam-centre height above the antenna of the beam at
    `elev_deg` over ground distance s (4/3-earth)."""
    re_ = rd.RE_EFF_KM
    th = math.radians(elev_deg)
    phi = s_km / re_
    c = np.cos(th + phi)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = re_ * np.sin(phi) / c
        h = re_ * math.cos(th) / c - re_
    bad = c <= 0.01
    r[bad], h[bad] = np.nan, np.nan
    return r, h


def column_products(sweeps: list[dict], az_out: np.ndarray, s_out: np.ndarray, antenna_msl_km: float,
                    antenna_agl_km: float = 0.0) -> dict[str, np.ndarray]:
    """CREF (dBZ), ET (kft MSL), VIL (kg/m^2), DVIL (g/m^3) on (az_out x
    s_out ground ranges) from reflectivity sweeps [{elev, az (sorted), first,
    width, vals}], low to high."""
    shape = (az_out.size, s_out.size)
    cref = np.full(shape, np.nan, dtype=np.float32)
    top_h = np.full(shape, np.nan, dtype=np.float32)      # km above the antenna
    vil = np.zeros(shape, dtype=np.float32)
    # Whether the volume's highest cut still has echo over a point: the top is
    # above the volume (near the radar), so ET is a floor and DVIL is not worth
    # dividing. (Far out only the low cuts reach at all; that is range, not this.)
    capped = np.zeros(shape, dtype=bool)
    prev_z: Optional[np.ndarray] = None
    prev_h: Optional[np.ndarray] = None
    ordered = sorted(sweeps, key=lambda s: s["elev"])
    for sw in ordered:
        vals = np.asarray(sw["vals"])
        r, h = slant_and_height(s_out, float(sw["elev"]))
        ii, ok_i = nearest_radials(np.asarray(sw["az"], dtype=np.float64) % 360.0, az_out)
        jj = np.rint((r - float(sw["first"])) / float(sw["width"]))
        ok_j = np.isfinite(jj) & (jj >= 0) & (jj < vals.shape[1])
        jj = np.where(ok_j, jj, 0).astype(np.int64)
        v = vals[ii][:, jj].astype(np.float32)
        v[~ok_i] = np.nan
        v[:, ~ok_j] = np.nan
        np.fmax(cref, v, out=cref)
        with np.errstate(invalid="ignore"):
            top = v >= ET_DBZ
        hb = np.broadcast_to(h.astype(np.float32)[None, :], shape)
        top_h[top] = hb[top]
        if sw is ordered[-1]:
            capped = top & ok_i[:, None] & ok_j[None, :]
        with np.errstate(invalid="ignore"):
            z = np.where(np.isfinite(v), np.power(10.0, np.minimum(v, VIL_CAP_DBZ) / 10.0), 0.0).astype(np.float32)
        if prev_z is not None:
            dh_m = np.maximum((h - prev_h) * 1000.0, 0.0)
            dh_m = np.where(np.isfinite(dh_m), dh_m, 0.0).astype(np.float32)
            vil += (3.44e-6 * np.power(0.5 * (prev_z + z), 4.0 / 7.0) * dh_m[None, :]).astype(np.float32)
        prev_z, prev_h = z, h
    with np.errstate(invalid="ignore", divide="ignore"):
        echo = cref >= ET_DBZ
        et = np.where(echo, (top_h + antenna_msl_km) * KFT_PER_KM, np.nan).astype(np.float32)
        vil_out = np.where(np.isfinite(cref) & (vil >= VIL_MIN), vil, np.nan).astype(np.float32)
        depth_km = top_h + antenna_agl_km
        dvil = np.where(echo & ~capped & (vil >= DVIL_MIN_VIL) & (depth_km >= DVIL_MIN_DEPTH_KM),
                        vil / (depth_km * 1000.0) * 1000.0, np.nan).astype(np.float32)
    return {"CREF": cref, "ET": et, "VIL": vil_out, "DVIL": dvil, "capped": capped & echo}


# ---------------------------------------------------------------------------
# VROT and PTDS
# ---------------------------------------------------------------------------
def vrot_field(v: np.ndarray, r_km: np.ndarray, d_az_deg: float) -> np.ndarray:
    """Half the spread of velocity (any unit; same unit back) across a ~5 km
    window centred on each gate: VROT_HALF_KM of arc either side, and
    VROT_HALF_GATES along the beam -- the gate pairs the eye takes for a
    couplet's Vrot. Leave speckle out first (NaN): one wild gate would make one."""
    vm = np.asarray(v, dtype=np.float32)
    ok = np.isfinite(vm)
    hi = np.where(ok, vm, -np.inf).astype(np.float32)
    lo = np.where(ok, vm, np.inf).astype(np.float32)
    g = 2 * VROT_HALF_GATES + 1
    hi = ndimage.maximum_filter1d(hi, g, axis=1, mode="nearest")
    lo = ndimage.minimum_filter1d(lo, g, axis=1, mode="nearest")
    arc = np.radians(max(d_az_deg, 0.1)) * np.maximum(r_km, 0.1)
    half = np.clip(np.rint(VROT_HALF_KM / arc), 1, VROT_MAX_HALF_RADIALS).astype(np.int64)
    for k in np.unique(half):
        cols = np.nonzero(half == k)[0]
        a, b = cols[0], cols[-1] + 1     # `half` falls with range: each k is one run
        hi[:, a:b] = ndimage.maximum_filter1d(hi[:, a:b], 2 * int(k) + 1, axis=0, mode="wrap")
        lo[:, a:b] = ndimage.minimum_filter1d(lo[:, a:b], 2 * int(k) + 1, axis=0, mode="wrap")
    with np.errstate(invalid="ignore"):
        out = 0.5 * (hi - lo)
    out[~ok | ~np.isfinite(out)] = np.nan
    out[:, r_km < VROT_MIN_RANGE_KM] = np.nan
    return out.astype(np.float32)


def nrot_field(v_ms: np.ndarray, r_km: np.ndarray, d_az_deg: float, hemi: int = 1) -> np.ndarray:
    """Normalized rotation (radar_detect's: azimuthal shear over the
    range-dependent divisor), cyclonic positive."""
    half_az = 2 if d_az_deg <= 0.75 else 1
    dr = float(r_km[1] - r_km[0]) if r_km.size > 1 else 0.25
    half_gate = min(max(1, int(round(0.5 / max(dr, 0.05)))), 4)
    sh = rd.azimuthal_shear(v_ms, d_az_deg, r_km, half_az, half_gate) * hemi
    nr = sh / rd.nrot_scale(r_km)[None, :]
    nr[:, r_km < rd.MIN_RANGE_KM] = np.nan
    return nr.astype(np.float32)


def _ramp(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


# PTDS weights (sum 100) and ramps -- set from the debris-signature studies:
#  * Ryzhkov et al. 2005 (JAM 44): debris = reflectivity > ~45 dBZ with
#    correlation < ~0.8 and ZDR near 0 at a velocity couplet.
#  * Bodine et al. 2013 (MWR 141): TDS correlation spans ~0.2-0.82 and grows
#    more distinct (lower CC, higher Z) with tornado strength.
#  * Van Den Broeke & Jauernic 2014 (JAMC 53): TDS medians of ZDR ~0-0.6 dB
#    (and negative in the strongest), Z mostly 45-55 dBZ, CC ~0.6-0.8, with
#    the widest spectrum width beside the vortex.
# Correlation carries the most, as the signature itself; reflectivity says
# there is enough lofted mass; ZDR separates debris from rain (and big drops)
# but not from hail, which rotation and spectrum width then must.
PTDS_W_REF, PTDS_W_CC, PTDS_W_ZDR, PTDS_W_ROT, PTDS_W_SW = 25.0, 35.0, 15.0, 15.0, 10.0
PTDS_MIN_DBZ = 25.0
PTDS_MAX_CC = 0.92
PTDS_SIGNIFICANT = 90.0
PTDS_DETECTION = 95.0
# Lofted debris fills a patch (a tornado's is ~0.5-2 km across); a ship, a
# wind turbine or a lone clutter gate is a gate or two. A gate whose window of
# PTDS_SUPPORT_WIN (radials x gates) holds few debris-like gates keeps only
# PTDS_SUPPORT_FLOOR of its score -- under the significant line on its own.
PTDS_SUPPORT_WIN = (5, 7)
PTDS_SUPPORT_LO, PTDS_SUPPORT_HI = 0.10, 0.30
PTDS_SUPPORT_FLOOR = 0.85


def debris_support(dbz: np.ndarray, cc: np.ndarray) -> np.ndarray:
    """Share of each gate's window that looks like debris (>= 30 dBZ, CC < 0.85)."""
    with np.errstate(invalid="ignore"):
        like = ((dbz >= 30.0) & (cc < 0.85)).astype(np.float32)
    return ndimage.uniform_filter(like, size=PTDS_SUPPORT_WIN, mode=("wrap", "nearest"))


def support_factor(support: np.ndarray) -> np.ndarray:
    return PTDS_SUPPORT_FLOOR + (1.0 - PTDS_SUPPORT_FLOOR) * _ramp(support, PTDS_SUPPORT_LO, PTDS_SUPPORT_HI)


# Ground clutter (a downtown at 0.5 deg: high Z, low CC, zero velocity) is what
# the clutter filter took power out of; debris moves and keeps its power. Where
# the filter removed PTDS_CFP_LO..HI dB the score fades to PTDS_CFP_FLOOR. (No
# clutter-filter-power moment before ~2014: no fade.)
PTDS_CFP_LO, PTDS_CFP_HI, PTDS_CFP_FLOOR = 5.0, 20.0, 0.6
# Past ~150 km the beam is 2.5 km wide and partly-filled beams lower CC by
# themselves (non-uniform beam filling): the score fades to 85 % by 200 km.
PTDS_FAR_KM = (150.0, 200.0)
PTDS_FAR_FLOOR = 0.85


def clutter_factor(cfp_db: Optional[np.ndarray]) -> np.ndarray | float:
    if cfp_db is None:
        return 1.0
    f = 1.0 - (1.0 - PTDS_CFP_FLOOR) * _ramp(cfp_db, PTDS_CFP_LO, PTDS_CFP_HI)
    return np.where(np.isfinite(cfp_db), f, 1.0)


def range_factor(r_km: np.ndarray) -> np.ndarray:
    return 1.0 - (1.0 - PTDS_FAR_FLOOR) * _ramp(r_km, *PTDS_FAR_KM)


def ptds_score(dbz: np.ndarray, cc: np.ndarray, zdr: np.ndarray, nrot: Optional[np.ndarray],
               sw_ms: Optional[np.ndarray]) -> np.ndarray:
    """0-100 per gate; NaN under PTDS_MIN_DBZ, at CC >= PTDS_MAX_CC, or where
    reflectivity or correlation is missing. A missing rotation or width (no
    Doppler sweep reaches there, or it is range folded) scores 0 for its part."""
    with np.errstate(invalid="ignore"):
        t_ref = _ramp(dbz, PTDS_MIN_DBZ, 45.0) * (1.0 - 0.4 * _ramp(dbz, 63.0, 70.0))   # big hail cores fade
        t_cc = np.where(cc <= 0.80, 0.4 + 0.6 * _ramp(cc, 0.12, 0.30), 1.0 - _ramp(cc, 0.80, PTDS_MAX_CC))
        t_cc = np.where(cc < 0.12, 0.4 * _ramp(cc, 0.0, 0.12), t_cc)                     # noise-level CC
        t_zdr = np.where(zdr <= 1.0, _ramp(zdr, -4.0, -1.5), 1.0 - _ramp(zdr, 1.0, 3.0))
        t_zdr = np.where(np.isfinite(zdr), t_zdr, 0.0)
        t_rot = np.nan_to_num(_ramp(np.abs(nrot), 0.3, 1.5), nan=0.0) if nrot is not None else 0.0
        t_sw = np.nan_to_num(_ramp(sw_ms, 4.0, 10.0), nan=0.0) if sw_ms is not None else 0.0
        score = (PTDS_W_REF * t_ref + PTDS_W_CC * t_cc + PTDS_W_ZDR * t_zdr
                 + PTDS_W_ROT * t_rot + PTDS_W_SW * t_sw)
        dead = ~np.isfinite(dbz) | ~np.isfinite(cc) | (dbz < PTDS_MIN_DBZ) | (cc >= PTDS_MAX_CC)
    score = np.asarray(score, dtype=np.float32)
    score[dead] = np.nan
    return score


# ---------------------------------------------------------------------------
# Storm motion
# ---------------------------------------------------------------------------
TRACK_CELL_KM = 2.0
TRACK_HALF_KM = 160.0
TRACK_MIN_KM = 20.0           # ground clutter does not move
TRACK_DBZ = 20.0
TRACK_MAX_MS = 40.0
TRACK_MIN_CELLS = 250
TRACK_MIN_CORR = 0.35
_MOTION: "OrderedDict[tuple, dict]" = OrderedDict()


def cartesian(dbz: np.ndarray, az: np.ndarray, r_km: np.ndarray, cell_km: float = TRACK_CELL_KM,
              half_km: float = TRACK_HALF_KM) -> np.ndarray:
    """The field on a square grid around the radar (row = north, col = east),
    each cell the mean of the gates along its radial across the cell."""
    step = max(1, int(round(cell_km / max(float(r_km[1] - r_km[0]), 0.05))))
    n = (dbz.shape[1] // step) * step
    blk = dbz[:, :n].reshape(dbz.shape[0], -1, step)
    with np.errstate(invalid="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # all-NaN cells
        coarse = np.nanmean(blk, axis=2)
    rc = r_km[:n].reshape(-1, step).mean(axis=1)
    m = int(round(2 * half_km / cell_km))
    x = -half_km + (np.arange(m) + 0.5) * cell_km
    xx, yy = np.meshgrid(x, x)
    rr = np.hypot(xx, yy)
    aa = np.degrees(np.arctan2(xx, yy)) % 360.0
    ii, ok_i = nearest_radials(az, aa.ravel())
    jj = np.rint((rr.ravel() - rc[0]) / (rc[1] - rc[0] if rc.size > 1 else cell_km)).astype(np.int64)
    ok = ok_i & (jj >= 0) & (jj < coarse.shape[1])
    out = np.full(rr.size, np.nan, dtype=np.float32)
    out[ok] = coarse[ii[ok], jj[ok]]
    out = out.reshape(rr.shape)
    out[rr < TRACK_MIN_KM] = np.nan
    return out


def track(a: np.ndarray, b: np.ndarray, dt_s: float, cell_km: float = TRACK_CELL_KM) -> Optional[dict]:
    """Echo motion from field `a` to field `b` (same grid, dt_s later): the
    cross-correlation peak of the echo above TRACK_DBZ, refined to a fraction
    of a cell. None when there is too little echo or no clear peak."""
    fa = np.clip(np.nan_to_num(a, nan=0.0) - TRACK_DBZ, 0.0, 40.0)
    fb = np.clip(np.nan_to_num(b, nan=0.0) - TRACK_DBZ, 0.0, 40.0)
    if (fa > 0).sum() < TRACK_MIN_CELLS or (fb > 0).sum() < TRACK_MIN_CELLS or dt_s <= 0:
        return None
    m = fa.shape[0]
    pad = 2 * m
    A = np.fft.rfft2(fa - fa.mean(), s=(pad, pad))
    B = np.fft.rfft2(fb - fb.mean(), s=(pad, pad))
    cc = np.fft.irfft2(B * np.conj(A), s=(pad, pad))
    lim = int(math.ceil(TRACK_MAX_MS * dt_s / 1000.0 / cell_km)) + 1
    lim = min(lim, m // 2)
    win = np.concatenate([np.arange(0, lim + 1), np.arange(-lim, 0)])
    sub = cc[np.ix_(win % pad, win % pad)]
    k = np.unravel_index(int(np.argmax(sub)), sub.shape)
    dy, dx = int(win[k[0]]), int(win[k[1]])
    norm = math.sqrt(float(((fa - fa.mean()) ** 2).sum()) * float(((fb - fb.mean()) ** 2).sum())) or 1.0
    corr = float(sub[k]) / norm
    if corr < TRACK_MIN_CORR or abs(dy) >= lim or abs(dx) >= lim:
        return None

    def vertex(c0: float, c1: float, c2: float) -> float:
        d = c0 - 2 * c1 + c2
        return 0.0 if d >= 0 else 0.5 * (c0 - c2) / d

    fy = vertex(cc[(dy - 1) % pad, dx % pad], cc[dy % pad, dx % pad], cc[(dy + 1) % pad, dx % pad])
    fx = vertex(cc[dy % pad, (dx - 1) % pad], cc[dy % pad, dx % pad], cc[dy % pad, (dx + 1) % pad])
    u = (dx + fx) * cell_km * 1000.0 / dt_s
    v = (dy + fy) * cell_km * 1000.0 / dt_s
    return {"u": u, "v": v, "corr": corr}


def previous_key(site: str, key: str) -> Optional[str]:
    """The volume before `key`, when it is 3-15 minutes older."""
    import radar_volume3d as rv  # noqa: PLC0415

    unix = rv._key_unix(key)  # noqa: SLF001
    if unix is None:
        return None
    if key.startswith("L2:"):
        vols = l2.list_volumes(site, 30)
        keys = [v["key"] for v in vols]
        if key in keys:
            i = keys.index(key)
            if i > 0 and 120 <= unix - vols[i - 1]["time"] <= 900:
                return vols[i - 1]["key"]
    arch = l2.archive_volumes(site, 8, int(unix) - 1200)
    before = [v for v in arch if v["time"] < unix - 60]
    if before and unix - before[-1]["time"] <= 900:
        return before[-1]["key"]
    return None


def echo_motion(site: str, key: str) -> Optional[dict]:
    """Storm motion from the lowest reflectivity cut of this volume and the
    one before: {speedKt, towardDeg, corr, prevKey}."""
    prev = previous_key(site, key)
    if not prev:
        return None
    cur = l2.polar_data_l2(site, "L2B0", key)
    old = l2.polar_data_l2(site, "L2B0", prev)
    if empty(cur) or empty(old):
        return None
    t1 = float(cur["meta"].get("sweepUnix") or cur["meta"]["scanUnix"])
    t0 = float(old["meta"].get("sweepUnix") or old["meta"]["scanUnix"])
    fields = []
    for g in (old, cur):
        vals, _ = values(g)
        az, r = geometry(g)
        fields.append(cartesian(vals, az, r))
    got = track(fields[0], fields[1], t1 - t0)
    if got is None:
        return None
    speed = math.hypot(got["u"], got["v"]) * KT_PER_MS
    toward = math.degrees(math.atan2(got["u"], got["v"])) % 360.0
    return {"speedKt": round(speed, 1), "towardDeg": round(toward, 1), "corr": round(got["corr"], 3),
            "prevKey": prev}


def storm_motion(site: str, key: str, c: Code, scan_unix: Optional[float]) -> dict:
    """{speedKt, towardDeg, source: track|sti|manual|none, ...} for SRV."""
    if c.motion == "manual" and c.manual:
        frm, kt = c.manual
        return {"speedKt": kt, "towardDeg": (frm + 180.0) % 360.0, "source": "manual"}
    ck = (site, key, c.motion)
    hit = _MOTION.get(ck)
    if hit is not None:
        return hit
    out: Optional[dict] = None
    if c.motion == "auto":
        try:
            got = echo_motion(site, key)
        except Exception:  # noqa: BLE001 - no previous volume, or no echo: the NWS cells
            got = None
        if got is not None:
            out = {**got, "source": "track"}
    if out is None:
        import radar_volume3d as rv  # noqa: PLC0415

        live = scan_unix is None or scan_unix >= time.time() - 1800
        spd, toward = rv.motion_at(site_id(site), None if live else scan_unix)
        out = {"speedKt": spd, "towardDeg": toward, "source": "sti" if spd > 0 else "none"}
    _MOTION[ck] = out
    while len(_MOTION) > 64:
        _MOTION.popitem(last=False)
    return out


def motion_for(site: str, key: str, how: str, scan_unix: Optional[float]) -> dict:
    """storm_motion for the 3D view and the cross-section, `how` being the
    map's storm-motion setting as their requests carry it (auto | sti |
    <from deg>/<kt>): their SRV takes out what the map's derived SRV does."""
    c = parse(with_options("L2S0", "", how or "auto")) or Code("S", "0")
    return storm_motion(site_id(site), key, c, scan_unix)


# ---------------------------------------------------------------------------
# Serving
# ---------------------------------------------------------------------------
_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_MAX = 160
_LOCK = threading.Lock()
_GATES: dict[tuple, threading.Lock] = {}


def _resolve(site: str, key: str) -> tuple[str, Any]:
    """A concrete volume key (newest whole one when none) and its volume id."""
    if not key:
        # As polar_data_l2 does: the newest volume with its end chunk (a
        # one-volume listing, not radar_xsect's thirty).
        recent = l2.list_volumes(site, 1)
        if not recent:
            raise RuntimeError(f"No complete Level II volume for {icao_for(site)}.")
        return recent[-1]["key"], recent[-1]["vol"]
    return xs._volume_for(site, None, key)  # noqa: SLF001


def _base(site: str, fam: str, slot: str, key: str) -> dict:
    """A plain Level II grid at a slot (velocity raw)."""
    return l2.polar_data_l2(site, f"L2{fam}{slot}" + ("_D0" if fam == "G" else ""), key)


def _empty_like(grid: dict, code: Code, product: str) -> dict:
    label, units, kind = _LABELS[code.name]
    pid = _KIND_DEFAULT_PALETTE.get(kind, "REF")
    _, vmin, vmax = get_cmap(pid)
    meta = dict(grid["meta"])
    meta.update({"product": product, "productLabel": label, "units": units, "kind": kind,
                 "family": code.name, "defaultPalette": pid, "vmin": vmin, "vmax": vmax, "derived": True})
    meta.pop("rfCode", None)
    if not meta.get("note"):
        meta["note"] = "Nothing to build this from at this tilt in this volume"
    return {"az": grid["az"], "lut": np.full(256, np.nan, dtype=np.float32), "codes": np.zeros_like(grid["codes"]),
            "meta": meta}


def _out(grid: dict, vals: np.ndarray, code: Code, product: str, rf: Optional[np.ndarray] = None,
         **extra: Any) -> dict:
    label, units, kind = _LABELS[code.name]
    codes, lut, rf_code, pid, vmin, vmax = pack(vals, kind, rf)
    meta = dict(grid["meta"])
    meta.pop("rfCode", None)
    meta.update({"product": product, "productLabel": label, "units": units, "kind": kind,
                 "family": code.name, "defaultPalette": pid, "vmin": vmin, "vmax": vmax, "derived": True})
    if rf_code is not None:
        meta["rfCode"] = rf_code
    meta.update(extra)
    return {"az": grid["az"], "lut": lut, "codes": codes, "meta": meta}


def unfolded_velocity(site: str, slot: str, key: str, alg: str
                      ) -> tuple[dict, np.ndarray, Optional[np.ndarray], dict, Optional[np.ndarray]]:
    """(raw grid, velocity kt unfolded by `alg`, range-folded mask, info,
    speckle mask) at a slot. The speckle mask (radar_detect's texture test:
    a ragged velocity along the beam, or a fragment) is what VROT and the
    debris score leave out; the velocity product itself keeps those gates."""
    g = _base(site, "G", slot, key)
    if empty(g):
        return g, np.zeros((0, 0), np.float32), None, {}, None
    vals, rf = values(g)
    nyq_kt = g["meta"].get("nyquistKt")
    info: dict[str, Any] = {"dealias": alg if nyq_kt else "off"}
    az, r = geometry(g)
    dbz = None
    b = _base(site, "B", slot, key)
    if not empty(b):
        bv, _ = values(b)
        baz, br = geometry(b)
        dbz = regrid(bv, baz, br, az, r)
    noise = None
    if nyq_kt:
        nyq = nyq_kt / KT_PER_MS
        vw = np.where(np.isfinite(vals), _wrap(np.nan_to_num(vals / KT_PER_MS), nyq), np.nan).astype(np.float32)
        noise = rd._noisy(vw, nyq, dbz)  # noqa: SLF001
    if alg == "off" or not nyq_kt:
        if alg != "off":
            info["dealiasNote"] = "No Nyquist velocity in this sweep: shown as observed"
        return g, vals, rf, info, noise
    t0 = time.perf_counter()
    v = unfold(vals / KT_PER_MS, nyq_kt / KT_PER_MS, r, az, float(g["meta"].get("elevation") or 0.5), alg,
               dbz if alg == "region" else None)
    info["msDealias"] = round((time.perf_counter() - t0) * 1000.0)
    return g, (v * KT_PER_MS).astype(np.float32), rf, info, noise


def _velocity(site: str, c: Code, key: str, product: str) -> dict:
    g, v, rf, info, _noise = unfolded_velocity(site, c.slot, key, c.dealias)
    if empty(g):
        return _empty_like(g, c, product)
    return _out(g, v, c, product, rf, **info)


def _srv(site: str, c: Code, key: str, product: str) -> dict:
    g, v, rf, info, _noise = unfolded_velocity(site, c.slot, key, c.dealias)
    if empty(g):
        return _empty_like(g, c, product)
    mo = storm_motion(site, key, c, g["meta"].get("scanUnix"))
    az, _ = geometry(g)
    srv = v - (mo["speedKt"] * np.cos(np.radians(az - mo["towardDeg"])))[:, None].astype(np.float32)
    extra = {"stormMotionKt": round(float(mo["speedKt"]), 1), "stormMotionDeg": round(float(mo["towardDeg"]), 1),
             "stormMotionFrom": round((float(mo["towardDeg"]) + 180.0) % 360.0, 1), "motionSource": mo["source"]}
    if mo.get("prevKey"):
        extra["motionTrackedFrom"] = mo["prevKey"]
    return _out(g, srv, c, product, rf, **info, **extra)


def _vrot(site: str, c: Code, key: str, product: str) -> dict:
    g, v, _rf, info, noise = unfolded_velocity(site, c.slot, key, c.dealias)
    if empty(g):
        return _empty_like(g, c, product)
    az, r = geometry(g)
    d_az = float(np.median(np.diff(az))) if az.size > 1 else 0.5
    t0 = time.perf_counter()
    if noise is not None:
        v = np.where(noise, np.float32(np.nan), v)
    vr = vrot_field(v, r, d_az if d_az > 0 else 0.5)
    info["msVrot"] = round((time.perf_counter() - t0) * 1000.0)
    return _out(g, vr, c, product, None, **info)


def _ptds(site: str, c: Code, key: str, product: str) -> dict:
    cg = _base(site, "C", c.slot, key)
    if empty(cg):
        return _empty_like(cg, c, product)
    az, r = geometry(cg)
    cc, _ = values(cg)

    def on_cc(fam: str) -> Optional[np.ndarray]:
        g = _base(site, fam, c.slot, key)
        if empty(g):
            return None
        vals, _ = values(g)
        gaz, gr = geometry(g)
        same = gaz.size == az.size and gr.size == r.size and np.allclose(gaz, az) and np.allclose(gr, r)
        return vals if same else regrid(vals, gaz, gr, az, r)

    dbz = on_cc("B")
    zdr = on_cc("X")
    sw_kt = on_cc("W")
    if dbz is None or zdr is None:
        return _empty_like(cg, c, product)
    info: dict[str, Any] = {}
    nrot_cc = None
    g, v, _rf, vinfo, noise = unfolded_velocity(site, c.slot, key, c.dealias)
    if not empty(g) and v.size:
        if noise is not None:
            v = np.where(noise, np.float32(np.nan), v)
        gaz, gr = geometry(g)
        d_az = float(np.median(np.diff(gaz))) if gaz.size > 1 else 0.5
        hemi = 1 if float(g["meta"].get("siteLat") or 0.0) >= 0 else -1
        nr = nrot_field(v / KT_PER_MS, gr, d_az if d_az > 0 else 0.5, hemi)
        # Debris sits in the vortex, not always on its strongest-shear gates.
        a = np.nan_to_num(np.abs(nr), nan=0.0)
        a = ndimage.maximum_filter(a, size=(5, 7), mode=("wrap", "nearest"))
        nrot_cc = regrid(a, gaz, gr, az, r)
        info.update(vinfo)
    t0 = time.perf_counter()
    dbz_m, cc_m = rd._median3(dbz), rd._median3(cc)  # noqa: SLF001
    score = ptds_score(dbz_m, cc_m, rd._median3(zdr), nrot_cc,  # noqa: SLF001
                       None if sw_kt is None else sw_kt / KT_PER_MS)
    score *= support_factor(debris_support(dbz_m, cc_m)).astype(np.float32)
    score *= np.asarray(clutter_factor(on_cc("F")), dtype=np.float32)
    score *= range_factor(r).astype(np.float32)[None, :]
    info["msPtds"] = round((time.perf_counter() - t0) * 1000.0)
    with np.errstate(invalid="ignore"):
        info["ptdsMax"] = round(float(np.nanmax(score)), 1) if np.isfinite(score).any() else None
        info["ptdsDetections"] = int((score > PTDS_DETECTION).sum())
        info["ptdsSignificant"] = int((score > PTDS_SIGNIFICANT).sum())
    return _out(cg, score, c, product, None, **info)


def volume_products(site: str, key: str) -> dict[str, dict]:
    """CREF, ET, VIL and DVIL of one volume, as wire grids on the lowest
    reflectivity cut's radials and gates."""
    vkey, vol = _resolve(site, key)
    t0 = time.perf_counter()
    st = xs._stack(site, vkey, vol, "B")  # noqa: SLF001
    t1 = time.perf_counter()
    sweeps = st["sweeps"]
    if not sweeps:
        raise RuntimeError("This volume carries no reflectivity.")
    base = min(sweeps, key=lambda s: (s["elev"], -np.asarray(s["vals"]).shape[1]))
    az = np.asarray(base["az"], dtype=np.float64) % 360.0
    order = np.argsort(az)
    az = az[order]
    ng = int(np.asarray(base["vals"]).shape[1])
    first, width = float(base["first"]), float(base["width"])
    s_out = first + np.arange(ng) * width
    agl = max(float(st["heightKm"]) - float(st["groundKm"]), 0.0)
    prods = column_products(sweeps, az, s_out, float(st["heightKm"]), agl)
    t2 = time.perf_counter()
    stamp = st["stamp"]
    unix = l2._stamp_unix(stamp)  # noqa: SLF001
    edges = np.empty(az.size + 1, dtype=np.float32)
    edges[:-1] = az
    edges[-1] = az[0] + 360.0
    out = {}
    for name in VOLUME:
        label, units, kind = _LABELS[name]
        codes, lut, _rfc, pid, vmin, vmax = pack(prods[name], kind)
        out[name] = {"az": edges, "lut": lut, "codes": codes, "meta": {
            "site": icao_for(site), "siteLat": st["lat"], "siteLon": st["lon"],
            "product": f"L2{name}", "productLabel": label, "units": units, "kind": kind,
            "family": name, "tilt": None, "elevation": None, "defaultPalette": pid,
            "vmin": vmin, "vmax": vmax, "nAz": int(codes.shape[0]), "nGates": int(codes.shape[1]),
            "rangeStartKm": first, "gateWidthKm": width, "maxRangeKm": first + ng * width,
            "validUnix": unix, "scanUnix": unix, "key": f"L2:{stamp}", "source": "level2",
            "derived": True, "superRes": int(codes.shape[0]) >= 720, "vcp": st.get("vcp"),
            "elevations": l2._ladder([float(s["elev"]) for s in sweeps]),  # noqa: SLF001
            "cuts": len(sweeps), "siteAmslM": round(float(st["groundKm"]) * 1000.0, 1),
            "msBuild": {"load": round((t1 - t0) * 1000.0), "compute": round((t2 - t1) * 1000.0)},
        }}
    capped = prods["capped"]
    if capped.any():
        # How far out the echo still reaches the highest cut: inside it the
        # echo top is above what the volume samples.
        reach = float(s_out[np.nonzero(capped.any(axis=0))[0][-1]])
        ordered_top = max(float(sw["elev"]) for sw in sweeps)
        out["ET"]["meta"]["toppedOutKm"] = round(reach, 1)
        out["ET"]["meta"]["note"] = (f"Echo reaches the highest cut ({ordered_top:.1f}°) out to {reach:.0f} km: "
                                     "the tops there are higher than shown")
        out["DVIL"]["meta"]["toppedOutKm"] = round(reach, 1)
    return out


def polar(site: str, product: str, key: str = "") -> dict:
    """A derived product (see the module notes) in the polar wire format."""
    c = parse(product)
    if c is None:
        raise RuntimeError(f"Unknown derived product: {product}")
    site = site_id(site)
    if key.startswith("L2P:") or re.search(r":c\d+$", key):
        # A live volume still being written, or a SAILS / MRLE rescan
        # (level2_live.py): per-tilt products read it by that key as it is.
        if c.name in VOLUME:
            raise RuntimeError(f"{c.name} needs the whole volume")
        vkey = key
    else:
        vkey, _vol = _resolve(site, key)
    ck = (site, c.canonical, vkey)
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
        t0 = time.perf_counter()
        name = (product or "").upper()
        if c.name in VOLUME:
            grids = volume_products(site, vkey)
            out = grids[c.name]
            with _LOCK:
                for nm, g in grids.items():
                    _CACHE[(site, f"L2{nm}", vkey)] = g
        elif c.name == "G":
            out = _velocity(site, c, vkey, name)
        elif c.name == "S":
            out = _srv(site, c, vkey, name)
        elif c.name == "VROT":
            out = _vrot(site, c, vkey, name)
        else:
            out = _ptds(site, c, vkey, name)
        out["meta"]["msTotal"] = round((time.perf_counter() - t0) * 1000.0)
        if out["meta"].get("pending"):  # that tilt isn't scanned yet: ask again later
            with _LOCK:
                _GATES.pop(ck, None)
            return out
        with _LOCK:
            _CACHE[ck] = out
            _CACHE.move_to_end(ck)
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
            _GATES.pop(ck, None)
        return out
