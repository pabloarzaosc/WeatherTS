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
import json
import math
import re
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
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

import tdwr

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
    # Normalized rotation, computed from the same super-res velocity cuts -- see
    # _nrot_polar. Unitless: 1 is significant rotation, 2.5 extreme.
    "R": {"label": "Normalized Rotation (NROT)", "units": "", "kind": "nrot", "tilts": ["0", "A", "1"]},
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

_MS_TO_KT = 1.943844

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


# The FAA's airport radars publish under their own codes (tdwr.py). They answer
# to the same families in the picker: reflectivity is reflectivity.
PRODUCTS: dict[str, dict[str, Any]] = {**_build_products(), **tdwr.PRODUCTS}
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
    # Long-range reflectivity: only a TDWR has it (hidden elsewhere).
    cat.append(dict(tdwr.CATALOG_FAMILY))
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

    Segment rules (the same as pal.ts): `Color:` carries r g b and `Color4:`
    r g b a; either may name a SECOND colour, which the segment up to the next
    stop ramps to (a hard break at the next stop). `SolidColor(4):` holds its
    colour flat up to the next stop. Both become an extra stop just below the
    next value. Alpha is read only from the 4-number forms: a two-colour
    `Color:` line's second red used to be taken as the alpha, which made those
    segments transparent. `Step:`, `Scale:`, `Offset:`, `RF:`, `Label:`,
    `Decimals:` and the rest carry no stop and are skipped.
    """
    def colour(nums: list[float], at: int, stride: int) -> tuple[float, float, float, float]:
        r, g, b = nums[at], nums[at + 1], nums[at + 2]
        a = nums[at + 3] if stride == 4 else 255.0
        if a <= 1.0:
            a *= 255.0
        return (r / 255.0, g / 255.0, b / 255.0, a / 255.0)

    entries: list[tuple[float, tuple, Optional[tuple], bool]] = []
    for raw in pal.splitlines():
        line = raw.split(";")[0].strip()
        if not line:
            continue
        key = ""
        if ":" in line:
            k, _, rest = line.partition(":")
            key = k.strip().lower()
            if not key.startswith(("color", "solidcolor")):
                continue  # Product:/Units:/Step:/Scale:/RF:/... -- no stop here
            line = rest.strip()
        try:
            nums = [float(p) for p in line.replace(",", " ").split()]
        except ValueError:
            continue
        if key:
            stride = 4 if key.endswith("4") else 3
            solid = key.startswith("solidcolor")
        else:  # bare shorthand: value r g b [a]
            stride = 4 if len(nums) >= 5 else 3
            solid = False
        if len(nums) < 1 + stride:
            continue
        c1 = colour(nums, 1, stride)
        c2 = colour(nums, 1 + stride, stride) if key and not solid and len(nums) >= 1 + 2 * stride else None
        entries.append((nums[0], c1, c2, solid))
    entries.sort(key=lambda e: e[0])

    stops: list[tuple[float, tuple[float, float, float, float]]] = []
    for i, (val, c1, c2, solid) in enumerate(entries):
        stops.append((val, c1))
        if i + 1 == len(entries):
            if c2 is not None:
                stops[-1] = (val, c2)  # past the last stop the segment's end colour holds
            continue
        nxt = entries[i + 1][0]
        end = c1 if solid else c2
        if end is not None and nxt > val:
            stops.append((nxt - (nxt - val) * 1e-6, end))
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
    "NROT": {"label": "Normalized Rotation", "pal": PAL_TABLES["NROT"]},
    # The Brazilian radars' volume products (brazil_radar.py).
    "MEHS": {"label": "Max. Expected Hail Size", "pal": PAL_TABLES["MEHS"]},
    "POSH": {"label": "Prob. of Severe Hail", "pal": PAL_TABLES["POSH"]},
    "RATE": {"label": "Rain Rate", "pal": PAL_TABLES["RATE"]},
    "EET": {"label": "Echo Tops (legacy)", "pal": PAL_TABLES["EET"]},
    "DAA": {"label": "1-hr Precip Accum (legacy)", "pal": PAL_TABLES["DAA"]},
    "DTA": {"label": "Storm Total Accum (legacy)", "pal": PAL_TABLES["DTA"]},
    # Computed from Level II volumes (radar_derived.py).
    "DVIL": {"label": "VIL Density", "pal": PAL_TABLES["DVIL"]},
    "VROT": {"label": "Rotational Velocity", "pal": PAL_TABLES["VROT"]},
    "PTDS": {"label": "Tornado Debris Score", "pal": PAL_TABLES["PTDS"]},
    # Alternates offered by the colour table menu (src/lib/colorTables.ts).
    "REF_WINTER": {"label": "Winter", "pal": PAL_TABLES["REF_WINTER"]},
    "PTDS_STEPS": {"label": "Steps", "pal": PAL_TABLES["PTDS_STEPS"]},
}

# Table a product kind uses. VIL used to borrow the storm-total table, which
# capped at 10 while VIL runs to ~80 -- the whole field clamped to one colour.
_KIND_DEFAULT_PALETTE = {
    "ref": "FILE_DR", "vel": "FILE_amixof2BV", "srv": "FILE_SRV", "cc": "CC", "zdr": "FILE_ZDR",
    "kdp": "FILE_KDP", "hca": "FILE_HC", "sw": "FILE_SW", "tops": "FILE_ET_steep", "vil": "FILE_VIL",
    "precip": "FILE_OHP", "storm_precip": "FILE_STP", "phi": "PHI", "cfp": "CFP", "nrot": "NROT",
    "mehs": "MEHS", "posh": "POSH", "rate": "RATE",
    "dvil": "DVIL", "vrot": "VROT", "ptds": "PTDS",
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
    """The radars there are to pick: IEM's list, minus the ones that are gone.

    IEM keeps radars that no longer exist and calls them online -- KLIX (New
    Orleans) among them, which stopped in 2023 when KHDC at Hammond replaced it.
    So each site's standing comes from the archive itself: a reflectivity scan
    today or yesterday is online, one in the last ninety days is a radar that
    is down, and none in ninety days is a radar that is not there any more.
    """
    sites = [dict(s) for s in _iem_sites()] + tdwr.sites()
    status = _site_status([s["id"] for s in sites])
    if not status:
        # Not worked out yet (a first run, still probing): the ones known gone.
        return [s for s in sites if s["id"] not in _KNOWN_GONE]
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    out = []
    for s in sites:
        last = status.get(s["id"], "?")
        if last is None:
            continue
        if last != "?":
            s["online"] = last >= yesterday
            s["lastScanDay"] = last
        out.append(s)
    return out


# Found by probing the archive on 2026-09-13; used only until the probe has run.
_KNOWN_GONE = {
    "LIX",  # New Orleans: last Level III in 2023, replaced by KHDC (Hammond) in March 2024
    "ODN",  # Kadena AB: no Level III in the archive for years
}

# Checks about the radars -- which exist, which are live -- get their own
# connections, so they never make a scan being loaded wait for one.
_PROBE_SESSION = requests.Session()
_PROBE_SESSION.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=2))

# sid -> the newest day with a reflectivity scan, or None for nothing in 90 days.
_STATUS_PATH = Path(tempfile.gettempdir()) / "weatherts-radar" / "site-status.json"
_STATUS: dict[str, Any] = {"at": 0.0, "last": {}}
_STATUS_TTL = 6 * 3600
_STATUS_LOCK = threading.Lock()
_STATUS_BUSY = {"on": False}
_STATUS_ASKED: set[str] = set()
# Days back to look, sparsely: a radar down for maintenance is back within
# weeks; one silent for three months has been taken down.
_LOOK_BACK_DAYS = (0, 1, 3, 7, 14, 30, 60, 90)


def live_code(sid: str) -> str:
    """The product whose newest scan says a radar is alive: its lowest reflectivity."""
    return "TZ0" if tdwr.is_tdwr(sid) else "N0B"


def newest_scan_unix(sid: str, code: str = "N0B") -> Optional[int]:
    """When a product's newest scan was, listing only the last two hours of it."""
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=2)
    for day, after in ((now, f"{sid}_{code}_{since:%Y_%m_%d_%H_%M_%S}"), (since, f"{sid}_{code}_{since:%Y_%m_%d_%H_%M_%S}")):
        r = _PROBE_SESSION.get(S3, params={"list-type": "2", "prefix": f"{sid}_{code}_{day:%Y_%m_%d}", "start-after": after},
                               timeout=_HTTP_TIMEOUT)
        keys = re.findall(r"<Key>([^<]+)</Key>", r.text)
        if keys:
            return key_time(keys[-1])
    return None


