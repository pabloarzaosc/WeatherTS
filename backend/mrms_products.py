"""
MRMS in the analyses catalogue: its three sources, their raw variables, and
the products drawn from them -- the national radar mosaic, hail and rotation
tracks, lightning, echo tops and VIL, rainfall, and flash flooding.

Imported at the end of obs_products, into whose tables it writes; mrms.py does
the reading. Units, missing codes and cadences were read off the live files
(2026-09-24), not taken from documentation:
  * reflectivity dBZ; echo tops and the hail-layer heights km; composite
    reflectivity height, the 0 °C height and the bright band m; MESH, rain
    rate (per hour) and totals mm; the model temperatures °C; rotation in
    units of 0.001 s-1 (a strong mesocyclone is 10-20); VIL and VII kg m-2,
    VIL density g m-3; lightning density flashes km-2 min-1; the FLASH
    ratio of rainfall to flash-flood guidance in percent, recurrence
    intervals in years, streamflow m3 s-1, unit streamflow m3 s-1 km-2.
  * Most products every two minutes; the model temperatures, the hourly
    maxima and the multi-sensor totals hourly; FLASH streamflow every ten.
"""
from __future__ import annotations

import numpy as np

from obs_products import (
    CONVERT, DERIVED, ETOP_KFT, FORMATS, PRATE_INHR, PRODUCTS, PROB_PCT, PTYPE_PAL, QPF_IN, REFL_DBZ, SOURCES,
    T0, TEMP_F, VIL_KGM2, _p,
)

CONVERT.update({
    "km->kft": lambda v: v * 3.28084,
    "mm->in": lambda v: v / 25.4,
    "C->F": lambda v: v * 9.0 / 5.0 + 32.0,
})

_URL = "mrms:{region}|{{ymd}}{{hh}}{{mm}}|{{var}}"

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
_HEIGHTS_Z = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16)
_HEIGHTS_DP = (1, 2, 3, 4, 5, 6, 8, 10)
_ROT = (30, 60, 120, 240, 360, 1440)
_SWATH = (30, 60, 120, 240, 360, 1440)
_RO = ("01H", "03H", "06H", "12H", "24H", "48H", "72H")


def _km(h: int) -> str:
    return f"{h:05.2f}"


_MRMS_RAW = {
    # --- reflectivity
    "mr_cref": "MergedReflectivityQCComposite_00.50",
    "mr_cref_raw": "MergedReflectivityComposite_00.50",
    "mr_bref": "MergedBaseReflectivityQC_00.50",
    "mr_ral": "ReflectivityAtLowestAltitude_00.50",
    "mr_hsr": "SeamlessHSR_00.00",
    "mr_llcref": "LowLevelCompositeReflectivity_00.50",
    "mr_lc_low": "LayerCompositeReflectivity_Low_00.50",
    "mr_lc_high": "LayerCompositeReflectivity_High_00.50",
    "mr_lc_super": "LayerCompositeReflectivity_Super_00.50",
    "mr_cref_1h": "CREF_1HR_MAX_00.50+3700",
    "mr_bref_1h": "BREF_1HR_MAX_00.50+3700",
    "mr_cref_hgt": "HeightCompositeReflectivity_00.50~0",
    "mr_ref_0c": "Reflectivity_0C_00.50",
    "mr_ref_m5c": "Reflectivity_-5C_00.50",
    "mr_ref_m10c": "Reflectivity_-10C_00.50",
    "mr_ref_m15c": "Reflectivity_-15C_00.50",
    "mr_ref_m20c": "Reflectivity_-20C_00.50",
    **{f"mr_z{h}": f"MergedReflectivityQC_{_km(h)}" for h in _HEIGHTS_Z},
    # The dual-pol mosaics every five minutes.
    **{f"mr_rho{h}": f"MergedRhoHV_{_km(h)}~0+330" for h in _HEIGHTS_DP},
    **{f"mr_zdr{h}": f"MergedZdr_{_km(h)}+330" for h in _HEIGHTS_DP},
    # --- precipitation type and the temperatures that decide it
    "mr_pflag": "PrecipFlag_00.00~0",
    "mr_tsfc": "Model_SurfaceTemp_00.50+10800",
    "mr_tw": "Model_WetBulbTemp_00.50+10800",
    "mr_frz": "Model_0degC_Height_00.50~0+10800",
    "mr_bbtop": "BrightBandTopHeight_00.00~0",
    "mr_bbbot": "BrightBandBottomHeight_00.00~0",
    # --- hail
    "mr_mesh": "MESH_00.50~0",
    # The swaths of two hours and more come every half hour.
    **{f"mr_mesh{n}": f"MESH_Max_{n}min_00.50~0" + ("+1900" if n >= 120 else "") for n in _SWATH},
    "mr_posh": "POSH_00.50~0",
    "mr_shi": "SHI_00.50~0",
    "mr_h50_0c": "H50_Above_0C_00.50~0",
    "mr_h50_m20c": "H50_Above_-20C_00.50~0",
    "mr_h60_0c": "H60_Above_0C_00.50~0",
    "mr_h60_m20c": "H60_Above_-20C_00.50~0",
    # --- rotation
    "mr_az_low": "MergedAzShear_0-2kmAGL_00.50",
    "mr_az_mid": "MergedAzShear_3-6kmAGL_00.50",
    **{f"mr_rot{n}": f"RotationTrack{n}min_00.50~0" + ("+1900" if n >= 120 else "") for n in _ROT},
    **{f"mr_rotml{n}": f"RotationTrackML{n}min_00.50~0" + ("+1900" if n >= 120 else "") for n in _ROT},
    # --- lightning
    **{f"mr_cg{n}": f"NLDN_CG_{n:03d}min_AvgDensity_00.00~0" for n in (1, 5, 15, 30)},
    "mr_ltgp30": "LightningProbabilityNext30minGrid_scale_1~0",
    "mr_ltgp60": "LightningProbabilityNext60minGrid_scale_1~0",
    "mr_jump": "LtgJumpGrid_scale_1~0",
    "mr_jump5": "LtgJumpGrid_Max_005min_scale_1~0",
    # --- storm structure
    **{f"mr_et{d}": f"EchoTop_{d}_00.50~0" for d in (18, 30, 50, 60)},
    "mr_vil": "VIL_00.50~0",
    "mr_vild": "VIL_Density_00.50~0",
    "mr_vii": "VII_00.50~0",
    "mr_vil120": "VIL_Max_120min_00.50~0+1900",
    "mr_vil1440": "VIL_Max_1440min_00.50~0+1900",
    # --- rainfall, radar only
    "mr_rate": "PrecipRate_00.00~0",
    "mr_ro15m": "RadarOnly_QPE_15M_00.00~0+960",
    # The hour's total every two minutes; the longer ones hourly.
    **{f"mr_ro{h.lower()}": f"RadarOnly_QPE_{h}_00.00~0" + ("" if h == "01H" else "+3700") for h in _RO},
    "mr_ro12z": "RadarOnly_QPE_Since12Z_00.00~0+3700",
    "mr_rqi": "RadarQualityIndex_00.00~0",
    "mr_warmrain": "WarmRainProbability_00.50~0+3700",
}

