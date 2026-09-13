"""
Satellite imagery: geostationary loops and polar passes, from the agencies' own
tile servers.

Nothing is downloaded or rendered here. Three services already cut the imagery
into web-map tiles with a time dimension, send CORS headers, and answer a
whole-country view in a second or two:

    NASA GIBS          GOES-East, GOES-West and Himawari every 10 minutes
                       (GeoColor, visible, IR, RGBs); VIIRS and MODIS daily
    NOAA nowCOAST      GOES East and West blended, every 5 minutes, about
                       three minutes behind real time -- the freshest there is
    EUMETSAT EUMETView Meteosat MTG-I and MSG (0 degrees, Indian Ocean, rapid
                       scan), Metop and Sentinel-3

So the map fetches tiles straight from them. What this module does is the part
a browser cannot do cheaply: read each service's capabilities (5 MB from GIBS,
and six seconds from EUMETView) to learn which times actually exist, keep that
fresh in the background, and hand the app a plain frame list.

Checked 2026-09-13: EUMETView's advertised end time is the newest image it
really has (asking past it returns the same picture again), GIBS lags about 15
minutes, nowCOAST about 3.
"""
from __future__ import annotations

import json
import re
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.3 (storm-chasing workstation)"

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
EUMETVIEW = "https://view.eumetsat.int/geoserver/wms"
NOWCOAST = "https://nowcoast.noaa.gov/geoserver/satellite/wms"

PROVIDERS: dict[str, dict[str, Any]] = {
    "gibs": {
        "label": "NASA GIBS",
        "caps": GIBS + "/1.0.0/WMTSCapabilities.xml",
        "ttl": 300.0,
        "attribution": "Imagery: NASA GIBS / NOAA / JMA",
    },
    "nowcoast": {
        "label": "NOAA nowCOAST",
        "caps": NOWCOAST + "?service=WMS&request=GetCapabilities&version=1.3.0",
        "ttl": 120.0,
        "attribution": "Imagery: NOAA nowCOAST",
    },
    "eumetview": {
        "label": "EUMETSAT EUMETView",
        "caps": "https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetCapabilities&version=1.3.0",
        "ttl": 300.0,
        "attribution": "Imagery: © EUMETSAT",
    },
}

# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------
SATELLITES: list[dict[str, Any]] = [
    {"id": "goes-blend", "label": "GOES East + West", "detail": "5-minute blend · nowCOAST",
     "region": "Americas", "view": {"center": [-100, 30], "zoom": 2.6}},
    {"id": "goes-east", "label": "GOES-East", "detail": "GOES-19 ABI · 10 min",
     "region": "Americas", "view": {"center": [-75, 5], "zoom": 1.6}},
    {"id": "goes-west", "label": "GOES-West", "detail": "GOES-18 ABI · 10 min",
     "region": "Americas", "view": {"center": [-137, 5], "zoom": 1.6}},
    {"id": "himawari", "label": "Himawari", "detail": "AHI · 10 min",
     "region": "Asia & Pacific", "view": {"center": [140, 5], "zoom": 1.6}},
    {"id": "mtg", "label": "Meteosat MTG-I (0°)", "detail": "FCI and Lightning Imager · 10 min",
     "region": "Europe & Africa", "view": {"center": [0, 10], "zoom": 1.6}},
    {"id": "msg", "label": "Meteosat MSG (0°)", "detail": "SEVIRI · 15 min",
     "region": "Europe & Africa", "view": {"center": [0, 10], "zoom": 1.6}},
    {"id": "msg-rss", "label": "Meteosat Rapid Scan", "detail": "SEVIRI over Europe · 5 min",
     "region": "Europe & Africa", "view": {"center": [10, 50], "zoom": 3}},
    {"id": "msg-iodc", "label": "Meteosat MSG (Indian Ocean)", "detail": "SEVIRI · 15 min",
     "region": "Asia & Pacific", "view": {"center": [45, 10], "zoom": 1.6}},
    {"id": "global", "label": "Global geostationary mosaic", "detail": "Every satellite stitched · hourly",
     "region": "Global", "view": {"center": [0, 15], "zoom": 1}},
    {"id": "metop", "label": "Metop-B / Metop-C", "detail": "AVHRR and ASCAT · polar passes",
     "region": "Polar orbit", "view": {"center": [0, 20], "zoom": 1}},
    {"id": "jpss", "label": "NOAA-20 / NOAA-21 / Suomi NPP", "detail": "VIIRS · daily",
     "region": "Polar orbit", "view": {"center": [-95, 35], "zoom": 3}},
    {"id": "eos", "label": "Terra / Aqua", "detail": "MODIS · daily",
     "region": "Polar orbit", "view": {"center": [-95, 35], "zoom": 3}},
    {"id": "sentinel3", "label": "Sentinel-3A / 3B", "detail": "OLCI · daily",
     "region": "Polar orbit", "view": {"center": [10, 45], "zoom": 3}},
]


