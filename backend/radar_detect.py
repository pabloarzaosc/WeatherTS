"""
Storm detections from the radar's own volume: mesocyclones, velocity couplets,
tornado debris signatures and hook echoes.

Everything here is computed from the base data of one volume -- the Level II
volume of a NEXRAD (the same whole-volume read radar_xsect makes) or a kept
Brazilian volume (brazil_radar) -- not from the RPG's own products, so it works
on any archive day and on radars that publish no derived products at all.

1. Velocity unfolding (`dealias`). Level II velocity is the RDA's, before the
   RPG unfolds it: with a Nyquist of ~26 m/s every strong couplet folds. Each
   sweep is unfolded by regions: the gates are split into value bands, each
   connected patch of one band is a region, and regions are joined across
   their shared boundaries -- longest boundary first, the way a maximum
   spanning tree is grown -- each taking the fold (a multiple of 2 Nyquist)
   that makes the boundary smooth. A short boundary that disagrees with a long
   one (a tornado's few gates of 40 m/s shear) is outvoted rather than
   "unfolded" into a fold that is not there. The joined field's absolute fold
   comes from the model's wind where there is one, else from the radar's own
   VAD: a ring's mean radial velocity is near zero, while a wrong fold moves
   it by 2 Nyquist.

2. Azimuthal shear (`azimuthal_shear`): the least-squares slope of velocity
   along the azimuth over a few radials and gates (the LLSD idea), in s^-1,
   positive where velocity rises clockwise -- cyclonic in the northern
   hemisphere. Normalised as the app's NROT is (nexrad_core._nrot_field), so a
   threshold reads the same near the radar and far from it.

3. Mesocyclones: per tilt, patches of cyclonic normalised shear around a core
   are 2D features, each with its rotational velocity (half the inbound to
   outbound difference around it) and diameter. Features on consecutive tilts
   within a few km are joined into 3D detections with a base and a top (beam
   centre heights, 4/3-earth model, above radar level), a depth and a strength
   rank. Given the detections of the volume before (when they are kept), each
   one is matched to its predecessor: a track id, a motion and a trail.

4. Velocity couplets: the largest cyclonic gate-to-gate difference across one
   to a few radials (inbound beside outbound) at the lowest tilts, ranked.

5. Tornado debris signature: low correlation (rhoHV <= 0.82) in high
   reflectivity (>= 35 dBZ) with ZDR near zero, beside strong low-level
   rotation (a couplet or a mesocyclone's low feature within a few km).

6. Hook echo: whether the circulation sits at the tip of a thin reflectivity
   appendage hanging off a thick core (see `_hook`). A heuristic; it is
   reported with its measures so it can be judged.
"""
from __future__ import annotations

import io
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
from scipy import ndimage

RE_KM = 6371.0
RE_EFF_KM = RE_KM * 4.0 / 3.0
MS_TO_KT = 1.943844

# How far out anything is looked for. Velocity reaches ~300 km, but past ~230
# the beam is kilometres wide and kilometres up: no circulation is resolved.
MAX_RANGE_KM = 230.0
MIN_RANGE_KM = 6.0
# The fastest radial velocity believed after unfolding: twice the Nyquist, or
# this, whichever is more. WSR-88D couplets top out near 60 m/s at the gate.
MAX_FOLDS = 2.0
MAX_WIND_MS = 55.0

# Normalisation of the shear, as the app's NROT (nexrad_core._nrot_field).
NROT_K0 = 0.010   # s^-1 that counts as significant within NROT_R0
NROT_R0 = 30.0    # km
MIN_ARC_KM = 0.25

# 2D mesocyclone features.
FEAT_LOW = 0.6     # normalised cyclonic shear that bounds a feature
FEAT_CORE = 1.0    # ... that its core must reach
FEAT_MIN_GATES = 6
FEAT_MIN_DBZ = 15.0
FEAT_MAX_DIAM_KM = 12.0
FEAT_MIN_VROT = 7.5  # m/s
ANTI_DOMINANT = 1.0  # opposite shear beside a feature, as a share of its own, that rejects it

# Vertical association.
ASSOC_KM = 5.0       # to the feature on the tilt just below
ASSOC_GAP_KM = 6.5   # across one tilt with nothing found
# One circulation split into several columns: a tornado's tight vortex and the
# broader mesocyclone around it are separate features on the same tilts, and a
# tilted column breaks where it leans past ASSOC_KM. Two columns of at least
# moderate strength with features this close on the same or adjacent tilts
# are one detection (Moore 2013: 3.2 km; Rolling Fork 2023: 3.5 km).
MERGE_KM = 4.0
MERGE_MIN_RANK = 5

# Couplets.
COUPLET_MIN_MS = 20.0       # ~39 kt of delta-V
COUPLET_MAX_GAP_KM = 2.5    # between the inbound and the outbound gate
COUPLET_MAX_ELEV = 1.6      # deg: the lowest tilts only
COUPLET_SUPPRESS_KM = 4.0
# A couplet seen on one tilt only is taken at its word only inside real echo
# and within the Nyquist interval. Past either, it is near-radar clutter or a
# fold the unfolding got wrong (KAMA 2026-10-26 16:32: a "101 kt" couplet
# 12.5 km out, 0.14 km up, outbound 61 kt with a 51 kt Nyquist, in showers).
COUPLET_ECHO_DBZ = 30.0     # strongest echo within ~1.5 km of the couplet
COUPLET_ECHO_WIN = (2, 6)   # radials, gates either side searched for it
# Tornado vortex signatures, from the couplets (after the NWS TDA's idea): a
# straddling couplet of at least ~25 m/s seen on two or more of the low tilts.
# On the volume's lowest tilt it is a TVS; starting higher, an elevated one
# (ETVS). Past ~160 km the beam is over 2.5 km wide and its lowest cut ~3 km
# up: a couplet there is a mesocyclone's, not a tornado's.
TVS_MIN_DV_KT = 50.0
TVS_MIN_TILTS = 2
TVS_MAX_RANGE_KM = 160.0

# Debris.
TDS_MIN_DBZ = 35.0
TDS_MAX_CC = 0.82
TDS_MAX_ZDR = 1.5
TDS_MIN_ZDR = -3.0
TDS_MIN_GATES = 3
TDS_MAX_ELEV = 3.5
# Real debris sits on its rotation (0.2-0.9 km at Moore 2013 and Rolling
# Fork 2023); low CC 2.2-2.9 km from a weak mesocyclone's centre was hail or
# clutter (KTLX 2013-05-20 20:16 and 20:29, near Midwest City and Spencer).
TDS_ROT_KM = 2.0
TDS_JOIN_KM = 4.0      # patches this close to a signature's seed, on any tilt, join it
TDS_MIN_PEAK_DBZ = 45.0  # a signature's strongest gate (weak echo loses CC with its signal)
TDS_GROUP_KM = 6.0     # no patch of a signature further than this from its seed
TDS_MIN_ALONE = 8      # gates a signature seen on one tilt only needs
TDS_MIN_ROT_KT = 50.0  # delta-V of the rotation a debris patch must sit beside (a TVS's)
TDS_ROT_MIN_TILTS = 2  # ... and the tilts that rotation must be seen on
# A signature on one tilt only also needs this much area: 11 gates / 0.5 km2 of
# low CC under a one-tilt couplet in ordinary showers (KAMA 2026-10-26 16:32,
# 20 km out) was clutter, not a tornado.
TDS_MIN_AREA_ALONE = 1.0
# Closer than this the lowest beam is a few hundred metres up, in the ground
# clutter: a signature there has to be lofted through a second tilt (Moore's
# debris 19 km from KTLX in 2013 reached 4+ tilts).
TDS_NEAR_KM = 20.0
# Lowest beam height a signature may start at. Far out, the low cut is 3-4 km
# up and kilometres wide: low correlation there is a hail core or the melting
# layer filling half the beam (KDGX 2023-03-25 at 196 km, KTLX 2013-05-20 at
# 166-172 km), not debris; at 2.9 km (KTLX 2013-05-20 20:25 at 159 km) still a
# 44 dBZ patch with no tornado under it.
TDS_MAX_BASE_KM = 2.5


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def beam_height_km(r_km: Any, elev_deg: float) -> Any:
    """Height of the beam centre above the antenna, 4/3-earth model."""
    th = math.radians(elev_deg)
    return np.sqrt(r_km * r_km + RE_EFF_KM ** 2 + 2.0 * r_km * RE_EFF_KM * math.sin(th)) - RE_EFF_KM


def ground_km(r_km: Any, elev_deg: float) -> Any:
    """Distance over the ground under a gate at slant range r."""
    h = beam_height_km(r_km, elev_deg)
    return RE_EFF_KM * np.arcsin(np.clip(r_km * math.cos(math.radians(elev_deg)) / (RE_EFF_KM + h), -1, 1))


def destination(lat: float, lon: float, az_deg: float, dist_km: float) -> tuple[float, float]:
    """The point dist_km from (lat, lon) along az_deg, on the sphere."""
    p1, l1 = math.radians(lat), math.radians(lon)
    th, d = math.radians(az_deg), dist_km / RE_KM
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(th))
    l2 = l1 + math.atan2(math.sin(th) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def _xy_to_ll(lat0: float, lon0: float, x: float, y: float) -> tuple[float, float]:
    return destination(lat0, lon0, math.degrees(math.atan2(x, y)) % 360.0, math.hypot(x, y))


def _ll_to_xy(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    """km east and north of the radar, along the great circle (azimuthal equidistant)."""
    p1, p2 = math.radians(lat0), math.radians(lat)
    dl = math.radians(lon - lon0)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    s = RE_KM * math.acos(max(-1.0, min(1.0, c)))
    az = math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))
    return s * math.sin(az), s * math.cos(az)


# ---------------------------------------------------------------------------
# A sweep, whatever volume it came from
# ---------------------------------------------------------------------------
@dataclass
class Sweep:
    elev: float
    az: np.ndarray                  # radial centres, deg, ascending
    r_km: np.ndarray                # gate centres, km
    data: dict[str, np.ndarray] = field(default_factory=dict)   # REF VEL SW RHO ZDR, rays x gates
    nyq: Optional[float] = None     # m/s
    unix: Optional[float] = None

    @property
    def d_az(self) -> float:
        if self.az.size < 2:
            return 1.0
        return float(np.median(np.diff(self.az))) or 1.0

    @property
    def dr(self) -> float:
        return float(self.r_km[1] - self.r_km[0]) if self.r_km.size > 1 else 0.25


@dataclass
class Tilt:
    elev: float
    vel: Optional[Sweep] = None     # the sweep that carries velocity
    pol: Optional[Sweep] = None     # the one that carries correlation (the same sweep outside split cuts)


