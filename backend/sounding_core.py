"""
Sounding core: fetch a vertical profile (Open-Meteo pressure levels) at an
arbitrary lat/lon for a model + forecast hour, run it through SHARPpy, and
return a JSON-ready dict (levels + parcel path + full parameter suite).

The JSON diagnostics use SHARPpy's computation core, and the viewer image is
rendered with SHARPpy's official Qt SPCWidget template.
"""
from __future__ import annotations

import base64
import math
import time
import warnings
from typing import Any, Optional

import numpy as np


class _SkipRender(Exception):
    """Not an error: the caller asked for parameters without the plot."""

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

warnings.filterwarnings("ignore", message="Warning: converting a masked element to nan.")

import sharppy.sharptab.profile as profile
import sharppy.sharptab.params as params
import sharppy.sharptab.interp as interp
import sharppy.sharptab.winds as winds
import sharppy.sharptab.thermo as thermo
import sharppy.sharptab.utils as sputils

# ---------------------------------------------------------------------------
# Model registry: our id -> Open-Meteo model + presentation metadata.
# ---------------------------------------------------------------------------
# Every entry below has been verified to actually return an Open-Meteo
# pressure-level profile (temperature / RH / wind / geopotential at multiple
# hPa levels). Models Open-Meteo lists but that expose *no* upper-air data
# (GraphCast, base AIFS, AROME-HD, HARMONIE direct, MeteoSwiss ICON-CH,
# BOM ACCESS-G, ...) are intentionally omitted — they cannot produce a
# sounding. `fallback` chains a regional model down to the next-best-resolution
# (and ultimately a global) model so any point on Earth — land, Europe, or the
# open ocean — still resolves to something.
MODELS: dict[str, dict[str, Any]] = {
    "auto": {
        "om": "best_match",
        "label": "Auto / Best",
        "group": "Recommended",
    },

    # ---- Global (cover the whole world, including mid-ocean) --------------
    "gfs": {
        "om": "gfs_seamless",
        "label": "GFS (NOAA)",
        "group": "Global",
    },
    "ecmwf": {
        "om": "ecmwf_ifs025",
        "label": "ECMWF IFS",
        "group": "Global",
    },
    "ecmwf_aifs": {
        "om": "ecmwf_aifs025_single",
        "label": "ECMWF AIFS (AI)",
        "group": "Global",
        "fallback": "ecmwf",
    },
    "icon": {
        "om": "icon_seamless",
        "label": "ICON (DWD)",
        "group": "Global",
    },
    "gem": {
        "om": "gem_seamless",
        "label": "GEM (Canada)",
        "group": "Global",
    },
    "ukmo": {
        "om": "ukmo_seamless",
        "label": "UKMO (Met Office)",
        "group": "Global",
    },
    "arpege": {
        "om": "meteofrance_seamless",
        "label": "ARPEGE (Météo-France)",
        "group": "Global",
    },
    "jma": {
        "om": "jma_seamless",
        "label": "JMA GSM (Japan)",
        "group": "Global",
    },
    "cma": {
        "om": "cma_grapes_global",
        "label": "CMA GRAPES (China)",
        "group": "Global",
    },

    # ---- United States (convection-allowing) -----------------------------
    "hrrr": {
        "om": "gfs_hrrr",
        "label": "HRRR (3 km)",
        "group": "United States",
        "fallback": "gfs",
    },

    # ---- Europe ----------------------------------------------------------
    "icon_eu": {
        "om": "icon_eu",
        "label": "ICON-EU (7 km)",
        "group": "Europe",
        "fallback": "icon",
    },
    "icon_d2": {
        "om": "icon_d2",
        "label": "ICON-D2 (2 km)",
        "group": "Europe",
        "fallback": "icon_eu",
    },
    "arpege_eu": {
        "om": "meteofrance_arpege_europe",
        "label": "ARPEGE-EU (11 km)",
        "group": "Europe",
        "fallback": "arpege",
    },
    "arome_fr": {
        "om": "meteofrance_arome_france",
        "label": "AROME France (1.3 km)",
        "group": "Europe",
        "fallback": "arpege_eu",
    },
    "ukmo_uk": {
        "om": "ukmo_uk_deterministic_2km",
        "label": "UKMO UK (2 km)",
        "group": "Europe",
        "fallback": "ukmo",
    },
    "knmi": {
        "om": "knmi_seamless",
        "label": "HARMONIE KNMI (NL)",
        "group": "Europe",
        "fallback": "icon_eu",
    },
    "dmi": {
        "om": "dmi_seamless",
        "label": "HARMONIE DMI (DK)",
        "group": "Europe",
        "fallback": "icon_eu",
    },
    "icon_2i": {
        "om": "italia_meteo_arpae_icon_2i",
        "label": "ICON-2I (Italy)",
        "group": "Europe",
        "fallback": "icon_eu",
    },

    # ---- North America (regional) ----------------------------------------
    "gem_regional": {
        "om": "gem_regional",
        "label": "GEM Regional (10 km)",
        "group": "North America",
        "fallback": "gem",
    },
    "hrdps": {
        "om": "gem_hrdps_continental",
        "label": "HRDPS (2.5 km)",
        "group": "North America",
        "fallback": "gem_regional",
    },

    # ---- Asia-Pacific (regional) -----------------------------------------
    "jma_msm": {
        "om": "jma_msm",
        "label": "JMA MSM (5 km)",
        "group": "Asia-Pacific",
        "fallback": "jma",
    },
}
DEFAULT_MODEL = "auto"

