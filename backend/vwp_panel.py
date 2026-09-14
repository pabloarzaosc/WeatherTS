"""The VWP hodograph panel: one image, the way an operational hodograph reads.

The numbers all come out of SHARPpy's sharptab -- helicity, shear, storm-
relative wind, Bunkers, Corfidi, the effective inflow layer, EHI, the critical
angle -- computed on a profile whose winds are the radar's own VAD. Nothing
here re-implements a parameter SHARPpy already defines.

Two honesty rules run through the whole panel, because a VAD is not a sounding:

  * The layer table is VAD-only. A row whose top is above the highest level the
    radar returned is dashed, never filled from the model. That is why a
    shallow VAD shows Sfc-1km and dashes Sfc-6km.
  * The storm motions are not, and cannot be. Bunkers is defined on 0-6 km and
    Corfidi on the 850-300 mb cloud layer, so those are computed on the profile
    with model winds spliced in above the VAD top, and the panel says so on its
    face. A storm motion is the one thing worth reaching for the model to get,
    because every storm-relative number in the table is measured against it.
"""
from __future__ import annotations

import io
import math
import time
from datetime import datetime, timezone
from typing import Any, Optional

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Circle

import nexrad_vwp
import sharppy_renderer
import vwp_sounding

MISSING = -9999.0

# The canvas, in pixels, and where each panel sits on it. Pixel boxes rather
# than figure fractions because the SHARPpy widgets are rendered at exactly the
# size of their box: a widget scaled after the fact would be soft, and SHARPpy
# sizes its own fonts from the widget, so stretching one distorts its layout.
CANVAS_W, CANVAS_H = 2000, 1200
HODO_BOX = (8, 8, 1188, 1186)
# 1.57:1. SHARPpy's kinematics widget takes its font size from its height and
# its column positions from its width, so only a box near the aspect its own
# window gives it keeps the numbers inside their columns.
KIN_BOX = (1212, 8, 784, 500)


def _rect(x: int, y: int, w: int, h: int) -> list[float]:
    """A pixel box (top-left origin) as a matplotlib figure rectangle."""
    return [x / CANVAS_W, (CANVAS_H - y - h) / CANVAS_H, w / CANVAS_W, h / CANVAS_H]

# --- palette and type ------------------------------------------------------
# Straight out of SHARPpy: sharptab/constants.py for the named colours and
# viz/preferences.py for the hodograph defaults. Nothing here is invented, so
# a hodograph in this panel and one in the SPCWidget read as the same tool.
#
# SHARPpy asks Qt for Helvetica and sets bold on nearly every font it makes;
# on Windows that resolves to Arial, which is what the SPCWidget renders with.
matplotlib.rcParams["font.family"] = "sans-serif"
matplotlib.rcParams["font.sans-serif"] = [
    "Helvetica", "Arial", "Liberation Sans", "Nimbus Sans", "DejaVu Sans",
]
matplotlib.rcParams["font.weight"] = "bold"
matplotlib.rcParams["axes.labelweight"] = "bold"
matplotlib.rcParams["axes.titleweight"] = "bold"

BG = "#000000"          # prefs bg_color
FG = "#ffffff"          # prefs fg_color
GRID = "#555555"        # prefs hodo_itach_color -- the isotach rings
CYAN = "#00ffff"        # constants CYAN; also eff_inflow_color and hodo_crit_color
LBLUE = "#06b5ff"       # constants LBLUE
TABLE_BLUE = "#0a74c6"  # viz/kinematics.py section rule
RED = "#ff0000"         # constants RED
GREEN = "#00ff00"       # constants GREEN
YELLOW = "#ffff00"      # constants YELLOW
MAGENTA = "#e700df"     # constants MAGENTA
LBROWN = "#996600"      # constants LBROWN
SALMON = "#ff6666"      # viz/kinematics.py, the Bunkers-left readout
STEEL = "#0099cc"       # viz/kinematics.py, the Bunkers-right readout

