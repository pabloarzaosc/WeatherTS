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

# A new colour every few degrees where the weather usually is: with eleven stops
# across 150 degrees, a valley at 74 and a range at 45 were both a yellow-green
# (Pablo, 2026-09-23, against another viewer's 2 m temperature). Blue for the
# 40s, teal in the 50s, green at 60, yellow at 70, orange at 80, red past 90.
TEMP_F = [
    (-40, "#f6ddfb"), (-25, "#dc9ced"), (-10, "#b25ad6"), (0, "#7d38c0"), (10, "#4c2fa8"),
    (20, "#26359c"), (30, "#2152c4"), (38, "#2a74dc"), (46, "#2f9ad0"), (52, "#35ae9c"),
    (57, "#4cba62"), (62, "#8cc83a"), (66, "#c4d62e"), (70, "#f0cf24"), (75, "#f2a61e"),
    (80, "#ee7c1c"), (86, "#e2511c"), (92, "#c9281e"), (98, "#9e1422"), (105, "#7a0e3a"),
    (112, "#a0206e"), (120, "#d060b0"),
]
# The same colours at the same temperatures, in Celsius, and colder for aloft.
TEMP_C = [(-60, "#fdf6fe"), (-50, "#f9e9fc")] + [(round((f - 32) * 5 / 9, 2), c) for f, c in TEMP_F]
DEW_F = [
    (-20, "#5a3a22"), (0, "#7a5230"), (20, "#a07a4a"), (30, "#b89868"), (40, "#d2c08e"),
    (45, "#b8cf8a"), (50, "#86c06a"), (55, "#4fae52"), (60, "#2f9448"), (64, "#23866c"),
    (68, "#2280a0"), (72, "#2a62b8"), (76, "#4a3fb0"), (80, "#7a2fa8"), (85, "#a8309a"),
]
DEW_C = [(round((f - 32) * 5 / 9, 2), c) for f, c in DEW_F]
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
# Probability: nothing under 5 %, then the usual ramp.
PROB_PCT = [(0, T0), (5, T0), (10, "#9ed1f0"), (20, "#5cbf5c"), (30, "#a9d34c"), (40, "#f2d23c"), (50, "#f0a83c"),
            (60, "#e4552e"), (70, "#c02a5a"), (80, "#8e2a9e"), (90, "#e0b0f0")]
ICE_IN = [(0, T0), (0.01, T0), (0.05, "#f0b8d8"), (0.1, "#e080b8"), (0.25, "#c04a98"), (0.5, "#8e2a7e"), (1, "#5a1a50")]
# Saffir-Simpson, by maximum wind in knots: depression, storm, categories 1-5.
SS_KT = [(0, "#9ed1f0"), (34, "#5cbf5c"), (64, "#f2d23c"), (83, "#f0a83c"), (96, "#e4552e"), (113, "#c02a5a"),
         (137, "#8e2a9e"), (170, "#8e2a9e")]
SS_LABELS = [{"v": 17, "t": "TD"}, {"v": 49, "t": "TS"}, {"v": 73, "t": "1"}, {"v": 89, "t": "2"},
             {"v": 104, "t": "3"}, {"v": 125, "t": "4"}, {"v": 153, "t": "5"}]
QPF_IN = [
    (0, T0), (0.01, T0), (0.05, "#b6e3a8"), (0.1, "#7cc86a"), (0.25, "#3f9b3f"), (0.5, "#2f7fb8"),
    (0.75, "#3b4fb0"), (1, "#6b4ab8"), (1.5, "#b04ab0"), (2, "#d6452e"), (3, "#f0a83c"), (5, "#f2e23c"), (8, "#ffffff"),
]
FRZR_IN = [(0, T0), (0.01, T0), (0.05, "#f0b8d8"), (0.1, "#e080b8"), (0.25, "#c04a98"), (0.5, "#8e2a7e"), (1, "#5a1a50")]
UH_M2S2 = [(0, T0), (25, T0), (50, "#9ed1f0"), (75, "#5cbf5c"), (100, "#f2d23c"), (150, "#f0a83c"),
           (200, "#e4552e"), (300, "#c02a5a"), (400, "#8e2a9e")]
UH_LOW_M2S2 = [(0, T0), (10, T0), (25, "#9ed1f0"), (50, "#5cbf5c"), (75, "#f2d23c"), (100, "#f0a83c"),
               (150, "#e4552e"), (200, "#8e2a9e")]
HAIL_IN = [(0, T0), (0.25, T0), (0.5, "#9ed1f0"), (0.75, "#5cbf5c"), (1, "#f2d23c"), (1.5, "#f0a83c"),
           (2, "#e4552e"), (2.5, "#c02a5a"), (3, "#8e2a9e")]
LTNG_PAL = [(0, T0), (0.05, T0), (0.1, "#9ed1f0"), (0.5, "#5cbf5c"), (1, "#f2d23c"), (2, "#f0a83c"),
            (4, "#e4552e"), (8, "#8e2a9e")]
UVV_MS = [(0, T0), (5, T0), (10, "#9ed1f0"), (20, "#5cbf5c"), (30, "#f2d23c"), (40, "#f0a83c"), (50, "#e4552e"),
          (70, "#8e2a9e")]
RELV_PAL = [(0, T0), (2, T0), (4, "#9ed1f0"), (6, "#5cbf5c"), (8, "#f2d23c"), (10, "#f0a83c"), (15, "#e4552e"),
            (20, "#8e2a9e")]
# Brightness temperature: grey for the ground and low cloud, colour only for
# the cold tops a satellite loop is watched for.
IR_C = [(-90, "#ffffff"), (-80, "#8e2a9e"), (-70, "#c02a5a"), (-60, "#e4552e"), (-50, "#f2d23c"),
        (-40, "#5cbf5c"), (-31, "#3d6fcf"), (-30, "#d8dce2"), (10, "#5a606a"), (40, "#16181c")]
WV_C = [(-80, "#ffffff"), (-60, "#3d6fcf"), (-45, "#9ed1f0"), (-35, "#e8eef6"), (-25, "#8a8f99"),
        (-15, "#f2a83c"), (-5, "#7a4a20")]

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


def _without(base: dict[str, str], *drop: str) -> dict[str, str]:
    """The shared vocabulary less what a particular file does not carry.

    Every NCEP file names its records the same way, so a source is mostly the
    common set; what differs is what is absent. Naming the absences keeps the
    catalogue honest -- a product is offered only where its ingredients really
    exist -- and each list was read off that file's own .idx.
    """
    return {k: v for k, v in base.items() if k not in drop}


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
        "step": 0.03, "days": 7, "cadence": 60,
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
            # The initial hour's simulated satellite ("anl" in the .idx): every
            # hour of the week, where a run's own forecast only looks ahead.
            "sbt124": "SBT124:top of atmosphere", "sbt123": "SBT123:top of atmosphere",
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
            "sbt124": "SBT124:top of atmosphere", "sbt123": "SBT123:top of atmosphere",
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
        "step": 0.03, "days": 7, "cadence": 60,
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
        "step": 0.03, "days": 7, "cadence": 15,
        # The same 2345 x 1597 Lambert grid as the hourly RTMA: one mapping serves both.
        "grid": "rtma2p5",
        "lov": -95.0, "latin": 25.0,
        "raw": _RTMA_RAW,
    },
    "gfs-anl": {
        "label": "GFS analysis 0.25°", "org": "NOAA/NCEP", "coverage": "Global",
        "note": "The GFS's initial hour, every six hours -- the only analysis here that covers the whole world.",
        "urls": {
            "nomads": NOMADS + "/gfs/prod/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f000",
            "aws": "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f000",
        },
        # A plain lat/lon grid, so no "lov": its winds already point east and north.
        "step": 0.25, "days": 7, "cadence": 360,
        "raw": {
            **_without(
                {**_NCEP_COMMON, **_upper((500,), dpt=False)},
                "bli", "cape3", "el_msl", "lfc_msl", "li", "smoke",
                "srh1", "ushr6", "vshr6", "ustm", "vstm",
            ),
            "mslp": "PRMSL:mean sea level",
        },
    },
    "nam-anl": {
        "label": "NAM analysis 12 km", "org": "NOAA/NCEP", "coverage": "North America",
        "note": "The NAM's initial hour, every six hours: a second opinion beside the RAP, reaching further south.",
        "urls": {
            "nomads": NOMADS + "/nam/prod/nam.{ymd}/nam.t{hh}z.awphys00.tm00.grib2",
            "aws": "https://noaa-nam-pds.s3.amazonaws.com/nam.{ymd}/nam.t{hh}z.awphys00.tm00.grib2",
        },
        "step": 0.11, "days": 7, "cadence": 360,
        "lov": -95.0, "latin": 25.0,
        "raw": {
            **_without(
                {**_NCEP_COMMON, **_upper((500,), dpt=False)},
                "cape3", "el_msl", "hcdc", "lcdc", "lfc_msl", "mcdc",
                "mlcape", "mlcin", "mucape", "mucin", "smoke", "srh1", "ustm", "vstm",
            ),
            "mslp": "PRMSL:mean sea level",
            # Both NAM files spell these the long way.
            "refc": "REFC:entire atmosphere (considered as a single layer)",
            "tcdc": "TCDC:entire atmosphere (considered as a single layer)",
        },
    },
    "nam3-anl": {
        "label": "NAM Nest analysis 3 km", "org": "NOAA/NCEP", "coverage": "CONUS",
        "note": "The 3 km NAM Nest's initial hour: HRRR-fine, from a different model, every six hours.",
        "urls": {
            "nomads": NOMADS + "/nam/prod/nam.{ymd}/nam.t{hh}z.conusnest.hiresf00.tm00.grib2",
            "aws": "https://noaa-nam-pds.s3.amazonaws.com/nam.{ymd}/nam.t{hh}z.conusnest.hiresf00.tm00.grib2",
        },
        "step": 0.03, "days": 7, "cadence": 360,
        "lov": -97.5, "latin": 38.5,
        "raw": {
            **_without(
                {**_NCEP_COMMON, **_upper((500,), dpt=True)},
                "cape3", "dpt200", "dpt250", "el_msl", "lfc_msl", "smoke", "ustm", "vstm",
            ),
            "mslp": "PRMSL:mean sea level",
            # Both NAM files spell these the long way.
            "refc": "REFC:entire atmosphere (considered as a single layer)",
            "tcdc": "TCDC:entire atmosphere (considered as a single layer)",
        },
    },
}


# ---------------------------------------------------------------------------
# Forecasts
# ---------------------------------------------------------------------------
def _forecast(anl: str, model: str, *, label: str, note: str, urls: dict[str, str]) -> dict[str, Any]:
    """A model's forecast hours, drawn exactly like its analysis.

    For these models the forecast files are the same family as the analysis
    one -- the same records on the same grid -- and only the hour in the file
    name moves (wrfprsf00 -> wrfprsf04). So a forecast source borrows its
    analysis twin's fields and projection, shares its regrid mapping, and adds
    the run structure: which cycles exist and how far each one runs. The hours
    come from model_sources, which already knows every model's axis.
    """
    import model_sources as ms  # the catalogue of runs; imported late to keep this module light
    base = SOURCES[anl]
    return {
        **base,
        "label": label,
        "note": note,
        "urls": urls,
        "grid": base.get("grid", anl),
        "forecast": {"cycles": tuple(ms.MODELS[model]["cycles"]), "hours": ms.forecast_hours(model)},
        # Where its products go back in time: the analysis twin, every hour of
        # the week, where a run only looks ahead (the panel's Replay).
        "replay": anl,
    }


_AWS_HRRR = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com"
_AWS_RAP = "https://noaa-rap-pds.s3.amazonaws.com"
_AWS_NAM = "https://noaa-nam-pds.s3.amazonaws.com"
_AWS_GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"

