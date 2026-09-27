"""
The satellite catalogue: satellites, their regions, the products of each region,
and which reader draws each one.

Laid out the way WeatherWise lays its satellites out -- USA (GOES-East,
GOES-West), JPSS (NOAA-20, NOAA-21), Asia Pacific (Himawari-9), Europe & Africa
(Meteosat-12, Meteosat-9, Meteosat-11), Metop (Metop-B, Metop-C) -- each with
its sectors and the parts of the full disk worth a region of their own.

Every product has one reader (see sat_*.py), picked for what it costs to show:

  slider   RAMMB/CIRA SLIDER tile pyramids: the bands and the RGBs it makes, for
           GOES, Himawari and Meteosat -- the fewest bytes per picture.
  abi      GOES files (Google Cloud's copy of NOAA's buckets, AWS behind it),
           drawn here: the RGBs SLIDER does not make, and every Level 2
           product (cloud height, fire, CAPE, TPW...).
  ahi      Himawari files on AWS: the Japan and target sectors, and the RGBs
           SLIDER does not make.
  wms      EUMETSAT EUMETView (Meteosat rapid scan, Metop, the fresher
           Meteosat-12 RGBs) and NASA GIBS (NOAA-20 / NOAA-21 VIIRS), both
           already Web Mercator.

A picture is asked for as a box of the map and a size; what comes back is a
Web Mercator WebP the map lays over that box. Pictures are kept on disk.
"""
from __future__ import annotations

import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

import numpy as np

import sat_geo as geo
import sat_net as net
import sat_recipes as rx

# ---------------------------------------------------------------------------
# Catalogue types
# ---------------------------------------------------------------------------


@dataclass
class Product:
    id: str
    label: str
    group: str                      # VISIBLE, NEAR_IR, IR, RGB_*, L2_*, ...
    note: str
    engine: str                     # slider, abi, abi_l2, ahi, wms
    params: dict = field(default_factory=dict)
    legend: Optional[dict] = None
    lossless: bool = False
    source: str = ""


@dataclass
class Region:
    id: str
    label: str
    bounds: Optional[tuple[float, float, float, float]]   # west, south, east, north; None: ask
    cadence_s: int
    products: list[Product]
    kind: str = "region"            # sector, region, disk, global
    note: str = ""


@dataclass
class Satellite:
    id: str
    label: str
    group: str
    detail: str
    regions: list[Region]
    note: str = ""


GROUP_LABELS = {
    "VISIBLE": "Visible", "NEAR_IR": "Near Infrared", "IR": "Infrared", "I-BAND": "VIIRS Imagery Bands",
    "AVHRR": "AVHRR Channels", "ASCAT": "ASCAT Winds",
    "RGB_DAY": "RGB · Day", "RGB_ALL": "RGB · Day & Night", "RGB_NIGHT": "RGB · Night",
    "RGB_SPECIALTY": "RGB · Specialty",
    "L2_CLOUD": "Clouds", "L2_FIRE": "Fire", "L2_STABILITY": "Stability", "L2_MOISTURE": "Moisture",
    "L2_AEROSOL": "Aerosols", "L2_SURFACE": "Land Surface",
}
GROUP_ORDER = list(GROUP_LABELS)

# ---------------------------------------------------------------------------
# GOES
# ---------------------------------------------------------------------------
ABI_BANDS = [
    (1, "Blue (Band 1)", "VISIBLE", "0.47 um: haze, smoke and dust over land and sea. Daytime only."),
    (2, "Red (Band 2)", "VISIBLE", "0.64 um at 500 m, the finest the imager has: cloud texture, updrafts, outflow. Daytime only."),
    (3, "Veggie (Band 3)", "VISIBLE", "0.86 um: vegetation bright, water black -- burn scars, flooding, land-sea edges. Daytime only."),
    (4, "Cirrus (Band 4)", "NEAR_IR", "1.37 um: thin high cirrus alone; the air below it is hidden. Daytime only."),
    (5, "Snow/Ice (Band 5)", "NEAR_IR", "1.6 um: ice cloud and snow dark, water cloud bright. Daytime only."),
    (6, "Cloud Particle Size (Band 6)", "NEAR_IR", "2.2 um: small droplets bright, large droplets and ice dark; hot fires. Daytime only."),
    (7, "Shortwave Window (Band 7)", "IR", "3.9 um: fog and low cloud at night, fire hot spots day and night."),
    (8, "Upper-level Tropospheric Water Vapor (Band 8)", "IR", "6.2 um: moisture above ~400 hPa -- jets, troughs, dry slots."),
    (9, "Mid-level Tropospheric Water Vapor (Band 9)", "IR", "6.9 um: moisture through the middle troposphere."),
    (10, "Lower-level Tropospheric Water Vapor (Band 10)", "IR", "7.3 um: the lowest level water vapour reaches; SO2 plumes."),
    (11, "Cloud-Top Phase (Band 11)", "IR", "8.4 um: ice and water cloud separate; dust and SO2."),
    (12, "Ozone (Band 12)", "IR", "9.6 um: total ozone, which traces the tropopause and jet dynamics."),
    (13, "Clean Infrared Longwave Window (Band 13)", "IR", "10.3 um: cloud-top temperature with the least water vapour in the way."),
    (14, "Infrared Longwave Window (Band 14)", "IR", "11.2 um: the classic infrared window."),
    (15, "Dirty Infrared Longwave Window (Band 15)", "IR", "12.3 um: window band with water vapour absorption -- low-level moisture, dust, ash."),
    (16, "CO2 Longwave Infrared (Band 16)", "IR", "13.3 um: cloud heights from CO2 absorption; air-mass temperature."),
]

# WeatherWise RGB id -> the SLIDER product that is that RGB, per satellite
# family. Only exact matches: SLIDER's "tropical airmass" id is its Overshooting
# Tops RGB, and its "Day Fire" is not the Day Land Cloud Fire recipe -- those
# are drawn here from the bands instead.
SLIDER_RGB_ABI = {
    "natural_color": "natural_color",
    "day_cloud_phase_distinction": "jma_day_cloud_phase_distinction_rgb",
    "day_cloud_type": "day_cloud_type_rgb",
    "day_snow_fog": "day_snow_fog",
    "day_convection": "eumetsat_severe_storms_rgb",
    "geo_color": "geocolor",
    "air_mass": "rgb_air_mass",
    "dust": "awips_dust",
    "dust_cvd": "cvd_dust_rgb",
    "ash": "eumetsat_ash",
    "so2": "jma_so2",
    "fire_temperature": "fire_temperature",
    "nighttime_microphysics": "eumetsat_nighttime_microphysics",
    "blowing_snow": "blowing_snow_rgb",
}
SLIDER_RGB_AHI = {k: v for k, v in SLIDER_RGB_ABI.items() if k != "day_cloud_type"} | {"dust": "eumetsat_dust"}
# SLIDER's per-product zoom limit (levels short of the sector's deepest).
SLIDER_ZOOM_ADJUST = {
    "goes": {**{f"band_{b:02d}": 2 for b in range(1, 17)}, "band_01": 1, "band_02": 0, "band_03": 1, "band_05": 1,
             "geocolor": 1, "natural_color": 1, "jma_day_cloud_phase_distinction_rgb": 1, "day_cloud_type_rgb": 1,
             "day_snow_fog": 1, "blowing_snow_rgb": 1},
    "himawari": {**{f"band_{b:02d}": 2 for b in range(1, 17)}, "band_01": 1, "band_02": 1, "band_03": 0,
                 "band_04": 1, "geocolor": 1, "natural_color": 1, "jma_day_cloud_phase_distinction_rgb": 1,
                 "day_snow_fog": 1, "blowing_snow_rgb": 1},
    "meteosat-12": {**{f"band_{b:02d}": 1 for b in range(1, 9)}, **{f"band_{b:02d}": 2 for b in range(9, 17)},
                    "geocolor": 1, "natural_color": 1, "jma_day_cloud_phase_distinction_rgb": 1,
                    "day_cloud_type_rgb": 1, "day_snow_fog": 1, "fire_temperature": 1},
    "meteosat-9": {},
}
DEFAULT_ADJUST = 2


