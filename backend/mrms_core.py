"""
MRMS: the national mosaic, as map layers.

MRMS (Multi-Radar Multi-Sensor) is NOAA's national grid -- every radar in the
country merged with gauges, lightning and model fields onto one 0.01 degree
mesh, updated every two minutes. It answers the questions a single radar
cannot: where is the hail swath across three states, where has rotation
tracked for the last hour, how much rain has actually fallen since 12Z.

Two things make this a different pipeline from nexrad_core rather than an
addition to it.

The grid is regular in latitude and longitude, not polar, and it is 7000 x 3500
points covering 35 degrees of latitude. A polar mesh of one site spans about
four degrees, where treating latitude as linear costs nothing you can see. Over
CONUS it costs tens of kilometres in the middle of the image, so the render
warps rows onto a Mercator axis before it draws -- see _mercator_rows.

And the products are files in a directory, not keys in an S3 bucket with a
manifest. The listing IS the index: 26 hours of history, one file every two
minutes, named for the moment they describe.

A note on identification: MRMS GRIB2 uses NOAA local tables that eccodes does
not carry, so every field reports `name='unknown'`. What a file contains is
known from the directory it came from and nothing else, which is why the
catalog below is a hand-written table rather than anything derived.
"""

from __future__ import annotations

import gzip
import io
import math
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional

import eccodes as ec
import numpy as np
import requests
from matplotlib.colors import Normalize
from scipy.ndimage import zoom as _ndzoom
from PIL import Image

from model_sources import EC_HANDLE_LOCK
from nexrad_core import get_cmap

BASE = "https://mrms.ncep.noaa.gov/2D/"
_HTTP_TIMEOUT = 45
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "WeatherTS/1.0 (+https://github.com/pabloarzaosc/WeatherTS)"})

# The listing changes every two minutes; the frames themselves never change.
_LIST_TTL = 60.0
_RENDER_TTL = 120.0


# ---------------------------------------------------------------------------
# Colour scales
#
# Reflectivity, hail size and precipitation borrow the tables the radar
# products already use, so the same value reads as the same colour whether it
# came from one radar or from the mosaic. The rest are MRMS's own quantities --
# azimuthal shear, probabilities, flash-flood ratios -- and get a scale defined
# here, because nothing in the Level III palette set is anchored to them.
# ---------------------------------------------------------------------------

# `floor`: values at or below this are drawn as nothing at all.
#
# Reflectivity is the odd one out. MRMS writes -999 for outside the domain and
# -99 for scanned-and-empty, so anything a person would call "no echo" is
# already far below the palette and a single cutoff handles it.
#
# Every derived product instead uses plain 0 for "none here": no hail, no
# rotation, no rain, no lightning. Those must be transparent rather than the
# bottom colour of the ramp -- drawn as a colour, a quiet day paints the whole
# country in the darkest shade of the scale and hides the map underneath it,
# which is exactly what MESH did before this existed.

# kind -> (palette id from nexrad_core, vmin, vmax) or (None, vmin, vmax, cmap)
_SCALES: dict[str, dict[str, Any]] = {
    "ref":      {"pal": "FILE_DR", "units": "dBZ", "floor": -90.0},
    "echotop":  {"pal": "FILE_ET_steep", "units": "kft", "floor": 0.0},
    "vil":      {"pal": "FILE_VIL", "units": "kg/m²", "floor": 0.0},
    "qpe":      {"pal": "FILE_STP", "units": "in", "floor": 0.0},
    "rate":     {"pal": "FILE_OHP", "units": "in/hr", "floor": 0.0},

    # MRMS-only quantities. vmin/vmax are the display range; the colours come
    # from a named matplotlib map because there is no .pal table for these.
    "mesh":     {"cmap": "turbo",    "vmin": 0.0,   "vmax": 4.0,   "units": "in", "floor": 0.0},
    "posh":     {"cmap": "plasma",   "vmin": 0.0,   "vmax": 100.0, "units": "%", "floor": 0.0},
    "shi":      {"cmap": "inferno",  "vmin": 0.0,   "vmax": 300.0, "units": "", "floor": 0.0},
    "azshear":  {"cmap": "magma",    "vmin": 0.0,   "vmax": 0.01,  "units": "s⁻¹", "floor": 0.0},
    "ltgden":   {"cmap": "plasma",   "vmin": 0.0,   "vmax": 5.0,   "units": "fl/km²/min", "floor": 0.0},
    "ltgprob":  {"cmap": "viridis",  "vmin": 0.0,   "vmax": 100.0, "units": "%", "floor": 0.0},
    "ltgjump":  {"cmap": "hot",      "vmin": 0.0,   "vmax": 10.0,  "units": "σ", "floor": 0.0},
    "height":   {"cmap": "viridis",  "vmin": 0.0,   "vmax": 20.0,  "units": "km", "floor": 0.0},
    "flag":     {"cmap": "tab20",    "vmin": 0.0,   "vmax": 20.0,  "units": "", "floor": 0.0},
    "ratio":    {"cmap": "RdYlBu_r", "vmin": 0.0,   "vmax": 2.0,   "units": "", "floor": 0.0},
    "ari":      {"cmap": "RdYlBu_r", "vmin": 0.0,   "vmax": 100.0, "units": "yr", "floor": 0.0},
    "flow":     {"cmap": "cividis",  "vmin": 0.0,   "vmax": 100.0, "units": "m³/s", "floor": 0.0},
    "soil":     {"cmap": "YlGnBu",   "vmin": 0.0,   "vmax": 100.0, "units": "%", "floor": 0.0},
    "vii":      {"cmap": "cool",     "vmin": 0.0,   "vmax": 30.0,  "units": "kg/m²", "floor": 0.0},
}