# On this panel salmon carries a second meaning as well: it marks every number
# the VAD could not supply on its own. See the footer.
LAV = LBLUE
BLUE = TABLE_BLUE
TEAL = LBLUE
OLIVE = LBROWN

MOTIONS = ("right", "left", "mean", "corfidi-up", "corfidi-down", "nixon-right", "nixon-left", "custom")


def _sharptab():
    from sharppy.sharptab import interp, params, profile, utils, winds

    return interp, params, profile, utils, winds


def _vec(u, v, utils) -> tuple[Optional[float], Optional[float]]:
    """(direction, speed) or (None, None) when either component is masked."""
    if u is None or v is None:
        return (None, None)
    try:
        if np.ma.is_masked(u) or np.ma.is_masked(v) or not np.isfinite(u) or not np.isfinite(v):
            return (None, None)
    except TypeError:
        return (None, None)
    d, s = utils.comp2vec(float(u), float(v))
    if not np.isfinite(d) or not np.isfinite(s):
        return (None, None)
    return (float(d), float(s))


def _num(x) -> Optional[float]:
    try:
        if x is None or np.ma.is_masked(x):
            return None
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if np.isfinite(f) and abs(f) < 1e8 else None


def _fmt_vec(d: Optional[float], s: Optional[float], dash: str = "-- / -- kt") -> str:
    if d is None or s is None:
        return dash
    return f"{d:.0f} / {s:.0f} kt"


def _fmt(v: Optional[float], suffix: str = "", dash: str = "--") -> str:
    return dash if v is None else f"{v:.0f}{suffix}"


# --- layer table ---------------------------------------------------------
# (label, bottom m AGL, top m AGL, colour, kind)
#   kind "layer"  -> shear / SRH / SR wind / EHI
#   kind "srh"    -> SRH and EHI only; the row exists to carry a depth that the
#                    other three columns are not conventionally quoted over.
ROWS = [
    ("Sfc-500m", 0.0, 500.0, FG, "layer"),
    ("Sfc-1km", 0.0, 1000.0, FG, "layer"),
    ("Eff Inflow", None, None, CYAN, "eff"),
    ("Sfc-3km", 0.0, 3000.0, LAV, "layer"),
    ("1km-3km", 1000.0, 3000.0, LAV, "layer"),
    ("3km-6km", 3000.0, 6000.0, BLUE, "layer"),
    ("Sfc-6km", 0.0, 6000.0, BLUE, "layer"),
    ("C: 0km-2km", 0.0, 2000.0, FG, "srh"),
]


def _profile_from_sounding(sounding: dict, prof_type: str = "convective"):
    _, _, profile, _, _ = _sharptab()
    levels = sounding["levels"]
    meta = sounding["meta"]
    valid = meta.get("validUnix")
    dt = (
        datetime.fromtimestamp(int(valid), tz=timezone.utc).replace(tzinfo=None)
        if valid
        else datetime.now(timezone.utc).replace(tzinfo=None)
    )
    return profile.create_profile(
        profile=prof_type,
        pres=np.array([lv["p"] for lv in levels], dtype=float),
        hght=np.array([lv["h"] for lv in levels], dtype=float),
        tmpc=np.array([lv["t"] for lv in levels], dtype=float),
        dwpc=np.array([lv["td"] for lv in levels], dtype=float),
        wdir=np.array([lv["wd"] for lv in levels], dtype=float),
        wspd=np.array([lv["ws"] for lv in levels], dtype=float),
        missing=MISSING,
        strictQC=False,
        date=dt,
        location=f"{meta.get('lat', 0):.2f},{meta.get('lon', 0):.2f}",
        latitude=float(meta.get("lat") or 0.0),
    )