def _gibs(pid, sat, label, kind, layer, level, ext="png", daily=False, note=""):
    return {"id": pid, "sat": sat, "label": label, "kind": kind, "provider": "gibs", "layer": layer,
            "tms": f"GoogleMapsCompatible_Level{level}", "ext": ext, "maxzoom": level, "tileSize": 256,
            "daily": daily, "note": note}


def _wms(pid, sat, label, kind, provider, layer, maxzoom=7, note="", daily=False, min_hours=0.0):
    return {"id": pid, "sat": sat, "label": label, "kind": kind, "provider": provider, "layer": layer,
            "maxzoom": maxzoom, "tileSize": 512, "daily": daily, "note": note, "min_hours": min_hours}


GEOCOLOR = "True colour by day, city lights and low cloud by night."
AIRMASS = "Red: dry, ozone-rich stratospheric air (jets, PV anomalies). Green: tropical. Blue/purple: cold polar air."
DUST = "Dust and sand glow magenta; thick high cloud goes dark red."
FIRETEMP = "Hot fires glow from red to yellow to white as they burn hotter."
IR = "Cloud-top temperature: the colder (higher) the top, the brighter."
VIS = "Reflected sunlight at the finest resolution the imager has. Daytime only."

PRODUCT_LIST: list[dict[str, Any]] = [
    # ----- GOES East + West, nowCOAST, 5 min
    _wms("goes-blend-vis", "goes-blend", "Visible", "Visible", "nowcoast", "goes_visible_imagery", 8, VIS),
    _wms("goes-blend-lwir", "goes-blend", "Longwave Infrared", "Infrared", "nowcoast", "goes_longwave_imagery", 7, IR),
    _wms("goes-blend-swir", "goes-blend", "Shortwave Infrared (3.9 µm)", "Infrared", "nowcoast", "goes_shortwave_imagery", 7,
         "Fog, low cloud and fire hot spots stand out at night."),
    _wms("goes-blend-wv", "goes-blend", "Water Vapor", "Water Vapor", "nowcoast", "goes_water_vapor_imagery", 7,
         "Mid- and upper-level moisture: troughs, jets and dry slots."),
    _wms("goes-blend-snow", "goes-blend", "Snow / Ice", "RGB", "nowcoast", "goes_snow_ice_imagery", 7),
    # ----- GOES-East (GIBS)
    _gibs("goes-east-geocolor", "goes-east", "GeoColor", "RGB", "GOES-East_ABI_GeoColor", 7, note=GEOCOLOR),
    _gibs("goes-east-vis", "goes-east", "Red Visible (Band 2)", "Visible", "GOES-East_ABI_Band2_Red_Visible_1km", 7, note=VIS),
    _gibs("goes-east-ir", "goes-east", "Clean Infrared (Band 13)", "Infrared", "GOES-East_ABI_Band13_Clean_Infrared", 6, note=IR),
    _gibs("goes-east-airmass", "goes-east", "Air Mass RGB", "RGB", "GOES-East_ABI_Air_Mass", 6, note=AIRMASS),
    _gibs("goes-east-dust", "goes-east", "Dust RGB", "RGB", "GOES-East_ABI_Dust", 7, note=DUST),
    _gibs("goes-east-fire", "goes-east", "Fire Temperature RGB", "Fire", "GOES-East_ABI_FireTemp", 7, note=FIRETEMP),
    # ----- GOES-West (GIBS)
    _gibs("goes-west-geocolor", "goes-west", "GeoColor", "RGB", "GOES-West_ABI_GeoColor", 7, note=GEOCOLOR),
    _gibs("goes-west-vis", "goes-west", "Red Visible (Band 2)", "Visible", "GOES-West_ABI_Band2_Red_Visible_1km", 7, note=VIS),
    _gibs("goes-west-ir", "goes-west", "Clean Infrared (Band 13)", "Infrared", "GOES-West_ABI_Band13_Clean_Infrared", 6, note=IR),
    _gibs("goes-west-airmass", "goes-west", "Air Mass RGB", "RGB", "GOES-West_ABI_Air_Mass", 6, note=AIRMASS),
    _gibs("goes-west-dust", "goes-west", "Dust RGB", "RGB", "GOES-West_ABI_Dust", 6, note=DUST),
    _gibs("goes-west-fire", "goes-west", "Fire Temperature RGB", "Fire", "GOES-West_ABI_FireTemp", 6, note=FIRETEMP),
    # ----- Himawari (GIBS)
    _gibs("himawari-vis", "himawari", "Red Visible (Band 3)", "Visible", "Himawari_AHI_Band3_Red_Visible_1km", 7, note=VIS),
    _gibs("himawari-ir", "himawari", "Clean Infrared (Band 13)", "Infrared", "Himawari_AHI_Band13_Clean_Infrared", 6, note=IR),
    _gibs("himawari-airmass", "himawari", "Air Mass RGB", "RGB", "Himawari_AHI_Air_Mass", 6, note=AIRMASS),
    # ----- Meteosat Third Generation, 0 degrees
    _wms("mtg-geocolour", "mtg", "GeoColour", "RGB", "eumetview", "mtg_fd:rgb_geocolour", 7, GEOCOLOR),
    _wms("mtg-truecolour", "mtg", "True Colour", "RGB", "eumetview", "mtg_fd:rgb_truecolour", 7),
    _wms("mtg-vis", "mtg", "Visible 0.6 µm (HRFI)", "Visible", "eumetview", "mtg_fd:vis06_hrfi", 8, VIS),
    _wms("mtg-ir", "mtg", "Infrared 10.5 µm (HRFI)", "Infrared", "eumetview", "mtg_fd:ir105_hrfi", 7, IR),
    _wms("mtg-cloudphase", "mtg", "Cloud Phase RGB", "Cloud", "eumetview", "mtg_fd:rgb_cloudphase", 7,
         "Ice clouds in red, water clouds in cyan and green."),
    _wms("mtg-cloudtype", "mtg", "Cloud Type RGB", "Cloud", "eumetview", "mtg_fd:rgb_cloudtype", 7),
    _wms("mtg-fog", "mtg", "Fog / Low Cloud RGB", "Cloud", "eumetview", "mtg_fd:rgb_fog", 7),
    _wms("mtg-dust", "mtg", "Dust RGB", "RGB", "eumetview", "mtg_fd:rgb_dust", 7, DUST),
    _wms("mtg-snow", "mtg", "Snow RGB", "RGB", "eumetview", "mtg_fd:rgb_snow", 7),
    _wms("mtg-firetemp", "mtg", "Fire Temperature RGB", "Fire", "eumetview", "mtg_fd:rgb_firetemperature", 7, FIRETEMP),
    _wms("mtg-frp", "mtg", "Fire Radiative Power", "Fire", "eumetview", "mtg_fd:frp", 7),
    _wms("mtg-lightning", "mtg", "Lightning (LI flash area)", "Lightning", "eumetview", "mtg_fd:li_afa", 7,
         "The Lightning Imager's accumulated flash area: where lightning is, from space, every 5 minutes."),
    _wms("mtg-precip", "mtg", "Precipitation (FCI + microwave)", "Precipitation", "eumetview", "mtg_fd:h40b", 6),
    # ----- MSG 0 degrees
    _wms("msg-vis", "msg", "Visible 0.6 µm", "Visible", "eumetview", "msg_fes:vis006", 6, VIS),
    _wms("msg-hrv", "msg", "HRV Colour (Europe)", "Visible", "eumetview", "msg_fes:rgb_eview", 7),
    _wms("msg-ir039", "msg", "Infrared 3.9 µm", "Infrared", "eumetview", "msg_fes:ir039", 6),
    _wms("msg-ir108", "msg", "Infrared 10.8 µm", "Infrared", "eumetview", "msg_fes:ir108", 6, IR),
    _wms("msg-wv062", "msg", "Water Vapour 6.2 µm", "Water Vapor", "eumetview", "msg_fes:wv062", 6),
    _wms("msg-airmass", "msg", "Airmass RGB", "RGB", "eumetview", "msg_fes:rgb_airmass", 6, AIRMASS),
    _wms("msg-convection", "msg", "Convection RGB", "RGB", "eumetview", "msg_fes:rgb_convection", 6,
         "Strong, small-ice updrafts go bright yellow."),
    _wms("msg-microphysics", "msg", "Night Microphysics RGB", "Cloud", "eumetview", "msg_fes:rgb_microphysics", 6),
    _wms("msg-natural", "msg", "Natural Colour RGB", "RGB", "eumetview", "msg_fes:rgb_natural", 6),
    _wms("msg-naturalenh", "msg", "Natural Colour Enhanced", "RGB", "eumetview", "msg_fes:rgb_naturalenhncd", 6),
    _wms("msg-tropical", "msg", "Tropical Airmass RGB", "RGB", "eumetview", "msg_fes:rgb_tropicalairmass", 6),
    _wms("msg-dust", "msg", "Dust RGB", "RGB", "eumetview", "msg_fes:rgb_dust", 6, DUST),
    _wms("msg-ash", "msg", "Volcanic Ash RGB", "RGB", "eumetview", "msg_fes:rgb_ash", 6),
    _wms("msg-fog", "msg", "Fog RGB", "Cloud", "eumetview", "msg_fes:rgb_fog", 6),
    _wms("msg-snow", "msg", "Snow RGB", "RGB", "eumetview", "msg_fes:rgb_snow", 6),
    _wms("msg-cth", "msg", "Cloud Top Height", "Cloud", "eumetview", "msg_fes:cth", 6),
    _wms("msg-clm", "msg", "Cloud Mask", "Cloud", "eumetview", "msg_fes:clm", 6),
    _wms("msg-rdt", "msg", "Rapidly Developing Thunderstorms", "Derived", "eumetview", "msg_fes:rdt", 7,
         "Storm cells identified and tracked from space, with their trend."),
    _wms("msg-kindex", "msg", "K-Index", "Derived", "eumetview", "msg_fes:gii_kindex", 6),
    _wms("msg-li", "msg", "Lifted Index", "Derived", "eumetview", "msg_fes:gii_liftedindex", 6),
    _wms("msg-fire", "msg", "Active Fires", "Fire", "eumetview", "msg_fes:fire", 7),
    _wms("msg-precip", "msg", "Precipitation (SEVIRI + microwave)", "Precipitation", "eumetview", "msg_fes:h60b", 6),
    # ----- MSG rapid scan over Europe, 5 min
    _wms("rss-natural", "msg-rss", "Natural Colour RGB", "RGB", "eumetview", "msg_rss:rgb_natural_nrt", 7),
    _wms("rss-naturalenh", "msg-rss", "Natural Colour Enhanced", "RGB", "eumetview", "msg_rss:rgb_naturalenhncd_nrt", 7),
    _wms("rss-microphysics", "msg-rss", "Night Microphysics RGB", "Cloud", "eumetview", "msg_rss:rgb_microphysics_nrt", 7),
    _wms("rss-ir039", "msg-rss", "Infrared 3.9 µm", "Infrared", "eumetview", "msg_rss:ir039_nrt", 7),
    # ----- MSG Indian Ocean
    _wms("iodc-vis", "msg-iodc", "Visible 0.6 µm", "Visible", "eumetview", "msg_iodc:vis006", 6, VIS),
    _wms("iodc-ir039", "msg-iodc", "Infrared 3.9 µm", "Infrared", "eumetview", "msg_iodc:ir039", 6),
    _wms("iodc-ir108", "msg-iodc", "Infrared 10.8 µm", "Infrared", "eumetview", "msg_iodc:ir108", 6, IR),
    _wms("iodc-wv062", "msg-iodc", "Water Vapour 6.2 µm", "Water Vapor", "eumetview", "msg_iodc:wv062", 6),
    _wms("iodc-airmass", "msg-iodc", "Airmass RGB", "RGB", "eumetview", "msg_iodc:rgb_airmass", 6, AIRMASS),
    _wms("iodc-convection", "msg-iodc", "Convection RGB", "RGB", "eumetview", "msg_iodc:rgb_convection", 6),
    _wms("iodc-microphysics", "msg-iodc", "Night Microphysics RGB", "Cloud", "eumetview", "msg_iodc:rgb_microphysics", 6),
    _wms("iodc-natural", "msg-iodc", "Natural Colour RGB", "RGB", "eumetview", "msg_iodc:rgb_natural", 6),
    _wms("iodc-tropical", "msg-iodc", "Tropical Airmass RGB", "RGB", "eumetview", "msg_iodc:rgb_tropicalairmass", 6),
    _wms("iodc-dust", "msg-iodc", "Dust RGB", "RGB", "eumetview", "msg_iodc:rgb_dust", 6, DUST),
    _wms("iodc-ash", "msg-iodc", "Volcanic Ash RGB", "RGB", "eumetview", "msg_iodc:rgb_ash", 6),
    _wms("iodc-fog", "msg-iodc", "Fog RGB", "Cloud", "eumetview", "msg_iodc:rgb_fog", 6),
    _wms("iodc-cth", "msg-iodc", "Cloud Top Height", "Cloud", "eumetview", "msg_iodc:cth", 6),
    _wms("iodc-kindex", "msg-iodc", "K-Index", "Derived", "eumetview", "msg_iodc:gii_kindex", 6),
    _wms("iodc-li", "msg-iodc", "Lifted Index", "Derived", "eumetview", "msg_iodc:gii_liftedindex", 6),
    _wms("iodc-fire", "msg-iodc", "Active Fires", "Fire", "eumetview", "msg_iodc:fire", 7),
    _wms("iodc-precip", "msg-iodc", "Precipitation Rate", "Precipitation", "eumetview", "msg_iodc:h63", 6),
    # ----- Global mosaic (nowCOAST, hourly)
    _wms("global-lwir", "global", "Longwave Infrared", "Infrared", "nowcoast", "global_longwave_imagery_mosaic", 6, IR),
    _wms("global-vis", "global", "Visible", "Visible", "nowcoast", "global_visible_imagery_mosaic", 6),
    _wms("global-wv", "global", "Water Vapor", "Water Vapor", "nowcoast", "global_water_vapor_imagery_mosaic", 6),
    _wms("global-swir", "global", "Shortwave Infrared", "Infrared", "nowcoast", "global_shortwave_imagery_mosaic", 6),
    # ----- Metop (polar, accumulated passes)
    _wms("metopb-ir", "metop", "Metop-B Infrared 10.8 µm", "Infrared", "eumetview", "eps:m01_ir108", 6,
         "The last six orbits laid side by side.", min_hours=24),
    _wms("metopb-rgb", "metop", "Metop-B Cloud RGB", "RGB", "eumetview", "eps:m01_rgb_124", 6, min_hours=24),
    _wms("metopb-fog", "metop", "Metop-B Natural / Fog RGB", "Cloud", "eumetview", "eps:m01_rgb_natural_fog", 6, min_hours=24),
    _wms("metopb-ascat", "metop", "Metop-B ASCAT Ocean Winds", "Derived", "eumetview", "eps:m01_ascat_wind", 7,
         "Scatterometer winds over the ocean, 12.5 km.", min_hours=24),
    _wms("metopc-ir", "metop", "Metop-C Infrared 10.8 µm", "Infrared", "eumetview", "eps:m03_ir108", 6, min_hours=24),
    _wms("metopc-rgb", "metop", "Metop-C Cloud RGB", "RGB", "eumetview", "eps:m03_rgb_124", 6, min_hours=24),
    _wms("metopc-fog", "metop", "Metop-C Natural / Fog RGB", "Cloud", "eumetview", "eps:m03_rgb_natural_fog", 6, min_hours=24),
    _wms("metopc-ascat", "metop", "Metop-C ASCAT Ocean Winds", "Derived", "eumetview", "eps:m03_ascat_wind", 7, min_hours=24),
    # ----- JPSS VIIRS (daily)
    _gibs("noaa20-true", "jpss", "NOAA-20 True Colour", "Visible", "VIIRS_NOAA20_CorrectedReflectance_TrueColor", 9, "jpg", True),
    _gibs("noaa21-true", "jpss", "NOAA-21 True Colour", "Visible", "VIIRS_NOAA21_CorrectedReflectance_TrueColor", 9, "jpg", True),
    _gibs("snpp-true", "jpss", "Suomi NPP True Colour", "Visible", "VIIRS_SNPP_CorrectedReflectance_TrueColor", 9, "jpg", True),
    _gibs("noaa20-firesnow", "jpss", "NOAA-20 Fire & Snow False Colour", "Fire", "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1", 9, "jpg", True,
          "Burn scars brown, snow and ice cyan, active fire orange."),
    _gibs("noaa20-dnb", "jpss", "NOAA-20 Day/Night Band", "Infrared", "VIIRS_NOAA20_DayNightBand", 7, "png", True,
          "Moonlit clouds and city lights at night."),
    # ----- EOS MODIS (daily)
    _gibs("terra-true", "eos", "Terra True Colour", "Visible", "MODIS_Terra_CorrectedReflectance_TrueColor", 9, "jpg", True),
    _gibs("aqua-true", "eos", "Aqua True Colour", "Visible", "MODIS_Aqua_CorrectedReflectance_TrueColor", 9, "jpg", True),
    # ----- Sentinel-3 (daily)
    _wms("s3-true", "sentinel3", "OLCI True Colour", "Visible", "eumetview",
         "copernicus:daily_sentinel3ab_olci_l1_rgb_fulres", 9, daily=True),
]
PRODUCTS: dict[str, dict[str, Any]] = {p["id"]: p for p in PRODUCT_LIST}