def _p(pid: str, label: str, group: str, path: str, kind: str, **extra) -> dict[str, Any]:
    return {"id": pid, "label": label, "group": group, "path": path, "kind": kind, **extra}


# ---------------------------------------------------------------------------
# The catalog.
#
# `path` is the directory under /2D/ and is the ONLY thing that identifies what
# a file holds, since the GRIB metadata does not. Every one of these was taken
# from the live listing rather than from documentation.
# ---------------------------------------------------------------------------
PRODUCTS: list[dict[str, Any]] = [
    # ---- reflectivity ----
    _p("cref", "Composite Reflectivity", "Reflectivity", "MergedReflectivityQCComposite", "ref"),
    _p("cref_raw", "Composite Reflectivity (unfiltered)", "Reflectivity", "MergedReflectivityComposite", "ref"),
    _p("bref", "Base Reflectivity", "Reflectivity", "MergedBaseReflectivityQC", "ref"),
    _p("ral", "Reflectivity At Lowest Altitude", "Reflectivity", "ReflectivityAtLowestAltitude", "ref"),
    _p("lcref", "Low-Level Composite Reflectivity", "Reflectivity", "LowLevelCompositeReflectivity", "ref"),
    _p("lcref_low", "Reflectivity Low (0–24 kft)", "Reflectivity", "LayerCompositeReflectivity_Low", "ref"),
    _p("lcref_high", "Reflectivity High (24–60 kft)", "Reflectivity", "LayerCompositeReflectivity_High", "ref"),
    _p("lcref_super", "Reflectivity Super (33–60 kft)", "Reflectivity", "LayerCompositeReflectivity_Super", "ref"),
    _p("cref_1hr", "Composite Reflectivity Hourly Maximum", "Reflectivity", "CREF_1HR_MAX", "ref"),
    _p("bref_1hr", "Base Reflectivity Hourly Maximum", "Reflectivity", "BREF_1HR_MAX", "ref"),
    _p("cref_h", "Reflectivity Height", "Reflectivity", "HeightCompositeReflectivity", "height"),
    _p("hsr", "Seamless Hybrid Scan Reflectivity", "Reflectivity", "SeamlessHSR", "ref"),

    # ---- reflectivity at isotherms ----
    _p("ref_0c", "Reflectivity (0 °C)", "Reflectivity", "Reflectivity_0C", "ref"),
    _p("ref_m5c", "Reflectivity (−5 °C)", "Reflectivity", "Reflectivity_-5C", "ref"),
    _p("ref_m10c", "Reflectivity (−10 °C)", "Reflectivity", "Reflectivity_-10C", "ref"),
    _p("ref_m15c", "Reflectivity (−15 °C)", "Reflectivity", "Reflectivity_-15C", "ref"),
    _p("ref_m20c", "Reflectivity (−20 °C)", "Reflectivity", "Reflectivity_-20C", "ref"),

    # ---- echo tops ----
    _p("et18", "Echo Top — 18 dBZ", "Echo tops", "EchoTop_18", "echotop"),
    _p("et30", "Echo Top — 30 dBZ", "Echo tops", "EchoTop_30", "echotop"),
    _p("et50", "Echo Top — 50 dBZ", "Echo tops", "EchoTop_50", "echotop"),
    _p("et60", "Echo Top — 60 dBZ", "Echo tops", "EchoTop_60", "echotop"),

    # ---- hail ----
    _p("posh", "Prob. of Severe Hail", "Hail", "POSH", "posh"),
    _p("shi", "Severe Hail Index", "Hail", "SHI", "shi"),
    _p("mesh", "Maximum Estimated Size of Hail", "Hail", "MESH", "mesh"),
    _p("mesh30", "MESH Hail Swath 30-minute", "Hail", "MESH_Max_30min", "mesh"),
    _p("mesh60", "MESH Hail Swath 1-hour", "Hail", "MESH_Max_60min", "mesh"),
    _p("mesh120", "MESH Hail Swath 2-hour", "Hail", "MESH_Max_120min", "mesh"),
    _p("mesh240", "MESH Hail Swath 4-hour", "Hail", "MESH_Max_240min", "mesh"),
    _p("mesh360", "MESH Hail Swath 6-hour", "Hail", "MESH_Max_360min", "mesh"),
    _p("mesh1440", "MESH Hail Swath 24-hour", "Hail", "MESH_Max_1440min", "mesh"),

    # ---- integrated water ----
    _p("vil", "Vertically Integrated Liquid", "VIL & ice", "VIL", "vil"),
    _p("vild", "Vertically Integrated Liquid Density", "VIL & ice", "VIL_Density", "vil"),
    _p("vil120", "VIL Swath 2-hour", "VIL & ice", "VIL_Max_120min", "vil"),
    _p("vil1440", "VIL Swath 24-hour", "VIL & ice", "VIL_Max_1440min", "vil"),
    _p("vii", "Vertically Integrated Ice", "VIL & ice", "VII", "vii"),

    # ---- rotation ----
    #
    # ML is MRMS's suffix for the mid-level band. The GRIB carries no name to
    # confirm it against, so the pairing below is by MRMS convention: the
    # unsuffixed tracks are 0-2 km, the ML ones 3-6 km, and the instantaneous
    # fields say their layer in the directory name outright.
    _p("azs_ll", "Rotation Track (0–2 km AGL) Instant", "Rotation", "MergedAzShear_0-2kmAGL", "azshear"),
    _p("rot30", "Rotation Track (0–2 km AGL) 30-minute", "Rotation", "RotationTrack30min", "azshear"),
    _p("rot60", "Rotation Track (0–2 km AGL) 1-hour", "Rotation", "RotationTrack60min", "azshear"),
    _p("rot120", "Rotation Track (0–2 km AGL) 2-hour", "Rotation", "RotationTrack120min", "azshear"),
    _p("rot240", "Rotation Track (0–2 km AGL) 4-hour", "Rotation", "RotationTrack240min", "azshear"),
    _p("rot360", "Rotation Track (0–2 km AGL) 6-hour", "Rotation", "RotationTrack360min", "azshear"),
    _p("rot1440", "Rotation Track (0–2 km AGL) 24-hour", "Rotation", "RotationTrack1440min", "azshear"),
    _p("azs_ml", "Rotation Track (3–6 km AGL) Instant", "Rotation", "MergedAzShear_3-6kmAGL", "azshear"),
    _p("rotml30", "Rotation Track (3–6 km AGL) 30-minute", "Rotation", "RotationTrackML30min", "azshear"),
    _p("rotml60", "Rotation Track (3–6 km AGL) 1-hour", "Rotation", "RotationTrackML60min", "azshear"),
    _p("rotml120", "Rotation Track (3–6 km AGL) 2-hour", "Rotation", "RotationTrackML120min", "azshear"),
    _p("rotml240", "Rotation Track (3–6 km AGL) 4-hour", "Rotation", "RotationTrackML240min", "azshear"),
    _p("rotml360", "Rotation Track (3–6 km AGL) 6-hour", "Rotation", "RotationTrackML360min", "azshear"),
    _p("rotml1440", "Rotation Track (3–6 km AGL) 24-hour", "Rotation", "RotationTrackML1440min", "azshear"),

    # ---- lightning ----
    _p("cg1", "CG Lightning 1-minute Average Density", "Lightning", "NLDN_CG_001min_AvgDensity", "ltgden"),
    _p("cg5", "CG Lightning 5-minute Average Density", "Lightning", "NLDN_CG_005min_AvgDensity", "ltgden"),
    _p("cg15", "CG Lightning 15-minute Average Density", "Lightning", "NLDN_CG_015min_AvgDensity", "ltgden"),
    _p("cg30", "CG Lightning 30-minute Average Density", "Lightning", "NLDN_CG_030min_AvgDensity", "ltgden"),
    _p("ltgp30", "CG Lightning Probability Next 30-minute", "Lightning", "LightningProbabilityNext30min", "ltgprob"),
    _p("ltgp60", "CG Lightning Probability Next 60-minute", "Lightning", "LightningProbabilityNext60min", "ltgprob"),
    _p("ltgjump", "Lightning Jump", "Lightning", "LtgJumpGrid", "ltgjump"),
    _p("ltgjump5", "Lightning Jump Max 5-minute", "Lightning", "LtgJumpGrid_Max_005min", "ltgjump"),

    # ---- QPE, radar only ----
    _p("rate", "QPE Radar-Only Precipitation Rate", "QPE", "PrecipRate", "rate"),
    _p("qpe15m", "QPE Radar-Only 15-minute", "QPE", "RadarOnly_QPE_15M", "qpe"),
    _p("qpe01h", "QPE Radar-Only 1-hour", "QPE", "RadarOnly_QPE_01H", "qpe"),
    _p("qpe03h", "QPE Radar-Only 3-hour", "QPE", "RadarOnly_QPE_03H", "qpe"),
    _p("qpe06h", "QPE Radar-Only 6-hour", "QPE", "RadarOnly_QPE_06H", "qpe"),
    _p("qpe12h", "QPE Radar-Only 12-hour", "QPE", "RadarOnly_QPE_12H", "qpe"),
    _p("qpe24h", "QPE Radar-Only 24-hour", "QPE", "RadarOnly_QPE_24H", "qpe"),
    _p("qpe48h", "QPE Radar-Only 48-hour", "QPE", "RadarOnly_QPE_48H", "qpe"),
    _p("qpe72h", "QPE Radar-Only 72-hour", "QPE", "RadarOnly_QPE_72H", "qpe"),
    _p("qpe12z", "QPE Radar-Only Since 12Z", "QPE", "RadarOnly_QPE_Since12Z", "qpe"),
    _p("preciptype", "Precipitation Type", "QPE", "PrecipFlag", "flag"),

    # ---- QPE, multi-sensor ----
    _p("ms01h1", "QPE Multi-Sensor 1-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_01H_Pass1", "qpe"),
    _p("ms03h1", "QPE Multi-Sensor 3-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_03H_Pass1", "qpe"),
    _p("ms06h1", "QPE Multi-Sensor 6-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_06H_Pass1", "qpe"),
    _p("ms12h1", "QPE Multi-Sensor 12-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_12H_Pass1", "qpe"),
    _p("ms24h1", "QPE Multi-Sensor 24-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_24H_Pass1", "qpe"),
    _p("ms48h1", "QPE Multi-Sensor 48-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_48H_Pass1", "qpe"),
    _p("ms72h1", "QPE Multi-Sensor 72-hour Pass 1", "QPE multi-sensor", "MultiSensor_QPE_72H_Pass1", "qpe"),
    _p("ms01h2", "QPE Multi-Sensor 1-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_01H_Pass2", "qpe"),
    _p("ms03h2", "QPE Multi-Sensor 3-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_03H_Pass2", "qpe"),
    _p("ms06h2", "QPE Multi-Sensor 6-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_06H_Pass2", "qpe"),
    _p("ms12h2", "QPE Multi-Sensor 12-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_12H_Pass2", "qpe"),
    _p("ms24h2", "QPE Multi-Sensor 24-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_24H_Pass2", "qpe"),
    _p("ms48h2", "QPE Multi-Sensor 48-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_48H_Pass2", "qpe"),
    _p("ms72h2", "QPE Multi-Sensor 72-hour Pass 2", "QPE multi-sensor", "MultiSensor_QPE_72H_Pass2", "qpe"),

    # ---- FLASH: flash-flood guidance and modelled response ----
    _p("flash_crest_soil", "FLASH QPE-CREST Soil Saturation", "FLASH", "FLASH/CREST_MAXSOILSAT", "soil"),
    _p("flash_crest_flow", "FLASH QPE-CREST Streamflow", "FLASH", "FLASH/CREST_MAXSTREAMFLOW", "flow"),
    _p("flash_crest_unit", "FLASH QPE-CREST Unit Streamflow", "FLASH", "FLASH/CREST_MAXUNITSTREAMFLOW", "flow"),
    _p("flash_sac_soil", "FLASH QPE-SAC Soil Saturation", "FLASH", "FLASH/SAC_MAXSOILSAT", "soil"),
    _p("flash_sac_flow", "FLASH QPE-SAC Streamflow", "FLASH", "FLASH/SAC_MAXSTREAMFLOW", "flow"),
    _p("flash_sac_unit", "FLASH QPE-SAC Unit Streamflow", "FLASH", "FLASH/SAC_MAXUNITSTREAMFLOW", "flow"),
    _p("flash_hp_flow", "FLASH QPE-Hydrophobic Streamflow", "FLASH", "FLASH/HP_MAXSTREAMFLOW", "flow"),
    _p("flash_hp_unit", "FLASH QPE-Hydrophobic Unit Streamflow", "FLASH", "FLASH/HP_MAXUNITSTREAMFLOW", "flow"),
    _p("ari30m", "FLASH QPE Average Recurrence Interval 30-minute", "FLASH", "FLASH/QPE_ARI30M", "ari"),
    _p("ari01h", "FLASH QPE Average Recurrence Interval 1-hour", "FLASH", "FLASH/QPE_ARI01H", "ari"),
    _p("ari03h", "FLASH QPE Average Recurrence Interval 3-hour", "FLASH", "FLASH/QPE_ARI03H", "ari"),
    _p("ari06h", "FLASH QPE Average Recurrence Interval 6-hour", "FLASH", "FLASH/QPE_ARI06H", "ari"),
    _p("ari12h", "FLASH QPE Average Recurrence Interval 12-hour", "FLASH", "FLASH/QPE_ARI12H", "ari"),
    _p("ari24h", "FLASH QPE Average Recurrence Interval 24-hour", "FLASH", "FLASH/QPE_ARI24H", "ari"),
    _p("arimax", "FLASH QPE Average Recurrence Interval Max", "FLASH", "FLASH/QPE_ARIMAX", "ari"),
    _p("ffg01h", "FLASH QPE-to-FFG Ratio 1-hour", "FLASH", "FLASH/QPE_FFG01H", "ratio"),
    _p("ffg03h", "FLASH QPE-to-FFG Ratio 3-hour", "FLASH", "FLASH/QPE_FFG03H", "ratio"),
    _p("ffg06h", "FLASH QPE-to-FFG Ratio 6-hour", "FLASH", "FLASH/QPE_FFG06H", "ratio"),
    _p("ffgmax", "FLASH QPE-to-FFG Ratio Max", "FLASH", "FLASH/QPE_FFGMAX", "ratio"),

    # ---- environment ----
    _p("h0c", "Model 0 °C Height", "Environment", "Model_0degC_Height", "height"),
    _p("bbtop", "Bright Band Top Height", "Environment", "BrightBandTopHeight", "height"),
    _p("bbbot", "Bright Band Bottom Height", "Environment", "BrightBandBottomHeight", "height"),
    _p("rqi", "Radar Quality Index", "Environment", "RadarQualityIndex", "soil"),
    _p("warmrain", "Warm Rain Probability", "Environment", "WarmRainProbability", "ltgprob"),
]