# Pressure levels Open-Meteo exposes (hPa), surface -> top.
OM_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500,
             400, 300, 250, 200, 150, 100, 70, 50, 30]

MISSING = -9999.0
KT2MS = 0.5144444  # SHARPpy composite indices (STP/SCP) want shear in m/s


class NetworkError(RuntimeError):
    """Open-Meteo was unreachable (DNS/connect/timeout after retries). Distinct
    from a per-location 'no data' error so the model fallback chain can skip it
    instead of retrying every model against the same unreachable host."""

# Simple in-memory TTL cache of raw Open-Meteo responses, keyed by
# (lat,lon,model) so scrubbing forecast hours doesn't refetch every step.
_CACHE: dict[tuple, tuple[float, dict]] = {}
_RESULT_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 600.0  # seconds

# Open-Meteo is reached over the public internet, so a single transient DNS
# hiccup or connect timeout shouldn't surface as a hard error to the user.
# Retry connection/read failures and 5xx a few times with backoff; 4xx (e.g.
# "no data for this location") is NOT retried so the model-fallback path stays
# fast. connect timeout is short so a stuck attempt fails over quickly.
_HTTP_TIMEOUT = (8, 30)  # (connect, read) seconds
_SESSION = requests.Session()
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=4,
            connect=4,
            read=3,
            backoff_factor=0.6,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
            respect_retry_after_header=True,
        )
    ),
)


def list_models() -> list[dict[str, str]]:
    return [{"id": k, "label": v["label"], "group": v["group"]} for k, v in MODELS.items()]


def _in_hrrr_domain(lat: float, lon: float) -> bool:
    """Approximate Open-Meteo HRRR CONUS availability domain."""
    return 20.0 <= lat <= 55.0 and -135.0 <= lon <= -55.0


def _preflight_model(lat: float, lon: float, model: str) -> tuple[str, Optional[str]]:
    model = model if model in MODELS else DEFAULT_MODEL
    if model == "hrrr" and not _in_hrrr_domain(lat, lon):
        return "gfs", "HRRR is only available over the United States; using GFS for this point."
    return model, None


def _model_meta(requested: str, actual: str, fallback_reason: Optional[str]) -> dict[str, Any]:
    req = MODELS.get(requested, MODELS[DEFAULT_MODEL])
    act = MODELS.get(actual, MODELS[DEFAULT_MODEL])
    return {
        "requestedModel": requested,
        "requestedModelLabel": req["label"],
        "model": actual,
        "modelLabel": act["label"],
        "modelGroup": act["group"],
        "openMeteoModel": act["om"],
        "fallbackReason": fallback_reason,
    }


# ---------------------------------------------------------------------------
# Data fetch
# ---------------------------------------------------------------------------
def _om_fields() -> list[str]:
    fields = ["surface_pressure", "temperature_2m", "dew_point_2m",
              "wind_speed_10m", "wind_direction_10m"]
    for lv in OM_LEVELS:
        for base in ("temperature", "relative_humidity", "wind_speed",
                     "wind_direction", "geopotential_height"):
            fields.append(f"{base}_{lv}hPa")
    return fields


def _fetch_raw_model(lat: float, lon: float, model: str) -> dict:
    key = (round(lat, 3), round(lon, 3), model)
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    om = MODELS[model]["om"]
    try:
        resp = _SESSION.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "hourly": ",".join(_om_fields()),
                "models": om,
                "forecast_days": 4,
                "wind_speed_unit": "kn",
                "cell_selection": "nearest",
                "timeformat": "unixtime",
            },
            timeout=_HTTP_TIMEOUT,
        )
    except requests.exceptions.RequestException as exc:
        # Connection/DNS/timeout after retries. Every model shares this host, so
        # this is fatal for the whole request, not a per-model fallback trigger.
        raise NetworkError(
            "Could not reach Open-Meteo after several tries - check the internet "
            "connection and try again."
        ) from exc
    try:
        data = resp.json()
    except ValueError:
        resp.raise_for_status()
        raise RuntimeError("Open-Meteo returned a non-JSON response")
    if not resp.ok:
        if isinstance(data, dict) and data.get("reason"):
            raise RuntimeError(data["reason"])
        resp.raise_for_status()
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data.get("reason", "Open-Meteo error"))
    _CACHE[key] = (now, data)
    return data