DEFAULT_PRODUCT = "goes-blend-vis"


def _tiles(spec: dict) -> str:
    """The tile URL with `{time}` left for the frame, and MapLibre's own
    placeholders for the tile."""
    if spec["provider"] == "gibs":
        return f"{GIBS}/{spec['layer']}/default/{{time}}/{spec['tms']}/{{z}}/{{y}}/{{x}}.{spec['ext']}"
    base = EUMETVIEW if spec["provider"] == "eumetview" else NOWCOAST
    return (f"{base}?service=WMS&request=GetMap&version=1.3.0&layers={spec['layer']}&styles="
            "&format=image/png&transparent=true&crs=EPSG:3857&width=512&height=512"
            "&bbox={bbox-epsg-3857}&time={time}")


def catalog() -> dict[str, Any]:
    return {
        "satellites": SATELLITES,
        "products": [
            {
                "id": p["id"], "sat": p["sat"], "label": p["label"], "kind": p["kind"], "note": p["note"],
                "provider": p["provider"], "tiles": _tiles(p), "tileSize": p["tileSize"],
                "maxzoom": p["maxzoom"], "daily": p["daily"],
                "attribution": PROVIDERS[p["provider"]]["attribution"],
            }
            for p in PRODUCT_LIST
        ],
        "defaultProduct": DEFAULT_PRODUCT,
    }