SOURCES["mrms"] = {
    "label": "MRMS Radar Mosaic 1 km", "org": "NOAA/NSSL", "coverage": "CONUS",
    "note": "Every radar in the country merged every two minutes: reflectivity, hail and rotation tracks, "
            "lightning, echo tops, VIL and rainfall.",
    "group": "Radar mosaic",
    "reader": "mrms", "region": "CONUS", "probe": "MergedReflectivityQCComposite_00.50",
    "urls": {"aws": _URL.format(region="CONUS")},
    # The files' own 0.01 degree grid, so the zoomed picture has every cell.
    "step": 0.01, "days": 1, "cadence": 2, "sharp": True, "frames_ttl": 60.0, "edge": False,
    "raw": _MRMS_RAW,
}

SOURCES["mrms-qpe"] = {
    "label": "MRMS Multi-Sensor QPE", "org": "NOAA/NSSL", "coverage": "CONUS",
    "note": "Rainfall from radar, gauges and the model together, hourly. The gauge-corrected second pass "
            "where it is out (about two hours after), the first pass for the newest hours.",
    "group": "Radar mosaic",
    "reader": "mrms", "region": "CONUS", "probe": "MultiSensor_QPE_01H_Pass1_00.00",
    "urls": {"aws": _URL.format(region="CONUS")},
    "step": 0.01, "days": 7, "cadence": 60, "sharp": True, "frames_ttl": 300.0, "edge": False,
    "raw": {f"mq_{h.lower()}": f"MultiSensor_QPE_{h}_Pass2_00.00~0;MultiSensor_QPE_{h}_Pass1_00.00~0" for h in _RO},
}

