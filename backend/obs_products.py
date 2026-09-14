"""
What the analyses can draw: sources, variables, derived parameters, products.

observations.py is the machine -- fetching, caching, warping, contouring. This
is the catalogue it runs: which GRIB field each source calls a variable, how
the derived ones are worked out, and how each product is shaded, contoured and
barbed. Kept apart so adding a product is an edit here and nothing else.

Checked against the files themselves (2026-09-12/13), which is where several
choices below come from:
  * The HRRR's analysis hour carries no precipitation rate, precipitation type
    or aerosol optical depth (all zero everywhere); the RAP's does. Those
    products are RAP-only rather than drawn as an empty map.
  * The HRRR's cloud ceiling and cloud top are heights above sea level (never
    below the terrain) while its cloud base is above ground; RTMA's ceiling is
    above ground, with 16000 m meaning no ceiling.
  * The HRRR's LFC and EL exist everywhere, parcel or not, so they are shown
    only where there is CAPE to have them.
"""
from __future__ import annotations

import math
from typing import Any, Callable, Optional

import numpy as np
from scipy.ndimage import gaussian_filter

NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com"

# ---------------------------------------------------------------------------
# Palettes: value stops in the product's display unit. An eight-digit colour
# carries alpha -- "nothing worth colouring" is a transparent stop.
# ---------------------------------------------------------------------------
T0 = "#00000000"

TEMP_F = [
    (-40, "#6b2fa0"), (-20, "#7b46c4"), (0, "#4f6fd0"), (15, "#3fa9dd"), (32, "#6fd2c8"),
    (45, "#4bb36a"), (60, "#a9d34c"), (72, "#f2d23c"), (85, "#f09236"), (95, "#e4552e"),
    (110, "#9e1f1f"),
]
TEMP_C = [
    (-60, "#e3d4f2"), (-50, "#b58fdc"), (-40, "#7b46c4"), (-30, "#4f6fd0"), (-20, "#3fa9dd"),
    (-10, "#6fd2c8"), (0, "#4bb36a"), (10, "#a9d34c"), (20, "#f2d23c"), (30, "#f09236"),
    (40, "#c33a2a"),
]
DEW_F = [
    (-10, "#6b4a2f"), (20, "#a98c5a"), (40, "#cfc08a"), (50, "#8fbf72"), (60, "#3f9b58"),
    (65, "#2f8f7a"), (70, "#2e7fa8"), (75, "#3b4fb0"), (80, "#6a2fa0"),
]
DEW_C = [
    (-30, "#6b4a2f"), (-10, "#a98c5a"), (0, "#cfc08a"), (5, "#8fbf72"), (10, "#3f9b58"),
    (15, "#2e7fa8"), (20, "#3b4fb0"), (25, "#6a2fa0"),
]
DPD_F = [(0, "#2f9b74"), (5, "#7fbf6a"), (10, "#d8d08a"), (20, "#b98a45"), (40, "#7a4a20"), (60, "#4a2a10")]
MIXR_GKG = [
    (0, "#7a4a20"), (4, "#b98a45"), (8, "#d8d08a"), (11, "#7fbf6a"), (14, "#2f9b74"),
    (17, "#2e7fa8"), (20, "#3b4fb0"), (24, "#6a2fa0"),
]
PWAT_IN = [
    (0, "#7a4a20"), (0.5, "#b98a45"), (1.0, "#d8d08a"), (1.25, "#7fbf6a"), (1.5, "#2f9b74"),
    (1.75, "#2e7fa8"), (2.0, "#3b4fb0"), (2.5, "#6a2fa0"), (3.0, "#b04ac0"),
]
RH_PCT = [(0, "#7a4a20"), (25, "#b98a45"), (50, "#d8d08a"), (70, "#7fbf6a"), (85, "#2f9b74"), (100, "#1f6f9b")]
THETAE_K = [
    (280, "#6b2fa0"), (300, "#4f6fd0"), (315, "#3fa9dd"), (325, "#4bb36a"), (335, "#a9d34c"),
    (345, "#f2d23c"), (355, "#f09236"), (365, "#e4552e"), (375, "#9e1f1f"),
]
MFC_GKGHR = [(0, T0), (0.25, T0), (0.5, "#9fd0a8"), (1, "#3f9b58"), (2, "#2e7fa8"), (4, "#3b4fb0"), (8, "#6a2fa0")]
WIND_MPH = [
    (0, "#10305a00"), (5, "#2f6f9b"), (12, "#3fa9a0"), (20, "#5cbf5c"), (30, "#e0d24a"),
    (45, "#e78b34"), (60, "#d6452e"), (80, "#a02068"), (100, "#6b2fa0"),
]
WIND_KT_LOW = [
    (0, "#10305a00"), (10, "#10305a00"), (15, "#9ed1f0"), (25, "#4fa3e0"), (35, "#5cbf5c"),
    (45, "#e0d24a"), (55, "#e78b34"), (65, "#d6452e"), (80, "#a02068"), (100, "#6b2fa0"),
]
WIND_KT_HIGH = [
    (0, "#10305a00"), (20, "#10305a00"), (30, "#9ed1f0"), (50, "#4fa3e0"), (70, "#3d6fcf"),
    (90, "#5cbf5c"), (110, "#e0d24a"), (130, "#e78b34"), (150, "#d6452e"), (170, "#a02068"),
    (200, "#6b2fa0"),
]
PRES_HPA = [(960, "#6b2fa0"), (985, "#3f5fc0"), (1000, "#3fa9dd"), (1013, "#e8eef6"), (1025, "#f2a83c"), (1045, "#c33a2a")]
SFC_PRES_HPA = [(600, "#6b2fa0"), (700, "#3f5fc0"), (800, "#3fa9dd"), (900, "#7fbf6a"), (1000, "#e8eef6"), (1040, "#c33a2a")]
THICK_DAM = [
    (480, "#6b2fa0"), (510, "#3d6fcf"), (528, "#3fa9dd"), (540, "#e8eef6"), (552, "#f2d23c"),
    (570, "#f09236"), (590, "#c33a2a"), (600, "#9e1f1f"),
]
VIS_MI = [(0, "#6b2fa0"), (0.5, "#c33a2a"), (1, "#e78b34"), (3, "#e0d24a"), (6, "#7fbf6a"), (10, "#2f6f9b00")]
CEIL_FT = [(0, "#6b2fa0"), (500, "#c33a2a"), (1000, "#e78b34"), (3000, "#e0d24a"), (5000, "#7fbf6a"), (12000, "#2f6f9b00")]
CBASE_FT = [(0, "#6b2fa0"), (1000, "#c33a2a"), (3000, "#e78b34"), (6000, "#e0d24a"), (10000, "#7fbf6a"), (20000, "#2f6f9b00")]
CTOP_KFT = [(0, T0), (5, "#9aa6b4"), (15, "#6fa0d8"), (25, "#3d6fcf"), (35, "#5cbf5c"), (45, "#f2d23c"), (55, "#e4552e"), (65, "#8e2a9e")]
CLOUD_PCT = [(0, "#5a6b8000"), (10, "#5a6b8000"), (40, "#7c8aa0a0"), (70, "#a7b2c2d0"), (100, "#e2e7eef0")]
PBL_M = [(0, "#3b4fb0"), (500, "#2e7fa8"), (1000, "#7fbf6a"), (2000, "#e0d24a"), (3000, "#e78b34"), (4000, "#c33a2a")]
SMOKE_UG = [
    (0, T0), (2, T0), (5, "#cfe8f6"), (10, "#9fd0a8"), (20, "#e8e07a"),
    (35, "#f0a83c"), (55, "#e4552e"), (100, "#b0306a"), (200, "#6b2fa0"),
]
SMOKE_COL_MG = [
    (0, T0), (15, T0), (30, "#cfe8f6"), (60, "#9fd0a8"), (120, "#e8e07a"),
    (250, "#f0a83c"), (500, "#e4552e"), (1000, "#b0306a"), (2000, "#6b2fa0"),
]
AOD = [(0, T0), (0.1, T0), (0.2, "#cfe8f6"), (0.4, "#e8e07a"), (0.7, "#f0a83c"), (1.0, "#e4552e"), (2.0, "#6b2fa0")]
VPD_HPA = [(0, "#2f9b74"), (10, "#a9d34c"), (20, "#f2d23c"), (35, "#f09236"), (50, "#d6452e"), (70, "#7a2020")]
FFWI_PAL = [(0, T0), (20, T0), (30, "#f2d23c"), (40, "#f0a83c"), (50, "#e4552e"), (60, "#c02a5a"), (75, "#8e2a9e")]
HDW_PAL = [(0, T0), (100, T0), (200, "#f2d23c"), (400, "#f0a83c"), (600, "#e4552e"), (800, "#c02a5a"), (1000, "#8e2a9e")]
REFL_DBZ = [
    (5, "#04e9e700"), (10, "#04e9e7"), (15, "#019ff4"), (20, "#0300f4"), (25, "#02fd02"),
    (30, "#01c501"), (35, "#008e00"), (40, "#fdf802"), (45, "#e5bc00"), (50, "#fd9500"),
    (55, "#fd0000"), (60, "#d40000"), (65, "#bc0000"), (70, "#f800fd"), (75, "#9854c6"),
]
ETOP_KFT = [(0, T0), (5, T0), (10, "#9ed1f0"), (20, "#3d6fcf"), (30, "#5cbf5c"), (40, "#f2d23c"), (50, "#f0a83c"), (60, "#e4552e"), (70, "#8e2a9e")]
VIL_KGM2 = [(0, T0), (0.5, T0), (1, "#9ed1f0"), (5, "#5cbf5c"), (10, "#f2d23c"), (20, "#f0a83c"), (35, "#e4552e"), (50, "#c02a5a"), (70, "#8e2a9e")]
PRATE_INHR = [(0, T0), (0.01, T0), (0.02, "#9be39b"), (0.1, "#3fbf3f"), (0.25, "#1f8f2f"), (0.5, "#f2e23c"), (1, "#f09236"), (2, "#d6452e"), (3, "#a02068")]