SOURCES.update({
    "hrrr-fc": {**_forecast(
        "hrrr-anl", "hrrr-3km", label="HRRR", note="Hourly 3 km runs out to 18 h, and to 48 h at 00/06/12/18Z.",
        urls={
            "nomads": NOMADS + "/hrrr/prod/hrrr.{ymd}/conus/hrrr.t{hh}z.wrfprsf{ff}.grib2",
            "aws": _AWS_HRRR + "/hrrr.{ymd}/conus/hrrr.t{hh}z.wrfprsf{ff}.grib2",
        }), "group": "Convection-allowing"},
    "nam3-fc": {**_forecast(
        "nam3-anl", "nam-3km", label="NAM Nest", note="The 3 km NAM Nest, out to 60 h four times a day.",
        urls={
            "nomads": NOMADS + "/nam/prod/nam.{ymd}/nam.t{hh}z.conusnest.hiresf{ff}.tm00.grib2",
            "aws": _AWS_NAM + "/nam.{ymd}/nam.t{hh}z.conusnest.hiresf{ff}.tm00.grib2",
        }), "group": "Convection-allowing"},
    "rap-fc": {**_forecast(
        "rap-anl", "rap-13km", label="RAP", note="Hourly 13 km runs over North America, out to 51 h four times a day.",
        urls={
            "nomads": NOMADS + "/rap/prod/rap.{ymd}/rap.t{hh}z.awp130pgrbf{ff}.grib2",
            "aws": _AWS_RAP + "/rap.{ymd}/rap.t{hh}z.awp130pgrbf{ff}.grib2",
        }), "group": "Regional"},
    "nam-fc": {**_forecast(
        "nam-anl", "nam-12km", label="NAM", note="The 12 km NAM over North America, out to 84 h.",
        urls={
            "nomads": NOMADS + "/nam/prod/nam.{ymd}/nam.t{hh}z.awphys{ff}.tm00.grib2",
            "aws": _AWS_NAM + "/nam.{ymd}/nam.t{hh}z.awphys{ff}.tm00.grib2",
        }), "group": "Regional"},
    "gfs-fc": {**_forecast(
        "gfs-anl", "gfs-0p25", label="GFS", note="Global 0.25 deg, hourly to 120 h and three-hourly to 384 h.",
        urls={
            "nomads": NOMADS + "/gfs/prod/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{fff}",
            "aws": _AWS_GFS + "/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{fff}",
        }), "group": "Global"},
})

# The HiResW members and the HREF mean, as their files name their records --
# read off each file's own .idx, long spellings and all. The three HiResW runs
# share one file layout and one 5 km Lambert grid; so does the HREF.
# ---------------------------------------------------------------------------
# The mesoanalysis archive: any hour since 2005 (see meso_archive.py)
# ---------------------------------------------------------------------------
# Worked out from each hour's own profile rather than read from the file, so
# they exist -- and mean the same -- in the RUC years too.
_PROFILE_DERIVED = (
    "sbcape", "sbcin", "mlcape", "mlcin", "mucape", "mucin", "cape3", "li", "bli",
    "lcl_msl", "mllcl", "lfc_msl", "el_msl", "ushr1", "vshr1", "ushr6", "vshr6", "ustm", "vstm",
    "srh1", "srh3", "esrh", "ebwd", "stp_eff", "scp_eff", "lr03",
)

SOURCES["rap-archive"] = {
    "label": "Mesoanalysis archive 13 km", "org": "NOAA/NCEP, NCEI", "coverage": "North America, 2005 on",
    "note": "Any hour since January 2005: the RAP's analysis (the RUC's before May 2012), with SPC's "
            "severe parameters worked out from its own profiles. Pick the day below.",
    "urls": {"archive": "archive:{ymd}{hh}"},
    "reader": "archive", "archive": True, "group": "Archive",
    # The same 13 km Lambert grid as the live RAP analysis, every year: its
    # regrid mapping is shared.
    "grid": "rap-anl",
    "step": 0.13, "days": 1, "cadence": 60,
    "lov": -95.0, "latin": 25.0,
    # Bumped when meso_profile's sums change, so no hour is served from before.
    "reread": "p1",
    # Only what the RUC's files carry as well as the RAP's: the rest is either
    # worked out from the profile or not in the early years at all.
    "raw": {
        **_without(_NCEP_COMMON, "u80", "v80", "tcdc", "lcdc", "mcdc", "hcdc", "smoke", "refc",
                   "lfc_msl", "el_msl"),
        **_upper((500,), dpt=False),
        "prate": "PRATE:surface",
        "crain": "CRAIN:surface", "csnow": "CSNOW:surface", "cicep": "CICEP:surface", "cfrzr": "CFRZR:surface",
        **{name: f"derived:{name}" for name in _PROFILE_DERIVED},
    },
}


_HRW_RAW = {
    "absv500": "ABSV:500 mb",
    "bli": "4LFTX:180-0 mb above ground",
    "dpt200": "DPT:200 mb",
    "dpt250": "DPT:250 mb",
    "dpt300": "DPT:300 mb",
    "dpt500": "DPT:500 mb",
    "dpt700": "DPT:700 mb",
    "dpt850": "DPT:850 mb",
    "dpt925": "DPT:925 mb",
    "gust": "GUST:surface",
    "hcdc": "HCDC:high cloud layer",
    "hgt1000": "HGT:1000 mb",
    "hgt200": "HGT:200 mb",
    "hgt250": "HGT:250 mb",
    "hgt300": "HGT:300 mb",
    "hgt500": "HGT:500 mb",
    "hgt700": "HGT:700 mb",
    "hgt850": "HGT:850 mb",
    "hgt925": "HGT:925 mb",
    "hgt_sfc": "HGT:surface",
    "lcdc": "LCDC:low cloud layer",
    "li": "LFTX:500-1000 mb",
    "mcdc": "MCDC:middle cloud layer",
    "mlcape": "CAPE:90-0 mb above ground",
    "mlcin": "CIN:90-0 mb above ground",
    "mslp": "PRMSL:mean sea level",
    "psfc": "PRES:surface",
    "pwat": "PWAT:entire atmosphere (considered as a single layer)",
    "refc": "REFC:entire atmosphere (considered as a single layer)",
    "refd1km": "REFD:1000 m above ground",
    "rh200": "RH:200 mb",
    "rh250": "RH:250 mb",
    "rh2m": "RH:2 m above ground",
    "rh300": "RH:300 mb",
    "rh500": "RH:500 mb",
    "rh700": "RH:700 mb",
    "rh850": "RH:850 mb",
    "rh925": "RH:925 mb",
    "sbcape": "CAPE:surface",
    "sbcin": "CIN:surface",
    "spfh2m": "SPFH:2 m above ground",
    "srh1": "HLCY:1000-0 m above ground",
    "srh3": "HLCY:3000-0 m above ground",
    "t2m": "TMP:2 m above ground",
    "tcdc": "TCDC:entire atmosphere (considered as a single layer)",
    "td2m": "DPT:2 m above ground",
    "tmp200": "TMP:200 mb",
    "tmp250": "TMP:250 mb",
    "tmp300": "TMP:300 mb",
    "tmp500": "TMP:500 mb",
    "tmp700": "TMP:700 mb",
    "tmp850": "TMP:850 mb",
    "tmp925": "TMP:925 mb",
    "tskin": "TMP:surface",
    "u10": "UGRD:10 m above ground",
    "u200": "UGRD:200 mb",
    "u250": "UGRD:250 mb",
    "u300": "UGRD:300 mb",
    "u500": "UGRD:500 mb",
    "u700": "UGRD:700 mb",
    "u80": "UGRD:80 m above ground",
    "u850": "UGRD:850 mb",
    "u925": "UGRD:925 mb",
    "ushr6": "VUCSH:0-6000 m above ground",
    "v10": "VGRD:10 m above ground",
    "v200": "VGRD:200 mb",
    "v250": "VGRD:250 mb",
    "v300": "VGRD:300 mb",
    "v500": "VGRD:500 mb",
    "v700": "VGRD:700 mb",
    "v80": "VGRD:80 m above ground",
    "v850": "VGRD:850 mb",
    "v925": "VGRD:925 mb",
    "vis": "VIS:surface",
    "vshr6": "VVCSH:0-6000 m above ground",
    "vvel200": "VVEL:200 mb",
    "vvel250": "VVEL:250 mb",
    "vvel300": "VVEL:300 mb",
    "vvel500": "VVEL:500 mb",
    "vvel700": "VVEL:700 mb",
    "vvel850": "VVEL:850 mb",
    "vvel925": "VVEL:925 mb",
    "weasd": "WEASD:surface",
}

_HREF_RAW = {
    "dpt500": "DPT:500 mb",
    "dpt700": "DPT:700 mb",
    "dpt850": "DPT:850 mb",
    "dpt925": "DPT:925 mb",
    "hcdc": "HCDC:high cloud layer",
    "hgt250": "HGT:250 mb",
    "hgt500": "HGT:500 mb",
    "hgt700": "HGT:700 mb",
    "hgt850": "HGT:850 mb",
    "hgt925": "HGT:925 mb",
    "lcdc": "LCDC:low cloud layer",
    "mcdc": "MCDC:middle cloud layer",
    "mlcape": "CAPE:90-0 mb above ground",
    "mlcin": "CIN:90-0 mb above ground",
    "mslp": "MSLET:mean sea level",
    "pwat": "PWAT:entire atmosphere (considered as a single layer)",
    "rh700": "RH:700 mb",
    "sbcape": "CAPE:surface",
    "sbcin": "CIN:surface",
    "srh3": "HLCY:3000-0 m above ground",
    "t2m": "TMP:2 m above ground",
    "tcdc": "TCDC:entire atmosphere (considered as a single layer)",
    "td2m": "DPT:2 m above ground",
    "tmp250": "TMP:250 mb",
    "tmp500": "TMP:500 mb",
    "tmp700": "TMP:700 mb",
    "tmp850": "TMP:850 mb",
    "tmp925": "TMP:925 mb",
    "tskin": "TMP:surface",
    "u250": "UGRD:250 mb",
    "u500": "UGRD:500 mb",
    "u700": "UGRD:700 mb",
    "u850": "UGRD:850 mb",
    "u925": "UGRD:925 mb",
    "v250": "VGRD:250 mb",
    "v500": "VGRD:500 mb",
    "v700": "VGRD:700 mb",
    "v850": "VGRD:850 mb",
    "v925": "VGRD:925 mb",
    "vis": "VIS:surface",
    "vvel700": "VVEL:700 mb",
    "weasd": "WEASD:surface",
}


def _forecast_own(model: str, *, label: str, note: str, coverage: str, group: str, url: str,
                  raw: dict[str, str], step: float, grid: str, lov: float, latin: float) -> dict[str, Any]:
    """A forecast source with no analysis twin: its own grid, its own records.

    NOMADS only -- these models have no public mirror -- so discovery and
    downloads spend the NOMADS budget.
    """
    import model_sources as ms  # imported late to keep this module light
    return {
        "label": label, "org": "NOAA/NCEP", "coverage": coverage, "note": note,
        "urls": {"nomads": url}, "step": step, "days": 7, "cadence": 60,
        "grid": grid, "lov": lov, "latin": latin, "raw": raw, "group": group,
        "forecast": {"cycles": tuple(ms.MODELS[model]["cycles"]), "hours": ms.forecast_hours(model)},
    }


SOURCES.update({
    "hrw-arw-fc": _forecast_own(
        "hiresw-arw", label="HRW-ARW M1", coverage="CONUS", group="Convection-allowing",
        note="The HiResW WRF-ARW member, 5 km, out to 48 h at 00 and 12Z.",
        url=NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{hh}z.arw_5km.f{ff}.conus.grib2",
        raw=_HRW_RAW, step=0.05, grid="hrw-5km", lov=-95.0, latin=25.0),
    "hrw-arw2-fc": _forecast_own(
        "hiresw-arw2", label="HRW-ARW M2", coverage="CONUS", group="Convection-allowing",
        note="The second HiResW WRF-ARW member, 5 km, out to 48 h at 00 and 12Z.",
        url=NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{hh}z.arw_5km.f{ff}.conusmem2.grib2",
        raw=_HRW_RAW, step=0.05, grid="hrw-5km", lov=-95.0, latin=25.0),
    "hrw-fv3-fc": _forecast_own(
        "hiresw-fv3", label="HRW-FV3", coverage="CONUS", group="Convection-allowing",
        note="The HiResW FV3 member, 5 km, out to 60 h at 00 and 12Z.",
        url=NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{hh}z.fv3_5km.f{ff}.conus.grib2",
        raw=_HRW_RAW, step=0.05, grid="hrw-5km", lov=-95.0, latin=25.0),
    "href-fc": _forecast_own(
        "href-mean", label="HREF", coverage="CONUS", group="CAM ensemble",
        note="The HREF ensemble mean on a 5 km grid, out to 48 h.",
        url=NOMADS + "/href/prod/href.{ymd}/ensprod/href.t{hh}z.conus.mean.f{ff}.grib2",
        raw=_HREF_RAW, step=0.05, grid="hrw-5km", lov=-95.0, latin=25.0),
})

# ---------------------------------------------------------------------------
# What only a forecast has: what fell and what peaked since the run began.
# A variable listed with several time windows is picked by one ("|tot" since
# the run began, "|1h" over the last hour, "|bkt3" the NAM's three-hour
# bucket, "|inst" at the hour itself -- model_sources._picks). Each list was
# read off that model's own .idx at a forecast hour.
# ---------------------------------------------------------------------------
_TYPES = {"crain": "CRAIN:surface|inst", "csnow": "CSNOW:surface|inst",
          "cicep": "CICEP:surface|inst", "cfrzr": "CFRZR:surface|inst"}
_RUN_TOTALS = {"qpf_tot": "APCP:surface|tot", "qpf_1h": "APCP:surface|1h"}
_NAM_BUCKETS = {"apcp_bkt3": "APCP:surface|bkt3", "weasd_bkt3": "WEASD:surface|bkt3"}
_CAM_MAXIMA = {"uh25_1h": "MXUPHL:5000-2000 m above ground|1h", "uh03_1h": "MXUPHL:3000-0 m above ground|1h",
               "maxref_1h": "MAXREF:1000 m above ground|1h"}