def _slider(sat_family: str, slider_sat: str, sector: str, product: str, layout: str) -> dict:
    return {"sat": slider_sat, "sector": sector, "product": product, "layout": layout,
            "zoom_adjust": SLIDER_ZOOM_ADJUST.get(sat_family, {}).get(product, DEFAULT_ADJUST)}


def _recipe_product(rid: str, engine: str, params: dict, source: str) -> Product:
    r = rx.RECIPES[rid]
    return Product(rid, r.label, r.group, r.note, engine, params, source=source)


# RGBs drawn here from SLIDER's band tiles read back as temperatures and
# reflectances (sat_slider.values): each role's SLIDER band per imager family.
SLV_BANDS: dict[str, dict[str, int]] = {
    "goes": {r: b for b, r in rx.ABI_ROLES.items()},
    "himawari": {r: b for b, r in rx.AHI_ROLES.items()},
    # FCI has no 11.2 um band; its 10.5 um stands in, as EUMETSAT's recipes do.
    "meteosat-12": {"b047": 1, "g051": 2, "r064": 3, "n086": 4, "c137": 6, "s161": 7, "p224": 8, "i039": 9,
                    "w062": 10, "w073": 11, "i086": 12, "i096": 13, "i103": 14, "i112": 14, "i123": 15, "i133": 16},
    "meteosat-9": {"r064": 1, "n086": 2, "s161": 3, "i039": 4, "w062": 5, "w073": 6, "i086": 7, "i096": 8,
                   "i103": 9, "i112": 9, "i123": 10, "i133": 11},
}


def slv_kind(role: str) -> str:
    if role == "r064":
        return "red"
    if role in rx.REFLECTIVE:
        return "vis"
    if role == "i039":
        return "swir"
    if role in ("w062", "w069", "w073"):
        return "wv"
    return "ir"


def slv_roles(family: str, rid: str) -> Optional[tuple[str, ...]]:
    return rx.recipe_roles(rid, set(SLV_BANDS[family]))


def _slv(family: str, slider_sat: str, layout: str) -> dict:
    return {"family": family, "sat": slider_sat, "sector": "full_disk", "layout": layout}


def _goes_products(sat: str, slider_sat: str, sector: str, slider_sector: str, layout: str,
                   with_l2: bool, full_disk: bool) -> list[Product]:
    out: list[Product] = []
    for b, label, group, note in ABI_BANDS:
        out.append(Product(f"c{b:02d}", label, group, note, "slider",
                           _slider("goes", slider_sat, slider_sector, f"band_{b:02d}", layout), source="CIRA SLIDER"))
    for rid in rx.RGB_ORDER:
        if full_disk and rid != "geo_color":
            continue
        if rid in SLIDER_RGB_ABI:
            out.append(_recipe_product(rid, "slider", _slider("goes", slider_sat, slider_sector, SLIDER_RGB_ABI[rid], layout),
                                       "CIRA SLIDER"))
        elif sector == "fd":
            # Across a full-disk region the scan's strips are the whole disk
            # wide; SLIDER's pyramid gives the same bands for a fraction of it.
            out.append(_recipe_product(rid, "slv", _slv("goes", slider_sat, layout), "Drawn here from CIRA SLIDER bands"))
        else:
            out.append(_recipe_product(rid, "abi", {"sat": sat, "sector": sector}, "NOAA GOES on AWS"))
    if with_l2:
        for pid in rx.L2_ORDER:
            p = rx.L2_PRODUCTS[pid]
            group = ("L2_FIRE" if p.folder == "FDC" else "L2_STABILITY" if p.folder == "DSI"
                     else "L2_MOISTURE" if p.folder == "TPW" else "L2_AEROSOL" if p.folder in ("AOD", "ADP")
                     else "L2_SURFACE" if p.folder in ("LST", "LSA", "FSC") else "L2_CLOUD")
            out.append(Product(f"l2_{pid}", p.label, group, p.note, "abi_l2", {"sat": sat, "sector": sector, "pid": pid},
                               legend=rx.l2_legend(p), lossless=p.kind == "category", source="NOAA GOES-R Level 2 on AWS"))
    return out


def _goes(sid: str, awsid: str, slider_sat: str, label: str, detail: str,
          crops: list[tuple[str, str, tuple[float, float, float, float]]], disk: tuple) -> Satellite:
    regions = [
        Region("conus", "CONUS" if awsid == "goes19" else "PACUS (CONUS)", None, 300,
               _goes_products(awsid, slider_sat, "conus", "conus", "conus", True, False), kind="sector"),
        Region("meso1", "Mesoscale 1", None, 60,
               _goes_products(awsid, slider_sat, "meso1", "mesoscale_01", "meso1", True, False), kind="sector",
               note="A 1000 km box NOAA moves to where the weather is; a scan every minute."),
        Region("meso2", "Mesoscale 2", None, 60,
               _goes_products(awsid, slider_sat, "meso2", "mesoscale_02", "meso2", True, False), kind="sector",
               note="A 1000 km box NOAA moves to where the weather is; a scan every minute."),
    ]
    for rid, rlabel, box in crops:
        regions.append(Region(rid, rlabel, box, 600,
                              _goes_products(awsid, slider_sat, "fd", "full_disk", "fd", False, False)))
    regions.append(Region("fd", "Full Disk", disk, 600,
                          _goes_products(awsid, slider_sat, "fd", "full_disk", "fd", False, True), kind="disk"))
    return Satellite(sid, label, "USA", detail, regions)


# ---------------------------------------------------------------------------
# Himawari
# ---------------------------------------------------------------------------
AHI_BANDS = [
    (1, "Blue (Band 1)", "VISIBLE", "0.47 um. Daytime only."),
    (2, "Blue-Green (Band 2)", "VISIBLE", "0.51 um: the green ABI lacks, so Himawari's true colour is real. Daytime only."),
    (3, "Red (Band 3)", "VISIBLE", "0.64 um at 500 m: cloud texture and updrafts. Daytime only."),
    (4, "Near-Infrared (Band 4)", "VISIBLE", "0.86 um: vegetation bright, water black. Daytime only."),
    (5, "Snow/Cloud NIR (Band 5)", "NEAR_IR", "1.6 um: ice cloud and snow dark, water cloud bright. Daytime only."),
    (6, "Cloud Particle Size (Band 6)", "NEAR_IR", "2.3 um: droplet size; hot fires. Daytime only."),
    (7, "Shortwave Window (Band 7)", "IR", "3.9 um: fog and low cloud at night, fire hot spots."),
    (8, "Upper-Level Water Vapor (Band 8)", "IR", "6.2 um: upper-level moisture and dry slots."),
    (9, "Mid-Level Water Vapor (Band 9)", "IR", "6.9 um: mid-level moisture."),
    (10, "Lower-Level Water Vapor (Band 10)", "IR", "7.3 um: lower-level moisture; SO2."),
    (11, "Cloud Phase / SO₂ (Band 11)", "IR", "8.6 um: cloud phase, SO2."),
    (12, "Ozone (Band 12)", "IR", "9.6 um: total ozone."),
    (13, "Clean IR Window (Band 13)", "IR", "10.4 um: cloud-top temperature."),
    (14, "IR Window (Band 14)", "IR", "11.2 um: the classic window."),
    (15, "Dirty IR Window (Band 15)", "IR", "12.4 um: low-level moisture, dust, ash."),
    (16, "CO₂ Longwave IR (Band 16)", "IR", "13.3 um: cloud heights."),
]
AHI_RGBS = [r for r in rx.RGB_ORDER if r != "day_cloud_type"]


