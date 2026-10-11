"""
Severe-weather parameters worked out from an analysis's own profiles, the way
SPC's mesoanalysis works them out.

The RAP files carry some of these ready-made, but not all of them, and not the
same ones in every year: the RUC (2005-2012) has no mixed-layer CAPE, no 0-6 km
shear, no storm motion, no 0-3 km helicity. Every year has the same profile,
though -- height, temperature, humidity and wind on 37 levels 25 mb apart, from
1000 to 100 mb -- with the surface under it. So everything here is made from
that, the same way for 2005 as for today, and a parameter means the same thing
on every date the archive opens on.

Everything works column by column on flat arrays (one value per grid point,
levels down the first axis), in SI units: K, m, m/s, hPa for pressure.

The level 0 of every profile is the surface (2 m temperature and dew point,
10 m wind, at the surface pressure and height). A pressure level below ground
is given the surface's values, so it is a layer of no depth that adds nothing
to any sum or integral, and the arrays stay rectangular.

Parcels follow Bolton (1980): the LCL from the dew point depression, the dry
adiabat below it, and above it the pseudo-adiabat of the parcel's equivalent
potential temperature, read from a table made once per level. Buoyancy uses
virtual temperature (Doswell and Rasmussen 1994).

Parcels, as SPC defines them:
  SB   from the surface
  ML   the mean potential temperature and mixing ratio of the lowest 100 mb,
       lifted from the surface
  MU   the level of highest theta-e in the lowest 300 mb
The effective inflow layer (Thompson et al. 2007) is the first run of levels,
from the ground up, whose parcels have CAPE >= 100 J/kg and CIN >= -250 J/kg.
Storm motion is Bunkers et al. (2000), right-moving.
"""
from __future__ import annotations

import numpy as np

G = 9.80665
KAPPA = 0.2854          # Rd/cp, Bolton's value
EPS = 0.622
LEVELS = tuple(range(1000, 99, -25))   # 1000, 975, ... 100 mb
# Single precision: a tenth of a joule of CAPE is far below anything drawn,
# and the grid's columns go through twice as fast.
_F = np.float32

_T_TABLE = np.arange(170.0, 340.0, 0.05)


def es(t: np.ndarray) -> np.ndarray:
    """Saturation vapour pressure over water (Bolton 1980), hPa, from K."""
    return 6.112 * np.exp(17.67 * (t - 273.15) / (t - 29.65))


def mixing_ratio(e: np.ndarray, p: np.ndarray) -> np.ndarray:
    """kg/kg from vapour pressure and pressure (both hPa)."""
    return EPS * e / np.maximum(p - e, 1e-3)


def dewpoint(e: np.ndarray) -> np.ndarray:
    """K from vapour pressure (hPa)."""
    ln = np.log(np.maximum(e, 1e-6) / 6.112)
    return 243.5 * ln / (17.67 - ln) + 273.15


def lcl_temperature(t: np.ndarray, td: np.ndarray) -> np.ndarray:
    """Bolton (1980) eq. 15."""
    td = np.minimum(td, t)
    return 1.0 / (1.0 / (td - 56.0) + np.log(t / td) / 800.0) + 56.0