BY_ID = {p["id"]: p for p in PRODUCTS}
DEFAULT_PRODUCT = "cref"

# ---------------------------------------------------------------------------
# Regions.
#
# The same catalog, published again under a directory per domain. Nothing else
# has to change for them: the grid corners are read from each file rather than
# assumed, so an Alaska frame places itself correctly without this module
# knowing where Alaska is.
#
# Coverage is not identical -- Alaska carries about 114 of the products against
# the mainland's full set -- so a product missing from a region is a normal
# 404 from the listing, not a fault.
# ---------------------------------------------------------------------------
REGIONS: list[dict[str, str]] = [
    {"id": "conus", "label": "CONUS", "prefix": ""},
    {"id": "alaska", "label": "Alaska", "prefix": "ALASKA/"},
    {"id": "hawaii", "label": "Hawaii", "prefix": "HAWAII/"},
    {"id": "caribbean", "label": "Caribbean", "prefix": "CARIB/"},
    {"id": "guam", "label": "Guam", "prefix": "GUAM/"},
]

BY_REGION = {r["id"]: r for r in REGIONS}
DEFAULT_REGION = "conus"


def _dir(product: str, region: str) -> str:
    """Directory under /2D/ for one product in one region."""
    spec = BY_ID.get(product)
    if not spec:
        raise RuntimeError(f"unknown MRMS product {product!r}")
    reg = BY_REGION.get(region or DEFAULT_REGION)
    if not reg:
        raise RuntimeError(f"unknown MRMS region {region!r}")
    # FLASH keeps its own nesting, and only the mainland publishes it.
    return f"{reg['prefix']}{spec['path']}"