def _ahi_products(region: str, full_disk: bool, slider_sector: Optional[str], layout: str = "him_fd") -> list[Product]:
    out: list[Product] = []
    for b, label, group, note in AHI_BANDS:
        if slider_sector:
            out.append(Product(f"b{b:02d}", label, group, note, "slider",
                               _slider("himawari", "himawari", slider_sector, f"band_{b:02d}", layout),
                               source="CIRA SLIDER"))
        else:
            out.append(Product(f"b{b:02d}", label, group, note, "ahi", {"region": region, "band": b},
                               source="JMA Himawari-9 via NOAA on AWS"))
    for rid in AHI_RGBS:
        if full_disk and rid != "geo_color":
            continue
        if slider_sector and rid in SLIDER_RGB_AHI:
            out.append(_recipe_product(rid, "slider",
                                       _slider("himawari", "himawari", slider_sector, SLIDER_RGB_AHI[rid], layout),
                                       "CIRA SLIDER"))
        elif slider_sector:
            params = _slv("himawari", "himawari", layout)
            params["sector"] = slider_sector
            out.append(_recipe_product(rid, "slv", params, "Drawn here from CIRA SLIDER bands"))
        else:
            out.append(_recipe_product(rid, "ahi", {"region": region}, "JMA Himawari-9 via NOAA on AWS"))
    return out


# ---------------------------------------------------------------------------
# Meteosat
# ---------------------------------------------------------------------------
FCI_BANDS = [
    (1, "Blue (0.44 µm)", "VISIBLE"), (2, "Green (0.51 µm)", "VISIBLE"), (3, "Red (0.64 µm)", "VISIBLE"),
    (4, "NIR (0.86 µm)", "VISIBLE"), (5, "NIR (0.91 µm)", "VISIBLE"), (6, "Cirrus (1.38 µm)", "NEAR_IR"),
    (7, "Snow/Ice (1.61 µm)", "NEAR_IR"), (8, "Cloud Particle (2.25 µm)", "NEAR_IR"),
    (9, "Shortwave Window (3.8 µm)", "IR"), (10, "Upper-level Water Vapour (6.3 µm)", "IR"),
    (11, "Lower-level Water Vapour (7.35 µm)", "IR"), (12, "Cloud-top Phase (8.7 µm)", "IR"),
    (13, "Ozone (9.7 µm)", "IR"), (14, "Clean IR Window (10.5 µm)", "IR"),
    (15, "Dirty IR Window (12.3 µm)", "IR"), (16, "CO₂ Longwave (13.3 µm)", "IR"),
]
# EUMETView's MTG layers: fresher than SLIDER's (about 30 minutes behind, not 70).
EV_MTG = {"c03": "mtg_fd:vis06_hrfi", "c14": "mtg_fd:ir105_hrfi", "true_color": "mtg_fd:rgb_truecolour",
          "cloud_phase_eumetsat": "mtg_fd:rgb_cloudphase", "day_cloud_type": "mtg_fd:rgb_cloudtype",
          "dust": "mtg_fd:rgb_dust", "fire_temperature": "mtg_fd:rgb_firetemperature",
          "fog_low_stratus": "mtg_fd:rgb_fog", "geo_color": "mtg_fd:rgb_geocolour"}
SLIDER_RGB_MTG = {"natural_color": "natural_color", "day_cloud_phase_distinction": "jma_day_cloud_phase_distinction_rgb",
                  "day_snow_fog": "day_snow_fog", "day_convection": "eumetsat_severe_storms_rgb",
                  "geo_color": "geocolor", "air_mass": "rgb_air_mass", "dust_cvd": "cvd_dust_rgb", "ash": "eumetsat_ash",
                  "nighttime_microphysics": "eumetsat_nighttime_microphysics", "blowing_snow": "blowing_snow_rgb"}
MTG_RGBS = [r for r in rx.RGB_ORDER if r not in ("so2", "precipitating_clouds")]

SEVIRI_BANDS = [
    ("vis006", 1, "Visible 0.6 µm", "VISIBLE"), ("vis008", 2, "Visible 0.8 µm", "VISIBLE"),
    ("ir016", 3, "Snow/Ice 1.6 µm", "NEAR_IR"), ("ir039", 4, "Shortwave IR 3.9 µm", "IR"),
    ("wv062", 5, "Upper-level Water Vapour 6.2 µm", "IR"), ("wv073", 6, "Lower-level Water Vapour 7.3 µm", "IR"),
    ("ir087", 7, "Cloud-top Phase 8.7 µm", "IR"), ("ir097", 8, "Ozone 9.7 µm", "IR"),
    ("ir108", 9, "IR Window 10.8 µm", "IR"), ("ir120", 10, "Dirty IR Window 12.0 µm", "IR"),
    ("ir134", 11, "CO₂ Longwave 13.4 µm", "IR"),
]
EV_IODC = {"vis006": "msg_iodc:vis006", "ir039": "msg_iodc:ir039", "wv062": "msg_iodc:wv062", "ir108": "msg_iodc:ir108",
           "natural_color": "msg_iodc:rgb_natural", "day_convection": "msg_iodc:rgb_convection",
           "day_microphysics": "msg_iodc:rgb_microphysics", "air_mass": "msg_iodc:rgb_airmass",
           "tropical_airmass": "msg_iodc:rgb_tropicalairmass", "dust": "msg_iodc:rgb_dust", "ash": "msg_iodc:rgb_ash",
           "fog_low_stratus": "msg_iodc:rgb_fog"}
SLIDER_RGB_MSG = {"day_cloud_phase_distinction": "jma_day_cloud_phase_distinction_rgb", "dust_cvd": "cvd_dust_rgb",
                  "nighttime_microphysics": "eumetsat_nighttime_microphysics", "blowing_snow": "blowing_snow_rgb",
                  "geo_color": "geocolor"}
# The SEVIRI RGBs, as WeatherWise lists them for Meteosat-9 (plus GeoColor).
MSG_RGBS = {"natural_color", "day_cloud_phase_distinction", "day_snow_fog", "day_convection", "day_microphysics",
            "sandwich", "overview", "geo_color", "air_mass", "tropical_airmass", "dust", "dust_cvd", "ash",
            "microphysics_24hr", "simple_water_vapor", "differential_water_vapor", "nighttime_microphysics",
            "fog_low_stratus", "blowing_snow", "rocket_plume"}
EV_RSS = {"ir039": "msg_rss:ir039_nrt", "natural_color": "msg_rss:rgb_natural_nrt",
          "natural_color_enhanced": "msg_rss:rgb_naturalenhncd_nrt", "day_microphysics": "msg_rss:rgb_microphysics_nrt"}


def _ev(layer: str, **extra) -> dict:
    return {"service": "eumetview", "layer": layer, **extra}


def _mtg_products(full_disk: bool) -> list[Product]:
    out: list[Product] = []
    for b, label, group in FCI_BANDS:
        pid = f"c{b:02d}"
        note = "Flexible Combined Imager channel."
        if pid in EV_MTG:
            out.append(Product(pid, label, group, note, "wms", _ev(EV_MTG[pid]), source="EUMETSAT EUMETView"))
        else:
            out.append(Product(pid, label, group, note, "slider",
                               _slider("meteosat-12", "meteosat-12", "full_disk", f"band_{b:02d}", "mtg_fd"),
                               source="CIRA SLIDER"))
    for rid in MTG_RGBS:
        if full_disk and rid != "geo_color":
            continue
        if rid in EV_MTG:
            out.append(_recipe_product(rid, "wms", _ev(EV_MTG[rid]), "EUMETSAT EUMETView"))
        elif rid in SLIDER_RGB_MTG:
            out.append(_recipe_product(rid, "slider",
                                       _slider("meteosat-12", "meteosat-12", "full_disk", SLIDER_RGB_MTG[rid], "mtg_fd"),
                                       "CIRA SLIDER"))
        elif slv_roles("meteosat-12", rid):
            out.append(_recipe_product(rid, "slv", _slv("meteosat-12", "meteosat-12", "mtg_fd"),
                                       "Drawn here from CIRA SLIDER bands"))
    return out