# ---------------------------------------------------------------------------
# 1. Velocity unfolding
# ---------------------------------------------------------------------------
# Speckle: the RMS of the gate-to-gate step along the radial (folded into one
# Nyquist interval) over +-2 gates, as a share of the Nyquist velocity. Weather
# steps a few m/s from gate to gate; noise is uniform across the interval and
# steps ~0.8 Nyquist. Weak echo has to be smooth to be kept, strong echo only
# has to be short of pure noise -- a tornado's core steps fast along the beam
# too, and it is always in strong echo.
TEXTURE_SOFT = 0.4
TEXTURE_HARD = 0.7
TEXTURE_DBZ = 25.0
# A region whose boundary says, by this share of its length, that it sits a
# whole fold away from everything around it is re-folded after the join.
REFOLD_SHARE = 0.6
REFOLD_PASSES = 3


def _wrap(v: np.ndarray, nyq: float) -> np.ndarray:
    two = 2.0 * nyq
    return (v + nyq) % two - nyq


def _noisy(vw: np.ndarray, nyq: float, dbz: Optional[np.ndarray]) -> np.ndarray:
    """Gates too noisy to unfold: a ragged velocity along the beam (see
    TEXTURE_*), or a fragment of under three gates along it."""
    ok = np.isfinite(vw)
    step = _wrap(np.diff(vw, axis=1), nyq)
    good = np.isfinite(step)
    s2 = np.where(good, step * step, 0.0).astype(np.float64)
    cnt = good.astype(np.float64)
    ng = vw.shape[1]
    # Gate j sees the steps j-2 .. j+1 (step k joins gates k and k+1).
    c2 = np.concatenate([np.zeros((vw.shape[0], 1)), np.cumsum(s2, axis=1)], axis=1)
    cc = np.concatenate([np.zeros((vw.shape[0], 1)), np.cumsum(cnt, axis=1)], axis=1)
    j = np.arange(ng)
    hi = np.minimum(j + 2, ng - 1)
    lo = np.maximum(j - 2, 0)
    tot = c2[:, hi] - c2[:, lo]
    n = cc[:, hi] - cc[:, lo]
    with np.errstate(invalid="ignore", divide="ignore"):
        tex = np.sqrt(tot / n) / nyq
    weak = np.ones(vw.shape, dtype=bool) if dbz is None else ~(np.nan_to_num(dbz[:, :ng], nan=-99.0) >= TEXTURE_DBZ)
    if dbz is not None and dbz.shape[1] < ng:
        weak[:, dbz.shape[1]:] = True
    bad = (n < 2) | (tex > TEXTURE_HARD) | (weak & (tex > TEXTURE_SOFT))
    return ok & bad


def _regions(vw: np.ndarray, ok: np.ndarray, nyq: float, bands: int) -> tuple[np.ndarray, int]:
    """Connected patches of one value band, numbered from 1."""
    edges = np.linspace(-nyq, nyq, bands + 1)[1:-1]
    band = np.digitize(np.where(ok, vw, 0.0), edges)
    labels = np.zeros(vw.shape, dtype=np.int64)
    n = 0
    for k in range(bands):
        lab, cnt = ndimage.label(ok & (band == k))
        if cnt:
            labels[lab > 0] = lab[lab > 0] + n
            n += cnt
    return labels, n


