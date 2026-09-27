"""
How satellite data becomes colour: single bands, RGB composites, and the
GOES-R Level 2 products.

Bands are named by what they measure rather than by each imager's numbering, so
one recipe serves every imager that carries the bands it needs:

    b047 blue 0.47    g051 green 0.51 (AHI, FCI)   r064 red 0.64
    n086 veggie 0.86  c137 cirrus 1.37 (ABI, FCI)  s161 snow/ice 1.6
    p224 particle size 2.2-2.3                     i039 shortwave IR 3.9
    w062 upper WV 6.2 w069 mid WV 6.9              w073 lower WV 7.3
    i086 cloud phase 8.4-8.7   i096 ozone 9.6      i103 clean IR 10.3-10.5
    i112 IR 11.2      i123 dirty IR 12.0-12.3      i133 CO2 13.3

Reflective bands come in as reflectance factor (0-1), emissive ones in kelvin.
The RGB limits are the published ones (CIRA and EUMETSAT quick guides, as
satpy carries them); satpy's gamma g means value ** (1 / g), kept here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

import numpy as np

ABI_ROLES = {
    1: "b047", 2: "r064", 3: "n086", 4: "c137", 5: "s161", 6: "p224", 7: "i039", 8: "w062",
    9: "w069", 10: "w073", 11: "i086", 12: "i096", 13: "i103", 14: "i112", 15: "i123", 16: "i133",
}
AHI_ROLES = {
    1: "b047", 2: "g051", 3: "r064", 4: "n086", 5: "s161", 6: "p224", 7: "i039", 8: "w062",
    9: "w069", 10: "w073", 11: "i086", 12: "i096", 13: "i103", 14: "i112", 15: "i123", 16: "i133",
}
REFLECTIVE = {"b047", "g051", "r064", "n086", "c137", "s161", "p224"}


# ---------------------------------------------------------------------------
# Building blocks
# ---------------------------------------------------------------------------

def stretch(v: np.ndarray, lo: float, hi: float, gamma: float = 1.0) -> np.ndarray:
    t = np.clip((v - lo) / (hi - lo), 0.0, 1.0)
    return t ** (1.0 / gamma) if gamma != 1.0 else t


def rgb(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Three 0-1 channels to an H x W x 3 float image (NaN stays NaN)."""
    return np.dstack([r, g, b]).astype("float32")


def pct(v: np.ndarray) -> np.ndarray:
    return v * 100.0


def ramp(stops: list[tuple[float, tuple[int, int, int]]]) -> Callable[[np.ndarray], np.ndarray]:
    """A piecewise-linear colour table over a value, as 0-1 RGB."""
    stops = sorted(stops, key=lambda s: s[0])
    xs = np.array([s[0] for s in stops], dtype="float32")
    cols = np.array([s[1] for s in stops], dtype="float32") / 255.0

    def apply(v: np.ndarray) -> np.ndarray:
        vv = np.nan_to_num(v, nan=float(xs[0]))
        out = np.stack([np.interp(vv, xs, cols[:, c]) for c in range(3)], axis=-1).astype("float32")
        out[~np.isfinite(v)] = np.nan
        return out

    apply.stops = stops  # type: ignore[attr-defined]
    return apply


def hexrgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def sunz_correct(refl: np.ndarray, sza: Optional[np.ndarray]) -> np.ndarray:
    """Reflectance over cos(solar zenith), capped near the terminator the way
    satpy's sunz_corrected is, so a day RGB is as bright at 5 pm as at noon."""
    if sza is None:
        return refl
    cos = np.cos(np.radians(np.clip(sza, 0.0, 88.0)))
    # Past 88 degrees the correction fades back to none by 95.
    fade = np.clip((sza - 88.0) / 7.0, 0.0, 1.0)
    return refl / np.maximum(cos, 0.035) * (1 - fade) + refl * fade


def day_fade(sza: Optional[np.ndarray], lo: float = 85.0, hi: float = 95.0) -> Optional[np.ndarray]:
    """1 in daylight, 0 at night, ramping across the terminator."""
    if sza is None:
        return None
    return np.clip((hi - sza) / (hi - lo), 0.0, 1.0).astype("float32")


# Planck, for the 3.9 um reflectance (Day Microphysics).
_C1 = 1.191042e8   # W um^4 m^-2 sr^-1
_C2 = 1.4387752e4  # um K


def _planck(wl_um: float, t: np.ndarray) -> np.ndarray:
    return _C1 / (wl_um ** 5 * (np.exp(_C2 / (wl_um * np.maximum(t, 1.0))) - 1.0))