def _iodc_products(full_disk: bool) -> list[Product]:
    out: list[Product] = []
    for key, b, label, group in SEVIRI_BANDS:
        if key in EV_IODC:
            out.append(Product(key, label, group, "SEVIRI channel, every 15 minutes.", "wms", _ev(EV_IODC[key]),
                               source="EUMETSAT EUMETView"))
        else:
            out.append(Product(key, label, group, "SEVIRI channel, hourly (the 15-minute scans of this channel are "
                               "not published openly).", "slider",
                               _slider("meteosat-9", "meteosat-9", "full_disk", f"band_{b:02d}", "msg_iodc"),
                               source="CIRA SLIDER"))
    rgbs = ["air_mass", "dust"] if full_disk else [r for r in rx.RGB_ORDER if r in MSG_RGBS]
    for rid in rgbs:
        if rid in EV_IODC:
            out.append(_recipe_product(rid, "wms", _ev(EV_IODC[rid]), "EUMETSAT EUMETView"))
        elif rid in SLIDER_RGB_MSG:
            out.append(_recipe_product(rid, "slider",
                                       _slider("meteosat-9", "meteosat-9", "full_disk", SLIDER_RGB_MSG[rid], "msg_iodc"),
                                       "CIRA SLIDER"))
        elif slv_roles("meteosat-9", rid):
            p = _recipe_product(rid, "slv", _slv("meteosat-9", "meteosat-9", "msg_iodc"),
                                "Drawn here from CIRA SLIDER bands")
            p.note += " Hourly: made from the channels published once an hour."
            out.append(p)
    return out


def _rss_products() -> list[Product]:
    return [
        Product("ir039", "Shortwave IR 3.9 µm", "IR", "SEVIRI rapid scan, every 5 minutes.", "wms",
                _ev(EV_RSS["ir039"]), source="EUMETSAT EUMETView"),
        _recipe_product("natural_color", "wms", _ev(EV_RSS["natural_color"]), "EUMETSAT EUMETView"),
        Product("natural_color_enhanced", "Natural Color (Enhanced)", "RGB_DAY",
                "EUMETSAT's natural colour with more contrast. Daytime only.", "wms",
                _ev(EV_RSS["natural_color_enhanced"]), source="EUMETSAT EUMETView"),
        _recipe_product("day_microphysics", "wms", _ev(EV_RSS["day_microphysics"]), "EUMETSAT EUMETView"),
    ]


# ---------------------------------------------------------------------------
# Polar orbiters
# ---------------------------------------------------------------------------
def _gibs(layer: str, **extra) -> dict:
    return {"service": "gibs", "layer": layer, **extra}


def _viirs_products(sat: str) -> list[Product]:
    n = sat.upper()
    return [
        Product("i1", "Visible (I1)", "I-BAND", "0.64 um at 375 m, from the day's passes (the I1 channel of NASA's "
                "corrected-reflectance composite). Daytime only.", "wms",
                _gibs(f"VIIRS_{n}_CorrectedReflectance_BandsM11-I2-I1", channel=2, daily=True), source="NASA GIBS"),
        Product("i2", "NIR (I2)", "I-BAND", "0.86 um at 375 m: vegetation bright, water black. Daytime only.", "wms",
                _gibs(f"VIIRS_{n}_CorrectedReflectance_BandsM11-I2-I1", channel=1, daily=True), source="NASA GIBS"),
        Product("i3", "SWIR (I3)", "I-BAND", "1.61 um at 375 m: snow and ice dark, water cloud bright. Daytime only.",
                "wms", _gibs(f"VIIRS_{n}_CorrectedReflectance_BandsM3-I3-M11", channel=1, daily=True),
                source="NASA GIBS"),
        Product("i5_day", "Thermal IR (I5) · day passes", "I-BAND", "11.45 um brightness temperature at 375 m.",
                "wms", _gibs(f"VIIRS_{n}_Brightness_Temp_BandI5_Day", daily=True, png=True), source="NASA GIBS"),
        Product("i5_night", "Thermal IR (I5) · night passes", "I-BAND", "11.45 um brightness temperature at 375 m.",
                "wms", _gibs(f"VIIRS_{n}_Brightness_Temp_BandI5_Night", daily=True, png=True), source="NASA GIBS"),
    ]


def _metop_products(m: str) -> list[Product]:
    return [
        Product("ch1", "Visible (Channel 1)", "AVHRR", "0.63 um, the last six orbits laid together (the red channel of "
                "EUMETSAT's AVHRR cloud RGB). Daytime only.", "wms", _ev(f"eps:{m}_rgb_124", channel=0),
                source="EUMETSAT EUMETView"),
        Product("ch2", "Near-Infrared (Channel 2)", "AVHRR", "0.86 um, the last six orbits (the green channel of "
                "EUMETSAT's AVHRR cloud RGB). Daytime only.", "wms", _ev(f"eps:{m}_rgb_124", channel=1),
                source="EUMETSAT EUMETView"),
        Product("ch3a", "Snow/Ice (Channel 3A)", "AVHRR", "1.6 um, daylit passes of the last six orbits (the red "
                "channel of EUMETSAT's natural colour RGB, which only daylight carries).", "wms",
                _ev(f"eps:{m}_rgb_natural_fog", channel=0, day_only=True), source="EUMETSAT EUMETView"),
        Product("ch4", "Thermal Infrared (Channel 4)", "AVHRR", "10.8 um, the last six orbits.", "wms",
                _ev(f"eps:{m}_ir108"), source="EUMETSAT EUMETView"),
        Product("natural_fog", "Natural Colour + Fog", "RGB_ALL", "EUMETSAT's AVHRR natural colour by day and the fog "
                "RGB by night, six orbits.", "wms", _ev(f"eps:{m}_rgb_natural_fog"), source="EUMETSAT EUMETView"),
        Product("ascat", "ASCAT Wind Speed (12.5 km coastal)", "ASCAT", "Ocean surface wind from the scatterometer, "
                "both swaths, on the 12.5 km coastal grid.", "wms", _ev(f"eps:{m}_ascat_wind"),
                source="EUMETSAT EUMETView (OSI SAF)"),
    ]


GLOBAL = (-180.0, -80.0, 180.0, 80.0)