_DIRS_TTL = 3600.0
_dirs_cache: dict[str, tuple[float, set[str]]] = {}
_dirs_lock = threading.Lock()
_DIR_RE = re.compile(r'<a href="([^"/?][^"]*)/">')


def region_dirs(region: str) -> set[str]:
    """What a region actually publishes.

    Coverage is not the same everywhere and never was: Alaska carries no
    rotation tracks, and the island domains carry neither lightning nor FLASH.
    Offering all 106 everywhere and letting the missing ones fail as a 502 puts
    the burden on the user to discover which is which -- from an HTTP status,
    which tells them nothing. The listing is the authority, and it changes
    about never, so an hour of cache is generous.
    """
    now = time.time()
    with _dirs_lock:
        hit = _dirs_cache.get(region)
        if hit and now - hit[0] < _DIRS_TTL:
            return hit[1]

    reg = BY_REGION.get(region or DEFAULT_REGION)
    if not reg:
        raise RuntimeError(f"unknown MRMS region {region!r}")
    html = _SESSION.get(f"{BASE}{reg['prefix']}", timeout=_HTTP_TIMEOUT).text
    dirs = set(_DIR_RE.findall(html))

    with _dirs_lock:
        _dirs_cache[region] = (now, dirs)
    return dirs


def _available(product: dict[str, Any], dirs: set[str]) -> bool:
    # FLASH nests its own products, so the region only lists the parent.
    return product["path"].split("/")[0] in dirs