def resolve_sounding_data(
    lat: float, lon: float, model: str
) -> tuple[dict, str, list[int], Optional[str]]:
    """Fetch a usable profile, walking the fallback chain until one works.

    A regional model returns HTTP 200 with all-null pressure fields outside its
    domain (e.g. HRRR / AROME over the open ocean), so "no valid hours" must
    trigger the fallback just like a hard error does. Returns
    (raw, actual_model, valid_hours, fallback_reason).
    """
    requested = model if model in MODELS else DEFAULT_MODEL
    actual, reason = _preflight_model(lat, lon, requested)

    tried: list[str] = []
    last_exc: Optional[Exception] = None
    current = actual
    while current is not None and current not in tried:
        tried.append(current)
        why: Optional[str] = None
        raw = None
        try:
            raw = _fetch_raw_model(lat, lon, current)
            valid_hours = _valid_hour_indices(raw)
            if valid_hours:
                return raw, current, valid_hours, reason
            why = f"{MODELS[current]['label']} has no vertical profile at this location"
        except NetworkError:
            # Unreachable host -> every fallback model would fail identically.
            raise
        except Exception as exc:  # noqa: BLE001 - try the fallback instead
            last_exc = exc
            why = f"{MODELS[current]['label']} is unavailable at this location ({exc})"

        fallback = MODELS[current].get("fallback")
        if fallback and fallback not in tried:
            reason = f"{why}; using {MODELS[fallback]['label']}."
        current = fallback

    if last_exc is not None:
        raise last_exc
    raise RuntimeError(
        "No forecast hours with enough valid sounding levels were returned for this point/model"
    )


# ---------------------------------------------------------------------------
# Profile assembly
# ---------------------------------------------------------------------------
def _dewpoint_from_rh(t: float, rh: float) -> float:
    rh = min(max(rh, 1.0), 100.0)
    a, b = 17.625, 243.04
    g = math.log(rh / 100.0) + a * t / (b + t)
    return b * g / (a - g)


def _valid(*vals) -> bool:
    for v in vals:
        if v is None:
            return False
        try:
            if not math.isfinite(float(v)):
                return False
        except (TypeError, ValueError):
            return False
    return True


def build_levels(raw: dict, hour_index: int) -> dict:
    """Assemble a surface->top level list for one forecast hour."""
    h = raw["hourly"]
    elevation = float(raw.get("elevation") or 0.0)
    i = hour_index

    def g(name):
        arr = h.get(name)
        if arr is None or i >= len(arr):
            return None
        return arr[i]

    levels: list[dict] = []

    # Surface level from 2 m / 10 m fields.
    sfc_p = g("surface_pressure")
    sfc_t = g("temperature_2m")
    sfc_td = g("dew_point_2m")
    sfc_ws = g("wind_speed_10m")
    sfc_wd = g("wind_direction_10m")
    if _valid(sfc_p, sfc_t):
        levels.append({
            "p": float(sfc_p),
            "h": elevation,
            "t": float(sfc_t),
            "td": float(sfc_td) if _valid(sfc_td) else float(sfc_t) - 3.0,
            "wd": float(sfc_wd) if _valid(sfc_wd) else 0.0,
            "ws": float(sfc_ws) if _valid(sfc_ws) else 0.0,
        })
    sfc_pressure = float(sfc_p) if _valid(sfc_p) else 1013.0

    for lv in OM_LEVELS:
        if lv >= sfc_pressure:  # skip below-ground / duplicate of surface
            continue
        t = g(f"temperature_{lv}hPa")
        rh = g(f"relative_humidity_{lv}hPa")
        gh = g(f"geopotential_height_{lv}hPa")
        ws = g(f"wind_speed_{lv}hPa")
        wd = g(f"wind_direction_{lv}hPa")
        if not _valid(t, gh):
            continue
        td = _dewpoint_from_rh(float(t), float(rh)) if _valid(rh) else float(t) - 5.0
        levels.append({
            "p": float(lv),
            "h": float(gh),
            "t": float(t),
            "td": td,
            "wd": float(wd) if _valid(wd) else 0.0,
            "ws": float(ws) if _valid(ws) else 0.0,
        })

    # Sort surface -> top (pressure descending), de-dupe, enforce monotonic height.
    levels.sort(key=lambda d: -d["p"])
    cleaned: list[dict] = []
    for lv in levels:
        if cleaned and lv["p"] >= cleaned[-1]["p"]:
            continue
        if cleaned and lv["h"] <= cleaned[-1]["h"]:
            continue
        cleaned.append(lv)

    times = h.get("time", [])
    valid_unix = times[i] if i < len(times) else None
    return {
        "levels": cleaned,
        "elevation": elevation,
        "valid_unix": valid_unix,
        "n_times": len(times),
        "times": times,
    }


def _valid_hour_indices(raw: dict) -> list[int]:
    cached = raw.get("__valid_hour_indices")
    if cached is not None:
        return cached

    n_times = len(raw.get("hourly", {}).get("time", []))
    valid = [idx for idx in range(n_times) if len(build_levels(raw, idx)["levels"]) >= 4]
    raw["__valid_hour_indices"] = valid
    return valid


def _nearest_valid_hour(valid_hours: list[int], requested_hour: int) -> int:
    before = [idx for idx in valid_hours if idx <= requested_hour]
    if before:
        return before[-1]
    return valid_hours[0]