def _build() -> list[Satellite]:
    sats = [
        _goes("goes19", "goes19", "goes-19", "GOES-East", "GOES-19 · 75.2°W",
              [("fd_mdr", "Main Development Region", (-85.0, 3.0, -15.0, 30.0)),
               ("fd_ca", "Central America", (-118.0, 3.0, -58.0, 33.0)),
               ("fd_sa", "South America", (-92.0, -57.0, -30.0, 14.0))],
              (-156.0, -80.0, 6.0, 80.0)),
        _goes("goes18", "goes18", "goes-18", "GOES-West", "GOES-18 · 137.0°W",
              [("fd_npo", "North Pacific Ocean", (-215.0, 8.0, -110.0, 62.0)),
               ("fd_spo", "South Pacific Ocean", (-215.0, -58.0, -95.0, 5.0))],
              (-218.0, -80.0, -56.0, 80.0)),
        Satellite("noaa20", "NOAA-20", "JPSS", "JPSS-1 · VIIRS", [
            Region("global", "Global", GLOBAL, 86400, _viirs_products("noaa20"), kind="global",
                   note="A picture a day, laid together from that day's passes."),
        ]),
        Satellite("noaa21", "NOAA-21", "JPSS", "JPSS-2 · VIIRS", [
            Region("global", "Global", GLOBAL, 86400, _viirs_products("noaa21"), kind="global",
                   note="A picture a day, laid together from that day's passes."),
        ]),
        Satellite("himawari9", "Himawari-9", "Asia Pacific", "140.7°E", [
            Region("japan", "Japan", (118.0, 17.0, 157.0, 49.0), 150,
                   _ahi_products("japan", False, "japan", "him_japan"),
                   kind="sector", note="JMA's Japan area, every 2.5 minutes."),
            Region("target", "Target", None, 150, _ahi_products("target", False, "mesoscale_01", "him_target"),
                   kind="sector",
                   note="A 1000 km box JMA points at typhoons and other targets, every 2.5 minutes."),
            Region("fd_aus", "Australia", (108.0, -46.0, 160.0, -8.0), 600, _ahi_products("fd", False, "full_disk")),
            Region("fd_nzl", "New Zealand", (160.0, -50.0, 184.0, -30.0), 600, _ahi_products("fd", False, "full_disk")),
            Region("fd_seasia", "South East Asia", (90.0, -12.0, 135.0, 25.0), 600,
                   _ahi_products("fd", False, "full_disk")),
            Region("fd_chn", "China", (73.0, 16.0, 135.0, 54.0), 600, _ahi_products("fd", False, "full_disk")),
            Region("fd_oceania", "Oceania Islands", (140.0, -28.0, 205.0, 14.0), 600,
                   _ahi_products("fd", False, "full_disk")),
            Region("fd", "Full Disk", (59.7, -80.0, 221.7, 80.0), 600, _ahi_products("fd", True, "full_disk"),
                   kind="disk"),
        ]),
        Satellite("meteosat12", "Meteosat-12", "Europe & Africa", "MTG-I1 · 0°", [
            *[Region(rid, lab, box, 600, _mtg_products(False)) for rid, lab, box in [
                ("fd_eur", "Europe", (-25.0, 34.0, 45.0, 72.0)),
                ("fd_med", "Mediterranean", (-10.0, 29.0, 40.0, 47.0)),
                ("fd_wafr", "West Africa", (-20.0, 2.0, 15.0, 25.0)),
                ("fd_nafr", "North Africa", (-18.0, 15.0, 38.0, 38.0)),
                ("fd_cafr", "Central Africa", (8.0, -12.0, 35.0, 12.0)),
                ("fd_safr", "Southern Africa", (10.0, -36.0, 42.0, -8.0)),
                ("fd_atlmdr", "Tropical Atlantic", (-60.0, 5.0, -15.0, 25.0)),
                ("fd_sam", "South America", (-82.0, -57.0, -32.0, 13.0)),
            ]],
            Region("fd", "Full Disk", (-80.0, -80.0, 80.0, 80.0), 600, _mtg_products(True), kind="disk"),
        ]),
        Satellite("meteosat9", "Meteosat-9", "Europe & Africa", "Indian Ocean · 45.5°E", [
            *[Region(rid, lab, box, 900, _iodc_products(False)) for rid, lab, box in [
                ("fd_ind", "India", (66.0, 5.0, 98.0, 36.0)),
                ("fd_me", "Middle East", (30.0, 12.0, 63.0, 42.0)),
                ("fd_eafr", "East Africa", (22.0, -12.0, 52.0, 18.0)),
                ("fd_sio", "South Indian Ocean", (40.0, -45.0, 100.0, -5.0)),
                ("fd_casia", "Central Asia", (45.0, 35.0, 90.0, 55.0)),
            ]],
            Region("fd", "Full Disk", (-34.5, -80.0, 125.5, 80.0), 900, _iodc_products(True), kind="disk"),
        ]),
        Satellite("meteosat11", "Meteosat-11", "Europe & Africa", "Rapid Scan · 9.5°E", [
            *[Region(rid, lab, box, 300, _rss_products()) for rid, lab, box in [
                ("fd_eur", "Europe", (-25.0, 34.0, 45.0, 72.0)),
                ("fd_med", "Mediterranean", (-10.0, 29.0, 40.0, 47.0)),
                ("fd_nafr", "North Africa", (-18.0, 15.0, 38.0, 38.0)),
                ("fd_me", "Middle East", (30.0, 12.0, 63.0, 42.0)),
            ]],
            Region("fd", "Rapid Scan Area", (-45.0, 15.0, 65.0, 79.0), 300, _rss_products(), kind="disk"),
        ], note="EUMETSAT publishes openly only these four rapid-scan products; the other channels need an "
                "EUMETSAT Data Store account."),
        Satellite("metopb", "Metop-B", "Metop", "AVHRR · ASCAT", [
            Region("global", "Global", GLOBAL, 6000, _metop_products("m01"), kind="global",
                   note="Each picture lays the last six orbits together."),
        ]),
        Satellite("metopc", "Metop-C", "Metop", "AVHRR · ASCAT", [
            Region("global", "Global", GLOBAL, 6000, _metop_products("m03"), kind="global",
                   note="Each picture lays the last six orbits together."),
        ]),
    ]
    return sats


SATELLITES: list[Satellite] = _build()
_BY_ID = {s.id: s for s in SATELLITES}


def find(sat: str, region: str, product: str) -> tuple[Satellite, Region, Product]:
    s = _BY_ID.get(sat)
    if s is None:
        raise ValueError(f"Unknown satellite {sat}")
    r = next((x for x in s.regions if x.id == region), None)
    if r is None:
        raise ValueError(f"Unknown region {region}")
    p = next((x for x in r.products if x.id == product), None)
    if p is None:
        raise ValueError(f"Unknown product {product}")
    return s, r, p


def catalog() -> dict[str, Any]:
    groups: list[dict] = []
    for s in SATELLITES:
        g = next((x for x in groups if x["label"] == s.group), None)
        if g is None:
            g = {"label": s.group, "satellites": []}
            groups.append(g)
        g["satellites"].append(s.id)
    return {
        "groups": groups,
        "productGroups": [{"id": k, "label": v} for k, v in GROUP_LABELS.items()],
        "satellites": [
            {
                "id": s.id, "label": s.label, "group": s.group, "detail": s.detail, "note": s.note,
                "regions": [
                    {
                        "id": r.id, "label": r.label, "kind": r.kind, "cadence": r.cadence_s, "note": r.note,
                        "bounds": list(r.bounds) if r.bounds else None,
                        "products": [
                            {"id": p.id, "label": p.label, "group": p.group, "note": p.note, "source": p.source,
                             "legend": p.legend}
                            for p in r.products
                        ],
                    }
                    for r in s.regions
                ],
            }
            for s in SATELLITES
        ],
        "default": {"sat": "goes19", "region": "conus", "product": "c13"},
    }


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------
def _layout(p: Product, when: Optional[datetime]):
    import sat_abi  # noqa: PLC0415
    import sat_slider as sl  # noqa: PLC0415

    key = p.params["layout"]
    sat = p.params["sat"]
    if key == "fd":
        return sl.LAYOUTS[(sat, "full_disk")]
    if key == "him_fd":
        return sl.LAYOUTS[("himawari", "full_disk")]
    if key == "him_japan":
        return _HIM_JAPAN
    if key == "him_target":
        # The target box moves: where it was comes from NOAA's copy of the
        # same scan (a 200 kB file), whose grid SLIDER's tiles sit on exactly.
        import sat_ahi  # noqa: PLC0415
        t = when or datetime.now(timezone.utc)
        return sat_ahi.target_layout(t)
    if key == "mtg_fd":
        return sl.LAYOUTS[("meteosat-12", "full_disk")]
    if key == "msg_iodc":
        return sl.LAYOUTS[("meteosat-9", "full_disk")]
    aws = "goes19" if sat == "goes-19" else "goes18"
    sector = key
    if sector == "conus":
        fixed = _conus_extent(aws)
        if fixed is not None:
            return sl.conus_layout(sat, *fixed)
    t = when or datetime.now(timezone.utc)
    found = sat_abi._file_at(aws, "MCMIP", sector, t, tolerance_s=300 if sector == "conus" else 45)  # noqa: SLF001
    if found is None:
        raise net.Missing(f"No GOES {sector} scan near {t:%H:%M}Z to place the picture")
    m = sat_abi.meta(sat_abi.BUCKETS[aws], *found)
    dx = m.x[1] - m.x[0]
    dy = m.y[1] - m.y[0]
    xs = (float(m.x[0] - dx / 2), float(m.x[-1] + dx / 2))
    ys = (float(m.y[0] - dy / 2), float(m.y[-1] + dy / 2))
    if sector == "conus":
        _keep_conus_extent(aws, xs, ys)
        return sl.conus_layout(sat, xs, ys)
    return sl.meso_layout(sat, xs, ys)


