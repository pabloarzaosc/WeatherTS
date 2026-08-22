"""
NEXRAD single-site radar (Level III).

Source: Unidata's public S3 archive of NEXRAD Level III products, which is live
(a new scan every ~4 min) and carries the full RadarScope-style product list.
Keys look like `ATX_N0B_2026_07_15_23_57_55` (3-letter site, product, UTC time).

Pipeline: newest S3 key -> MetPy Level3File decode -> polar (az/range) reprojected
to lat/lon -> matplotlib raster -> transparent PNG + bounds for a MapLibre image
overlay. Palettes are selectable per product.
"""
from __future__ import annotations

import io
import math
import re
import time
from collections import OrderedDict
from typing import Any, Optional

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
from matplotlib.colors import LinearSegmentedColormap, Normalize
from metpy.io import Level3File
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

S3 = "https://unidata-nexrad-level3.s3.amazonaws.com/"
IEM_SITES = "https://mesonet.agron.iastate.edu/geojson/network/NEXRAD.geojson"

_HTTP_TIMEOUT = (8, 30)
_SESSION = requests.Session()
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

# ---------------------------------------------------------------------------
# Products (the RadarScope-style list).
#
# Tilted Level III codes are `N<slot><family>`: the middle character selects the
# elevation cut, the last one the moment. The slots are NOT in elevation order --
# 'B' (1.8) sits between '1' (1.3) and '2' (2.4) -- so TILT_SLOTS is written in
# true ascending order and everything downstream follows it.
#
# Elevations here are the VCP nominals used for labelling before a scan loads;
# the real angle comes back in each scan's meta (`elevation`). Verified against
# KATX 2026-07-16.
# ---------------------------------------------------------------------------
TILT_SLOTS: list[tuple[str, float]] = [
    ("0", 0.5),
    ("A", 0.9),
    ("1", 1.3),
    ("B", 1.8),
    ("2", 2.4),
    ("3", 3.1),
]
_ALL_TILTS = [s for s, _ in TILT_SLOTS]

# Which cuts each moment is actually published at (probed against the live
# archive -- velocity only goes to 1.3, and SRV is single-tilt).
FAMILIES: dict[str, dict[str, Any]] = {
    "B": {"label": "Reflectivity", "units": "dBZ", "kind": "ref", "tilts": _ALL_TILTS},
    "G": {"label": "Velocity", "units": "kt", "kind": "vel", "tilts": ["0", "A", "1"]},
    # SRV is *computed* from super-res base velocity, not read from the N0S
    # product -- see _SRV_SOURCE. That's why it carries velocity's tilt list.
    "S": {"label": "Storm Relative Velocity", "units": "kt", "kind": "srv", "tilts": ["0", "A", "1"]},
    "C": {"label": "Correlation Coefficient", "units": "", "kind": "cc", "tilts": _ALL_TILTS},
    "X": {"label": "Differential Reflectivity", "units": "dB", "kind": "zdr", "tilts": _ALL_TILTS},
    "K": {"label": "Specific Differential Phase", "units": "°/km", "kind": "kdp", "tilts": _ALL_TILTS},
    "H": {"label": "Hydrometeor Classification", "units": "", "kind": "hca", "tilts": _ALL_TILTS},
}

# Products with a single, whole-volume answer -- no elevation to pick.
FLAT_PRODUCTS: dict[str, dict[str, Any]] = {
    "HHC": {"label": "Hybrid Hydrometeor Classification", "units": "", "kind": "hca"},
    "EET": {"label": "Enhanced Echo Tops", "units": "kft", "kind": "tops"},
    "DVL": {"label": "Vertical Integrated Liquid", "units": "kg/m²", "kind": "vil"},
    "OHA": {"label": "One Hour Precip. Accum.", "units": "in", "kind": "precip"},
    "DAA": {"label": "One Hour Precip. Accum. (digital)", "units": "in", "kind": "precip"},
    "DTA": {"label": "Storm Total Precip. Accum.", "units": "in", "kind": "storm_precip"},
}

_ELEV = dict(TILT_SLOTS)

# Products whose scale MetPy reads without the spec's x100 factor. See _value_lut.
_ACCUM_X100 = {"DAA", "DTA"}

# Product Description Block halfword 8. The VCP number sits beside it and both
# come free with every Level III scan, so the panel can name the scan strategy.
_OP_MODES = {0: "Maintenance", 1: "Clear Air Mode", 2: "Precipitation Mode"}