def _ptype_palette() -> list:
    """Four ramps end to end: rain 0-100, snow 100-200, sleet 200-300,
    freezing rain 300-400, each coloured by the reflectivity added to its base."""
    ramps = [
        ["#b8f0b8", "#3fbf3f", "#1f8f2f", "#f2e23c", "#f09236", "#d6452e", "#a02068"],
        ["#d6e7f8", "#a8c8f0", "#7fb2ec", "#4f7fd8", "#3553b8", "#2a3a93", "#1d2670"],
        ["#ecd3f3", "#dcb3ea", "#c38fdc", "#ae72ce", "#9a55c0", "#8240b0", "#6b2fa0"],
        ["#f9d3e4", "#f3a9ca", "#ec7fb2", "#e16298", "#d6457f", "#bb326c", "#a0205a"],
    ]
    out: list = []
    for k, ramp in enumerate(ramps):
        b = 100 * k
        out += [(b, ramp[0][:7] + "00"), (b + 4.9, ramp[0][:7] + "00")]
        for i, colour in enumerate(ramp):
            out.append((b + 5 + i * 70 / (len(ramp) - 1), colour))
        out.append((b + 99.9, ramp[-1]))
    return out


PTYPE_PAL = _ptype_palette()
PTYPE_NAMES = ["Rain", "Snow", "Sleet", "Freezing rain"]

CAPE_JKG = [
    (0, T0), (100, T0), (250, "#9ed1f0"), (500, "#5aa8e0"), (1000, "#5cbf5c"),
    (1500, "#c8d84a"), (2000, "#f2d23c"), (2500, "#f0a83c"), (3000, "#e4552e"), (4000, "#c02a5a"),
    (5000, "#8e2a9e"), (6000, "#e0b0f0"),
]
CAPE3_JKG = [(0, T0), (25, T0), (50, "#9ed1f0"), (100, "#5cbf5c"), (150, "#f2d23c"), (200, "#f0a83c"), (300, "#e4552e"), (400, "#8e2a9e")]
CIN_JKG = [
    (-400, "#5a2fa0"), (-250, "#8e2a9e"), (-150, "#3d6fcf"), (-100, "#4fa3e0"), (-50, "#9ed1f0"),
    (-25, "#d6ecf8"), (-10, "#ffffff00"), (0, "#ffffff00"),
]
LI_C = [(-12, "#8e2a9e"), (-9, "#c02a5a"), (-6, "#e4552e"), (-4, "#f0a83c"), (-2, "#f2d23c"), (0, "#ffffff00"), (15, "#ffffff00")]
LCL_M = [(0, "#1f8f2f"), (500, "#5cbf5c"), (1000, "#a9d34c"), (1500, "#f2d23c"), (2000, "#f09236"), (2500, "#d6452e"), (3500, "#7a4a20")]
LFC_M = [(0, "#1f8f2f"), (1000, "#5cbf5c"), (1500, "#a9d34c"), (2000, "#f2d23c"), (3000, "#f09236"), (4000, "#d6452e"), (5000, "#7a4a20")]
EL_M = [(0, T0), (3000, "#9ed1f0"), (6000, "#5cbf5c"), (9000, "#f2d23c"), (12000, "#f0a83c"), (14000, "#e4552e"), (16000, "#8e2a9e")]
FRZ_FT = [(0, "#6b2fa0"), (4000, "#3d6fcf"), (8000, "#3fa9dd"), (12000, "#7fbf6a"), (15000, "#f2d23c"), (18000, "#e4552e")]
SRH_M2S2 = [
    (0, T0), (50, T0), (100, "#9ed1f0"), (150, "#5cbf5c"), (200, "#f2d23c"),
    (300, "#f0a83c"), (400, "#e4552e"), (500, "#c02a5a"), (750, "#8e2a9e"), (1000, "#e0b0f0"),
]
SHR6_KT = [(0, T0), (20, T0), (25, "#9ed1f0"), (30, "#5cbf5c"), (40, "#f2d23c"), (50, "#f0a83c"), (60, "#e4552e"), (80, "#8e2a9e")]
SHR1_KT = [(0, T0), (10, T0), (15, "#9ed1f0"), (20, "#5cbf5c"), (25, "#f2d23c"), (30, "#f0a83c"), (40, "#e4552e"), (50, "#8e2a9e")]
STM_KT = [(0, T0), (10, "#9ed1f0"), (20, "#5cbf5c"), (30, "#f2d23c"), (40, "#f0a83c"), (50, "#e4552e"), (60, "#8e2a9e")]
STP_PAL = [
    (0, T0), (0.5, T0), (1, "#9ed1f0"), (2, "#5cbf5c"), (3, "#f2d23c"),
    (4, "#f0a83c"), (6, "#e4552e"), (8, "#c02a5a"), (10, "#8e2a9e"), (15, "#e0b0f0"),
]
SCP_PAL = [
    (0, T0), (1, T0), (2, "#9ed1f0"), (4, "#5cbf5c"), (6, "#f2d23c"),
    (8, "#f0a83c"), (12, "#e4552e"), (16, "#c02a5a"), (20, "#8e2a9e"), (30, "#e0b0f0"),
]
EHI_PAL = [
    (0, T0), (0.5, T0), (1, "#9ed1f0"), (2, "#5cbf5c"), (3, "#f2d23c"),
    (4, "#f0a83c"), (5, "#e4552e"), (6, "#c02a5a"), (8, "#8e2a9e"),
]
CRAVEN_PAL = [(0, T0), (10, T0), (20, "#9ed1f0"), (30, "#5cbf5c"), (40, "#f2d23c"), (60, "#f0a83c"), (80, "#e4552e"), (100, "#8e2a9e")]
SHIP_PAL = [(0, T0), (0.25, T0), (0.5, "#9ed1f0"), (1, "#5cbf5c"), (1.5, "#f2d23c"), (2, "#f0a83c"), (3, "#e4552e"), (4, "#8e2a9e")]
VORT_PAL = [
    (0, "#ffffff00"), (4, "#ffffff00"), (6, "#f6e27a"), (10, "#f0a83c"), (14, "#e4552e"),
    (18, "#c02a5a"), (24, "#8e2a9e"), (32, "#5a2fa0"),
]
DIV_PAL = [(0, T0), (2, T0), (4, "#f6e27a"), (6, "#f0a83c"), (8, "#e4552e"), (12, "#c02a5a"), (16, "#8e2a9e")]
OMEGA_UBS = [
    (-30, "#6b2fa0"), (-15, "#3d6fcf"), (-5, "#9ed1f0"), (-2, "#ffffff00"), (2, "#ffffff00"),
    (5, "#f6d28a"), (15, "#e08a3c"), (30, "#b0402a"),
]
TADV_CHR = [(-3, "#3b4fb0"), (-1.5, "#3fa9dd"), (-0.5, "#9ed1f0"), (-0.2, "#ffffff00"), (0.2, "#ffffff00"), (0.5, "#f6c28a"), (1.5, "#e4552e"), (3, "#9e1f1f")]
LAPSE_CKM = [(4, T0), (5.5, T0), (6, "#f6e27a"), (7, "#f0a83c"), (8, "#e4552e"), (9, "#c02a5a"), (10, "#8e2a9e")]
SNOW_IN = [
    (0, T0), (0.1, T0), (0.5, "#cfe0f0"), (1, "#a8c8e8"), (3, "#6f9fd8"),
    (6, "#4f6fd0"), (12, "#6b4ab8"), (24, "#9a3fb0"), (48, "#d060c0"), (96, "#f0c0e8"),
]
SWE_IN = [(0, T0), (0.05, T0), (0.1, "#cfe0f0"), (0.5, "#a8c8e8"), (1, "#6f9fd8"), (2, "#4f6fd0"), (5, "#6b4ab8"), (10, "#9a3fb0"), (20, "#d060c0")]
SNOWC_PCT = [(0, T0), (10, T0), (50, "#cfe0f0"), (100, "#ffffff")]