def _newest_scan_day(sid: str) -> Optional[str]:
    today = datetime.now(timezone.utc)
    code = live_code(sid)
    for back in _LOOK_BACK_DAYS:
        day = today - timedelta(days=back)
        r = _PROBE_SESSION.get(S3, params={"list-type": "2", "prefix": f"{sid}_{code}_{day:%Y_%m_%d}", "max-keys": "1"},
                               timeout=_HTTP_TIMEOUT)
        if "<Key>" in r.text:
            return day.strftime("%Y-%m-%d")
    return None


def _work_out_status(ids: list[str]) -> None:
    try:
        # Few at a time, on connections of its own: this runs as the app starts,
        # which is exactly when someone opens their first radar.
        with ThreadPoolExecutor(8) as pool:
            found = dict(zip(ids, pool.map(_probe_or_unknown, ids)))
        last = {k: v for k, v in found.items() if v != "?"}
        with _STATUS_LOCK:
            _STATUS["last"] = {**_STATUS["last"], **last}
            _STATUS["at"] = time.time()
        try:
            _STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
            _STATUS_PATH.write_text(json.dumps(_STATUS), encoding="utf-8")
        except OSError:
            pass
    finally:
        _STATUS_BUSY["on"] = False


def _probe_or_unknown(sid: str) -> Optional[str]:
    try:
        return _newest_scan_day(sid)
    except Exception:  # noqa: BLE001 - a failed probe says nothing about the radar
        return "?"