SOURCES["mrms-flash"] = {
    "label": "MRMS FLASH Flash Flooding", "org": "NOAA/NSSL", "coverage": "CONUS",
    "note": "How rare the rain is, how it compares to flash-flood guidance, and the streamflow it makes "
            "in three hydrologic models -- every ten minutes.",
    "group": "Radar mosaic",
    "reader": "mrms", "region": "CONUS", "probe": "FLASH_CREST_MAXUNITSTREAMFLOW_00.00",
    "urls": {"aws": _URL.format(region="CONUS")},
    "step": 0.01, "days": 2, "cadence": 10, "sharp": True, "frames_ttl": 120.0, "edge": False,
    "raw": {
        **{f"mf_ari{w.lower()}": f"FLASH_QPE_ARI{w}_00.00~0" for w in ("30M", "01H", "03H", "06H", "12H", "24H", "MAX")},
        **{f"mf_ffg{w.lower()}": f"FLASH_QPE_FFG{w}_00.00~0" for w in ("01H", "03H", "06H", "MAX")},
        **{f"mf_{m.lower()}_{k}": f"FLASH_{m}_MAX{v}_00.00~0"
           for m in ("CREST", "SAC", "HP") for k, v in (("flow", "STREAMFLOW"), ("unit", "UNITSTREAMFLOW"))},
        "mf_crest_soil": "FLASH_CREST_MAXSOILSAT_00.00~0",
        "mf_sac_soil": "FLASH_SAC_MAXSOILSAT_00.00~0",
    },
}

# ---------------------------------------------------------------------------
# Palettes, in each product's display unit
# ---------------------------------------------------------------------------
# Hail in inches, a colour every quarter inch: pea, penny, quarter, golf ball,
# tennis ball, baseball and up.
MESH_IN = [
    (0, T0), (0.24, T0), (0.25, "#a6dcf5"), (0.5, "#4fb5e8"), (0.75, "#35a853"), (1.0, "#f2e23c"),
    (1.25, "#f5b52e"), (1.5, "#f08a24"), (1.75, "#e8561e"), (2.0, "#c8281e"), (2.5, "#d23fa4"),
    (3.0, "#8c2fc0"), (4.0, "#f2e6ff"),
]
POSH_PCT = [(0, T0), (9.9, T0), (10, "#a6dcf5"), (30, "#35a853"), (50, "#f2e23c"), (70, "#f08a24"),
            (90, "#c8281e"), (100, "#8c2fc0")]
SHI = [(0, T0), (9.9, T0), (10, "#a6dcf5"), (25, "#35a853"), (50, "#f2e23c"), (100, "#f08a24"),
       (150, "#c8281e"), (200, "#d23fa4"), (300, "#8c2fc0")]
# Rotation, 0.001 s-1: weak from 4, a mesocyclone from about 10, tornadic past 20.
# Below 5 it is the speckle every shower has; drawn, it buried the tracks.
ROT = [(0, T0), (4.9, T0), (5, "#8fd3f4"), (6.5, "#48b86a"), (8, "#c8e03c"), (10, "#f2e23c"), (12, "#f5b52e"),
       (15, "#e8561e"), (20, "#c8281e"), (30, "#d23fa4"), (40, "#f2e6ff")]
# Instantaneous shear both ways: cyclonic warm, anticyclonic cool.
AZ = [(-20, "#1d2670"), (-10, "#3553b8"), (-5, "#8fb4e8"), (-4.9, T0), (4.9, T0), (5, "#8fd3f4"), (6.5, "#48b86a"),
      (8, "#c8e03c"), (10, "#f2e23c"), (12, "#f5b52e"), (15, "#e8561e"), (20, "#c8281e"), (30, "#d23fa4")]
# Lightning density as the NLDN grids it: a cell with a flash reads about 0.87
# and up (measured 2026-09-24: nothing between 0 and 0.866), a busy core 2-3.
LTG_DEN = [(0, T0), (0.8, T0), (0.85, "#3553b8"), (1.0, "#3f9fdf"), (1.25, "#48b86a"), (1.5, "#c8e03c"),
           (1.75, "#f2e23c"), (2.0, "#f5b52e"), (2.5, "#e8561e"), (3.0, "#c8281e"), (4.0, "#d23fa4")]
LTG_PROB = [(0, T0), (9.9, T0), (10, "#a6dcf5"), (25, "#35a853"), (50, "#f2e23c"), (75, "#f08a24"),
            (90, "#c8281e"), (100, "#8c2fc0")]
JUMP = [(0, T0), (0.5, T0), (1, "#f2e23c"), (2, "#f08a24"), (3, "#c8281e"), (4, "#c8281e")]
JUMP_LABELS = [{"v": 1.5, "t": "1σ"}, {"v": 2.5, "t": "2σ"}, {"v": 3.5, "t": "3σ"}]
VILD = [(0, T0), (0.99, T0), (1, "#a6dcf5"), (1.5, "#35a853"), (2, "#c8e03c"), (2.5, "#f2e23c"), (3, "#f08a24"),
        (3.5, "#e8561e"), (4, "#c8281e"), (5, "#8c2fc0")]
VII = [(0, T0), (0.5, T0), (1, "#a6dcf5"), (3, "#35a853"), (6, "#f2e23c"), (10, "#f08a24"), (20, "#e8561e"),
       (35, "#c8281e"), (50, "#8c2fc0")]
# How deep the 50/60 dBZ core reaches above a freezing level, km: the hail layer.
CORE_KM = [(0, T0), (0.24, T0), (0.25, "#a6dcf5"), (1, "#35a853"), (2, "#f2e23c"), (3, "#f08a24"),
           (4, "#e8561e"), (5, "#c8281e"), (6, "#8c2fc0")]