def refl39(bt39: np.ndarray, bt11: np.ndarray, sza: Optional[np.ndarray]) -> np.ndarray:
    """The reflected part of the 3.9 um signal (Rosenfeld and Lensky): what the
    band measures, less what the scene emits at its 11 um temperature, over the
    sunlight that reaches it."""
    wl = 3.9
    l39 = _planck(wl, bt39)
    lth = _planck(wl, bt11)
    sun = 9.748  # W m^-2 um^-1, top-of-atmosphere solar irradiance near 3.9 um
    mu = np.cos(np.radians(np.clip(sza if sza is not None else 60.0, 0.0, 85.0)))
    r = (l39 - lth) / (sun * mu / np.pi - lth)
    return np.clip(r, 0.0, 1.0).astype("float32")


def cira_stretch(refl: np.ndarray) -> np.ndarray:
    """The CIRA logarithmic stretch for true colour (satpy's cira_stretch)."""
    log_root = np.log10(0.0223)
    denom = (1.0 - log_root) * 0.75
    v = np.log10(np.clip(refl, 0.0223, None))
    return np.clip((v - log_root) / denom, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Colour tables for single bands
# ---------------------------------------------------------------------------

# Longwave infrared, the cold tops coloured the way storm chasers read them.
IR_ENHANCED = ramp([
    (330.0, (0, 0, 0)), (243.0, (205, 205, 205)),
    (242.9, (120, 190, 255)), (233.0, (30, 70, 210)),
    (228.0, (40, 190, 60)), (223.0, (250, 240, 60)),
    (218.0, (255, 150, 20)), (213.0, (225, 25, 25)),
    (205.0, (125, 0, 35)), (199.0, (235, 90, 235)), (185.0, (255, 255, 255)),
])
IR_GREY = ramp([(330.0, (0, 0, 0)), (180.0, (255, 255, 255))])
# Shortwave infrared: grey, with hot spots running red to yellow.
SWIR = ramp([
    (200.0, (255, 255, 255)), (300.0, (40, 40, 40)), (318.0, (10, 10, 10)),
    (320.0, (150, 0, 0)), (335.0, (255, 60, 0)), (350.0, (255, 200, 0)), (380.0, (255, 255, 200)),
])
# Water vapour: dry air warm and brown, moist air white, high and cold blue-green.
WATER_VAPOUR = ramp([
    (290.0, (20, 12, 4)), (268.0, (120, 60, 15)), (256.0, (205, 150, 70)),
    (248.0, (225, 225, 225)), (238.0, (255, 255, 255)), (228.0, (110, 200, 255)),
    (218.0, (30, 110, 210)), (208.0, (20, 160, 60)), (195.0, (230, 230, 60)), (180.0, (240, 60, 60)),
])


def band_image(role: str, v: np.ndarray) -> np.ndarray:
    """One band as 0-1 RGB."""
    if role in REFLECTIVE:
        g = np.sqrt(np.clip(v, 0.0, 1.05) / 1.05)
        return rgb(g, g, g)
    if role == "i039":
        return SWIR(v)
    if role in ("w062", "w069", "w073"):
        return WATER_VAPOUR(v)
    return IR_ENHANCED(v)


def band_legend(role: str) -> Optional[dict]:
    if role in REFLECTIVE:
        return {"units": "%", "stops": [[0, "#000000"], [25, "#7f7f7f"], [100, "#ffffff"]]}
    table = SWIR if role == "i039" else WATER_VAPOUR if role in ("w062", "w069", "w073") else IR_ENHANCED
    stops = sorted(table.stops, key=lambda s: -s[0])  # type: ignore[attr-defined]
    return {"units": "°C", "stops": [[round(t - 273.15, 1), "#%02x%02x%02x" % c] for t, c in stops]}


# ---------------------------------------------------------------------------
# RGB composites
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Recipe:
    id: str
    label: str
    group: str                     # RGB_DAY, RGB_ALL, RGB_NIGHT, RGB_SPECIALTY
    roles: tuple[str, ...]
    draw: Callable[[dict[str, np.ndarray], Optional[np.ndarray]], np.ndarray]
    note: str
    needs_sun: bool = False
    # Imagers that cannot make it (a band they do not carry).
    alt_roles: dict = field(default_factory=dict)


def _green(v: dict[str, np.ndarray]) -> np.ndarray:
    """ABI has no green band; AHI and FCI do. The ABI stand-in is CIRA's
    hybrid (45% red, 45% blue, 10% veggie); a real green gets a touch of the
    veggie band, as JMA does, so land is not too dull."""
    if "g051" in v:
        return 0.93 * v["g051"] + 0.07 * v["n086"]
    return 0.45 * v["r064"] + 0.45 * v["b047"] + 0.10 * v["n086"]


def _true_colour(v, sza):
    r = sunz_correct(v["r064"], sza)
    g = sunz_correct(_green(v), sza)
    b = sunz_correct(v["b047"], sza)
    # Scattering by the air brightens blue most; take a little off each band.
    r, g, b = r - 0.015, g - 0.03, b - 0.06
    return rgb(cira_stretch(r), cira_stretch(g), cira_stretch(b))


def _false_colour(v, sza):
    return rgb(stretch(pct(sunz_correct(v["n086"], sza)), 0, 100, 1.5),
               stretch(pct(sunz_correct(v["r064"], sza)), 0, 100, 1.5),
               stretch(pct(sunz_correct(_green(v), sza)), 0, 100, 1.5))


def _sandwich(v, sza):
    vis = np.sqrt(np.clip(sunz_correct(v["r064"], sza), 0, 1))
    grey = rgb(vis, vis, vis)
    colour = IR_ENHANCED(v["i103"])
    # Colour where the tops are cold, over the visible texture: the updraft and
    # its temperature at once. A fifth of the infrared stays where the sun is low.
    w = np.clip((243.0 - np.nan_to_num(v["i103"], nan=300.0)) / 12.0, 0.0, 1.0)[..., None] * 0.7
    shade = (0.2 + 0.8 * vis)[..., None]
    day = grey * (1 - w) + colour * w * shade
    # With no sun there is no texture to lay it over: the plain enhanced
    # infrared, faded in across the terminator.
    fade = day_fade(sza)
    if fade is None:
        return day
    return day * fade[..., None] + colour * (1 - fade[..., None])


def _geocolor(v, sza):
    """Day: true colour. Night: cloud tops from the clean IR band, low cloud
    and fog from the 10.3 - 3.9 difference, over a dark ground. Blended across
    the terminator (78-88 degrees, as CIRA's GeoColor)."""
    day = _true_colour(v, sza)
    t = v["i103"]
    high = stretch(t, 280.0, 220.0, 1.0)
    low = stretch(t - v["i039"], 1.0, 5.0) * (t > 250)
    base = np.dstack([np.full_like(t, 0.03), np.full_like(t, 0.05), np.full_like(t, 0.12)])
    lowc = np.dstack([0.55 * low, 0.62 * low, 0.75 * low])
    night = base + lowc * (1 - high[..., None])
    night = night * (1 - high[..., None]) + high[..., None] * 0.95
    if sza is None:
        return day
    w = np.clip((88.0 - sza) / 10.0, 0.0, 1.0)[..., None]
    return day * w + night * (1 - w)


def _day_microphysics(v, sza):
    r39 = refl39(v["i039"], v["i103"], sza)
    return rgb(stretch(pct(sunz_correct(v["n086"], sza)), 0, 100),
               stretch(pct(r39), 0, 60, 2.5),
               stretch(v["i103"], 203, 323))


def _fog_low_stratus(v, sza):
    d = v["i103"] - v["i039"]
    return rgb(stretch(d, -2.0, 6.0), stretch(d, 0.5, 6.5), stretch(v["i103"], 243.0, 293.0, 1.0) * 0.55)


def _rocket(v, sza):
    blue_day = stretch(pct(v["r064"]), 0, 80)
    blue_night = stretch(pct(v["s161"]), 0, 80)
    w = day_fade(sza)
    blue = blue_day if w is None else blue_day * w + blue_night * (1 - w)
    return rgb(stretch(v["i039"], 273, 338), stretch(v["w062"], 233, 253), blue)


def _precipitating(v, sza):
    """Deep, raining cloud from the water-vapour and window channels: the 6.2 -
    10.3 difference goes positive where the tops reach the upper troposphere,
    the 7.3 - 6.2 difference shows the moist column, and the window marks the
    coldest cores."""
    return rgb(stretch(v["w062"] - v["i103"], -12.0, 2.0),
               stretch(v["i103"], 250.0, 205.0),
               stretch(v["w073"] - v["w062"], 2.0, 25.0))


RECIPES: dict[str, Recipe] = {r.id: r for r in [
    Recipe("true_color", "True Color", "RGB_DAY", ("r064", "b047", "n086"), _true_colour,
           "The scene as the eye sees it. On ABI the green is made from the red, blue and veggie bands. Daytime only.",
           needs_sun=True),
    Recipe("false_color", "False Color", "RGB_DAY", ("n086", "r064", "b047"), _false_colour,
           "Colour infrared: healthy vegetation red, water black, snow and ice blue-white, burn scars maroon. Daytime only.",
           needs_sun=True),
    Recipe("natural_color", "Natural Color", "RGB_DAY", ("s161", "n086", "r064"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["s161"], s)), 0, 120, 1.8),
                            stretch(pct(sunz_correct(v["n086"], s)), 0, 120, 1.8),
                            stretch(pct(sunz_correct(v["r064"], s)), 0, 120, 1.8)),
           "Day Land Cloud: snow and ice cyan, vegetation green, bare ground brown, water cloud white. Daytime only.",
           needs_sun=True),
    Recipe("day_land_cloud_fire", "Day Land Cloud Fire", "RGB_DAY", ("p224", "n086", "r064"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["p224"], s)), 0, 100),
                            stretch(pct(sunz_correct(v["n086"], s)), 0, 100),
                            stretch(pct(sunz_correct(v["r064"], s)), 0, 100)),
           "Natural colour with the 2.2 um band in red: active fires glow red, burn scars dark. Daytime only.",
           needs_sun=True),
    Recipe("day_cloud_phase_distinction", "Day Cloud Phase Distinction", "RGB_DAY", ("i103", "r064", "s161"),
           lambda v, s: rgb(stretch(v["i103"], 280.7, 219.6),
                            stretch(pct(sunz_correct(v["r064"], s)), 0, 78),
                            stretch(pct(sunz_correct(v["s161"], s)), 1, 59)),
           "Water cloud cyan and green, glaciating tops yellow, ice red: where towers turn to ice first. Daytime only.",
           needs_sun=True),
    Recipe("day_cloud_type", "Day Cloud Type", "RGB_DAY", ("c137", "r064", "s161"),
           lambda v, s: rgb(stretch(pct(v["c137"]), 0, 10, 1.5),
                            stretch(pct(sunz_correct(v["r064"], s)), 0, 78),
                            stretch(pct(sunz_correct(v["s161"], s)), 0, 59)),
           "Thin cirrus red, thick ice cloud yellow, low water cloud cyan, lofted water cloud white. Daytime only.",
           needs_sun=True),
    Recipe("day_snow_fog", "Day Snow-Fog", "RGB_DAY", ("n086", "s161", "i039", "i103"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["n086"], s)), 0, 100, 1.7),
                            stretch(pct(sunz_correct(v["s161"], s)), 0, 70, 1.7),
                            stretch(v["i039"] - v["i103"], 0, 30, 1.7)),
           "Snow red-orange, fog and low cloud yellow-white, ice cloud pink. Daytime only.",
           needs_sun=True),
    Recipe("day_convection", "Day Convection", "RGB_DAY", ("w062", "w073", "i039", "i103", "s161", "r064"),
           lambda v, s: rgb(stretch(v["w062"] - v["w073"], -35, 5),
                            stretch(v["i039"] - v["i103"], -5, 60, 0.5),
                            stretch(pct(v["s161"] - v["r064"]), -75, 25)),
           "Strong updrafts with small ice particles bright yellow: the storms likely severe. Daytime only.",
           needs_sun=True),
    Recipe("day_microphysics", "Day Microphysics", "RGB_DAY", ("n086", "i039", "i103"), _day_microphysics,
           "Small water droplets green, large droplets and ice blue to magenta; the green is the reflected part "
           "of the 3.9 um band. Daytime only.", needs_sun=True),
    Recipe("cloud_phase_eumetsat", "Cloud Phase (EUMETSAT)", "RGB_DAY", ("s161", "p224", "r064"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["s161"], s)), 0, 50),
                            stretch(pct(sunz_correct(v["p224"], s)), 0, 50),
                            stretch(pct(sunz_correct(v["r064"], s)), 0, 100)),
           "Ice cloud blue, thick water cloud white to yellow, small droplets cyan. Daytime only.", needs_sun=True),
    Recipe("sandwich", "Sandwich", "RGB_DAY", ("r064", "i103"), _sandwich,
           "Cold cloud tops coloured over the visible texture: the updraft and its temperature in one picture.",
           needs_sun=True),
    Recipe("overview", "Overview", "RGB_DAY", ("r064", "n086", "i112"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["r064"], s)), 0, 100, 1.6),
                            stretch(pct(sunz_correct(v["n086"], s)), 0, 100, 1.6),
                            stretch(v["i112"], 323, 203, 1.6)),
           "Visible, veggie and inverted infrared: cold tops blue-white, low cloud yellowish, land dark green. "
           "Daytime only.", needs_sun=True),
    Recipe("geo_color", "GeoColor", "RGB_ALL", ("r064", "b047", "n086", "i103", "i039"), _geocolor,
           "True colour by day, infrared cloud by night, blended across the terminator.", needs_sun=True),
    Recipe("air_mass", "Air Mass", "RGB_ALL", ("w062", "w073", "i096", "i103"),
           lambda v, s: rgb(stretch(v["w062"] - v["w073"], -26.2, 0.6),
                            stretch(v["i096"] - v["i103"], -43.2, 6.7),
                            stretch(v["w062"], 243.9, 208.5)),
           "Dry stratospheric air red (jets, potential-vorticity lobes), tropical air green, polar air purple."),
    Recipe("tropical_airmass", "Tropical Airmass", "RGB_ALL", ("w062", "w073", "i096", "i103"),
           lambda v, s: rgb(stretch(v["w073"] - v["w062"], 26.2, 0.6),
                            stretch(v["i103"] - v["i096"], 27.4, -26.2),
                            stretch(v["w062"], 243.9, 208.5)),
           "The Air Mass RGB tuned for the tropics, where the standard one turns everything green."),
    Recipe("dust", "Dust", "RGB_ALL", ("i123", "i103", "i112", "i086"),
           lambda v, s: rgb(stretch(v["i123"] - v["i103"], -6.7, 2.6),
                            stretch(v["i112"] - v["i086"], -0.5, 20.0, 2.5),
                            stretch(v["i103"], 261.2, 288.7)),
           "Dust and sand magenta, thick high cloud dark red, thin cirrus black."),
    Recipe("dust_cvd", "Dust (CVD)", "RGB_ALL", ("i123", "i103", "i112", "i086"),
           lambda v, s: rgb(stretch(v["i123"] - v["i103"], -6.7, 2.6),
                            stretch(v["i103"], 261.2, 288.7),
                            stretch(v["i112"] - v["i086"], -0.5, 20.0, 2.5)),
           "The Dust RGB with its green and blue swapped, for colour-blind eyes: dust yellow instead of magenta."),
    Recipe("ash", "Volcanic Ash", "RGB_ALL", ("i123", "i103", "i112", "i086"),
           lambda v, s: rgb(stretch(v["i123"] - v["i103"], -6.7, 2.6),
                            stretch(v["i112"] - v["i086"], -6.0, 6.3),
                            stretch(v["i103"], 243.6, 302.4)),
           "Ash red to pink, SO2 green, thick ice cloud brown."),
    Recipe("so2", "SO₂", "RGB_ALL", ("w069", "w073", "i103", "i086"),
           lambda v, s: rgb(stretch(v["w069"] - v["w073"], -4.0, 2.0),
                            stretch(v["i103"] - v["i086"], -4.0, 5.0),
                            stretch(v["i103"], 243.05, 302.95)),
           "Volcanic sulphur dioxide bright green-yellow."),
    Recipe("fire_temperature", "Fire Temperature", "RGB_ALL", ("i039", "p224", "s161"),
           lambda v, s: rgb(stretch(v["i039"], 273.15, 333.15, 0.4),
                            stretch(pct(v["p224"]), 0, 100),
                            stretch(pct(v["s161"]), 0, 75)),
           "Fires red when cool, orange to yellow to white as they burn hotter."),
    Recipe("microphysics_24hr", "24-Hour Microphysics", "RGB_ALL", ("i123", "i103", "i086"),
           lambda v, s: rgb(stretch(v["i123"] - v["i103"], -4.0, 2.0),
                            stretch(v["i103"] - v["i086"], 0.0, 6.0, 1.2),
                            stretch(v["i103"], 248.0, 303.0)),
           "Cloud phase and particle size day and night: thick high cloud red-brown, low cloud pale, thin cirrus dark."),
    Recipe("precipitating_clouds", "Precipitating Clouds", "RGB_ALL", ("w062", "w073", "i103"), _precipitating,
           "Raining and deep convective cloud red to orange, glaciated anvils green, moist cloudy columns blue, "
           "clear dry air near black."),
    Recipe("simple_water_vapor", "Simple Water Vapor", "RGB_ALL", ("i103", "w062", "w073"),
           lambda v, s: rgb(stretch(v["i103"], 279.0, 202.3, 10.0),
                            stretch(v["w062"], 242.7, 214.7, 5.5),
                            stretch(v["w073"], 261.0, 245.1, 5.5)),
           "Moisture at three levels at once: high cloud white, mid-level moisture green, dry air dark."),
    Recipe("differential_water_vapor", "Differential Water Vapor", "RGB_ALL", ("w073", "w062"),
           lambda v, s: rgb(stretch(v["w073"] - v["w062"], 30.0, -3.0, 3.5),
                            stretch(v["w073"], 278.15, 213.15, 2.5),
                            stretch(v["w062"], 243.9, 208.5, 2.5)),
           "Upper and lower water vapour compared: dry air orange, moist air blue-white."),
    Recipe("nighttime_microphysics", "Nighttime Microphysics", "RGB_NIGHT", ("i123", "i103", "i039"),
           lambda v, s: rgb(stretch(v["i123"] - v["i103"], -6.7, 2.6),
                            stretch(v["i103"] - v["i039"], -3.1, 5.2),
                            stretch(v["i103"], 243.55, 292.65)),
           "Fog and low stratus aqua, thin cirrus dark blue, deep cold cloud red. For the night."),
    Recipe("fog_low_stratus", "Fog and Low Stratus", "RGB_NIGHT", ("i103", "i039"), _fog_low_stratus,
           "Fog and low stratus yellow to cream, high cold cloud orange-brown. Most useful before sunrise."),
    Recipe("blowing_snow", "Blowing Snow", "RGB_SPECIALTY", ("r064", "s161", "i039", "i103"),
           lambda v, s: rgb(stretch(pct(sunz_correct(v["r064"], s)), 0, 50, 0.7),
                            stretch(pct(sunz_correct(v["s161"], s)), 2, 20),
                            stretch(v["i039"] - v["i103"], 0, 30, 0.7)),
           "Lofted blowing snow apart from snow on the ground and cloud. Daytime only.", needs_sun=True),
    Recipe("rocket_plume", "Rocket Plume", "RGB_SPECIALTY", ("i039", "w062", "r064", "s161"), _rocket,
           "Rocket exhaust and other hot plumes lofted high: shortwave IR, upper water vapour and a visible or 1.6 um band.",
           needs_sun=True),
]}