def _site_status(ids: list[str]) -> dict[str, Optional[str]]:
    """What is known, refreshed behind the answer once it is old. Never waits:
    probing 160 radars is some fifteen seconds from here, and the site list is
    what the radar layer needs first."""
    with _STATUS_LOCK:
        if not _STATUS["last"]:
            try:
                saved = json.loads(_STATUS_PATH.read_text(encoding="utf-8"))
                if time.time() - float(saved.get("at", 0)) < 86400:
                    _STATUS.update(saved)
            except (OSError, ValueError):
                pass
        known, age = dict(_STATUS["last"]), time.time() - float(_STATUS["at"])
        # A radar the saved answer has never seen is looked up once now, not in
        # six hours (a file written before the TDWRs joined the list).
        fresh = [i for i in ids if i not in known and i not in _STATUS_ASKED]
        whole = not known or age > _STATUS_TTL
        start = not _STATUS_BUSY["on"] and (whole or bool(fresh))
        if start:
            _STATUS_BUSY["on"] = True
            _STATUS_ASKED.update(ids)
    if start:
        threading.Thread(target=_work_out_status, args=(ids if whole else fresh,), daemon=True, name="radar-status").start()
    return known


def warm_site_status() -> None:
    """Work out which radars are live in the background at start-up."""
    def run() -> None:
        try:
            _site_status([s["id"] for s in _iem_sites()] + sorted(tdwr.IDS))
        except Exception:  # noqa: BLE001 - the site list asks again
            pass
    threading.Thread(target=run, daemon=True, name="radar-status-warm").start()


CHUNKS_BUCKET = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com/"
# Used only when the Level II bucket cannot be read.
_ICAO_ABROAD = {"KJK": "RKJK", "KSG": "RKSG", "PLA": "LPLA", "ODN": "RODN"}
_ICAO: dict[str, Any] = {"at": 0.0, "map": {}}


def site_id(site: str) -> str:
    """The 3-letter id Level III keys use, from either that or a 4-letter ICAO."""
    s = (site or "").upper().strip()
    return s[1:] if len(s) == 4 else s


def icao_for(site: str) -> str:
    """A radar's real 4-letter ICAO.

    Not always K + id: the radars outside the lower 48 are TJUA (San Juan), PHKI
    (Kauai), PGUA (Guam), PABC (Bethel), RKJK (Kunsan) and so on. Level II files are keyed by
    the real name, so "KJUA" found no volume at all. Read once a day from the
    Level II bucket's own top-level names.
    """
    sid = site_id(site)
    if tdwr.is_tdwr(sid):
        return f"T{sid}"
    if time.time() - float(_ICAO["at"]) > 86400:
        try:
            r = _SESSION.get(CHUNKS_BUCKET, params={"list-type": "2", "delimiter": "/"}, timeout=_HTTP_TIMEOUT)
            names = [p.rstrip("/") for p in re.findall(r"<Prefix>([^<]+)</Prefix>", r.text)]
            mapping: dict[str, str] = {}
            # K (lower 48), P (Alaska, Hawaii, Guam), R (Korea), L (Azores) are
            # WSR-88Ds; T is mostly the airport TDWRs, so it loses a tie.
            rank = {"K": 0, "P": 1, "R": 2, "L": 3, "T": 4}
            for name in names:
                if len(name) == 4 and name.isalpha() and name[0] in rank:
                    held = mapping.get(name[1:])
                    if held is None or rank[name[0]] < rank[held[0]]:
                        mapping[name[1:]] = name
            if mapping:
                _ICAO.update(at=time.time(), map=mapping)
        except Exception:  # noqa: BLE001 - K + id is right for most radars meanwhile
            pass
    return _ICAO["map"].get(sid) or _ICAO_ABROAD.get(sid) or f"K{sid}"


def l3_elevation(key: str) -> Optional[float]:
    """The elevation a Level III product was cut at, from its header alone.

    The product description block is never compressed; its dependent parameter
    3 is the angle x10 for the elevation products. Reading 400 bytes instead of
    a whole file is what makes checking every tilt of a radar affordable.
    """
    import struct as _struct
    r = _SESSION.get(S3 + key, headers={"Range": "bytes=0-399"}, timeout=_HTTP_TIMEOUT)
    b = r.content
    i = 0
    for _ in range(2):  # the WMO header: two CRLF-terminated lines
        j = b.find(b"\r\r\n", i)
        if j < 0:
            return None
        i = j + 3
    pdb = i + 18  # past the 18-byte message header
    if len(b) < pdb + 42 or _struct.unpack(">h", b[pdb:pdb + 2])[0] != -1:
        return None
    return _struct.unpack(">h", b[pdb + 40:pdb + 42])[0] / 10.0


NWS_RADAR_STATIONS = "https://api.weather.gov/radar/stations?stationType=WSR-88D"