_SIM_SAT = {"sbt124": "SBT124:top of atmosphere", "sbt123": "SBT123:top of atmosphere"}
_FORECAST_RAW: dict[str, dict[str, str]] = {
    "hrrr-fc": {
        **_TYPES, **_RUN_TOTALS, **_CAM_MAXIMA, **_SIM_SAT,
        "weasd": "WEASD:surface|inst", "prate": "PRATE:surface|inst",
        "snow_tot": "ASNOW:surface|tot", "swe_tot": "WEASD:surface|tot", "frzr_tot": "FRZR:surface|tot",
        "uh02_1h": "MXUPHL:2000-0 m above ground|1h", "hail_1h": "HAIL:entire atmosphere|1h",
        "ltng": "LTNG:entire atmosphere", "maxuvv_1h": "MAXUVV:100-1000 mb above ground|1h",
        "relv1_1h": "RELV:1000-0 m above ground|1h", "relv2_1h": "RELV:2000-0 m above ground|1h",
        "wmax_1h": "WIND:10 m above ground|1h",
    },
    "rap-fc": {
        **_TYPES, **_RUN_TOTALS, **_SIM_SAT,
        "weasd": "WEASD:surface|inst", "prate": "PRATE:surface|inst",
        "snow_tot": "ASNOW:surface|tot", "swe_tot": "WEASD:surface|tot", "frzr_tot": "FRZR:surface|tot",
    },
    "nam-fc": {**_TYPES, **_NAM_BUCKETS, "weasd": "WEASD:surface|inst"},
    "nam3-fc": {**_TYPES, **_NAM_BUCKETS, **_CAM_MAXIMA, "weasd": "WEASD:surface|inst",
                "prate": "PRATE:surface|inst"},
    "gfs-fc": {**_TYPES, "qpf_tot": "APCP:surface|tot", "weasd": "WEASD:surface|inst",
               "prate": "PRATE:surface|inst"},
    # The ARW files list WEASD only as what fell, never as the snow on the
    # ground -- so no snow water equivalent product for them. The FV3 lists the
    # snow on the ground and the last hour's fall, but no run total.
    **{sid: {**_TYPES, **_RUN_TOTALS, **_CAM_MAXIMA, "swe_tot": "WEASD:surface|tot"}
       for sid in ("hrw-arw-fc", "hrw-arw2-fc")},
    "hrw-fv3-fc": {**_TYPES, **_RUN_TOTALS, **_CAM_MAXIMA,
                   "weasd": "WEASD:surface|inst", "weasd_1h": "WEASD:surface|1h"},
    # The HREF mean lists only hour-long (and three-hour) buckets: its run
    # totals are the hours added up.
    "href-fc": {"qpf_1h": "APCP:surface|1h", "weasd_1h": "WEASD:surface|1h"},
}
for _sid, _extra in _FORECAST_RAW.items():
    _raw = {**SOURCES[_sid]["raw"], **_extra}
    if "weasd" not in _extra:
        _raw.pop("weasd", None)
    SOURCES[_sid]["raw"] = _raw


# ---------------------------------------------------------------------------
# RRFS, the HRRR's successor: 3 km over CONUS, NOMADS only. Each hour is two
# files on one grid -- the surface and severe fields in "2dfld", the pressure
# levels in "prslev" -- so the surface records are addressed "2d>...".
# ---------------------------------------------------------------------------
_RRFS = NOMADS + "/rrfs/v1.0/rrfs.{ymd}/{hh}/rrfs.t{hh}z."
_RRFS_2D_HAS = (
    "bli", "cape3", "el_msl", "frz_msl", "gust", "hcdc", "hgt_sfc", "hpbl", "lcdc", "li", "mcdc", "mlcape", "mlcin",
    "mucape", "mucin", "psfc", "pwat", "refd1km", "rh2m", "sbcape", "sbcin", "smoke", "snod", "spfh2m", "srh1",
    "srh3", "t2m", "td2m", "tskin", "u10", "u80", "ushr6", "v10", "v80", "vis", "vshr6",
)
_RRFS_RAW = {
    **{k: "2d>" + v for k, v in _NCEP_COMMON.items() if k in _RRFS_2D_HAS},
    **{k: "2d>" + v for k, v in {
        "weasd": "WEASD:surface|inst", "mslp": "MSLET:mean sea level",
        "refc": "REFC:entire atmosphere (considered as a single layer)",
        "etop": "RETOP:entire atmosphere (considered as a single layer)",
        "vil": "VIL:entire atmosphere (considered as a single layer)", "refd263": "REFD:263 K level",
        **_TYPES, **_RUN_TOTALS, **_CAM_MAXIMA,
        "prate": "PRATE:surface|inst", "snow_tot": "ASNOW:surface|tot", "frzr_tot": "FRZR:surface|tot",
        "hail_1h": "HAIL:surface|1h", "ltng": "LTNG:entire atmosphere|1h",
        "maxuvv_1h": "MAXUVV:100-1000 mb|1h", "wmax_1h": "WIND:10 m above ground|1h",
        "relv1_1h": "RELV:1000-0 m above ground|1h", "relv2_1h": "RELV:2000-0 m above ground|1h",
    }.items()},
    **{k: v for k, v in _upper(LEVELS, dpt=True).items() if not k.startswith("vvel")},
    # Vertical motion as a velocity (m/s), not as omega: omega is worked out.
    **{f"dzdt{p}": f"DZDT:{p} mb" for p in LEVELS},
}
SOURCES["rrfs-fc"] = {
    "label": "RRFS", "org": "NOAA/NCEP", "coverage": "CONUS",
    "note": "The Rapid Refresh Forecast System, the HRRR's successor: 3 km, out to 84 h four times a day.",
    "urls": {"nomads": _RRFS + "prslev.3km.f{fff}.conus.grib2"},
    "files": {"2d": {"nomads": _RRFS + "2dfld.3km.f{fff}.conus.grib2"}},
    # The HRRR's own 1799 x 1059 Lambert grid, winds along its axes: one
    # mapping serves both.
    "step": 0.03, "days": 7, "cadence": 60, "grid": "hrrr-anl", "lov": -97.5, "latin": 38.5,
    "raw": _RRFS_RAW, "group": "Convection-allowing",
    "forecast": {"cycles": (0, 6, 12, 18), "hours": list(range(0, 85))},
}


# ---------------------------------------------------------------------------
# Sub-hourly runs: every quarter-hour of the first 18 hours. Each file holds
# four quarter-hours ("75 min fcst" ... "120 min fcst", or "2 hour fcst" for
# the RRFS), so each record names its minute: "|t{fmin}".
# ---------------------------------------------------------------------------
def _quarter(records: dict[str, str]) -> dict[str, str]:
    return {k: f"{v}|t{{fmin}}" for k, v in records.items()}


_SUBH_COMMON = {
    "t2m": "TMP:2 m above ground", "td2m": "DPT:2 m above ground", "spfh2m": "SPFH:2 m above ground",
    "u10": "UGRD:10 m above ground", "v10": "VGRD:10 m above ground",
    "u80": "UGRD:80 m above ground", "v80": "VGRD:80 m above ground",
    "gust": "GUST:surface", "psfc": "PRES:surface", "hgt_sfc": "HGT:surface", "vis": "VIS:surface",
    "refd1km": "REFD:1000 m above ground", "prate": "PRATE:surface",
    "crain": "CRAIN:surface", "csnow": "CSNOW:surface", "cicep": "CICEP:surface", "cfrzr": "CFRZR:surface",
    "ceil_msl": "HGT:cloud ceiling", "cbase": "HGT:cloud base", "ctop_msl": "HGT:cloud top",
}
_HRRR_SUBH = "/hrrr.{ymd}/conus/hrrr.t{hh}z.wrfsubhf{ff}.grib2"
_RRFS_SUBH = NOMADS + "/rrfs/v1.0/rrfs.{ymd}/{hh}/rrfs.t{hh}z.2dfld.3km.subh.f{fff}.conus.grib2"
_QUARTERS = [q / 4 for q in range(0, 18 * 4 + 1)]
SOURCES.update({
    "hrrr-subh": {
        "label": "HRRR Sub-Hourly", "org": "NOAA/NCEP", "coverage": "CONUS", "group": "Convection-allowing",
        "note": "The HRRR every 15 minutes for the first 18 hours: storms move between frames, not jump.",
        "urls": {"nomads": NOMADS + "/hrrr/prod" + _HRRR_SUBH, "aws": _AWS_HRRR + _HRRR_SUBH},
        "step": 0.03, "days": 7, "cadence": 15, "grid": "hrrr-anl", "lov": -97.5, "latin": 38.5,
        "subhourly": 15, "replay": "hrrr-anl",
        "raw": _quarter({**_SUBH_COMMON, "refc": "REFC:entire atmosphere", "etop": "RETOP:cloud top",
                         "vil": "VIL:entire atmosphere", "sbt124": "SBT124:top of atmosphere",
                         "sbt123": "SBT123:top of atmosphere"}),
        "forecast": {"cycles": tuple(range(24)), "hours": _QUARTERS},
    },
    "rrfs-subh": {
        "label": "RRFS Sub-Hourly", "org": "NOAA/NCEP", "coverage": "CONUS", "group": "Convection-allowing",
        "note": "The RRFS every 15 minutes for the first 18 hours.",
        "urls": {"nomads": _RRFS_SUBH},
        "step": 0.03, "days": 7, "cadence": 15, "grid": "hrrr-anl", "lov": -97.5, "latin": 38.5,
        "subhourly": 15,
        "raw": _quarter({**_SUBH_COMMON, "mslp": "MSLET:mean sea level",
                         "refc": "REFC:entire atmosphere (considered as a single layer)",
                         "etop": "RETOP:entire atmosphere (considered as a single layer)",
                         "vil": "VIL:entire atmosphere (considered as a single layer)"}),
        # Its first file is f001: no analysis quarter-hour.
        "forecast": {"cycles": tuple(range(24)), "hours": _QUARTERS[1:]},
    },
})


# ---------------------------------------------------------------------------
# NOAA's machine-learned models, NOMADS only, 0.25 degree, six-hourly: the AI
# GFS, and the means of the AI GEFS and the hybrid (half AI, half physics)
# HGEFS. Each hour is a pressure-level file with a thin surface file beside
# it; humidity aloft is specific, relative humidity is worked out.
# ---------------------------------------------------------------------------
_AI_UPPER = {
    **{k: v for k, v in _upper((), dpt=False).items() if not k.startswith("rh")},
    **{f"q{p}": f"SPFH:{p} mb" for p in LEVELS}, "hgt1000": "HGT:1000 mb",
}
_AI_SFC = {"t2m": "sfc>TMP:2 m above ground", "u10": "sfc>UGRD:10 m above ground",
           "v10": "sfc>VGRD:10 m above ground", "mslp": "sfc>PRMSL:mean sea level"}


def _noaa_ai(*, label: str, note: str, group: str, pres: str, sfc: str, raw: dict[str, str], hours: list[int]) -> dict:
    return {
        "label": label, "org": "NOAA/NCEP", "coverage": "Global", "note": note,
        "urls": {"nomads": NOMADS + pres}, "files": {"sfc": {"nomads": NOMADS + sfc}},
        "step": 0.25, "days": 7, "cadence": 360, "grid": "noaa-ai-0p25", "raw": raw, "group": group,
        "forecast": {"cycles": (0, 6, 12, 18), "hours": hours},
    }


SOURCES.update({
    "aigfs-fc": _noaa_ai(
        label="AI GFS", group="Global",
        note="NOAA's machine-learned GFS (GraphCast-based), 0.25 deg, six-hourly to 384 h.",
        pres="/aigfs/v1.1/aigfs.{ymd}/{hh}/model/atmos/grib2/aigfs.t{hh}z.pres.f{fff}.grib2",
        sfc="/aigfs/v1.1/aigfs.{ymd}/{hh}/model/atmos/grib2/aigfs.t{hh}z.sfc.f{fff}.grib2",
        raw={**_AI_UPPER, **_AI_SFC, "qpf_tot": "sfc>APCP:surface|tot"}, hours=list(range(0, 385, 6))),
    "aigefs-fc": _noaa_ai(
        label="AI GEFS", group="Ensemble",
        note="The mean of NOAA's machine-learned ensemble, 0.25 deg, six-hourly to 384 h.",
        pres="/aigefs/v1.0/aigefs.{ymd}/{hh}/ensstat/products/atmos/grib2/aigefs.t{hh}z.pres.avg.f{fff}.grib2",
        sfc="/aigefs/v1.0/aigefs.{ymd}/{hh}/ensstat/products/atmos/grib2/aigefs.t{hh}z.sfc.avg.f{fff}.grib2",
        raw={**_AI_UPPER, **_AI_SFC, "apcp_bkt6": "sfc>APCP:surface|bkt6"}, hours=list(range(0, 385, 6))),
    "hgefs-fc": _noaa_ai(
        label="HGEFS", group="Ensemble",
        note="The mean of the hybrid GEFS -- physics and machine-learned members together -- six-hourly to 240 h.",
        pres="/hgefs/v1.0/hgefs.{ymd}/{hh}/ensstat/products/atmos/grib2/hgefs.t{hh}z.pres.avg.f{fff}.grib2",
        sfc="/hgefs/v1.0/hgefs.{ymd}/{hh}/ensstat/products/atmos/grib2/hgefs.t{hh}z.sfc.avg.f{fff}.grib2",
        raw={**_AI_UPPER, **_AI_SFC, "apcp_bkt6": "sfc>APCP:surface|bkt6"}, hours=list(range(0, 241, 6))),
})