def _build_products() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for fam, spec in FAMILIES.items():
        for slot in spec["tilts"]:
            out[f"N{slot}{fam}"] = {
                "label": spec["label"],
                "units": spec["units"],
                "kind": spec["kind"],
                "family": fam,
                "tilt": slot,
                "elev": _ELEV[slot],
            }
    for code, spec in FLAT_PRODUCTS.items():
        out[code] = {**spec, "family": code, "tilt": None, "elev": None}
    return out


PRODUCTS: dict[str, dict[str, Any]] = _build_products()
DEFAULT_PRODUCT = "N0B"


def product_catalog() -> list[dict[str, Any]]:
    """Families for the picker: one entry per moment, with its tilt options."""
    cat: list[dict[str, Any]] = []
    for fam, spec in FAMILIES.items():
        cat.append({
            "id": fam,
            "label": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "tilts": [
                {"code": f"N{s}{fam}", "tilt": s, "elev": _ELEV[s]} for s in spec["tilts"]
            ],
        })
    for code, spec in FLAT_PRODUCTS.items():
        cat.append({
            "id": code,
            "label": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "tilts": [{"code": code, "tilt": None, "elev": None}],
        })
    return cat

# ---------------------------------------------------------------------------
# Palettes — parsed from GRLevelX-style .pal tables (value-anchored stops).
# ---------------------------------------------------------------------------
def parse_pal(pal: str) -> list[tuple[float, tuple[float, float, float, float]]]:
    """`value r g b [a]` per line -> sorted [(value, (r,g,b,a))] in 0..1 floats.

    Also accepts the GRLevelX keyword form (`Color: value r g b [r2 g2 b2]`,
    `Product:`/`Units:`/`Step:` headers). This is the coarse server-side reader
    -- it only needs each stop's first colour to derive vmin/vmax. The browser
    does the real colouring with the full segment semantics (src/lib/pal.ts).

    Alpha is optional; 0..1 is taken as a fraction, >1 as 0..255. Comments after
    ';' and blank lines are ignored.
    """
    stops: list[tuple[float, tuple[float, float, float, float]]] = []
    for raw in pal.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        if ":" in line:
            key, _, rest = line.partition(":")
            if not key.strip().lower().startswith(("color", "solidcolor")):
                continue  # Product:/Units:/Step:/... -- no stop here
            line = rest.strip()
        parts = line.split()
        try:
            nums = [float(p) for p in parts[:5]]
        except ValueError:
            continue
        if len(nums) < 4:
            continue
        val, r, g, b = nums[0], nums[1], nums[2], nums[3]
        a = nums[4] if len(nums) >= 5 else 255.0
        if a <= 1.0:
            a *= 255.0
        stops.append((val, (r / 255.0, g / 255.0, b / 255.0, a / 255.0)))
    stops.sort(key=lambda s: s[0])
    return stops


def pal_to_cmap(name: str, pal: str) -> tuple[LinearSegmentedColormap, float, float]:
    """Build a colormap + the value range the stops span.

    Stops are placed at their real data value (normalised into the cmap's 0..1
    axis), so pairing this cmap with Normalize(vmin, vmax) reproduces the table
    exactly — including alpha, which is what makes low values drop out.
    """
    stops = parse_pal(pal)
    if not stops:
        raise ValueError(f"empty palette: {name}")
    vmin, vmax = stops[0][0], stops[-1][0]
    span = (vmax - vmin) or 1.0
    colors = [(max(0.0, min(1.0, (v - vmin) / span)), rgba) for v, rgba in stops]
    # Two stops at the same value is how a .pal author writes a HARD BREAK: the
    # segment ends on one colour and the next starts on another with no ramp
    # between. Matplotlib rejects that outright ("must increase monotonically"),
    # which took out the published CC and ZDR tables entirely. Nudging the
    # second one up by the smallest representable step keeps the break sharp and
    # keeps the table usable.
    fixed: list[tuple[float, tuple[float, float, float, float]]] = []
    for pos, rgba in colors:
        if fixed and pos <= fixed[-1][0]:
            pos = math.nextafter(fixed[-1][0], 1.0)
        fixed.append((pos, rgba))
    return LinearSegmentedColormap.from_list(name, fixed), vmin, vmax


def _cmap(name: str, colors: list[tuple[float, str]]) -> LinearSegmentedColormap:
    return LinearSegmentedColormap.from_list(name, colors)


# Standard value-anchored tables (provenance in pal_tables.py).
from pal_tables import PAL_TABLES