# ---------------------------------------------------------------------------
# Raw variables: what each source's file calls them ("VAR:LEVEL" in its .idx).
# Kept in SI on the drawing grid; products convert.
# ---------------------------------------------------------------------------
LEVELS = (925, 850, 700, 500, 300, 250, 200)

_NCEP_COMMON = {
    "t2m": "TMP:2 m above ground", "td2m": "DPT:2 m above ground", "rh2m": "RH:2 m above ground",
    "spfh2m": "SPFH:2 m above ground", "tskin": "TMP:surface",
    "u10": "UGRD:10 m above ground", "v10": "VGRD:10 m above ground",
    "u80": "UGRD:80 m above ground", "v80": "VGRD:80 m above ground",
    "gust": "GUST:surface", "mslp": "MSLMA:mean sea level", "psfc": "PRES:surface", "hgt_sfc": "HGT:surface",
    "vis": "VIS:surface", "tcdc": "TCDC:entire atmosphere",
    "lcdc": "LCDC:low cloud layer", "mcdc": "MCDC:middle cloud layer", "hcdc": "HCDC:high cloud layer",
    "hpbl": "HPBL:surface", "pwat": "PWAT:entire atmosphere (considered as a single layer)",
    "smoke": "MASSDEN:8 m above ground", "refc": "REFC:entire atmosphere", "refd1km": "REFD:1000 m above ground",
    "sbcape": "CAPE:surface", "mlcape": "CAPE:90-0 mb above ground", "mucape": "CAPE:255-0 mb above ground",
    "cape3": "CAPE:0-3000 m above ground",
    "sbcin": "CIN:surface", "mlcin": "CIN:90-0 mb above ground", "mucin": "CIN:255-0 mb above ground",
    "li": "LFTX:500-1000 mb", "bli": "4LFTX:180-0 mb above ground",
    "lfc_msl": "HGT:level of free convection", "el_msl": "HGT:equilibrium level", "frz_msl": "HGT:0C isotherm",
    "srh1": "HLCY:1000-0 m above ground", "srh3": "HLCY:3000-0 m above ground",
    "ushr6": "VUCSH:0-6000 m above ground", "vshr6": "VVCSH:0-6000 m above ground",
    "ustm": "USTM:0-6000 m above ground", "vstm": "VSTM:0-6000 m above ground",
    "snod": "SNOD:surface", "weasd": "WEASD:surface", "hgt1000": "HGT:1000 mb",
}


def _upper(absv: tuple[int, ...], dpt: bool) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in LEVELS:
        out.update({f"hgt{p}": f"HGT:{p} mb", f"tmp{p}": f"TMP:{p} mb", f"rh{p}": f"RH:{p} mb",
                    f"vvel{p}": f"VVEL:{p} mb", f"u{p}": f"UGRD:{p} mb", f"v{p}": f"VGRD:{p} mb"})
        if dpt:
            out[f"dpt{p}"] = f"DPT:{p} mb"
    for p in absv:
        out[f"absv{p}"] = f"ABSV:{p} mb"
    return out


_RTMA_RAW = {
    "t2m": "TMP:2 m above ground", "td2m": "DPT:2 m above ground", "spfh2m": "SPFH:2 m above ground",
    "u10": "UGRD:10 m above ground", "v10": "VGRD:10 m above ground",
    "gust": "GUST:10 m above ground", "psfc": "PRES:surface", "hgt_sfc": "HGT:surface", "vis": "VIS:surface",
    "tcdc": "TCDC:entire atmosphere (considered as a single layer)", "ceil_agl": "CEIL:cloud ceiling",
}

SOURCES: dict[str, dict[str, Any]] = {
    "hrrr-anl": {
        "label": "HRRR analysis 3 km", "org": "NOAA/NCEP", "coverage": "CONUS",
        "note": "The HRRR's initial hour: surface, clouds, upper air and the severe parameters.",
        # The pressure-level file, not the surface one: it carries everything the
        # surface file does plus every level, and one file is one .idx per hour.
        "urls": {
            "nomads": NOMADS + "/hrrr/prod/hrrr.{ymd}/conus/hrrr.t{hh}z.wrfprsf00.grib2",
            "aws": "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{ymd}/conus/hrrr.t{hh}z.wrfprsf00.grib2",
        },
        "step": 0.05, "days": 7, "cadence": 60,
        # The Lambert grid's centre meridian and tangent latitude: the winds are
        # given along the grid's axes and are turned to north by these.
        "lov": -97.5, "latin": 38.5,
        "raw": {
            **_NCEP_COMMON, **_upper(LEVELS, dpt=True),
            "smoke_col": "COLMD:entire atmosphere (considered as a single layer)",
            "ceil_msl": "HGT:cloud ceiling", "cbase": "HGT:cloud base", "ctop_msl": "HGT:cloud top",
            "etop": "RETOP:cloud top", "vil": "VIL:entire atmosphere", "refd263": "REFD:263 K level",
            "snowc": "SNOWC:surface", "lcl_msl": "HGT:level of adiabatic condensation from sfc",
            "ushr1": "VUCSH:0-1000 m above ground", "vshr1": "VVCSH:0-1000 m above ground",
        },
    },
    "rap-anl": {
        "label": "RAP analysis 13 km", "org": "NOAA/NCEP", "coverage": "North America",
        "note": "The RAP's initial hour: coarser, but the widest -- and the one with precipitation type.",
        "urls": {
            "nomads": NOMADS + "/rap/prod/rap.{ymd}/rap.t{hh}z.awp130pgrbf00.grib2",
            "aws": "https://noaa-rap-pds.s3.amazonaws.com/rap.{ymd}/rap.t{hh}z.awp130pgrbf00.grib2",
        },
        "step": 0.13, "days": 7, "cadence": 60,
        "lov": -95.0, "latin": 25.0,
        # Absolute vorticity only at 500 mb in this file; the other levels are
        # worked out from the wind.
        "raw": {
            **_NCEP_COMMON, **_upper((500,), dpt=False),
            "etop": "RETOP:entire atmosphere (considered as a single layer)",
            "prate": "PRATE:surface", "aod": "AOTK:entire atmosphere (considered as a single layer)",
            "crain": "CRAIN:surface", "csnow": "CSNOW:surface", "cicep": "CICEP:surface", "cfrzr": "CFRZR:surface",
        },
    },
    "rtma2p5": {
        "label": "RTMA 2.5 km", "org": "NOAA/NCEP", "coverage": "CONUS",
        "note": "Surface analysis fitted to the observations, hourly -- the finest surface analysis there is.",
        "urls": {
            "nomads": NOMADS + "/rtma/prod/rtma2p5.{ymd}/rtma2p5.t{hh}z.2dvaranl_ndfd.grb2_wexp",
            "aws": "https://noaa-rtma-pds.s3.amazonaws.com/rtma2p5.{ymd}/rtma2p5.t{hh}z.2dvaranl_ndfd.grb2_wexp",
        },
        # Drawn on a 0.05 degree grid (5 km): at any zoom a whole-country field is
        # read at, the eye cannot tell it from the 2.5 km original.
        "step": 0.05, "days": 7, "cadence": 60,
        "lov": -95.0, "latin": 25.0,
        "raw": _RTMA_RAW,
    },
    "rtma-ru": {
        "label": "RTMA Rapid Update 2.5 km", "org": "NOAA/NCEP", "coverage": "CONUS",
        "note": "The same surface analysis every 15 minutes: four frames an hour on the timeline.",
        "urls": {
            "nomads": NOMADS + "/rtma/prod/rtma2p5_ru.{ymd}/rtma2p5_ru.t{hh}{mm}z.2dvaranl_ndfd.grb2",
            "aws": "https://noaa-rtma-pds.s3.amazonaws.com/rtma2p5_ru.{ymd}/rtma2p5_ru.t{hh}{mm}z.2dvaranl_ndfd.grb2",
        },
        "step": 0.05, "days": 7, "cadence": 15,
        # The same 2345 x 1597 Lambert grid as the hourly RTMA: one mapping serves both.
        "grid": "rtma2p5",
        "lov": -95.0, "latin": 25.0,
        "raw": _RTMA_RAW,
    },
}