def catalog(region: str = DEFAULT_REGION) -> dict[str, Any]:
    """The picker lists, for one region.

    Each product carries whether this region publishes it, rather than being
    silently dropped: a chaser who knows MRMS has rotation tracks should see
    that Alaska does not have them, not wonder where they went.
    """
    try:
        dirs = region_dirs(region)
    except Exception:
        # A listing that will not load must not empty the catalog; better to
        # offer everything and let one product fail than to offer nothing.
        dirs = None

    products = []
    for p in PRODUCTS:
        products.append({
            "id": p["id"],
            "label": p["label"],
            "group": p["group"],
            "units": _units(p),
            "available": True if dirs is None else _available(p, dirs),
        })

    return {
        "products": products,
        "regions": [{"id": r["id"], "label": r["label"]} for r in REGIONS],
        "region": region,
        "defaultProduct": DEFAULT_PRODUCT,
        "defaultRegion": DEFAULT_REGION,
    }


def _units(p: dict[str, Any]) -> str:
    return str(_SCALES.get(p["kind"], {}).get("units", ""))


# ---------------------------------------------------------------------------
# The listing
# ---------------------------------------------------------------------------

_FILE_RE = re.compile(r'href="(MRMS_[^"]+?_(\d{8})-(\d{6})\.grib2\.gz)"')
_list_cache: dict[str, tuple[float, list[dict]]] = {}
_list_lock = threading.Lock()