def _boundaries(labels: np.ndarray, vals: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Every pair of touching gates in different regions -- along the gates,
    across the radials and across the 360/0 seam: (region a, region b,
    value at b minus value at a)."""
    def pairs(a: np.ndarray, b: np.ndarray, va: np.ndarray, vb: np.ndarray):
        m = (a > 0) & (b > 0) & (a != b)
        return a[m], b[m], (vb - va)[m]

    parts = [
        pairs(labels[:, :-1], labels[:, 1:], vals[:, :-1], vals[:, 1:]),
        pairs(labels[:-1], labels[1:], vals[:-1], vals[1:]),
        pairs(labels[-1:], labels[:1], vals[-1:], vals[:1]),
    ]
    return (np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts]),
            np.concatenate([p[2] for p in parts]).astype(np.float64))


def dealias(v: np.ndarray, nyq: Optional[float], ref: Optional[np.ndarray] = None,
            r_km: Optional[np.ndarray] = None, az: Optional[np.ndarray] = None, bands: int = 3,
            dbz: Optional[np.ndarray] = None) -> np.ndarray:
    """Unfold one sweep's radial velocity (rays x gates, m/s, NaN = none).

    `ref`, when given, is a field of the radial velocity expected at each gate
    (the model's wind): it settles each joined region's absolute fold. Without
    it the ring means of the largest region settle it (see the module notes).
    `dbz`, the same sweep's reflectivity, lets strong echo keep a rougher
    velocity than weak echo before it counts as noise. Noise comes back NaN.
    """
    v = np.asarray(v, dtype=np.float32)
    ok = np.isfinite(v)
    if not nyq or nyq <= 0 or ok.sum() < 10:
        return v.copy()
    nyq = float(nyq)
    two = 2.0 * nyq
    vw = np.where(ok, _wrap(v, nyq), np.nan).astype(np.float32)
    noise = _noisy(vw, nyq, dbz)
    vw[noise] = np.nan
    ok &= ~noise
    if ok.sum() < 10:
        return vw

    labels, n = _regions(vw, ok, nyq, bands)
    if n <= 1:
        return _absolute(vw.copy(), labels, two, ref, r_km, az)

    la, lb, dd = _boundaries(labels, vw)
    if la.size == 0:
        return _absolute(vw.copy(), labels, two, ref, r_km, az)
    swap = la > lb
    lo = np.where(swap, lb, la)
    hi = np.where(swap, la, lb)
    dd = np.where(swap, -dd, dd)                  # velocity of `hi` minus `lo`
    key = lo * (n + 1) + hi
    uniq, inv = np.unique(key, return_inverse=True)
    cnt = np.bincount(inv)
    mean = np.bincount(inv, weights=dd) / cnt
    ea, eb = uniq // (n + 1), uniq % (n + 1)
    # The fold of `hi` relative to `lo` that makes the boundary smooth.
    kk = -np.rint(mean / two).astype(np.int64)
    order = np.argsort(-cnt, kind="stable")

    size = np.bincount(labels.ravel(), minlength=n + 1).astype(np.int64)
    parent = list(range(n + 1))
    off = [0] * (n + 1)     # fold of a node relative to its parent

    def find(x: int) -> tuple[int, int]:
        path = []
        while parent[x] != x:
            path.append(x)
            x = parent[x]
        root = x
        # Compress, folding the offsets along the way.
        acc = 0
        for node in reversed(path):
            acc += off[node]
            off[node] = acc
            parent[node] = root
        return root, (off[path[0]] if path else 0)

    sz = size.tolist()
    ea_l, eb_l, kk_l = ea.tolist(), eb.tolist(), kk.tolist()
    for e in order.tolist():
        a, b = ea_l[e], eb_l[e]
        ra, oa = find(a)
        rb, ob = find(b)
        if ra == rb:
            continue
        rel = kk_l[e] + oa - ob             # fold of rb's root relative to ra's
        if sz[ra] >= sz[rb]:
            parent[rb], off[rb] = ra, rel
            sz[ra] += sz[rb]
        else:
            parent[ra], off[ra] = rb, -rel
            sz[rb] += sz[ra]

    roots = np.zeros(n + 1, dtype=np.int64)
    folds = np.zeros(n + 1, dtype=np.int64)
    for x in range(1, n + 1):
        r, o = find(x)
        roots[x], folds[x] = r, o
    out = vw + (two * folds[labels]).astype(np.float32)
    out[~ok] = np.nan
    groups = roots[labels]
    groups[~ok] = 0
    out = _absolute(out, groups, two, ref, r_km, az)
    return _refold(out, labels, n, two, size)


def _refold(out: np.ndarray, labels: np.ndarray, n: int, two: float, size: np.ndarray) -> np.ndarray:
    """Re-fold the regions the join got wrong.

    A join decided on a boundary's mean step can still take a wrong fold when
    the boundary is short and ragged. Such a region then stands a whole fold
    away from nearly everything around it, which no wind does: a tornado's
    core is a fold away from the far side of its couplet, but joins its own
    side smoothly. Each region's boundary gates vote for the whole folds that
    would make them smooth; a region whose boundary mostly agrees on one
    non-zero fold takes it. The largest region is the frame of reference and
    never moves."""
    biggest = int(np.argmax(size[1:]) + 1) if n else 0
    for _ in range(REFOLD_PASSES):
        la, lb, d = _boundaries(labels, out)
        good = np.isfinite(d)
        la, lb, d = la[good], lb[good], d[good]
        if la.size == 0:
            break
        regs = np.concatenate([la, lb])
        ks = np.concatenate([np.rint(d / two), np.rint(-d / two)]).astype(np.int64)
        total = np.bincount(regs, minlength=n + 1).astype(np.float64)
        best_k = np.zeros(n + 1, dtype=np.int64)
        best_v = np.zeros(n + 1, dtype=np.float64)
        for k in (-3, -2, -1, 1, 2, 3):
            sel = ks == k
            if not sel.any():
                continue
            votes = np.bincount(regs[sel], minlength=n + 1).astype(np.float64)
            better = votes > best_v
            best_v = np.where(better, votes, best_v)
            best_k = np.where(better, k, best_k)
        with np.errstate(invalid="ignore", divide="ignore"):
            share = best_v / total
        move = (share >= REFOLD_SHARE) & (total >= 3) & (best_k != 0)
        move[0] = False
        if biggest:
            move[biggest] = False
        if not move.any():
            break
        shift = np.where(move, best_k, 0)
        out = out + (two * shift[labels]).astype(np.float32)
    return out


def _harmonic(az_rad: np.ndarray, vals: np.ndarray) -> Optional[tuple[float, float, float]]:
    """Least-squares a0 + a1 cos(az) + b1 sin(az)."""
    if vals.size < 30:
        return None
    a = np.stack([np.ones_like(az_rad), np.cos(az_rad), np.sin(az_rad)], axis=1)
    try:
        c, *_ = np.linalg.lstsq(a, vals, rcond=None)
    except np.linalg.LinAlgError:
        return None
    return float(c[0]), float(c[1]), float(c[2])


def _absolute(out: np.ndarray, groups: np.ndarray, two: float, ref: Optional[np.ndarray],
              r_km: Optional[np.ndarray], az: Optional[np.ndarray]) -> np.ndarray:
    """Shift each joined group by the whole folds that put it where it belongs."""
    ok = np.isfinite(out) & (groups > 0)
    if not ok.any():
        return out
    ids, counts = np.unique(groups[ok], return_counts=True)
    order = np.argsort(-counts)
    shifts = np.arange(-3, 4)
    rng = np.random.default_rng(0)

    vad = None
    g0 = None
    if ref is None and r_km is not None and az is not None:
        # The largest group: whole folds that bring its ring means nearest zero.
        g0 = ids[order[0]]
        m0 = ok & (groups == g0)
        best_s = 0
        rings = []
        ring_km = 15.0
        azr = np.radians(az)
        for lo in np.arange(0.0, float(r_km[-1]), ring_km):
            cols = np.nonzero((r_km >= lo) & (r_km < lo + ring_km))[0]
            if cols.size == 0:
                continue
            sub = m0[:, cols[0]:cols[-1] + 1]
            rows = np.nonzero(sub.any(axis=1))[0]
            # Coverage: the ring is worth a mean only seen most of the way round.
            if rows.size < 0.6 * az.size:
                continue
            ii, jj = np.nonzero(sub)
            if ii.size > 6000:
                pick = rng.choice(ii.size, 6000, replace=False)
                ii, jj = ii[pick], jj[pick]
            vals = out[ii, cols[0] + jj].astype(np.float64)
            fit = _harmonic(azr[ii], vals)
            if fit is not None:
                rings.append((lo + ring_km / 2.0, fit, ii.size))
        if rings:
            costs = [sum(w * abs(f[0] + two * s) for _, f, w in rings) for s in shifts]
            best_s = int(shifts[int(np.argmin(costs))])
        else:
            # Nothing seen all round: the nearest gates' median, which is the
            # low-level wind and rarely past one Nyquist.
            seen = np.nonzero(m0.any(axis=0))[0]
            near = m0 & (r_km[None, :] < max(40.0, float(np.percentile(r_km[seen], 20))))
            ii, jj = np.nonzero(near if near.any() else m0)
            if ii.size > 20000:
                pick = rng.choice(ii.size, 20000, replace=False)
                ii, jj = ii[pick], jj[pick]
            med = float(np.median(out[ii, jj]))
            best_s = int(shifts[int(np.argmin(np.abs(med + two * shifts)))])
        out[m0] += two * best_s
        if rings:
            # The ring fits, shifted, are the reference for every other group.
            ranges = np.array([c for c, _, _ in rings])
            fits = np.array([[f[0] + two * best_s, f[1], f[2]] for _, f, _ in rings])
            vad = (ranges, fits)

    # Every other group at once: per group and per whole fold, the summed
    # distance (capped at a fold, so a few wild gates cannot outvote the rest)
    # from where the reference says its gates should be.
    rest = ok if g0 is None else ok & (groups != g0)
    if not rest.any():
        return out
    ii, jj = np.nonzero(rest)
    gi = groups[ii, jj]
    vals = out[ii, jj].astype(np.float64)
    if ref is not None:
        want = ref[ii, jj].astype(np.float64)
    elif vad is not None:
        ranges, fits = vad
        rr = r_km[jj]
        a0 = np.interp(rr, ranges, fits[:, 0])
        a1 = np.interp(rr, ranges, fits[:, 1])
        b1 = np.interp(rr, ranges, fits[:, 2])
        azr = np.radians(az[ii])
        want = a0 + a1 * np.cos(azr) + b1 * np.sin(azr)
    else:
        want = np.zeros_like(vals)
    good = np.isfinite(want)
    if not good.any():
        return out
    gi_g, vals_g, want_g = gi[good], vals[good], want[good]
    nlab = int(groups.max()) + 1
    cost = np.stack([np.bincount(gi_g, weights=np.minimum(np.abs(vals_g + two * s - want_g), two),
                                 minlength=nlab) for s in shifts])
    best = shifts[np.argmin(cost, axis=0)]
    best[np.bincount(gi_g, minlength=nlab) == 0] = 0
    if g0 is not None:
        best[g0] = 0
    out[ii, jj] += (two * best[gi]).astype(np.float32)
    return out


# ---------------------------------------------------------------------------
# 2. Azimuthal shear
# ---------------------------------------------------------------------------
def azimuthal_shear(v_ms: np.ndarray, d_az_deg: float, r_km: np.ndarray, half_az: int = 2,
                    half_gate: int = 2, min_frac: float = 0.55) -> np.ndarray:
    """The least-squares slope of velocity along the azimuth over a window of
    (2 half_az + 1) radials x (2 half_gate + 1) gates, per metre of arc: s^-1.
    Positive where the velocity rises clockwise. NaN where under `min_frac`
    of the window has data."""
    v = np.asarray(v_ms, dtype=np.float32)
    ok = np.isfinite(v)
    okf = ok.astype(np.float32)
    v0 = np.where(ok, v, np.float32(0.0))
    w = half_gate

    def gate_box(a: np.ndarray) -> np.ndarray:
        if w == 0:
            return a
        c = np.cumsum(np.pad(a, ((0, 0), (w + 1, w))), axis=1, dtype=np.float32)
        return c[:, 2 * w + 1:] - c[:, : -(2 * w + 1)]

    def az_moment(a: np.ndarray, power: int) -> np.ndarray:
        out = np.zeros_like(a)
        for dx in range(-half_az, half_az + 1):
            if power and dx == 0:
                continue
            out += np.float32(dx ** power) * np.roll(a, -dx, axis=0)
        return out

    g_ok, g_v = gate_box(okf), gate_box(v0)
    n = az_moment(g_ok, 0)
    sx, sxx = az_moment(g_ok, 1), az_moment(g_ok, 2)
    sv, sxv = az_moment(g_v, 0), az_moment(g_v, 1)
    denom = n * sxx - sx * sx
    with np.errstate(invalid="ignore", divide="ignore"):
        slope = (n * sxv - sx * sv) / denom           # m/s per radial
        arc_m = np.maximum(np.radians(d_az_deg) * r_km, MIN_ARC_KM) * 1000.0
        shear = slope / arc_m[None, :]
    full = (2 * half_az + 1) * (2 * half_gate + 1)
    shear[(n < min_frac * full) | ~ok | (denom <= 0)] = np.nan
    return shear.astype(np.float32)


def nrot_scale(r_km: np.ndarray) -> np.ndarray:
    """The shear (s^-1) that counts as 1 at each range: the app's NROT divisor."""
    return NROT_K0 * np.sqrt(NROT_R0 / np.maximum(r_km, NROT_R0))


def _windows(sw: Sweep) -> tuple[int, int]:
    """Shear window half-widths for a sweep: ~2.5 deg and ~1.25 km."""
    half_az = 2 if sw.d_az <= 0.75 else 1
    half_gate = max(1, int(round(0.5 / max(sw.dr, 0.05))))
    return half_az, min(half_gate, 4)


# ---------------------------------------------------------------------------
# Per-sweep fields
# ---------------------------------------------------------------------------
@dataclass
class VelField:
    sw: Sweep
    v: np.ndarray        # unfolded velocity, m/s
    shear: np.ndarray    # s^-1, cyclonic positive (hemisphere applied)
    nrot: np.ndarray     # shear / nrot_scale
    ref: Optional[np.ndarray]
    x: np.ndarray        # km east of the radar per gate
    y: np.ndarray
    h: np.ndarray        # beam height above the antenna per gate (gates only)


def _gate_xy(sw: Sweep) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    s = ground_km(sw.r_km.astype(np.float64), sw.elev)
    a = np.radians(sw.az.astype(np.float64))
    x = (np.sin(a)[:, None] * s[None, :]).astype(np.float32)
    y = (np.cos(a)[:, None] * s[None, :]).astype(np.float32)
    h = beam_height_km(sw.r_km.astype(np.float64), sw.elev).astype(np.float32)
    return x, y, h


def vel_field(sw: Sweep, hemi: int, ref: Optional[np.ndarray] = None) -> Optional[VelField]:
    v = sw.data.get("VEL")
    if v is None or not np.isfinite(v).any():
        return None
    vu = dealias(v, sw.nyq, ref=ref, r_km=sw.r_km, az=sw.az, dbz=sw.data.get("REF"))
    if sw.nyq:
        # A gate unfolded past this is a fold the unfolding got wrong, not a
        # wind: it would read as a 100-kt couplet beside its neighbours.
        with np.errstate(invalid="ignore"):
            vu[np.abs(vu) > max(MAX_FOLDS * float(sw.nyq), MAX_WIND_MS)] = np.nan
    ha, hg = _windows(sw)
    sh = azimuthal_shear(vu, sw.d_az, sw.r_km, ha, hg) * hemi
    nr = sh / nrot_scale(sw.r_km)[None, :]
    nr[:, sw.r_km < MIN_RANGE_KM] = np.nan
    x, y, h = _gate_xy(sw)
    return VelField(sw=sw, v=vu, shear=sh, nrot=nr, ref=sw.data.get("REF"), x=x, y=y, h=h)


# ---------------------------------------------------------------------------
# 3. Mesocyclones
# ---------------------------------------------------------------------------
def rank_2d(vrot_ms: float) -> int:
    """A feature's strength rank: 1 from 5 m/s of rotational velocity, one
    more for every 2.5 m/s (rank 5 = 15 m/s = 29 kt, 9 = 49 kt, 13 = 68 kt)."""
    return int(max(0, min(25, math.floor(vrot_ms / 2.5) - 1)))


def features_2d(vf: VelField, tilt_index: int, hemi: int) -> list[dict]:
    """The cyclonic shear features of one tilt."""
    sw = vf.sw
    nr = vf.nrot
    good = np.isfinite(nr)
    mask = good & (nr >= FEAT_LOW) & (sw.r_km[None, :] <= MAX_RANGE_KM)
    if vf.ref is not None:
        mask &= np.nan_to_num(vf.ref, nan=-99.0) >= FEAT_MIN_DBZ
    if not mask.any():
        return []
    lab, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    if n == 0:
        return []
    peak = ndimage.maximum(np.where(mask, nr, 0.0), lab, index=np.arange(1, n + 1))
    sizes = ndimage.sum(mask, lab, index=np.arange(1, n + 1))
    out = []
    slices = ndimage.find_objects(lab)
    for k, slc in enumerate(slices):
        if slc is None or peak[k] < FEAT_CORE or sizes[k] < FEAT_MIN_GATES:
            continue
        lid = k + 1
        r0, r1 = slc[0].start, slc[0].stop
        c0, c1 = slc[1].start, slc[1].stop
        sub = lab[r0:r1, c0:c1] == lid
        wts = np.where(sub, np.maximum(nr[r0:r1, c0:c1], 0.0), 0.0)
        wsum = float(wts.sum()) or 1.0
        cx = float((vf.x[r0:r1, c0:c1] * wts).sum() / wsum)
        cy = float((vf.y[r0:r1, c0:c1] * wts).sum() / wsum)
        # Rotational velocity: the strongest inbound and outbound around the
        # feature (two radials and gates past its edge each way).
        pa, pg = 3, 3
        rows = np.arange(r0 - pa, r1 + pa) % sw.az.size
        g0, g1 = max(0, c0 - pg), min(sw.r_km.size, c1 + pg)
        dil = ndimage.binary_dilation(np.pad(sub, ((pa, pa), (c0 - g0, g1 - c1))),
                                      structure=np.ones((2 * pa + 1, 2 * pg + 1), dtype=bool))
        vv = vf.v[rows][:, g0:g1]
        vv = np.where(dil & np.isfinite(vv), vv, np.nan)
        if not np.isfinite(vv).any():
            continue
        # The flank of a stronger anticyclone: outside a vortex's core the
        # shear turns the other way, so every anticyclone (and every cyclone's
        # far side) is fringed with weaker shear of the opposite sense. A
        # feature whose surroundings turn harder the other way is that fringe.
        around = np.where(dil, vf.nrot[rows][:, g0:g1], np.nan)
        if np.isfinite(around).any() and float(np.nanmin(around)) < -ANTI_DOMINANT * float(peak[k]):
            continue
        imax = np.unravel_index(int(np.nanargmax(vv)), vv.shape)
        imin = np.unravel_index(int(np.nanargmin(vv)), vv.shape)
        vmax, vmin = float(vv[imax]), float(vv[imin])
        xs, ys = vf.x[rows][:, g0:g1], vf.y[rows][:, g0:g1]
        diam = math.hypot(float(xs[imax] - xs[imin]), float(ys[imax] - ys[imin]))
        vrot = 0.5 * (vmax - vmin)
        # The outbound peak must sit clockwise of the inbound for a cyclone in
        # the north (anticlockwise in the south).
        if hemi * (imax[0] - imin[0]) < 0 or diam > FEAT_MAX_DIAM_KM or vrot < FEAT_MIN_VROT:
            continue
        rng = math.hypot(cx, cy)
        j = int(np.clip(np.searchsorted(sw.r_km, _slant_from_ground(rng, sw.elev)), 0, sw.r_km.size - 1))
        sh = float(np.nanmax(np.where(sub, vf.shear[r0:r1, c0:c1], np.nan)))
        out.append({
            "tilt": tilt_index, "elev": round(sw.elev, 2), "x": cx, "y": cy, "rangeKm": rng,
            "heightKm": float(vf.h[j]), "nrot": float(peak[k]), "shear": sh,
            "vrot": vrot, "vin": vmin, "vout": vmax, "diamKm": diam, "gates": int(sizes[k]),
            "rank": rank_2d(vrot), "unix": sw.unix,
        })
    return out


def _slant_from_ground(s_km: float, elev_deg: float) -> float:
    """Slant range of the beam at ground distance s (inverse of ground_km)."""
    th = math.radians(elev_deg)
    phi = s_km / RE_EFF_KM
    # Law of sines in the triangle earth-centre / antenna / gate.
    return RE_EFF_KM * math.sin(phi) / max(math.cos(th + phi), 1e-6)


def associate(feats_by_tilt: list[list[dict]], heights_offset_km: float = 0.0) -> list[dict]:
    """Join 2D features tilt to tilt into 3D detections (lowest tilt first).
    A feature joins the chain whose last feature is on the tilt just below
    within ASSOC_KM, or two below within ASSOC_GAP_KM: the nearest one, each
    chain taking one feature per tilt, the strongest features choosing first."""
    chains: list[list[dict]] = []
    for t, feats in enumerate(feats_by_tilt):
        taken: set[int] = set()
        for f in sorted(feats, key=lambda q: -q["nrot"]):
            best, best_d = None, None
            for ci, ch in enumerate(chains):
                if ci in taken:
                    continue
                last = ch[-1]
                gap = t - last["tilt"]
                if gap < 1 or gap > 2:
                    continue
                d = math.hypot(f["x"] - last["x"], f["y"] - last["y"])
                if d <= (ASSOC_KM if gap == 1 else ASSOC_GAP_KM) and (best_d is None or d < best_d):
                    best, best_d = ci, d
            if best is None:
                chains.append([f])
                taken.add(len(chains) - 1)
            else:
                chains[best].append(f)
                taken.add(best)
    out = []
    for ch, parts in merge_chains([ch for ch in chains if len(ch) >= 2]):
        det = _detection(ch, heights_offset_km)
        det["parts"] = parts
        out.append(det)
    out.sort(key=lambda d: (-d["rank"], -d["maxNrot"]))
    return out


def merge_chains(chains: list[list[dict]]) -> list[tuple[list[dict], int]]:
    """Join columns that are one circulation (see MERGE_KM): each pair of at
    least MERGE_MIN_RANK with features on the same or adjacent tilts within
    MERGE_KM, transitively. On a tilt both carry, the stronger feature stays.
    Returns (chain, how many columns it was made of)."""
    n = len(chains)
    parent = list(range(n))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    strong = [i for i in range(n) if rank_3d([f["rank"] for f in chains[i]]) >= MERGE_MIN_RANK]
    for a_i, a in enumerate(strong):
        for b in strong[a_i + 1:]:
            if root(a) == root(b):
                continue
            if any(abs(fa["tilt"] - fb["tilt"]) <= 1
                   and math.hypot(fa["x"] - fb["x"], fa["y"] - fb["y"]) <= MERGE_KM
                   for fa in chains[a] for fb in chains[b]):
                parent[root(b)] = root(a)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(root(i), []).append(i)
    out = []
    for members in groups.values():
        if len(members) == 1:
            out.append((chains[members[0]], 1))
            continue
        per_tilt: dict[int, dict] = {}
        for i in members:
            for f in chains[i]:
                cur = per_tilt.get(f["tilt"])
                if cur is None or f["vrot"] > cur["vrot"]:
                    per_tilt[f["tilt"]] = f
        out.append(([per_tilt[t] for t in sorted(per_tilt)], len(members)))
    return out


def rank_3d(ranks: list[int]) -> int:
    """The largest rank reached by at least min(3, n) of the features: one
    noisy tilt does not make a strong detection, a column does."""
    need = min(3, len(ranks))
    srt = sorted(ranks, reverse=True)
    return int(srt[need - 1]) if srt else 0


def strength_label(rank: int) -> str:
    if rank >= 13:
        return "Intense"
    if rank >= 9:
        return "Strong"
    if rank >= 5:
        return "Moderate"
    return "Weak"


def _detection(ch: list[dict], h_off: float) -> dict:
    base = min(f["heightKm"] for f in ch) + h_off
    top = max(f["heightKm"] for f in ch) + h_off
    low = [f for f in ch if f["heightKm"] + h_off <= base + 3.0] or ch[:1]
    rank = rank_3d([f["rank"] for f in ch])
    depth = top - base
    meso = rank >= 5 and depth >= 3.0 and len(ch) >= 3
    first = ch[0]
    strongest = max(ch, key=lambda f: f["vrot"])
    return {
        "x": first["x"], "y": first["y"],
        "baseKm": round(base, 2), "topKm": round(top, 2), "depthKm": round(depth, 2),
        "nTilts": len(ch), "rank": rank, "strength": strength_label(rank),
        "kind": "meso" if meso else "circulation",
        "maxVrotKt": round(strongest["vrot"] * MS_TO_KT, 1),
        "maxVrotHeightKm": round(strongest["heightKm"] + h_off, 2),
        "lowVrotKt": round(max(f["vrot"] for f in low) * MS_TO_KT, 1),
        "maxDvKt": round(max(f["vout"] - f["vin"] for f in ch) * MS_TO_KT, 1),
        "maxShear": round(max(f["shear"] for f in ch), 5),
        "maxNrot": round(max(f["nrot"] for f in ch), 2),
        "lowNrot": round(max(f["nrot"] for f in low), 2),
        "diamKm": round(float(np.median([f["diamKm"] for f in ch])), 2),
        "rangeKm": round(first["rangeKm"], 1),
        "features": [{
            "elev": f["elev"], "x": f["x"], "y": f["y"], "heightKm": round(f["heightKm"] + h_off, 2),
            "vrotKt": round(f["vrot"] * MS_TO_KT, 1), "dvKt": round((f["vout"] - f["vin"]) * MS_TO_KT, 1),
            "shear": round(f["shear"], 5), "nrot": round(f["nrot"], 2), "diamKm": round(f["diamKm"], 2),
            "rank": f["rank"],
        } for f in ch],
    }


# ---------------------------------------------------------------------------
# 4. Couplets
# ---------------------------------------------------------------------------
def _median3(v: np.ndarray) -> np.ndarray:
    """The median of each gate and its two neighbours along the radial,
    ignoring missing ones (np.nanmedian, without its cost on a whole sweep)."""
    vs = np.stack([np.roll(v, s, axis=1) for s in (-1, 0, 1)])
    fin = np.isfinite(vs)
    n = fin.sum(axis=0)
    srt = np.sort(np.where(fin, vs, np.inf), axis=0)
    with np.errstate(invalid="ignore"):
        two = 0.5 * (srt[0] + srt[1])
    out = np.where(n == 3, srt[1], np.where(n == 2, two, np.where(n == 1, srt[0], np.nan)))
    return out.astype(np.float32)


def couplets_in(vf: VelField, hemi: int) -> list[dict]:
    """The strongest cyclonic gate-to-gate differences of one tilt: for each
    gate, the outbound up to COUPLET_MAX_GAP_KM clockwise of it (a gate of
    range either way) minus it. Local maxima above COUPLET_MIN_MS."""
    sw = vf.sw
    # A 3-gate median along the radial takes out single-gate spikes without
    # touching the shear across the radials.
    v = vf.v
    vm = _median3(v)
    vm[:, 0] = v[:, 0]
    vm[:, -1] = v[:, -1]
    vm[~np.isfinite(v)] = np.nan
    if vf.ref is not None:
        vm = np.where(np.nan_to_num(vf.ref, nan=-99.0) >= FEAT_MIN_DBZ, vm, np.nan)
    dth = math.radians(sw.d_az)
    best = np.full(v.shape, -np.inf, dtype=np.float32)
    bk = np.zeros(v.shape, dtype=np.int8)
    bg = np.zeros(v.shape, dtype=np.int8)
    for k in range(1, 6):
        arc_ok = (k * dth * sw.r_km <= COUPLET_MAX_GAP_KM)
        if not arc_ok.any():
            break
        rolled = np.roll(vm, -hemi * k, axis=0)
        for dg in (-1, 0, 1):
            other = np.roll(rolled, -dg, axis=1)
            dv = other - vm
            dv[:, ~arc_ok] = -np.inf
            dv = np.where(np.isfinite(dv), dv, -np.inf)
            upd = dv > best
            best = np.where(upd, dv, best)
            bk = np.where(upd, np.int8(k), bk)
            bg = np.where(upd, np.int8(dg), bg)
    rr = sw.r_km[None, :]
    mask = (best >= COUPLET_MIN_MS) & (rr >= MIN_RANGE_KM + 2) & (rr <= MAX_RANGE_KM)
    if not mask.any():
        return []
    lab, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    out = []
    nrays, ngates = v.shape
    for k, slc in enumerate(ndimage.find_objects(lab)):
        if slc is None:
            continue
        sub = np.where(lab[slc] == k + 1, best[slc], -np.inf)
        i, j = np.unravel_index(int(np.argmax(sub)), sub.shape)
        i += slc[0].start
        j += slc[1].start
        kk, dg = int(bk[i, j]), int(bg[i, j])
        io, jo = (i + hemi * kk) % nrays, min(max(j + dg, 0), ngates - 1)
        vin, vout = float(vm[i, j]), float(vm[io, jo])
        xm = 0.5 * (float(vf.x[i, j]) + float(vf.x[io, jo]))
        ym = 0.5 * (float(vf.y[i, j]) + float(vf.y[io, jo]))
        gap = math.hypot(float(vf.x[io, jo] - vf.x[i, j]), float(vf.y[io, jo] - vf.y[i, j]))
        # Shear has to agree: a fold left in by the unfolding gives a huge
        # difference across two gates and nothing over the window around them.
        nr = vf.nrot[[i, io], :][:, max(0, j - 1):j + 2]
        nrot = float(np.nanmax(nr)) if np.isfinite(nr).any() else float("nan")
        if not (nrot >= 0.8):
            continue
        # The strongest echo around the couplet (both gates), for the
        # one-tilt checks in merge_couplets.
        echo = None
        if vf.ref is not None:
            wa, wg = COUPLET_ECHO_WIN
            rows = [(r % nrays) for r in range(min(i, io) - wa, max(i, io) + wa + 1)]
            blk = vf.ref[rows, max(0, min(j, jo) - wg):max(j, jo) + wg + 1]
            if np.isfinite(blk).any():
                echo = float(np.nanmax(blk))
        out.append({
            "elev": round(sw.elev, 2), "x": xm, "y": ym, "rangeKm": math.hypot(xm, ym),
            "heightKm": float(vf.h[j]), "dv": float(best[i, j]), "vin": vin, "vout": vout,
            "gapKm": gap, "radials": kk, "nrot": nrot, "unix": sw.unix,
            "echoDbz": echo, "nyq": float(sw.nyq) if sw.nyq else None,
        })
    # Within a tilt, the strongest within COUPLET_SUPPRESS_KM stands for the rest.
    out.sort(key=lambda c: -c["dv"])
    kept: list[dict] = []
    for c in out:
        if all(math.hypot(c["x"] - q["x"], c["y"] - q["y"]) > COUPLET_SUPPRESS_KM for q in kept):
            kept.append(c)
    return kept


def couplet_doubt(c: dict) -> Optional[str]:
    """Why a couplet is not believed, or None. It must sit in real echo: a
    50-66 kt "TVS" on two tilts in clear-air returns (KTLX 2026-10-26 17:20,
    20 km out, 0.4 km up) was birds and clutter. Seen on ONE tilt it must also
    need no unfolding; on two or more the column vouches for that (Moore's
    unfolded 70 kt inbound is past its Nyquist, and real)."""
    echo = c.get("echoDbz")
    if echo is not None and echo < COUPLET_ECHO_DBZ:
        return "outside the echo" if len(c["tilts"]) >= 2 else "one tilt, outside the echo"
    if len(c["tilts"]) >= 2:
        return None
    nyq = c.get("nyq")
    if nyq and max(abs(c["vin"]), abs(c["vout"])) > float(nyq) + 0.5:
        return "one tilt, past the Nyquist velocity"
    return None


def couplet_class(dv_kt: float) -> str:
    if dv_kt >= 90:
        return "Intense"
    if dv_kt >= 70:
        return "Strong"
    if dv_kt >= 50:
        return "Moderate"
    return "Weak"


def tvs_class(c: dict, low_elev: Optional[float]) -> Optional[str]:
    """"TVS", "ETVS" or None for a merged couplet (see TVS_*)."""
    if (not c["straddles"] or c["dvKt"] < TVS_MIN_DV_KT or len(c["tilts"]) < TVS_MIN_TILTS
            or c["rangeKm"] > TVS_MAX_RANGE_KM):
        return None
    on_lowest = low_elev is None or min(c["tilts"]) <= low_elev + 0.05
    return "TVS" if on_lowest else "ETVS"


def merge_couplets(per_tilt: list[list[dict]], h_off: float, low_elev: Optional[float] = None) -> list[dict]:
    """One entry per place, seen on one or more of the low tilts. `low_elev`
    is the volume's lowest velocity tilt (a TVS starts there)."""
    flat = sorted((c for cs in per_tilt for c in cs), key=lambda c: -c["dv"])
    groups: list[list[dict]] = []
    for c in flat:
        home = next((g for g in groups
                     if math.hypot(c["x"] - g[0]["x"], c["y"] - g[0]["y"]) <= COUPLET_SUPPRESS_KM), None)
        if home is None:
            groups.append([c])
        elif all(q["elev"] != c["elev"] for q in home):
            home.append(c)
    out = []
    for g in groups:
        top = g[0]
        dv_kt = top["dv"] * MS_TO_KT
        if dv_kt < 40.0:
            continue
        out.append({
            "x": top["x"], "y": top["y"], "elev": top["elev"], "heightKm": round(top["heightKm"] + h_off, 2),
            "rangeKm": round(top["rangeKm"], 1), "dvKt": round(dv_kt, 1), "vrotKt": round(dv_kt / 2.0, 1),
            "vinKt": round(top["vin"] * MS_TO_KT, 1), "voutKt": round(top["vout"] * MS_TO_KT, 1),
            "gapKm": round(top["gapKm"], 2), "gateToGate": top["radials"] <= 1,
            "straddles": top["vin"] < 0.0 < top["vout"],
            "nrot": round(top["nrot"], 2), "tilts": sorted({q["elev"] for q in g}),
            "baseKm": round(min(q["heightKm"] for q in g) + h_off, 2),
            "class": couplet_class(dv_kt),
        })
        doubt = couplet_doubt({"tilts": out[-1]["tilts"], "vin": top["vin"], "vout": top["vout"],
                               "nyq": top.get("nyq"), "echoDbz": top.get("echoDbz")})
        out[-1]["suspect"] = doubt
        out[-1]["echoDbz"] = round(top["echoDbz"], 1) if top.get("echoDbz") is not None else None
        if doubt:
            # Never "Intense" -- nor a TVS -- on the strength of doubtful data.
            out[-1]["class"] = "Unconfirmed"
        out[-1]["tvs"] = None if doubt else tvs_class(out[-1], low_elev)
    # Believable couplets rank first; the doubtful ones after, strongest first.
    out.sort(key=lambda c: (bool(c["suspect"]), -c["dvKt"]))
    for i, c in enumerate(out):
        c["rank"] = i + 1
    return out[:25]


# ---------------------------------------------------------------------------
# 5. Tornado debris
# ---------------------------------------------------------------------------
def debris_in(sw: Sweep) -> list[dict]:
    ref, cc, zdr = sw.data.get("REF"), sw.data.get("RHO"), sw.data.get("ZDR")
    if ref is None or cc is None or zdr is None:
        return []
    ng = min(ref.shape[1], cc.shape[1], zdr.shape[1])
    ref, cc, zdr = ref[:, :ng], cc[:, :ng], zdr[:, :ng]
    r = sw.r_km[:ng]
    with np.errstate(invalid="ignore"):
        mask = (ref >= TDS_MIN_DBZ) & (cc <= TDS_MAX_CC) & (cc > 0.0) & (zdr <= TDS_MAX_ZDR) & (zdr >= TDS_MIN_ZDR)
    mask &= (r[None, :] >= MIN_RANGE_KM + 4) & (r[None, :] <= 200.0)
    if not mask.any():
        return []
    lab, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    s = ground_km(r.astype(np.float64), sw.elev)
    h = beam_height_km(r.astype(np.float64), sw.elev)
    a = np.radians(sw.az.astype(np.float64))
    out = []
    for k, slc in enumerate(ndimage.find_objects(lab)):
        if slc is None:
            continue
        sub = lab[slc] == k + 1
        cnt = int(sub.sum())
        if cnt < TDS_MIN_GATES:
            continue
        ii, jj = np.nonzero(sub)
        ii = ii + slc[0].start
        jj = jj + slc[1].start
        xs = np.sin(a[ii]) * s[jj]
        ys = np.cos(a[ii]) * s[jj]
        refs = ref[ii, jj]
        w = np.maximum(refs - TDS_MIN_DBZ + 1.0, 1.0)
        out.append({
            "elev": round(sw.elev, 2), "x": float((xs * w).sum() / w.sum()), "y": float((ys * w).sum() / w.sum()),
            "heightKm": float(np.mean(h[jj])), "maxDbz": float(np.max(refs)), "minCc": float(np.min(cc[ii, jj])),
            "zdr": float(np.median(zdr[ii, jj])), "gates": cnt,
            "areaKm2": float(np.sum(s[jj] * math.radians(sw.d_az) * sw.dr)),
        })
    return out


def debris_rotation(couplets: list[dict], mesos: list[dict]) -> list[dict]:
    """The rotation a debris signature may sit beside: a TVS (a straddling
    couplet of TVS strength on two or more low tilts, not one the one-tilt
    checks doubt) or a mesocyclone (3+ tilts, 3 km deep) whose lowest part is
    that strong. Two inbounds of different speed are shear, not a vortex; and
    33-50 kt circulations and one-tilt couplets beside low CC were hail and
    clutter (KTLX 2013-05-20 20:16-20:29, KAMA 2026-10-26 16:32)."""
    rot = [dict(c, kind="couplet") for c in couplets
           if c.get("tvs") and c["straddles"] and c["dvKt"] >= TDS_MIN_ROT_KT and not c.get("suspect")
           and len(c["tilts"]) >= TDS_ROT_MIN_TILTS]
    for i, m in enumerate(mesos):
        if (m["kind"] == "meso" and m["nTilts"] >= TDS_ROT_MIN_TILTS
                and m["features"][0]["dvKt"] >= TDS_MIN_ROT_KT):
            f0 = m["features"][0]
            rot.append({"x": f0["x"], "y": f0["y"], "kind": "meso", "index": i, "dvKt": f0["dvKt"]})
    return rot


def merge_debris(per_tilt: list[list[dict]], rot: list[dict], h_off: float,
                 low_elevs: Optional[list[float]] = None) -> list[dict]:
    """Debris patches beside rotation. A signature grows from a seed: a patch
    within TDS_ROT_KM of rotation on one of the two lowest tilts (the
    strongest rotation's first, then the lowest and nearest patch). Patches on
    any tilt join it patch to patch within TDS_JOIN_KM -- debris lofted up the
    column and a ragged patch split in two are still one tornado -- but never
    further than TDS_GROUP_KM from the seed: unbounded, the chain walked 7.7 km
    into the inflow's low-CC speckle at KTLX 2013-05-20 19:59 and put the
    marker there. The marker is the lowest tilt's centre near the seed when
    that is still beside rotation, else the seed, and its distance to the
    rotation is its own. A signature seen on one tilt only has to be more than
    a few gates, and every signature needs a core of TDS_MIN_PEAK_DBZ (weak
    echo's correlation drops with its signal, not with debris)."""
    def near_rot(p: dict) -> Optional[tuple[dict, float]]:
        best, bd = None, None
        for q in rot:
            d = math.hypot(p["x"] - q["x"], p["y"] - q["y"])
            if d <= TDS_ROT_KM and (bd is None or d < bd):
                best, bd = q, d
        return (best, bd) if best is not None else None

    patches = [p for ps in per_tilt for p in ps]
    # Debris is lofted from the ground: a signature starts on one of the two
    # lowest tilts. Patches seen only higher up beside weak shear (KTLX
    # 2013-05-20 20:25 at 2.4-3.1 deg, 13-20 km out) are hail or fallout.
    low_cut = (max(low_elevs[:2]) + 0.05) if low_elevs else None
    seeds = []
    for i, p in enumerate(patches):
        if low_cut is not None and p["elev"] > low_cut:
            continue
        hit = near_rot(p)
        if hit is not None:
            seeds.append((-float(hit[0].get("dvKt", 0.0)), p["elev"], hit[1], i))
    # The strongest rotation's patches first, the lowest and nearest of them.
    seeds.sort()
    used: set[int] = set()
    out = []
    for *_k, si in seeds:
        if si in used:
            continue
        seed = patches[si]
        # Grown patch to patch (a debris ball is ragged), but never further
        # than TDS_GROUP_KM from the seed.
        members = [si]
        grew = True
        while grew:
            grew = False
            for i, p in enumerate(patches):
                if i in used or i in members or                         math.hypot(p["x"] - seed["x"], p["y"] - seed["y"]) > TDS_GROUP_KM:
                    continue
                if any(math.hypot(p["x"] - patches[m]["x"], p["y"] - patches[m]["y"]) <= TDS_JOIN_KM
                       for m in members):
                    members.append(i)
                    grew = True
        g = [patches[i] for i in members]
        tilts = sorted({p["elev"] for p in g})
        gates = int(sum(p["gates"] for p in g))
        area = sum(p["areaKm2"] for p in g)
        if len(tilts) < 2 and (gates < TDS_MIN_ALONE or area < TDS_MIN_AREA_ALONE):
            continue
        # Near the radar the lowest beam runs through the ground clutter.
        if len(tilts) < 2 and math.hypot(seed["x"], seed["y"]) < TDS_NEAR_KM:
            continue
        if min(p["heightKm"] for p in g) + h_off > TDS_MAX_BASE_KM:
            continue
        maxp = max(g, key=lambda p: p["maxDbz"])
        if maxp["maxDbz"] < TDS_MIN_PEAK_DBZ:
            continue
        used.update(members)
        # The marker: the gate-weighted centre of the lowest tilt's patches
        # near the seed when that is still beside rotation, else the seed.
        # Its distance to the rotation is always its own.
        low = [p for p in g if p["elev"] == tilts[0]
               and math.hypot(p["x"] - seed["x"], p["y"] - seed["y"]) <= TDS_JOIN_KM] or [seed]
        w = np.array([p["gates"] for p in low], dtype=np.float64)
        cx = float(np.dot(w, [p["x"] for p in low]) / w.sum())
        cy = float(np.dot(w, [p["y"] for p in low]) / w.sum())
        hit = near_rot({"x": cx, "y": cy}) or near_rot(seed)
        if hit is None:
            continue
        q, dq = hit
        x, y = (cx, cy) if near_rot({"x": cx, "y": cy}) else (float(seed["x"]), float(seed["y"]))
        # The edge of a debris field already marked beside stronger rotation
        # (KTLX 2013-05-20 20:25: a patch 4.7 km from the 107 kt TVS beside a
        # 54 kt couplet) is that signature, not a second tornado.
        if any(math.hypot(x - o["x"], y - o["y"]) <= TDS_GROUP_KM for o in out):
            continue
        out.append({
            "x": x, "y": y, "elev": tilts[0],
            "baseKm": round(min(p["heightKm"] for p in g) + h_off, 2),
            "topKm": round(max(p["heightKm"] for p in g) + h_off, 2),
            "maxDbz": round(maxp["maxDbz"], 1), "minCc": round(min(p["minCc"] for p in g), 3),
            "zdr": round(float(np.median([p["zdr"] for p in g])), 2),
            "gates": gates, "areaKm2": round(sum(p["areaKm2"] for p in g), 2),
            "tilts": tilts, "rangeKm": round(math.hypot(x, y), 1),
            "rotKm": round(dq, 2), "rotDvKt": round(q.get("dvKt", 0.0), 1), "_rot": q,
        })
    out.sort(key=lambda t: (-len(t["tilts"]), -t["maxDbz"]))
    return out


# ---------------------------------------------------------------------------
# 6. Hook echo
# ---------------------------------------------------------------------------
HOOK_GRID_KM = 0.5
HOOK_RADIUS_KM = 22.0
HOOK_DBZ = 30.0


def _cart(sw: Sweep, cx: float, cy: float) -> Optional[np.ndarray]:
    """The sweep's reflectivity on a 0.5 km grid around (cx, cy), nearest gate."""
    ref = sw.data.get("REF")
    if ref is None:
        return None
    n = int(2 * HOOK_RADIUS_KM / HOOK_GRID_KM) + 1
    gx = cx + (np.arange(n) - n // 2) * HOOK_GRID_KM
    gy = cy + (np.arange(n) - n // 2) * HOOK_GRID_KM
    X, Y = np.meshgrid(gx, gy[::-1])
    s = np.hypot(X, Y)
    az = np.degrees(np.arctan2(X, Y)) % 360.0
    # Ground distance -> slant range (near enough at low tilts: the slant
    # range exceeds the ground distance by a few metres there).
    r = np.vectorize(lambda q: _slant_from_ground(float(q), sw.elev))(s) if sw.elev > 3 else s
    i = np.searchsorted(sw.az, az) % sw.az.size
    i0 = (i - 1) % sw.az.size
    d1 = np.abs(((sw.az[i] - az) + 180) % 360 - 180)
    d0 = np.abs(((sw.az[i0] - az) + 180) % 360 - 180)
    ii = np.where(d1 < d0, i, i0)
    jj = np.rint((r - sw.r_km[0]) / sw.dr).astype(int)
    okj = (jj >= 0) & (jj < ref.shape[1])
    out = np.full(X.shape, np.nan, dtype=np.float32)
    out[okj] = ref[ii[okj], jj[okj]]
    return out


def _hook(sw: Sweep, cx: float, cy: float) -> Optional[dict]:
    """Does the circulation at (cx, cy) sit at the tip of a hook?

    On a 0.5 km grid around it, the >= 30 dBZ echo it touches must hold a
    thick core (somewhere >= 3 km from any edge) and the circulation must be
    out on a thin part of it (<= 1.5 km from an edge), well along the echo
    from that core: its distance through the echo to the core at least 5 km,
    and the circle of 3 km around it mostly not echo. A classic hook is a
    curl of rain round the mesocyclone's rear; a circulation in the middle of
    a core, or on the straight edge of a line, fails one of these."""
    g = _cart(sw, cx, cy)
    if g is None:
        return None
    m = np.nan_to_num(g, nan=-99.0) >= HOOK_DBZ
    m = ndimage.binary_opening(m, structure=np.ones((2, 2), dtype=bool))
    n = m.shape[0]
    c = n // 2
    if not m.any():
        return {"hook": False, "why": "no echo >= 30 dBZ around the circulation"}
    lab, _ = ndimage.label(m)
    # The echo the circulation touches: nearest within 2.5 km.
    dist_to = ndimage.distance_transform_edt(~m, return_indices=True)
    d0, (ri, ci) = dist_to[0], dist_to[1]
    if d0[c, c] * HOOK_GRID_KM > 2.5:
        return {"hook": False, "why": "circulation outside the echo"}
    pi, pj = int(ri[c, c]), int(ci[c, c])
    comp = lab == lab[pi, pj]
    edt = ndimage.distance_transform_edt(comp) * HOOK_GRID_KM
    core = comp & (edt >= 3.0)
    if not core.any():
        return {"hook": False, "why": "no thick core in the echo"}
    width = float(edt[pi, pj])
    # Distance through the echo from the core to the circulation.
    reach = core.copy()
    steps = 0
    limit = int(30.0 / HOOK_GRID_KM)
    while not reach[pi, pj] and steps < limit:
        grown = ndimage.binary_dilation(reach, structure=np.ones((3, 3), dtype=bool)) & comp
        if grown.sum() == reach.sum():
            break
        reach = grown
        steps += 1
    along = steps * HOOK_GRID_KM if reach[pi, pj] else float("inf")
    yy, xx = np.mgrid[0:n, 0:n]
    disc = (xx - c) ** 2 + (yy - c) ** 2 <= (3.0 / HOOK_GRID_KM) ** 2
    fill = float(m[disc].mean())
    hook = width <= 1.5 and 5.0 <= along <= 25.0 and fill <= 0.55
    return {"hook": bool(hook), "widthKm": round(width, 2), "alongKm": round(along, 2) if math.isfinite(along) else None,
            "echoFill": round(fill, 2)}


# ---------------------------------------------------------------------------
# The whole volume
# ---------------------------------------------------------------------------
def detect(tilts: list[Tilt], lat: float, lon: float, *, h_off_km: float = 0.0,
           ref_fields: Optional[dict[float, np.ndarray]] = None) -> dict:
    """Every detection in a volume's tilts (low to high). Positions come back
    as x/y km from the radar; `place` turns them into lat/lon."""
    hemi = 1 if lat >= 0 else -1
    tilts = sorted(tilts, key=lambda t: t.elev)
    feats_by_tilt: list[list[dict]] = []
    low_couplets: list[list[dict]] = []
    nyqs = []
    for ti, t in enumerate([t for t in tilts if t.vel is not None]):
        ref = ref_fields.get(round(t.elev, 2)) if ref_fields else None
        vf = vel_field(t.vel, hemi, ref)
        if vf is None:
            feats_by_tilt.append([])
            continue
        nyqs.append(t.vel.nyq)
        feats_by_tilt.append(features_2d(vf, len(feats_by_tilt), hemi))
        if t.elev <= COUPLET_MAX_ELEV and len(low_couplets) < 3:
            low_couplets.append(couplets_in(vf, hemi))
    mesos = associate(feats_by_tilt, h_off_km)
    low_elev = next((round(t.elev, 2) for t in tilts if t.vel is not None), None)
    couplets = merge_couplets(low_couplets, h_off_km, low_elev)

    debris: list[dict] = []
    dual = any(t.pol is not None and "RHO" in t.pol.data for t in tilts)
    if dual:
        per = [debris_in(t.pol) for t in tilts if t.pol is not None and t.elev <= TDS_MAX_ELEV]
        rot = debris_rotation(couplets, mesos)
        low_elevs = sorted(round(t.elev, 2) for t in tilts if t.pol is not None)[:2]
        debris = merge_debris(per, rot, h_off_km, low_elevs)

    # Hooks, at the lowest tilt carrying reflectivity, for each mesocyclone
    # and each strong couplet.
    low_ref = next((t.pol or t.vel for t in tilts if (t.pol or t.vel) is not None
                    and "REF" in (t.pol or t.vel).data), None)
    if low_ref is not None:
        for m in mesos:
            if m["kind"] == "meso":
                f0 = m["features"][0]
                m["hookEcho"] = _hook(low_ref, f0["x"], f0["y"])
        for c in couplets:
            if c["dvKt"] >= 50.0:
                c["hookEcho"] = _hook(low_ref, c["x"], c["y"])

    # Debris and couplets attach to the detections they sit in.
    for m in mesos:
        f0 = m["features"][0]
        m["tds"] = any(math.hypot(d["x"] - f0["x"], d["y"] - f0["y"]) <= TDS_ROT_KM + 1.0 for d in debris)
        near = [c for c in couplets if math.hypot(c["x"] - f0["x"], c["y"] - f0["y"]) <= 5.0]
        m["couplet"] = near[0]["rank"] if near else None
    for d in debris:
        d.pop("_rot", None)

    return {"mesos": mesos, "couplets": couplets, "tds": debris, "dualPol": dual,
            "tilts": [round(t.elev, 2) for t in tilts],
            "nyquistKt": sorted({round(n * MS_TO_KT, 1) for n in nyqs if n})}


def place(out: dict, lat: float, lon: float) -> dict:
    """x/y km from the radar -> lat/lon, everywhere in a detect() result."""
    def put(o: dict) -> None:
        if "x" in o and "y" in o:
            la, lo = _xy_to_ll(lat, lon, o["x"], o["y"])
            o["lat"], o["lon"] = round(la, 5), round(lo, 5)
            o["azDeg"] = round(math.degrees(math.atan2(o["x"], o["y"])) % 360.0, 1)
            o["x"], o["y"] = round(o["x"], 3), round(o["y"], 3)

    for m in out["mesos"]:
        put(m)
        for f in m["features"]:
            put(f)
    for c in out["couplets"]:
        put(c)
    for d in out["tds"]:
        put(d)
    return out


# ---------------------------------------------------------------------------
# Volumes: NEXRAD Level II and the Brazilian store
# ---------------------------------------------------------------------------
_MOMENTS = {b"REF": "REF", b"VEL": "VEL", b"SW": "SW", b"RHO": "RHO", b"ZDR": "ZDR"}


def _gates_within(first: float, width: float, ngates: int) -> int:
    return int(max(1, min(ngates, math.ceil((MAX_RANGE_KM - first) / width) + 1)))


def _sweep_from_metpy(f: Any, idx: int, want: tuple[bytes, ...], elev: float) -> Optional[Sweep]:
    import nexrad_level2 as l2
    radials = sorted(f.sweeps[idx], key=lambda r: float(r[0].az_angle))
    if not radials:
        return None
    m0 = l2._moments(radials[0])
    have = [w for w in want if w in m0]
    if not have:
        return None
    h0 = m0[have[0]][0]
    first, width = float(h0.first_gate), float(h0.gate_width)
    ng = _gates_within(first, width, max(int(m0[w][0].num_gates) for w in have))
    az = np.array([float(r[0].az_angle) for r in radials], dtype=np.float64)
    data = {}
    for w in have:
        arr = np.full((len(radials), ng), np.nan, dtype=np.float32)
        for k, r in enumerate(radials):
            blk = l2._moments(r).get(w)
            if blk is None:
                continue
            d = np.asarray(blk[1], dtype=np.float32)
            m = min(d.size, ng)
            arr[k, :m] = d[:m]
        data[_MOMENTS[w]] = arr
    hdr = radials[0]
    nyq = None
    if len(hdr) > 4 and hdr[3] is not None:
        nyq = float(getattr(hdr[3], "nyq_vel", 0.0) or 0.0) or None
    else:
        nyq = float(getattr(hdr[0], "nyq_vel", 0.0) or 0.0) or None
    try:
        unix = (int(hdr[0].date) - 1) * 86400 + float(hdr[0].time_ms) / 1000.0
    except Exception:  # noqa: BLE001
        unix = None
    return Sweep(elev=elev, az=az, r_km=first + np.arange(ng, dtype=np.float32) * width, data=data, nyq=nyq, unix=unix)


def _sweep_fast(buf: bytes, sw: dict, want: tuple[bytes, ...], elev: float) -> Optional[Sweep]:
    """_sweep_from_metpy for a sweep of level2_fast.read_sweeps."""
    import level2_fast as lf
    geo = {w: lf.sweep_gates(buf, sw, w) for w in want}
    have = [w for w in want if geo[w] is not None]
    if not have:
        return None
    first, width = geo[have[0]][0], geo[have[0]][1]
    ng = _gates_within(first, width, max(geo[w][2] for w in have))
    data = {}
    az = None
    for w in have:
        az, arr = lf.sweep_values(buf, sw, w, ng)
        data[_MOMENTS[w]] = arr
    return Sweep(elev=elev, az=az, r_km=first + np.arange(ng, dtype=np.float32) * width, data=data,
                 nyq=sw["nyq"], unix=sw["unix"])


def _tilts_fast(buf: bytes, fast: dict) -> tuple[list[Tilt], dict]:
    """nexrad_tilts' choice of sweeps, on level2_fast.read_sweeps."""
    import level2_fast as lf
    sws = fast["sweeps"]
    vel_at: dict[float, int] = {}
    pol_at: dict[float, tuple[int, int]] = {}
    ref_at: dict[float, tuple[int, int]] = {}
    for i, sw in enumerate(sws):
        angle = round(sw["elev"], 1)
        if angle > 180.0:
            angle = round(angle - 360.0, 1)
        ms = sw["ptr"][0]
        if b"VEL" in ms and angle not in vel_at:
            vel_at[angle] = i
        for m, at in ((b"RHO", pol_at), (b"REF", ref_at)):
            if m in ms:
                g = lf.sweep_gates(buf, sw, m)
                g = g[2] if g else 0
                if angle not in at or g > at[angle][1]:
                    at[angle] = (i, g)
    tilts = []
    for angle in sorted(set(vel_at) | set(pol_at) | set(ref_at)):
        t = Tilt(elev=angle)
        if angle in vel_at:
            t.vel = _sweep_fast(buf, sws[vel_at[angle]], (b"VEL", b"SW", b"REF"), angle)
        if angle in pol_at:
            pi = pol_at[angle][0]
            if t.vel is not None and pi == vel_at.get(angle):
                extra = _sweep_fast(buf, sws[pi], (b"RHO", b"ZDR"), angle)
                if extra is not None:
                    t.vel.data.update(extra.data)
                t.pol = t.vel
            else:
                t.pol = _sweep_fast(buf, sws[pi], (b"REF", b"RHO", b"ZDR"), angle)
        elif angle in ref_at and t.vel is None:
            t.pol = _sweep_fast(buf, sws[ref_at[angle][0]], (b"REF",), angle)
        tilts.append(t)
    amsl, feed = float(fast["siteAmslM"] or 0.0), float(fast["feedhornM"] or 0.0)
    return tilts, {"lat": fast["lat"], "lon": fast["lon"], "vcp": fast["vcp"], "antennaKm": (amsl + feed) / 1000.0,
                   "feedKm": feed / 1000.0}


def nexrad_tilts(raw: bytes, site: str) -> tuple[list[Tilt], dict]:
    """A Level II volume's distinct tilts: the first sweep at each angle that
    carries velocity, and the one with the most range that carries
    correlation (the surveillance half of a split cut)."""
    import nexrad_level2 as l2
    import level2_fast
    from metpy.io import Level2File
    with l2._DECODE_SEM:
        # Straight from the bytes first (~0.3 s, MetPy's parse was 1.2-2.7 s);
        # a legacy or compressed volume goes through MetPy as before.
        buf = level2_fast.plain(raw)
        fast = level2_fast.read_sweeps(buf, tuple(_MOMENTS))
        if fast is not None:
            try:
                return _tilts_fast(buf, fast)
            except (ValueError, IndexError, KeyError, TypeError):
                pass
        f = Level2File(io.BytesIO(buf))
        vel_at: dict[float, int] = {}
        pol_at: dict[float, tuple[int, int]] = {}
        ref_at: dict[float, tuple[int, int]] = {}
        first = None
        for i, sw in enumerate(f.sweeps):
            if not sw:
                continue
            ms = l2._moments(sw[0])
            if first is None:
                first = sw[0]
            angle = round(l2._sweep_angle(f, sw), 1)
            if angle > 180.0:
                # A negative cut (mountain-top radars, KMAX's -0.2) comes out
                # of the scan strategy as 359.8: it is the lowest, not the top.
                angle = round(angle - 360.0, 1)
            if b"VEL" in ms and angle not in vel_at:
                vel_at[angle] = i
            if b"RHO" in ms:
                g = int(ms[b"RHO"][0].num_gates)
                if angle not in pol_at or g > pol_at[angle][1]:
                    pol_at[angle] = (i, g)
            if b"REF" in ms:
                g = int(ms[b"REF"][0].num_gates)
                if angle not in ref_at or g > ref_at[angle][1]:
                    ref_at[angle] = (i, g)
        if first is None:
            raise RuntimeError("This volume holds no sweeps.")
        tilts = []
        for angle in sorted(set(vel_at) | set(pol_at) | set(ref_at)):
            t = Tilt(elev=angle)
            if angle in vel_at:
                t.vel = _sweep_from_metpy(f, vel_at[angle], (b"VEL", b"SW", b"REF"), angle)
            if angle in pol_at:
                pi = pol_at[angle][0]
                t.pol = t.vel if (t.vel is not None and pi == vel_at.get(angle)) else \
                    _sweep_from_metpy(f, pi, (b"REF", b"RHO", b"ZDR"), angle)
                if t.vel is not None and pi == vel_at.get(angle):
                    # The same sweep: give it the dual-pol moments too.
                    extra = _sweep_from_metpy(f, pi, (b"RHO", b"ZDR"), angle)
                    if extra is not None:
                        t.vel.data.update(extra.data)
                    t.pol = t.vel
            elif angle in ref_at and t.vel is None:
                t.pol = _sweep_from_metpy(f, ref_at[angle][0], (b"REF",), angle)
            tilts.append(t)
        lat, lon, vcp = l2._site_of(first, site)
        hdr = first[1] if len(first) > 4 else None
        amsl = float(getattr(hdr, "site_amsl", 0.0) or 0.0)
        feed = float(getattr(hdr, "feedhorn_agl", 0.0) or 0.0)
        del f
    return tilts, {"lat": lat, "lon": lon, "vcp": vcp, "antennaKm": (amsl + feed) / 1000.0,
                   "feedKm": feed / 1000.0}


def brazil_tilts(site: str, stamp: str) -> tuple[list[Tilt], dict, Optional[dict]]:
    """A kept Brazilian volume's tilts, and the model column for unfolding."""
    import brazil_radar as br
    vol = br.load(site, stamp)
    names = {"REF": ("DBZH", "TH"), "VEL": ("VRAD",), "SW": ("WRAD",), "RHO": ("RHOHV",), "ZDR": ("ZDR",)}
    by_elev: dict[float, Tilt] = {}
    for s in vol.sweeps:
        if s.nrays < 2:
            continue
        spacing = float(np.median(np.diff(s.az))) if s.nrays > 1 else 1.0
        centres = np.mod(s.az + 0.5 * spacing, 360.0)
        order = np.argsort(centres)
        nb = next(iter(s.data.values())).shape[1] if s.data else 0
        if nb == 0:
            continue
        r = s.r0_km + (np.arange(nb, dtype=np.float32) + 0.5) * s.dr_km
        keep = r <= MAX_RANGE_KM
        data = {}
        for k, alts in names.items():
            for a in alts:
                if a in s.data:
                    data[k] = np.asarray(s.data[a], dtype=np.float32)[order][:, keep]
                    break
        sw = Sweep(elev=float(s.elev), az=centres[order].astype(np.float64), r_km=r[keep], data=data,
                   nyq=s.nyquist, unix=float(s.unix) if s.unix else None)
        e = round(float(s.elev), 1)
        t = by_elev.setdefault(e, Tilt(elev=e))
        if "VEL" in data and t.vel is None:
            t.vel = sw
        if "RHO" in data and t.pol is None:
            t.pol = sw
        if t.pol is None and t.vel is None and "REF" in data:
            t.pol = sw
    env = None
    try:
        env = br.environment(vol.lat, vol.lon, vol.unix)
    except Exception:  # noqa: BLE001 - unfolded by the VAD instead
        env = None
    return sorted(by_elev.values(), key=lambda t: t.elev), {
        "lat": vol.lat, "lon": vol.lon, "vcp": None, "antennaKm": vol.alt_m / 1000.0, "feedKm": 0.02,
        "unix": vol.unix, "name": vol.name}, env


def _model_ref(sw: Sweep, env: Optional[dict], alt_m: float) -> Optional[np.ndarray]:
    """The radial velocity the model's wind would give at each gate (m/s)."""
    if not env or not env.get("wind"):
        return None
    zs = np.array([w[0] for w in env["wind"]])
    us = np.array([w[1] for w in env["wind"]])
    vs = np.array([w[2] for w in env["wind"]])
    h = beam_height_km(sw.r_km.astype(np.float64), sw.elev) * 1000.0 + alt_m
    u_h, v_h = np.interp(h, zs, us), np.interp(h, zs, vs)
    a = np.radians(sw.az)
    return ((np.sin(a)[:, None] * u_h[None, :] + np.cos(a)[:, None] * v_h[None, :])
            * math.cos(math.radians(sw.elev))).astype(np.float32)


# ---------------------------------------------------------------------------
# Cache, tracking, the request
# ---------------------------------------------------------------------------
_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_MAX = 96
_LOCK = threading.Lock()
_GATES: dict[tuple, threading.Lock] = {}
# One volume at a time: detection is a couple of seconds of CPU and the radar
# loop beside it must keep being served (downloads run outside it).
_RUN = threading.Semaphore(1)
_TRACK_IDS: dict[str, dict[tuple, int]] = {}
_TRACK_NEXT: dict[str, int] = {}
TRACK_MAX_DT_S = 20 * 60


def _track_id(site: str, root: tuple) -> int:
    ids = _TRACK_IDS.setdefault(site, {})
    if root not in ids:
        _TRACK_NEXT[site] = _TRACK_NEXT.get(site, 0) + 1
        ids[root] = _TRACK_NEXT[site]
        if len(ids) > 4000:
            ids.pop(next(iter(ids)))
    return ids[root]


def _previous(site: str, unix: float) -> Optional[dict]:
    """The kept result of this radar's volume just before, within 20 min."""
    with _LOCK:
        cands = [v for (s, _), v in _CACHE.items() if s == site and v["scanUnix"] is not None
                 and 0 < unix - v["scanUnix"] <= TRACK_MAX_DT_S]
    return max(cands, key=lambda v: v["scanUnix"]) if cands else None


def link_tracks(cur: list[dict], prev: Optional[list[dict]], dt_s: float) -> list[tuple[int, Optional[int]]]:
    """Match each current detection to one of the previous volume's: nearest
    to where the previous one was heading (its own motion carried forward, or
    where it was), within 5 km plus 1.2 km a minute. Strongest first."""
    out: list[tuple[int, Optional[int]]] = []
    if not prev:
        return [(i, None) for i in range(len(cur))]
    used: set[int] = set()
    lim = 5.0 + 1.2 * dt_s / 60.0
    for i in sorted(range(len(cur)), key=lambda k: -cur[k]["rank"]):
        c = cur[i]
        best, bd = None, None
        for j, p in enumerate(prev):
            if j in used:
                continue
            px, py = p["x"], p["y"]
            mo = p.get("_uv")
            if mo:
                px += mo[0] * dt_s / 1000.0
                py += mo[1] * dt_s / 1000.0
            d = math.hypot(c["x"] - px, c["y"] - py)
            if d <= lim and (bd is None or d < bd):
                best, bd = j, d
        if best is not None:
            used.add(best)
        out.append((i, best))
    out.sort()
    return out


def _apply_tracks(site: str, res: dict) -> None:
    """Track ids, motion and the trail behind each detection, from the
    detections of the volumes before (as far back as they are kept)."""
    prev = _previous(site, res["scanUnix"]) if res["scanUnix"] else None
    cur = res["mesos"]
    res["_prevUnix"] = prev["scanUnix"] if prev is not None else None
    if prev is None:
        for i, m in enumerate(cur):
            m["_root"] = (res["key"], i)
            m["trackId"] = _track_id(site, m["_root"])
            m["motion"] = None
            m["_uv"] = None
            m["track"] = []
        return
    dt = float(res["scanUnix"] - prev["scanUnix"])
    for i, j in link_tracks(cur, prev["mesos"], dt):
        m = cur[i]
        if j is None:
            m["_root"] = (res["key"], i)
            m["trackId"] = _track_id(site, m["_root"])
            m["motion"], m["_uv"], m["track"] = None, None, []
            continue
        p = prev["mesos"][j]
        m["_root"] = p["_root"]
        m["trackId"] = p["trackId"]
        u = (m["x"] - p["x"]) * 1000.0 / dt   # m/s east
        v = (m["y"] - p["y"]) * 1000.0 / dt
        if p.get("_uv"):
            # A little smoothing against the step before.
            u = 0.6 * u + 0.4 * p["_uv"][0]
            v = 0.6 * v + 0.4 * p["_uv"][1]
        m["_uv"] = (u, v)
        m["motion"] = {"speedKt": round(math.hypot(u, v) * MS_TO_KT, 1),
                       "toward": round(math.degrees(math.atan2(u, v)) % 360.0, 1)}
        trail = list(p.get("track") or [])
        trail.append({"lat": p["lat"], "lon": p["lon"], "unix": prev["scanUnix"], "rank": p["rank"]})
        m["track"] = trail[-12:]


def _public(res: dict) -> dict:
    """The result without the internals kept for tracking."""
    out = {k: v for k, v in res.items() if not k.startswith("_")}
    out["mesos"] = [{k: v for k, v in m.items() if not k.startswith("_")} for m in res["mesos"]]
    out["tracked"] = res.get("_prevUnix") is not None
    return out


def _relink(site: str, res: dict) -> None:
    """A kept result computed before the volume ahead of it was: link it now
    (cheap -- only the mesocyclone list is walked)."""
    if res.get("_prevUnix") is None and res.get("scanUnix") and _previous(site, res["scanUnix"]) is not None:
        _apply_tracks(site, res)


def _resolve(site: str, key: str, at: Optional[float]) -> tuple[str, Any, bool]:
    """(volume key, volume id, Brazilian?) of the volume to read."""
    import brazil_radar as br
    if br.is_br(site):
        stamp = key.split(":", 1)[1] if key.startswith("L2BR:") else br._newest_stamp(site.upper(), int(at) if at else None)
        if not stamp:
            raise ValueError(f"No volume kept for {site}")
        return f"L2BR:{stamp}", stamp, True
    import radar_xsect
    k = key if key.startswith(("L2:", "L2A:")) else ""
    vkey, vol = radar_xsect._volume_for(site, at, k)
    return vkey, vol, False


def detections(site: str, key: str = "", at: Optional[float] = None, trail: bool = False) -> dict:
    """The detections of the volume `key` names (a Level II or Brazilian
    key), else the one nearest `at`, else the newest. Kept per volume.

    `trail`: when no volume just before this one is kept (the first frame
    asked for), read that one too, so the mesocyclones come back tracked --
    a track id, a motion and the point they came from. Costs a second volume,
    so a viewer asks plainly first and with `trail` after."""
    if trail:
        cur = detections(site, key, at)
        if not cur.get("tracked") and cur.get("scanUnix") and cur.get("mesos"):
            try:
                before = detections(site, "", float(cur["scanUnix"]) - 45.0)
            except Exception:  # noqa: BLE001 -- the trail is a nicety
                before = None
            if before is not None and before.get("key") == cur.get("key"):
                return cur
        return detections(site, cur["key"], None)
    import brazil_radar as br
    from nexrad_core import icao_for, site_id
    br_site = br.is_br(site)
    sid = site.upper() if br_site else site_id(site)
    vkey, vol, is_br = _resolve(sid, key, at)
    ck = (sid, vkey)
    with _LOCK:
        hit = _CACHE.get(ck)
        if hit is not None:
            _CACHE.move_to_end(ck)
    if hit is not None:
        _relink(sid, hit)
        return _public(hit)
    with _LOCK:
        gate = _GATES.setdefault(ck, threading.Lock())
    with gate:
        with _LOCK:
            hit = _CACHE.get(ck)
        if hit is not None:
            _relink(sid, hit)
            return _public(hit)
        t0 = time.time()
        # The download happens outside the one-at-a-time section: it is the
        # network, not the CPU, and a loop read ahead (useDetectionsStore)
        # fetches the next volumes while this one is detected.
        pre = None
        if not is_br:
            import radar_xsect
            pre = radar_xsect._raw(sid, vol)
        with _RUN:
            if is_br:
                tilts, meta, env = brazil_tilts(sid, vol)
                alt_m = meta["antennaKm"] * 1000.0
                refs = {}
                for t in tilts:
                    if t.vel is not None:
                        rf = _model_ref(t.vel, env, alt_m)
                        if rf is not None:
                            refs[round(t.elev, 2)] = rf
                scan_unix = meta.get("unix")
                label = sid[3:]
                t_load = time.time() - t0
                res = detect(tilts, meta["lat"], meta["lon"], h_off_km=meta["feedKm"], ref_fields=refs or None)
            else:
                import nexrad_level2 as l2
                raw, stamp = pre
                tilts, meta = nexrad_tilts(raw, sid)
                scan_unix = l2._stamp_unix(stamp)
                label = icao_for(sid)
                t_load = time.time() - t0
                res = detect(tilts, meta["lat"], meta["lon"], h_off_km=meta["feedKm"])
        place(res, meta["lat"], meta["lon"])
        res.update({
            "site": label, "siteId": sid, "siteLat": meta["lat"], "siteLon": meta["lon"], "key": vkey,
            "scanUnix": scan_unix, "vcp": meta.get("vcp"), "heightRef": "ARL",
            "ms": round((time.time() - t0) * 1000), "loadMs": round(t_load * 1000),
        })
        _apply_tracks(sid, res)
        with _LOCK:
            _CACHE[ck] = res
            while len(_CACHE) > _CACHE_MAX:
                _CACHE.popitem(last=False)
            _GATES.pop(ck, None)
        return _public(res)