# u and v travel together: fetched side by side and turned from grid to north
# at once, because neither component means anything alone.
PAIRS: dict[str, str] = {
    "u10": "v10", "u80": "v80", "ushr6": "vshr6", "ushr1": "vshr1", "ustm": "vstm",
    **{f"u{p}": f"v{p}" for p in LEVELS},
}

OMEGA = 7.2921e-5
EARTH_R = 6371000.0


# ---------------------------------------------------------------------------
# Derived variables. Each function takes `get`, which hands back any variable
# by name (raw or derived) and carries the drawing grid as `get.grid` =
# (lats north->south, lons west->east, step in degrees).
# ---------------------------------------------------------------------------
def _es_hpa(t_k: np.ndarray) -> np.ndarray:
    """Saturation vapour pressure over water (Bolton 1980), hPa."""
    tc = t_k - 273.15
    return 6.112 * np.exp(17.67 * tc / (tc + 243.5))


def _rh(get) -> np.ndarray:
    return np.clip(100.0 * _es_hpa(get("td2m")) / _es_hpa(get("t2m")), 0.0, 100.0)


def _theta_e(get) -> np.ndarray:
    """Bolton's (1980) equivalent potential temperature at 2 m, K."""
    t, td, p = get("t2m").astype(np.float64), get("td2m").astype(np.float64), get("psfc") / 100.0
    e = _es_hpa(td)
    r = 622.0 * e / np.maximum(p - e, 1.0)  # g/kg
    tl = 1.0 / (1.0 / (td - 56.0) + np.log(t / td) / 800.0) + 56.0
    return t * (1000.0 / p) ** (0.2854 * (1.0 - 0.00028 * r)) * np.exp((3.376 / tl - 0.00254) * r * (1.0 + 0.00081 * r))


def _feels(get) -> np.ndarray:
    """The NWS wind chill below 50 F with a wind, heat index from 80 F; the air
    temperature between. Worked in F, returned in K like every other variable."""
    tf = get("t2m").astype(np.float64) * 9.0 / 5.0 - 459.67
    rh = _rh(get).astype(np.float64)
    mph = np.hypot(get("u10"), get("v10")).astype(np.float64) * 2.236936

    v16 = np.power(np.maximum(mph, 0.0), 0.16)
    chill = 35.74 + 0.6215 * tf - 35.75 * v16 + 0.4275 * tf * v16

    simple = 0.5 * (tf + 61.0 + (tf - 68.0) * 1.2 + rh * 0.094)
    full = (-42.379 + 2.04901523 * tf + 10.14333127 * rh - 0.22475541 * tf * rh
            - 6.83783e-3 * tf * tf - 5.481717e-2 * rh * rh + 1.22874e-3 * tf * tf * rh
            + 8.5282e-4 * tf * rh * rh - 1.99e-6 * tf * tf * rh * rh)
    dry = (rh < 13) & (tf >= 80) & (tf <= 112)
    full = np.where(dry, full - ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(tf - 95.0)) / 17, 0, None)), full)
    humid = (rh > 85) & (tf >= 80) & (tf <= 87)
    full = np.where(humid, full + ((rh - 85) / 10) * ((87 - tf) / 5), full)
    heat = np.where((simple + tf) / 2.0 >= 80.0, full, simple)

    out = np.where((tf <= 50.0) & (mph >= 3.0), chill, np.where(tf >= 80.0, heat, tf))
    return (out + 459.67) * 5.0 / 9.0


def _wet_bulb(get) -> np.ndarray:
    """Stull's (2011) wet-bulb temperature from 2 m temperature and humidity, K.
    Good to about a degree for ordinary surface air."""
    t = get("t2m").astype(np.float64) - 273.15
    rh = np.clip(_rh(get).astype(np.float64), 1.0, 100.0)
    tw = (t * np.arctan(0.151977 * np.sqrt(rh + 8.313659)) + np.arctan(t + rh) - np.arctan(rh - 1.676331)
          + 0.00391838 * rh ** 1.5 * np.arctan(0.023101 * rh) - 4.686035)
    return tw + 273.15


def _mixing_ratio(get) -> np.ndarray:
    q = get("spfh2m")
    return q / np.maximum(1.0 - q, 1e-6)


def _vpd(get) -> np.ndarray:
    """Vapour pressure deficit at 2 m, hPa: how hard the air pulls water out of fuel."""
    return np.maximum(_es_hpa(get("t2m")) - _es_hpa(get("td2m")), 0.0)


def _ffwi(get) -> np.ndarray:
    """Fosberg Fire Weather Index (Fosberg 1978) from 2 m temperature and
    humidity and 10 m wind."""
    tf = get("t2m").astype(np.float64) * 9.0 / 5.0 - 459.67
    h = _rh(get).astype(np.float64)
    u = np.hypot(get("u10"), get("v10")).astype(np.float64) * 2.236936
    m = np.where(h < 10, 0.03229 + 0.281073 * h - 0.000578 * h * tf,
                 np.where(h <= 50, 2.22749 + 0.160107 * h - 0.01478 * tf,
                          21.0606 + 0.005565 * h * h - 0.00035 * h * tf - 0.483199 * h))
    x = np.clip(m, 0.0, 30.0) / 30.0
    eta = 1.0 - 2.0 * x + 1.5 * x * x - 0.5 * x ** 3
    return np.clip(eta * np.sqrt(1.0 + u * u) / 0.3002, 0.0, 100.0)


def _hdw(get) -> np.ndarray:
    """Hot-Dry-Windy Index from the surface: VPD (hPa) times wind speed (m/s).
    The published index takes the worst of the lowest 500 m; this is its
    surface reading, so it runs low on a mixed afternoon."""
    return _vpd(get) * np.hypot(get("u10"), get("v10"))


def _sigma(step: float, km: float) -> float:
    return max(1.0, km / (111.0 * step))


