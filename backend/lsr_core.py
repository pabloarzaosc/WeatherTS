"""
NWS Local Storm Reports (LSR).

Source: the Iowa Environmental Mesonet's LSR GeoJSON feed, which aggregates the
LSR text products every WFO issues. One request covers the whole country over an
arbitrary time window, so the client can scrub the timeline and get exactly the
reports that were filed up to that moment.

    https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=...&ets=...

Feed properties (verified live): wfo, type (1-char code), typetext, magnitude,
magf (numeric), unit, qualifier, city, county, st/state, source, remark, valid
(ISO Z), lat, lon, product_id.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

FEED = "https://mesonet.agron.iastate.edu/geojson/lsr.geojson"

_HTTP_TIMEOUT = (8, 40)
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=3, connect=3, read=2, backoff_factor=0.5,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset(["GET"]),
        )
    ),
)

MAX_HOURS = 72

# ---------------------------------------------------------------------------
# The complete NWS Local Storm Report type table.
#
# The single-character codes and every phrase that maps to them come from the
# IEM parser's own `lsr_events` table (pyIEM reference.py) -- 111 phrases onto
# 48 codes -- cross-checked against 16,000 live reports. Guessing these is not
# safe: an earlier hand-written table here had `Z` as freezing rain when it is
# BLIZZARD, `q` as storm surge when it is SNOW SQUALL, and `s` as snow squall
# when it is SLEET.
#
# `cat` drives the icon and colour, `rank` decides who survives a declutter
# fight (a tornado must never be dropped for a rain total), and `desc` is the
# plain-English meaning shown in the report card and the type list.
# ---------------------------------------------------------------------------
TYPES: dict[str, dict[str, Any]] = {
    # --- tornadic ---------------------------------------------------------
    "T": {"label": "Tornado", "cat": "tornado", "rank": 100,
          "desc": "A violently rotating column of air in contact with both the ground "
                  "and a thunderstorm. Magnitude is the EF damage rating."},
    "W": {"label": "Waterspout / landspout", "cat": "tornado", "rank": 95,
          "desc": "A tornadic circulation over water, or one that forms along a "
                  "boundary without a parent mesocyclone."},
    "C": {"label": "Funnel cloud", "cat": "funnel", "rank": 80,
          "desc": "A rotating funnel visible below cloud base that has not reached the "
                  "ground. No damage is implied."},
    "X": {"label": "Wall cloud", "cat": "funnel", "rank": 72,
          "desc": "A lowering beneath a thunderstorm rain-free base, marking the "
                  "updraft where a tornado may form."},

    # --- thunderstorm -----------------------------------------------------
    "D": {"label": "Thunderstorm wind damage", "cat": "tstorm", "rank": 88,
          "desc": "Damage caused by thunderstorm winds -- trees or limbs down, "
                  "structural damage. No measured speed."},
    "G": {"label": "Thunderstorm wind gust", "cat": "tstorm", "rank": 78,
          "desc": "A measured or estimated wind gust produced by a thunderstorm."},
    "B": {"label": "Downburst", "cat": "tstorm", "rank": 86,
          "desc": "A concentrated downdraft producing damaging straight-line winds at "
                  "the surface."},
    "M": {"label": "Marine thunderstorm wind", "cat": "tstorm", "rank": 74,
          "desc": "Thunderstorm winds observed over coastal or open water."},
    "L": {"label": "Lightning", "cat": "tstorm", "rank": 55,
          "desc": "A lightning event notable enough to report -- usually damage, fire "
                  "or injury."},
    "K": {"label": "Lightning strike", "cat": "tstorm", "rank": 60,
          "desc": "A confirmed lightning strike on a structure, vessel or person."},

    # --- hail -------------------------------------------------------------
    "H": {"label": "Hail", "cat": "hail", "rank": 90,
          "desc": "Hail reaching the ground. Magnitude is the largest stone diameter, "
                  "in inches."},
    "h": {"label": "Marine hail", "cat": "hail", "rank": 76,
          "desc": "Hail observed over coastal or open water."},

    # --- non-thunderstorm wind -------------------------------------------
    "A": {"label": "High sustained wind", "cat": "wind", "rank": 66,
          "desc": "Sustained non-thunderstorm winds at or above warning criteria."},
    "N": {"label": "Non-thunderstorm wind gust", "cat": "wind", "rank": 58,
          "desc": "A wind gust with no thunderstorm involved -- gradient, downslope or "
                  "frontal."},
    "O": {"label": "Non-thunderstorm wind damage", "cat": "wind", "rank": 64,
          "desc": "Damage from winds with no thunderstorm involved."},
    "m": {"label": "Dust devil", "cat": "wind", "rank": 40,
          "desc": "A small fair-weather whirlwind lifting dust. Not a tornado."},

    # --- rain and flooding ------------------------------------------------
    "F": {"label": "Flash flood", "cat": "flood", "rank": 84,
          "desc": "Rapid flooding, usually within hours of the rain that caused it."},
    "E": {"label": "Flood", "cat": "flood", "rank": 62,
          "desc": "Slower-onset or river flooding, including areal and urban flooding."},
    "x": {"label": "Debris flow / landslide", "cat": "flood", "rank": 70,
          "desc": "A landslide, mudslide, debris flow or ice jam -- often on burn scars "
                  "or steep terrain."},
    "u": {"label": "Lakeshore flood", "cat": "flood", "rank": 52,
          "desc": "Flooding along a lake shore, driven by wind setup or seiche."},
    "v": {"label": "Coastal flood", "cat": "flood", "rank": 54,
          "desc": "Salt-water flooding of normally dry coastal land."},
    "1": {"label": "Storm surge / tide", "cat": "flood", "rank": 82,
          "desc": "Water pushed ashore above the predicted tide by a storm wind field."},
    "9": {"label": "Seiche", "cat": "flood", "rank": 36,
          "desc": "A standing wave sloshing across an enclosed body of water."},
    "y": {"label": "Tsunami", "cat": "flood", "rank": 92,
          "desc": "A series of waves generated by a seafloor displacement."},
    "R": {"label": "Rain", "cat": "rain", "rank": 22,
          "desc": "A rainfall total, in inches, over the period the office specified."},
    "3": {"label": "Sprinkles", "cat": "rain", "rank": 6,
          "desc": "Trace precipitation, reported to mark the onset of rain."},

    # --- snow -------------------------------------------------------------
    "S": {"label": "Snow", "cat": "snow", "rank": 30,
          "desc": "A snowfall or storm-total accumulation, in inches."},
    "q": {"label": "Snow squall", "cat": "snow", "rank": 48,
          "desc": "A brief, intense burst of heavy snow with wind, collapsing "
                  "visibility in minutes."},
    "Z": {"label": "Blizzard", "cat": "snow", "rank": 50,
          "desc": "Wind of 35 mph or more with falling or blowing snow holding "
                  "visibility below a quarter mile."},
    "a": {"label": "Blowing / drifting snow", "cat": "snow", "rank": 34,
          "desc": "Wind lifting fallen snow enough to cut visibility or drift roads."},

    # --- ice and cold -----------------------------------------------------
    "5": {"label": "Freezing rain / ice storm", "cat": "ice", "rank": 68,
          "desc": "Rain freezing on contact. Magnitude is ice accretion, in inches."},
    "s": {"label": "Sleet", "cat": "ice", "rank": 32,
          "desc": "Ice pellets reaching the ground, accumulating in inches."},
    "6": {"label": "Extreme cold / freeze", "cat": "ice", "rank": 26,
          "desc": "A temperature low cold enough to report, including frost and freeze "
                  "events."},
    "7": {"label": "Wind chill", "cat": "ice", "rank": 24,
          "desc": "An apparent temperature from combined cold and wind."},
    "i": {"label": "Heavy freezing spray", "cat": "ice", "rank": 44,
          "desc": "Sea spray freezing onto a vessel fast enough to threaten its "
                  "stability."},

    # --- tropical ---------------------------------------------------------
    "0": {"label": "Hurricane / typhoon", "cat": "tropical", "rank": 98,
          "desc": "Sustained winds of 74 mph or more from a tropical cyclone."},
    "Q": {"label": "Tropical storm", "cat": "tropical", "rank": 86,
          "desc": "Sustained winds of 39 to 73 mph from a tropical cyclone."},

    # --- fire -------------------------------------------------------------
    "U": {"label": "Wildfire", "cat": "fire", "rank": 46,
          "desc": "A wildfire significant enough for the office to log."},
    "j": {"label": "Dense smoke", "cat": "fire", "rank": 20,
          "desc": "Smoke reducing visibility, usually from wildfire."},

    # --- everything else --------------------------------------------------
    "I": {"label": "Extreme heat", "cat": "other", "rank": 28,
          "desc": "A high temperature or heat index at or above local criteria."},
    "J": {"label": "Dense fog", "cat": "other", "rank": 14,
          "desc": "Fog reducing visibility. Magnitude is the visibility, in miles."},
    "2": {"label": "Blowing dust / dust storm", "cat": "other", "rank": 38,
          "desc": "Wind-lifted dust reducing visibility, often to zero within seconds."},
    "V": {"label": "Avalanche", "cat": "other", "rank": 56,
          "desc": "A snow avalanche, reported when it reaches people or infrastructure."},
    "P": {"label": "Rip current / high surf", "cat": "other", "rank": 42,
          "desc": "A hazardous surf-zone condition -- rip currents, high surf or "
                  "another marine hazard."},
    "t": {"label": "Sneaker wave", "cat": "other", "rank": 42,
          "desc": "An unusually large wave running far up a beach without warning."},
    "z": {"label": "Volcanic ash", "cat": "other", "rank": 44,
          "desc": "Ashfall from a volcanic eruption."},
    "4": {"label": "Astronomical tide", "cat": "other", "rank": 12,
          "desc": "An unusually high or low tide driven by astronomy, not by weather."},
    "8": {"label": "Drought", "cat": "other", "rank": 10,
          "desc": "A drought impact worth recording."},
}

# Categories the UI offers as filters, in display order. Mirrors the grouping a
# storm-report legend uses, so the map and the panel read the same way.
CATEGORIES: list[dict[str, str]] = [
    {"id": "tornado", "label": "Tornado / waterspout"},
    {"id": "funnel", "label": "Funnel / wall cloud"},
    {"id": "tstorm", "label": "Thunderstorm wind"},
    {"id": "hail", "label": "Hail"},
    {"id": "wind", "label": "Wind (non-storm)"},
    {"id": "flood", "label": "Flood"},
    {"id": "rain", "label": "Rain"},
    {"id": "snow", "label": "Snow"},
    {"id": "ice", "label": "Ice / cold"},
    {"id": "tropical", "label": "Tropical"},
    {"id": "fire", "label": "Fire / smoke"},
    {"id": "other", "label": "Other"},
]

_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 60.0


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%MZ")


def _f(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if f == f else None  # NaN check
    except (TypeError, ValueError):
        return None


# How the magnitude was arrived at, as the LSR product encodes it.
_QUALIFIERS = {"M": "Measured", "E": "Estimated", "U": "Unknown", "": ""}


def _issued_unix(product_id: Any) -> Optional[int]:
    """When the office transmitted the product, from the IEM product id.

    `202608081339-KGYX-NWUS51-LSRGYX` -> unix. This is the ISSUED time, which
    can be hours after the event time -- a storm survey filed the next morning
    still describes yesterday's tornado.
    """
    s = str(product_id or "")
    if len(s) < 12 or not s[:12].isdigit():
        return None
    try:
        return int(datetime.strptime(s[:12], "%Y%m%d%H%M")
                   .replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def _magnitude_text(code: str, magf: Optional[float], unit: Optional[str],
                    raw: Optional[str], qualifier: Optional[str]) -> str:
    """A short, human magnitude: 2.75\" hail, M65 MPH gust, EF2, 3.10\" rain."""
    if code == "T":
        # Tornado magnitude arrives as the EF rating in `magnitude`.
        return f"EF{raw}" if raw not in (None, "", "0.00") else ""
    if magf is None:
        return raw or ""
    u = (unit or "").upper()
    q = (qualifier or "").strip().upper()
    prefix = {"M": "M", "E": "E", "U": ""}.get(q, "")
    if u.startswith("INCH"):
        return f"{prefix}{magf:.2f}\""
    if u in ("MPH", "KTS", "KNOTS"):
        return f"{prefix}{magf:.0f} {u.lower()}"
    if u == "F":
        return f"{prefix}{magf:.0f}°F"
    return f"{prefix}{magf:g}{(' ' + u.lower()) if u else ''}"