# palette id -> label + the .pal table it renders from.
PALETTES: dict[str, dict[str, Any]] = {
    # Files in <repo>/palettes: the NEXRAD Level-3 tables from NOAA's Weather
    # and Climate Toolkit. Defaults for almost everything, because they are the
    # published palettes for these product codes -- a value reads the same
    # colour here as in any other display built on them.
    "FILE_DR": {"label": "Reflectivity", "pal": PAL_TABLES["FILE_DR"]},
    "FILE_DV": {"label": "Velocity (WCT)", "pal": PAL_TABLES["FILE_DV"]},
    # Pablo's own base-velocity table, and the default for velocity. Converted
    # from its authored mph to knots on the way into palettes/ -- see the header
    # in the file; the parser ignores `Scale:`, so an unconverted mph table
    # would place every colour about 15% off.
    "FILE_amixof2BV": {"label": "Velocity", "pal": PAL_TABLES["FILE_amixof2BV"]},
    "FILE_SRV": {"label": "Storm Relative Velocity", "pal": PAL_TABLES["FILE_SRV"]},
    "FILE_ET": {"label": "Echo Tops (WCT)", "pal": PAL_TABLES["FILE_ET"]},
    "FILE_ET_steep": {"label": "Echo Tops", "pal": PAL_TABLES["FILE_ET_steep"]},
    "FILE_VIL": {"label": "Vertically Integrated Liquid", "pal": PAL_TABLES["FILE_VIL"]},
    "FILE_HC": {"label": "Hydrometeor Classification", "pal": PAL_TABLES["FILE_HC"]},
    "FILE_ZDR": {"label": "Differential Reflectivity", "pal": PAL_TABLES["FILE_ZDR"]},
    "FILE_KDP": {"label": "Specific Differential Phase", "pal": PAL_TABLES["FILE_KDP"]},
    "FILE_KDP2": {"label": "Differential Phase (WCT)", "pal": PAL_TABLES["FILE_KDP2"]},
    "FILE_SW": {"label": "Spectrum Width", "pal": PAL_TABLES["FILE_SW"]},
    "FILE_OHP": {"label": "One Hour Precip", "pal": PAL_TABLES["FILE_OHP"]},
    "FILE_STP": {"label": "Storm Total Precip", "pal": PAL_TABLES["FILE_STP"]},
    "FILE_CC": {"label": "Correlation Coefficient (WCT, x100)", "pal": PAL_TABLES["FILE_CC"]},

    # The hand-tuned tables, still selectable. CC and PHI stay the DEFAULTS:
    # the WCT correlation table is authored in rho x100 (stops 20-105) while our
    # decoder hands over rho itself (0-1.05), and WCT's differential phase table
    # stops at 180 deg where the field runs to 360. Both would clamp almost
    # everything to one colour.
    # The alternates below stay in the table but are hidden from the picker;
    # see the note under _KIND_DEFAULT_PALETTE.
    "REF": {"label": "Reflectivity (alternate)", "pal": PAL_TABLES["REF"]},
    "VEL": {"label": "Velocity (Viper HD)", "pal": PAL_TABLES["VEL"]},
    "SRV": {"label": "Storm Relative Velocity", "pal": PAL_TABLES["SRV"]},
    "CC": {"label": "Correlation Coefficient", "pal": PAL_TABLES["CC"]},
    "ZDR": {"label": "Differential Reflectivity", "pal": PAL_TABLES["ZDR"]},
    "KDP": {"label": "Specific Differential Phase", "pal": PAL_TABLES["KDP"]},
    "DHC": {"label": "Hydrometeor Classification (legacy)", "pal": PAL_TABLES["DHC"]},
    "SW": {"label": "Spectrum Width", "pal": PAL_TABLES["SW"]},
    "PHI": {"label": "Differential Phase", "pal": PAL_TABLES["PHI"]},
    "CFP": {"label": "Clutter Filter Power", "pal": PAL_TABLES["CFP"]},
    "EET": {"label": "Echo Tops (legacy)", "pal": PAL_TABLES["EET"]},
    "DAA": {"label": "1-hr Precip Accum (legacy)", "pal": PAL_TABLES["DAA"]},
    "DTA": {"label": "Storm Total Accum (legacy)", "pal": PAL_TABLES["DTA"]},
}

# Table a product kind uses. VIL used to borrow the storm-total table, which
# capped at 10 while VIL runs to ~80 -- the whole field clamped to one colour.
_KIND_DEFAULT_PALETTE = {
    "ref": "FILE_DR", "vel": "FILE_amixof2BV", "srv": "FILE_SRV", "cc": "CC", "zdr": "FILE_ZDR",
    "kdp": "FILE_KDP", "hca": "FILE_HC", "sw": "FILE_SW", "tops": "FILE_ET_steep", "vil": "FILE_VIL",
    "precip": "FILE_OHP", "storm_precip": "FILE_STP", "phi": "PHI", "cfp": "CFP",
}