def _storm_motions(prof, vad_top_agl: float) -> dict[str, tuple]:
    """Every vector the panel can draw, in (u, v) knots.

    Bunkers and Corfidi are defined over depths a VAD does not reach, so these
    come off the spliced profile. That is the deliberate exception to the
    VAD-only rule, and the panel prints it.
    """
    interp, params, _, utils, winds = _sharptab()
    out: dict[str, tuple] = {}

    try:
        rstu, rstv, lstu, lstv = winds.non_parcel_bunkers_motion(prof)
        out["right"] = (_num(rstu), _num(rstv))
        out["left"] = (_num(lstu), _num(lstv))
    except Exception:
        out["right"] = out["left"] = (None, None)

    try:
        p6 = interp.pres(prof, interp.to_msl(prof, 6000.0))
        mu, mv = winds.mean_wind(prof, pbot=prof.pres[prof.sfc], ptop=p6)
        out["mean"] = (_num(mu), _num(mv))
    except Exception:
        out["mean"] = (None, None)

    try:
        upu, upv, dnu, dnv = winds.corfidi_mcs_motion(prof)
        out["corfidi-up"] = (_num(upu), _num(upv))
        out["corfidi-down"] = (_num(dnu), _num(dnv))
    except Exception:
        out["corfidi-up"] = out["corfidi-down"] = (None, None)

    # Nixon deviant tornado motion: the midpoint of the storm's motion and the
    # 0-500 m mean wind. Both movers get one, hence DTMR and DTML.
    try:
        p500 = interp.pres(prof, interp.to_msl(prof, 500.0))
        lu, lv = winds.mean_wind(prof, pbot=prof.pres[prof.sfc], ptop=p500)
        lu, lv = _num(lu), _num(lv)
    except Exception:
        lu = lv = None
    for src, dst in (("right", "nixon-right"), ("left", "nixon-left")):
        su, sv = out.get(src, (None, None))
        if None in (su, sv, lu, lv):
            out[dst] = (None, None)
        else:
            out[dst] = ((su + lu) / 2.0, (sv + lv) / 2.0)

    return out


def _layer_rows(prof, storm: tuple, vad_top_agl: float) -> list[dict]:
    """One dict per table row, with None wherever the VAD did not reach."""
    interp, params, _, utils, winds = _sharptab()
    stu, stv = storm
    have_storm = stu is not None and stv is not None
    su = 0.0 if stu is None else stu
    sv = 0.0 if stv is None else stv

    def pres_at(z_agl: float):
        return interp.pres(prof, interp.to_msl(prof, z_agl))

    # The effective inflow layer needs CAPE, so it comes from the model's
    # thermodynamics. It is only quoted when it sits inside the depth the radar
    # actually measured -- otherwise its winds would be the model's.
    eff_bot = eff_top = None
    try:
        epbot, eptop = params.effective_inflow_layer(prof)
        if _num(epbot) is not None and _num(eptop) is not None:
            eff_bot = _num(interp.to_agl(prof, interp.hght(prof, epbot)))
            eff_top = _num(interp.to_agl(prof, interp.hght(prof, eptop)))
    except Exception:
        pass

    rows: list[dict] = []
    for label, bot, top, color, kind in ROWS:
        row = {"label": label, "color": color, "shear": None, "srh": None, "srw": None, "ehi": None}

        if kind == "eff":
            bot, top = eff_bot, eff_top
            if bot is None or top is None or top <= bot:
                row["label"] = "Eff Inflow"
                rows.append(row)
                continue
            row["label"] = f"Eff Inflow"

        if bot is None or top is None:
            rows.append(row)
            continue

        # The one rule that keeps this honest: nothing above the VAD's top.
        if top > vad_top_agl + 1.0:
            rows.append(row)
            continue

        if kind in ("layer", "eff"):
            try:
                su_, sv_ = winds.wind_shear(prof, pbot=pres_at(bot), ptop=pres_at(top))
                row["shear"] = _vec(su_, sv_, utils)
            except Exception:
                pass
            if have_storm:
                try:
                    ru, rv = winds.sr_wind(prof, pbot=pres_at(bot), ptop=pres_at(top), stu=su, stv=sv)
                    row["srw"] = _vec(ru, rv, utils)
                except Exception:
                    pass

        if have_storm:
            try:
                total = winds.helicity(prof, bot, top, stu=su, stv=sv)[0]
                row["srh"] = _num(total)
            except Exception:
                pass
            try:
                pcl = getattr(prof, "mupcl", None)
                if pcl is not None:
                    row["ehi"] = _num(params.ehi(prof, pcl, bot, top, stu=su, stv=sv))
            except Exception:
                pass

        rows.append(row)
    return rows