# The CONUS sector never moves on the fixed grid: its edges are read from one
# scan and kept (on disk too), instead of a listing and a file index -- 1.4 s
# on this link -- before every CONUS frame.
_CONUS: dict[str, tuple[tuple[float, float], tuple[float, float]]] = {}


def _conus_extent(aws: str) -> Optional[tuple[tuple[float, float], tuple[float, float]]]:
    hit = _CONUS.get(aws)
    if hit is None:
        raw = net.disk_get("layout", f"conus-v1-{aws}")
        if raw:
            try:
                xs, ys = json.loads(raw)
                hit = _CONUS[aws] = ((float(xs[0]), float(xs[1])), (float(ys[0]), float(ys[1])))
            except (ValueError, TypeError, IndexError):
                hit = None
    return hit


def _keep_conus_extent(aws: str, xs: tuple[float, float], ys: tuple[float, float]) -> None:
    _CONUS[aws] = (xs, ys)
    net.disk_put("layout", f"conus-v1-{aws}", json.dumps([list(xs), list(ys)]).encode())


def _him_japan_layout():
    """JMA's Japan area (HSD "JP" files: 1500 x 1200 at 2 km, COFF 1075.5,
    LOFF 2300.5 on the 2 km grid); SLIDER's Japan image is that array with 75
    rows of padding above it at zoom 0. Matched to the HSD files to 0.0 px."""
    import math  # noqa: PLC0415
    import sat_slider as sl  # noqa: PLC0415

    k = 65536.0 / 20466275.0
    ext = (math.radians((0.5 - 1075.5) * k), math.radians((1500.5 - 1075.5) * k),
           -math.radians((0.5 - 2300.5) * k), -math.radians((1200.5 - 2300.5) * k))
    return sl.Layout(750, 3, geo.Geos(140.7, 35785863.0, 6378137.0, 6356752.3, "y"), ext, 750, 600, top=75)


_HIM_JAPAN = _him_japan_layout()


def _times(p: Product, r: Region, count: int) -> list[datetime]:
    if p.engine == "slider":
        import sat_slider as sl  # noqa: PLC0415
        return sl.times(p.params["sat"], p.params["sector"], p.params["product"], count)
    if p.engine == "slv":
        import sat_slider as sl  # noqa: PLC0415
        # Every band the recipe needs, at the times they all have.
        common: Optional[set] = None
        first: list[datetime] = []
        for role in slv_roles(p.params["family"], p.id) or ():
            prod = f"band_{SLV_BANDS[p.params['family']][role]:02d}"
            ts = sl.times(p.params["sat"], p.params["sector"], prod, count + 6)
            first = first or ts
            common = set(ts) if common is None else common & set(ts)
        return sorted(common or set())[-count:]
    if p.engine == "abi":
        import sat_abi  # noqa: PLC0415
        return sat_abi.times(p.params["sat"], p.params["sector"], "MCMIP", count)
    if p.engine == "abi_l2":
        import sat_abi  # noqa: PLC0415
        return sat_abi.l2_times(p.params["sat"], p.params["sector"], p.params["pid"], count)
    if p.engine == "ahi":
        import sat_ahi  # noqa: PLC0415
        return sat_ahi.times(p.params["region"], count)
    if p.engine == "wms":
        import sat_wms  # noqa: PLC0415
        return sat_wms.times(p.params, count)
    raise ValueError(p.engine)


# Where each geostationary satellite sits, for fading its pictures out
# towards the limb (sat_geo.view_fade).
SUBPOINT = {"goes19": -75.0, "goes18": -137.0, "himawari9": 140.7,
            "meteosat12": 0.0, "meteosat9": 45.5, "meteosat11": 9.5}


def _render(s: Satellite, r: Region, p: Product, when: datetime, box: tuple[float, float, float, float],
            width: int, height: int, coarse: bool = False) -> np.ndarray:
    rgba = _draw(s, r, p, when, box, width, height, coarse)
    lon0 = SUBPOINT.get(s.id)
    if lon0 is not None:
        lon, lat = geo.mercator_grid(*box, width, height)
        fade = geo.view_fade(lon, lat, lon0)
        if fade.min() < 1.0:
            rgba = rgba.copy() if not rgba.flags.writeable else rgba
            rgba[..., 3] = (rgba[..., 3] * fade + 0.5).astype("uint8")
    return rgba


def _draw(s: Satellite, r: Region, p: Product, when: datetime, box: tuple[float, float, float, float],
          width: int, height: int, coarse: bool = False) -> np.ndarray:
    if p.engine == "wms":
        import sat_wms  # noqa: PLC0415
        return sat_wms.render(p.params, when, box, width, height)
    lon, lat = geo.mercator_grid(*box, width, height)
    if p.engine == "slider":
        import sat_slider as sl  # noqa: PLC0415
        layout = _layout(p, when)
        mask = None
        if p.params.get("layout") == "him_japan":
            import sat_ahi  # noqa: PLC0415
            mask = sat_ahi.japan_mask()
        return sl.render(p.params["sat"], p.params["sector"], p.params["product"], when, layout, lon, lat,
                         zoom_adjust=p.params.get("zoom_adjust", 0), mask=mask, coarse=coarse)
    if p.engine == "slv":
        return _render_slv(p, when, lon, lat, coarse)
    if p.engine == "abi":
        import sat_abi  # noqa: PLC0415
        return sat_abi.render_band_or_rgb(p.params["sat"], p.params["sector"], p.id, when, lon, lat)
    if p.engine == "abi_l2":
        import sat_abi  # noqa: PLC0415
        return sat_abi.render_l2(p.params["sat"], p.params["sector"], p.params["pid"], when, lon, lat)
    if p.engine == "ahi":
        import sat_ahi  # noqa: PLC0415
        return sat_ahi.render(p.params["region"], p.id, when, lon, lat)
    raise ValueError(p.engine)


