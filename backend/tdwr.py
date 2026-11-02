"""The FAA's Terminal Doppler Weather Radars (TDWR): 45 C-band radars beside the
big airports, a second kind of radar in the viewer next to the WSR-88Ds.

No numpy here on purpose: radar_status imports this in its tests.

What they publish, from Unidata's Level III bucket (checked 2026-11-01):

  TZ0 TZ1 TZ2   product 180, reflectivity at three tilts: 360 x 592, 150 m gates
  TV0 TV1 TV2   product 182, velocity at the same tilts: 360 x 592, 150 m gates,
                0.5 m/s steps from -63.5 to 63 (m/s, like product 99)
  TZL           product 186, long-range reflectivity: 360 x 1390, 300 m gates
  NVL           product 57, VIL: a raster, 116 x 116 at 4 km, 16 levels
  NET           product 41, echo tops: the same raster. The bucket stops keeping
                it in 2023; the NWS feed (tgftp) still has it live.

The site list is api.weather.gov/radar/stations?stationType=TDWR, cross-checked
against IEM's TWDR network and the WMO header of each radar's newest scan
(which names its office). All 45 published on the day of the check.

Gate spacing: MetPy's table says 90 km and 416 km, round numbers; the true
ranges are 592 x 150 m = 88.8 km (48 nmi) and 1390 x 300 m = 417 km (225 nmi).
Spreading the gates over the round number would put an echo at 80 km more than a
kilometre too far out.
"""

from __future__ import annotations

import re
from datetime import date as _date
from typing import Any, Optional