def _summary(prof, storm: tuple) -> dict:
    """EBWD, the LCL-EL shear and the critical angle -- the three numbers the
    reference panel carries outside the layer table."""
    interp, params, _, utils, winds = _sharptab()
    stu, stv = storm
    out = {"ebwd": (None, None), "lclel": (None, None), "critical": None}

    ebwd = getattr(prof, "ebwd", None)
    if ebwd is not None:
        try:
            out["ebwd"] = _vec(ebwd[0], ebwd[1], utils)
        except Exception:
            pass
    if out["ebwd"] == (None, None):
        # Effective bulk wind difference: the effective inflow base to half the
        # equilibrium level.
        try:
            epbot, _eptop = params.effective_inflow_layer(prof)
            pcl = getattr(prof, "mupcl", None)
            el = _num(getattr(pcl, "elhght", None))
            base = _num(interp.to_agl(prof, interp.hght(prof, epbot)))
            if el is not None and base is not None and el > base:
                top = interp.pres(prof, interp.to_msl(prof, base + (el - base) * 0.5))
                u, v = winds.wind_shear(prof, pbot=epbot, ptop=top)
                out["ebwd"] = _vec(u, v, utils)
        except Exception:
            pass

    try:
        pcl = getattr(prof, "mupcl", None)
        lcl = _num(getattr(pcl, "lclhght", None))
        el = _num(getattr(pcl, "elhght", None))
        if lcl is not None and el is not None and el > lcl:
            u, v = winds.wind_shear(
                prof,
                pbot=interp.pres(prof, interp.to_msl(prof, lcl)),
                ptop=interp.pres(prof, interp.to_msl(prof, el)),
            )
            out["lclel"] = _vec(u, v, utils)
    except Exception:
        pass

    if stu is not None and stv is not None:
        try:
            out["critical"] = _num(winds.critical_angle(prof, stu=stu, stv=stv))
        except Exception:
            pass
    return out


# --- drawing -------------------------------------------------------------
def _panel(fig, rect):
    ax = fig.add_axes(rect)
    ax.set_facecolor(BG)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    return ax


def _place_png(fig, rect, png: bytes):
    """Drop a rendered widget onto the canvas at 1:1."""
    import matplotlib.image as mpimg

    ax = fig.add_axes(rect)
    ax.set_axis_off()
    ax.imshow(mpimg.imread(io.BytesIO(png), format="png"), aspect="auto",
              interpolation="none")
    return ax


def _hodo_caption(fig, rect, title: str, subtitle: str, note: str):
    """The text block over the hodograph's empty top-left corner."""
    ax = fig.add_axes(rect)
    ax.set_axis_off()
    ax.patch.set_alpha(0.0)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.text(0.008, 0.988, title, transform=ax.transAxes, color=FG, fontsize=16,
            fontweight="bold", ha="left", va="top")
    ax.text(0.008, 0.952, subtitle, transform=ax.transAxes, color="#9aa4b2",
            fontsize=12, ha="left", va="top")
    if note:
        ax.text(0.008, 0.915, note, transform=ax.transAxes, color="#98a3b2",
                fontsize=11.5, ha="left", va="top", linespacing=1.5)
    return ax