# One palette per product in the picker: the one that product actually uses.
#
# The alternates are kept in PALETTES -- ids like "REF" and "VEL" are what half
# the codebase falls back to, and usePaletteStore maps an imported file's
# `Product:` header (BR/BREF/REF/R/Z, BV/SRM, ...) onto them -- but they no
# longer appear as things to choose between. Offering two tables for the same
# moment was worse than noise: pointing an imported palette at the one that is
# NOT the product's default replaced a table nothing was drawing, so the import
# looked broken through no fault of its own.
for _pid, _entry in PALETTES.items():
    _entry["hidden"] = _pid not in set(_KIND_DEFAULT_PALETTE.values())

# A default that names a palette nobody defined renders as a KeyError deep in
# get_cmap, at the moment someone opens that product. Fail here instead.
for _kind, _pid in _KIND_DEFAULT_PALETTE.items():
    if _pid not in PALETTES:
        raise RuntimeError(f"default palette {_pid!r} for {_kind!r} is not in PALETTES")

_CMAPS: dict[str, tuple[LinearSegmentedColormap, float, float]] = {}


def get_cmap(pid: str) -> tuple[LinearSegmentedColormap, float, float]:
    """cmap + the (vmin, vmax) its stops span. Built once per palette."""
    if pid not in _CMAPS:
        _CMAPS[pid] = pal_to_cmap(pid, PALETTES[pid]["pal"])
    return _CMAPS[pid]


def list_products() -> list[dict[str, str]]:
    return [{"id": k, "label": v["label"], "units": v["units"]} for k, v in PRODUCTS.items()]


def list_palettes() -> list[dict[str, str]]:
    """The palettes a user can pick between. Hidden ones still resolve by id."""
    return [
        {"id": k, "label": v["label"]}
        for k, v in PALETTES.items()
        if not v.get("hidden")
    ]


# ---------------------------------------------------------------------------
# Sites
# ---------------------------------------------------------------------------
_SITES_CACHE: tuple[float, list[dict]] | None = None


def list_sites() -> list[dict]:
    """NEXRAD sites (3-letter id matches the S3 key prefix)."""
    global _SITES_CACHE
    now = time.time()
    if _SITES_CACHE and now - _SITES_CACHE[0] < 86400:
        return _SITES_CACHE[1]
    r = _SESSION.get(IEM_SITES, timeout=_HTTP_TIMEOUT)
    r.raise_for_status()
    sites: list[dict] = []
    for f in r.json().get("features", []):
        p = f.get("properties") or {}
        sid = str(p.get("sid") or "").strip()
        lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
        if not sid or lat is None or lon is None:
            continue
        sites.append({
            "id": sid,                 # 3-letter (S3 prefix)
            "icao": f"K{sid}",         # display
            "name": p.get("sname") or sid,
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "country": p.get("country"),
            "online": bool(p.get("online")),
        })
    _SITES_CACHE = (now, sites)
    return sites


# ---------------------------------------------------------------------------
# Fetch + decode
# ---------------------------------------------------------------------------
_KEY_CACHE: dict[tuple, tuple[float, Optional[str]]] = {}
_SCANS_CACHE: dict[tuple, tuple[float, list[dict]]] = {}

# The Unidata archive starts ~2022-03; every day since has ~180-385 scans/product.
ARCHIVE_START = "2022-03-01"


def _utc_unix(dt) -> Optional[int]:
    """Naive-UTC datetime -> unix seconds (never reinterpret it as local time)."""
    from datetime import timezone

    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def key_time(key: str) -> Optional[int]:
    """`ATX_N0B_2026_07_15_23_57_55` -> unix seconds (UTC)."""
    from datetime import datetime, timezone

    m = re.search(r"_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$", key)
    if not m:
        return None
    y, mo, d, h, mi, s = (int(x) for x in m.groups())
    return int(datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp())


def _list_keys(site: str, product: str, day: str) -> list[str]:
    """All S3 keys for site+product on a UTC day ('YYYY_MM_DD')."""
    prefix = f"{site}_{product}_{day}"
    r = _SESSION.get(S3, params={"list-type": "2", "max-keys": "1000", "prefix": prefix}, timeout=_HTTP_TIMEOUT)
    if not r.ok:
        return []
    return re.findall(r"<Key>([^<]+)</Key>", r.text)


