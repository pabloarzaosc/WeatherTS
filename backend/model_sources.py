"""
Model fields, from wherever each model is published.

Every model product in the app -- isobars and H/L centres, the automatic
fronts -- needs a handful of fields from a run: mean sea level pressure, and at
850 hPa temperature, humidity and wind, plus terrain height to mask where
850 hPa is underground. Each centre publishes them differently:

    NCEP (NOMADS)     GRIB2 with an .idx sidecar: read the byte offsets, fetch
                      only the messages wanted
    ECMWF open data   GRIB2 with a JSON .index sidecar: the same idea
    DWD open data     one bzip2-compressed GRIB2 per field; ICON global on its
                      icosahedral mesh, with the cell centres published apart
    ECCC datamart     one GRIB2 per field, some on rotated lat/lon grids
    FNMOC, JMA        one whole GRIB2 per step
    Met Office        one netCDF per field

MODELS says, for each model, where each field lives. Everything else -- finding
the newest run that carries an hour, reading only the bytes needed, decoding to
coordinates and consistent units, putting scattered grids onto a regular one --
is shared, so a model is a table entry rather than new code.

Only openly published data is used. Models whose owners gate their output
behind an account or key are left out rather than scraped.
"""
from __future__ import annotations

import bz2
import io
import json
import math
import os
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

import eccodes as ec
import numpy as np
import requests
from requests.adapters import HTTPAdapter
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree
from urllib3.util.retry import Retry

NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com"
ECMWF = "https://data.ecmwf.int/forecasts"
DWD = "https://opendata.dwd.de/weather/nwp"
MSC = "https://dd.weather.gc.ca"
UKMO = "https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com"
RISH = "http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original"

# Logical fields. Humidity comes in whichever form a centre publishes (relative,
# specific, dew point, dew point depression); the fronts code converts.
HUMIDITY = ("rh850", "q850", "td850", "depr850")

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_SESSION.mount(
    "http",
    HTTPAdapter(
        pool_maxsize=16,
        max_retries=Retry(total=3, connect=3, read=2, backoff_factor=0.6,
                          status_forcelist=(429, 500, 502, 503, 504),
                          allowed_methods=frozenset(["GET"])),
    ),
)
_TIMEOUT = (10, 120)


# ================================================================== catalogue
def _ncep(url: str, **fields: Any) -> dict:
    return {"kind": "idx", "url": url, "fields": fields}


def _msc(url: str, **fields: str) -> dict:
    return {"kind": "direct", "fields": {k: url.replace("{var}", v) for k, v in fields.items()}}


def _ecmwf(url: str, extra: Optional[dict] = None, **fields: dict) -> dict:
    return {"kind": "ecmwf", "url": url,
            "fields": {k: {**(extra or {}), **v} for k, v in fields.items()}}


_NCEP_850 = dict(t850="TMP:850 mb", rh850="RH:850 mb", u850="UGRD:850 mb", v850="VGRD:850 mb", orog="HGT:surface")
# 1000-500 hPa thickness, the other set of lines on a surface chart.
_NCEP_THICK = dict(z500="HGT:500 mb", z1000="HGT:1000 mb")
_MSC_DD = MSC + "/{ymd}/WXO-DD"
_RRFS_2D = NOMADS + "/rrfs/v1.0/rrfs.{ymd}/{cc}/rrfs.t{cc}z.2dfld.3km.f{fff}.conus.grib2"
# The folder is the run; the file is named for the time it is valid at.
_UKMO_GLOBAL = UKMO + "/global-deterministic-10km/{ymd}T{cc}00Z/{valid}-PT{hhhh}H00M-{var}.nc"
_UKMO_UKV = UKMO + "/uk-deterministic-2km/{ymd}T{cc}00Z/{valid}-PT{hhhh}H00M-{var}.nc"
_IFS_FIELDS = dict(
    mslp={"param": "msl"},
    z500={"param": "gh", "levelist": "500"},
    z1000={"param": "gh", "levelist": "1000"},
    t850={"param": "t", "levelist": "850"},
    rh850={"param": "r", "levelist": "850"},
    u850={"param": "u", "levelist": "850"},
    v850={"param": "v", "levelist": "850"},
)
_AIFS_FIELDS = dict(
    mslp={"param": "msl"},
    t850={"param": "t", "levelist": "850"},
    q850={"param": "q", "levelist": "850"},
    u850={"param": "u", "levelist": "850"},
    v850={"param": "v", "levelist": "850"},
)


def _dwd(model: str, grid: str, pmsl: str, t: str, rh: str, u: str, v: str, hsurf: str,
         fi500: str = "", fi1000: str = "") -> dict:
    base = f"{DWD}/{model}/grib/{{cc}}"
    return {
        "kind": "direct",
        "bz2": True,
        "fields": {
            "mslp": f"{base}/pmsl/{pmsl}",
            "t850": f"{base}/t/{t}",
            "rh850": f"{base}/relhum/{rh}",
            "u850": f"{base}/u/{u}",
            "v850": f"{base}/v/{v}",
            "orog": f"{base}/hsurf/{hsurf}",
            **({"z500": f"{base}/fi/{fi500}", "z1000": f"{base}/fi/{fi1000}"} if fi500 else {}),
        },
    }