def _render_slv(p: Product, when: datetime, lon: np.ndarray, lat: np.ndarray, coarse: bool = False) -> np.ndarray:
    import sat_slider as sl  # noqa: PLC0415

    fam = p.params["family"]
    layout = _layout(p, when)
    roles = slv_roles(fam, p.id) or ()
    adjust = SLIDER_ZOOM_ADJUST.get(fam, {})

    def one(role: str) -> np.ndarray:
        prod = f"band_{SLV_BANDS[fam][role]:02d}"
        return sl.values(p.params["sat"], p.params["sector"], prod, slv_kind(role), when, layout, lon, lat,
                         zoom_adjust=adjust.get(prod, DEFAULT_ADJUST), coarse=coarse)

    got = dict(zip(roles, net.BANDS.map(one, roles)))
    if p.params.get("layout") == "him_japan":
        import sat_ahi  # noqa: PLC0415
        inside = sat_ahi.japan_mask()(*geo.scan_angles(layout.geos, lon, lat))
        got = {k: np.where(inside, v, np.nan) for k, v in got.items()}
    recipe = rx.RECIPES[p.id]
    sza = geo.solar_zenith(lon, lat, when) if recipe.needs_sun else None
    img = recipe.draw(got, sza)
    valid = np.ones(lon.shape, dtype=bool)
    for a in got.values():
        valid &= np.isfinite(a)
    rgb8 = (np.clip(np.nan_to_num(img, nan=0.0), 0.0, 1.0) * 255.0 + 0.5).astype("uint8")
    alpha = np.where(valid, 255.0, 0.0)
    fade = rx.night_alpha(p.id, sza)
    if fade is not None:
        alpha = alpha * fade
    return np.dstack([rgb8, alpha.astype("uint8")])


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
_FRAMES_LOCK = threading.Lock()
_FRAMES: dict[tuple, tuple[float, list[dict]]] = {}
# Lists asked for lately, kept fresh by a thread so the panel's question is
# answered at once: a list from SLIDER or a bucket is a round trip or two
# (0.6-1.5 s here) that otherwise stood before every first picture.
_FRAMES_USED: dict[tuple, float] = {}
FRAMES_FRESH_S = 30
FRAMES_SERVE_S = 120
_REFRESHER: Optional[threading.Thread] = None
_FRAMES_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="sat-frames")


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _list_frames(ck: tuple) -> list[dict]:
    sat, region, product, count = ck
    _s, r, p = find(sat, region, product)
    out = [{"time": iso(t), "unix": int(t.timestamp())} for t in _times(p, r, count)]
    with _FRAMES_LOCK:
        _FRAMES[ck] = (time.time(), out)
    return out


# Connections kept open to the two sources most pictures come from while the
# satellite is in use (see sat_net.warm): a tile on an open one comes in 0.2 s,
# on a new one in 0.8.
_WARM_URLS = ("https://slider.cira.colostate.edu/data/json/goes-19/conus/band_13/latest_times.json",
              "https://storage.googleapis.com/storage/v1/b/gcp-public-data-goes-19/o?maxResults=1&fields=items(name)")
_WARMED = 0.0


def _keep_warm() -> None:
    global _WARMED
    now = time.time()
    if now - _WARMED < 40:
        return
    _WARMED = now
    for url in _WARM_URLS:
        _FRAMES_POOL.submit(net.warm, url, 16)


def _refresh_frames() -> None:
    while True:
        time.sleep(5)
        now = time.time()
        with _FRAMES_LOCK:
            used = [(ck, t) for ck, t in _FRAMES_USED.items()]
            stale = []
            for ck, asked in used:
                if now - asked > 300:
                    _FRAMES_USED.pop(ck, None)
                    continue
                hit = _FRAMES.get(ck)
                if hit is None or now - hit[0] >= FRAMES_FRESH_S:
                    stale.append(ck)
            in_use = bool(_FRAMES_USED)
        if in_use:
            _keep_warm()
        for fut in [_FRAMES_POOL.submit(_list_frames, ck) for ck in stale]:
            try:
                fut.result(timeout=60)
            except Exception:  # noqa: BLE001 - asked again in five seconds
                pass


def frames(sat: str, region: str, product: str, count: int) -> dict[str, Any]:
    global _REFRESHER
    find(sat, region, product)
    count = max(1, min(400, count))
    ck = (sat, region, product, count)
    with _FRAMES_LOCK:
        hit = _FRAMES.get(ck)
        _FRAMES_USED[ck] = time.time()
        if _REFRESHER is None:
            _REFRESHER = threading.Thread(target=_refresh_frames, name="sat-frames-refresh", daemon=True)
            _REFRESHER.start()
    _keep_warm()
    if hit and time.time() - hit[0] < FRAMES_SERVE_S:
        out = hit[1]
    else:
        out = _list_frames(ck)
    return {"frames": out, "bounds": bounds(sat, region)}


def warm(sat: str = "goes19", region: str = "conus", product: str = "c13", count: int = 24) -> None:
    """At start: the default product's list, the CONUS placements and open
    connections to the sources, so the first picture waits on its own tiles
    only. The list is not marked as in use: an app that never shows the
    satellite does not keep refreshing it."""
    import sat_abi  # noqa: PLC0415

    _keep_warm()
    for aws in ("goes19", "goes18"):
        try:
            if _conus_extent(aws) is None:
                newest = sat_abi.times(aws, "conus", "MCMIP", 1)
                if newest:
                    _layout(Product(id="warm", label="", group="", note="", engine="slider",
                                    params={"layout": "conus", "sat": "goes-19" if aws == "goes19" else "goes-18"}),
                            newest[-1])
        except Exception:  # noqa: BLE001 - read on first use instead
            pass
    try:
        find(sat, region, product)
        _list_frames((sat, region, product, max(1, min(400, count))))
    except Exception:  # noqa: BLE001
        pass


def bounds(sat: str, region: str) -> Optional[list[float]]:
    s = _BY_ID[sat]
    r = next(x for x in s.regions if x.id == region)
    if r.bounds:
        return list(r.bounds)
    try:
        fixed = _conus_extent(s.id) if r.id == "conus" and s.id in ("goes19", "goes18") else None
        if fixed is not None:
            (x0, x1), (y0, y1) = fixed
            g = geo.Geos(-75.0 if s.id == "goes19" else -137.0, 35786023.0)
            b = geo.box_bounds(g, min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1))
        elif s.id in ("goes19", "goes18"):
            import sat_abi  # noqa: PLC0415
            b = sat_abi.sector_bounds(s.id, r.id)
        elif s.id == "himawari9":
            import sat_ahi  # noqa: PLC0415
            b = sat_ahi.region_bounds(r.id)
        else:
            b = None
    except Exception:  # noqa: BLE001 - the panel falls back to the satellite's view
        b = None
    return [b["west"], b["south"], b["east"], b["north"]] if b else None


# Finished pictures: memory, then disk, then drawn.
_IMG_LOCK = threading.Lock()
_IMGS: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()
_IMG_BYTES = 0
IMG_BUDGET = 200 * 1024 ** 2
_IMG_FLIGHT: dict[str, threading.Event] = {}
_IMG_FAIL: dict[str, float] = {}


_TABLE_GROUPS = {"VISIBLE", "NEAR_IR", "IR", "I-BAND", "AVHRR", "ASCAT", "L2_CLOUD", "L2_FIRE", "L2_STABILITY",
                 "L2_MOISTURE", "L2_AEROSOL", "L2_SURFACE"}

# Bumped whenever a picture would come out differently, so the ones kept on
# disk from before are not served again.
RENDER_VERSION = 13


def _img_key(sat, region, product, t, box, w, h, detail: str = "full") -> str:
    return (f"v{RENDER_VERSION}|{sat}|{region}|{product}|{t}|"
            f"{box[0]:.4f},{box[1]:.4f},{box[2]:.4f},{box[3]:.4f}|{w}x{h}"
            + ("|coarse" if detail == "coarse" else ""))


def _have(key: str) -> bool:
    with _IMG_LOCK:
        if key in _IMGS:
            return True
    return net.disk_get("img", key) is not None


def _coarsens(p: Product, when: datetime, box, width: int, height: int) -> bool:
    """Whether a quick picture from one pyramid level down costs less: only
    the tile readers have levels, and at level 0 there is none below."""
    if p.engine not in ("slider", "slv"):
        return False
    import sat_slider as sl  # noqa: PLC0415

    lon, lat = geo.mercator_grid(*box, width, height)
    if p.engine == "slider":
        adjust = p.params.get("zoom_adjust", 0)
    else:
        fam = p.params["family"]
        roles = slv_roles(fam, p.id) or ()
        table = SLIDER_ZOOM_ADJUST.get(fam, {})
        adjust = min((table.get(f"band_{SLV_BANDS[fam][role]:02d}", DEFAULT_ADJUST) for role in roles),
                     default=DEFAULT_ADJUST)
    return sl.zoom_at(_layout(p, when), lon, lat, adjust) > 0