def _scans_for_day(site: str, product: str, day: str) -> list[dict]:
    """One UTC day's scans, ascending. Cached: today briefly, past days for good."""
    from datetime import datetime, timezone

    cache_key = (site, product, day)
    now = time.time()
    hit = _SCANS_CACHE.get(cache_key)
    is_today = day == datetime.now(timezone.utc).strftime("%Y_%m_%d")
    # Today's listing has to stay fresh: this TTL adds directly to how late a
    # new scan shows up, on top of the client's poll interval.
    if hit and (now - hit[0] < (15 if is_today else 86400)):
        return hit[1]

    scans = [{"key": k, "time": key_time(k)} for k in _list_keys(site, product, day)]
    scans = [s for s in scans if s["time"] is not None]
    scans.sort(key=lambda s: s["time"])
    _SCANS_CACHE[cache_key] = (now, scans)
    return scans


def list_scans(site: str, product: str, date: Optional[str] = None, limit: int = 0,
               start: Optional[int] = None) -> list[dict]:
    """Scans as [{key, time}], ascending.

    Three modes:
      * `start` (unix seconds) -- archive playback: the first `limit` scans at or
        after that instant, walking forward through UTC days. This is what the
        calendar drives: pick a moment, get a contiguous loop from there.
      * `date` -- a whole UTC day, thinned evenly to `limit`.
      * neither -- live: the most recent `limit` scans.

    Keys are bucketed per UTC day, so live has to walk *back* through days or a
    loop asked for just after 00Z is capped at whatever the new day holds.
    """
    from datetime import datetime, timedelta, timezone

    site = (site or "").upper().strip()
    product = (product or DEFAULT_PRODUCT).upper().strip()
    # SRV frames are velocity frames -- list the source cut so scrubbing the loop
    # hands polar_data a key it can actually decode.
    product = _SRV_SOURCE.get(product, product)

    if start is not None:
        begin = datetime.fromtimestamp(start, timezone.utc)
        now = datetime.now(timezone.utc)
        scans: list[dict] = []
        day = begin
        # forward through days until the loop is full or we reach the present
        for _ in range(8):
            if day.date() > now.date():
                break
            got = _scans_for_day(site, product, day.strftime("%Y_%m_%d"))
            scans.extend(s for s in got if s["time"] >= start)
            if limit and len(scans) >= limit:
                break
            day = day + timedelta(days=1)
        scans.sort(key=lambda s: s["time"])
        return scans[:limit] if limit else scans

    if date:
        scans = _scans_for_day(site, product, date.replace("-", "_"))
    else:
        today = datetime.now(timezone.utc)
        scans = []
        # a day holds ~200-440 scans, so 3 days covers even the longest loop
        for back in range(3):
            day = (today - timedelta(days=back)).strftime("%Y_%m_%d")
            scans = _scans_for_day(site, product, day) + scans
            if limit and len(scans) >= limit:
                break

    if limit and len(scans) > limit:
        if date:
            # a pinned day: thin evenly so the loop still spans the whole day
            step = len(scans) / limit
            idx = sorted({min(len(scans) - 1, int(round(i * step))) for i in range(limit)})
            idx[-1] = len(scans) - 1  # always keep the newest
            scans = [scans[i] for i in idx]
        else:
            # live: a contiguous loop of the most recent scans, like any radar app
            scans = scans[-limit:]
    return scans


def _latest_key(site: str, product: str) -> Optional[str]:
    """Newest S3 key for a site+product (checks today then yesterday, UTC)."""
    from datetime import datetime, timedelta, timezone

    cache_key = (site, product)
    now = time.time()
    hit = _KEY_CACHE.get(cache_key)
    if hit and now - hit[0] < 15:  # scans arrive ~every 4 min
        return hit[1]

    today = datetime.now(timezone.utc)
    for day in (today, today - timedelta(days=1)):
        keys = _list_keys(site, product, day.strftime("%Y_%m_%d"))
        if keys:
            _KEY_CACHE[cache_key] = (now, keys[-1])
            return keys[-1]
    _KEY_CACHE[cache_key] = (now, None)
    return None


def _decode(raw: bytes, product: str = ""):
    f = Level3File(io.BytesIO(raw))
    datadict = f.sym_block[0][0]
    if PRODUCTS.get(product, {}).get("kind") == "hca":
        # Classification products aren't a continuous scale: the raw byte IS the
        # category code (0=below threshold, 10=biological, ... 150=range folded)
        # and the DHC palette is anchored to those codes. map_data() would divide
        # them by 10 into a category index, which no longer matches the table.
        vals = np.asarray(datadict["data"], dtype=float)
        vals[vals == 0] = np.nan  # below threshold -> draw nothing
        data = np.ma.masked_invalid(vals)
    else:
        data = np.ma.masked_invalid(np.asarray(f.map_data(datadict["data"]), dtype=float))
    az = np.array(datadict["start_az"] + [datadict["end_az"][-1]], dtype=float)
    rng = np.linspace(0, f.max_range, data.shape[-1] + 1)
    return f, az, rng, data