# ---------------------------------------------------------------------------
# The GEFS mean, the 0.5 degree "a" file: the ensemble average of 31 runs.
# Its sibling at 0.25 degree has a third of the fields. Precipitation comes in
# six-hour buckets; CAPE only for the most unstable parcel (180-0 mb).
# ---------------------------------------------------------------------------
_GEFS_HAS = (
    "t2m", "rh2m", "u10", "v10", "psfc", "pwat", "tcdc", "snod", "weasd",
    "hgt1000", "vvel850", *(f"{v}{p}" for p in (925, 850, 700, 500, 250, 200) for v in ("hgt", "tmp", "rh", "u", "v")),
    "hgt300", "u300", "v300",
)
_GEFS_RAW = {
    **{k: v for k, v in {**_NCEP_COMMON, **_upper(LEVELS, dpt=False)}.items() if k in _GEFS_HAS},
    "mslp": "PRMSL:mean sea level",
    "mucape": "CAPE:180-0 mb above ground", "mucin": "CIN:180-0 mb above ground",
    "apcp_bkt6": "APCP:surface|bkt6",
}
_GEFS_PATH = "/gefs.{ymd}/{hh}/atmos/pgrb2ap5/geavg.t{hh}z.pgrb2a.0p50.f{fff}"
def _ens(stat: str, record: str) -> str:
    """An ensemble statistic worked out from the members (observations._ens_values)."""
    return f"ens:{stat}:{record}"


# Precipitation thresholds, mm: 0.01", 1", 4"; snow as 10:1 water, mm: 1", 6", 12".
_QPF24 = {"p_qpf24_001": 0.254, "p_qpf24_1": 25.4, "p_qpf24_4": 101.6}
_SNOW24 = {"p_snow24_1": 2.54, "p_snow24_6": 15.24, "p_snow24_12": 30.48}

SOURCES["gefs-fc"] = {
    "label": "GEFS", "org": "NOAA/NCEP", "coverage": "Global",
    "note": "The GFS ensemble's mean of 31 runs at 0.5 deg, three-hourly to 240 h and six-hourly to 384 h.",
    "urls": {"nomads": NOMADS + "/gens/prod" + _GEFS_PATH, "aws": "https://noaa-gefs-pds.s3.amazonaws.com" + _GEFS_PATH},
    # The control and 30 perturbed runs, each its own file, for what the mean
    # cannot say: the deepest low any member has, how many give an inch of rain.
    "members": {"ids": ["c00", *(f"p{i:02d}" for i in range(1, 31))],
                "urls": {"aws": "https://noaa-gefs-pds.s3.amazonaws.com"
                         "/gefs.{ymd}/{hh}/atmos/pgrb2ap5/ge{mem}.t{hh}z.pgrb2a.0p50.f{fff}"}},
    "step": 0.25, "days": 7, "cadence": 360, "grid": "gefs-0p50", "group": "Ensemble",
    "raw": {**_GEFS_RAW, "mslp_min": _ens("min", "PRMSL:mean sea level"),
            **{k: _ens(f"p>{v}", "s24:APCP:surface|6h") for k, v in _QPF24.items()}},
    "forecast": {"cycles": (0, 6, 12, 18), "hours": [*range(0, 241, 3), *range(246, 385, 6)]},
}


# ---------------------------------------------------------------------------
# ECMWF open data: the same 0.25 degree grid for the IFS and the AIFS, found
# through a JSON .index beside each file rather than an .idx ("param=t,
# levelist=850" rather than "TMP:850 mb"). Read from ECMWF's own AWS mirror
# first and from data.ecmwf.int for a run the mirror does not have yet.
# ---------------------------------------------------------------------------
_ECMWF = "https://data.ecmwf.int/forecasts"
_ECMWF_AWS = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"


def _ec_upper(params: dict[str, str]) -> dict[str, str]:
    return {f"{ours}{p}": f"param={theirs},levelist={p}" for p in LEVELS for ours, theirs in params.items()}


# What both carry. Terrain height is only in the first hour's file, as
# geopotential (/g for metres). Precipitation and snowfall are since the run
# began: in metres of water from the IFS (x1000 for kg/m2), already in kg/m2
# from the AIFS -- each file's own units, read off its GRIB.
_EC_COMMON = {
    "t2m": "param=2t", "td2m": "param=2d", "u10": "param=10u", "v10": "param=10v",
    "mslp": "param=msl", "psfc": "param=sp", "tskin": "param=skt",
    "hgt_sfc": "param=z*0.10197162@0", "hgt1000": "param=gh,levelist=1000",
}
_IFS_RAW = {
    **_EC_COMMON,
    "qpf_tot": "param=tp*1000", "swe_tot": "param=sf*1000",
    "gust": "param=10fg", "tcdc": "param=tcc*100", "pwat": "param=tcwv", "mucape": "param=mucape",
    "weasd": "param=sd*1000", "prate": "param=tprate", "ptype_code": "param=ptype",
    **_ec_upper({"hgt": "gh", "tmp": "t", "rh": "r", "u": "u", "v": "v", "vvel": "w"}),
}
# The AIFS has cloud by layer but no relative humidity aloft: that is worked
# out from its specific humidity.
_AIFS_RAW = {
    **_EC_COMMON,
    "qpf_tot": "param=tp", "swe_tot": "param=sf",
    "tcdc": "param=tcc", "lcdc": "param=lcc", "mcdc": "param=mcc", "hcdc": "param=hcc",
    **_ec_upper({"hgt": "gh", "tmp": "t", "q": "q", "u": "u", "v": "v", "vvel": "w"}),
}


def _ecmwf_source(*, label: str, note: str, path: str, raw: dict[str, str], hours: list[int]) -> dict[str, Any]:
    return {
        "label": label, "org": "ECMWF", "coverage": "Global", "note": note,
        "urls": {"aws": _ECMWF_AWS + path, "ecmwf": _ECMWF + path},
        "reader": "ecmwf", "step": 0.25, "days": 4, "cadence": 360,
        "grid": "ecmwf-0p25", "raw": raw, "group": "Global",
        "forecast": {"cycles": (0, 6, 12, 18), "hours": hours},
    }


# ---------------------------------------------------------------------------
# Environment Canada's GEM global (GDPS), from the MSC datamart: a file per
# variable per hour, no index; the record is the variable's name in the file
# name. Everything is in SI already. CAPE and CIN are 9999 where there is no
# parcel to lift -- blanked, not drawn as the most unstable air on earth.
# ---------------------------------------------------------------------------
_MSC_DD = "https://dd.weather.gc.ca/{ymd}/WXO-DD"


def _msc_upper(params: dict[str, str]) -> dict[str, str]:
    return {f"{ours}{p}": f"{theirs}_IsbL-{p:04d}" for p in LEVELS for ours, theirs in params.items()}


_GDPS_RAW = {
    "t2m": "AirTemp_AGL-2m", "td2m": "DewPoint_AGL-2m", "rh2m": "RelativeHumidity_AGL-2m",
    "spfh2m": "SpecificHumidity_AGL-2m",
    "u10": "WindU_AGL-10m", "v10": "WindV_AGL-10m", "u80": "WindU_AGL-80m", "v80": "WindV_AGL-80m",
    "gust": "WindGust_AGL-10m", "mslp": "Pressure_MSL", "psfc": "Pressure_Sfc",
    "tcdc": "TotalCloudCover_Sfc", "hpbl": "PlanetaryBoundaryLayerHeight_Sfc",
    "sbcape": "CAPE_Sfc!9999", "sbcin": "CIN_Sfc!9999", "snod": "SnowDepth_Sfc",
    "qpf_tot": "Precip-Accum_Sfc", "swe_tot": "Snow-Accum_Sfc", "frzr_tot": "FreezingRain-Accum_Sfc",
    "prate": "PrecipRate_Sfc", "ptype_code": "PrecipType-Instant_Sfc",
    "hgt1000": "GeopotentialHeight_IsbL-1000",
    **_msc_upper({"hgt": "GeopotentialHeight", "tmp": "AirTemp", "rh": "RelativeHumidity", "u": "WindU",
                  "v": "WindV", "vvel": "VerticalVelocity", "absv": "AbsoluteVorticity"}),
}

# ---------------------------------------------------------------------------
# DWD's ICON, 13 km global, from opendata.dwd.de: a bzip2 file per variable per
# hour on the icosahedral mesh, the cell centres published beside the run.
# The record is the file's path, run and hour written in.
# ---------------------------------------------------------------------------
_DWD = "https://opendata.dwd.de/weather/nwp/icon/grib/{hh}"


def _icon(var: str, level: Optional[int] = None) -> str:
    kind = f"pressure-level_{{ymd}}{{hh}}_{{fff}}_{level}" if level else "single-level_{ymd}{hh}_{fff}"
    return f"{var}/icon_global_icosahedral_{kind}_{var.upper()}"


_ICON_RAW = {
    "t2m": _icon("t_2m"), "td2m": _icon("td_2m"), "rh2m": _icon("relhum_2m"),
    "u10": _icon("u_10m"), "v10": _icon("v_10m"), "gust": _icon("vmax_10m"),
    "mslp": _icon("pmsl"), "psfc": _icon("ps"),
    "tcdc": _icon("clct"), "lcdc": _icon("clcl"), "mcdc": _icon("clcm"), "hcdc": _icon("clch"),
    "mlcape": _icon("cape_ml"), "pwat": _icon("tqv"), "frz_msl": _icon("hzerocl"),
    "snod": _icon("h_snow"), "weasd": _icon("w_snow"), "qpf_tot": _icon("tot_prec"),
    # Snow that fell, in two parts: from the convection scheme and the rest.
    "snowcon_tot": _icon("snow_con"), "snowgsp_tot": _icon("snow_gsp"),
    "hgt_sfc": "hsurf/icon_global_icosahedral_time-invariant_{ymd}{hh}_HSURF",
    # Geopotential, m2/s2, /g for metres.
    **{f"hgt{p}": _icon("fi", p) + "*0.10197162" for p in (*LEVELS, 1000)},
    **{f"{ours}{p}": _icon(theirs, p) for p in LEVELS
       for ours, theirs in (("tmp", "t"), ("rh", "relhum"), ("u", "u"), ("v", "v"))},
}

# The ECMWF ensembles: 50 members in one file per step, found through the
# .index like the rest of ECMWF's open data. Every field is a statistic worked
# out here -- a variable is 20 to 70 MB of members an hour, so a first look at
# an hour takes a while; after that it is kept.
_ENS_LEVELS = (925, 850, 700, 500, 300, 200)
_ENS_IFS_RAW = {
    **{k: _ens("mean", v) for k, v in {
        "t2m": "param=2t", "td2m": "param=2d", "u10": "param=10u", "v10": "param=10v", "mslp": "param=msl",
        "gust": "param=10fg", "pwat": "param=tcwv", "mucape": "param=mucape",
        **{f"{ours}{p}": f"param={theirs},levelist={p}" for p in _ENS_LEVELS
           for ours, theirs in (("hgt", "gh"), ("tmp", "t"), ("rh", "r"), ("u", "u"), ("v", "v"))},
        "hgt1000": "param=gh,levelist=1000"}.items()},
    "tcdc": _ens("mean", "param=tcc") + "*100",
    "qpf_tot": _ens("mean", "param=tp") + "*1000", "swe_tot": _ens("mean", "param=sf") + "*1000",
    "gust_max": _ens("max", "param=10fg"),
    "p_gust40": _ens("p>17.88", "param=10fg"), "p_gust75": _ens("p>33.53", "param=10fg"),
    "mslp_min": _ens("min", "param=msl"),
    **{k: _ens(f"p>{v}", "d24:param=tp") + "*1000" for k, v in _QPF24.items()},
    **{k: _ens(f"p>{v}", "d24:param=sf") + "*1000" for k, v in _SNOW24.items()},
}
# The AIFS gives precipitation already in kg/m2, heights as geopotential, and
# humidity aloft only as specific humidity; it has no gusts.
_ENS_AIFS_RAW = {
    **{k: _ens("mean", v) for k, v in {
        "t2m": "param=2t", "td2m": "param=2d", "u10": "param=10u", "v10": "param=10v", "mslp": "param=msl",
        "tcdc": "param=tcc", "qpf_tot": "param=tp", "swe_tot": "param=sf",
        **{f"{ours}{p}": f"param={theirs},levelist={p}" for p in _ENS_LEVELS
           for ours, theirs in (("tmp", "t"), ("q", "q"), ("u", "u"), ("v", "v"))}}.items()},
    **{f"hgt{p}": _ens("mean", f"param=z,levelist={p}") + "*0.10197162" for p in (*_ENS_LEVELS, 1000)},
    "mslp_min": _ens("min", "param=msl"),
    **{k: _ens(f"p>{v}", "d24:param=tp") for k, v in _QPF24.items()},
    **{k: _ens(f"p>{v}", "d24:param=sf") for k, v in _SNOW24.items()},
}