HGT_KFT = [(0, "#1d2670"), (5, "#3553b8"), (10, "#3f9fdf"), (15, "#48b86a"), (20, "#c8e03c"), (25, "#f2e23c"),
           (30, "#f5b52e"), (40, "#e8561e"), (50, "#c8281e"), (60, "#8c2fc0")]
ZDR_DB = [(-2, "#3a3a3a"), (-0.5, "#8a8a8a"), (0, "#c4c4c4"), (0.5, "#3553b8"), (1, "#3f9fdf"), (1.5, "#48b86a"),
          (2, "#c8e03c"), (2.5, "#f2e23c"), (3, "#f5b52e"), (4, "#e8561e"), (5, "#c8281e"), (6, "#d23fa4"),
          (8, "#f2e6ff")]
CC = [(0.2, "#16163f"), (0.45, "#2a3fa0"), (0.65, "#3f9fdf"), (0.75, "#48b86a"), (0.85, "#c8e03c"),
      (0.9, "#f2e23c"), (0.93, "#f5b52e"), (0.95, "#e8561e"), (0.97, "#c8281e"), (0.99, "#d23fa4"),
      (1.05, "#f2e6ff")]
RQI = [(0, "#7a2020"), (0.25, "#e8561e"), (0.5, "#f2e23c"), (0.75, "#48b86a"), (1, "#2f9b74")]
# Recurrence intervals on a log axis (log10 years): 1, 2, 5, 10, 25, 50, 100, 200.
ARI_LOG = [(-0.5, T0), (-0.01, T0), (0.0, "#b8e6b8"), (0.3, "#48b86a"), (0.7, "#f2e23c"), (1.0, "#f5b52e"),
           (1.4, "#e8561e"), (1.7, "#c8281e"), (2.0, "#d23fa4"), (2.3, "#8c2fc0"), (2.5, "#8c2fc0")]
ARI_LABELS = [{"v": 0.0, "t": "1"}, {"v": 0.3, "t": "2"}, {"v": 0.7, "t": "5"}, {"v": 1.0, "t": "10"},
              {"v": 1.4, "t": "25"}, {"v": 1.7, "t": "50"}, {"v": 2.0, "t": "100"}, {"v": 2.3, "t": "200 yr"}]
FFG_PCT = [(0, T0), (49, T0), (50, "#a6dcf5"), (75, "#35a853"), (100, "#f2e23c"), (125, "#f5b52e"),
           (150, "#e8561e"), (200, "#c8281e"), (300, "#8c2fc0")]
# Streamflow on log axes: log10 m3 s-1, and log10 m3 s-1 km-2.
FLOW_LOG = [(0.0, T0), (0.99, T0), (1.0, "#a6dcf5"), (1.7, "#35a853"), (2.0, "#c8e03c"), (2.4, "#f2e23c"),
            (2.7, "#f5b52e"), (3.0, "#e8561e"), (3.4, "#c8281e"), (3.7, "#d23fa4"), (4.3, "#f2e6ff")]
FLOW_LABELS = [{"v": 1.0, "t": "10"}, {"v": 2.0, "t": "100"}, {"v": 3.0, "t": "1k"}, {"v": 4.0, "t": "10k m³/s"}]
UNIT_LOG = [(-1.0, T0), (-0.71, T0), (-0.7, "#a6dcf5"), (-0.3, "#35a853"), (0.0, "#c8e03c"), (0.3, "#f2e23c"),
            (0.5, "#f5b52e"), (0.7, "#e8561e"), (1.0, "#c8281e"), (1.3, "#d23fa4"), (1.5, "#f2e6ff")]
UNIT_LABELS = [{"v": -0.7, "t": "0.2"}, {"v": 0.0, "t": "1"}, {"v": 0.3, "t": "2"}, {"v": 0.7, "t": "5"},
               {"v": 1.0, "t": "10"}, {"v": 1.3, "t": "20"}]
SOIL_PCT = [(0, "#7a4a20"), (20, "#b98a45"), (40, "#d8d08a"), (60, "#7fbf6a"), (80, "#2f9b74"), (100, "#1f6f9b")]
# Precipitation type by MRMS's flag.
PFLAG = [(0, "#4caf50"), (1, "#9ccc65"), (2, "#fdd835"), (3, "#e53935"), (4, "#64b5f6"), (5, "#26a69a"),
         (6, "#ab47bc"), (7, "#ab47bc")]
PFLAG_NAMES = ["Warm stratiform rain", "Cold stratiform rain", "Convective rain", "Rain and hail", "Snow",
               "Tropical stratiform rain", "Tropical convective rain"]