def _nws_sites() -> list[dict]:
    """The WSR-88Ds from api.weather.gov, shaped like IEM's list: the fallback
    when IEM does not answer (2026-10-25: 25-73 s, then 502). No retired radars
    in it; whether each one is up still comes from the archive (_site_status)."""
    r = _SESSION.get(NWS_RADAR_STATIONS, timeout=_HTTP_TIMEOUT, headers={"Accept": "application/geo+json"})
    r.raise_for_status()
    sites: list[dict] = []
    for f in r.json().get("features", []):
        p = f.get("properties") or {}
        icao = str(p.get("id") or "").strip().upper()
        lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
        if len(icao) != 4 or lat is None or lon is None or icao.startswith("R"):
            continue  # RKSG / RKJK / RODN: no NEXRAD archive under a 3-letter id
        sid = icao[1:]
        sites.append({
            "id": sid,
            "icao": icao_for(sid),
            "name": p.get("name") or sid,
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "country": "US",
            "online": True,
            "elev": ((p.get("elevation") or {}).get("value") if isinstance(p.get("elevation"), dict) else None),
        })
    return sites


def _iem_sites() -> list[dict]:
    """NEXRAD sites (3-letter id matches the S3 key prefix)."""
    global _SITES_CACHE
    now = time.time()
    if _SITES_CACHE and now - _SITES_CACHE[0] < 86400:
        return _SITES_CACHE[1]
    try:
        r = _SESSION.get(IEM_SITES, timeout=_HTTP_TIMEOUT)
        r.raise_for_status()
    except Exception:  # noqa: BLE001 - IEM down or crawling: the NWS list instead
        sites = _nws_sites()
        # kept an hour, not a day, so IEM's fuller list (retired radars too) comes back
        _SITES_CACHE = (now - 86400 + 3600, sites)
        return sites
    sites: list[dict] = []
    for f in r.json().get("features", []):
        p = f.get("properties") or {}
        sid = str(p.get("sid") or "").strip()
        lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
        if not sid or lat is None or lon is None:
            continue
        sites.append({
            "id": sid,                 # 3-letter (S3 prefix)
            "icao": icao_for(sid),     # display: TJUA, PHKI, ... not always K
            "name": p.get("sname") or sid,
            "lat": round(float(lat), 4),
            "lon": round(float(lon), 4),
            "country": p.get("country"),
            "online": bool(p.get("online")),
            # for the site list and the radar's own panel (radar-sites)
            "state": (str(p.get("state") or "").strip() or None),
            "wfo": (str(p.get("wfo") or "").strip() or None),
            "elev": p.get("elevation"),
            "tz": p.get("tzname"),
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
ARCHIVE_START_UNIX = 1646092800  # the same day, 00Z: before it, Level II's archive is the only one


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


def _list_pages(prefix: str, pages: int = 3) -> list[str]:
    """Each page of an S3 listing as text. A page holds 1000 keys, and a TDWR in
    hazardous mode scans its lowest tilt every minute: 1440 keys a day."""
    out: list[str] = []
    params = {"list-type": "2", "max-keys": "1000", "prefix": prefix}
    for _ in range(pages):
        r = _SESSION.get(S3, params=params, timeout=_HTTP_TIMEOUT)
        if not r.ok:
            break
        out.append(r.text)
        token = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
        if "<IsTruncated>true</IsTruncated>" not in r.text or not token:
            break
        params = {"list-type": "2", "max-keys": "1000", "prefix": prefix, "continuation-token": token.group(1)}
    return out


def _list_keys(site: str, product: str, day: str) -> list[str]:
    """All S3 keys for site+product on a UTC day ('YYYY_MM_DD')."""
    prefix = f"{tdwr.archive_id(site, day)}_{product}_{day}"
    keys = [k for page in _list_pages(prefix) for k in re.findall(r"<Key>([^<]+)</Key>", page)]
    if not keys and product in tdwr.FEED_DIRS and tdwr.is_tdwr(site):
        return [k for k in feed_keys(site, product) if k.startswith(prefix)]
    return keys


# A product the bucket stopped keeping (a TDWR's echo tops, 2023) comes from the
# NWS feed: its directory holds the last 250 scans, about a day, one file each,
# named by slot (sn.0123) and rewritten round the ring.
_FEED_LIST: dict[tuple[str, str], tuple[float, list[str]]] = {}
_FEED_URL: dict[str, str] = {}
_FEED_TTL = 30.0
_FEED_ROW = re.compile(r'href="(sn\.\d{4})">[^<]*</a></td>\s*<td[^>]*>\s*(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2})')


def parse_feed_listing(html: str, site: str, product: str, base: str) -> dict[str, str]:
    """A feed directory's page -> {key: file url}, keys shaped like the bucket's,
    timed by when each file came in (a minute's precision, oldest first)."""
    rows = []
    for name, stamp in _FEED_ROW.findall(html or ""):
        try:
            when = datetime.strptime(stamp, "%d-%b-%Y %H:%M")
        except ValueError:
            continue
        rows.append((when, name))
    rows.sort()
    return {f"{site}_{product}_{when:%Y_%m_%d_%H_%M_%S}": f"{base}{name}" for when, name in rows}


def feed_keys(site: str, product: str) -> list[str]:
    """The keys of a product in the NWS feed, oldest first."""
    ck = (site, product)
    now = time.time()
    hit = _FEED_LIST.get(ck)
    if hit and now - hit[0] < _FEED_TTL:
        return hit[1]
    base = f"{tdwr.FEED_BASE}{tdwr.FEED_DIRS[product]}/SI.t{site.lower()}/"
    try:
        r = _SESSION.get(base, timeout=_HTTP_TIMEOUT)
        r.raise_for_status()
    except Exception:  # noqa: BLE001 - the feed being down is an empty list, kept briefly
        keys = hit[1] if hit else []
        _FEED_LIST[ck] = (now, keys)
        return keys
    found = parse_feed_listing(r.text, site, product, base)
    _FEED_URL.update(found)
    keys = list(found)
    _FEED_LIST[ck] = (now, keys)
    while len(_FEED_URL) > 4096:
        _FEED_URL.pop(next(iter(_FEED_URL)))
    return keys


def scan_url(key: str) -> str:
    """Where a Level III key's file is: the bucket, or a slot of the NWS feed."""
    url = _FEED_URL.get(key)
    if url:
        return url
    parts = key.split("_")
    if len(parts) > 2 and parts[1] in tdwr.FEED_DIRS and tdwr.is_tdwr(parts[0]) and (key_time(key) or 0) > tdwr.FEED_NEWER_THAN:
        feed_keys(parts[0], parts[1])
        return _FEED_URL.get(key) or S3 + key
    return S3 + key


def tdwr_day(site: str, date: str) -> list[dict]:
    """A TDWR's lowest reflectivity scans of one UTC day ("YYYY-MM-DD") as the
    Archive panel's rows: key, time, bytes."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date or ""):
        raise ValueError(f"Not a date: {date!r} (YYYY-MM-DD)")
    sid = site_id(site)
    day = date.replace("-", "_")
    out = []
    for page in _list_pages(f"{tdwr.archive_id(sid, day)}_TZ0_{day}"):
        for key, size in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", page, re.S):
            unix = key_time(key)
            if unix is not None:
                out.append({"key": key, "time": unix, "size": int(size), "partial": False})
    out.sort(key=lambda v: v["time"])
    return out


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
    product = tdwr.for_site(site, (product or DEFAULT_PRODUCT).upper().strip())
    # SRV and NROT frames are velocity frames -- list the source cut so scrubbing the loop
    # hands polar_data a key it can actually decode.
    product = _DERIVED_SOURCE.get(product, product)

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
    gate = tdwr.gate_km(product)
    rng = np.linspace(0, gate * data.shape[-1] if gate else f.max_range, data.shape[-1] + 1)
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


def _l3_antenna(f: "Level3File", site: str = "") -> dict:
    """The antenna, for the readout and the product info panel: the WSR-88D's
    nominal 0.95 deg S-band beam (a TDWR's 0.55 deg C-band one), and its height
    (Level III gives feet above sea level). Level III carries no Nyquist velocity."""
    out: dict = {"band": tdwr.BAND, "beamWidthDeg": tdwr.BEAM_WIDTH_DEG} if tdwr.is_tdwr(site) else {"band": "S", "beamWidthDeg": 0.95}
    try:
        out["siteAmslM"] = round(float(f.height) * 0.3048, 1)
    except Exception:  # noqa: BLE001 - optional detail
        pass
    return out


def _scan_mode(f: "Level3File", site: str = "") -> str:
    """The radar's mode as its scan names it: a WSR-88D's Clear Air or
    Precipitation, a TDWR's Monitor or Hazardous (its header says Precipitation
    in both, so the VCP decides)."""
    if tdwr.is_tdwr(site) and int(f.prod_desc.vcp) in tdwr.VCP_MODES:
        return tdwr.VCP_MODES[int(f.prod_desc.vcp)]
    return _OP_MODES.get(int(f.prod_desc.op_mode), f"Mode {f.prod_desc.op_mode}")


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

    # Digital velocity arrives in m/s (MetPy's DigitalVelMapper, as the ICD
    # defines products 99 and 154), and everything downstream -- the velocity
    # tables, the readout, Level II's velocity, the storm motion SRV removes --
    # is in knots. Unconverted, every speed read about half what it was: a
    # 60 kt couplet drew in the colours of 30 kt, and the readout agreed.
    # Checked on one KFWS volume: N0G |v| p90 was 8.0 against Level II's
    # 15.6 kt, the m/s-to-knot ratio exactly.
    if PRODUCTS.get(product, {}).get("kind") in ("vel", "srv"):
        out *= _MS_TO_KT
    return out


# Storm-relative velocity is derived, not fetched: the ready-made N0S product is
# 1 deg x 1 km / 230 km (82k gates), while base velocity is super-res 0.5 deg x
# 0.25 km (864k gates). Subtracting the storm-motion component from super-res
# velocity gives the same field at ~10x the detail, which is what the good radar
# apps display. These map the SRV wire code to the velocity cut it comes from.
_SRV_SOURCE = {"N0S": "N0G", "NAS": "NAG", "N1S": "N1G"}

# Normalized rotation is derived from the same cuts.
_NROT_SOURCE = {"N0R": "N0G", "NAR": "NAG", "N1R": "N1G"}

# Every derived product and the velocity cut its frames are.
_DERIVED_SOURCE = {**_SRV_SOURCE, **_NROT_SOURCE}

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

    vals = _value_lut(f, src_product)[codes]  # kt (converted there), NaN where no data

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
    # Range-folded gates keep their own code (255, no value), as Level II does.
    srv_rf = (codes == 1) & ~np.isfinite(vals)
    if srv_rf.any():
        q[q == 255] = 254
        q[srv_rf] = 255
        lut[255] = np.nan
    out_codes = q.astype(np.uint8)

    spec = PRODUCTS[product]
    out = {
        "az": az,
        "lut": lut,
        "codes": out_codes,
        "meta": {
            "site": icao_for(site),
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
            **_l3_antenna(f),
            **({"rfCode": 255} if srv_rf.any() else {}),
        },
    }
    _POLAR_CACHE[cache_key] = out
    while len(_POLAR_CACHE) > _POLAR_CACHE_MAX:
        _POLAR_CACHE.popitem(last=False)
    return out


# Normalized rotation (NROT), after GR2Analyst's: the azimuthal shear of the
# velocity, divided by a shear that counts as significant at that range, so one
# scale reads the same near the radar and far from it. 1 is significant
# rotation, 2.5 extreme; positive is cyclonic (counter-clockwise), negative
# anticyclonic.
#
# The shear comes from Level III velocity because the RPG has already
# dealiased it -- on raw Level II velocity every Nyquist fold would read as an
# enormous shear. It is the slope across a window of 5 radials x 5 gates
# (least squares, so a missing gate or two does not matter), in m/s per metre
# of arc: s^-1.
#
# The divisor falls with range because the beam widens: far out, a vortex is
# smeared across more of the window and its measured shear drops. GR's own
# divisor is empirical and not published; this one is set so a tornadic
# couplet near the radar (60-90 kt across a few radials) reads 3-5, a strong
# mesocyclone at 80-120 km about 1-2, and the noise of quiet echo under 0.2.
_NROT_WIN = 2            # half-width: 5 radials x 5 gates
_NROT_K0 = 0.010         # s^-1 counted as significant within _NROT_R0
_NROT_R0 = 30.0          # km
_NROT_MIN_KM = 6.0       # nearer than this it is ground clutter more than weather
# Near the radar a 0.5 deg radial is a few tens of metres wide, and any noise in
# the clutter there read as a huge shear (|NROT| 5 at 4-8 km, on a quiet day).
# The spacing between radials counts as at least one gate's length, so the
# shear is always taken over at least ~1 km.
_NROT_MIN_ARC_KM = 0.25
_NROT_MIN_GATES = 14     # of the 25 in the window
_NROT_MAX = 5.0


def _nrot_field(vel_kt: np.ndarray, az: np.ndarray, rng_km: np.ndarray) -> np.ndarray:
    """NROT for every gate of a velocity cut (NaN where there is too little
    data). `vel_kt` is radials x gates; `az` the radial edges in degrees,
    `rng_km` the gate edges."""
    v = vel_kt.astype(np.float32) / np.float32(_MS_TO_KT)   # m/s
    w = _NROT_WIN
    ok = np.isfinite(v)
    okf = ok.astype(np.float32)
    v0 = np.where(ok, v, np.float32(0.0))

    # The window sums are separable: a plain box along the gates (by running
    # sums), then along the radials the box and its x and x^2 moments. A loop
    # can play 60 of these, so this is the cost that matters -- 25 shifts of the
    # whole scan took 1.5-4 s a frame; this takes a fraction of that.
    def gate_box(a: np.ndarray) -> np.ndarray:
        c = np.cumsum(np.pad(a, ((0, 0), (w + 1, w))), axis=1, dtype=np.float32)
        return c[:, 2 * w + 1:] - c[:, : -(2 * w + 1)]

    def az_moment(a: np.ndarray, power: int) -> np.ndarray:
        out = np.zeros_like(a)
        for dx in range(-w, w + 1):
            if power and dx == 0:
                continue
            # Radials wrap around the circle.
            out += np.float32(dx ** power) * np.roll(a, -dx, axis=0)
        return out

    g_ok = gate_box(okf)
    g_v = gate_box(v0)
    n = az_moment(g_ok, 0)
    sx = az_moment(g_ok, 1)
    sxx = az_moment(g_ok, 2)
    sv = az_moment(g_v, 0)
    sxv = az_moment(g_v, 1)
    denom = n * sxx - sx * sx
    with np.errstate(invalid="ignore", divide="ignore"):
        slope = (n * sxv - sx * sv) / denom                # m/s per radial
    dtheta = np.radians(float(np.median(np.diff(az))) % 360.0 or 0.5)
    r_mid_km = 0.5 * (rng_km[:-1] + rng_km[1:])
    with np.errstate(invalid="ignore", divide="ignore"):
        arc_m = np.maximum(dtheta * r_mid_km, _NROT_MIN_ARC_KM) * 1000.0   # m between radials
        shear = slope / arc_m[None, :]                                        # s^-1
    sig = _NROT_K0 * np.sqrt(_NROT_R0 / np.maximum(r_mid_km, _NROT_R0))
    nrot = shear / sig[None, :]
    bad = (n < _NROT_MIN_GATES) | ~np.isfinite(v) | (denom <= 0) | (r_mid_km < _NROT_MIN_KM)[None, :]
    nrot[bad] = np.nan
    return np.clip(nrot, -_NROT_MAX, _NROT_MAX).astype(np.float32)


def _nrot_polar(site: str, product: str, src_product: str, key: Optional[str]) -> dict:
    """Normalized rotation built from a super-res base-velocity cut."""
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
    vals = _value_lut(f, src_product)[codes]  # kt, dealiased by the RPG, NaN where no data
    nrot = _nrot_field(vals, az, rng)

    pid = _resolve_palette(product, None)
    _, vmin, vmax = get_cmap(pid)
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)
    t = (nrot - vmin) / (vmax - vmin or 1.0)
    q = np.clip(np.rint(t * 254.0) + 1.0, 1, 255)
    q[~np.isfinite(nrot)] = 0
    out_codes = q.astype(np.uint8)

    spec = PRODUCTS[product]
    out = {
        "az": az,
        "lut": lut,
        "codes": out_codes,
        "meta": {
            "site": icao_for(site),
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
            "derivedFrom": src_product,
            "vcp": int(f.prod_desc.vcp),
            "mode": _OP_MODES.get(int(f.prod_desc.op_mode), f"Mode {f.prod_desc.op_mode}"),
            **_l3_antenna(f),
        },
    }
    _POLAR_CACHE[cache_key] = out
    while len(_POLAR_CACHE) > _POLAR_CACHE_MAX:
        _POLAR_CACHE.popitem(last=False)
    return out


def _null_scan(site: str, product: str, key: str, f: "Level3File") -> dict:
    """A product published with nothing in it -- a "null product".

    With no rain the accumulations carry only a line of text ("No precipitation
    detected since ...") and no gates at all, and the missing gate array was
    read as an error: the panel said "'data'" and drew nothing. It is an empty
    scan: nothing to draw, and the radar's own words to show.
    """
    spec = PRODUCTS[product]
    pid = _resolve_palette(product, None)
    _, vmin, vmax = get_cmap(pid)
    texts = [str(p.get("text")).strip() for layer in (getattr(f, "sym_block", None) or []) for p in layer
             if isinstance(p, dict) and p.get("text")]
    note = texts[0] if texts else "Nothing to show in this product right now"
    lut = np.full(256, np.nan, dtype=np.float32)
    return {
        "az": np.linspace(0, 360, 361, dtype=np.float32),
        "lut": lut,
        "codes": np.zeros((360, 1), dtype=np.uint8),
        "meta": {
            "site": icao_for(site),
            "siteLat": float(f.lat),
            "siteLon": float(f.lon),
            "product": product,
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": spec.get("family"),
            "tilt": spec.get("tilt"),
            "elevation": None,
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": 360,
            "nGates": 1,
            "rangeStartKm": 0.0,
            "gateWidthKm": float(f.max_range),
            "maxRangeKm": float(f.max_range),
            "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
            "scanUnix": key_time(key),
            "key": key,
            "note": note,
            "vcp": int(f.prod_desc.vcp),
            "mode": _scan_mode(f, site),
        },
    }


_RASTER_GATE_KM = 1.0


def _raster_to_polar(grid: Any, cell_km: float, max_range_km: float) -> tuple[np.ndarray, np.ndarray]:
    """A raster product on radials, 1 deg x 1 km, nearest cell: the viewer draws
    radials, and a 4 km cell is much coarser than either, so its square edges
    survive. The grid is centred on the radar, first row north, first column
    west (checked against the same volume's reflectivity)."""
    g = np.asarray(grid, dtype=np.uint8)
    ny, nx = g.shape
    n_gates = int(round(max_range_km / _RASTER_GATE_KM))
    az = np.linspace(0.0, 360.0, 361, dtype=np.float32)
    a = np.deg2rad(az[:-1] + 0.5)[:, None]
    r = (np.arange(n_gates) + 0.5)[None, :] * _RASTER_GATE_KM
    col = np.floor(r * np.sin(a) / cell_km + nx / 2.0).astype(int)
    row = np.floor(ny / 2.0 - r * np.cos(a) / cell_km).astype(int)
    inside = (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    codes = np.zeros((360, n_gates), dtype=np.uint8)
    codes[inside] = g[row[inside], col[inside]]
    return codes, az


class UndecodableScan(RuntimeError):
    """A radar file that was fetched whole but cannot be decoded: permanent."""


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
    # Before the check: a Level II code is not in PRODUCTS, and at a TDWR it must
    # be mapped or refused there, not turned into reflectivity here.
    product = tdwr.for_site(site, product)
    if product not in PRODUCTS:
        product = tdwr.for_site(site, DEFAULT_PRODUCT)

    # SRV and NROT are derived from the matching super-res velocity cut, not fetched.
    src = _SRV_SOURCE.get(product)
    if src:
        return _srv_polar(site, product, src, key)
    src = _NROT_SOURCE.get(product)
    if src:
        return _nrot_polar(site, product, src, key)

    if not key:
        key = _latest_key(site, product)
    if not key:
        raise RuntimeError(f"No recent {PRODUCTS[product]['label']} scan for {icao_for(site)}.")

    cache_key = (site, product, key)
    hit = _POLAR_CACHE.get(cache_key)
    if hit is not None:
        _POLAR_CACHE.move_to_end(cache_key)
        return hit

    resp = _SESSION.get(scan_url(key), timeout=_HTTP_TIMEOUT)
    if resp.status_code != 200:
        raise RuntimeError(f"Level III file {key} not available (HTTP {resp.status_code}).")
    raw = resp.content
    try:
        f = Level3File(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001 -- MetPy raises anything on a bad file
        # A file that downloaded whole but does not parse (TBW N0B 2024-10-09
        # 22:58:07: "Bad divider for symbology block") stays that way: say so,
        # so the app drops the frame instead of retrying it forever.
        raise UndecodableScan(f"This Level III file is damaged and cannot be read ({exc}).") from exc
    # A product with nothing to draw has no symbology block at all, not an empty one.
    block = getattr(f, "sym_block", None)
    datadict = block[0][0] if block and block[0] else {}
    if "data" not in datadict:
        out = _null_scan(site, product, key, f)
        _POLAR_CACHE[cache_key] = out
        return out
    radial = "start_az" in datadict
    if radial:
        codes = np.asarray(datadict["data"], dtype=np.uint8)
        az = np.array(datadict["start_az"] + [datadict["end_az"][-1]], dtype=np.float32)
    else:
        # A raster product (a TDWR's VIL and echo tops), sampled onto radials.
        codes, az = _raster_to_polar(datadict["data"], tdwr.RASTER_CELL_KM.get(product, 4.0), float(f.max_range))
    # A TDWR's gates are 150 or 300 m exactly (tdwr.py); MetPy's range is rounded.
    gate = tdwr.gate_km(product) if radial else _RASTER_GATE_KM
    rng = np.linspace(0, gate * codes.shape[-1] if gate else f.max_range, codes.shape[-1] + 1)

    spec = PRODUCTS[product]
    pid = _resolve_palette(product, None)
    _, vmin, vmax = get_cmap(pid)
    out_lut = _value_lut(f, product)
    out = {
        "az": az,                                     # naz + 1 edges (deg from N)
        "lut": out_lut,                               # 256 floats
        "codes": codes,                               # naz x ngates, uint8
        "meta": {
            "site": icao_for(site),
            "siteLat": float(f.lat),
            "siteLon": float(f.lon),
            "product": product,
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": spec.get("family"),
            "tilt": spec.get("tilt"),
            # the cut this scan was actually taken at, not the VCP nominal
            # (MetPy's 0.1 steps come out as 0.30000000000000004)
            "elevation": round(float(f.metadata.get("el_angle")), 2) if radial and f.metadata.get("el_angle") is not None else None,
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": int(codes.shape[0]),
            "nGates": int(codes.shape[1]),
            "rangeStartKm": float(rng[0]),
            "gateWidthKm": float(rng[1] - rng[0]),
            "maxRangeKm": float(rng[-1]),
            "validUnix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
            "scanUnix": key_time(key),
            "key": key,
            "vcp": int(f.prod_desc.vcp),
            "mode": _scan_mode(f, site),
            **_l3_antenna(f, site),
            # Digital velocity / width: level 1 is "range folded" (no value).
            **({"rfCode": 1} if spec["kind"] in ("vel", "sw") and not np.isfinite(out_lut[1]) else {}),
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
    # Before the check: a Level II code is not in PRODUCTS, and at a TDWR it must
    # be mapped or refused there, not turned into reflectivity here.
    product = tdwr.for_site(site, product)
    if product not in PRODUCTS:
        product = tdwr.for_site(site, DEFAULT_PRODUCT)

    cache_key = (site, product, palette or "auto", key or "latest")
    now = time.time()
    hit = _RENDER_CACHE.get(cache_key)
    # a specific historical scan never changes -> cache it for the session
    if hit and (key or now - hit[0] < _TTL):
        return hit[1]

    if not key:
        key = _latest_key(site, product)
    if not key:
        raise RuntimeError(f"No recent {PRODUCTS[product]['label']} scan for {icao_for(site)}.")

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
            "site": icao_for(site),
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