# ---------------------------------------------------------------------------
# Capabilities -> which times exist
# ---------------------------------------------------------------------------
_LOCK = threading.Lock()
# provider -> (fetched at, {layer: [time ranges]})
_DIMS: dict[str, tuple[float, dict[str, list]]] = {}
_REFRESHING: set[str] = set()
_DIR = Path(tempfile.gettempdir()) / "weatherts-sat"


def _iso(text: str) -> datetime:
    text = text.strip()
    if len(text) == 10:
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def _period(text: str) -> timedelta:
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", text.strip())
    if not m:
        raise ValueError(f"unreadable period {text}")
    d, h, mi, s = (int(v) if v else 0 for v in m.groups())
    return timedelta(days=d, hours=h, minutes=mi, seconds=s)


def _ranges(values: list[str]) -> list[tuple[str, str, int]]:
    """Dimension values -> (start, end, step seconds). A bare time is a range of one."""
    out = []
    for v in values:
        for part in v.split(","):
            part = part.strip()
            if not part:
                continue
            bits = part.split("/")
            if len(bits) == 3:
                out.append((bits[0], bits[1], int(_period(bits[2]).total_seconds())))
            else:
                out.append((bits[0], bits[0], 0))
    return out


def _parse(provider: str, text: str) -> dict[str, list]:
    wanted = {p["layer"] for p in PRODUCT_LIST if p["provider"] == provider}
    out: dict[str, list] = {}
    for layer in wanted:
        if provider == "gibs":
            i = text.find(f"<ows:Identifier>{layer}</ows:Identifier>")
            if i < 0:
                continue
            start = text.rfind("<Layer>", 0, i)
            block = text[start:text.find("</Layer>", i)]
            values = re.findall(r"<Value>([^<]+)</Value>", block)
        else:
            i = text.find(f"<Name>{layer}</Name>")
            if i < 0:
                continue
            block = text[i:text.find("</Layer>", i)]
            dim = re.search(r'<Dimension name="time"[^>]*>([^<]*)</Dimension>', block)
            values = [dim.group(1)] if dim else []
        if values:
            out[layer] = _ranges(values)
    return out