# (id, place, state, office, lat, lon, elevation m, time zone)
_SITES: list[tuple[str, str, str, Optional[str], float, float, int, str]] = [
    ("ADW", "Andrews AFB", "MD", "LWX", 38.695, -76.845, 105, "America/New_York"),
    ("ATL", "Atlanta", "GA", "FFC", 33.647, -84.262, 328, "America/New_York"),
    ("BNA", "Nashville", "TN", "OHX", 35.980, -86.662, 249, "America/Chicago"),
    ("BOS", "Boston", "MA", "BOX", 42.158, -70.933, 80, "America/New_York"),
    ("BWI", "Baltimore/Washington", "MD", "LWX", 39.090, -76.630, 91, "America/New_York"),
    ("CLT", "Charlotte", "NC", "GSP", 35.337, -80.885, 265, "America/New_York"),
    ("CMH", "Columbus", "OH", "ILN", 40.006, -82.715, 350, "America/New_York"),
    ("CVG", "Cincinnati/Covington", "KY", "ILN", 38.898, -84.580, 321, "America/New_York"),
    ("DAL", "Dallas Love Field", "TX", "FWD", 32.926, -96.968, 190, "America/Chicago"),
    ("DAY", "Dayton", "OH", "ILN", 40.022, -84.123, 311, "America/New_York"),
    ("DCA", "Washington National", "VA", "LWX", 38.759, -76.962, 105, "America/New_York"),
    ("DEN", "Denver", "CO", "BOU", 39.728, -104.526, 1738, "America/Denver"),
    ("DFW", "Dallas/Fort Worth", "TX", "FWD", 33.065, -96.918, 178, "America/Chicago"),
    ("DJT", "West Palm Beach", "FL", "MFL", 26.688, -80.273, 41, "America/New_York"),
    ("DTW", "Detroit", "MI", "DTX", 42.111, -83.515, 235, "America/Detroit"),
    ("EWR", "Newark", "NJ", "OKX", 40.593, -74.270, 41, "America/New_York"),
    ("FLL", "Fort Lauderdale", "FL", "MFL", 26.143, -80.344, 37, "America/New_York"),
    ("HOU", "Houston Hobby", "TX", "HGX", 29.516, -95.242, 36, "America/Chicago"),
    ("IAD", "Washington Dulles", "VA", "LWX", 39.084, -77.529, 144, "America/New_York"),
    ("IAH", "Houston Intercontinental", "TX", "HGX", 30.065, -95.567, 77, "America/Chicago"),
    ("ICH", "Wichita", "KS", "ICT", 37.507, -97.437, 412, "America/Chicago"),
    ("IDS", "Indianapolis", "IN", "IND", 39.637, -86.436, 258, "America/Indiana/Indianapolis"),
    ("JFK", "New York JFK", "NY", "OKX", 40.589, -73.881, 34, "America/New_York"),
    ("LAS", "Las Vegas", "NV", "VEF", 36.144, -115.007, 627, "America/Los_Angeles"),
    ("LVE", "Cleveland", "OH", "CLE", 41.290, -82.008, 284, "America/New_York"),
    ("MCI", "Kansas City", "MO", "EAX", 39.498, -94.742, 332, "America/Chicago"),
    ("MCO", "Orlando", "FL", "MLB", 28.344, -81.326, 52, "America/New_York"),
    ("MDW", "Chicago Midway", "IL", "LOT", 41.651, -87.730, 233, "America/Chicago"),
    ("MEM", "Memphis", "TN", "MEG", 34.896, -89.993, 147, "America/Chicago"),
    ("MIA", "Miami", "FL", "MFL", 25.758, -80.491, 38, "America/New_York"),
    ("MKE", "Milwaukee", "WI", "MKX", 42.819, -88.046, 284, "America/Chicago"),
    ("MSP", "Minneapolis", "MN", "MPX", 44.871, -92.933, 342, "America/Chicago"),
    ("MSY", "New Orleans", "LA", "LIX", 30.022, -90.403, 30, "America/Chicago"),
    ("OKC", "Oklahoma City", "OK", "OUN", 35.276, -97.510, 399, "America/Chicago"),
    ("ORD", "Chicago O'Hare", "IL", "LOT", 41.797, -87.858, 227, "America/Chicago"),
    ("PHL", "Philadelphia", "PA", "PHI", 39.949, -75.069, 47, "America/New_York"),
    ("PHX", "Phoenix", "AZ", "PSR", 33.421, -112.163, 332, "America/Phoenix"),
    ("PIT", "Pittsburgh", "PA", "PBZ", 40.501, -80.486, 422, "America/New_York"),
    ("RDU", "Raleigh-Durham", "NC", "RAH", 36.002, -78.697, 157, "America/New_York"),
    ("SDF", "Louisville", "KY", "LMK", 38.046, -85.610, 223, "America/New_York"),
    ("SJU", "San Juan", "PR", "SJU", 18.474, -66.179, 48, "America/Puerto_Rico"),
    ("SLC", "Salt Lake City", "UT", "SLC", 40.967, -111.930, 1309, "America/Denver"),
    ("STL", "St. Louis", "MO", "LSX", 38.805, -90.489, 197, "America/Chicago"),
    ("TPA", "Tampa Bay", "FL", "TBW", 27.860, -82.518, 28, "America/New_York"),
    ("TUL", "Tulsa", "OK", "TSA", 36.071, -95.827, 251, "America/Chicago"),
]

IDS: frozenset[str] = frozenset(s[0] for s in _SITES)

# West Palm Beach's TDWR was renamed for its airport: PBI's last scan in the
# bucket is 2026-07-31, DJT's first is 2026-08-12. Days before the change are
# read under the old name, so the archive has the radar's whole history.
_FORMER: dict[str, tuple[str, str]] = {"DJT": ("PBI", "2026-08-12")}

# Beam and band, for the readout and the product info panel.
BAND = "C"
BEAM_WIDTH_DEG = 0.55
# The range that matters to someone reading the map, for the panel's words.
DOPPLER_RANGE_KM = 88.8
LONG_RANGE_KM = 417.0

# Tilt slots as the app holds them. TZ0 is the radar's lowest cut, which is not
# the same at every site (0.3 at TMEM, 0.5 at TBWI): the real angle comes from
# each scan. These are the labels before one has been read.
TILTS: list[tuple[str, float]] = [("0", 0.5), ("1", 1.0), ("2", 2.4)]