def image(sat: str, region: str, product: str, t: str, box: tuple[float, float, float, float],
          width: int, height: int, detail: str = "full") -> tuple[bytes, str, str]:
    """One frame of a product over a map box: WebP bytes, media type, and its
    detail. "coarse" asks for a quick picture from one tile level down (a
    quarter of the bytes); the sharp one is answered instead when it is
    already made or no quicker one exists."""
    global _IMG_BYTES
    s, r, p = find(sat, region, product)
    when = parse_time(t)
    if detail == "coarse":
        try:
            if _have(_img_key(sat, region, product, t, box, width, height)) or \
                    not _coarsens(p, when, box, width, height):
                detail = "full"
        except Exception:  # noqa: BLE001 - the sharp picture will say what is wrong
            detail = "full"
    else:
        detail = "full"
    key = _img_key(sat, region, product, t, box, width, height, detail)
    while True:
        with _IMG_LOCK:
            hit = _IMGS.get(key)
            if hit:
                _IMGS.move_to_end(key)
                return hit[0], hit[1], detail
            failed = _IMG_FAIL.get(key)
            if failed and time.time() - failed < 20:
                raise net.Missing("This frame failed a moment ago")
            ev = _IMG_FLIGHT.get(key)
            if ev is None:
                _IMG_FLIGHT[key] = threading.Event()
                break
        ev.wait(timeout=120)
    try:
        data = net.disk_get("img", key)
        media = "image/webp"
        if data is None:
            rgba = _render(s, r, p, when, box, width, height, coarse=detail == "coarse")
            # Colour tables (single bands, Level 2) go lossless: lossy WebP
            # halves colour resolution, and the edge of each colour band is
            # what is read. RGBs are photographs and stay lossy, finely.
            sharp_edges = p.lossless or p.group in _TABLE_GROUPS
            data, media = geo.encode_lossless(rgba) if sharp_edges else geo.encode(rgba, quality=92)
            net.disk_put("img", key, data)
        with _IMG_LOCK:
            _IMGS[key] = (data, media)
            _IMG_BYTES += len(data)
            while _IMG_BYTES > IMG_BUDGET and len(_IMGS) > 1:
                _k, (d, _m) = _IMGS.popitem(last=False)
                _IMG_BYTES -= len(d)
        return data, media, detail
    except Exception:
        with _IMG_LOCK:
            _IMG_FAIL[key] = time.time()
        raise
    finally:
        with _IMG_LOCK:
            ev = _IMG_FLIGHT.pop(key, None)
        if ev:
            ev.set()


def is_ready(sat, region, product, t, box, w, h) -> bool:
    return _have(_img_key(sat, region, product, t, box, w, h))


# A loop made ahead of the play, frame after frame in play order.
_LOOP_LOCK = threading.Lock()
_LOOP_GEN = 0
_LOOP_POOL = None
# A loop's tiles, fetched ahead of its drawing: a dozen at a time keeps the
# link busy. Drawn frame by frame, every frame fetched then drew in step with
# the others, and the link sat idle half the time (0 to 16 tiles in flight,
# 10 Mbit/s, where a steady 16 gets 20+).
_TILE_POOL = ThreadPoolExecutor(max_workers=12, thread_name_prefix="sat-loop-tiles")
_PLANS: "OrderedDict[tuple, list[tuple]]" = OrderedDict()
_PLAN_LOCK = threading.Lock()


def _tile_jobs(p: Product, when: datetime, box, width: int, height: int, coarse: bool) -> list[tuple]:
    """(sat, sector, product, when, z, row, col) of every SLIDER tile a
    picture reads. The tiles under a box are the same for every frame of a
    fixed sector, so they are worked out once per loop."""
    if p.engine not in ("slider", "slv"):
        return []
    import sat_slider as sl  # noqa: PLC0415

    layout = _layout(p, when)
    if p.engine == "slider":
        prods = [(p.params["product"], p.params.get("zoom_adjust", 0))]
    else:
        fam = p.params["family"]
        table = SLIDER_ZOOM_ADJUST.get(fam, {})
        prods = []
        for role in slv_roles(fam, p.id) or ():
            prod = f"band_{SLV_BANDS[fam][role]:02d}"
            prods.append((prod, table.get(prod, DEFAULT_ADJUST)))
    key = (layout, tuple(box), width, height, tuple(prods), coarse)
    with _PLAN_LOCK:
        planned = _PLANS.get(key)
    if planned is None:
        lon, lat = geo.mercator_grid(*box, width, height)
        planned = []
        for prod, adjust in prods:
            z, tiles = sl.plan(layout, lon, lat, adjust, coarse)
            planned += [(prod, z, r, c) for r, c in tiles]
        with _PLAN_LOCK:
            _PLANS[key] = planned
            while len(_PLANS) > 64:
                _PLANS.popitem(last=False)
    return [(p.params["sat"], p.params["sector"], prod, when, z, r, c) for prod, z, r, c in planned]


def prefetch(sat: str, region: str, product: str, times_: list[str], box, width: int, height: int,
             coarse_first: bool = True) -> dict:
    """Make a loop ahead of the play: every frame's quick picture first, so the
    loop can run within a quarter of the wait, then the sharp ones."""
    global _LOOP_GEN, _LOOP_POOL
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    _s, _r, prod = find(sat, region, product)
    with _LOOP_LOCK:
        _LOOP_GEN += 1
        gen = _LOOP_GEN
        if _LOOP_POOL is None:
            _LOOP_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sat-loop")
        pool = _LOOP_POOL

    def one(t: str, detail: str) -> None:
        if gen != _LOOP_GEN:
            return
        try:
            image(sat, region, product, t, box, width, height, detail)
        except Exception:  # noqa: BLE001 - the frame is asked for again when shown
            pass

    def fetch(job: tuple) -> None:
        if gen == _LOOP_GEN:
            import sat_slider as sl  # noqa: PLC0415
            try:
                sl.tile(*job)
            except Exception:  # noqa: BLE001 - the drawing asks for it again
                pass

    def tiles_ahead(detail: str) -> list:
        futures = []
        for t in times_:
            if gen != _LOOP_GEN:
                break
            try:
                jobs = _tile_jobs(prod, parse_time(t), box, width, height, detail == "coarse")
            except Exception:  # noqa: BLE001 - that frame's drawing fetches its own
                continue
            futures += [_TILE_POOL.submit(fetch, job) for job in jobs]
        return futures

    def run() -> None:
        # The sharp tiles wait for the last quick one: fetched alongside, their
        # bytes (four times as many) took the link from the quick ones and the
        # loop was playable no sooner. They start as soon as the quick tiles
        # are in, while those frames are still being drawn.
        drawing = []
        if coarse_first:
            for fut in tiles_ahead("coarse"):
                fut.result()
            drawing = [pool.submit(one, t, "coarse") for t in times_]
        if gen == _LOOP_GEN:
            tiles_ahead("full")
            for fut in drawing:
                fut.result()
            for t in times_:
                pool.submit(one, t, "full")

    threading.Thread(target=run, name="sat-loop-plan", daemon=True).start()
    return {"queued": len(times_)}


def cancel() -> dict:
    global _LOOP_GEN
    with _LOOP_LOCK:
        _LOOP_GEN += 1
    return {"ok": True}


def legend(sat: str, region: str, product: str) -> Optional[dict]:
    _s, _r, p = find(sat, region, product)
    return p.legend