PFLAG_LABELS = [{"v": k + 0.5, "t": t} for k, t in enumerate(("Warm", "Cold", "Conv.", "Hail", "Snow", "Trop.", "Trop. conv."))]
RMS_NAMES = ["Rain", "Snow", "Mix", "Freezing rain"]
RMS_LABELS = [{"v": 50, "t": "Rain"}, {"v": 150, "t": "Snow"}, {"v": 250, "t": "Mix"}, {"v": 350, "t": "Frz rain"}]


# ---------------------------------------------------------------------------
# Derived variables
# ---------------------------------------------------------------------------
_RAIN_FLAGS = (1.0, 2.0, 6.0, 7.0, 10.0, 91.0, 96.0)
_SNOW_FLAGS = (3.0, 4.0)
_FLAG_CLASS = {1.0: 0, 2.0: 0, 10.0: 1, 6.0: 2, 7.0: 3, 3.0: 4, 4.0: 4, 91.0: 5, 96.0: 6}


def _rain_mix_snow(get) -> np.ndarray:
    """The seamless hybrid-scan reflectivity, coloured by what is falling: 0-100
    rain, 100-200 snow, 200-300 mix, 300-400 freezing rain.

    MRMS's own flag says rain or snow. The in-between is read off the model's
    surface temperature and wet-bulb, which the flag does not carry: snow into a
    wet-bulb above half a degree is wet snow mixing with rain; rain onto ground
    at or below freezing is freezing rain; rain where the surface is just above
    freezing but the wet-bulb is not is sleet or a mix."""
    dbz = get("mr_hsr")
    flag = get("mr_pflag")
    tw = get("mr_tw")
    ts = get("mr_tsfc")
    tw = np.where(np.isfinite(tw), tw, 10.0)
    ts = np.where(np.isfinite(ts), ts, 10.0)
    rain = np.isin(flag, _RAIN_FLAGS)
    snow = np.isin(flag, _SNOW_FLAGS)
    base = np.full(dbz.shape, np.nan, dtype=np.float32)
    base[rain] = 0.0
    base[snow] = 100.0
    base[(snow & (tw > 0.5)) | (rain & (ts > 0.0) & (ts <= 1.5) & (tw <= 0.5))] = 200.0
    base[rain & (ts <= 0.0)] = 300.0
    return np.where(np.isfinite(base) & (dbz >= 5.0), base + np.clip(dbz, 0.0, 75.0), np.nan).astype(np.float32)


def _flag_class(get) -> np.ndarray:
    flag = get("mr_pflag")
    out = np.full(flag.shape, np.nan, dtype=np.float32)
    for code, k in _FLAG_CLASS.items():
        out[flag == code] = k + 0.5
    return out


def _log10(name: str):
    def fn(get) -> np.ndarray:
        v = get(name)
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.where(v > 0, np.log10(np.maximum(v, 1e-12)), np.nan).astype(np.float32)
    return fn


DERIVED["mr_rms"] = [(("mr_hsr", "mr_pflag", "mr_tw", "mr_tsfc"), _rain_mix_snow)]
DERIVED["mr_pflag_cat"] = [(("mr_pflag",), _flag_class)]
for _w in ("30m", "01h", "03h", "06h", "12h", "24h", "max"):
    DERIVED[f"mf_ari{_w}_log"] = [((f"mf_ari{_w}",), _log10(f"mf_ari{_w}"))]
for _m in ("crest", "sac", "hp"):
    DERIVED[f"mf_{_m}_flow_log"] = [((f"mf_{_m}_flow",), _log10(f"mf_{_m}_flow"))]
    DERIVED[f"mf_{_m}_unit_log"] = [((f"mf_{_m}_unit",), _log10(f"mf_{_m}_unit"))]


def _exp10(v: float) -> str:
    x = 10.0 ** v
    return f"{x:.3g}"


FORMATS.update({
    "rms": lambda v: f"{RMS_NAMES[int(min(max(v // 100, 0), 3))]} · {round(v - int(min(max(v // 100, 0), 3)) * 100)} dBZ",
    "pflag": lambda v: PFLAG_NAMES[int(min(max(v, 0), 6))],
    "exp10": _exp10,
    "jump": lambda v: f"{int(round(v))}σ jump",
})

# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
# "MRMS" on every group: the menu lists every product whatever the source, and
# a model's Composite Reflectivity sits beside the mosaic's.
R, W, HL, RO, LT, ST, DP, RF, MQ, FF = ("MRMS Reflectivity", "MRMS Precipitation Type", "MRMS Hail",
                                        "MRMS Rotation", "MRMS Lightning", "MRMS Storm Structure",
                                        "MRMS Dual-Pol 3-D", "MRMS Rainfall", "MRMS Multi-Sensor Rainfall",
                                        "MRMS Flash Flooding")