def _path(provider: str) -> Path:
    return _DIR / f"{provider}-times.json"


def _refresh(provider: str) -> Optional[dict[str, list]]:
    try:
        r = _SESSION.get(PROVIDERS[provider]["caps"], timeout=45)
        r.raise_for_status()
        dims = _parse(provider, r.text)
    except Exception:  # noqa: BLE001 - the last good list keeps serving
        return None
    finally:
        with _LOCK:
            _REFRESHING.discard(provider)
    if not dims:
        return None
    with _LOCK:
        _DIMS[provider] = (time.time(), dims)
    try:
        _DIR.mkdir(parents=True, exist_ok=True)
        _path(provider).write_text(json.dumps({"saved": time.time(), "dims": dims}), encoding="utf-8")
    except OSError:
        pass
    return dims


def _refresh_later(provider: str) -> None:
    with _LOCK:
        if provider in _REFRESHING:
            return
        _REFRESHING.add(provider)
    threading.Thread(target=_refresh, args=(provider,), daemon=True, name=f"sat-{provider}").start()


def _dims(provider: str) -> dict[str, list]:
    """Which times each layer has. Answers at once from what is known -- memory,
    else the copy on disk -- and refreshes behind the answer when it is old; only
    a first run with nothing saved waits for the service."""
    ttl = PROVIDERS[provider]["ttl"]
    with _LOCK:
        hit = _DIMS.get(provider)
    if hit is None:
        try:
            saved = json.loads(_path(provider).read_text(encoding="utf-8"))
            if time.time() - float(saved.get("saved", 0)) < 86400:
                hit = (float(saved["saved"]), saved["dims"])
                with _LOCK:
                    _DIMS.setdefault(provider, hit)
        except (OSError, ValueError, KeyError):
            pass
    if hit is None:
        with _LOCK:
            _REFRESHING.add(provider)
        return _refresh(provider) or {}
    if time.time() - hit[0] > ttl:
        _refresh_later(provider)
    return hit[1]