def _polar_to_lonlat(site_lat: float, site_lon: float, az: np.ndarray, rng: np.ndarray):
    """Azimuth (deg from N) + range (km) -> lon/lat mesh edges."""
    a = np.deg2rad(az)[:, None]
    r = rng[None, :]
    x = r * np.sin(a)  # east km
    y = r * np.cos(a)  # north km
    lat = site_lat + y / 111.32
    lon = site_lon + x / (111.32 * np.cos(np.deg2rad(site_lat)))
    return lon, lat


def _resolve_palette(product: str, palette: Optional[str]) -> str:
    """Palette id to use: explicit choice, else the product kind's default."""
    if palette and palette in PALETTES:
        return palette
    kind = PRODUCTS.get(product, {}).get("kind", "ref")
    return _KIND_DEFAULT_PALETTE.get(kind, "REF")


_RENDER_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 120.0

# A decoded scan never changes, so this is keyed by the S3 key and needs no TTL
# -- it just needs a bound. ~1.4 MB each; 60 covers a full day's animation.
_POLAR_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_POLAR_CACHE_MAX = 60


def _value_lut(f: "Level3File", product: str) -> np.ndarray:
    """code (0-255) -> physical value, NaN where there's no data.

    Each product carries its own level table, and they are NOT all 256 long:
    SRV and OHA are legacy 16-level products, KDP's is 244. Calling
    `map_data(arange(256))` therefore blows up with an IndexError on exactly
    those products -- which is why SRV/KDP/EET/OHA were dead. Read the mapper's
    lut directly and pad the unused codes with NaN instead.
    """
    if PRODUCTS.get(product, {}).get("kind") == "hca":
        # see _decode: the code IS the category, and 0 means below threshold
        lut = np.arange(256, dtype=np.float32)
        lut[0] = np.nan
        return lut

    out = np.full(256, np.nan, dtype=np.float32)
    src = np.asarray(f.map_data.lut, dtype=np.float32)
    n = min(len(src), 256)
    out[:n] = src[:n]
    # MetPy encodes "below threshold"/"range folded" as huge sentinels; they are
    # not data, so drop them rather than letting them stretch the scale.
    out[~np.isfinite(out)] = np.nan
    out[np.abs(out) > 1e30] = np.nan

    # The digital accumulation products (DAA/DTA) declare scale as
    # `float * 100` -- MetPy builds its lut without that factor, so its values
    # come out 100x too large (a 2.1" storm total reads as 211"). Confirmed
    # against the NEXRAD L3 spec as implemented in SparkRadar's MIT-licensed
    # products/170 + /172 decoders (`scale: raf.readFloat() * 100`).
    if product in _ACCUM_X100:
        out /= 100.0
    return out


# Storm-relative velocity is derived, not fetched: the ready-made N0S product is
# 1 deg x 1 km / 230 km (82k gates), while base velocity is super-res 0.5 deg x
# 0.25 km (864k gates). Subtracting the storm-motion component from super-res
# velocity gives the same field at ~10x the detail, which is what the good radar
# apps display. These map the SRV wire code to the velocity cut it comes from.
_SRV_SOURCE = {"N0S": "N0G", "NAS": "NAG", "N1S": "N1G"}

_KT_PER_KMH = 0.539957


def _mean_storm_motion(site: str) -> tuple[float, float]:
    """Mean SCIT storm motion as (speed_kt, bearing_deg_toward).

    Averaged over every tracked cell's first forecast leg (SCIT forecasts are a
    fixed 15 min apart). Falls back to calm (0, 0) -- with no motion SRV is just
    base velocity, which is the right degenerate answer.
    """
    try:
        key = _latest_key(site, "NST")
        if not key:
            return (0.0, 0.0)
        f = Level3File(io.BytesIO(_SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content))
        block = f.sym_block[0] if getattr(f, "sym_block", None) else []
        us: list[float] = []
        vs: list[float] = []
        for i, p in enumerate(block):
            if not (isinstance(p, dict) and p.get("type") == "Storm ID"):
                continue
            for q in block[i + 1 : i + 4]:
                if not (isinstance(q, dict) and "track" in q):
                    continue
                if "forecast" not in str(q.get("markers", "")):
                    continue
                trk = q["track"]
                if isinstance(trk, list) and len(trk) >= 2:
                    dx = float(trk[1][0]) - float(trk[0][0])  # km east over 15 min
                    dy = float(trk[1][1]) - float(trk[0][1])  # km north
                    us.append(dx / 0.25 * _KT_PER_KMH)
                    vs.append(dy / 0.25 * _KT_PER_KMH)
                break
        if not us:
            return (0.0, 0.0)
        u = sum(us) / len(us)
        v = sum(vs) / len(vs)
        return (math.hypot(u, v), math.degrees(math.atan2(u, v)) % 360.0)
    except Exception:
        return (0.0, 0.0)