_SPEC_REF = {"label": "Reflectivity", "units": "dBZ", "kind": "ref", "family": "B"}
_SPEC_VEL = {"label": "Velocity", "units": "kt", "kind": "vel", "family": "G"}

PRODUCTS: dict[str, dict[str, Any]] = {
    **{f"TZ{s}": {**_SPEC_REF, "tilt": s, "elev": e} for s, e in TILTS},
    **{f"TV{s}": {**_SPEC_VEL, "tilt": s, "elev": e} for s, e in TILTS},
    "TZL": {"label": "Long Range Reflectivity", "units": "dBZ", "kind": "ref", "family": "TZL", "tilt": None, "elev": None},
    "NVL": {"label": "Vertical Integrated Liquid", "units": "kg/m²", "kind": "vil", "family": "DVL", "tilt": None, "elev": None},
    "NET": {"label": "Echo Tops", "units": "kft", "kind": "tops", "family": "EET", "tilt": None, "elev": None},
}

# Which picker family each code answers to, and the order they are checked in.
FAMILY_CODES: dict[str, list[str]] = {
    "B": ["TZ0", "TZ1", "TZ2"],
    "G": ["TV0", "TV1", "TV2"],
    "TZL": ["TZL"],
    "DVL": ["NVL"],
    "EET": ["NET"],
}

# The family only a TDWR has, as the picker's catalogue lists it. `unavailable`:
# hidden on every other radar, shown when a TDWR's availability fills it in.
CATALOG_FAMILY: dict[str, Any] = {
    "id": "TZL",
    "label": "Long Range Reflectivity",
    "units": "dBZ",
    "kind": "ref",
    "tdwrOnly": True,
    "unavailable": True,
    "tilts": [{"code": "TZL", "tilt": None, "elev": None}],
}

# True gate spacing per product family, km (see the top of this file).
_GATE_KM = {"TZ": 0.150, "TV": 0.150}
_GATE_KM_TZL = 0.300

# The raster products: side of one cell, km.
RASTER_CELL_KM: dict[str, float] = {"NVL": 4.0, "NET": 4.0}

# Products the bucket stopped keeping, in the NWS feed instead (live, a day's
# worth): their directory, and the moment after which a key means the feed.
FEED_BASE = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar/"
FEED_DIRS: dict[str, str] = {"NET": "DS.p41et"}
FEED_NEWER_THAN = 1_688_169_600  # 2023-07-01 00Z: NET's last keys in the bucket are June 2023

# The two ways a TDWR runs, by the VCP number in its scans (the header's own
# mode says Precipitation in both): checked against the scan cadence, TMEM's VCP
# 80 sends TZ0 every minute, TBWI's VCP 90 every six.
VCP_MODES: dict[int, str] = {80: "Hazardous Mode", 90: "Monitor Mode"}

# Not "has no Level II": Unidata does keep TDWR volumes (TMEM20261031_000741_V08:
# 16 sweeps of REF, VEL and SW). This viewer's volume tools read only WSR-88Ds.
LEVEL2_NOTE = "Cross-sections, the 3D view and detections read NEXRAD volumes: they are not available on a TDWR airport radar. Pick a NEXRAD radar."


def is_tdwr(site: Optional[str]) -> bool:
    """True for a TDWR's 3-letter id or its T-prefixed ICAO ('BWI', 'TBWI')."""
    s = (site or "").strip().upper()
    if len(s) == 4 and s[0] == "T":
        s = s[1:]
    return s in IDS


def sid_of(site: str) -> str:
    s = (site or "").strip().upper()
    return s[1:] if len(s) == 4 else s


def archive_id(sid: str, day: str) -> str:
    """The name a radar's scans are filed under on a UTC day ('2024_05_07' or
    '2024-05-07'): the old one before a rename."""
    was = _FORMER.get(sid)
    if was and day.replace("_", "-")[:10] < was[1]:
        return was[0]
    return sid