def _append_notice(existing: Optional[str], notice: str) -> str:
    return f"{existing} {notice}" if existing else notice


# ---------------------------------------------------------------------------
# SHARPpy computation
# ---------------------------------------------------------------------------
def _num(v) -> Optional[float]:
    """Coerce a numpy/masked/inf value to a JSON-safe float or None."""
    try:
        if v is None:
            return None
        if isinstance(v, (tuple, list, np.ndarray)):
            return None
        f = float(v)
        if not math.isfinite(f):
            return None
        if abs(f) >= 9000.0 and abs(abs(f) - 9999.0) < 50.0:
            return None  # MISSING sentinel
        return round(f, 3)
    except (TypeError, ValueError):
        return None


def _dir_spd(u: float, v: float) -> tuple[Optional[float], Optional[float]]:
    try:
        fu, fv = float(u), float(v)
        # NaN never raises, so guard it explicitly -- otherwise a NaN Bunkers
        # motion (sparse-wind profiles) leaks a NaN into the JSON payload and
        # FastAPI's json.dumps rejects it with a 500.
        if not (math.isfinite(fu) and math.isfinite(fv)):
            return None, None
        spd = math.hypot(fu, fv)
        d = (270.0 - math.degrees(math.atan2(fv, fu))) % 360.0
        return round(d, 1), round(spd, 1)
    except (TypeError, ValueError):
        return None, None


def _dry_temp(p_start: float, t_start_c: float, p2: float) -> float:
    tk = t_start_c + 273.15
    theta = tk * (1000.0 / p_start) ** 0.2854
    return theta * (p2 / 1000.0) ** 0.2854 - 273.15


def _parcel_trace(pres_levels, p0, t0, lclpres) -> list[Optional[float]]:
    """Parcel temperature (C) at each environmental pressure level."""
    out: list[Optional[float]] = []
    try:
        t_lcl = _dry_temp(p0, t0, lclpres)
    except Exception:
        return [None] * len(pres_levels)
    for p in pres_levels:
        try:
            if p >= lclpres:
                val = _dry_temp(p0, t0, p)
            else:
                val = float(thermo.wetlift(lclpres, t_lcl, p))
            out.append(round(val, 3) if math.isfinite(val) else None)
        except Exception:
            out.append(None)
    return out