def _srv_polar(site: str, product: str, src_product: str, key: Optional[str]) -> dict:
    """Storm-relative velocity built from a super-res base-velocity cut."""
    if not key:
        key = _latest_key(site, src_product)
    if not key:
        raise RuntimeError(f"No recent velocity scan for K{site}.")

    cache_key = (site, product, key)
    hit = _POLAR_CACHE.get(cache_key)
    if hit is not None:
        _POLAR_CACHE.move_to_end(cache_key)
        return hit

    f = Level3File(io.BytesIO(_SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content))
    d = f.sym_block[0][0]
    codes = np.asarray(d["data"], dtype=np.uint8)
    az = np.array(d["start_az"] + [d["end_az"][-1]], dtype=np.float32)
    rng = np.linspace(0, f.max_range, codes.shape[-1] + 1)

    vals = _value_lut(f, src_product)[codes]  # kt, NaN where no data

    # Remove the storm-motion component along each radial. A radial pointing
    # along the storm's heading sees the full speed; perpendicular sees none.
    speed_kt, toward_deg = _mean_storm_motion(site)
    az_mid = 0.5 * (az[:-1] + az[1:])
    radial = speed_kt * np.cos(np.radians(az_mid - toward_deg))
    srv = vals - radial[:, None]

    # Re-quantise to the wire format (code 0 = no data, 1..255 across the scale).
    pid = _resolve_palette(product, None)
    _, vmin, vmax = get_cmap(pid)
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)
    t = (srv - vmin) / (vmax - vmin or 1.0)
    q = np.clip(np.rint(t * 254.0) + 1.0, 1, 255)
    q[~np.isfinite(srv)] = 0
    out_codes = q.astype(np.uint8)

    spec = PRODUCTS[product]
    out = {
        "az": az,
        "lut": lut,
        "codes": out_codes,
        "meta": {
            "site": f"K{site}",
            "siteLat": float(f.lat),
            "siteLon": float(f.lon),
            "product": product,
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": spec.get("family"),
            "tilt": spec.get("tilt"),
            "elevation": float(f.metadata.get("el_angle")) if f.metadata.get("el_angle") is not None else None,
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": int(out_codes.shape[0]),
            "nGates": int(out_codes.shape[1]),
            "rangeStartKm": float(rng[0]),
            "gateWidthKm": float(rng[1] - rng[0]),
            "maxRangeKm": float(f.max_range),
            "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
            "scanUnix": key_time(key),
            "key": key,
            # so the UI can show what motion was removed
            "stormMotionKt": round(speed_kt, 1),
            "stormMotionDeg": round(toward_deg, 1),
            "derivedFrom": src_product,
            "vcp": int(f.prod_desc.vcp),
            "mode": _OP_MODES.get(int(f.prod_desc.op_mode), f"Mode {f.prod_desc.op_mode}"),
        },
    }
    _POLAR_CACHE[cache_key] = out
    while len(_POLAR_CACHE) > _POLAR_CACHE_MAX:
        _POLAR_CACHE.popitem(last=False)
    return out