SOURCES.update({
    "ecmwf-ens-fc": {**_ecmwf_source(
        label="ECMWF ENS", raw=_ENS_IFS_RAW,
        note="ECMWF's 50-member ensemble, worked out here: means, extremes and probabilities. "
             "A first look at an hour downloads every member (tens of MB a field).",
        path="/{ymd}/{hh}z/ifs/0p25/enfo/{ymd}{hh}0000-{h}h-enfo-ef.grib2",
        hours=[*range(0, 145, 3), *range(150, 361, 6)]), "group": "Ensemble"},
    "aifs-ens-fc": {**_ecmwf_source(
        label="ECMWF AIFS ENS", raw=_ENS_AIFS_RAW,
        note="ECMWF's machine-learned 50-member ensemble, six-hourly to 360 h, worked out here.",
        path="/{ymd}/{hh}z/aifs-ens/0p25/enfo/{ymd}{hh}0000-{h}h-enfo-pf.grib2",
        hours=list(range(0, 361, 6))), "group": "Ensemble"},
    "ecmwf-fc": _ecmwf_source(
        label="ECMWF", raw=_IFS_RAW,
        note="The ECMWF IFS at 0.25 deg: three-hourly to 144 h, then six-hourly to 360 h; "
             "the 06 and 18Z runs are shorter.",
        path="/{ymd}/{hh}z/ifs/0p25/oper/{ymd}{hh}0000-{h}h-oper-fc.grib2",
        hours=[*range(0, 145, 3), *range(150, 361, 6)]),
    "aifs-fc": _ecmwf_source(
        label="ECMWF AIFS", raw=_AIFS_RAW,
        note="ECMWF's machine-learned model, six-hourly to 360 h.",
        path="/{ymd}/{hh}z/aifs-single/0p25/oper/{ymd}{hh}0000-{h}h-oper-fc.grib2",
        hours=list(range(0, 361, 6))),
    "gdps-fc": {
        "label": "GEM", "org": "ECCC (Canada)", "coverage": "Global",
        "note": "Canada's global GEM (GDPS) at 15 km, three-hourly to 240 h from 00 and 12Z.",
        "urls": {"msc": _MSC_DD + "/model_gdps/15km/{hh}/{fff}/{ymd}T{hh}Z_MSC_GDPS_{var}_LatLon0.15_PT{fff}H.grib2"},
        "reader": "file", "probe": "Pressure_MSL",
        "step": 0.15, "days": 7, "cadence": 720, "grid": "gdps-0p15", "raw": _GDPS_RAW, "group": "Global",
        "forecast": {"cycles": (0, 12), "hours": list(range(0, 241, 3))},
    },
    "icon-fc": {
        "label": "ICON", "org": "DWD (Germany)", "coverage": "Global",
        "note": "Germany's ICON at 13 km: hourly to 78 h, then three-hourly to 180 h (120 h from 06 and 18Z).",
        "urls": {"dwd": _DWD + "/{var}.grib2.bz2"},
        "reader": "file", "probe": _icon("pmsl"),
        "cells": {"lat": _DWD + "/clat/icon_global_icosahedral_time-invariant_{ymd}{hh}_CLAT.grib2.bz2",
                  "lon": _DWD + "/clon/icon_global_icosahedral_time-invariant_{ymd}{hh}_CLON.grib2.bz2"},
        "step": 0.15, "days": 2, "cadence": 360, "grid": "icon-global", "raw": _ICON_RAW, "group": "Global",
        "forecast": {"cycles": (0, 6, 12, 18), "hours": [*range(0, 79), *range(81, 181, 3)]},
    },
})

# ---------------------------------------------------------------------------
# Probabilities, as the ensembles' own product files give them ("prob" beside
# the mean). The record's last field names the threshold: "|window|prob >75".
# ---------------------------------------------------------------------------
def _ens_probs(prefix: str, ltng: str) -> dict[str, str]:
    """The probability records the HREF and the REFS share, under one naming."""
    p = prefix + ">"
    return {
        "p_uh25": p + "MXUPHL:5000-2000 m above ground||prob >25",
        "p_uh75": p + "MXUPHL:5000-2000 m above ground||prob >75",
        "p_uh150": p + "MXUPHL:5000-2000 m above ground||prob >150",
        "p_mlcape500": p + "CAPE:90-0 mb above ground||prob >500",
        "p_mlcape1000": p + "CAPE:90-0 mb above ground||prob >1000",
        "p_mlcape2000": p + "CAPE:90-0 mb above ground||prob >2000",
        "p_mlcin50": p + "CIN:90-0 mb above ground||prob <-50",
        "p_mlcin100": p + "CIN:90-0 mb above ground||prob <-100",
        "p_srh100": p + "HLCY:3000-0 m above ground||prob >100",
        "p_srh200": p + "HLCY:3000-0 m above ground||prob >200",
        "p_srh400": p + "HLCY:3000-0 m above ground||prob >400",
        "p_ltng": p + ltng,
        "p_wind58": p + "WIND:10 m above ground||prob >25.72",
        "p_vis025": p + "VIS:surface||prob <400",
        "p_vis05": p + "VIS:surface||prob <800",
        "p_vis1": p + "VIS:surface||prob <1600",
        # 24-hour totals come every 12 hours (0-24, 12-36, 24-48).
        "p_qpf24_1": p + "APCP:surface|24h|prob >25.4",
        "p_qpf24_5": p + "APCP:surface|24h|prob >127",
        "p_crain": p + "CRAIN:surface||prob >=1 <0", "p_csnow": p + "CSNOW:surface||prob >=1 <0",
        "p_cicep": p + "CICEP:surface||prob >=1 <0", "p_cfrzr": p + "CFRZR:surface||prob >=1 <0",
    }


# The HREF: its mean file, and beside it the probability-matched mean (for
# reflectivity, which an average smears) and the probabilities.
_HREF_ENS = NOMADS + "/href/prod/href.{ymd}/ensprod/href.t{hh}z.conus."
SOURCES["href-fc"]["files"] = {"pmmn": {"nomads": _HREF_ENS + "pmmn.f{ff}.grib2"},
                               "prob": {"nomads": _HREF_ENS + "prob.f{ff}.grib2"}}
SOURCES["href-fc"]["raw"] = {
    **SOURCES["href-fc"]["raw"],
    "refc": "pmmn>REFC:entire atmosphere (considered as a single layer)",
    **_ens_probs("prob", "LTNG:surface||prob >0.2"),
}

# The REFS, the RRFS ensemble: 3 km on the HRRR's own grid, NOMADS only.
_REFS = NOMADS + "/refs/v1.0/refs.{ymd}/{hh}/ensprod/refs.t{hh}z."
_REFS_RAW = {
    "t2m": "TMP:2 m above ground", "td2m": "DPT:2 m above ground", "tskin": "TMP:surface",
    "u10": "UGRD:10 m above ground", "v10": "VGRD:10 m above ground", "mslp": "MSLET:mean sea level",
    "pwat": "PWAT:entire atmosphere (considered as a single layer)", "vis": "VIS:surface",
    "tcdc": "TCDC:entire atmosphere (considered as a single layer)", "lcdc": "LCDC:low cloud layer",
    "mcdc": "MCDC:middle cloud layer", "hcdc": "HCDC:high cloud layer",
    "sbcape": "CAPE:surface", "mlcape": "CAPE:90-0 mb above ground", "mucape": "CAPE:180-0 mb above ground",
    "sbcin": "CIN:surface", "mlcin": "CIN:90-0 mb above ground", "mucin": "CIN:180-0 mb above ground",
    "srh3": "HLCY:3000-0 m above ground", "frz_msl": "HGT:0C isotherm", "hgt_sfc": "HGT:surface",
    "hgt250": "HGT:250 mb", "tmp250": "TMP:250 mb", "u250": "UGRD:250 mb", "v250": "VGRD:250 mb", "rh700": "RH:700 mb",
    **{f"{ours}{p}": f"{theirs}:{p} mb" for p in (925, 850, 700, 500)
       for ours, theirs in (("hgt", "HGT"), ("tmp", "TMP"), ("dpt", "DPT"), ("u", "UGRD"), ("v", "VGRD"))},
    "qpf_1h": "APCP:surface|1h", "weasd_1h": "WEASD:surface|1h",
    "refc": "pmmn>REFC:entire atmosphere (considered as a single layer)",
    **_ens_probs("prob", "LTNG:entire atmosphere||prob >0.08"),
}
SOURCES["refs-fc"] = {
    "label": "REFS", "org": "NOAA/NCEP", "coverage": "CONUS", "group": "CAM ensemble",
    "note": "The RRFS ensemble: mean, probability-matched reflectivity and probabilities, 3 km, out to 60 h.",
    "urls": {"nomads": _REFS + "mean.f{ff}.conus.grib2"},
    "files": {"pmmn": {"nomads": _REFS + "pmmn.f{ff}.conus.grib2"},
              "prob": {"nomads": _REFS + "prob.f{ff}.conus.grib2"}},
    "step": 0.03, "days": 7, "cadence": 360, "grid": "hrrr-anl", "lov": -97.5, "latin": 38.5,
    "raw": _REFS_RAW, "forecast": {"cycles": (0, 6, 12, 18), "hours": list(range(1, 61))},
}

# ---------------------------------------------------------------------------
# The National Blend of Models, CONUS, on the RTMA's 2.5 km grid. Every field
# comes several ways -- the blend, its spread, percentiles, probabilities --
# told apart by the record's last field ("" for the blend itself). Wind is
# speed and direction, not u and v. Precipitation, snow and ice come in
# six-hour buckets ending every six hours, and hourly ones.
# ---------------------------------------------------------------------------
_NBM_PATH = "/blend.{ymd}/{hh}/core/blend.t{hh}z.core.f{fff}.co.grib2"
_NBM_RAW = {
    "t2m": "TMP:2 m above ground||", "td2m": "DPT:2 m above ground||", "rh2m": "RH:2 m above ground||",
    "feels": "APTMP:2 m above ground||", "wspd10": "WIND:10 m above ground||", "wdir10": "WDIR:10 m above ground||",
    "gust": "GUST:10 m above ground||", "tcdc": "TCDC:surface||", "vis": "VIS:surface||",
    "ceil_agl": "CEIL:cloud ceiling||", "sbcape": "CAPE:surface||", "snod": "SNOD:surface||",
    "pwat": "PWAT:entire atmosphere (considered as a single layer)||",
    "maxref_1h": "MAXREF:1000 m above ground|1h", "vil": "VIL:entire atmosphere||", "etop": "RETOP:cloud top||",
    # Six-hour buckets end at 00, 06, 12 and 18Z, so they exist only at the
    # hours that line up with them.
    "qpf_1h": "APCP:surface|1h|", "nbm_qpf6": "APCP:surface|6h|",
    "snow_1h": "ASNOW:surface|1h|", "nbm_snow6": "ASNOW:surface|6h|",
    "ice_1h": "FICEAC:surface|1h|", "nbm_ice6": "FICEAC:surface|6h|",
    "p_tstm": "TSTM:surface|3h|probability forecast", "p_drytstm": "DRYTPROB:surface|3h|prob >0",
}
SOURCES["nbm-fc"] = {
    "label": "NBM", "org": "NOAA/NWS", "coverage": "CONUS", "group": "Ensemble",
    "note": "The National Blend of Models, 2.5 km: hourly to 48 h, three-hourly to 192 h, six-hourly to 264 h.",
    "urls": {"nomads": NOMADS + "/blend/prod" + _NBM_PATH, "aws": "https://noaa-nbm-grib2-pds.s3.amazonaws.com" + _NBM_PATH},
    "step": 0.03, "days": 7, "cadence": 60, "grid": "rtma2p5", "lov": -95.0, "latin": 25.0, "raw": _NBM_RAW,
    # Its totals exist only every six hours: no three-hour window.
    "hide": {"qpf_3h"},
    # Every other row is coded backwards; copies saved before that was read
    # right are not to be used (observations._var_path).
    "reread": 1,
    "forecast": {"cycles": tuple(range(24)), "hours": [*range(1, 49), *range(51, 193, 3), *range(198, 265, 6)]},
}