#   category   Global | Regional | Mesoscale | AI | Ensemble | Climate
#   region     the centre's home, as the picker groups them
#   world      wraps the globe (dateline handling, periodic smoothing)
#   spacing    nominal grid spacing in degrees, for smoothing and centre spacing
#   cycles     UTC hours the model runs at; hours: fine_step to fine_until, then step
MODELS: dict[str, dict[str, Any]] = {
    # ---- Global ----------------------------------------------------------------
    "gfs-0p25": {
        "label": "GFS 0.25°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Global", "region": "USA",
        "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 120, "step": 3, "max_hour": 384,
        "src": _ncep(NOMADS + "/gfs/prod/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.pgrb2.0p25.f{fff}",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "gfs-0p50": {
        "label": "GFS 0.5°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Global", "region": "USA",
        "world": True, "spacing": 0.5, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
        "src": _ncep(NOMADS + "/gfs/prod/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.pgrb2full.0p50.f{fff}",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "gfs-1p00": {
        "label": "GFS 1.0°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Global", "region": "USA",
        "world": True, "spacing": 1.0, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
        "src": _ncep(NOMADS + "/gfs/prod/gfs.{ymd}/{cc}/atmos/gfs.t{cc}z.pgrb2.1p00.f{fff}",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "gdas-0p25": {
        "label": "GDAS 0.25° (analysis)", "org": "NOAA/NCEP", "coverage": "Global", "category": "Global",
        "region": "USA", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 9, "step": 3, "max_hour": 9,
        "src": _ncep(NOMADS + "/gfs/prod/gdas.{ymd}/{cc}/atmos/gdas.t{cc}z.pgrb2.0p25.f{fff}",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "navgem-0p5": {
        "label": "NAVGEM 0.5°", "org": "US Navy (FNMOC)", "coverage": "Global", "category": "Global",
        "region": "USA", "world": True, "spacing": 0.5, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 24, "step": 6, "max_hour": 180,
        "src": {"kind": "whole", "url": NOMADS + "/fnmoc/prod/navgem.{ymd}/navgem_{ymd}{cc}f{fff}.grib2",
                "fields": {
                    "mslp": {"shortName": "prmsl"},
                    "t850": {"shortName": "t", "typeOfLevel": "isobaricInhPa", "level": 850},
                    "rh850": {"shortName": "r", "typeOfLevel": "isobaricInhPa", "level": 850},
                    "u850": {"shortName": "u", "typeOfLevel": "isobaricInhPa", "level": 850},
                    "v850": {"shortName": "v", "typeOfLevel": "isobaricInhPa", "level": 850},
                }},
    },
    "ecmwf-ifs": {
        "label": "ECMWF IFS 0.25°", "org": "ECMWF", "coverage": "Global", "category": "Global",
        "region": "European", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 144, "step": 6, "max_hour": 240,
        "src": _ecmwf(ECMWF + "/{ymd}/{cc}z/ifs/0p25/{stream}/{ymd}{cc}0000-{h}h-{stream}-fc.grib2",
                      orog={"param": "z", "levtype": "sfc", "scale": 1 / 9.80665}, **_IFS_FIELDS),
    },
    "icon-global": {
        "label": "ICON 13 km", "org": "DWD (Germany)", "coverage": "Global", "category": "Global",
        "region": "European", "world": True, "spacing": 0.125, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 78, "step": 3, "max_hour": 180,
        "src": {
            **_dwd("icon", "icosahedral",
                   pmsl="icon_global_icosahedral_single-level_{ymd}{cc}_{fff}_PMSL.grib2.bz2",
                   t="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_850_T.grib2.bz2",
                   rh="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_850_RELHUM.grib2.bz2",
                   u="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_850_U.grib2.bz2",
                   v="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_850_V.grib2.bz2",
                   hsurf="icon_global_icosahedral_time-invariant_{ymd}{cc}_HSURF.grib2.bz2",
                   fi500="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_500_FI.grib2.bz2",
                   fi1000="icon_global_icosahedral_pressure-level_{ymd}{cc}_{fff}_1000_FI.grib2.bz2"),
            "cells": {
                "lat": DWD + "/icon/grib/{cc}/clat/icon_global_icosahedral_time-invariant_{ymd}{cc}_CLAT.grib2.bz2",
                "lon": DWD + "/icon/grib/{cc}/clon/icon_global_icosahedral_time-invariant_{ymd}{cc}_CLON.grib2.bz2",
            },
        },
    },
    "ukmo-global": {
        "label": "UKMET 10 km", "org": "Met Office (UK)", "coverage": "Global", "category": "Global",
        "region": "European", "world": True, "spacing": 0.14, "cycles": (0, 6, 12, 18),
        # Hourly to 54 h, 3-hourly to 144 h, 6-hourly to 168 h -- from 00z and
        # 12z; the 06z and 18z runs stop at 69 h.
        "fine_step": 1, "fine_until": 54, "step": 3, "max_hour": 168,
        "hours": [*range(0, 55), *range(57, 145, 3), *range(150, 169, 6)],
        # Pressure only: the 850 hPa fields come as every-level files of 150-230 MB.
        "src": {"kind": "netcdf", "fields": {
            "mslp": _UKMO_GLOBAL.replace("{var}", "pressure_at_mean_sea_level"),
            "orog": _UKMO_GLOBAL.replace("{var}", "height_of_orography"),
        }},
    },
    "gdps-15km": {
        "label": "GDPS 15 km", "org": "ECCC (Canada)", "coverage": "Global", "category": "Global",
        "region": "Canadian", "world": True, "spacing": 0.15, "cycles": (0, 12),
        "fine_step": 3, "fine_until": 240, "step": 3, "max_hour": 240,
        "src": _msc(_MSC_DD + "/model_gdps/15km/{cc}/{fff}/{ymd}T{cc}Z_MSC_GDPS_{var}_LatLon0.15_PT{fff}H.grib2",
                    mslp="Pressure_MSL", t850="AirTemp_IsbL-0850", rh850="RelativeHumidity_IsbL-0850",
                    u850="WindU_IsbL-0850", v850="WindV_IsbL-0850", orog="GeopotentialHeight_Sfc",
                    z500="GeopotentialHeight_IsbL-0500", z1000="GeopotentialHeight_IsbL-1000"),
    },
    "jma-gsm": {
        "label": "JMA GSM 0.5°", "org": "JMA (Japan)", "coverage": "Global", "category": "Global",
        "region": "Asian", "world": True, "spacing": 0.5, "cycles": (0, 6, 12, 18),
        "fine_step": 6, "fine_until": 264, "step": 6, "max_hour": 264,
        "src": {"kind": "whole",
                "url": RISH + "/{Y}/{m}/{d}/Z__C_RJTD_{ymd}{cc}0000_GSM_GPV_Rgl_FD{dd}{hh}_grib2.bin",
                "fields": {"mslp": {"shortName": "prmsl"}}},
    },

    # ---- Regional --------------------------------------------------------------
    "nam-12km": {
        "label": "NAM 12 km", "org": "NOAA/NCEP", "coverage": "North America", "category": "Regional",
        "region": "USA", "world": False, "spacing": 0.11, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 36, "step": 3, "max_hour": 84,
        "src": _ncep(NOMADS + "/nam/prod/nam.{ymd}/nam.t{cc}z.awphys{ff}.tm00.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "rap-13km": {
        "label": "RAP 13 km", "org": "NOAA/NCEP", "coverage": "North America", "category": "Regional",
        "region": "USA", "world": False, "spacing": 0.12, "cycles": tuple(range(24)),
        "fine_step": 1, "fine_until": 51, "step": 1, "max_hour": 51,
        "src": _ncep(NOMADS + "/rap/prod/rap.{ymd}/rap.t{cc}z.awp130pgrbf{ff}.grib2",
                     mslp="MSLMA:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "icon-eu": {
        "label": "ICON-EU 7 km", "org": "DWD (Germany)", "coverage": "Europe", "category": "Regional",
        "region": "European", "world": False, "spacing": 0.0625, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 78, "step": 3, "max_hour": 120,
        "src": _dwd("icon-eu", "regular",
                    pmsl="icon-eu_europe_regular-lat-lon_single-level_{ymd}{cc}_{fff}_PMSL.grib2.bz2",
                    t="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_T.grib2.bz2",
                    rh="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_RELHUM.grib2.bz2",
                    u="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_U.grib2.bz2",
                    v="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_V.grib2.bz2",
                    hsurf="icon-eu_europe_regular-lat-lon_time-invariant_{ymd}{cc}_HSURF.grib2.bz2",
                    fi500="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_500_FI.grib2.bz2",
                    fi1000="icon-eu_europe_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_1000_FI.grib2.bz2"),
    },
    "rdps-10km": {
        "label": "RDPS (RGEM) 10 km", "org": "ECCC (Canada)", "coverage": "North America", "category": "Regional",
        "region": "Canadian", "world": False, "spacing": 0.09, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 84, "step": 1, "max_hour": 84,
        "src": _msc(_MSC_DD + "/model_rdps/10km/{cc}/{fff}/{ymd}T{cc}Z_MSC_RDPS_{var}_RLatLon0.09_PT{fff}H.grib2",
                    mslp="Pressure_MSL", t850="AirTemp_IsbL-0850", rh850="RelativeHumidity_IsbL-0850",
                    u850="WindU_IsbL-0850", v850="WindV_IsbL-0850", orog="GeopotentialHeight_Sfc",
                    z500="GeopotentialHeight_IsbL-0500", z1000="GeopotentialHeight_IsbL-1000"),
    },

    # ---- Mesoscale -------------------------------------------------------------
    "hrrr-3km": {
        "label": "HRRR 3 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": tuple(range(24)),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _ncep(NOMADS + "/hrrr/prod/hrrr.{ymd}/conus/hrrr.t{cc}z.wrfsfcf{ff}.grib2",
                     mslp="MSLMA:mean sea level", t850="TMP:850 mb", td850="DPT:850 mb",
                     u850="UGRD:850 mb", v850="VGRD:850 mb", orog="HGT:surface", **_NCEP_THICK),
    },
    "hrrr-ak-3km": {
        "label": "HRRR Alaska 3 km", "org": "NOAA/NCEP", "coverage": "Alaska", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 3, 6, 9, 12, 15, 18, 21),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _ncep(NOMADS + "/hrrr/prod/hrrr.{ymd}/alaska/hrrr.t{cc}z.wrfsfcf{ff}.ak.grib2",
                     mslp="MSLMA:mean sea level", t850="TMP:850 mb", td850="DPT:850 mb",
                     u850="UGRD:850 mb", v850="VGRD:850 mb", orog="HGT:surface", **_NCEP_THICK),
    },
    "nam-3km": {
        "label": "NAM 3 km CONUS", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
        "src": _ncep(NOMADS + "/nam/prod/nam.{ymd}/nam.t{cc}z.conusnest.hiresf{ff}.tm00.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "nam-3km-ak": {
        "label": "NAM 3 km Alaska", "org": "NOAA/NCEP", "coverage": "Alaska", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
        "src": _ncep(NOMADS + "/nam/prod/nam.{ymd}/nam.t{cc}z.alaskanest.hiresf{ff}.tm00.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "nam-3km-hi": {
        "label": "NAM 3 km Hawaii", "org": "NOAA/NCEP", "coverage": "Hawaii", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fronts": False,  # a small tropical domain: the detector masks everything equatorward of 20 deg

        "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
        "src": _ncep(NOMADS + "/nam/prod/nam.{ymd}/nam.t{cc}z.hawaiinest.hiresf{ff}.tm00.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "nam-3km-pr": {
        "label": "NAM 3 km Puerto Rico", "org": "NOAA/NCEP", "coverage": "Puerto Rico", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fronts": False,  # a small tropical domain: the detector masks everything equatorward of 20 deg

        "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
        "src": _ncep(NOMADS + "/nam/prod/nam.{ymd}/nam.t{cc}z.priconest.hiresf{ff}.tm00.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "rrfs-3km": {
        "label": "RRFS A 3 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 84, "step": 1, "max_hour": 84,
        "src": _ncep(NOMADS + "/rrfs/v1.0/rrfs.{ymd}/{cc}/rrfs.t{cc}z.prslev.3km.f{fff}.conus.grib2",
                     mslp=(_RRFS_2D, "MSLET:mean sea level"), orog=(_RRFS_2D, "HGT:surface"),
                     t850="TMP:850 mb", rh850="RH:850 mb", u850="UGRD:850 mb", v850="VGRD:850 mb", **_NCEP_THICK),
    },
    "hiresw-fv3": {
        "label": "HRW FV3 5 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.05, "cycles": (0, 12),
        "fine_step": 1, "fine_until": 60, "step": 1, "max_hour": 60,
        "src": _ncep(NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{cc}z.fv3_5km.f{ff}.conus.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "hiresw-arw": {
        "label": "WRF-ARW 5 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.05, "cycles": (0, 12),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _ncep(NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{cc}z.arw_5km.f{ff}.conus.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "hiresw-arw2": {
        "label": "WRF-ARW2 5 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Mesoscale",
        "region": "USA", "world": False, "spacing": 0.05, "cycles": (0, 12),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _ncep(NOMADS + "/hiresw/prod/hiresw.{ymd}/hiresw.t{cc}z.arw_5km.f{ff}.conusmem2.grib2",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "icon-d2": {
        "label": "ICON-D2 2.2 km", "org": "DWD (Germany)", "coverage": "Central Europe", "category": "Mesoscale",
        "region": "European", "world": False, "spacing": 0.02, "cycles": (0, 3, 6, 9, 12, 15, 18, 21),
        # About 1200 km across: no room for a front 600 km long to be traced
        # once the field is blurred to synoptic scale (none found in testing).
        "fronts": False,
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _dwd("icon-d2", "regular",
                    pmsl="icon-d2_germany_regular-lat-lon_single-level_{ymd}{cc}_{fff}_2d_pmsl.grib2.bz2",
                    t="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_t.grib2.bz2",
                    rh="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_relhum.grib2.bz2",
                    u="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_u.grib2.bz2",
                    v="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_850_v.grib2.bz2",
                    hsurf="icon-d2_germany_regular-lat-lon_time-invariant_{ymd}{cc}_000_0_hsurf.grib2.bz2",
                    fi500="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_500_fi.grib2.bz2",
                    fi1000="icon-d2_germany_regular-lat-lon_pressure-level_{ymd}{cc}_{fff}_1000_fi.grib2.bz2"),
    },
    "ukv-2km": {
        "label": "UKV 2 km", "org": "Met Office (UK)", "coverage": "United Kingdom", "category": "Mesoscale",
        "region": "European", "world": False, "spacing": 0.02, "cycles": tuple(range(24)),
        "fine_step": 1, "fine_until": 54, "step": 1, "max_hour": 54,
        "src": {"kind": "netcdf", "fields": {
            "mslp": _UKMO_UKV.replace("{var}", "pressure_at_mean_sea_level"),
        }},
    },
    "hrdps-2.5km": {
        "label": "HRDPS 2.5 km", "org": "ECCC (Canada)", "coverage": "Canada", "category": "Mesoscale",
        "region": "Canadian", "world": False, "spacing": 0.0225, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _msc(_MSC_DD + "/model_hrdps/continental/2.5km/{cc}/{fff}/{ymd}T{cc}Z_MSC_HRDPS_{var}_RLatLon0.0225_PT{fff}H.grib2",
                    mslp="PRMSL_MSL", t850="TMP_ISBL_0850", rh850="RH_ISBL_0850",
                    u850="UGRD_ISBL_0850", v850="VGRD_ISBL_0850", orog="HGT_Sfc"),
    },
    "caps-3km": {
        "label": "CAPS 3 km", "org": "ECCC (Canada)", "coverage": "Canadian Arctic", "category": "Mesoscale",
        "region": "Canadian", "world": False, "spacing": 0.03, "cycles": (0, 12),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48,
        "src": _msc(_MSC_DD + "/model_caps/3km/{cc}/{fff}/{ymd}T{cc}Z_MSC_CAPS_{var}_RLatLon0.03_PT{fff}H.grib2",
                    mslp="Pressure_MSL", t850="AirTemp_IsbL-0850", rh850="RelativeHumidity_IsbL-0850",
                    u850="WindU_IsbL-0850", v850="WindV_IsbL-0850", orog="GeopotentialHeight_Sfc",
                    z500="GeopotentialHeight_IsbL-0500", z1000="GeopotentialHeight_IsbL-1000"),
    },

    # ---- AI --------------------------------------------------------------------
    "ecmwf-aifs": {
        "label": "ECMWF AIFS 0.25°", "org": "ECMWF", "coverage": "Global", "category": "AI",
        "region": "European", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 6, "fine_until": 360, "step": 6, "max_hour": 360,
        "src": _ecmwf(ECMWF + "/{ymd}/{cc}z/aifs-single/0p25/oper/{ymd}{cc}0000-{h}h-oper-fc.grib2",
                      orog={"param": "z", "levtype": "sfc", "scale": 1 / 9.80665},
                      z500={"param": "gh", "levelist": "500"},
                      z1000={"param": "gh", "levelist": "1000"}, **_AIFS_FIELDS),
    },
    "ecmwf-aifs-ens": {
        "label": "ECMWF AIFS ENS (control)", "org": "ECMWF", "coverage": "Global", "category": "AI",
        "region": "European", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 6, "fine_until": 360, "step": 6, "max_hour": 360,
        "src": _ecmwf(ECMWF + "/{ymd}/{cc}z/aifs-ens/0p25/enfo/{ymd}{cc}0000-{h}h-enfo-cf.grib2",
                      {"type": "cf"}, orog={"param": "z", "levtype": "sfc", "scale": 1 / 9.80665},
                      **_AIFS_FIELDS),
    },
    "gem-ml-25km": {
        "label": "GEM-ML 25 km", "org": "ECCC (Canada)", "coverage": "Global", "category": "AI",
        "region": "Canadian", "world": True, "spacing": 0.25, "cycles": (0, 12),
        # Starts from the GDPS analysis and publishes nothing at hour 0.
        "fine_step": 6, "fine_until": 240, "step": 6, "max_hour": 240, "first_hour": 6,
        "src": _msc(_MSC_DD + "/model_gdps-geml/25km/{cc}/{fff}/{ymd}T{cc}Z_MSC_GDPS-GEML_{var}_LatLon0.25_PT{fff}H.grib2",
                    mslp="Pressure_MSL", t850="AirTemp_IsbL-0850", q850="SpecificHumidity_IsbL-0850",
                    u850="WindU_IsbL-0850", v850="WindV_IsbL-0850",
                    z500="Geopotential_IsbL-0500", z1000="Geopotential_IsbL-1000"),
    },

    # ---- Ensemble --------------------------------------------------------------
    "gefs-mean": {
        "label": "GEFS mean 0.5°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Ensemble",
        "region": "USA", "world": True, "spacing": 0.5, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 384, "step": 3, "max_hour": 384,
        "src": _ncep(NOMADS + "/gens/prod/gefs.{ymd}/{cc}/atmos/pgrb2ap5/geavg.t{cc}z.pgrb2a.0p50.f{fff}",
                     mslp="PRMSL:mean sea level", **_NCEP_850, **_NCEP_THICK),
    },
    "gefs-mean-0p25": {
        "label": "GEFS mean 0.25°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Ensemble",
        "region": "USA", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        "fine_step": 3, "fine_until": 240, "step": 3, "max_hour": 240,
        "src": _ncep(NOMADS + "/gens/prod/gefs.{ymd}/{cc}/atmos/pgrb2sp25/geavg.t{cc}z.pgrb2s.0p25.f{fff}",
                     mslp="PRMSL:mean sea level", orog="HGT:surface"),
    },
    "geps-mean": {
        "label": "GEPS mean 0.5°", "org": "ECCC (Canada)", "coverage": "Global", "category": "Ensemble",
        "region": "Canadian", "world": True, "spacing": 0.5, "cycles": (0, 12),
        "fine_step": 3, "fine_until": 192, "step": 6, "max_hour": 384,
        # No terrain height in the mean files.
        "src": _ncep(NOMADS + "/naefs/prod/cmce.{ymd}/{cc}/pgrb2ap5/cmc_geavg.t{cc}z.pgrb2a.0p50.f{fff}",
                     mslp="PRMSL:mean sea level", t850="TMP:850 mb", rh850="RH:850 mb",
                     u850="UGRD:850 mb", v850="VGRD:850 mb", **_NCEP_THICK),
    },
    "ecmwf-ens-mean": {
        "label": "ECMWF ENS mean", "org": "ECMWF", "coverage": "Global", "category": "Ensemble",
        "region": "European", "world": True, "spacing": 0.25, "cycles": (0, 6, 12, 18),
        # 00z and 12z to 360 h, 06z and 18z to 144 h.
        "fine_step": 3, "fine_until": 144, "step": 6, "max_hour": 360,
        # Averaged here from the 50 members, about 27 MB a step. Pressure only:
        # their 850 hPa fields would be five times that.
        "src": {**_ecmwf(ECMWF + "/{ymd}/{cc}z/ifs/0p25/enfo/{ymd}{cc}0000-{h}h-enfo-ef.grib2",
                         {"type": "pf"}, mslp={"param": "msl"}), "mean": True},
    },
    "href-mean": {
        "label": "HREF mean 3 km", "org": "NOAA/NCEP", "coverage": "CONUS", "category": "Ensemble",
        "region": "USA", "world": False, "spacing": 0.03, "cycles": (0, 6, 12, 18),
        "fine_step": 1, "fine_until": 48, "step": 1, "max_hour": 48, "first_hour": 1,
        "src": _ncep(NOMADS + "/href/prod/href.{ymd}/ensprod/href.t{cc}z.conus.mean.f{ff}.grib2",
                     mslp="MSLET:mean sea level", t850="TMP:850 mb", td850="DPT:850 mb",
                     u850="UGRD:850 mb", v850="VGRD:850 mb"),
    },

    # ---- Climate ---------------------------------------------------------------
    "cfs": {
        "label": "CFS 1.0°", "org": "NOAA/NCEP", "coverage": "Global", "category": "Climate",
        "region": "USA", "world": True, "spacing": 1.0, "cycles": (0, 6, 12, 18),
        "fine_step": 6, "fine_until": 768, "step": 6, "max_hour": 768,
        "src": _ncep(NOMADS + "/cfs/prod/cfs.{ymd}/{cc}/6hrly_grib_01/pgbf{vymdh}.01.{ymd}{cc}.grb2",
                     mslp="PRMSL:mean sea level", t850="TMP:850 mb", rh850="RH:850 mb",
                     u850="UGRD:850 mb", v850="VGRD:850 mb", **_NCEP_THICK),
    },
}

DEFAULT_MODEL = "gfs-0p25"
LOOKBACK_RUNS = 8


def fields_of(model_id: str) -> set[str]:
    return set(MODELS[model_id]["src"]["fields"])


def has_mslp(model_id: str) -> bool:
    return "mslp" in fields_of(model_id)


def has_fronts(model_id: str) -> bool:
    if MODELS[model_id].get("fronts") is False:
        return False
    f = fields_of(model_id)
    return {"t850", "u850", "v850"} <= f and any(h in f for h in HUMIDITY)


def has_thickness(model_id: str) -> bool:
    """Publishes both heights the 1000-500 hPa thickness is made of."""
    return {"z500", "z1000"} <= fields_of(model_id)


def forecast_hours(model_id: str) -> list[int]:
    m = MODELS[model_id]
    if "hours" in m:  # an axis with more than two steps
        return list(m["hours"])
    first = m.get("first_hour", 0)
    hours = list(range(first, min(m["fine_until"], m["max_hour"]) + 1, m["fine_step"]))
    hours += list(range(m["fine_until"] + m["step"], m["max_hour"] + 1, m["step"]))
    return sorted(set(h for h in hours if first <= h <= m["max_hour"]))


def candidate_runs(model_id: str, now: Optional[datetime] = None) -> list[datetime]:
    """Plausible recent runs, newest first."""
    cycles = set(MODELS[model_id]["cycles"])
    t = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    out: list[datetime] = []
    for _ in range(24 * 4):
        if t.hour in cycles:
            out.append(t)
            if len(out) >= LOOKBACK_RUNS:
                break
        t -= timedelta(hours=1)
    return out


# ==================================================================== fetching
@dataclass
class Field:
    """A decoded field. Coordinates are 1-D for a regular lat/lon grid (lat may
    run either way), 2-D for anything projected, and 1-D per cell for ICON's
    unstructured mesh (then `values` is 1-D too)."""
    lons: np.ndarray
    lats: np.ndarray
    values: np.ndarray
    world: bool
    # Wind components along the grid's own axes rather than east and north, as
    # Lambert and rotated grids publish them.
    grid_relative: bool = False
    # What the file says the values are in ("gpm", "m**2 s**-2", "Pa", ...).
    units: str = ""

    @property
    def regular(self) -> bool:
        return self.lons.ndim == 1 and self.values.ndim == 2

    @property
    def scattered(self) -> bool:
        return self.values.ndim == 1


def _fmt(template: str, run: datetime, hour: int) -> str:
    valid = run + timedelta(hours=hour)
    return template.format(
        ymd=run.strftime("%Y%m%d"), cc=run.strftime("%H"), Y=run.strftime("%Y"), m=run.strftime("%m"),
        d=run.strftime("%d"), fff=f"{hour:03d}", ff=f"{hour:02d}", h=hour, hhhh=f"{hour:04d}",
        dd=f"{hour // 24:02d}", hh=f"{hour % 24:02d}", vymdh=valid.strftime("%Y%m%d%H"),
        valid=valid.strftime("%Y%m%dT%H%MZ"),
        # The open-data mirror files the 06z and 18z runs under "oper" too
        # (checked: .../06z/ifs/0p25/oper/ answers, .../scda/ is a 404).
        stream="oper",
    )


class RateLimited(RuntimeError):
    """A server is refusing requests for a while. Trying older runs would only
    keep it refusing, so this is not treated as a missing field."""


# Requests a minute allowed per host. NOMADS blocks an address for a quarter
# of an hour past about 120 -- and blocked it again soon after the first block
# lifted -- while one fronts load is a burst of dozens. The margin leaves room
# for the rest of the app's NOMADS use.
_HOST_LIMITS = {"nomads.ncep.noaa.gov": 60}
_HITS: dict[str, list[float]] = {}
_HITS_LOCK = threading.Lock()


def _throttle(url: str) -> None:
    host = urlsplit(url).netloc
    limit = _HOST_LIMITS.get(host)
    if limit is None:
        return
    while True:
        with _HITS_LOCK:
            now = time.monotonic()
            hits = [t for t in _HITS.get(host, []) if now - t < 60.0]
            if len(hits) < limit:
                hits.append(now)
                _HITS[host] = hits
                return
            _HITS[host] = hits
            wait = 60.0 - (now - hits[0]) + 0.05
        time.sleep(wait)


def room(host: str) -> int:
    """How many more requests `host` takes this minute before _throttle makes
    one wait -- for a caller with somewhere else to go (a mirror) instead."""
    limit = _HOST_LIMITS.get(host)
    if limit is None:
        return 1 << 30
    with _HITS_LOCK:
        now = time.monotonic()
        return limit - sum(1 for t in _HITS.get(host, []) if now - t < 60.0)


_DEADLINE_S = 150.0  # for a whole download, not the gap between two packets


def _download(url: str, **kw: Any) -> requests.Response:
    """GET with a limit on the whole transfer. requests' read timeout is per
    packet, so a server trickling bytes would otherwise hold a build forever
    (seen from DWD at a busy hour)."""
    r = _SESSION.get(url, timeout=_TIMEOUT, stream=True, **kw)
    deadline = time.monotonic() + _DEADLINE_S
    chunks = []
    try:
        for chunk in r.iter_content(1 << 16):
            chunks.append(chunk)
            if time.monotonic() > deadline:
                raise requests.Timeout(f"{urlsplit(url).netloc} took over {_DEADLINE_S:.0f} s")
    finally:
        r.close()
    r._content = b"".join(chunks)  # noqa: SLF001 - what .content would have read
    r._content_consumed = True  # noqa: SLF001
    return r


def _get(url: str, **kw: Any) -> Optional[requests.Response]:
    for attempt in range(3):
        _throttle(url)
        try:
            r = _download(url, **kw)
        except (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError):
            # The datamart and NOMADS drop a connection now and then in a burst
            # of requests; urllib3's retry does not cover a reset mid-response.
            if attempt == 2:
                raise
            time.sleep(0.8 * (attempt + 1))
            continue
        # 429 is the plain answer (ECMWF); NOMADS instead sends a 302 with no
        # Location header and a page titled "Over Rate Limit" as its body.
        if r.status_code == 429:
            raise RateLimited(f"{urlsplit(url).netloc} is refusing requests from this computer "
                              "for a while (too many in a short time)")
        if (r.status_code == 302 or r.history) and b"Rate Limit" in r.content[:600]:
            raise RateLimited(f"{urlsplit(url).netloc} is refusing requests from this computer "
                              "for a while (too many in a short time)")
        # An unfollowed redirect is no more data than an error is.
        return None if r.status_code >= 300 and r.status_code != 416 else r
    return None


_IDX_CACHE: dict[str, Optional[list[str]]] = {}
_WHOLE_CACHE: dict[str, bytes] = {}
_LOCK = threading.Lock()


def _idx_lines(url: str) -> Optional[list[str]]:
    with _LOCK:
        if url in _IDX_CACHE:
            return _IDX_CACHE[url]
    r = _get(url + ".idx")
    # "1:0:d=2026091112:PRMSL:..." -- anything else (an error page) is not cached.
    lines = r.text.splitlines() if r is not None and re.match(r"\d+(\.\d+)?:\d+:d=", r.text) else None
    if lines is not None:
        with _LOCK:
            _IDX_CACHE[url] = lines
            while len(_IDX_CACHE) > 256:
                _IDX_CACHE.pop(next(iter(_IDX_CACHE)))
    return lines


def _fetch_idx(url: str, match: str) -> Optional[tuple[bytes, int]]:
    """The message holding `match` ("VAR:LEVEL"), and which field of it that is:
    NCEP packs u and v into one message, listed as N.1 and N.2."""
    lines = _idx_lines(url)
    if not lines:
        return None
    for i, line in enumerate(lines):
        parts = line.split(":")
        if len(parts) < 5 or f"{parts[3]}:{parts[4]}" != match:
            continue
        nth = int(parts[0].split(".")[1]) if "." in parts[0] else 1
        start = int(parts[1])
        end = ""
        for nxt in lines[i + 1:]:
            p = nxt.split(":")
            if len(p) > 1 and p[1].isdigit() and int(p[1]) > start:
                end = str(int(p[1]) - 1)
                break
        r = _get(url, headers={"Range": f"bytes={start}-{end}"})
        return (r.content, nth) if r is not None and r.content[:4] == b"GRIB" else None
    return None


def _ecmwf_entries(url: str, match: dict) -> list[dict]:
    r = _get(url.removesuffix(".grib2") + ".index")
    if r is None:
        return []
    want = {k: str(v) for k, v in match.items() if k != "scale"}
    want.setdefault("levtype", "pl" if "levelist" in want else "sfc")
    out = []
    for line in r.text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if all(str(entry.get(k)) == v for k, v in want.items()):
            out.append(entry)
    return out


def _ecmwf_range(url: str, entry: dict) -> Optional[bytes]:
    off, length = int(entry["_offset"]), int(entry["_length"])
    g = _get(url, headers={"Range": f"bytes={off}-{off + length - 1}"})
    return g.content if g is not None and g.content[:4] == b"GRIB" else None


def _fetch_ecmwf(url: str, match: dict) -> Optional[bytes]:
    entries = _ecmwf_entries(url, match)
    return _ecmwf_range(url, entries[0]) if entries else None


def _ecmwf_mean(url: str, match: dict, world: bool) -> Optional[Field]:
    """The mean of every member's field. ECMWF's open data carry the 50
    perturbed members of the ensemble, but neither its control nor -- short of
    day 10 -- its mean."""
    entries = _ecmwf_entries(url, match)
    if len(entries) < 10:
        return None

    def member(entry: dict) -> Optional[Field]:
        raw = _ecmwf_range(url, entry)
        return _decode(raw, None, world) if raw else None

    base: Optional[Field] = None
    total: Optional[np.ndarray] = None
    n = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in pool.map(member, entries):
            if f is None:
                continue
            if total is None:
                base, total = f, f.values.astype(np.float64)
            else:
                total += f.values
            n += 1
    if base is None or n < len(entries) * 0.9:
        return None  # a step still being published: the mean of some members is not the mean
    base.values = (total / n).astype(np.float32)
    return base


def _fetch_direct(url: str, compressed: bool) -> Optional[bytes]:
    r = _get(url)
    if r is None or len(r.content) < 64:
        return None
    data = bz2.decompress(r.content) if compressed else r.content
    return data if data[:4] == b"GRIB" else None


def _fetch_whole(url: str) -> Optional[bytes]:
    with _LOCK:
        hit = _WHOLE_CACHE.get(url)
    if hit is not None:
        return hit
    r = _get(url)
    if r is None or r.content[:4] != b"GRIB" and b"GRIB" not in r.content[:4096]:
        return None
    with _LOCK:
        _WHOLE_CACHE[url] = r.content
        while len(_WHOLE_CACHE) > 3:
            _WHOLE_CACHE.pop(next(iter(_WHOLE_CACHE)))
    return r.content


# ==================================================================== decoding
# eccodes reads its definition files with a flex scanner that is not safe to
# run on two threads at once: a handle made for a template it has not seen yet
# parses definitions, and two of those together killed the whole backend with
# "fatal flex scanner internal error--end of buffer missed" once the analyses
# started decoding eight fields side by side. Making handles is quick; the
# downloads around it and the value decode after it stay parallel. Every module
# that makes eccodes handles in this process takes this one lock.
EC_HANDLE_LOCK = threading.RLock()


def _messages(content: bytes):
    """Yield eccodes handles for every GRIB message in `content` (edition 1 or 2)."""
    off = 0
    while True:
        off = content.find(b"GRIB", off)
        if off < 0 or off + 16 > len(content):
            return
        edition = content[off + 7]
        total = (int.from_bytes(content[off + 8:off + 16], "big") if edition == 2
                 else int.from_bytes(content[off + 4:off + 7], "big"))
        if total <= 16 or off + total > len(content):
            return
        with EC_HANDLE_LOCK:
            gid = ec.codes_new_from_message(content[off:off + total])
        try:
            yield gid
        finally:
            ec.codes_release(gid)
        off += total


def _matches(gid, select: dict) -> bool:
    for k, v in select.items():
        try:
            got = ec.codes_get(gid, k)
        except Exception:  # noqa: BLE001
            return False
        if str(got) != str(v):
            return False
    return True


_MULTI_LOCK = threading.Lock()


def _fields_in_message(content: bytes):
    """Every field of a message that packs several -- NCEP puts u and v in one.
    codes_new_from_message reads only the first, and eccodes walks the rest
    only from a file."""
    fd, path = tempfile.mkstemp(suffix=".grib2")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(content)
        # Multi-field reading is a library-wide switch with per-file state.
        with _MULTI_LOCK, open(path, "rb") as fh:
            ec.codes_grib_multi_support_on()
            try:
                while True:
                    with EC_HANDLE_LOCK:
                        gid = ec.codes_grib_new_from_file(fh)
                    if gid is None:
                        return
                    try:
                        yield gid
                    finally:
                        ec.codes_release(gid)
            finally:
                reset = getattr(ec, "codes_grib_multi_support_reset_file", None)
                if reset is not None:
                    reset(fh)
                ec.codes_grib_multi_support_off()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _to_field(gid, world: bool) -> Field:
    values = ec.codes_get_values(gid).astype(np.float32)
    try:
        units = str(ec.codes_get(gid, "units"))
    except Exception:  # noqa: BLE001 - not every template carries it
        units = ""
    if ec.codes_get(gid, "bitmapPresent"):
        values[values == ec.codes_get(gid, "missingValue")] = np.nan
    grid = ec.codes_get(gid, "gridType")
    if grid == "unstructured_grid":
        return Field(np.empty(0), np.empty(0), values, world, units=units)
    ni, nj = ec.codes_get(gid, "Ni"), ec.codes_get(gid, "Nj")
    values = values.reshape(nj, ni)
    if grid == "regular_ll":
        lat0 = ec.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lat1 = ec.codes_get(gid, "latitudeOfLastGridPointInDegrees")
        lon0 = ec.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        lon1 = ec.codes_get(gid, "longitudeOfLastGridPointInDegrees")
        lats = np.linspace(lat0, lat1, nj)
        lons = np.linspace(lon0, lon1 if lon1 > lon0 else lon1 + 360.0, ni)
        if not world:
            lons = ((lons + 180.0) % 360.0) - 180.0
            if np.any(np.diff(lons) < 0):  # a regional grid crossing +/-180
                lons = np.unwrap(np.radians(lons)) * 180 / np.pi
        return Field(lons, lats, values, world, units=units)
    lats = ec.codes_get_array(gid, "latitudes").reshape(nj, ni)
    lons = ec.codes_get_array(gid, "longitudes").reshape(nj, ni)
    lons = ((lons + 180.0) % 360.0) - 180.0
    try:
        relative = bool(ec.codes_get(gid, "uvRelativeToGrid"))
    except Exception:  # noqa: BLE001 - not every template carries the flag
        relative = False
    return Field(lons, lats, values, world, relative, units)


def _decode(content: bytes, select: Optional[dict], world: bool, nth: int = 1) -> Optional[Field]:
    """The first field matching `select`, or the `nth` field of a message."""
    handles = _messages(content) if nth == 1 else _fields_in_message(content)
    try:
        for i, gid in enumerate(handles, 1):
            if i < nth or (select and not _matches(gid, select)):
                continue
            return _to_field(gid, world)
    finally:
        handles.close()
    return None


def _laea_to_lonlat(x: np.ndarray, y: np.ndarray, lon0: float, lat0: float) -> tuple[np.ndarray, np.ndarray]:
    """Inverse spherical Lambert azimuthal equal-area (authalic radius). Off by
    a few km against the ellipsoid, which a 4 hPa isobar cannot show."""
    R = 6371007.2
    rho = np.hypot(x, y)
    c = 2 * np.arcsin(np.clip(rho / (2 * R), -1, 1))
    phi0, lam0 = math.radians(lat0), math.radians(lon0)
    with np.errstate(invalid="ignore", divide="ignore"):
        lat = np.arcsin(np.cos(c) * math.sin(phi0) + np.where(rho > 0, y * np.sin(c) * math.cos(phi0) / rho, 0))
        lon = lam0 + np.arctan2(x * np.sin(c), rho * math.cos(phi0) * np.cos(c) - y * math.sin(phi0) * np.sin(c))
    return np.degrees(lon), np.degrees(lat)


def _decode_netcdf(content: bytes, world: bool) -> Optional[Field]:
    import xarray as xr  # heavy, and only the Met Office needs it

    ds = xr.open_dataset(io.BytesIO(content), engine="h5netcdf")
    try:
        var = next(v for v in ds.data_vars.values() if v.ndim == 2)
        values = var.values.astype(np.float32)
        if "latitude" in var.dims:
            return Field(ds["longitude"].values.astype(float), ds["latitude"].values.astype(float), values, world)
        gm = ds[var.attrs["grid_mapping"]].attrs
        xs, ys = np.meshgrid(ds["projection_x_coordinate"].values, ds["projection_y_coordinate"].values)
        lons, lats = _laea_to_lonlat(xs, ys, float(gm["longitude_of_projection_origin"]),
                                     float(gm["latitude_of_projection_origin"]))
        return Field(lons, lats, values, world)
    finally:
        ds.close()


_CELLS: dict[str, tuple[np.ndarray, np.ndarray]] = {}


def _icon_cells(model_id: str, run: datetime) -> tuple[np.ndarray, np.ndarray]:
    """ICON's cell centres. The mesh never changes, so this is fetched once."""
    with _LOCK:
        hit = _CELLS.get(model_id)
    if hit is not None:
        return hit
    src = MODELS[model_id]["src"]
    out = []
    for key in ("lat", "lon"):
        raw = _fetch_direct(_fmt(src["cells"][key], run, 0), True)
        if raw is None:
            raise RuntimeError(f"ICON cell {key}itudes are not published for this run")
        f = _decode(raw, None, True)
        vals = f.values.astype(np.float64)
        out.append(np.degrees(vals) if np.nanmax(np.abs(vals)) <= math.pi + 0.01 else vals)
    with _LOCK:
        _CELLS[model_id] = (out[1], out[0])
    return out[1], out[0]


def _normalise(name: str, field: Field, spec: Any) -> Field:
    v = field.values
    scaled = isinstance(spec, dict) and "scale" in spec
    if scaled:
        v = v * float(spec["scale"])
    # Geopotential (m2 s-2) where a height is wanted: ICON publishes FI, ECCC
    # Geopotential, ECMWF z. Asked of the file rather than guessed from the
    # magnitude -- 1000 hPa geopotential is small enough to pass for a height,
    # which had ICON's thickness out by 400 dam.
    if not scaled and name in ("z500", "z1000", "orog") and "m**2" in (field.units or "").replace(" ", ""):
        v = v / 9.80665
    finite = v[np.isfinite(v)]
    top = float(np.max(np.abs(finite))) if finite.size else 0.0
    if name == "mslp" and top > 2000:
        v = v / 100.0  # Pa -> hPa
    elif name in ("t850", "td850") and top < 150:
        v = v + 273.15  # degC -> K
    elif name == "rh850" and top <= 1.5:
        v = v * 100.0  # fraction -> %
    elif name in ("z500", "z1000") and top > 20000 and not field.units:
        v = v / 9.80665  # geopotential, from a file that names no units
    elif name == "q850" and top > 0.2:
        v = v / 1000.0  # g/kg -> kg/kg
    field.values = v.astype(np.float32)
    return field


_FIELD_CACHE: dict[tuple[str, str, int, str], Field] = {}


def _fetch_one(model_id: str, name: str, run: datetime, hour: int) -> Optional[Field]:
    m = MODELS[model_id]
    src = m["src"]
    spec = src["fields"][name]
    kind = src["kind"]
    world = bool(m["world"])
    if kind == "idx":
        url, match = spec if isinstance(spec, tuple) else (src["url"], spec)
        got = _fetch_idx(_fmt(url, run, hour), match)
        field = _decode(got[0], None, world, nth=got[1]) if got else None
    elif kind == "ecmwf":
        url = _fmt(src["url"], run, hour)
        if src.get("mean"):
            field = _ecmwf_mean(url, spec, world)
        else:
            raw = _fetch_ecmwf(url, spec)
            field = _decode(raw, None, world) if raw else None
    elif kind == "direct":
        raw = _fetch_direct(_fmt(spec, run, hour), bool(src.get("bz2")))
        field = _decode(raw, None, world) if raw else None
        if field is not None and field.scattered:
            field.lons, field.lats = _icon_cells(model_id, run)
    elif kind == "whole":
        raw = _fetch_whole(_fmt(src["url"], run, hour))
        field = _decode(raw, spec, world) if raw else None
    elif kind == "netcdf":
        r = _get(_fmt(spec, run, hour))
        field = _decode_netcdf(r.content, world) if r is not None and r.content[:4] == b"\x89HDF" else None
    else:
        raise ValueError(f"unknown source kind {kind}")
    return _normalise(name, field, spec) if field is not None else None


def has_idx(url: str) -> bool:
    """Whether a GRIB2 file is published yet, asked of its small .idx sidecar."""
    return _idx_lines(url) is not None


def values_at(url: str, match: str) -> Optional[np.ndarray]:
    """Only the numbers of one field, shaped (Nj, Ni) in the file's own order.

    For a caller that already holds the grid's coordinates: working out the
    latitude and longitude of two million points is most of the cost of a full
    decode, and they are the same every hour.
    """
    got = _fetch_idx(url, match)
    if got is None:
        return None
    raw, nth = got
    handles = _messages(raw) if nth == 1 else _fields_in_message(raw)
    try:
        for i, gid in enumerate(handles, 1):
            if i < nth:
                continue
            values = ec.codes_get_values(gid).astype(np.float32)
            if ec.codes_get(gid, "bitmapPresent"):
                values[values == ec.codes_get(gid, "missingValue")] = np.nan
            ni, nj = int(ec.codes_get(gid, "Ni")), int(ec.codes_get(gid, "Nj"))
            return values.reshape(nj, ni)
    finally:
        handles.close()
    return None


def fetch_at(url: str, match: str, *, world: bool = False) -> Optional[Field]:
    """One field out of a GRIB2 file addressed by its .idx sidecar.

    For callers that hold their own URLs rather than a catalogue entry -- the
    hourly analyses in observations.py -- so the byte-range reading, the
    multi-field decode and the rate-limit handling are not written twice.
    """
    got = _fetch_idx(url, match)
    if got is None:
        return None
    return _decode(got[0], None, world, nth=got[1])


def fetch_field(model_id: str, name: str, hour: int, run: Optional[datetime] = None) -> tuple[Field, datetime]:
    """One field for one hour: from `run`, or from the newest run that has it."""
    if model_id not in MODELS:
        raise ValueError(f"Unknown model: {model_id}")
    if name not in fields_of(model_id):
        raise ValueError(f"{MODELS[model_id]['label']} does not publish {name}")
    runs = [run] if run is not None else candidate_runs(model_id)
    # Terrain does not change with lead time, and several centres publish it
    # only with the first hour (ECMWF, ECCC, the Met Office) -- so it is read
    # from there first, once per run, rather than again for every hour.
    first = MODELS[model_id].get("first_hour", 0)
    hours = [first, hour] if name == "orog" and hour != first else [hour]
    last: Optional[Exception] = None
    for r in runs:
        for h in hours:
            key = (model_id, r.strftime("%Y%m%d%H"), h, name)
            with _LOCK:
                hit = _FIELD_CACHE.get(key)
            if hit is not None:
                return hit, r
            try:
                field = _fetch_one(model_id, name, r, h)
            except RateLimited:
                raise
            except Exception as exc:  # noqa: BLE001 - try the previous run
                last = exc
                continue
            if field is None:
                continue
            with _LOCK:
                _FIELD_CACHE[key] = field
                while len(_FIELD_CACHE) > 40:
                    _FIELD_CACHE.pop(next(iter(_FIELD_CACHE)))
            return field, r
    label = MODELS[model_id]["label"]
    where = f"the {run:%d %HZ} run" if run is not None else "any recent run"
    raise RuntimeError(f"{label} f{hour:03d}: {name} is not in {where}" + (f" ({last})" if last else ""))


# ================================================================== regridding
_REGRID: dict[tuple, tuple[np.ndarray, np.ndarray, np.ndarray]] = {}


def _xyz(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    lo, la = np.radians(lon), np.radians(lat)
    return np.column_stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])


def regular(field: Field, step: float, cache_key: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(lats descending, lons ascending, values) on a regular grid of `step`
    degrees -- the whole globe (lons 0..360) for a world field, the field's own
    box otherwise. NaN where the source has no data."""
    if field.world:
        lats = np.arange(90.0, -90.0 - 1e-9, -step)
        lons = np.arange(0.0, 360.0 - 1e-9, step)
    else:
        lon = field.lons if field.lons.size else np.array([0.0])
        lo_min, lo_max = float(np.nanmin(lon)), float(np.nanmax(lon))
        la_min, la_max = float(np.nanmin(field.lats)), float(np.nanmax(field.lats))
        lats = np.arange(math.floor(la_max / step) * step, la_min - 1e-9, -step)
        lons = np.arange(math.ceil(lo_min / step) * step, lo_max + 1e-9, step)
    glon, glat = np.meshgrid(lons, lats)

    if field.regular:
        src_lats, src_lons = field.lats, field.lons
        dlat = src_lats[1] - src_lats[0]
        dlon = src_lons[1] - src_lons[0]
        jj = (glat - src_lats[0]) / dlat
        if field.world:
            ii = ((glon - src_lons[0]) % 360.0) / dlon
            out = map_coordinates(field.values, [jj, ii], order=1, mode="grid-wrap")
        else:
            ii = (glon - src_lons[0]) / dlon
            out = map_coordinates(field.values, [jj, ii], order=1, mode="constant", cval=np.nan)
        return lats, lons, out.astype(np.float32)

    key = (cache_key, field.values.shape, step, lats.size, lons.size)
    with _LOCK:
        hit = _REGRID.get(key)
    if hit is None:
        src_lon = field.lons.ravel()
        src_lat = field.lats.ravel()
        stride = 1
        if field.values.ndim == 2:
            # A 3 km grid onto half a degree: keep every nth point, plenty for
            # interpolation and ~100x cheaper to index.
            spacing = abs(float(np.nanmedian(np.diff(field.lats[:, field.lats.shape[1] // 2]))))
            stride = max(1, int(step / 3 / max(spacing, 1e-3)))
        idx_src = np.arange(src_lon.size).reshape(field.values.shape)[::stride, ::stride].ravel() \
            if field.values.ndim == 2 else np.arange(src_lon.size)
        tree = cKDTree(_xyz(src_lon[idx_src], src_lat[idx_src]))
        dist, nn = tree.query(_xyz(glon.ravel(), glat.ravel()), k=4)
        spacing_rad = math.radians(step) * 1.5
        weights = 1.0 / np.maximum(dist, 1e-9)
        weights /= weights.sum(axis=1, keepdims=True)
        mask = dist[:, 0] > spacing_rad
        hit = (idx_src[nn], weights.astype(np.float32), mask)
        with _LOCK:
            _REGRID[key] = hit
            while len(_REGRID) > 12:
                _REGRID.pop(next(iter(_REGRID)))
    nn, weights, mask = hit
    flat = field.values.ravel()
    out = (flat[nn] * weights).sum(axis=1)
    out[mask] = np.nan
    return lats, lons, out.reshape(glat.shape).astype(np.float32)