RGB_ORDER = [
    "true_color", "false_color", "natural_color", "day_land_cloud_fire", "day_cloud_phase_distinction",
    "day_cloud_type", "day_snow_fog", "day_convection", "day_microphysics", "cloud_phase_eumetsat", "sandwich",
    "overview", "geo_color", "air_mass", "tropical_airmass", "dust", "dust_cvd", "ash", "so2", "fire_temperature",
    "microphysics_24hr", "precipitating_clouds", "simple_water_vapor", "differential_water_vapor",
    "nighttime_microphysics", "fog_low_stratus", "blowing_snow", "rocket_plume",
]


def night_alpha(rid: str, sza: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """Where a daytime-only RGB has no sun, it is left open (as EUMETSAT's own
    day RGBs are) rather than drawn as a sheet of one colour. The sandwich and
    GeoColor carry their own night."""
    r = RECIPES[rid]
    if r.group != "RGB_DAY" or rid in ("sandwich", "geo_color") or sza is None:
        return None
    return np.clip((100.0 - sza) / 8.0, 0.0, 1.0)


def recipe_roles(rid: str, roles_available: set[str]) -> Optional[tuple[str, ...]]:
    """The bands a recipe needs from this imager, or None when it lacks one.
    True colour's green comes from AHI's own green band where there is one."""
    r = RECIPES[rid]
    need = set(r.roles)
    if rid in ("true_color", "false_color", "geo_color") and "g051" in roles_available:
        need |= {"g051"}
    return tuple(sorted(need)) if need <= roles_available else None


# ---------------------------------------------------------------------------
# GOES-R Level 2 products
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class L2:
    id: str
    label: str
    folder: str            # ABI-L2-<folder><sector letter>
    var: str
    sectors: str           # which sector letters publish it: C, F, M
    units: str
    kind: str              # "scale" or "category"
    lo: float = 0.0
    hi: float = 1.0
    scale: float = 1.0     # multiply the file's value by this for display units
    offset: float = 0.0
    stops: tuple = ()      # (value, hex) for scales; (value, hex, label) for categories
    log: bool = False
    note: str = ""
    layer: Optional[int] = None


_RAINBOW = (("#1a0033", 0.0), ("#3a2fb5", 0.12), ("#1f78d1", 0.25), ("#15b0b0", 0.38), ("#2fbf4a", 0.5),
            ("#b5d82a", 0.62), ("#f5d31a", 0.72), ("#f58b1a", 0.84), ("#d6241f", 0.93), ("#f3c6f5", 1.0))


def _spread(lo: float, hi: float, table=_RAINBOW) -> tuple:
    return tuple((round(lo + (hi - lo) * f, 3), c) for c, f in table)


_TEMP = (("#2c0f5e", 0.0), ("#3452c9", 0.2), ("#2fa6d6", 0.35), ("#48c26b", 0.5), ("#e8e23a", 0.65),
         ("#f39c1f", 0.8), ("#d7301f", 0.92), ("#7a0010", 1.0))
_MOIST = (("#8c5a2b", 0.0), ("#d8b365", 0.15), ("#f6e8c3", 0.3), ("#c7eae5", 0.45), ("#5ab4ac", 0.6),
          ("#2c7fb8", 0.75), ("#253494", 0.9), ("#7b1fa2", 1.0))
_GREYS = (("#202020", 0.0), ("#ffffff", 1.0))
_FIRE = (("#fff5b0", 0.0), ("#ffd23f", 0.3), ("#ff8c1a", 0.55), ("#e8311f", 0.8), ("#7a0010", 1.0))

L2_PRODUCTS: dict[str, L2] = {p.id: p for p in [
    L2("cloud_top_height", "Cloud Top Height", "ACHA", "HT", "CFM", "km", "scale", 0, 18, 0.001,
       stops=_spread(0, 18), note="Height of the cloud tops from the ABI's infrared bands."),
    L2("cloud_top_pressure", "Cloud Top Pressure", "CTP", "PRES", "CF", "hPa", "scale", 100, 1000,
       stops=tuple(reversed(_spread(100, 1000))), note="Pressure at the cloud tops; low numbers are high tops."),
    L2("cloud_top_phase", "Cloud Top Phase", "ACTP", "Phase", "CFM", "", "category",
       stops=((1, "#2b83ba", "Liquid"), (2, "#00c9c9", "Supercooled liquid"), (3, "#7fd13b", "Mixed"),
              (4, "#f5f5f5", "Ice"), (5, "#8c8c8c", "Unknown")),
       note="What the cloud tops are made of."),
    L2("clear_sky_mask", "Clear Sky Mask", "ACM", "ACM", "CFM", "", "category",
       stops=((1, "#6e8b3d", "Probably clear"), (2, "#bdbdbd", "Probably cloudy"), (3, "#ffffff", "Cloudy")),
       note="Where the ABI sees cloud; clear sky left open."),
    L2("cloud_probability", "Cloud Probability", "ACM", "Cloud_Probabilities", "CFM", "%", "scale", 0, 100, 100.0,
       stops=_spread(0, 100, _GREYS), note="Chance each pixel is cloudy."),
    L2("total_cloud_fraction", "Total Cloud Fraction", "CCL", "TCF", "CFM", "%", "scale", 0, 100, 100.0,
       stops=_spread(0, 100, _GREYS), note="Share of each 10 km box covered by cloud."),
    L2("cloud_layer_flag", "Cloud Layer Flag", "CCL", "CL", "CFM", "", "category",
       stops=((1, "#2b83ba", "Below 5,000 ft"), (2, "#4fb3a9", "5,000-10,000 ft"), (3, "#b5d82a", "10,000-18,000 ft"),
              (4, "#f5b31a", "18,000-24,000 ft"), (5, "#e8311f", "Above 24,000 ft"), (6, "#f3c6f5", "More than one layer")),
       note="Which of the five layers hold cloud in each 10 km box: a single layer by its height, several in pink."),
    *[L2(f"cloud_fraction_layer_{k}", f"Cloud Fraction Layer {k}", "CCL", f"CF{k}", "CFM", "%", "scale", 0, 100,
         stops=_spread(0, 100, _GREYS), layer=k,
         note=["Surface to 5,000 ft", "5,000-10,000 ft", "10,000-18,000 ft", "18,000-24,000 ft",
               "24,000 ft to the top of the atmosphere"][k - 1] + " (above sea level): cloud cover in the layer.")
      for k in range(1, 6)],
    L2("fire_mask", "Fire Detection Mask", "FDC", "Mask", "CFM", "", "category",
       stops=((10, "#ff0000", "Good fire"), (11, "#ff00ff", "Saturated fire"), (12, "#ffa500", "Cloud-contaminated fire"),
              (13, "#ff4500", "High-probability fire"), (14, "#ffd700", "Medium-probability fire"),
              (15, "#ffff80", "Low-probability fire")),
       note="Fire pixels by confidence (the temporally filtered ones fold in)."),
    L2("fire_power", "Fire Radiative Power", "FDC", "Power", "CFM", "MW", "scale", 1, 1000, log=True,
       stops=((1, "#fff5b0"), (10, "#ffd23f"), (50, "#ff8c1a"), (200, "#e8311f"), (1000, "#7a0010")),
       note="Energy the fire radiates."),
    L2("fire_temperature", "Fire Temperature", "FDC", "Temp", "CFM", "K", "scale", 400, 1200,
       stops=_spread(400, 1200, _FIRE), note="Temperature of the burning part of each fire pixel."),
    L2("fire_area", "Fire Area", "FDC", "Area", "CFM", "km²", "scale", 0.001, 4, 1e-6, log=True,
       stops=((0.001, "#fff5b0"), (0.01, "#ffd23f"), (0.1, "#ff8c1a"), (1, "#e8311f"), (4, "#7a0010")),
       note="Area of the burning part of each fire pixel."),
    L2("cape", "CAPE", "DSI", "CAPE", "CFM", "J/kg", "scale", 0, 5000,
       stops=((0, "#00000000"), (100, "#2b83ba"), (500, "#4fb3a9"), (1000, "#7fd13b"), (2000, "#f5d31a"),
              (3000, "#f58b1a"), (4000, "#d6241f"), (5000, "#b012b0")),
       note="Convective available potential energy retrieved in clear air."),
    L2("lifted_index", "Lifted Index", "DSI", "LI", "CFM", "°C", "scale", -12, 12,
       stops=((-12, "#b012b0"), (-8, "#d6241f"), (-5, "#f58b1a"), (-2, "#f5d31a"), (0, "#e0e0e0"), (4, "#4fb3a9"),
              (12, "#2b3ba5")), note="Negative is unstable."),
    L2("total_totals", "Total Totals Index", "DSI", "TT", "CFM", "°C", "scale", 30, 70,
       stops=_spread(30, 70, _TEMP), note="Above 50 thunderstorms likely, above 55 severe."),
    L2("k_index", "K-Index", "DSI", "KI", "CFM", "°C", "scale", 0, 45,
       stops=_spread(0, 45, _TEMP), note="Air-mass thunderstorm potential; above 35 numerous storms."),
    L2("showalter_index", "Showalter Index", "DSI", "SI", "CFM", "°C", "scale", -10, 10,
       stops=((-10, "#b012b0"), (-6, "#d6241f"), (-3, "#f58b1a"), (0, "#f5d31a"), (3, "#e0e0e0"), (10, "#2b3ba5")),
       note="Stability of air lifted from 850 hPa; negative is unstable."),
    L2("tpw", "Total Precipitable Water", "TPW", "TPW", "CFM", "mm", "scale", 0, 70,
       stops=_spread(0, 70, _MOIST), note="Water in the whole column of clear air."),
    L2("aod", "Aerosol Optical Depth", "AOD", "AOD", "CF", "", "scale", 0, 2,
       stops=((0, "#2b83ba"), (0.2, "#7fd13b"), (0.5, "#f5d31a"), (1, "#f58b1a"), (2, "#8b1a1a")),
       note="Haze, smoke and dust in the column. Daytime."),
    L2("smoke", "Smoke Detection", "ADP", "Smoke", "CFM", "", "category",
       stops=((1, "#9e9ac8", "Smoke"),), note="Where the aerosol product finds smoke. Daytime."),
    L2("dust_detection", "Dust Detection", "ADP", "Dust", "CFM", "", "category",
       stops=((1, "#d8a15c", "Dust"),), note="Where the aerosol product finds dust."),
    L2("lst", "Land Surface Temperature", "LST", "LST", "CFM", "°C", "scale", -30, 60, 1.0, -273.15,
       stops=_spread(-30, 60, _TEMP), note="Skin temperature of clear land (hourly over CONUS)."),
    L2("land_surface_albedo", "Land Surface Albedo", "LSA", "LSA", "CFM", "", "scale", 0, 0.6,
       stops=_spread(0, 0.6, _GREYS), note="Share of sunlight the ground reflects. Daytime."),
    L2("snow_cover", "Snow Cover", "FSC", "FSC", "CFM", "%", "scale", 0, 100,
       stops=((0, "#00000000"), (1, "#c6dbef"), (50, "#6baed6"), (100, "#ffffff")),
       note="Fraction of each pixel covered by snow (hourly over CONUS)."),
]}


def l2_colour(p: L2, values: np.ndarray) -> np.ndarray:
    """RGBA uint8 for an L2 field in display units; NaN transparent."""
    out = np.zeros(values.shape + (4,), dtype="uint8")
    finite = np.isfinite(values)
    if p.kind == "category":
        for stop in p.stops:
            val, col = stop[0], stop[1]
            sel = finite & (np.rint(values) == val)
            r, g, b = hexrgb(col)
            out[sel] = (r, g, b, 235)
        return out
    xs = np.array([s[0] for s in p.stops], dtype="float64")
    cols = [s[1] for s in p.stops]
    rgba = np.array([[*hexrgb(c[:7]), int(c[7:9], 16) if len(c) == 9 else 255] for c in cols], dtype="float32")
    v = np.nan_to_num(values, nan=float(xs[0]))
    if p.log:
        xs_t = np.log10(np.maximum(xs, 1e-9))
        v_t = np.log10(np.maximum(v, 1e-9))
    else:
        xs_t, v_t = xs, v
    for c in range(4):
        out[..., c] = np.interp(v_t, xs_t, rgba[:, c]).astype("uint8")
    out[~finite] = 0
    return out


def l2_legend(p: L2) -> dict:
    if p.kind == "category":
        return {"units": p.units, "categories": [[s[2], s[1]] for s in p.stops]}
    return {"units": p.units, "stops": [[s[0], s[1][:7]] for s in p.stops], "log": p.log}


L2_ORDER = list(L2_PRODUCTS)