def compute(levels: list[dict], lat: float = 35.0) -> dict:
    """Run SHARPpy on assembled levels; return params + parcel traces.

    `lat` is only used for inferred temperature advection, which needs the
    Coriolis parameter — everything else is latitude-independent.
    """
    lat_deg = float(lat) if lat is not None and math.isfinite(float(lat)) else 35.0
    pres = np.array([l["p"] for l in levels], dtype=float)
    hght = np.array([l["h"] for l in levels], dtype=float)
    tmpc = np.array([l["t"] for l in levels], dtype=float)
    dwpc = np.array([l["td"] for l in levels], dtype=float)
    wdir = np.array([l["wd"] for l in levels], dtype=float)
    wspd = np.array([l["ws"] for l in levels], dtype=float)

    prof = profile.create_profile(
        profile="default", pres=pres, hght=hght, tmpc=tmpc, dwpc=dwpc,
        wspd=wspd, wdir=wdir, missing=MISSING, strictQC=False,
    )

    P: dict[str, Any] = {}

    def wrap(name, fn):
        try:
            P[name] = fn()
        except Exception:
            P[name] = None

    # Parcels ---------------------------------------------------------------
    sfcpcl = mlpcl = mupcl = None
    try:
        sfcpcl = params.parcelx(prof, flag=1)
    except Exception:
        pass
    try:
        mlpcl = params.parcelx(prof, flag=4)
    except Exception:
        pass
    try:
        mupcl = params.parcelx(prof, flag=3)
    except Exception:
        pass

    if sfcpcl:
        P["sbcape"] = _num(sfcpcl.bplus); P["sbcin"] = _num(sfcpcl.bminus)
        P["sblcl"] = _num(sfcpcl.lclhght); P["sblfc"] = _num(sfcpcl.lfchght)
        P["sbel"] = _num(sfcpcl.elhght); P["sbli"] = _num(getattr(sfcpcl, "li5", None))
    if mlpcl:
        P["mlcape"] = _num(mlpcl.bplus); P["mlcin"] = _num(mlpcl.bminus)
        P["mllcl"] = _num(mlpcl.lclhght); P["mllfc"] = _num(mlpcl.lfchght)
        P["mlel"] = _num(mlpcl.elhght)
    if mupcl:
        P["mucape"] = _num(mupcl.bplus); P["mucin"] = _num(mupcl.bminus)
        P["mulcl"] = _num(mupcl.lclhght); P["mulfc"] = _num(mupcl.lfchght)
        P["muel"] = _num(mupcl.elhght)
        P["mupcl_p"] = _num(getattr(mupcl, "pres", None))

    # Moisture / thermodynamics --------------------------------------------
    wrap("pwat", lambda: _num(params.precip_water(prof) * 25.4))  # in -> mm
    wrap("kindex", lambda: _num(params.k_index(prof)))
    wrap("lr03", lambda: _num(params.lapse_rate(prof, 0, 3000, pres=False)))
    wrap("lr700_500", lambda: _num(params.lapse_rate(prof, 700, 500, pres=True)))
    wrap("lr36", lambda: _num(params.lapse_rate(prof, 3000, 6000, pres=False)))
    try:
        dc = params.dcape(prof)
        P["dcape"] = _num(dc[0] if isinstance(dc, (tuple, list)) else dc)
    except Exception:
        P["dcape"] = None

    # Effective inflow layer ------------------------------------------------
    eff_bot = eff_top = None
    try:
        eff_bot, eff_top = params.effective_inflow_layer(prof)
        P["eff_bot"] = _num(eff_bot); P["eff_top"] = _num(eff_top)
    except Exception:
        pass

    # Storm motion (Bunkers) ------------------------------------------------
    srwind = None
    try:
        srwind = params.bunkers_storm_motion(prof)
        rmu, rmv, lmu, lmv = srwind
        rmd, rms = _dir_spd(rmu, rmv)
        lmd, lms = _dir_spd(lmu, lmv)
        P["rm"] = [_num(rmu), _num(rmv), rmd, rms]
        P["lm"] = [_num(lmu), _num(lmv), lmd, lms]
    except Exception:
        pass
    try:
        mnu, mnv = winds.mean_wind(prof, pbot=prof.pres[prof.sfc],
                                   ptop=interp.pres(prof, interp.to_msl(prof, 6000.)))
        P["mean_wind"] = [_num(mnu), _num(mnv)]
    except Exception:
        pass

    stu = srwind[0] if srwind else 0.0
    stv = srwind[1] if srwind else 0.0

    # Helicity --------------------------------------------------------------
    def _helim(hbot, htop):
        return winds.helicity(prof, hbot, htop, stu=stu, stv=stv)[0]
    wrap("srh1km", lambda: _num(_helim(0, 1000.)))
    wrap("srh3km", lambda: _num(_helim(0, 3000.)))

    esrh = None
    if eff_bot is not None and eff_top is not None:
        try:
            ebot_z = interp.to_agl(prof, interp.hght(prof, eff_bot))
            etop_z = interp.to_agl(prof, interp.hght(prof, eff_top))
            esrh = winds.helicity(prof, ebot_z, etop_z, stu=stu, stv=stv)[0]
            P["esrh"] = _num(esrh)
        except Exception:
            pass

    # Shear -----------------------------------------------------------------
    def _shear_mag(ztop):
        u, v = winds.wind_shear(prof, pbot=prof.pres[prof.sfc],
                                ptop=interp.pres(prof, interp.to_msl(prof, ztop)))
        return sputils.mag(u, v)
    wrap("bwd1km", lambda: _num(_shear_mag(1000.)))
    wrap("bwd3km", lambda: _num(_shear_mag(3000.)))
    wrap("bwd6km", lambda: _num(_shear_mag(6000.)))
    wrap("bwd8km", lambda: _num(_shear_mag(8000.)))

    ebwd = None  # kt; effective bulk wind difference (eff base -> mid of eff base..EL)
    if eff_bot is not None and mupcl is not None:
        try:
            eff_base_z = interp.to_agl(prof, interp.hght(prof, eff_bot))
            el_z = float(mupcl.elhght)  # AGL (m)
            top_z = 0.5 * (el_z + eff_base_z)
            ptop_eff = interp.pres(prof, interp.to_msl(prof, top_z))
            u, v = winds.wind_shear(prof, pbot=eff_bot, ptop=ptop_eff)
            ebwd = float(sputils.mag(u, v))
            P["ebwd"] = _num(ebwd)
        except Exception:
            pass

    # Composite indices (STP/SCP want shear in m/s, NOT kt) -----------------
    if sfcpcl:
        try:
            P["stp_fixed"] = _num(params.stp_fixed(
                sfcpcl.bplus, sfcpcl.lclhght,
                _helim(0, 1000.), _shear_mag(6000.) * KT2MS))
        except Exception:
            P["stp_fixed"] = None
    if mlpcl and esrh is not None and ebwd is not None:
        try:
            P["stp_eff"] = _num(params.stp_cin(
                mlpcl.bplus, esrh, ebwd * KT2MS, mlpcl.lclhght, mlpcl.bminus))
        except Exception:
            P["stp_eff"] = None
    if mupcl and esrh is not None and ebwd is not None:
        try:
            P["scp"] = _num(params.scp(mupcl.bplus, esrh, ebwd * KT2MS))
        except Exception:
            P["scp"] = None
    wrap("ship", lambda: _num(params.ship(prof)))
    wrap("ttotals", lambda: _num(params.t_totals(prof)))
    wrap("dcp", lambda: _num(params.dcp(prof)))          # derecho composite
    wrap("lhp", lambda: _num(params.lhp(prof)))          # large hail parameter
    wrap("wndg", lambda: _num(params.wndg(prof)))        # wind damage parameter
    wrap("tei", lambda: _num(params.tei(prof)))          # theta-e index
    wrap("mburst", lambda: _num(params.mburst(prof)))
    wrap("esp", lambda: _num(params.esp(prof)))
    wrap("mmp", lambda: _num(params.mmp(prof)))
    wrap("sherb", lambda: _num(params.sherb(prof)))

    # ---------------------------------------------------------------------
    # The full workstation read-out: one parcel table, one thermo block, one
    # lapse-rate block and one kinematics table -- the four groups a severe
    # forecaster actually reads, rather than a flat bag of numbers.
    # ---------------------------------------------------------------------

    def _parcel_row(pcl) -> Optional[dict]:
        if pcl is None:
            return None
        g = lambda a: _num(getattr(pcl, a, None))  # noqa: E731
        # SHARPpy's Parcel has no NCAPE attribute, so derive it: CAPE spread over
        # the depth of the buoyant layer is what separates a tall thin profile
        # from a fat one with the same integral.
        cape, lfc, el = g("bplus"), g("lfchght"), g("elhght")
        ncape = None
        if cape is not None and lfc is not None and el is not None and el > lfc:
            ncape = round(cape / (el - lfc), 4)
        return {
            "cape": cape, "cin": g("bminus"),
            "cape3": g("b3km"), "cape6": g("b6km"),
            "capeFzl": g("bfzl"), "brn": g("brn"),
            "ncape": ncape,
            "lcl": g("lclhght"), "lfc": lfc, "el": el,
            "mpl": g("mplhght"), "li": g("li5"),
            "pres": g("pres"), "lclPres": g("lclpres"),
            # Cap strength is why a big CAPE can still do nothing.
            "cap": g("cap"), "capPres": g("cappres"),
        }

    P["parcels"] = {
        "sb": _parcel_row(sfcpcl),
        "ml": _parcel_row(mlpcl),
        "mu": _parcel_row(mupcl),
    }

    sfc_p = float(prof.pres[prof.sfc])

    def _p_at(z_agl: float) -> float:
        return float(interp.pres(prof, interp.to_msl(prof, z_agl)))

    def _hgt_of_p(p: float) -> Optional[float]:
        # _num, not float(): when the profile never reaches the requested
        # temperature -- a shallow aircraft ascent topping at 635 hPa has no
        # freezing level -- temp_lvl yields NaN, and float(nan) does NOT raise.
        # The NaN then reaches json.dumps and 500s the whole sounding.
        try:
            return _num(interp.to_agl(prof, interp.hght(prof, p)))
        except Exception:
            return None

    # Moisture / thermo block ----------------------------------------------
    wrap("pwatIn", lambda: _num(params.precip_water(prof)))
    wrap("meanMixRatio", lambda: _num(params.mean_mixratio(prof)))
    wrap("rhSfc", lambda: _num(params.mean_relh(prof, pbot=sfc_p, ptop=sfc_p - 50)))
    wrap("rhLow", lambda: _num(params.mean_relh(prof, pbot=sfc_p, ptop=850)))
    wrap("rhMid", lambda: _num(params.mean_relh(prof, pbot=850, ptop=500)))
    wrap("convT", lambda: _num(params.convective_temp(prof)))
    wrap("maxT", lambda: _num(params.max_temp(prof)))
    wrap("thetaeDiff", lambda: _num(params.thetae_diff(prof)))
    wrap("pblTop", lambda: _hgt_of_p(params.pbl_top(prof)))
    # Freezing and wet-bulb-zero levels, as heights AGL -- the two the skew-T
    # annotates (FZL / WBZ).
    wrap("fzlHght", lambda: _hgt_of_p(params.temp_lvl(prof, 0)))
    wrap("wbzHght", lambda: _hgt_of_p(params.temp_lvl(prof, 0, wetbulb=True)))
    wrap("minus10Hght", lambda: _hgt_of_p(params.temp_lvl(prof, -10)))
    wrap("minus20Hght", lambda: _hgt_of_p(params.temp_lvl(prof, -20)))
    wrap("minus30Hght", lambda: _hgt_of_p(params.temp_lvl(prof, -30)))

    # Dendritic growth zone: its depth and mean RH drive snow-growth calls.
    try:
        dgz_bot, dgz_top = params.dgz(prof)
        P["dgzBotP"] = _num(dgz_bot)
        P["dgzTopP"] = _num(dgz_top)
        P["dgzRh"] = _num(params.mean_relh(prof, pbot=dgz_bot, ptop=dgz_top))
    except Exception:
        P["dgzBotP"] = P["dgzTopP"] = P["dgzRh"] = None

    if sfcpcl is not None:
        P["lclTempC"] = _num(thermo.wetlift(sfc_p, float(prof.tmpc[prof.sfc]),
                                            float(sfcpcl.lclpres)))

    # Downdraft: DCAPE's own parcel trace ends at the surface temperature the
    # downdraft would arrive with, which is the number worth showing.
    try:
        dres = params.dcape(prof)
        if isinstance(dres, (tuple, list)) and len(dres) >= 2:
            ttrace = dres[1]
            P["downT"] = _num(float(ttrace[-1])) if len(ttrace) else None
    except Exception:
        P["downT"] = None

    # Lapse rates -----------------------------------------------------------
    wrap("lr850_500", lambda: _num(params.lapse_rate(prof, 850, 500, pres=True)))
    wrap("lr950_850", lambda: _num(params.lapse_rate(prof, 950, 850, pres=True)))
    if sfcpcl is not None:
        wrap("lrSfcLcl",
             lambda: _num(params.lapse_rate(prof, 0, float(sfcpcl.lclhght), pres=False)))
    try:
        mlr = params.max_lapse_rate(prof)
        P["lrMax26"] = _num(mlr[0] if isinstance(mlr, (tuple, list)) else mlr)
    except Exception:
        P["lrMax26"] = None

    # Kinematics table ------------------------------------------------------
    def _kin(label: str, htop: Optional[float], hbot: float = 0.0) -> Optional[dict]:
        if htop is None or htop <= hbot:
            return None
        try:
            pbot = _p_at(hbot)
            ptop = _p_at(htop)
            su, sv = winds.wind_shear(prof, pbot=pbot, ptop=ptop)
            sdir, sspd = _dir_spd(su, sv)
            h = winds.helicity(prof, hbot, htop, stu=stu, stv=stv)[0]
            ru, rv = winds.sr_wind(prof, pbot=pbot, ptop=ptop, stu=stu, stv=stv)
            rdir, rspd = _dir_spd(ru, rv)
            e = None
            if mlpcl is not None:
                try:
                    e = _num(params.ehi(prof, mlpcl, hbot, htop, stu=stu, stv=stv))
                except Exception:
                    e = None
            return {"label": label, "shearDir": sdir, "shearKt": sspd,
                    "srh": _num(h), "srDir": rdir, "srKt": rspd, "ehi": e}
        except Exception:
            return None

    rows = [
        _kin("Sfc-500m", 500.0),
        _kin("Sfc-1km", 1000.0),
        _kin("Sfc-2km", 2000.0),
        _kin("Sfc-3km", 3000.0),
        _kin("Sfc-6km", 6000.0),
        _kin("Sfc-8km", 8000.0),
    ]
    # Layers defined by the sounding itself rather than by a fixed height.
    if mlpcl is not None and _num(mlpcl.lfchght) is not None:
        rows.append(_kin("Sfc-MLLFC", float(mlpcl.lfchght)))
    if sfcpcl is not None and _num(sfcpcl.lclhght) is not None:
        rows.append(_kin("Sfc-SBLCL", float(sfcpcl.lclhght)))
    if eff_bot is not None and eff_top is not None:
        eb, et = _hgt_of_p(eff_bot), _hgt_of_p(eff_top)
        if eb is not None and et is not None:
            rows.append(_kin("Eff Inflow", et, eb))
    P["kinematics"] = [r for r in rows if r is not None]

    # Storm slinky: the MU parcel's trajectory in the storm-relative frame, the
    # 3-D shape SHARPpy draws to show how upright or tilted the updraft is.
    # Cheap -- it reuses the parcel we already lifted.
    try:
        traj_pcl = mupcl or sfcpcl or mlpcl
        if traj_pcl is not None:
            tr = params.parcelTraj(prof, traj_pcl, smu=stu, smv=stv)
            pts = np.asarray(tr[0], dtype=float) if isinstance(tr, (tuple, list)) else None
            if pts is not None and pts.ndim == 2 and pts.shape[1] >= 3:
                P["slinky"] = [
                    [round(float(x), 1), round(float(y), 1), round(float(z), 1)]
                    for x, y, z in pts[:, :3]
                    if math.isfinite(x) and math.isfinite(y) and math.isfinite(z)
                ]
                P["slinkyAngle"] = _num(float(tr[1])) if len(tr) > 1 else None
    except Exception:
        P["slinky"] = None
        P["slinkyAngle"] = None

    # Inferred temperature advection, kept in the payload for callers that
    # want the layer-by-layer values.
    # NOTE: this returns one value per LAYER, and each "pressure" entry is the
    # pair [pbot, ptop] of that layer -- not a single level. Treating it as a
    # scalar throws and silently empties the whole strip.
    try:
        adv, adv_layers = params.inferred_temp_adv(prof, lat=lat_deg)
        out_adv: list[list[float]] = []
        for lay, aa in zip(adv_layers, adv):
            try:
                pbot_l, ptop_l = float(lay[0]), float(lay[1])
                val = float(aa)
            except (TypeError, ValueError, IndexError):
                continue
            if not math.isfinite(val):
                continue
            out_adv.append([round(pbot_l, 1), round(ptop_l, 1), round(val, 3)])
        P["tempAdvProfile"] = out_adv or None
    except Exception:
        P["tempAdvProfile"] = None

    # Parcel traces for the skew-T (draw the MU parcel; SB as fallback). ----
    trace_pcl = mupcl or sfcpcl or mlpcl
    parcel_trace = None
    if trace_pcl is not None:
        try:
            parcel_trace = _parcel_trace(
                [l["p"] for l in levels],
                float(trace_pcl.pres), float(trace_pcl.tmpc), float(trace_pcl.lclpres))
        except Exception:
            parcel_trace = None

    # Last line of defence. A single NaN anywhere in this dict makes json.dumps
    # raise and turns the WHOLE sounding into an HTTP 500 -- one missing
    # freezing level should never cost the user the other 80 numbers. SHARPpy
    # returns NaN for anything a profile cannot support, so sweep before
    # returning rather than trusting every call site to have guarded.
    def _json_safe(o):
        if isinstance(o, float):
            return o if math.isfinite(o) else None
        if isinstance(o, dict):
            return {k: _json_safe(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [_json_safe(v) for v in o]
        return o

    return {"params": _json_safe(P), "parcelTrace": _json_safe(parcel_trace),
            "effBotP": _num(eff_bot), "effTopP": _num(eff_top)}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def build_sounding(lat: float, lon: float, model: str, hour: int,
                   view: Optional[dict] = None, render: bool = True) -> dict:
    if model not in MODELS:
        model = DEFAULT_MODEL
    requested_hour = max(0, int(hour))
    view = view or {}
    # The plot options are part of the identity of the rendered image, so they
    # belong in the key: without them, switching parcel returned the cached
    # picture of the previous one.
    # See build_raob: a parameters-only response must not be served to a caller
    # that asked for the plot.
    cache_key = (round(lat, 3), round(lon, 3), model, requested_hour, bool(render),
                 tuple(sorted(view.items())))
    hit = _RESULT_CACHE.get(cache_key)
    now = time.time()
    if hit and now - hit[0] < _TTL:
        return hit[1]

    requested_model = model if model in MODELS else DEFAULT_MODEL
    raw, actual_model, valid_hours, fallback_reason = resolve_sounding_data(lat, lon, model)
    model_info = _model_meta(requested_model, actual_model, fallback_reason)
    raw_times = raw.get("hourly", {}).get("time", [])
    raw_n_times = len(raw_times)

    max_valid_hour = max(valid_hours)
    requested_hour = min(requested_hour, max(raw_n_times - 1, 0))
    hour = requested_hour
    if hour not in valid_hours:
        hour = _nearest_valid_hour(valid_hours, hour)
        model_info["fallbackReason"] = _append_notice(
            model_info["fallbackReason"],
            f"No complete vertical profile at F{requested_hour:03d}; using F{hour:03d}.",
        )

    assembled = build_levels(raw, hour)
    levels = assembled["levels"]
    if len(levels) < 4:
        raise RuntimeError("Not enough valid levels returned for this point/hour")

    result = compute(levels, lat=lat)

    # Preserve missing winds. SHARPpy skips those levels instead of drawing
    # artificial calm-wind segments in the hodograph.
    render_levels = levels

    meta = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "model": model_info["model"],
        "requestedModel": model_info["requestedModel"],
        "modelLabel": model_info["modelLabel"],
        "requestedModelLabel": model_info["requestedModelLabel"],
        "modelGroup": model_info["modelGroup"],
        "openMeteoModel": model_info["openMeteoModel"],
        "fallbackReason": model_info["fallbackReason"],
        "hour": hour,
        "requestedHour": requested_hour,
        "forecastMaxHour": max_valid_hour,
        "validHours": valid_hours,
        "elevation": round(assembled["elevation"], 1),
        "validUnix": assembled["valid_unix"],
        "times": assembled["times"][:max_valid_hour + 1],
        "nTimes": max_valid_hour + 1,
        "source": "Open-Meteo + SHARPpy SPCWidget",
    }

    image = None
    image_error = None
    # Skipping the plot is what makes a multi-station scan possible at all:
    # the parameters are already computed above, while the SHARPpy render is
    # seconds of Qt work per profile.
    try:
        if not render:
            raise _SkipRender()
        from sharppy_renderer import render_spc_widget_png

        # The panel's parcel / storm-motion choices ride in the same meta the
        # renderer already receives, so nothing else in the path changes.
        meta.update(view or {})

        image = base64.b64encode(render_spc_widget_png(render_levels, meta)).decode("ascii")
    except Exception as exc:  # noqa: BLE001 - return renderer failures to the UI
        # If the main renderer fails, try in-process rendering directly
        image_error = str(exc)
        try:
            from sharppy_renderer import _render_spc_widget_png_serialized

            image = base64.b64encode(_render_spc_widget_png_serialized(render_levels, meta)).decode("ascii")
            image_error = None  # Clear error if in-process succeeded
        except Exception as exc2:  # noqa: BLE001
            image_error = f"{exc}; in-process also failed: {exc2}"

    payload = {
        "meta": meta,
        "levels": levels,
        "parcelTrace": result["parcelTrace"],
        "effBotP": result["effBotP"],
        "effTopP": result["effTopP"],
        "params": result["params"],
        "image": image,
        "imageRenderer": "SHARPpy SPCWidget",
        "imageError": image_error,
    }
    _RESULT_CACHE[cache_key] = (now, payload)
    return payload