def polar_data(site: str, product: str, key: Optional[str] = None) -> dict:
    """Raw polar scan for client-side (GPU) rendering.

    Ships the gates as their native 8-bit codes plus a 256-entry code->value
    table, not as floats. Level III data is quantised to 256 levels anyway, so
    this is lossless -- and it keeps the payload at 1 byte/gate instead of 4,
    which matters more for the gzip CPU than for the wire: expanding to float32
    first made a 178 KB source file into 5.3 MB that then cost ~600 ms to
    compress back down. This way it's ~20 ms.

    The browser resolves value = lut[code] when it builds the mesh.
    """
    site = (site or "").upper().strip()
    product = (product or DEFAULT_PRODUCT).upper().strip()
    if product not in PRODUCTS:
        product = DEFAULT_PRODUCT

    # SRV is derived from the matching super-res velocity cut, not fetched.
    src = _SRV_SOURCE.get(product)
    if src:
        return _srv_polar(site, product, src, key)

    if not key:
        key = _latest_key(site, product)
    if not key:
        raise RuntimeError(f"No recent {PRODUCTS[product]['label']} scan for K{site}.")

    cache_key = (site, product, key)
    hit = _POLAR_CACHE.get(cache_key)
    if hit is not None:
        _POLAR_CACHE.move_to_end(cache_key)
        return hit

    raw = _SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content
    f = Level3File(io.BytesIO(raw))
    datadict = f.sym_block[0][0]
    codes = np.asarray(datadict["data"], dtype=np.uint8)
    az = np.array(datadict["start_az"] + [datadict["end_az"][-1]], dtype=np.float32)
    rng = np.linspace(0, f.max_range, codes.shape[-1] + 1)

    spec = PRODUCTS[product]
    pid = _resolve_palette(product, None)
    _, vmin, vmax = get_cmap(pid)
    out = {
        "az": az,                                     # naz + 1 edges (deg from N)
        "lut": _value_lut(f, product),                # 256 floats
        "codes": codes,                               # naz x ngates, uint8
        "meta": {
            "site": f"K{site}",
            "siteLat": float(f.lat),
            "siteLon": float(f.lon),
            "product": product,
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": spec.get("family"),
            "tilt": spec.get("tilt"),
            # the cut this scan was actually taken at, not the VCP nominal
            "elevation": float(f.metadata.get("el_angle")) if f.metadata.get("el_angle") is not None else None,
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": int(codes.shape[0]),
            "nGates": int(codes.shape[1]),
            "rangeStartKm": float(rng[0]),
            "gateWidthKm": float(rng[1] - rng[0]),
            "maxRangeKm": float(f.max_range),
            "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
            "scanUnix": key_time(key),
            "key": key,
            "vcp": int(f.prod_desc.vcp),
            "mode": _OP_MODES.get(int(f.prod_desc.op_mode), f"Mode {f.prod_desc.op_mode}"),
        },
    }

    _POLAR_CACHE[cache_key] = out
    while len(_POLAR_CACHE) > _POLAR_CACHE_MAX:
        _POLAR_CACHE.popitem(last=False)
    return out


def render(site: str, product: str, palette: Optional[str] = None, key: Optional[str] = None) -> dict:
    """Render a scan: `key` for a specific (historical) scan, else the newest."""
    site = (site or "").upper().strip()
    product = (product or DEFAULT_PRODUCT).upper().strip()
    if product not in PRODUCTS:
        product = DEFAULT_PRODUCT

    cache_key = (site, product, palette or "auto", key or "latest")
    now = time.time()
    hit = _RENDER_CACHE.get(cache_key)
    # a specific historical scan never changes -> cache it for the session
    if hit and (key or now - hit[0] < _TTL):
        return hit[1]

    if not key:
        key = _latest_key(site, product)
    if not key:
        raise RuntimeError(f"No recent {PRODUCTS[product]['label']} scan for K{site}.")

    raw = _SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content
    f, az, rng, data = _decode(raw, product)
    lon, lat = _polar_to_lonlat(float(f.lat), float(f.lon), az, rng)

    spec = PRODUCTS[product]
    # The .pal table itself defines the value range its stops are anchored to.
    pid = _resolve_palette(product, palette)
    cmap, vmin, vmax = get_cmap(pid)
    norm = Normalize(vmin=vmin, vmax=vmax)

    west, east = float(np.nanmin(lon)), float(np.nanmax(lon))
    south, north = float(np.nanmin(lat)), float(np.nanmax(lat))

    px = 1400
    fig = plt.figure(figsize=(px / 100, px / 100), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_xlim(west, east)
    ax.set_ylim(south, north)
    ax.pcolormesh(lon, lat, data, cmap=cmap, norm=norm, shading="flat")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, dpi=100,
                bbox_inches=None, pad_inches=0)
    plt.close(fig)

    payload = {
        "png": buf.getvalue(),
        "bounds": {"west": west, "south": south, "east": east, "north": north},
        "meta": {
            "site": f"K{site}",
            "siteLat": float(f.lat),
            "siteLon": float(f.lon),
            "product": product,
            "productLabel": spec["label"],
            "units": spec["units"],
            "vmin": vmin,
            "vmax": vmax,
            "palette": pid,
            "paletteLabel": PALETTES[pid]["label"],
            # prod_time is a NAIVE datetime already in UTC -- .timestamp() would
            # read it as local time and shift it by the server's UTC offset.
            "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
            "scanUnix": key_time(key),
            "key": key,
            "maxRangeKm": float(f.max_range),
        },
    }
    _RENDER_CACHE[cache_key] = (now, payload)
    return payload