def _derivs(a: np.ndarray, grid, km: float):
    """(smoothed field, d/dx, d/dy, finite mask) on the lat/lon drawing grid.

    Smoothed first: fields reach this grid by nearest neighbour, and
    differencing the repeated and skipped cells that leaves would draw the
    sampling instead of the weather.
    """
    lats, _lons, step = grid
    good = np.isfinite(a)
    fill = np.where(good, a, float(np.nanmean(a[good])) if good.any() else 0.0)
    s = gaussian_filter(fill.astype(np.float64), _sigma(step, km), mode="nearest")
    phi = np.radians(lats)[:, None]
    d = math.radians(step)
    ddx = np.gradient(s, axis=1) / (EARTH_R * np.cos(phi) * d)
    # Rows run north to south, so a step down the array is a step south.
    ddy = -np.gradient(s, axis=0) / (EARTH_R * d)
    return s, ddx, ddy, good


def _vort_from_absv(p: int) -> Callable:
    def fn(get):
        lats = get.grid[0]
        return get(f"absv{p}") - (2.0 * OMEGA * np.sin(np.radians(lats)))[:, None]
    return fn


def _vort_from_wind(p) -> Callable:
    def fn(get):
        lats = get.grid[0]
        u, dudx, dudy, gu = _derivs(get(f"u{p}"), get.grid, 10.0)
        v, dvdx, dvdy, gv = _derivs(get(f"v{p}"), get.grid, 10.0)
        out = dvdx - dudy + u * np.tan(np.radians(lats))[:, None] / EARTH_R
        return np.where(gu & gv, out, np.nan)
    return fn


def _divergence(p) -> Callable:
    def fn(get):
        lats = get.grid[0]
        u, dudx, _, gu = _derivs(get(f"u{p}"), get.grid, 15.0)
        v, _, dvdy, gv = _derivs(get(f"v{p}"), get.grid, 15.0)
        out = dudx + dvdy - v * np.tan(np.radians(lats))[:, None] / EARTH_R
        return np.where(gu & gv, out, np.nan)
    return fn


def _temp_advection(p) -> Callable:
    def fn(get):
        _, dtdx, dtdy, gt = _derivs(get(f"tmp{p}"), get.grid, 20.0)
        u, v = get(f"u{p}"), get(f"v{p}")
        return np.where(gt, -(u * dtdx + v * dtdy), np.nan)  # K/s
    return fn


def _moisture_convergence(get) -> np.ndarray:
    """Surface moisture flux convergence, -div(q V), kg/kg per second."""
    q, dqdx, dqdy, gq = _derivs(_mixing_ratio(get), get.grid, 25.0)
    lats = get.grid[0]
    u, dudx, _, gu = _derivs(get("u10"), get.grid, 25.0)
    v, _, dvdy, gv = _derivs(get("v10"), get.grid, 25.0)
    div = dudx + dvdy - v * np.tan(np.radians(lats))[:, None] / EARTH_R
    return np.where(gq & gu & gv, -(u * dqdx + v * dqdy) - q * div, np.nan)


def _dewpoint_from_rh(p) -> Callable:
    def fn(get):
        e = np.clip(get(f"rh{p}"), 1.0, 100.0) / 100.0 * _es_hpa(get(f"tmp{p}"))
        ln = np.log(e / 6.112)
        return 243.5 * ln / (17.67 - ln) + 273.15
    return fn


def _lapse(lower: int, upper: int) -> Callable:
    def fn(get):
        dz = (get(f"hgt{upper}") - get(f"hgt{lower}")) / 1000.0
        return (get(f"tmp{lower}") - get(f"tmp{upper}")) / np.maximum(dz, 0.1)
    return fn


def _above_ground(msl: str) -> Callable:
    return lambda get: np.maximum(get(msl) - get("hgt_sfc"), 0.0)


def _parcel_height(msl: str) -> Callable:
    """An LFC or EL is only a height where a parcel has one to reach."""
    return lambda get: np.where(get("mucape") >= 25.0, np.maximum(get(msl) - get("hgt_sfc"), 0.0), np.nan)


def _stp(get) -> np.ndarray:
    """Significant Tornado Parameter, fixed layer (Thompson et al. 2003)."""
    cape = get("sbcape") / 1500.0
    lcl = np.clip((2000.0 - get("lcl")) / 1000.0, 0.0, 1.0)
    srh = get("srh1") / 150.0
    shr = get("shr6")
    shear = np.where(shr < 12.5, 0.0, np.minimum(shr, 30.0) / 20.0)
    return cape * lcl * srh * shear


def _scp(get) -> np.ndarray:
    """Supercell Composite Parameter on fixed layers, with the MUCIN term."""
    shr = get("shr6")
    shear = np.where(shr < 10.0, 0.0, np.minimum(shr, 20.0) / 20.0)
    cin = get("mucin")
    cin_term = np.where(cin > -40.0, 1.0, -40.0 / np.minimum(cin, -40.0))
    return (get("mucape") / 1000.0) * (get("srh3") / 50.0) * shear * cin_term


def _ship(get) -> np.ndarray:
    """Significant Hail Parameter (SPC). The most-unstable parcel's mixing ratio
    is not in the files; the 2 m mixing ratio stands in for it."""
    mucape = get("mucape")
    mr = np.clip(_mixing_ratio(get) * 1000.0, 11.0, 13.6)
    lr = get("lr75")
    t500 = np.minimum(get("tmp500") - 273.15, -5.5)
    shr = np.clip(get("shr6"), 7.0, 27.0)
    ship = mucape * mr * lr * -t500 * shr / 42_000_000.0
    ship = np.where(mucape < 1300.0, ship * mucape / 1300.0, ship)
    ship = np.where(lr < 5.8, ship * lr / 5.8, ship)
    frz = get("frz_msl") - get("hgt_sfc")
    ship = np.where(frz < 2400.0, ship * np.maximum(frz, 0.0) / 2400.0, ship)
    return ship


def _ptype(get) -> np.ndarray:
    """Precipitation type coded onto its reflectivity: 0-100 rain, 100-200 snow,
    200-300 sleet, 300-400 freezing rain. Where several are flagged the more
    dangerous wins, the way a forecaster would read it."""
    dbz = get("refd1km")
    base = np.where(get("cfrzr") > 0.5, 300.0,
                    np.where(get("cicep") > 0.5, 200.0,
                             np.where(get("csnow") > 0.5, 100.0,
                                      np.where(get("crain") > 0.5, 0.0, np.nan))))
    return np.where(np.isfinite(base) & (dbz >= 5.0), base + np.clip(dbz, 0.0, 75.0), np.nan)


def _speed(u: str, v: str) -> Callable:
    return lambda get: np.hypot(get(u), get(v))