# ---------------------------------------------------------------------------
# Which cycles run the whole way, and where the others stop. The newest run is
# often a short one -- an hourly HRRR run ends at 18 h while the 00/06/12/18Z
# ones reach 48 -- so the timeline opens on the newest long run instead, and
# the short ones stay a pick away under Run. Measured against the files on
# 2026-09-23 (the NBM's 03/09/15/21Z runs stop near 190 h: not long).
# ---------------------------------------------------------------------------
_LONG_RUNS = {
    "hrrr-fc": ((0, 6, 12, 18), 18),
    "rap-fc": ((3, 9, 15, 21), 21),
    "nbm-fc": ((0, 1, 6, 7, 12, 13, 18, 19), 48),
    "ecmwf-fc": ((0, 12), 144),
    "ecmwf-ens-fc": ((0, 12), 144),
    "icon-fc": ((0, 12), 120),
}
for _sid, (_long, _short) in _LONG_RUNS.items():
    SOURCES[_sid]["forecast"] = {**SOURCES[_sid]["forecast"], "long": _long, "short": _short}

# ---------------------------------------------------------------------------
# Tropical models: a domain per storm, NOMADS only, three-hourly to 126 h. The
# storm is part of the key ({storm} in the paths): '17e' for the HAFS,
# 'polo17e' (name and number) for the HWRF and HMON.
# ---------------------------------------------------------------------------
_TROP_HAS = (
    *(f"{v}{p}" for p in (925, 850, 700, 500, 300, 250, 200) for v in ("hgt", "tmp", "rh", "u", "v", "vvel", "absv")),
    "dpt850", "dpt700", "dpt500", "hgt1000", "hgt_sfc", "hpbl", "psfc", "pwat", "rh2m", "sbcape", "sbcin",
    "spfh2m", "srh3", "t2m", "td2m", "tskin", "u10", "v10",
)
_TROP_COMMON = {
    **{k: v for k, v in {**_NCEP_COMMON, **_upper(LEVELS, dpt=True)}.items() if k in _TROP_HAS},
    "mslp": "PRMSL:mean sea level", "refc": "REFC:entire atmosphere (considered as a single layer)",
}
_HAFS_RAW = {**_TROP_COMMON, "gust": "GUST:surface", "qpf_tot": "APCP:surface|tot",
             "tcdc": "TCDC:entire atmosphere (considered as a single layer)|inst",
             "uh25_1h": "MXUPHL:5000-2000 m above ground|1h", "uh03_1h": "MXUPHL:3000-0 m above ground|1h",
             "wmax_1h": "WIND:10 m above ground|1h"}


def _storm_model(*, label: str, note: str, url: str, listing: str, token: str, raw: dict[str, str],
                 step: float, grid: str) -> dict:
    return {
        "label": label, "org": "NOAA/NCEP", "coverage": "Storm", "group": "Tropical", "note": note,
        "urls": {"nomads": NOMADS + url}, "step": step, "days": 3, "cadence": 360, "grid": grid, "raw": raw,
        "storms": {"dir": NOMADS + listing, "file": token},
        "forecast": {"cycles": (0, 6, 12, 18), "hours": list(range(0, 127, 3))},
    }


SOURCES.update({
    "hafsa-fc": _storm_model(
        label="HAFS-A", step=0.06, grid="hafsa", raw=_HAFS_RAW,
        note="NOAA's hurricane model, configuration A: a 6 km domain around each storm, to 126 h. Pick the "
             "storm under Run.",
        url="/hafs/prod/hfsa.{ymd}/{hh}/{storm}.{ymd}{hh}.hfsa.parent.atm.f{fff}.grb2",
        listing="/hafs/prod/hfsa.{ymd}/{hh}/",
        token=r'"(\d\d[a-z])\.\d{10}\.hfsa\.parent\.atm\.f000\.grb2"'),
    "hafsb-fc": _storm_model(
        label="HAFS-B", step=0.06, grid="hafsb", raw=_HAFS_RAW,
        note="NOAA's hurricane model, configuration B, to 126 h. Pick the storm under Run.",
        url="/hafs/prod/hfsb.{ymd}/{hh}/{storm}.{ymd}{hh}.hfsb.parent.atm.f{fff}.grb2",
        listing="/hafs/prod/hfsb.{ymd}/{hh}/",
        token=r'"(\d\d[a-z])\.\d{10}\.hfsb\.parent\.atm\.f000\.grb2"'),
    "hwrf-fc": _storm_model(
        label="HWRF", step=0.125, grid="hwrf",
        raw={**_TROP_COMMON, "qpf_tot": "APCP:surface|tot"},
        note="The HWRF's synoptic domain around each storm, 0.125 deg, to 126 h. Pick the storm under Run.",
        url="/hwrf/prod/hwrf.{ymd}/{hh}/{storm}.{ymd}{hh}.hwrfprs.synoptic.0p125.f{fff}.grb2",
        listing="/hwrf/prod/hwrf.{ymd}/{hh}/",
        token=r'"([a-z]+\d\d[a-z])\.\d{10}\.hwrfprs\.synoptic\.0p125\.f000\.grb2"'),
    "hmon-fc": _storm_model(
        label="HMON", step=0.2, grid="hmon",
        raw={**_TROP_COMMON, "apcp_bkt6": "APCP:surface|bkt6"},
        note="The HMON's outer domain around each storm, 0.2 deg, to 126 h. Pick the storm under Run.",
        url="/hmon/prod/hmon.{ymd}/{hh}/{storm}.{ymd}{hh}.hmonprs.d1.0p20.f{fff}.grb2",
        listing="/hmon/prod/hmon.{ymd}/{hh}/",
        token=r'"([a-z]+\d\d[a-z])\.\d{10}\.hmonprs\.d1\.0p20\.f000\.grb2"'),
})

# The NHC's ATCF guidance: every model's track for the active storms. Nothing
# to shade -- the Models layer draws the tracks themselves (atcf.py).
SOURCES["atcf"] = {
    "label": "ATCF", "org": "NHC", "coverage": "Storm", "group": "Tropical",
    "note": "Every model's track for the active Atlantic and Pacific storms, from the NHC's guidance decks. "
            "Pick the storm under Run; the timeline moves each model's position along its track.",
    "urls": {"nhc": "https://ftp.nhc.noaa.gov/atcf/aid_public/"}, "tracks": True,
    "step": 1.0, "days": 3, "cadence": 360, "raw": {},
    "forecast": {"cycles": (0, 6, 12, 18), "hours": list(range(0, 241, 6))},
}

# ---------------------------------------------------------------------------
# The NDFD: the National Weather Service's own forecast grids, 5 km CONUS,
# from NOAA's AWS copy. One file per element holds every valid time and no
# index; the messages are found by reading their headings
# (model_sources.scan_messages). The record is the element and the valid time.
# ---------------------------------------------------------------------------
def _ndfd(element: str) -> str:
    return f"{element}|{{vunix}}"