def _span(minutes: int) -> str:
    return "30-Min" if minutes < 60 else f"{minutes // 60}-Hour"


def _refl(label: str, shade: str, sub: str, note: str = "") -> dict:
    return _p(label, R, shade, "dBZ", REFL_DBZ, sub=sub, stepped=True, note=note)


_M = {
    # ----- Reflectivity
    "mr_cref": _refl("Composite Reflectivity", "mr_cref", "Mosaic",
                     "The strongest echo in every column, every radar merged and cleaned of clutter."),
    "mr_bref": _refl("Base Reflectivity", "mr_bref", "Mosaic", "The lowest tilt of each radar, merged."),
    "mr_hsr": _refl("Seamless Hybrid-Scan Reflectivity", "mr_hsr", "Mosaic",
                    "The lowest beam not blocked by terrain: what is closest to the ground."),
    "mr_ral": _refl("Reflectivity at Lowest Altitude", "mr_ral", "Mosaic"),
    "mr_cref_raw": _refl("Composite Reflectivity (unfiltered)", "mr_cref_raw", "Mosaic",
                         "Without the quality control: clutter, birds and chaff included."),
    "mr_cref_1h": _refl("Composite Reflectivity 1-Hour Max", "mr_cref_1h", "Mosaic",
                        "The strongest echo of the past hour: a storm's whole path at once."),
    "mr_bref_1h": _refl("Base Reflectivity 1-Hour Max", "mr_bref_1h", "Mosaic"),
    "mr_llcref": _refl("Low-Level Composite Reflectivity", "mr_llcref", "Layers"),
    "mr_lc_low": _refl("Layer Composite 0-24 kft", "mr_lc_low", "Layers"),
    "mr_lc_high": _refl("Layer Composite 24-60 kft", "mr_lc_high", "Layers"),
    "mr_lc_super": _refl("Layer Composite 33-60 kft", "mr_lc_super", "Layers"),
    "mr_cref_hgt": _p("Height of Composite Reflectivity", R, "mr_cref_hgt", "kft", HGT_KFT, sub="Layers",
                      convert="m->kft", decimals=1, note="Where in the column the strongest echo sits."),
    **{f"mr_ref_{k}": _refl(f"Reflectivity at {t}", f"mr_ref_{k}", "At isotherms", note)
       for k, t, note in (("0c", "0 °C", ""), ("m5c", "-5 °C", ""),
                          ("m10c", "-10 °C", "Where charge separation begins: strong echo here means lightning and hail."),
                          ("m15c", "-15 °C", ""), ("m20c", "-20 °C", "Strong echo this high is a hail-producing updraft."))},
    **{f"mr_z{h}": _refl(f"Reflectivity at {h} km MSL", f"mr_z{h}", "3-D (height above sea level)")
       for h in _HEIGHTS_Z},
    # ----- Precipitation type
    "mr_rms": _p("Rain / Mix / Snow Intensity", W, "mr_rms", "", PTYPE_PAL, fmt="rms", lut_steps=1024,
                 labels=RMS_LABELS,
                 note="The near-ground reflectivity coloured by what is falling: MRMS's rain or snow, with mix and "
                      "freezing rain read from the surface and wet-bulb temperatures."),
    "mr_pflag": _p("Precipitation Flag", W, "mr_pflag_cat", "", PFLAG, stepped=True, fmt="pflag",
                   labels=PFLAG_LABELS, note="MRMS's own classification of the precipitation at each point."),
    "mr_tsfc": _p("Surface Temperature", W, "mr_tsfc", "°F", TEMP_F, sub="Temperatures", convert="C->F"),
    "mr_tw": _p("Surface Wet-Bulb Temperature", W, "mr_tw", "°F", TEMP_F, sub="Temperatures", convert="C->F",
                note="Below 33 °F precipitation tends to reach the ground frozen."),
    "mr_frz": _p("Freezing Level", W, "mr_frz", "kft", HGT_KFT, sub="Temperatures", convert="m->kft", decimals=1),
    "mr_bbtop": _p("Bright Band Top", W, "mr_bbtop", "kft", HGT_KFT, sub="Bright band", convert="m->kft", decimals=1,
                   note="The melting layer as the radars see it."),
    "mr_bbbot": _p("Bright Band Bottom", W, "mr_bbbot", "kft", HGT_KFT, sub="Bright band", convert="m->kft",
                   decimals=1),
    # ----- Hail
    "mr_mesh": _p("MESH (Max Estimated Hail Size)", HL, "mr_mesh", "in", MESH_IN, sub="Instant", convert="mm->in",
                  decimals=2, stepped=True, note="The largest hail the radar reflectivity above freezing implies."),
    **{f"mr_mesh{n}": _p(f"Hail Swath {_span(n)}", HL, f"mr_mesh{n}", "in", MESH_IN, sub="Swaths", convert="mm->in",
                         decimals=2, stepped=True, note="The largest MESH at each point over the period: the hail's path.")
       for n in _SWATH},
    "mr_posh": _p("Probability of Severe Hail", HL, "mr_posh", "%", POSH_PCT, sub="Instant",
                  note="The chance of hail 1 inch or larger."),
    "mr_shi": _p("Severe Hail Index", HL, "mr_shi", "", SHI, sub="Instant"),
    "mr_h50_0c": _p("50 dBZ Above 0 °C", HL, "mr_h50_0c", "km", CORE_KM, sub="Hail core depth", decimals=1,
                    note="How far the 50 dBZ core reaches above freezing: the deeper, the bigger the hail."),
    "mr_h50_m20c": _p("50 dBZ Above -20 °C", HL, "mr_h50_m20c", "km", CORE_KM, sub="Hail core depth", decimals=1),
    "mr_h60_0c": _p("60 dBZ Above 0 °C", HL, "mr_h60_0c", "km", CORE_KM, sub="Hail core depth", decimals=1),
    "mr_h60_m20c": _p("60 dBZ Above -20 °C", HL, "mr_h60_m20c", "km", CORE_KM, sub="Hail core depth", decimals=1),
    # ----- Rotation
    "mr_az_low": _p("Azimuthal Shear 0-2 km", RO, "mr_az_low", "10⁻³ s⁻¹", AZ, sub="Instant", decimals=1,
                    note="Rotation near the ground now: warm colours turn cyclonically, cool anticyclonically."),
    "mr_az_mid": _p("Azimuthal Shear 3-6 km", RO, "mr_az_mid", "10⁻³ s⁻¹", AZ, sub="Instant", decimals=1,
                    note="The mid-level mesocyclone."),
    **{f"mr_rot{n}": _p(f"Rotation Track 0-2 km {_span(n)}", RO, f"mr_rot{n}", "10⁻³ s⁻¹", ROT, sub="Tracks 0-2 km",
                        decimals=1, note="The strongest low-level rotation at each point over the period: the "
                                         "path a tornado would have taken.") for n in _ROT},
    **{f"mr_rotml{n}": _p(f"Rotation Track 3-6 km {_span(n)}", RO, f"mr_rotml{n}", "10⁻³ s⁻¹", ROT,
                          sub="Tracks 3-6 km", decimals=1) for n in _ROT},
    # ----- Lightning
    **{f"mr_cg{n}": _p(f"CG Lightning Density ({n} min)", LT, f"mr_cg{n}", "fl/km²/min", LTG_DEN, sub="Density",
                       decimals=2, note="Cloud-to-ground flashes from the NLDN, averaged over the period.")
       for n in (1, 5, 15, 30)},
    "mr_ltgp30": _p("Lightning Probability Next 30 min", LT, "mr_ltgp30", "%", LTG_PROB, sub="Probability"),
    "mr_ltgp60": _p("Lightning Probability Next 60 min", LT, "mr_ltgp60", "%", LTG_PROB, sub="Probability"),
    "mr_jump": _p("Lightning Jump", LT, "mr_jump", "σ", JUMP, sub="Jumps", stepped=True, fmt="jump", labels=JUMP_LABELS,
                  note="A sudden rise in a storm's flash rate: an updraft strengthening, often ahead of severe weather."),
    "mr_jump5": _p("Lightning Jump 5-min Max", LT, "mr_jump5", "σ", JUMP, sub="Jumps", stepped=True, fmt="jump",
                   labels=JUMP_LABELS),
    # ----- Storm structure
    **{f"mr_et{d}": _p(f"Echo Tops ({d} dBZ)", ST, f"mr_et{d}", "kft", ETOP_KFT, sub="Echo tops", convert="km->kft",
                       decimals=1, note="The highest the echo reaches this strength, above sea level.")
       for d in (18, 30, 50, 60)},
    "mr_vil": _p("Vertically Integrated Liquid", ST, "mr_vil", "kg/m²", VIL_KGM2, sub="VIL", decimals=1),
    "mr_vild": _p("VIL Density", ST, "mr_vild", "g/m³", VILD, sub="VIL", decimals=2,
                  note="VIL over the echo top: 3.5 or more is a strong signal for large hail."),
    "mr_vil120": _p("VIL Swath 2-Hour", ST, "mr_vil120", "kg/m²", VIL_KGM2, sub="VIL", decimals=1),
    "mr_vil1440": _p("VIL Swath 24-Hour", ST, "mr_vil1440", "kg/m²", VIL_KGM2, sub="VIL", decimals=1),
    "mr_vii": _p("Vertically Integrated Ice", ST, "mr_vii", "kg/m²", VII, sub="VIL", decimals=1,
                 note="Ice between -10 and -40 °C: the graupel that makes lightning."),
    # ----- Dual-pol at height
    **{f"mr_rho{h}": _p(f"Correlation Coefficient at {h} km", DP, f"mr_rho{h}", "", CC, sub="Correlation coefficient",
                        decimals=2, lut_steps=1024) for h in _HEIGHTS_DP},
    **{f"mr_zdr{h}": _p(f"Differential Reflectivity at {h} km", DP, f"mr_zdr{h}", "dB", ZDR_DB,
                        sub="Differential reflectivity", decimals=1) for h in _HEIGHTS_DP},
    # ----- Rainfall, radar only
    "mr_rate": _p("Precipitation Rate", RF, "mr_rate", "in/h", PRATE_INHR, convert="mm->in", decimals=2),
    "mr_ro15m": _p("15-Minute Rainfall (Radar)", RF, "mr_ro15m", "in", QPF_IN, sub="Radar only", convert="mm->in",
                   decimals=2),
    **{f"mr_ro{h.lower()}": _p(f"{int(h[:2])}-Hour Rainfall (Radar)", RF, f"mr_ro{h.lower()}", "in", QPF_IN,
                               sub="Radar only", convert="mm->in", decimals=2) for h in _RO},
    "mr_ro12z": _p("Rainfall Since 12Z (Radar)", RF, "mr_ro12z", "in", QPF_IN, sub="Radar only", convert="mm->in",
                   decimals=2),
    "mr_rqi": _p("Radar Quality Index", RF, "mr_rqi", "", RQI, sub="Quality", decimals=2,
                 note="How well the radars see the ground here: low behind mountains and far from any radar."),
    "mr_warmrain": _p("Warm Rain Probability", RF, "mr_warmrain", "%", PROB_PCT, sub="Quality",
                      note="Tropical, efficient rain: radar rainfall runs low where this is high."),
    # ----- Multi-sensor rainfall
    **{f"mq_{h.lower()}": _p(f"{int(h[:2])}-Hour Rainfall (Multi-Sensor)", MQ, f"mq_{h.lower()}", "in", QPF_IN,
                             convert="mm->in", decimals=2,
                             note="Radar corrected with the rain gauges and the model: the best estimate of what fell.")
       for h in _RO},
    # ----- Flash flooding
    **{f"mf_ari{w.lower()}": _p(f"Rainfall Recurrence Interval {t}", FF, f"mf_ari{w.lower()}_log", "years", ARI_LOG,
                                sub="Average recurrence interval", fmt="exp10", labels=ARI_LABELS, lut_steps=1024,
                                note="How rare this much rain is here: a 100-year rain has a 1% chance in any year.")
       for w, t in (("30M", "30 min"), ("01H", "1 h"), ("03H", "3 h"), ("06H", "6 h"), ("12H", "12 h"), ("24H", "24 h"),
                    ("MAX", "(any duration)"))},
    **{f"mf_ffg{w.lower()}": _p(f"Rainfall / Flash Flood Guidance {t}", FF, f"mf_ffg{w.lower()}", "%", FFG_PCT,
                                sub="Against flash-flood guidance",
                                note="Rain as a share of what it takes to flood: 100% and up, flooding is likely.")
       for w, t in (("01H", "1 h"), ("03H", "3 h"), ("06H", "6 h"), ("MAX", "(max)"))},
    **{f"mf_{m}_unit": _p(f"Unit Streamflow ({lab})", FF, f"mf_{m}_unit_log", "m³/s/km²", UNIT_LOG, sub="Streamflow",
                          fmt="exp10", labels=UNIT_LABELS, lut_steps=1024,
                          note="Water running off per square kilometre: past 2, flash flooding; past 5, severe.")
       for m, lab in (("crest", "CREST"), ("sac", "SAC-SMA"), ("hp", "Hydrophobic"))},
    **{f"mf_{m}_flow": _p(f"Streamflow ({lab})", FF, f"mf_{m}_flow_log", "m³/s", FLOW_LOG, sub="Streamflow",
                          fmt="exp10", labels=FLOW_LABELS, lut_steps=1024)
       for m, lab in (("crest", "CREST"), ("sac", "SAC-SMA"), ("hp", "Hydrophobic"))},
    "mf_crest_soil": _p("Soil Saturation (CREST)", FF, "mf_crest_soil", "%", SOIL_PCT, sub="Soil"),
    "mf_sac_soil": _p("Soil Saturation (SAC-SMA)", FF, "mf_sac_soil", "%", SOIL_PCT, sub="Soil"),
}

# Specks and tracks a cell or two wide: kept at their strongest when a picture
# is coarser than the grid (observations._peaks).
for _pid, _spec in _M.items():
    if _pid.startswith(("mr_mesh", "mr_rot", "mr_az_", "mr_cg", "mr_jump", "mr_vil1", "mr_posh", "mr_shi")):
        _spec["peaks"] = True

PRODUCTS.update(_M)