def _frame_unix(ymd: str, hms: str) -> int:
    dt = datetime.strptime(ymd + hms, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def frames(product: str, limit: int = 60, region: str = DEFAULT_REGION) -> list[dict]:
    """Available times for a product, newest last.

    The directory listing is the index -- MRMS publishes no manifest -- so this
    is a scrape by necessity rather than by preference. It is cached for a
    minute because the listing only changes when a new file lands, which is
    every two minutes at best.
    """
    path = _dir(product, region)
    cache_id = f"{region}/{product}"

    now = time.time()
    with _list_lock:
        hit = _list_cache.get(cache_id)
        if hit and now - hit[0] < _LIST_TTL:
            return hit[1][-limit:]

    url = f"{BASE}{path}/"
    html = _SESSION.get(url, timeout=_HTTP_TIMEOUT).text
    out = [
        {"key": name, "unix": _frame_unix(ymd, hms)}
        for name, ymd, hms in _FILE_RE.findall(html)
    ]
    out.sort(key=lambda f: f["unix"])

    with _list_lock:
        _list_cache[cache_id] = (now, out)
    return out[-limit:]


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------

def _decode(raw: bytes) -> tuple[np.ndarray, dict[str, float]]:
    """GRIB2 -> (values as (nj, ni) north-up, grid corners).

    eccodes will not read from memory, so this goes through a temp file. On
    Windows the handle survives the `with`, which is why the unlink is allowed
    to fail rather than taking the request down with it.
    """
    data = gzip.decompress(raw)
    fd, path = tempfile.mkstemp(suffix=".grib2")
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            fh.write(data)
        with open(path, "rb") as fh:
            with EC_HANDLE_LOCK:  # see model_sources.EC_HANDLE_LOCK
                gid = ec.codes_grib_new_from_file(fh)
            if gid is None:
                raise RuntimeError("not a GRIB2 message")
            try:
                ni = int(ec.codes_get(gid, "Ni"))
                nj = int(ec.codes_get(gid, "Nj"))
                grid = {
                    "north": float(ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")),
                    "south": float(ec.codes_get(gid, "latitudeOfLastGridPointInDegrees")),
                    "west": float(ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")),
                    "east": float(ec.codes_get(gid, "longitudeOfLastGridPointInDegrees")),
                }
                j_up = bool(ec.codes_get(gid, "jScansPositively"))
                vals = ec.codes_get_values(gid).astype(np.float32).reshape(nj, ni)
            finally:
                ec.codes_release(gid)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    # Rows must run north -> south for the warp below; MRMS scans that way, but
    # the flag is what says so rather than the assumption.
    if j_up:
        vals = vals[::-1]
        grid["north"], grid["south"] = grid["south"], grid["north"]

    # MRMS longitudes arrive as 230..300 east; the map speaks -180..180.
    if grid["west"] > 180:
        grid["west"] -= 360
    if grid["east"] > 180:
        grid["east"] -= 360
    return vals, grid


# ---------------------------------------------------------------------------
# Mercator
# ---------------------------------------------------------------------------

def _merc_y(lat_deg: np.ndarray | float) -> np.ndarray | float:
    lat = np.clip(np.asarray(lat_deg, dtype=np.float64), -85.05, 85.05)
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def _mercator_rows(north: float, south: float, nj: int, out_h: int) -> np.ndarray:
    """Row index per output row, so a lat/lon grid draws correctly on a map.

    MapLibre places an image by its four corners and stretches linearly in
    between. Latitude is not linear in Mercator, so an image drawn in even
    degrees is wrong everywhere except its edges -- over 35 degrees of CONUS
    that is tens of kilometres in the middle, enough to put a hail swath in the
    wrong county. Resampling rows onto an even Mercator axis here makes the
    four-corner placement exact.
    """
    # Source row centres, north -> south.
    step = (north - south) / nj
    src_lat = north - (np.arange(nj) + 0.5) * step
    src_y = _merc_y(src_lat)  # decreasing, north -> south

    # Output rows, evenly spaced in Mercator y.
    y_top, y_bot = _merc_y(north), _merc_y(south)
    out_y = np.linspace(y_top, y_bot, out_h)

    # searchsorted needs ascending input, and src_y descends.
    idx = np.searchsorted(src_y[::-1], out_y)
    idx = np.clip(idx, 0, nj - 1)
    return (nj - 1 - idx).astype(np.int32)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _floor(kind: str) -> float:
    """Below-or-equal-to this is nothing, and nothing is transparent."""
    scale = _SCALES.get(kind) or _SCALES["ref"]
    return float(scale.get("floor", 0.0))

_render_cache: dict[tuple, tuple[float, dict]] = {}
_render_lock = threading.Lock()

# The decoded grid, kept apart from the rendered image.
#
# Panning and zooming ask for a different window onto the SAME frame, and
# fetching 1.3 MB and re-decoding 24 million points for each of those would
# make the map feel broken. The array is what is expensive; the crop and the
# colouring that follow are cheap.
_grid_cache: dict[tuple, tuple[float, np.ndarray, dict]] = {}
_grid_lock = threading.Lock()
_GRID_TTL = 900.0
_GRID_MAX = 4


def _grid(path: str, key: str) -> tuple[np.ndarray, dict]:
    ck = (path, key)
    now = time.time()
    with _grid_lock:
        hit = _grid_cache.get(ck)
        if hit and now - hit[0] < _GRID_TTL:
            return hit[1], hit[2]

    raw = _SESSION.get(f"{BASE}{path}/{key}", timeout=_HTTP_TIMEOUT).content
    vals, grid = _decode(raw)

    with _grid_lock:
        _grid_cache[ck] = (now, vals, grid)
        # Each of these is ~100 MB of float32; a handful is a cache, a hundred
        # is a memory leak with a friendly name.
        if len(_grid_cache) > _GRID_MAX:
            for old in sorted(_grid_cache, key=lambda k: _grid_cache[k][0])[:-_GRID_MAX]:
                _grid_cache.pop(old, None)
    return vals, grid


def _cmap_for(kind: str):
    """The colour table and the range its stops are anchored to."""
    scale = _SCALES.get(kind) or _SCALES["ref"]
    if "pal" in scale:
        return get_cmap(scale["pal"])
    from matplotlib import colormaps
    return colormaps[scale["cmap"]], float(scale["vmin"]), float(scale["vmax"])


def _bar(kind: str, steps: int = 64) -> list[str]:
    """The scale as hex stops, so the client draws the legend from the same
    table the pixels came from rather than from a guess about it."""
    cmap, _vmin, _vmax = _cmap_for(kind)
    out = []
    for i in range(steps):
        r, g, b, _a = cmap(i / (steps - 1), bytes=True)
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def _smooth(vals: np.ndarray, kind: str, factor: float) -> np.ndarray:
    """Upsample the FIELD, not the picture.

    A 1 km grid magnified by the map is a grid of squares, because that is
    honestly what it is. Every professional display softens it anyway, and the
    reason it works is where the interpolation happens: between values, before
    the palette, rather than between colours after it. Interpolating dBZ and
    then colouring follows the palette's own steps -- a 45 dBZ core fades
    through the colours the table assigns to 44, 43, 42. Interpolating the
    finished pixels instead blends red into green through whatever lies
    between them in RGB, which is mud.

    No-data is carried through as a mask rather than a number. Letting -999
    into the average would drag a whole neighbourhood of real echo down toward
    nothing, painting a dark halo around every storm.
    """
    if factor <= 1.01:
        return vals

    floor = _floor(kind)
    good = np.isfinite(vals) & (vals > floor)
    if not good.any():
        return vals

    filled = np.where(good, vals, floor).astype(np.float32)
    # order=1 is bilinear: enough to lose the squares, not enough to invent
    # detail. Cubic overshoots at a storm edge and paints values the radar
    # never measured.
    big = _ndzoom(filled, factor, order=1, mode="nearest")
    mask = _ndzoom(good.astype(np.float32), factor, order=1, mode="nearest")

    # Half a cell of coverage keeps the edge where the data put it; anything
    # lower grows the echo outward with every zoom step.
    out = np.where(mask >= 0.5, big, floor - 1.0)
    return out.astype(np.float32)


def _colorize(vals: np.ndarray, kind: str) -> np.ndarray:
    cmap, vmin, vmax = _cmap_for(kind)

    good = np.isfinite(vals) & (vals > _floor(kind))
    norm = Normalize(vmin=vmin, vmax=vmax, clip=True)
    rgba = cmap(norm(np.where(good, vals, vmin)), bytes=True)
    rgba[..., 3] = np.where(good, rgba[..., 3], 0)
    return rgba


def render(product: str = DEFAULT_PRODUCT, key: str = "", width: int = 2048,
           region: str = DEFAULT_REGION,
           bbox: Optional[tuple[float, float, float, float]] = None) -> dict:
    """One frame as a Mercator PNG, ready for a MapLibre image source.

    `bbox` is (west, south, east, north) and is what makes zooming legible. A
    single image spanning CONUS is 7000 cells wide; asking a browser to hold
    that as one texture is asking for either a refusal or a downscale, so the
    whole-domain view has to be coarse. Cropping to what the screen actually
    shows spends the same pixels on a hundredth of the area, which is the
    difference between 3 km blocks and the 1 km the data is published at.
    """
    path = _dir(product, region)
    spec = BY_ID[product]

    box_id = tuple(round(v, 3) for v in bbox) if bbox else None
    cache_key = (region, product, key or "latest", width, box_id)
    now = time.time()
    with _render_lock:
        hit = _render_cache.get(cache_key)
        # A named frame is a fixed moment and never changes; "latest" moves.
        if hit and (key or now - hit[0] < _RENDER_TTL):
            return hit[1]

    if not key:
        try:
            avail = frames(product, limit=1, region=region)
        except Exception:
            avail = []
        if not avail:
            reg = BY_REGION.get(region, {}).get("label", region)
            try:
                published = _available(spec, region_dirs(region))
            except Exception:
                published = True
            raise RuntimeError(
                f"{spec['label']} is not published for {reg}."
                if not published
                else f"No recent {spec['label']} frame for {reg}."
            )
        key = avail[-1]["key"]

    vals, grid = _grid(path, key)
    nj, ni = vals.shape

    # ---- crop to the requested window, snapped to whole source cells --------
    west, south, east, north = grid["west"], grid["south"], grid["east"], grid["north"]
    if bbox:
        bw, bs, be, bn = bbox
        # An empty intersection means the view is off the domain entirely; the
        # clamps below collapse it to a sliver rather than to a negative size.
        bw, be = max(west, min(bw, east)), max(west, min(be, east))
        bs, bn = max(south, min(bs, north)), max(south, min(bn, north))
        if be - bw > 1e-6 and bn - bs > 1e-6:
            dx = (east - west) / ni
            dy = (north - south) / nj
            c0 = max(0, int(np.floor((bw - west) / dx)))
            c1 = min(ni, int(np.ceil((be - west) / dx)))
            r0 = max(0, int(np.floor((north - bn) / dy)))
            r1 = min(nj, int(np.ceil((north - bs) / dy)))
            if c1 - c0 >= 2 and r1 - r0 >= 2:
                vals = vals[r0:r1, c0:c1]
                nj, ni = vals.shape
                west, east = west + c0 * dx, west + c1 * dx
                north, south = north - r0 * dy, north - r1 * dy

    # ---- smoothing, when the screen has more pixels than the grid has cells --
    #
    # Only ever up to 4x. Beyond that the interpolation is inventing shapes at
    # a scale the radar cannot resolve, and a smooth picture of something that
    # was never measured is worse than a blocky picture of something that was.
    if width > ni * 1.2:
        factor = min(4.0, width / max(ni, 1))
        vals = _smooth(vals, spec["kind"], factor)
        nj, ni = vals.shape

    # Column decimation is a plain stride: longitude IS linear in Mercator.
    out_w = min(width, ni)
    cols = np.linspace(0, ni - 1, out_w).astype(np.int32)
    # Keep the aspect the map expects, in Mercator space rather than degrees.
    span_x = abs(east - west)
    span_y = abs(float(_merc_y(north) - _merc_y(south)))
    out_h = max(1, int(round(out_w * span_y / np.radians(span_x))))
    rows = _mercator_rows(north, south, nj, out_h)

    warped = vals[np.ix_(rows, cols)]
    rgba = _colorize(warped, spec["kind"])

    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=False, compress_level=6)

    m = _FILE_RE.search(f'href="{key}"')
    unix = _frame_unix(m.group(2), m.group(3)) if m else int(time.time())

    _cm, vmin, vmax = _cmap_for(spec["kind"])

    payload = {
        "png": buf.getvalue(),
        # Corner order MapLibre wants: TL, TR, BR, BL. These are the CROPPED
        # bounds, not the domain's -- the image is placed where it was cut from.
        "coordinates": [
            [west, north],
            [east, north],
            [east, south],
            [west, south],
        ],
        "meta": {
            "product": product,
            "region": region,
            "label": spec["label"],
            "group": spec["group"],
            "units": _units(spec),
            "key": key,
            "unix": unix,
            "width": int(out_w),
            "height": int(out_h),
            # What the domain covers, so the client can clamp its next request
            # instead of asking for ocean.
            "domain": [grid["west"], grid["south"], grid["east"], grid["north"]],
            # Metres per output pixel at the middle of the crop, which is the
            # honest answer to "how sharp is this".
            "resolutionKm": round(abs(east - west) / max(out_w, 1) * 111.0, 2),
            "vmin": vmin,
            "vmax": vmax,
            "bar": _bar(spec["kind"]),
            "source": "NOAA MRMS",
        },
    }
    with _render_lock:
        _render_cache[cache_key] = (now, payload)
    return payload