def _norm(feature: dict) -> Optional[dict]:
    p = feature.get("properties") or {}
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates")
    lon = _f(p.get("lon"))
    lat = _f(p.get("lat"))
    if lon is None or lat is None:
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            lon, lat = _f(coords[0]), _f(coords[1])
    if lon is None or lat is None:
        return None

    code = str(p.get("type") or "").strip() or "?"
    spec = TYPES.get(code) or {
        "label": p.get("typetext") or "Report", "cat": "other", "rank": 5,
        "desc": "An event type this build does not have a description for.",
    }
    valid = str(p.get("valid") or "")
    try:
        unix = int(
            datetime.strptime(valid, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        )
    except ValueError:
        unix = 0

    magf = _f(p.get("magf"))
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
        "properties": {
            "code": code,
            "cat": spec["cat"],
            "rank": spec["rank"],
            # Prefer the feed's own wording; fall back to our label for odd codes.
            "label": str(p.get("typetext") or spec["label"]).title(),
            # Our own canonical name and its plain-English meaning. The feed's
            # `typetext` is one of up to eight phrasings per code, so the card
            # shows what the office wrote AND what the code actually means.
            "typeName": spec["label"],
            "desc": spec.get("desc", ""),
            "qualifierText": _QUALIFIERS.get(str(p.get("qualifier") or "").strip().upper(), ""),
            "issuedUnix": _issued_unix(p.get("product_id")),
            "mag": _magnitude_text(code, magf, p.get("unit"), p.get("magnitude"), p.get("qualifier")),
            "magf": magf,
            "unit": p.get("unit") or "",
            "city": p.get("city") or "",
            "county": p.get("county") or "",
            "state": p.get("st") or p.get("state") or "",
            "wfo": p.get("wfo") or "",
            "source": p.get("source") or "",
            "remark": p.get("remark") or "",
            "unix": unix,
            "valid": valid,
        },
    }