def theta_e(t: np.ndarray, td: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Bolton (1980) eq. 43, K."""
    td = np.minimum(td, t)
    r = 1000.0 * mixing_ratio(es(td), p)  # g/kg
    tl = lcl_temperature(t, td)
    return (t * (1000.0 / p) ** (KAPPA * (1.0 - 0.00028 * r))
            * np.exp((3.376 / tl - 0.00254) * r * (1.0 + 0.00081 * r)))


def _saturated_table(p: float) -> tuple[np.ndarray, np.ndarray]:
    """theta-e of saturated air at pressure p, and the temperatures it is for:
    rising together, so a parcel's temperature is read back by interpolation.
    Only as warm as air at that pressure can hold its vapour (far past any
    real parcel): beyond, the vapour pressure nears the pressure itself and
    the formula runs off to infinity."""
    t = _T_TABLE[es(_T_TABLE) < 0.25 * p]
    with np.errstate(over="ignore", invalid="ignore"):
        the = theta_e(t, t, np.full_like(t, p))
    keep = np.isfinite(the)
    keep &= np.concatenate([[True], np.diff(np.where(keep, the, -np.inf)) > 0])
    n = int(np.argmin(keep)) if not keep.all() else keep.size
    return the[:n], t[:n]


_TABLES = {p: _saturated_table(float(p)) for p in LEVELS}


def _virtual(t: np.ndarray, r: np.ndarray) -> np.ndarray:
    return t * (1.0 + 0.61 * r)


def _interp(coord: np.ndarray, target: np.ndarray, values: np.ndarray) -> np.ndarray:
    """values at `target` along each column of `coord` (levels x columns,
    rising up the levels, repeats allowed). `target` is one value per column,
    or several (rows) per column."""
    tgt = np.atleast_2d(target)
    nlev = coord.shape[0]
    idx = np.clip((coord[:, None, :] <= tgt[None, :, :]).sum(axis=0) - 1, 0, nlev - 2)
    c0 = np.take_along_axis(coord, idx, axis=0)
    c1 = np.take_along_axis(coord, idx + 1, axis=0)
    v0 = np.take_along_axis(values, idx, axis=0)
    v1 = np.take_along_axis(values, idx + 1, axis=0)
    span = c1 - c0
    w = np.clip(np.where(span > 0, (tgt - c0) / np.where(span > 0, span, 1.0), 0.0), 0.0, 1.0)
    out = v0 + w * (v1 - v0)
    return out[0] if np.ndim(target) == 1 else out


class Profile:
    """The columns, surface first. Built from the level fields of one hour."""

    def __init__(self, lev: dict[str, np.ndarray], sfc: dict[str, np.ndarray]):
        """`lev` holds hgt, tmp, rh, u, v as (37, N) in LEVELS order; `sfc`
        holds psfc (Pa), hgt, t2m, td2m, u10, v10 as (N,)."""
        n = sfc["t2m"].shape[0]
        psfc = sfc["psfc"].astype(_F) / 100.0
        hsfc = sfc["hgt"].astype(_F)
        t2 = sfc["t2m"].astype(_F)
        td2 = np.minimum(sfc["td2m"].astype(_F), t2)
        plev = np.array(LEVELS, dtype=_F)[:, None] * np.ones((1, n), dtype=_F)
        tlev = lev["tmp"].astype(_F)
        rh = np.clip(lev["rh"].astype(_F), 1.0, 100.0)
        tdlev = np.minimum(dewpoint(rh / 100.0 * es(tlev)), tlev)
        zlev = lev["hgt"].astype(_F)

        # A level at or below the ground takes the surface's values.
        under = (plev >= psfc[None, :] - 0.5) | (zlev <= hsfc[None, :] + 1.0)
        self.under = under

        def stack(sval, lval):
            return np.vstack([sval[None, :], np.where(under, sval[None, :], lval)])

        self.p = stack(psfc, plev)
        self.z = np.maximum.accumulate(stack(hsfc, zlev), axis=0)
        self.t = stack(t2, tlev)
        self.td = stack(td2, tdlev)
        self.u = stack(sfc["u10"].astype(_F), lev["u"].astype(_F))
        self.v = stack(sfc["v10"].astype(_F), lev["v"].astype(_F))
        self.psfc, self.hsfc = psfc, hsfc
        self.r = mixing_ratio(es(self.td), self.p)
        self.tv = _virtual(self.t, self.r)
        self.agl = self.z - hsfc[None, :]
        self.lnp = -np.log(self.p)  # rising with height, for interpolation in pressure

    # -- interpolation --------------------------------------------------------
    def at_height(self, values: np.ndarray, h_agl: np.ndarray) -> np.ndarray:
        return _interp(self.agl, h_agl, values)

    def at_pressure(self, values: np.ndarray, p: np.ndarray) -> np.ndarray:
        return _interp(self.lnp, -np.log(p), values)

    def wind_at(self, h_agl: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return self.at_height(self.u, h_agl), self.at_height(self.v, h_agl)


class Parcel:
    """One parcel lifted through every column: its buoyancy and what follows."""

    def __init__(self, prof: Profile, p0: np.ndarray, t0: np.ndarray, td0: np.ndarray, k0: np.ndarray | int):
        """From pressure p0 (hPa), temperature t0 and dew point td0 (K), at
        level index k0 of the profile (per column, or one for all)."""
        nlev, n = prof.p.shape
        td0 = np.minimum(td0, t0)
        r0 = mixing_ratio(es(td0), p0)
        tl = lcl_temperature(t0, td0)
        self.p_lcl = p0 * (tl / t0) ** (1.0 / KAPPA)
        theta = t0 * (1000.0 / p0) ** KAPPA
        the = theta_e(t0, td0, p0)

        tp = np.empty_like(prof.t)
        rp = np.empty_like(prof.t)
        for k in range(nlev):
            pk = prof.p[k]
            dry_t = theta * (pk / 1000.0) ** KAPPA
            if k == 0:
                tp[k], rp[k] = dry_t, r0
                continue
            lev = LEVELS[k - 1]
            moist_t = np.interp(the, *_TABLES[lev])
            moist = pk < self.p_lcl
            tp[k] = np.where(moist, moist_t, dry_t)
            rp[k] = np.where(moist, mixing_ratio(es(moist_t), pk), r0)
        self.tp = tp
        buoy = (_virtual(tp, rp) - prof.tv) / prof.tv
        k0 = np.broadcast_to(np.asarray(k0), (n,))
        self.k0 = k0
        above = np.arange(nlev)[:, None] >= k0[None, :]
        self.b = np.where(above, buoy, np.nan)
        self.z_lcl = prof.at_pressure(prof.agl, np.minimum(self.p_lcl, prof.psfc))
        self.z0 = np.take_along_axis(prof.agl, k0[None, :], axis=0)[0]
        self._layers(prof)

    def _layers(self, prof: Profile) -> None:
        """Each layer's positive and negative part: its heights and its area."""
        z1, z2 = prof.agl[:-1], prof.agl[1:]
        b1, b2 = self.b[:-1], self.b[1:]
        ok = np.isfinite(b1) & np.isfinite(b2) & (z2 > z1)
        b1 = np.where(ok, b1, 0.0)
        b2 = np.where(ok, b2, 0.0)
        cross = (b1 > 0) != (b2 > 0)
        f = np.where(cross, b1 / np.where(cross, b1 - b2, 1.0), 0.0)
        zc = z1 + f * (z2 - z1)
        rising = b2 > 0   # positive at the top of the layer
        # Positive part [pa, pb] and its area; negative part [na, nb] and its.
        self.pa = np.where(cross, np.where(rising, zc, z1), z1)
        self.pb = np.where(cross, np.where(rising, z2, zc), z2)
        self.na = np.where(cross, np.where(rising, z1, zc), z1)
        self.nb = np.where(cross, np.where(rising, zc, z2), z2)
        pos_layer = (b1 > 0) & (b2 > 0)
        neg_layer = (b1 <= 0) & (b2 <= 0)
        self.pos = G * np.where(cross, np.where(rising, b2, b1) * 0.5 * (self.pb - self.pa),
                                np.where(pos_layer, 0.5 * (b1 + b2) * (z2 - z1), 0.0))
        self.neg = G * np.where(cross, np.where(rising, b1, b2) * 0.5 * (self.nb - self.na),
                                np.where(neg_layer, 0.5 * (b1 + b2) * (z2 - z1), 0.0))
        has_pos = ok & (self.pos > 0) & (self.pb > self.pa)
        self.has_pos = has_pos

        # LFC: where the parcel first turns positively buoyant at or above its
        # LCL. EL: the top of its highest positive layer.
        lcl = self.z_lcl[None, :]
        reach = has_pos & (self.pb > lcl)
        start = np.where(reach, np.maximum(self.pa, lcl), np.inf)
        self.z_lfc = start.min(axis=0)
        self.found = np.isfinite(self.z_lfc)
        top = np.where(reach & (self.pb > self.z_lfc[None, :]), self.pb, -np.inf)
        self.z_el = np.where(self.found, top.max(axis=0), np.nan)
        self.z_lfc = np.where(self.found, self.z_lfc, np.nan)

    @staticmethod
    def _part(area, a, b, lo, hi):
        span = b - a
        frac = np.clip((np.minimum(b, hi) - np.maximum(a, lo)) / np.where(span > 0, span, 1.0), 0.0, 1.0)
        return np.where(span > 0, area * frac, 0.0).sum(axis=0)

    def cape(self, top_agl: np.ndarray | None = None) -> np.ndarray:
        """Positive area from the LFC to the EL (or to `top_agl`), J/kg."""
        lo = np.where(self.found, self.z_lfc, np.inf)[None, :]
        hi = self.z_el if top_agl is None else np.minimum(self.z_el, top_agl)
        hi = np.where(self.found, hi, -np.inf)[None, :]
        return np.where(self.found, self._part(self.pos, self.pa, self.pb, lo, hi), 0.0)

    def cin(self) -> np.ndarray:
        """Negative area from the parcel's start to its LFC, J/kg (<= 0)."""
        lo = self.z0[None, :]
        hi = np.where(self.found, self.z_lfc, lo[0])[None, :]
        return np.where(self.found, self._part(self.neg, self.na, self.nb, lo, hi), 0.0)

    def temperature_at(self, prof: Profile, p: float) -> np.ndarray:
        return prof.at_pressure(self.tp, np.full(self.tp.shape[1], p))


def _layer_mean(prof: Profile, values: np.ndarray, depth_hpa: float, samples: int = 11) -> np.ndarray:
    """The pressure-weighted mean of `values` over the lowest `depth_hpa`."""
    ps = prof.psfc[None, :] - np.linspace(0.0, depth_hpa, samples)[:, None]
    return prof.at_pressure(values, ps).mean(axis=0)


def _srh(prof: Profile, cx, cy, lo_agl, hi_agl, samples: int) -> np.ndarray:
    """Storm-relative helicity between two heights (m AGL), m2/s2."""
    lo = np.broadcast_to(lo_agl, cx.shape)
    hi = np.broadcast_to(hi_agl, cx.shape)
    h = lo[None, :] + (hi - lo)[None, :] * np.linspace(0.0, 1.0, samples)[:, None]
    u, v = prof.wind_at(h)
    su, sv = u - cx[None, :], v - cy[None, :]
    return (su[1:] * sv[:-1] - su[:-1] * sv[1:]).sum(axis=0)


def compute(lev: dict[str, np.ndarray], sfc: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Every parameter for a set of columns: see the module's docstring."""
    prof = Profile(lev, sfc)
    n = prof.p.shape[1]
    out: dict[str, np.ndarray] = {}

    # Surface-based.
    sb = Parcel(prof, prof.p[0], prof.t[0], prof.td[0], 0)
    out["sbcape"], out["sbcin"] = sb.cape(), sb.cin()
    out["lcl_msl"] = sb.z_lcl + prof.hsfc

    # Mixed layer: the lowest 100 mb's mean theta and mixing ratio, from the ground.
    theta = prof.t * (1000.0 / prof.p) ** KAPPA
    th_m = _layer_mean(prof, theta, 100.0)
    r_m = _layer_mean(prof, prof.r, 100.0)
    t_ml = th_m * (prof.psfc / 1000.0) ** KAPPA
    td_ml = dewpoint(r_m * prof.psfc / (EPS + r_m))
    ml = Parcel(prof, prof.psfc, t_ml, td_ml, 0)
    out["mlcape"], out["mlcin"] = ml.cape(), ml.cin()
    out["cape3"] = ml.cape(top_agl=np.full(n, 3000.0))
    out["mllcl"] = ml.z_lcl
    out["li"] = prof.at_pressure(prof.t, np.full(n, 500.0)) - ml.temperature_at(prof, 500.0)

    # Most unstable: the highest theta-e in the lowest 300 mb.
    the = theta_e(prof.t, prof.td, prof.p)
    window = prof.p >= (prof.psfc[None, :] - 300.0)
    kmu = np.argmax(np.where(window, the, -np.inf), axis=0)
    pick = lambda a: np.take_along_axis(a, kmu[None, :], axis=0)[0]  # noqa: E731
    mu = Parcel(prof, pick(prof.p), pick(prof.t), pick(prof.td), kmu)
    out["mucape"], out["mucin"] = mu.cape(), mu.cin()
    out["lfc_msl"] = mu.z_lfc + prof.hsfc
    out["el_msl"] = mu.z_el + prof.hsfc
    out["bli"] = prof.at_pressure(prof.t, np.full(n, 500.0)) - mu.temperature_at(prof, 500.0)

    # Bunkers right-moving storm motion: the 0-6 km mean wind, 7.5 m/s to the
    # right of the shear from the lowest 500 m to the 5.5-6 km layer.
    h = np.arange(0.0, 6001.0, 250.0)
    u, v = prof.wind_at(np.repeat(h[:, None], n, axis=1))
    mean_u, mean_v = u.mean(axis=0), v.mean(axis=0)
    su = u[-3:].mean(axis=0) - u[:3].mean(axis=0)
    sv = v[-3:].mean(axis=0) - v[:3].mean(axis=0)
    mag = np.maximum(np.hypot(su, sv), 1e-6)
    cx, cy = mean_u + 7.5 * sv / mag, mean_v - 7.5 * su / mag
    out["ustm"], out["vstm"] = cx, cy
    u1, v1 = prof.wind_at(np.full(n, 1000.0))
    out["ushr1"], out["vshr1"] = u1 - u[0], v1 - v[0]
    out["ushr6"], out["vshr6"] = u[-1] - u[0], v[-1] - v[0]
    out["srh1"] = _srh(prof, cx, cy, 0.0, 1000.0, 11)
    out["srh3"] = _srh(prof, cx, cy, 0.0, 3000.0, 21)
    out["lr03"] = (prof.t[0] - prof.at_height(prof.t, np.full(n, 3000.0))) / 3.0

    # The effective inflow layer: parcels from each level of the lowest 300 mb.
    # Only where the most unstable parcel has 100 J/kg: no parcel of the layer
    # can have more, so nowhere else can the layer exist (SHARPpy's shortcut).
    nlev = prof.p.shape[0]
    base = np.full(n, np.nan)
    top = np.full(n, np.nan)
    base_k = np.full(n, -1)
    open_ = out["mucape"] >= 100.0  # still looking for the base, or still climbing
    for k in range(nlev):
        inside = window[k] & open_ & ~((k > 0) & prof.under[k - 1])
        if not inside.any():
            if k > 0 and not window[k].any():
                break
            continue
        cols = np.nonzero(inside)[0]
        if k == 0:
            cape, cin = out["sbcape"][cols], out["sbcin"][cols]
        else:
            sub = _subset(prof, cols)
            parcel = Parcel(sub, sub.p[k], sub.t[k], sub.td[k], k)
            cape, cin = parcel.cape(), parcel.cin()
        good = (cape >= 100.0) & (cin >= -250.0)
        z = prof.agl[k, cols]
        new_base = good & np.isnan(base[cols])
        base[cols[new_base]] = z[new_base]
        base_k[cols[new_base]] = k
        climbing = good & ~np.isnan(base[cols])
        top[cols[climbing]] = z[climbing]
        # A column whose layer has started and has now failed is done.
        done = ~good & ~np.isnan(base[cols])
        open_[cols[done]] = False
    have = ~np.isnan(base)
    out["eff_base"] = base
    out["eff_top"] = top
    esrh = _srh(prof, cx, cy, np.where(have, base, 0.0), np.where(have, top, 0.0), 12)
    out["esrh"] = np.where(have, esrh, 0.0)
    # Effective bulk wind difference: from the layer's base to half way up to
    # the most unstable parcel's EL.
    el = np.where(np.isfinite(mu.z_el), mu.z_el, 0.0)
    b0 = np.where(have, base, 0.0)
    half = b0 + 0.5 * np.maximum(el - b0, 0.0)
    ub, vb = prof.wind_at(b0)
    uh, vh = prof.wind_at(half)
    out["ebwd"] = np.where(have & (el > b0), np.hypot(uh - ub, vh - vb), 0.0)

    # STP with the effective layer and CIN (Thompson et al. 2012), zero where
    # the inflow layer is not rooted at the ground.
    lcl_t = np.clip((2000.0 - out["mllcl"]) / 1000.0, 0.0, 1.0)
    shr_t = np.where(out["ebwd"] < 12.5, 0.0, np.minimum(out["ebwd"], 30.0) / 20.0)
    cin_t = np.clip((200.0 + out["mlcin"]) / 150.0, 0.0, 1.0)
    rooted = base_k == 0
    out["stp_eff"] = np.where(rooted, (out["mlcape"] / 1500.0) * lcl_t * (out["esrh"] / 150.0) * shr_t * cin_t, 0.0)
    # SCP with the effective layer and the MUCIN term.
    scp_shr = np.where(out["ebwd"] < 10.0, 0.0, np.minimum(out["ebwd"], 20.0) / 20.0)
    mucin_t = np.where(out["mucin"] > -40.0, 1.0, -40.0 / np.minimum(out["mucin"], -40.0))
    out["scp_eff"] = (out["mucape"] / 1000.0) * (out["esrh"] / 50.0) * scp_shr * mucin_t
    return {k: v.astype(np.float32) for k, v in out.items()}


def _subset(prof: Profile, cols: np.ndarray) -> Profile:
    """The same profile for some columns only."""
    sub = Profile.__new__(Profile)
    for name in ("p", "z", "t", "td", "u", "v", "r", "tv", "agl", "lnp", "under"):
        setattr(sub, name, getattr(prof, name)[:, cols])
    sub.psfc, sub.hsfc = prof.psfc[cols], prof.hsfc[cols]
    return sub