def gate_km(product: str) -> Optional[float]:
    """The gate spacing of a TDWR product, km; None for anything else."""
    if product == "TZL":
        return _GATE_KM_TZL
    if product in PRODUCTS:
        return _GATE_KM.get(product[:2])
    return None


def sites() -> list[dict]:
    """The radars as the site list serves them."""
    return [
        {
            "id": sid,
            "icao": f"T{sid}",
            "name": place,
            "lat": lat,
            "lon": lon,
            "country": "US",
            "online": True,
            "state": state,
            "wfo": wfo,
            "elev": elev,
            "tz": tz,
            "type": "TDWR",
        }
        for sid, place, state, wfo, lat, lon, elev, tz in _SITES
    ]


# ---------------------------------------------------------------------------
# A product code on the other kind of radar.
#
# A pane can hold a product while its radar changes, or be given a radar of its
# own, and the codes differ (N0B here, TZ0 there). The app moves to the radar's
# real code as soon as it can; this answers the requests in between with the
# nearest thing the radar publishes, not with an error.
# ---------------------------------------------------------------------------
_L3_RE = re.compile(r"^N([0A1B23])([A-Z])$")
_SLOT_TO_TDWR = {"L": "0", "0": "0", "A": "1", "1": "1", "B": "1", "2": "2", "3": "2"}
# A NEXRAD's whole-volume products a TDWR has no match for.
_NEXRAD_FLAT = {"HHC", "OHA", "DAA", "DTA"}
_TO_NEXRAD = {"TZ0": "N0B", "TZ1": "N1B", "TZ2": "N2B", "TZL": "N0B", "TV0": "N0G", "TV1": "N1G", "TV2": "N1G",
              "NVL": "DVL", "NET": "EET"}


class NotOnTdwr(ValueError):
    """A product a TDWR does not have. Answered with its reflectivity, a pane said
    Correlation Coefficient over reflectivity data."""


def to_tdwr(product: str) -> str:
    """The code a TDWR publishes for a moment's `product`: reflectivity, velocity,
    echo tops and VIL have one; the rest (dual-pol, SRV, NROT, composites, precip
    totals) raise NotOnTdwr.
    Anything that is not a moment on a map (NST, NMD, NVW) goes through as it is:
    a TDWR publishes those under the same codes."""
    p = (product or "").upper()
    if p in PRODUCTS:
        return p
    if p == "EET" or p.startswith("L2ET"):
        return "NET"
    if p == "DVL" or p.startswith("L2VIL") or p.startswith("L2DVIL"):
        return "NVL"
    m = _L3_RE.match(p)
    if m:
        slot, fam = m.groups()
        if fam in ("B", "G"):
            return f"{'TZ' if fam == 'B' else 'TV'}{_SLOT_TO_TDWR[slot]}"
        raise NotOnTdwr(f"NEXRAD only: a TDWR has no {p}")
    if p.startswith("L2"):
        # Level II codes: L2<moment><slot>, with any options after it.
        slot_m = re.search(r"([LA0-9B])(?:[@:].*)?$", p)
        slot = _SLOT_TO_TDWR.get(slot_m.group(1), "0") if slot_m else "0"
        if p.startswith(("L2B", "L2G")):
            return f"{'TZ' if p.startswith('L2B') else 'TV'}{slot}"
        raise NotOnTdwr(f"NEXRAD only: a TDWR has no {p}")
    if p in _NEXRAD_FLAT:
        raise NotOnTdwr(f"NEXRAD only: a TDWR has no {p}")
    return p


def to_nexrad(product: str) -> str:
    """The WSR-88D product closest to a TDWR's code (anything else: unchanged)."""
    p = (product or "").upper()
    return _TO_NEXRAD.get(p, product)


def for_site(site: str, product: str) -> str:
    """The code to ask `site` for when `product` may belong to the other kind."""
    if is_tdwr(site):
        return to_tdwr(product)
    return to_nexrad(product)