def warm() -> None:
    """Read every service's capabilities in the background at start-up, so the
    panel opens onto a frame list instead of a six-second wait."""
    for provider in PROVIDERS:
        _refresh_later(provider)


def _fmt_time(spec: dict, when: datetime) -> str:
    if spec["daily"]:
        return when.strftime("%Y-%m-%d")
    if spec["provider"] == "gibs":
        return when.strftime("%Y-%m-%dT%H:%M:%SZ")
    return when.strftime("%Y-%m-%dT%H:%M:%S.000Z")


MAX_FRAMES = 300


def _times(spec: dict, since: datetime, now: datetime) -> list[datetime]:
    dims = _dims(spec["provider"]).get(spec["layer"], [])
    times: set[datetime] = set()
    for start_s, end_s, step in dims:
        start, end = _iso(start_s), min(_iso(end_s), now)
        if end < since:
            continue
        if step <= 0:
            if since <= start <= now:
                times.add(start)
            continue
        # First step at or after `since`, on the range's own grid.
        k = max(0, int((since - start).total_seconds() // step))
        t = start + timedelta(seconds=k * step)
        while t <= end:
            if t >= since:
                times.add(t)
            t += timedelta(seconds=step)
    if spec["daily"]:
        # A daily composite is one picture a day however many granules went in.
        times = {t.replace(hour=0, minute=0, second=0, microsecond=0) for t in times}
    return sorted(times)


def frames(product: str, hours: float = 3.0) -> dict[str, Any]:
    """The frames of one product in the last `hours` (or the last ten days for a
    daily one), oldest first, with the time string its tile URL wants.

    A loop that comes back empty -- visible imagery at night, a polar pass hours
    ago -- gives the last dozen frames there are instead: the latest daylight
    loop is more use than a blank map."""
    spec = PRODUCTS.get(product)
    if spec is None:
        raise ValueError(f"Unknown satellite product: {product}")
    hours = max(0.5, min(float(hours), 48.0), float(spec.get("min_hours") or 0.0))
    now = datetime.now(timezone.utc)
    since = now - (timedelta(days=10) if spec["daily"] else timedelta(hours=hours))
    ordered = _times(spec, since, now)
    stale = False
    if not ordered and not spec["daily"]:
        ordered = _times(spec, now - timedelta(days=3), now)[-12:]
        stale = bool(ordered)
    ordered = ordered[-MAX_FRAMES:]
    label = "%b %d" if spec["daily"] else "%d %H:%MZ"
    out = [{"time": _fmt_time(spec, t), "unix": int(t.timestamp()), "label": t.strftime(label)} for t in ordered]
    return {
        "product": product,
        "frames": out,
        "latest": out[-1]["unix"] if out else None,
        # True when these are older than the loop asked for (see above).
        "stale": stale,
    }