_NDFD_RAW = {
    "t2m": _ndfd("temp"), "td2m": _ndfd("td"), "rh2m": _ndfd("rhm"), "feels": _ndfd("apt"), "wbgt2m": _ndfd("wbgt"),
    "wspd10": _ndfd("wspd"), "wdir10": _ndfd("wdir"), "gust": _ndfd("wgust"), "tcdc": _ndfd("sky"),
    "vis": _ndfd("vis"), "nbm_qpf6": _ndfd("qpf"), "p_pop12": _ndfd("pop12"),
    "nbm_snow6": _ndfd("snow"), "ice_6h": _ndfd("iceaccum"),
}
SOURCES["ndfd-fc"] = {
    "label": "NDFD", "org": "NOAA/NWS", "coverage": "CONUS", "group": "Regional",
    "note": "The National Weather Service's own forecast grids -- what the local offices issue -- at 5 km: "
            "hourly to 36 h, then three- and six-hourly to day 7. Only the current issuance is published.",
    "urls": {"aws": "https://noaa-ndfd-pds.s3.amazonaws.com/opnl/AR.conus/{vp}/ds.{var}.bin"},
    "reader": "scan", "probe": "temp",
    "step": 0.05, "days": 7, "cadence": 60, "grid": "ndfd-5km", "raw": _NDFD_RAW,
    # Its totals are six-hour ones only; no window is cut from them.
    "hide": {"qpf_1h", "qpf_3h", "qpf_24h", "qpf_tot", "snow_1h", "snow_24h", "snow_tot"},
    "forecast": {"cycles": tuple(range(24)), "hours": list(range(0, 169))},
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


def _ptype_ensemble(get) -> np.ndarray:
    """_ptype for an ensemble: the type most of its members give, coloured by
    the probability-matched reflectivity."""
    probs = np.stack([get("p_crain"), get("p_csnow"), get("p_cicep"), get("p_cfrzr")])
    probs = np.where(np.isfinite(probs), probs, -1.0)
    kind = np.argmax(probs, axis=0)
    some = probs.max(axis=0) > 0.0
    dbz = get("refc")
    base = (kind * 100.0).astype(np.float32)
    return np.where(some & (dbz >= 5.0), base + np.clip(dbz, 0.0, 75.0), np.nan)


def _rh_from_q(p: int) -> Callable:
    """Relative humidity at a pressure level from its specific humidity."""
    def fn(get):
        q = get(f"q{p}")
        e = q * p / (0.622 + 0.378 * q)  # vapour pressure, hPa
        return np.clip(100.0 * e / _es_hpa(get(f"tmp{p}")), 0.0, 100.0)
    return fn


def _omega(p: int) -> Callable:
    """Omega (Pa/s) from a vertical velocity in m/s, hydrostatically:
    -rho g w, with the density of dry air at that pressure and temperature."""
    def fn(get):
        rho = p * 100.0 / (287.05 * get(f"tmp{p}"))
        return -rho * 9.80665 * get(f"dzdt{p}")
    return fn


# Precipitation type as WMO code table 4.201 has it, which ECMWF and the MSC
# both use: 1 rain, 2 thunderstorm, 3 freezing rain, 4 mixed/ice, 5 snow, 6 wet
# snow, 7 rain and snow, 8 ice pellets, 9 graupel, 10 hail, 11 drizzle, 12
# freezing drizzle -- onto the four kinds the palette draws.
_WMO_KIND = {1: 0.0, 2: 0.0, 3: 300.0, 4: 200.0, 5: 100.0, 6: 100.0, 7: 200.0, 8: 200.0, 9: 200.0,
             10: 200.0, 11: 0.0, 12: 300.0}


def _ptype_coded(get) -> np.ndarray:
    """_ptype for a model with a type code but no reflectivity: its
    precipitation rate stands in, turned into dBZ by Marshall-Palmer
    (Z = 200 R^1.6), as a radar would the other way round."""
    code = np.rint(get("ptype_code"))
    base = np.full(code.shape, np.nan, dtype=np.float32)
    for c, b in _WMO_KIND.items():
        base[code == c] = b
    rate = np.maximum(get("prate") * 3600.0, 1e-6)  # mm/h
    dbz = 10.0 * np.log10(200.0 * rate ** 1.6)
    return np.where(np.isfinite(base) & (dbz >= 5.0), base + np.clip(dbz, 0.0, 75.0), np.nan)


def _forecast_hour(get) -> int:
    if get.fh is None:
        raise RuntimeError("only a forecast has a run to add up")
    return get.fh


def _window(total: str, hours: int) -> Callable:
    """What fell over the last `hours`: the run's total now, less its total then."""
    def make(get) -> np.ndarray:
        fh = _forecast_hour(get)
        now = get(total)
        if fh <= hours:
            return now
        if fh - hours not in SOURCES[get.source]["forecast"]["hours"]:
            raise RuntimeError(f"a {hours} h total needs the hour {hours} h before, and this run skips it")
        # Two totals rounded apart can differ by a hair below zero where nothing fell.
        return np.maximum(now - get.at(fh - hours)(total), 0.0)
    return make


def _steps_by(hours: int) -> Callable[[str], bool]:
    """Whether a source's run moves in steps an `hours` window can be cut from:
    a 1 h total from the six-hourly AIFS would have no hour before to subtract."""
    def ok(source: str) -> bool:
        fc = SOURCES[source].get("forecast")
        if not fc or len(fc["hours"]) < 2:
            return False
        step = fc["hours"][1] - fc["hours"][0]
        return step <= hours and hours % step == 0
    return ok


# Hours folded per batch: fetched side by side, then let go.
_BATCH = 8


def _fold(get, hours: list[int], each: str, running: str, combine: Callable) -> Optional[np.ndarray]:
    """Carry `running` forward through `hours` of the run, starting from the
    latest one it is still kept for; keep it at every hour on the way, so the
    next hour asked for starts where this one stopped."""
    acc: Optional[np.ndarray] = None
    done = 0
    for i in range(len(hours) - 1, -1, -1):
        kept = get.at(hours[i]).kept(running)
        if kept is not None:
            acc, done = kept, i + 1
            break
    rest = hours[done:]
    for i in range(0, len(rest), _BATCH):
        chunk = rest[i:i + _BATCH]
        get.warm(each, chunk)
        for h in chunk:
            g = get.at(h)
            acc = g(each) if acc is None else combine(acc, g(each))
            g.keep(running, acc)
    return acc


def _bucket_total(bucket: str, total: str, every: int = 3) -> Callable:
    """A run total from buckets emptied every `every` hours (the NAM's three,
    the GEFS's six), added up. A bucket closes on every multiple of `every`;
    the one still filling ends at this hour."""
    def make(get) -> np.ndarray:
        fh = _forecast_hour(get)
        start = every * ((fh - 1) // every) if fh else 0
        before = _fold(get, list(range(every, start + 1, every)), bucket, total, np.add)
        here = get(bucket)
        return here if before is None else before + here
    return make


def _hourly_total(hourly: str, total: str) -> Callable:
    """A run total from hour-long buckets, for files that list none of their own."""
    def make(get) -> np.ndarray:
        fh = _forecast_hour(get)
        earlier = [h for h in SOURCES[get.source]["forecast"]["hours"] if 0 < h < fh]
        if len(earlier) != fh - 1:
            raise RuntimeError("adding up hour-long buckets needs every hour of the run")
        before = _fold(get, earlier, hourly, total, np.add)
        here = get(hourly)
        return here if before is None else before + here
    return make


def _synced_total(six: str, one: str, total: str) -> Callable:
    """A run total for the blend, whose six-hour buckets end at 00, 06, 12 and
    18Z whatever hour the run starts. The hours up to the first of those come
    from its hour-long buckets, then one six-hour bucket per six hours, then
    hour-long buckets again past the last one -- which the blend lists only
    while it is hourly (to 48 h)."""
    def make(get) -> np.ndarray:
        fh = _forecast_hour(get)
        lead = (-int(get.key[8:10])) % 6        # hours from the run to the first synoptic hour
        hours = set(SOURCES[get.source]["forecast"]["hours"])
        synced = [h for h in range(lead or 6, fh + 1, 6) if h >= 6 or lead]
        acc: Optional[np.ndarray] = None
        # The latest synoptic hour whose total is still kept.
        done = 0
        for i in range(len(synced) - 1, -1, -1):
            kept = get.at(synced[i]).kept(total)
            if kept is not None:
                acc, done = kept, i + 1
                break
        for h in synced[done:]:
            g = get.at(h)
            if h == lead and lead:
                get.warm(one, list(range(1, lead + 1)))
                part = sum(get.at(k)(one) for k in range(1, lead + 1))
            else:
                part = g(six)
            acc = part if acc is None else acc + part
            g.keep(total, acc)
        last = synced[-1] if synced else 0
        rest = list(range(last + 1, fh + 1))
        if rest and not all(h in hours for h in rest):
            raise RuntimeError("the blend's run total is kept only every six hours past its hourly range")
        if rest:
            get.warm(one, rest)
            tail = sum(get.at(k)(one) for k in rest)
            acc = tail if acc is None else acc + tail
        return acc
    return make


def _run_max(hourly: str, running: str) -> Callable:
    """The most any hour of the run has reached so far: every hour's maximum,
    kept against the ones before it."""
    def make(get) -> np.ndarray:
        fh = _forecast_hour(get)
        earlier = [h for h in SOURCES[get.source]["forecast"]["hours"] if 0 < h < fh]
        before = _fold(get, earlier, hourly, running, np.fmax)
        here = get(hourly)
        return here if before is None else np.fmax(before, here)
    return make


# name -> ways to make it, tried in order; the first whose ingredients the
# source can supply is the one used. A third element, when present, is a test
# the source must also pass.
Recipe = tuple
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
    # Wind given as speed and the direction it blows from (the NBM's).
    "u10": [(("wspd10", "wdir10"), lambda get: -get("wspd10") * np.sin(np.radians(get("wdir10"))))],
    "v10": [(("wspd10", "wdir10"), lambda get: -get("wspd10") * np.cos(np.radians(get("wdir10"))))],
    "snow_tot": [(("nbm_snow6", "snow_1h"), _synced_total("nbm_snow6", "snow_1h", "snow_tot"))],
    "ice_tot": [(("nbm_ice6", "ice_1h"), _synced_total("nbm_ice6", "ice_1h", "ice_tot"))],
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
    "ptype": [(("refd1km", "crain", "csnow", "cicep", "cfrzr"), _ptype), (("ptype_code", "prate"), _ptype_coded),
              (("refc", "p_crain", "p_csnow", "p_cicep", "p_cfrzr"), _ptype_ensemble)],
    # Forecast accumulations: run totals, and the windows cut from them.
    "qpf_tot": [(("nbm_qpf6", "qpf_1h"), _synced_total("nbm_qpf6", "qpf_1h", "qpf_tot")),
                (("apcp_bkt3",), _bucket_total("apcp_bkt3", "qpf_tot")),
                (("apcp_bkt6",), _bucket_total("apcp_bkt6", "qpf_tot", every=6)),
                (("qpf_1h",), _hourly_total("qpf_1h", "qpf_tot"))],
    "swe_tot": [(("weasd_bkt3",), _bucket_total("weasd_bkt3", "swe_tot")),
                (("snowcon_tot", "snowgsp_tot"), lambda get: get("snowcon_tot") + get("snowgsp_tot")),
                (("weasd_1h",), _hourly_total("weasd_1h", "swe_tot"))],
    **{f"qpf_{h}h": [(("qpf_tot",), _window("qpf_tot", h), _steps_by(h))] for h in (1, 3, 24)},
    "qpf_6h": [(("nbm_qpf6",), lambda get: get("nbm_qpf6")), (("qpf_tot",), _window("qpf_tot", 6), _steps_by(6))],
    **{f"snow_{h}h": [(("snow_tot",), _window("snow_tot", h), _steps_by(h))] for h in (1, 24)},
    "snow_6h": [(("nbm_snow6",), lambda get: get("nbm_snow6")), (("snow_tot",), _window("snow_tot", 6), _steps_by(6))],
    # Ten inches of snow to an inch of water: the plain ratio, beside the
    # model's own density above.
    "snow10_tot": [(("swe_tot",), lambda get: get("swe_tot") * 0.01)],
    **{f"snow10_{h}h": [(("snow10_tot",), _window("snow10_tot", h), _steps_by(h))] for h in (6, 24)},
    **{f"{v}_run": [((f"{v}_1h",), _run_max(f"{v}_1h", f"{v}_run"))] for v in ("uh25", "uh03", "uh02", "hail")},
    **{f"wspd{p}": [((f"u{p}", f"v{p}"), _speed(f"u{p}", f"v{p}"))] for p in LEVELS},
    **{f"dpt{p}": [((f"tmp{p}", f"rh{p}"), _dewpoint_from_rh(p))] for p in LEVELS},
    **{f"rh{p}": [((f"tmp{p}", f"q{p}"), _rh_from_q(p))] for p in LEVELS},
    **{f"vvel{p}": [((f"dzdt{p}", f"tmp{p}"), _omega(p))] for p in LEVELS},
    **{f"vort{p}": [((f"absv{p}",), _vort_from_absv(p)), ((f"u{p}", f"v{p}"), _vort_from_wind(p))] for p in LEVELS},
    **{f"div{p}": [((f"u{p}", f"v{p}"), _divergence(p))] for p in LEVELS},
    **{f"tadv{p}": [((f"tmp{p}", f"u{p}", f"v{p}"), _temp_advection(p))] for p in LEVELS},
}

# Kept on the drawing grid once worked out: the next hour's total or maximum
# is built from this hour's.
KEEP = frozenset({"qpf_tot", "swe_tot", "snow10_tot", "snow_tot", "ice_tot",
                  "uh25_run", "uh03_run", "uh02_run", "hail_run"})

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
        for deps, fn, *when in DERIVED.get(name, []):
            if when and not when[0](source):
                continue
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
    "s-1->1e-3": lambda v: v * 1e3,
    "x1e-3": lambda v: v / 1000.0,
}