def _profile_axes(fig, rect, title, xvals, yvals, xerr=None, color=CYAN,
                  xticks=None, fill=True, dotted=False):
    ax = fig.add_axes(rect)
    ax.set_facecolor(BG)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors=FG, labelsize=10.5, length=3, pad=2)
    ax.set_title(title, color=FG, fontsize=14.5, fontweight="bold", pad=6)
    if not len(xvals):
        ax.set_xticks([])
        ax.set_yticks([])
        return ax

    top = max(2.0, float(np.nanmax(yvals)))
    ax.set_ylim(0, top)
    if fill:
        ax.fill_betweenx(yvals, 0, xvals, color=color, alpha=0.22)
    ax.plot(xvals, yvals, color=color, lw=2.0, ls=":" if dotted else "-",
            marker="o", ms=4.5)
    if xerr is not None:
        ax.errorbar(xvals, yvals, xerr=xerr, fmt="none", ecolor=RED, elinewidth=1.6,
                    capsize=3, capthick=1.6)
    if xticks is not None:
        ax.set_xticks(xticks)
    ax.set_yticks([t for t in (1.0, 2.0, 3.0, 4.0, 6.0, 8.0) if t <= top])
    ax.grid(color="#2a2a2a", lw=0.8)
    ax.axhline(0, color=FG, lw=1.2)
    return ax


def _draw_map(fig, rect, site_lat, site_lon, site_id, product="N0B", span=2.2):
    """The radar's own reflectivity, so the profile has a scene attached to it."""
    ax = fig.add_axes(rect)
    ax.set_facecolor("#0b0f14")
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_color("#2a3340")

    try:
        import nexrad_core

        payload = nexrad_core.render(site_id, product)
        b = payload["bounds"]
        img = plt.imread(io.BytesIO(payload["png"]))
        ax.imshow(img, extent=[b["west"], b["east"], b["south"], b["north"]],
                  origin="upper", interpolation="nearest", zorder=1)
    except Exception:
        ax.text(0.5, 0.5, "no scan", transform=ax.transAxes, color="#54606f",
                fontsize=12, ha="center", va="center")

    # Ranges the eye uses: 50 and 100 nm from the radar.
    for nm in (50, 100):
        r = nm * 1.852 / 111.0
        ax.add_patch(Circle((site_lon, site_lat), r, fill=False, ec="#39465a",
                            lw=1.0, ls=(0, (4, 4)), zorder=2))
    ax.plot([site_lon], [site_lat], marker="o", ms=11, mfc=RED, mec=FG, mew=1.6, zorder=3)
    ax.set_xlim(site_lon - span / math.cos(math.radians(site_lat)) / 2, 
                site_lon + span / math.cos(math.radians(site_lat)) / 2)
    ax.set_ylim(site_lat - span / 2, site_lat + span / 2)
    ax.text(0.03, 0.95, f"K{site_id}", transform=ax.transAxes, color=FG, fontsize=12,
            fontweight="bold", ha="left", va="top", zorder=4)
    return ax


def _draw_barbs(fig, rect, trace):
    """The lowest three levels as barbs -- the layer a VAD exists to show."""
    ax = _panel(fig, rect)
    wanted = [(0.0, "0km AGL"), (500.0, "0.5km AGL"), (1000.0, "1km AGL")]
    if len(trace) < 2:
        return ax
    zs = np.array([p["z"] for p in trace], dtype=float)
    us = np.array([p["u"] for p in trace], dtype=float)
    vs = np.array([p["v"] for p in trace], dtype=float)
    for i, (z, label) in enumerate(wanted):
        # A radar cannot see the surface -- its lowest beam is already hundreds
        # of metres up -- so "0 km" is drawn from the lowest level there is
        # rather than left blank. Anything above the VAD's top is left out.
        if z > zs[-1] + 1:
            continue
        u = float(np.interp(z, zs, us))
        v = float(np.interp(z, zs, vs))
        y = 0.22 + i * 0.30
        ax.barbs([0.34], [y], [u], [v], color=MAGENTA, length=8.5, linewidth=1.7,
                 pivot="middle", zorder=3)
        ax.text(0.97, y, label, color=MAGENTA, fontsize=13, fontweight="bold",
                ha="right", va="center")
    return ax