# name -> ways to make it, tried in order; the first whose ingredients the
# source can supply is the one used.
Recipe = tuple[tuple[str, ...], Callable]
DERIVED: dict[str, list[Recipe]] = {
    "rh2m": [(("t2m", "td2m"), _rh)],
    "thetae2m": [(("t2m", "td2m", "psfc"), _theta_e)],
    "feels": [(("t2m", "td2m", "u10", "v10"), _feels)],
    "wetbulb2m": [(("t2m", "td2m"), _wet_bulb)],
    "dpd2m": [(("t2m", "td2m"), lambda get: get("t2m") - get("td2m"))],
    "mixr2m": [(("spfh2m",), _mixing_ratio)],
    "vpd2m": [(("t2m", "td2m"), _vpd)],
    "ffwi": [(("t2m", "td2m", "u10", "v10"), _ffwi)],
    "hdw": [(("t2m", "td2m", "u10", "v10"), _hdw)],
    "mfc": [(("spfh2m", "u10", "v10"), _moisture_convergence)],
    "wspd10": [(("u10", "v10"), _speed("u10", "v10"))],
    "wspd80": [(("u80", "v80"), _speed("u80", "v80"))],
    "shr6": [(("ushr6", "vshr6"), _speed("ushr6", "vshr6"))],
    "shr1": [(("ushr1", "vshr1"), _speed("ushr1", "vshr1"))],
    "stmspd": [(("ustm", "vstm"), _speed("ustm", "vstm"))],
    "thick": [(("hgt1000", "hgt500"), lambda get: get("hgt500") - get("hgt1000"))],
    "lr75": [(("tmp700", "tmp500", "hgt700", "hgt500"), _lapse(700, 500))],
    "lr85": [(("tmp850", "tmp500", "hgt850", "hgt500"), _lapse(850, 500))],
    # The model's own parcel LCL where the file has it, Espy's 125 m per degree
    # of dew point depression where it does not.
    "lcl": [(("lcl_msl", "hgt_sfc"), _above_ground("lcl_msl")),
            (("t2m", "td2m"), lambda get: 125.0 * (get("t2m") - get("td2m")))],
    "lfc": [(("lfc_msl", "hgt_sfc", "mucape"), _parcel_height("lfc_msl"))],
    "el": [(("el_msl", "hgt_sfc", "mucape"), _parcel_height("el_msl"))],
    "ceil": [(("ceil_agl",), lambda get: np.where(get("ceil_agl") < 15999.0, get("ceil_agl"), np.nan)),
             (("ceil_msl", "hgt_sfc"), _above_ground("ceil_msl"))],
    "etop_m": [(("etop",), lambda get: np.where(get("etop") > 0.0, get("etop"), np.nan))],
    "stp": [(("sbcape", "lcl", "srh1", "shr6"), _stp)],
    "scp": [(("mucape", "mucin", "srh3", "shr6"), _scp)],
    "ehi1": [(("sbcape", "srh1"), lambda get: get("sbcape") * get("srh1") / 160000.0)],
    "ehi3": [(("sbcape", "srh3"), lambda get: get("sbcape") * get("srh3") / 160000.0)],
    "craven": [(("mlcape", "shr6"), lambda get: get("mlcape") * get("shr6"))],
    "ship": [(("mucape", "spfh2m", "lr75", "tmp500", "shr6", "frz_msl", "hgt_sfc"), _ship)],
    "ptype": [(("refd1km", "crain", "csnow", "cicep", "cfrzr"), _ptype)],
    **{f"wspd{p}": [((f"u{p}", f"v{p}"), _speed(f"u{p}", f"v{p}"))] for p in LEVELS},
    **{f"dpt{p}": [((f"tmp{p}", f"rh{p}"), _dewpoint_from_rh(p))] for p in LEVELS},
    **{f"vort{p}": [((f"absv{p}",), _vort_from_absv(p)), ((f"u{p}", f"v{p}"), _vort_from_wind(p))] for p in LEVELS},
    **{f"div{p}": [((f"u{p}", f"v{p}"), _divergence(p))] for p in LEVELS},
    **{f"tadv{p}": [((f"tmp{p}", f"u{p}", f"v{p}"), _temp_advection(p))] for p in LEVELS},
}

_RECIPES: dict[tuple[str, str], Optional[tuple[str, Optional[Callable], tuple[str, ...]]]] = {}


def recipe(source: str, name: str) -> Optional[tuple[str, Optional[Callable], tuple[str, ...]]]:
    """How `source` gets `name`: ("raw", None, ()) or ("derived", fn, deps), or
    None when it cannot. Raw wins over derived."""
    key = (source, name)
    if key in _RECIPES:
        return _RECIPES[key]
    _RECIPES[key] = None  # a cycle resolves to "cannot", not to recursion
    out = None
    if name in SOURCES[source]["raw"]:
        out = ("raw", None, ())
    else:
        for deps, fn in DERIVED.get(name, []):
            if all(recipe(source, d) is not None for d in deps):
                out = ("derived", fn, deps)
                break
    _RECIPES[key] = out
    return out


def needs(source: str, name: str) -> Optional[set[str]]:
    """The raw variables `name` comes down to in `source`, or None."""
    r = recipe(source, name)
    if r is None:
        return None
    if r[0] == "raw":
        return {name}
    out: set[str] = set()
    for d in r[2]:
        out |= needs(source, d) or set()
    return out


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
CONVERT: dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "K->F": lambda v: v * 9.0 / 5.0 - 459.67,
    "K->C": lambda v: v - 273.15,
    "dK->dF": lambda v: v * 9.0 / 5.0,
    "ms->mph": lambda v: v * 2.236936,
    "ms->kt": lambda v: v * 1.943844,
    "Pa->hPa": lambda v: v / 100.0,
    "Pas->ubs": lambda v: v * 10.0,
    "m->mi": lambda v: v / 1609.344,
    "m->in": lambda v: v * 39.37008,
    "m->ft": lambda v: v * 3.28084,
    "m->kft": lambda v: v * 3.28084 / 1000.0,
    "gpm->dam": lambda v: v / 10.0,
    "kgm3->ugm3": lambda v: v * 1e9,
    "kgm2->mgm2": lambda v: v * 1e6,
    "kgm2->in": lambda v: v * 0.0393701,
    "kgm2s->inhr": lambda v: v * 141.732,
    "kgkg->gkg": lambda v: v * 1000.0,
    "kgkgs->gkghr": lambda v: v * 1000.0 * 3600.0,
    "Ks->Chr": lambda v: v * 3600.0,
    "s-1->1e-5": lambda v: v * 1e5,
    "x1e-3": lambda v: v / 1000.0,
}