def _ptype_text(v: float) -> str:
    kind = int(min(max(v // 100, 0), 3))
    return f"{PTYPE_NAMES[kind]} · {round(v - kind * 100)} dBZ"


FORMATS: dict[str, Callable[[float], str]] = {"ptype": _ptype_text}


def _p(label: str, group: str, shade: str, unit: str, palette: list, *, sub: Optional[str] = None,
       convert: Optional[str] = None, lines: Optional[dict] = None, barbs: Optional[tuple[str, str]] = None,
       smooth_km: float = 0.0, decimals: int = 0, stepped: bool = False, note: str = "",
       fmt: Optional[str] = None, labels: Optional[list[dict]] = None, lut_steps: int = 256,
       outline: Optional[dict] = None) -> dict:
    """`outline` draws where another variable crosses a level, as black lines
    over the colours: {"var": "uh25_1h", "level": 75} marks the rotating
    updrafts on a reflectivity picture."""
    return {"label": label, "group": group, "sub": sub, "shade": shade, "unit": unit, "palette": palette,
            "convert": convert, "lines": lines, "barbs": barbs, "smooth_km": smooth_km,
            "decimals": decimals, "stepped": stepped, "note": note, "fmt": fmt, "labels": labels,
            "lut_steps": lut_steps, "outline": outline}


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
    "wbgt": _p("2m Wet Bulb Globe Temperature", S, "wbgt2m", "°F", TEMP_F, sub="Temperature", convert="K->F",
               note="Heat stress in the sun: temperature, humidity, wind and sunshine together."),
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
    "gust_max": _p("Max 10m Wind Gusts", S, "gust_max", "mph", WIND_MPH, sub="Wind", convert="ms->mph",
                   note="The strongest gust any member gives."),
    "p_gust40": _p("Probability of 40+ MPH Gusts", S, "p_gust40", "%", PROB_PCT, sub="Wind",
                   note="ECMWF's gust is the strongest of the last few hours."),
    "p_gust75": _p("Probability of 75+ MPH Gusts", S, "p_gust75", "%", PROB_PCT, sub="Wind",
                   note="ECMWF's gust is the strongest of the last few hours."),
    "wind80m": _p("80m Wind", S, "wspd80", "mph", WIND_MPH, sub="Wind", convert="ms->mph", lines=own(10),
                  barbs=wind(80), note="Hub height: the wind a turbine -- or a low-level jet at dusk -- feels."),
    # ----- Surface: pressure
    "mslp": _p("Sea Level Pressure", S, "mslp", "hPa", PRES_HPA, sub="Pressure", convert="Pa->hPa", lines=own(4)),
    "mslp_min": _p("Minimum Sea Level Pressure", S, "mslp_min", "hPa", PRES_HPA, sub="Pressure", convert="Pa->hPa",
                   note="The lowest pressure any member gives at each point: where a deep low could be."),
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
    "p_vis025": _p("Probability of Visibility < 1/4 Mile", "Clouds & Visibility", "p_vis025", "%", PROB_PCT,
                   sub="Probabilities"),
    "p_vis05": _p("Probability of Visibility < 1/2 Mile", "Clouds & Visibility", "p_vis05", "%", PROB_PCT,
                  sub="Probabilities"),
    "p_vis1": _p("Probability of Visibility < 1 Mile", "Clouds & Visibility", "p_vis1", "%", PROB_PCT,
                 sub="Probabilities"),
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
    "lr03": _p("0-3 km Lapse Rate", UA, "lr03", "°C/km", LAPSE_CKM, sub="Lapse Rates", lines=own(1, lo=7),
               decimals=1, note="From the 2 m temperature to 3 km above ground: steep low levels speed updrafts."),
    # ----- Precipitation
    "refc": _p("Composite Reflectivity", "Precipitation", "refc", "dBZ", REFL_DBZ, stepped=True,
               note="The model's own reflectivity, not the radar mosaic."),
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
                note="The model's diagnosed type, coloured by its 1 km reflectivity."),
    "ptype_mslp": _p("Precipitation Type + MSLP", "Precipitation", "ptype", "", PTYPE_PAL, fmt="ptype",
                     lut_steps=1024, lines=MSLP_LINES,
                     labels=[{"v": 50, "t": "Rain"}, {"v": 150, "t": "Snow"}, {"v": 250, "t": "Sleet"},
                             {"v": 350, "t": "Frz rain"}],
                     note="The model's diagnosed type, coloured by its 1 km reflectivity."),
    **{f"qpf_{h}h": _p(f"{h}-Hour Precipitation", "Precipitation", f"qpf_{h}h", "in", QPF_IN, sub="Accumulated",
                       convert="kgm2->in", decimals=2) for h in (1, 3, 6, 24)},
    "qpf_tot": _p("Total Precipitation", "Precipitation", "qpf_tot", "in", QPF_IN, sub="Accumulated",
                  convert="kgm2->in", decimals=2, note="Everything since the run began."),
    "p_pop12": _p('Probability of 12-h QPF > .01"', "Precipitation", "p_pop12", "%", PROB_PCT, sub="Probabilities",
                  note="The forecast offices' chance of measurable rain in the 12 hours to this time."),
    "p_qpf24_001": _p('Probability of 24-h QPF > .01"', "Precipitation", "p_qpf24_001", "%", PROB_PCT,
                      sub="Probabilities"),
    "p_qpf24_1": _p('Probability of 24-h QPF > 1"', "Precipitation", "p_qpf24_1", "%", PROB_PCT, sub="Probabilities",
                    note="The HREF and REFS give it every 12 hours (F024, F036, F048)."),
    "p_qpf24_4": _p('Probability of 24-h QPF > 4"', "Precipitation", "p_qpf24_4", "%", PROB_PCT, sub="Probabilities"),
    "p_qpf24_5": _p('Probability of 24-h QPF > 5"', "Precipitation", "p_qpf24_5", "%", PROB_PCT, sub="Probabilities",
                    note="Published every 12 hours: at F024, F036, F048."),
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
    "mllcl": _p("Mixed-Layer LCL Height", SV, "mllcl", "m", LCL_M, sub="Parcel Heights",
                note="Above ground, for the lowest 100 mb's mean parcel: the LCL in SPC's STP."),
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
    "esrh": _p("Effective Storm-Relative Helicity", SV, "esrh", "m²/s²", SRH_M2S2, sub="Kinematics",
               lines=own(100, lo=100),
               note="Over the effective inflow layer: the levels whose parcels have 100 J/kg of CAPE and no more "
                    "than 250 of CIN. Zero where storms would have no inflow to draw on."),
    "ebwd": _p("Effective Bulk Shear", SV, "ebwd", "kt", SHR6_KT, sub="Kinematics", convert="ms->kt",
               lines=own(10, lo=30),
               note="From the base of the effective inflow layer half way to the most unstable parcel's "
                    "equilibrium level. 40 kt and up supports supercells."),
    # ----- Severe weather: composites
    "stp": _p("Significant Tornado Parameter", SV, "stp", "", STP_PAL, sub="Composite", lines=own(1, lo=1),
              decimals=1, note="Fixed layer: SBCAPE, surface LCL, 0-1 km SRH, 0-6 km shear."),
    "scp": _p("Supercell Composite Parameter", SV, "scp", "", SCP_PAL, sub="Composite", lines=own(2, lo=2),
              decimals=1, note="Fixed layers standing in for effective ones: MUCAPE, 0-3 km SRH, 0-6 km shear, MUCIN."),
    "ship": _p("Significant Hail Parameter", SV, "ship", "", SHIP_PAL, sub="Composite", lines=own(1, lo=1),
               decimals=1, note="SPC's SHIP, with the 2 m mixing ratio standing in for the most-unstable parcel's."),
    "ehi1": _p("0-1 km Energy-Helicity Index", SV, "ehi1", "", EHI_PAL, sub="Composite", lines=own(1, lo=1), decimals=1),
    "ehi3": _p("0-3 km Energy-Helicity Index", SV, "ehi3", "", EHI_PAL, sub="Composite", lines=own(1, lo=1), decimals=1),
    "stp_eff": _p("Significant Tornado Parameter (effective)", SV, "stp_eff", "", STP_PAL, sub="Composite",
                  lines=own(1, lo=1), decimals=1,
                  note="SPC's effective-layer STP with CIN (Thompson et al. 2012): MLCAPE, ML LCL, effective SRH, "
                       "effective shear, MLCIN; zero where the inflow layer is not at the ground."),
    "scp_eff": _p("Supercell Composite Parameter (effective)", SV, "scp_eff", "", SCP_PAL, sub="Composite",
                  lines=own(2, lo=2), decimals=1,
                  note="MUCAPE, effective SRH and effective shear, with the MUCIN term, as SPC draws it."),
    "craven": _p("Craven-Brooks Significant Severe", SV, "craven", "10³ m³/s³", CRAVEN_PAL, sub="Composite",
                 convert="x1e-3", lines=own(20, lo=20),
                 note="MLCAPE times 0-6 km shear; 20 000 m³/s³ separates significant severe from the rest."),
    # ----- Severe weather: what the storms themselves do, hour by hour
    "refc_uh75": _p("Composite Reflectivity + UH > 75", SV, "refc", "dBZ", REFL_DBZ, sub="Storm Attributes",
                    stepped=True, outline={"var": "uh25_1h", "level": 75.0},
                    note="Outlined in black: where the hour's 2-5 km updraft helicity passed 75 m²/s² -- the "
                         "model's supercells."),
    "uh25_1h": _p("2-5 km Updraft Helicity (1 h max)", SV, "uh25_1h", "m²/s²", UH_M2S2, sub="Storm Attributes",
                  note="Rotating updrafts: the tracks of the model's supercells. 75 and up is a strong one."),
    "uh25_run": _p("2-5 km Updraft Helicity (run max)", SV, "uh25_run", "m²/s²", UH_M2S2, sub="Storm Attributes",
                   note="The strongest hour at each point since the run began: whole supercell tracks."),
    "uh03_1h": _p("0-3 km Updraft Helicity (1 h max)", SV, "uh03_1h", "m²/s²", UH_LOW_M2S2, sub="Storm Attributes",
                  note="Rotation near the ground, where tornadoes form."),
    "uh03_run": _p("0-3 km Updraft Helicity (run max)", SV, "uh03_run", "m²/s²", UH_LOW_M2S2, sub="Storm Attributes"),
    "uh02_1h": _p("0-2 km Updraft Helicity (1 h max)", SV, "uh02_1h", "m²/s²", UH_LOW_M2S2, sub="Storm Attributes"),
    "uh02_run": _p("0-2 km Updraft Helicity (run max)", SV, "uh02_run", "m²/s²", UH_LOW_M2S2, sub="Storm Attributes"),
    "hail_1h": _p("Max Hail Size (1 h)", SV, "hail_1h", "in", HAIL_IN, sub="Storm Attributes", convert="m->in",
                  decimals=2, note="The largest hail anywhere in the column over the hour."),
    "hail_run": _p("Max Hail Size (run max)", SV, "hail_run", "in", HAIL_IN, sub="Storm Attributes", convert="m->in",
                   decimals=2),
    "maxref_1h": _p("1 km Reflectivity (1 h max)", SV, "maxref_1h", "dBZ", REFL_DBZ, sub="Storm Attributes",
                    stepped=True),
    "maxuvv_1h": _p("Max Updraft Speed (1 h)", SV, "maxuvv_1h", "m/s", UVV_MS, sub="Storm Attributes", decimals=1),
    "relv1_1h": _p("0-1 km Cyclonic Vorticity (1 h max)", SV, "relv1_1h", "10⁻³ s⁻¹", RELV_PAL,
                   sub="Storm Attributes", convert="s-1->1e-3", decimals=1),
    "relv2_1h": _p("0-2 km Cyclonic Vorticity (1 h max)", SV, "relv2_1h", "10⁻³ s⁻¹", RELV_PAL,
                   sub="Storm Attributes", convert="s-1->1e-3", decimals=1),
    "wmax_1h": _p("10m Max Wind Speed (1 h)", SV, "wmax_1h", "mph", WIND_MPH, sub="Storm Attributes",
                  convert="ms->mph"),
    "ltng": _p("Lightning Flash Density", SV, "ltng", "fl/km²/5 min", LTNG_PAL, sub="Storm Attributes", decimals=2),
    # ----- Severe weather: ensemble and blend probabilities
    **{f"p_uh{v}": _p(f"Probability of Updraft Helicity > {v}", SV, f"p_uh{v}", "%", PROB_PCT, sub="Probabilities",
                      note="Share of the ensemble's members with 2-5 km UH above it, within a neighbourhood.")
       for v in (25, 75, 150)},
    **{f"p_mlcape{v}": _p(f"Probability of MLCAPE > {v}", SV, f"p_mlcape{v}", "%", PROB_PCT, sub="Probabilities")
       for v in (500, 1000, 2000)},
    **{f"p_mlcin{v}": _p(f"Probability of MLCIN < -{v}", SV, f"p_mlcin{v}", "%", PROB_PCT, sub="Probabilities")
       for v in (50, 100)},
    **{f"p_srh{v}": _p(f"Probability of 0-3 km SRH > {v}", SV, f"p_srh{v}", "%", PROB_PCT, sub="Probabilities")
       for v in (100, 200, 400)},
    "p_wind58": _p("Probability of Wind > 58 MPH", SV, "p_wind58", "%", PROB_PCT, sub="Probabilities"),
    "p_ltng": _p("Lightning Probability", SV, "p_ltng", "%", PROB_PCT, sub="Probabilities"),
    "p_tstm": _p("Thunderstorm Probability (3 h)", SV, "p_tstm", "%", PROB_PCT, sub="Probabilities"),
    "p_drytstm": _p("Dry Thunderstorm Probability (3 h)", SV, "p_drytstm", "%", PROB_PCT, sub="Probabilities",
                    note="Thunder with little rain: lightning that starts fires."),
    # ----- Winter
    "snod": _p("Snow Depth", "Winter Weather", "snod", "in", SNOW_IN, convert="m->in", decimals=1),
    "swe": _p("Snow Water Equivalent", "Winter Weather", "weasd", "in", SWE_IN, convert="kgm2->in", decimals=2),
    "snowc": _p("Snow Cover", "Winter Weather", "snowc", "%", SNOWC_PCT),
    "snow_tot": _p("Total Snowfall", "Winter Weather", "snow_tot", "in", SNOW_IN, sub="Snowfall", convert="m->in",
                   decimals=1, note="With the model's own snow density, not a fixed ratio."),
    **{f"snow_{h}h": _p(f"{h}-Hour Snowfall", "Winter Weather", f"snow_{h}h", "in", SNOW_IN, sub="Snowfall",
                        convert="m->in", decimals=1) for h in (1, 6, 24)},
    "snow10_tot": _p("Total Snowfall (10:1)", "Winter Weather", "snow10_tot", "in", SNOW_IN, sub="Snowfall",
                     convert="m->in", decimals=1, note="Ten inches of snow to every inch of water that fell as snow."),
    **{f"snow10_{h}h": _p(f"{h}-Hour Snowfall (10:1)", "Winter Weather", f"snow10_{h}h", "in", SNOW_IN,
                          sub="Snowfall", convert="m->in", decimals=1) for h in (6, 24)},
    "ice_6h": _p("6-Hour Ice Accumulation", "Winter Weather", "ice_6h", "in", ICE_IN, convert="kgm2->in", decimals=2),
    "ice_tot": _p("Total Ice Accumulation", "Winter Weather", "ice_tot", "in", ICE_IN, convert="kgm2->in",
                  decimals=2, note="Ice on flat surfaces since the run began."),
    **{f"p_snow24_{v}": _p(f'Probability of 24-h Snowfall (10:1) > {v}"', "Winter Weather", f"p_snow24_{v}", "%",
                           PROB_PCT, sub="Snowfall") for v in (1, 6, 12)},
    "frzr_tot": _p("Total Freezing Rain", "Winter Weather", "frzr_tot", "in", FRZR_IN, convert="kgm2->in",
                   decimals=2, note="Ice that accreted since the run began."),
    # ----- Tropical tracks (ATCF): drawn as lines, not shaded
    "trk_sel": _p("Spaghetti Plot", "Tropical", "tracks", "", SS_KT, sub="Selected guidance",
                  note="NHC's forecast (white), the consensus and the main dynamical models, each its own colour."),
    "trk_int_sel": _p("Spaghetti Plot - Intensity", "Tropical", "tracks", "kt", SS_KT, sub="Selected guidance",
                      stepped=True, labels=SS_LABELS, note="Each track coloured by the storm's strength along it."),
    "trk_all": _p("Spaghetti Plot", "Tropical", "tracks", "", SS_KT, sub="All guidance",
                  note="Every aid in the deck, statistical ones included."),
    "trk_int_all": _p("Spaghetti Plot - Intensity", "Tropical", "tracks", "kt", SS_KT, sub="All guidance",
                      stepped=True, labels=SS_LABELS),
    "trk_gefs": _p("GEFS Member Tracks", "Tropical", "tracks", "", SS_KT, sub="Ensemble guidance",
                   note="The GEFS control and its 30 members (thin) around their mean (thick). NHC posts them "
                        "at 00, 06 and 12Z; pick one of those cycles under Run."),
    # ----- Simulated satellite
    "sim_ir": _p("Simulated IR Satellite", "Simulated Satellite", "sbt124", "°C", IR_C, convert="K->C",
                 note="What the GOES 10.7 µm window channel would see in the model's clouds."),
    "sim_wv": _p("Simulated Water Vapor", "Simulated Satellite", "sbt123", "°C", WV_C, convert="K->C",
                 note="The 6.5 µm water vapour channel: the mid-level moisture and dry slots."),
}

# MRMS, the national radar mosaic: its sources and products are kept in their
# own module, which writes them into the tables above.
import mrms_products  # noqa: E402,F401