def _trace_from_vad(levels: list[dict], site_elev_m: float) -> list[dict]:
    """VAD levels as a hodograph trace: heights AGL, winds in knots."""
    pts = []
    for lv in levels:
        alt, spd, d = lv.get("altM"), lv.get("spdKt"), lv.get("dirDeg")
        if alt is None or spd is None or d is None:
            continue
        z = float(alt) - site_elev_m
        if z < -50:
            continue
        r = math.radians(float(d))
        pts.append({
            "z": max(z, 0.0),
            "u": -float(spd) * math.sin(r),
            "v": -float(spd) * math.cos(r),
            "spd": float(spd),
            "dir": float(d),
            "rms": lv.get("rmsKt"),
        })
    pts.sort(key=lambda p: p["z"])
    return pts


_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 90.0


def render_vwp_panel(
    site: str,
    motion: str = "right",
    custom: Optional[tuple[float, float]] = None,
    product: str = "N0B",
    show_map: bool = True,
) -> dict[str, Any]:
    """The whole VWP panel as one PNG, plus the numbers on it."""
    site = (site or "").upper().strip()
    # Four letters is an ICAO (KTLX, RKJK): drop its first. Not lstrip("K") --
    # that turned Kunsan's KJK into "JK".
    if len(site) == 4:
        site = site[1:]
    if len(site) != 3:
        raise ValueError("site must be the 3-letter radar id, e.g. 'JKL'")
    motion = motion if motion in MOTIONS else "right"

    ck = (site, motion, custom, product, show_map)
    now = time.time()
    hit = _CACHE.get(ck)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    vwp = nexrad_vwp.build_vwp(site, columns=1)
    vad_levels = (vwp["columns"] or [{}])[-1].get("levels") or []
    sounding = vwp_sounding.build_vwp_sounding(site, render=False)
    meta = sounding["meta"]
    site_elev = float(meta.get("elevation") or 0.0)

    trace = _trace_from_vad(vad_levels, site_elev)
    if len(trace) < 2:
        raise vwp_sounding.NoProfileError(
            f"K{site} published a VAD but it carried too few usable levels to plot."
        )
    vad_top_agl = trace[-1]["z"]

    prof = _profile_from_sounding(sounding)
    motions = _storm_motions(prof, vad_top_agl)
    if custom is not None:
        d, s = custom
        r = math.radians(float(d))
        motions["custom"] = (-float(s) * math.sin(r), -float(s) * math.cos(r))
    else:
        motions["custom"] = (None, None)

    chosen = motions.get(motion, (None, None))
    if chosen[0] is None and motion != "right":
        motion, chosen = "right", motions.get("right", (None, None))

    rows = _layer_rows(prof, chosen, vad_top_agl)
    summary = _summary(prof, chosen)

    valid = meta.get("validUnix")
    when = (
        datetime.fromtimestamp(int(valid), tz=timezone.utc).strftime("%d %b %Y %H:%M UTC")
        if valid
        else "unknown time"
    )
    title = f"VWP {site} — valid {when}"
    subtitle = "WeatherTS — parameters by SHARPpy"
    thermo = str(meta.get("thermoModel") or "model").upper()
    note = (
        f"WHITE = measured — winds to {vad_top_agl / 1000:.1f} km AGL are this radar's own VAD, "
        f"and the table stops where the VAD does." + chr(10) +
        f"SALMON = needs the model — Bunkers wants 0-6 km and Corfidi the cloud layer, so those "
        f"use {thermo} winds above the VAD, over {thermo} thermodynamics."
    )

    # The hodograph and the kinematics are SHARPpy's own widgets, grabbed out
    # of the same Qt objects its window draws -- not a redrawing of them. The
    # storm motion goes in with the profile so the markers, the shear vectors
    # and every storm-relative number on the table are measured against the one
    # the user picked.
    render_meta = dict(meta)
    if motion in ("right", "left"):
        render_meta["stormMotion"] = motion
    elif chosen[0] is not None:
        # Hand SHARPpy the exact vector the table was built on instead of
        # naming a motion it would recompute its own way. Mean wind, Corfidi
        # and the Nixon deviants are all just a vector to SHARPpy, and the
        # markers on the hodograph have to be the same storm as the numbers
        # printed next to them.
        d, spd = _vec(chosen[0], chosen[1], _sharptab()[3])
        render_meta["stormMotion"] = "custom"
        render_meta["stormMotionDir"] = d
        render_meta["stormMotionSpd"] = spd
    else:
        render_meta["stormMotion"] = "right"
    widgets = sharppy_renderer.render_vwp_widgets(
        sounding["levels"], render_meta,
        {"hodo": (HODO_BOX[2], HODO_BOX[3]), "kinematics": (KIN_BOX[2], KIN_BOX[3])},
    )

    fig = plt.figure(figsize=(CANVAS_W / 100, CANVAS_H / 100), dpi=100, facecolor=BG)

    _place_png(fig, _rect(*HODO_BOX), widgets["hodo"])
    _hodo_caption(fig, _rect(*HODO_BOX), title, subtitle, note)
    fig.add_artist(Line2D([0.601, 0.601], [0.0, 1.0], color=FG, lw=2.0,
                          transform=fig.transFigure))

    _place_png(fig, _rect(*KIN_BOX), widgets["kinematics"])
    kin_bottom = 1.0 - (KIN_BOX[1] + KIN_BOX[3] + 8) / CANVAS_H
    fig.add_artist(Line2D([0.606, 0.996], [kin_bottom, kin_bottom], color=FG, lw=2.0,
                          transform=fig.transFigure))

    zs = np.array([p["z"] / 1000.0 for p in trace])
    spd = np.array([p["spd"] for p in trace])
    dirs = np.array([p["dir"] for p in trace])
    rms = np.array([p["rms"] if p["rms"] is not None else np.nan for p in trace])
    rms = np.where(np.isfinite(rms), rms, 0.0)

    stu, stv = chosen
    if stu is not None and stv is not None:
        srw = np.array([math.hypot(p["u"] - stu, p["v"] - stv) for p in trace])
    else:
        srw = np.array([])

    _profile_axes(fig, _rect(1232, 566, 232, 596), "SR Wind (kt)\nv Height (km)",
                  srw, zs if len(srw) else np.array([]), color=RED, dotted=True)
    _profile_axes(fig, _rect(1508, 566, 232, 272), "Wind Spd (kt)", spd, zs,
                  xerr=rms, color=CYAN)
    _profile_axes(fig, _rect(1508, 890, 232, 272), "Wind Dir (Deg)", dirs, zs,
                  xerr=None, color=CYAN, fill=False)

    if show_map:
        _draw_map(fig, _rect(1760, 550, 232, 232), meta["lat"], meta["lon"],
                  site, product)
    _draw_barbs(fig, _rect(1752, 840, 240, 322), trace)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", facecolor=BG, dpi=100)
    plt.close(fig)

    out = {
        "png": buf.getvalue(),
        "meta": {
            "site": f"K{site}",
            "lat": meta["lat"],
            "lon": meta["lon"],
            "validUnix": valid,
            "motion": motion,
            "vadTopAglM": vad_top_agl,
            "vadLevels": len(trace),
            "thermoModel": meta.get("thermoModel"),
            "note": note,
        },
        "motions": {
            k: {"dir": (math.degrees(math.atan2(-u, -v)) % 360.0), "spd": math.hypot(u, v)}
            for k, (u, v) in motions.items()
            if u is not None and v is not None
        },
        "rows": [
            {
                "label": r["label"],
                "shear": None if not r["shear"] or r["shear"][0] is None else
                         {"dir": r["shear"][0], "spd": r["shear"][1]},
                "srh": r["srh"],
                "srWind": None if not r["srw"] or r["srw"][0] is None else
                          {"dir": r["srw"][0], "spd": r["srw"][1]},
                "ehi": r["ehi"],
            }
            for r in rows
        ],
        "critical": summary["critical"],
    }
    _CACHE[ck] = (now, out)
    return out