def _ptype_text(v: float) -> str:
    kind = int(min(max(v // 100, 0), 3))
    return f"{PTYPE_NAMES[kind]} · {round(v - kind * 100)} dBZ"


FORMATS: dict[str, Callable[[float], str]] = {"ptype": _ptype_text}


def _p(label: str, group: str, shade: str, unit: str, palette: list, *, sub: Optional[str] = None,
       convert: Optional[str] = None, lines: Optional[dict] = None, barbs: Optional[tuple[str, str]] = None,
       smooth_km: float = 0.0, decimals: int = 0, stepped: bool = False, note: str = "",
       fmt: Optional[str] = None, labels: Optional[list[dict]] = None, lut_steps: int = 256) -> dict:
    return {"label": label, "group": group, "sub": sub, "shade": shade, "unit": unit, "palette": palette,
            "convert": convert, "lines": lines, "barbs": barbs, "smooth_km": smooth_km,
            "decimals": decimals, "stepped": stepped, "note": note, "fmt": fmt, "labels": labels,
            "lut_steps": lut_steps}


def own(step: float, lo: Optional[float] = None, hi: Optional[float] = None) -> dict:
    """Contours of the shaded field itself."""
    return {"var": None, "step": step, "lo": lo, "hi": hi}


MSLP_LINES = {"var": "mslp", "convert": "Pa->hPa", "unit": "hPa", "step": 4.0, "lo": None, "hi": None}
HEIGHT_STEP = {925: 3.0, 850: 3.0, 700: 3.0, 500: 6.0, 300: 12.0, 250: 12.0, 200: 12.0}


def heights(p: int) -> dict:
    return {"var": f"hgt{p}", "convert": "gpm->dam", "unit": "dam", "step": HEIGHT_STEP[p], "lo": None, "hi": None}


def wind(p) -> tuple[str, str]:
    return (f"u{p}", f"v{p}")


W10 = wind(10)
S, UA, SV = "Surface", "Upper-Air", "Severe Weather"

PRODUCTS: dict[str, dict[str, Any]] = {
    # ----- Surface: temperature
    "t2m": _p("2m Temperature", S, "t2m", "°F", TEMP_F, sub="Temperature", convert="K->F", lines=own(5)),
    "t2m_wind": _p("2m Temperature + Wind", S, "t2m", "°F", TEMP_F, sub="Temperature", convert="K->F",
                   lines=own(5), barbs=W10),
    "t2m_wind_mslp": _p("2m Temperature + Wind + MSLP", S, "t2m", "°F", TEMP_F, sub="Temperature",
                        convert="K->F", lines=MSLP_LINES, barbs=W10),
    "feels": _p("2m Wind Chill / Heat Index", S, "feels", "°F", TEMP_F, sub="Temperature", convert="K->F",
                lines=own(5), note="Wind chill below 50 °F with a wind, heat index from 80 °F, the air temperature between."),
    "wetbulb": _p("2m Wet-Bulb Temperature", S, "wetbulb2m", "°F", TEMP_F, sub="Temperature", convert="K->F",
                  lines=own(5), note="Stull (2011) from temperature and humidity: the coldest evaporation can make the air."),
    "tskin": _p("Skin Temperature", S, "tskin", "°F", TEMP_F, sub="Temperature", convert="K->F", lines=own(10),
                note="The ground and water surface itself, not the air above it."),
    # ----- Surface: moisture
    "td2m": _p("2m Dewpoint", S, "td2m", "°F", DEW_F, sub="Moisture", convert="K->F", lines=own(5)),
    "td2m_wind": _p("2m Dewpoint + Wind", S, "td2m", "°F", DEW_F, sub="Moisture", convert="K->F",
                    lines=own(5), barbs=W10),
    "dpd2m": _p("2m Dewpoint Depression", S, "dpd2m", "°F", DPD_F, sub="Moisture", convert="dK->dF", lines=own(10)),
    "rh2m": _p("2m Relative Humidity", S, "rh2m", "%", RH_PCT, sub="Moisture", lines=own(10)),
    "mixr2m": _p("2m Mixing Ratio", S, "mixr2m", "g/kg", MIXR_GKG, sub="Moisture", convert="kgkg->gkg", lines=own(2)),
    "thetae": _p("2m Theta-E", S, "thetae2m", "K", THETAE_K, sub="Moisture", lines=own(5),
                 note="Equivalent potential temperature (Bolton 1980): heat and moisture in one number."),
    "thetae_wind": _p("2m Theta-E + Wind", S, "thetae2m", "K", THETAE_K, sub="Moisture", lines=own(5), barbs=W10),
    "pwat": _p("Precipitable Water", S, "pwat", "in", PWAT_IN, sub="Moisture", convert="kgm2->in",
               lines=own(0.5, lo=1.0), decimals=2),
    "mfc": _p("Surface Moisture Convergence + Wind", S, "mfc", "g/kg/h", MFC_GKGHR, sub="Moisture",
              convert="kgkgs->gkghr", barbs=W10, decimals=1, smooth_km=15.0,
              note="Where the surface wind piles moisture up -- the classic first sign of initiation."),
    # ----- Surface: wind
    "wind10m": _p("10m Wind", S, "wspd10", "mph", WIND_MPH, sub="Wind", convert="ms->mph", lines=own(10), barbs=W10),
    "wind10m_mslp": _p("10m Wind + MSLP", S, "wspd10", "mph", WIND_MPH, sub="Wind", convert="ms->mph",
                       lines=MSLP_LINES, barbs=W10),
    "gust": _p("10m Wind Gusts", S, "gust", "mph", WIND_MPH, sub="Wind", convert="ms->mph", lines=own(10)),
    "wind80m": _p("80m Wind", S, "wspd80", "mph", WIND_MPH, sub="Wind", convert="ms->mph", lines=own(10),
                  barbs=wind(80), note="Hub height: the wind a turbine -- or a low-level jet at dusk -- feels."),
    # ----- Surface: pressure
    "mslp": _p("Sea Level Pressure", S, "mslp", "hPa", PRES_HPA, sub="Pressure", convert="Pa->hPa", lines=own(4)),
    "psfc": _p("Surface Pressure", S, "psfc", "hPa", SFC_PRES_HPA, sub="Pressure", convert="Pa->hPa",
               note="Station pressure: it follows the terrain, so the Rockies read hundreds of hPa lower."),
    "thick_mslp": _p("1000-500mb Thickness + MSLP", S, "thick", "dam", THICK_DAM, sub="Pressure",
                     convert="gpm->dam", lines=MSLP_LINES,
                     note="Thickness is the mean temperature of the lower half of the atmosphere; 540 dam is the old rain/snow line."),
    # ----- Clouds and visibility
    "vis": _p("Visibility", "Clouds & Visibility", "vis", "mi", VIS_MI, convert="m->mi", decimals=1),
    "ceil": _p("Cloud Ceiling", "Clouds & Visibility", "ceil", "ft", CEIL_FT, convert="m->ft",
               note="Height above ground of the lowest broken or overcast layer; clear where there is none."),
    "tcdc": _p("Total Cloud Cover", "Clouds & Visibility", "tcdc", "%", CLOUD_PCT),
    "lcdc": _p("Low Cloud Cover", "Clouds & Visibility", "lcdc", "%", CLOUD_PCT),
    "mcdc": _p("Mid Cloud Cover", "Clouds & Visibility", "mcdc", "%", CLOUD_PCT),
    "hcdc": _p("High Cloud Cover", "Clouds & Visibility", "hcdc", "%", CLOUD_PCT),
    "cbase": _p("Cloud Base Height", "Clouds & Visibility", "cbase", "ft", CBASE_FT, convert="m->ft"),
    "ctop": _p("Cloud Top Height", "Clouds & Visibility", "ctop_msl", "kft", CTOP_KFT, convert="m->kft",
               note="Above sea level."),
    "hpbl": _p("Boundary Layer Height", "Clouds & Visibility", "hpbl", "m", PBL_M,
               note="How deep the mixed layer runs: the ceiling on how far surface air is stirred."),
    # ----- Fire and smoke
    "smoke": _p("Near-Surface Smoke", "Fire & Smoke", "smoke", "µg/m³", SMOKE_UG, convert="kgm3->ugm3",
                note="Smoke at 8 m above ground, from the HRRR/RAP smoke scheme."),
    "smoke_col": _p("Vertically Integrated Smoke", "Fire & Smoke", "smoke_col", "mg/m²", SMOKE_COL_MG,
                    convert="kgm2->mgm2", note="All the smoke in the column, surface to model top."),
    "aod": _p("Aerosol Optical Depth", "Fire & Smoke", "aod", "", AOD, decimals=2,
              note="How much the whole column dims the sun -- smoke and haze together."),
    "vpd": _p("Vapor Pressure Deficit", "Fire & Smoke", "vpd2m", "hPa", VPD_HPA, lines=own(10)),
    "ffwi": _p("Fosberg Fire Weather Index", "Fire & Smoke", "ffwi", "", FFWI_PAL,
               note="Fosberg (1978): temperature, humidity and wind; above 50 is critical."),
    "hdw": _p("Hot-Dry-Windy Index (surface)", "Fire & Smoke", "hdw", "", HDW_PAL,
              note="VPD times wind speed at the surface. The full index takes the worst of the lowest 500 m."),
    # ----- Upper air
    **{f"w{p}": _p(f"{p}mb Wind + Height", UA, f"wspd{p}", "kt", WIND_KT_LOW if p >= 700 else WIND_KT_HIGH,
                   sub="Wind", convert="ms->kt", lines=heights(p), barbs=wind(p)) for p in LEVELS},
    **{f"t{p}": _p(f"{p}mb Temperature + Wind + Height", UA, f"tmp{p}", "°C", TEMP_C, sub="Temperature",
                   convert="K->C", lines=heights(p), barbs=wind(p)) for p in (925, 850, 700, 500, 300)},
    **{f"td{p}": _p(f"{p}mb Dewpoint + Wind + Height", UA, f"dpt{p}", "°C", DEW_C, sub="Moisture",
                    convert="K->C", lines=heights(p), barbs=wind(p)) for p in (925, 850, 700)},
    **{f"rh{p}": _p(f"{p}mb Relative Humidity + Height", UA, f"rh{p}", "%", RH_PCT, sub="Moisture",
                    lines=heights(p)) for p in (850, 700, 500)},
    **{f"vort{p}": _p(f"{p}mb Cyclonic Vorticity + Height", UA, f"vort{p}", "10⁻⁵ s⁻¹", VORT_PAL,
                      sub="Vorticity", convert="s-1->1e-5", lines=heights(p), smooth_km=20.0,
                      note="Relative vorticity, shaded where it turns cyclonically.") for p in (850, 700, 500, 300)},
    **{f"omega{p}": _p(f"{p}mb Vertical Velocity + Height", UA, f"vvel{p}", "µb/s", OMEGA_UBS,
                       sub="Vertical Motion", convert="Pas->ubs", lines=heights(p), smooth_km=15.0,
                       note="Omega: negative (cool colours) is rising air.") for p in (850, 700, 500)},
    **{f"div{p}": _p(f"{p}mb Divergence + Wind + Height", UA, f"div{p}", "10⁻⁵ s⁻¹", DIV_PAL,
                     sub="Divergence", convert="s-1->1e-5", lines=heights(p), barbs=wind(p), smooth_km=25.0,
                     note="Upper-level divergence: air leaving aloft is air rising beneath.") for p in (300, 250, 200)},
    **{f"tadv{p}": _p(f"{p}mb Temperature Advection + Wind + Height", UA, f"tadv{p}", "°C/h", TADV_CHR,
                      sub="Advection", convert="Ks->Chr", lines=heights(p), barbs=wind(p), smooth_km=25.0,
                      decimals=1, note="Warm colours: the wind is carrying warmer air in.") for p in (850, 700)},
    "lr75": _p("700-500mb Lapse Rate", UA, "lr75", "°C/km", LAPSE_CKM, sub="Lapse Rates", lines=own(1, lo=7),
               decimals=1, note="Steep mid-level lapse rates (7+ °C/km) are the elevated mixed layer hail feeds on."),
    "lr85": _p("850-500mb Lapse Rate", UA, "lr85", "°C/km", LAPSE_CKM, sub="Lapse Rates", lines=own(1, lo=7),
               decimals=1),
    # ----- Precipitation
    "refc": _p("Composite Reflectivity", "Precipitation", "refc", "dBZ", REFL_DBZ, stepped=True,
               note="The model's own reflectivity at analysis time, not the radar mosaic."),
    "refd1km": _p("1 km AGL Reflectivity", "Precipitation", "refd1km", "dBZ", REFL_DBZ, stepped=True),
    "refd263": _p("-10°C Reflectivity", "Precipitation", "refd263", "dBZ", REFL_DBZ, stepped=True,
                  note="Reflectivity at the -10 °C level, where charge separation and hail growth happen."),
    "etop": _p("Echo Tops", "Precipitation", "etop_m", "kft", ETOP_KFT, convert="m->kft",
               note="Highest 18 dBZ echo, above sea level."),
    "vil": _p("Vertically Integrated Liquid", "Precipitation", "vil", "kg/m²", VIL_KGM2, decimals=1),
    "prate": _p("Precipitation Rate", "Precipitation", "prate", "in/h", PRATE_INHR, convert="kgm2s->inhr", decimals=2),
    "ptype": _p("Precipitation Type", "Precipitation", "ptype", "", PTYPE_PAL, fmt="ptype", lut_steps=1024,
                labels=[{"v": 50, "t": "Rain"}, {"v": 150, "t": "Snow"}, {"v": 250, "t": "Sleet"},
                        {"v": 350, "t": "Frz rain"}],
                note="The RAP's diagnosed type, coloured by its 1 km reflectivity."),
    # ----- Severe weather: instability
    "sbcape": _p("Surface-Based CAPE", SV, "sbcape", "J/kg", CAPE_JKG, sub="Instability", lines=own(1000, lo=1000)),
    "mlcape": _p("Mixed-Layer CAPE", SV, "mlcape", "J/kg", CAPE_JKG, sub="Instability", lines=own(1000, lo=1000),
                 note="Parcel mixed through the lowest 90 mb."),
    "mucape": _p("Most-Unstable CAPE", SV, "mucape", "J/kg", CAPE_JKG, sub="Instability", lines=own(1000, lo=1000),
                 note="The most unstable parcel in the lowest 255 mb."),
    "cape3": _p("0-3 km CAPE", SV, "cape3", "J/kg", CAPE3_JKG, sub="Instability", lines=own(100, lo=100),
                note="Low-level buoyancy: stretching near the ground, where tornadoes start."),
    "sbcin": _p("Surface-Based CIN", SV, "sbcin", "J/kg", CIN_JKG, sub="Instability"),
    "mlcin": _p("Mixed-Layer CIN", SV, "mlcin", "J/kg", CIN_JKG, sub="Instability"),
    "mucin": _p("Most-Unstable CIN", SV, "mucin", "J/kg", CIN_JKG, sub="Instability"),
    "li": _p("Surface Lifted Index", SV, "li", "°C", LI_C, sub="Instability", lines=own(2, hi=-2)),
    "bli": _p("Best Lifted Index", SV, "bli", "°C", LI_C, sub="Instability", lines=own(2, hi=-2),
              note="The most unstable of four parcels in the lowest 180 mb."),
    # ----- Severe weather: parcel heights
    "lcl": _p("LCL Height", SV, "lcl", "m", LCL_M, sub="Parcel Heights",
              note="Above ground. Below 1000 m favours tornadoes; the HRRR gives its own parcel's, RTMA uses Espy's estimate."),
    "lfc": _p("LFC Height", SV, "lfc", "m", LFC_M, sub="Parcel Heights",
              note="Above ground, most-unstable parcel; only where there is CAPE."),
    "el": _p("Equilibrium Level Height", SV, "el", "m", EL_M, sub="Parcel Heights",
             note="Above ground: roughly where an updraft's anvil spreads out."),
    "frz": _p("Freezing Level", SV, "frz_msl", "ft", FRZ_FT, sub="Parcel Heights", convert="m->ft",
              note="Height of the 0 °C isotherm above sea level."),
    # ----- Severe weather: kinematics
    "srh1": _p("0-1 km Storm-Relative Helicity", SV, "srh1", "m²/s²", SRH_M2S2, sub="Kinematics", lines=own(100, lo=100)),
    "srh3": _p("0-3 km Storm-Relative Helicity", SV, "srh3", "m²/s²", SRH_M2S2, sub="Kinematics", lines=own(100, lo=100)),
    "shr1": _p("0-1 km Bulk Shear", SV, "shr1", "kt", SHR1_KT, sub="Kinematics", convert="ms->kt",
               barbs=("ushr1", "vshr1"), lines=own(10, lo=20)),
    "shr6": _p("0-6 km Bulk Shear", SV, "shr6", "kt", SHR6_KT, sub="Kinematics", convert="ms->kt",
               barbs=("ushr6", "vshr6"), lines=own(10, lo=30),
               note="The barbs are the shear vector itself; 40 kt and up supports supercells."),
    "stm": _p("Bunkers Storm Motion", SV, "stmspd", "kt", STM_KT, sub="Kinematics", convert="ms->kt",
              barbs=("ustm", "vstm"), note="The right-moving supercell's expected motion (0-6 km)."),
    # ----- Severe weather: composites
    "stp": _p("Significant Tornado Parameter", SV, "stp", "", STP_PAL, sub="Composite", lines=own(1, lo=1),
              decimals=1, note="Fixed layer: SBCAPE, surface LCL, 0-1 km SRH, 0-6 km shear."),
    "scp": _p("Supercell Composite Parameter", SV, "scp", "", SCP_PAL, sub="Composite", lines=own(2, lo=2),
              decimals=1, note="Fixed layers standing in for effective ones: MUCAPE, 0-3 km SRH, 0-6 km shear, MUCIN."),
    "ship": _p("Significant Hail Parameter", SV, "ship", "", SHIP_PAL, sub="Composite", lines=own(1, lo=1),
               decimals=1, note="SPC's SHIP, with the 2 m mixing ratio standing in for the most-unstable parcel's."),
    "ehi1": _p("0-1 km Energy-Helicity Index", SV, "ehi1", "", EHI_PAL, sub="Composite", lines=own(1, lo=1), decimals=1),
    "ehi3": _p("0-3 km Energy-Helicity Index", SV, "ehi3", "", EHI_PAL, sub="Composite", lines=own(1, lo=1), decimals=1),
    "craven": _p("Craven-Brooks Significant Severe", SV, "craven", "10³ m³/s³", CRAVEN_PAL, sub="Composite",
                 convert="x1e-3", lines=own(20, lo=20),
                 note="MLCAPE times 0-6 km shear; 20 000 m³/s³ separates significant severe from the rest."),
    # ----- Winter
    "snod": _p("Snow Depth", "Winter Weather", "snod", "in", SNOW_IN, convert="m->in", decimals=1),
    "swe": _p("Snow Water Equivalent", "Winter Weather", "weasd", "in", SWE_IN, convert="kgm2->in", decimals=2),
    "snowc": _p("Snow Cover", "Winter Weather", "snowc", "%", SNOWC_PCT),
}