def fetch_lsr(hours: int = 12, end_unix: Optional[float] = None,
              bbox: Optional[tuple[float, float, float, float]] = None,
              start_unix: Optional[float] = None) -> dict:
    """Reports over a trailing window, newest first.

    `end_unix` lets the timeline scrub into the past: the window is the `hours`
    ending at that instant, so a report filed after the frame you are looking at
    is not drawn over it.

    `start_unix` sets the window's start instead of `hours` -- the convective
    day, 12Z to 12Z, is the window SPC's own storm report pages use. It is held
    to MAX_HOURS before the end.
    """
    end = datetime.fromtimestamp(end_unix, timezone.utc) if end_unix else datetime.now(timezone.utc)
    if start_unix is not None:
        start = datetime.fromtimestamp(start_unix, timezone.utc)
        start = min(max(start, end - timedelta(hours=MAX_HOURS)), end - timedelta(minutes=1))
        hours = max(1, round((end - start).total_seconds() / 3600))
    else:
        hours = max(1, min(int(hours), MAX_HOURS))
        start = end - timedelta(hours=hours)

    # Bucket the cache to the minute so scrubbing doesn't miss every time.
    ck = (int(start.timestamp()) // 60, int(end.timestamp()) // 60)
    now = time.time()
    hit = _CACHE.get(ck)
    if hit and now - hit[0] < _TTL:
        payload = hit[1]
    else:
        r = _SESSION.get(FEED, params={"sts": _iso(start), "ets": _iso(end)}, timeout=_HTTP_TIMEOUT)
        r.raise_for_status()
        raw = r.json()
        feats = []
        for f in raw.get("features") or []:
            n = _norm(f)
            if n is not None:
                feats.append(n)
        feats.sort(key=lambda f: f["properties"]["unix"], reverse=True)
        payload = {
            "type": "FeatureCollection",
            "features": feats,
            "meta": {
                "start": _iso(start),
                "end": _iso(end),
                "startUnix": int(start.timestamp()),
                "endUnix": int(end.timestamp()),
                "hours": hours,
                "count": len(feats),
                "source": "NWS Local Storm Reports via Iowa Environmental Mesonet",
            },
        }
        _CACHE[ck] = (now, payload)
        while len(_CACHE) > 64:
            _CACHE.pop(next(iter(_CACHE)))

    if bbox:
        lat0, lon0, lat1, lon1 = bbox
        feats = [
            f for f in payload["features"]
            if lon0 <= f["geometry"]["coordinates"][0] <= lon1
            and lat0 <= f["geometry"]["coordinates"][1] <= lat1
        ]
        return {**payload, "features": feats, "meta": {**payload["meta"], "count": len(feats)}}
    return payload


def list_types() -> dict:
    """Type + category tables, so the panel's filters stay in step with the parser."""
    return {
        "categories": CATEGORIES,
        "types": [{"code": c, **v} for c, v in sorted(TYPES.items(), key=lambda kv: -kv[1]["rank"])],
    }
