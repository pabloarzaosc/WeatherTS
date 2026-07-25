"""
NEXRAD **Level II** super-resolution moments.

Level III caps the dual-pol moments at 1 deg azimuthal (360 radials). Level II
carries the same moments at **0.5 deg (720 radials)** on the lower cuts, plus
Spectrum Width, which Level III never publishes at all. This module fetches a
live volume, decodes it, and hands a single moment back in the *same* polar wire
format `nexrad_core.polar_data` produces, so the frontend needs no new decoder.

Access notes (measured 2026-07-19, the earlier "not viable" call was wrong):
  * `noaa-nexrad-level2` (the archive) is 403 to anonymous callers.
  * The GCP mirror `gcp-public-data-nexrad-l2` lists fine but lags ~5 days.
  * `unidata-nexrad-level2-chunks` IS live -- newest volume ~2 min old. It
    delivers a volume as ~70 numbered chunks (S start, I middle, E end) that
    concatenate into something MetPy's Level2File reads directly.

Cost: a volume is ~7 MB / ~70 chunks, 4-25 s to pull in parallel and ~1 s to
decode -- versus ~1 s for a 178 KB Level III product. That's why this is opt-in
and why the decoded volume is cached hard: one download serves *every* moment
and *every* tilt until the next volume lands.
"""
from __future__ import annotations

import io
import math
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import numpy as np
import requests
from metpy.io import Level2File
from requests.adapters import HTTPAdapter

from nexrad_core import (
    TILT_SLOTS,
    _KIND_DEFAULT_PALETTE,
    _mean_storm_motion,
    get_cmap,
)

CHUNKS = "https://unidata-nexrad-level2-chunks.s3.amazonaws.com/"
_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
_TIMEOUT = 25
_MS_TO_KT = 1.943844

# A dedicated pool: pulling ~70 chunks at once starves the shared 10-slot one.
_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=2))

# What we expose from a volume. `src` is the MetPy moment key; SRV rides on VEL
# and gets storm motion removed. KDP is absent on purpose: Level II carries PHI
# (total differential phase), and specific differential phase is its range
# derivative -- a real algorithm, not a rename, so KDP stays on Level III.
L2_MOMENTS: dict[str, dict[str, Any]] = {
    "B": {"label": "Super-Res Reflectivity", "units": "dBZ", "kind": "ref", "src": b"REF"},
    "G": {"label": "Super-Res Velocity", "units": "kt", "kind": "vel", "src": b"VEL", "kt": True},
    "S": {"label": "Super-Res Storm Rel. Velocity", "units": "kt", "kind": "srv", "src": b"VEL", "kt": True, "srv": True},
    "W": {"label": "Spectrum Width", "units": "kt", "kind": "sw", "src": b"SW", "kt": True},
    "C": {"label": "Super-Res Correlation Coeff.", "units": "", "kind": "cc", "src": b"RHO"},
    "X": {"label": "Super-Res Diff. Reflectivity", "units": "dB", "kind": "zdr", "src": b"ZDR"},
    "P": {"label": "Differential Phase", "units": "°", "kind": "phi", "src": b"PHI"},
    "F": {"label": "Clutter Filter Power", "units": "dB", "kind": "cfp", "src": b"CFP"},
}

_ELEV = dict(TILT_SLOTS)

# A DECODED volume is enormous (17 sweeps x ~700 radials x ~5 moments of
# float32 -- hundreds of MB), so it is never cached. What gets cached is the
# extracted polar grid per (site, product, tilt, volume): uint8 codes, ~0.9-1.3
# MB each. 30 frames of one product is ~30 MB.
_GRID_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_GRID_MAX = 240
# A volume is ~7 MB, so a 30-frame loop already pulls ~225 MB. That's the
# practical ceiling; Level III carries the long loops.
MAX_LOOP = 30
# Decoding is the memory spike, so only a couple run at once no matter how many
# frames the client prefetches in parallel.
_DECODE_SEM = threading.Semaphore(2)
# Volume listings per site (the newest N), refreshed as scans land.
_LIST_CACHE: "OrderedDict[str, tuple[float, list[dict]]]" = OrderedDict()
_LIST_TTL = 120.0
# Last known volume number per site, so discovery doesn't rescan 999 dirs.
_VOL_HINT: dict[str, int] = {}
# The elevation ladder per decoded volume, so every extracted grid can carry it.
_VOL_ELEVS: dict[tuple, list[dict]] = {}


def _chunks_for(site: str, vol: int) -> list[tuple[str, int]]:
    r = _SESSION.get(f"{CHUNKS}?list-type=2&prefix={site}/{vol}/&max-keys=400", timeout=10)
    root = ET.fromstring(r.text)
    return [
        (c.find("s3:Key", _NS).text, int(c.find("s3:Size", _NS).text))
        for c in root.findall(".//s3:Contents", _NS)
    ]


def _stamp(keys: list[tuple[str, int]]) -> str:
    """The volume's timestamp, taken from any chunk key."""
    return keys[0][0].split("/")[2].rsplit("-", 2)[0]


def _stamp_unix(stamp: str) -> int:
    import datetime as _dt
    return int(_dt.datetime.strptime(stamp, "%Y%m%d-%H%M%S")
               .replace(tzinfo=_dt.timezone.utc).timestamp())


def _newest_vol_num(site: str) -> Optional[int]:
    """The volume number currently being written.

    Volume directories cycle 1..999 and don't sort chronologically, so "newest"
    means max chunk timestamp. A full scan is ~13 s; remember the last answer and
    probe a window around it first, which makes the steady state a few requests.
    """
    def scan(vols) -> list[tuple[str, int]]:
        with ThreadPoolExecutor(24) as ex:
            got = list(ex.map(lambda v: (v, _chunks_for(site, v)), vols))
        return [(_stamp(ch), v) for v, ch in got if ch]

    hint = _VOL_HINT.get(site)
    found: list[tuple[str, int]] = []
    if hint:
        found = scan([((hint - 3 + i) % 999) + 1 for i in range(12)])
    if not found:
        found = scan(range(1, 1000))
    if not found:
        return None
    _, vol = max(found)
    _VOL_HINT[site] = vol
    return vol


def list_volumes(site: str, limit: int = 30, start: Optional[int] = None) -> list[dict]:
    """The newest `limit` complete volumes, oldest first.

    Volumes are numbered sequentially as they're written, so once the newest is
    known the previous ones are just N-1, N-2, ... (wrapping at 1). No need to
    rescan every directory.
    """
    site = site.upper().strip()
    if not site.startswith("K"):
        site = "K" + site
    now = time.time()
    hit = _LIST_CACHE.get(site)
    cached = hit[1] if hit and now - hit[0] < _LIST_TTL else None
    if cached is not None and start is None and len(cached) >= limit:
        _LIST_CACHE.move_to_end(site)
        return cached[-limit:]

    newest = _newest_vol_num(site)
    if newest is None:
        return []
    # A few extra candidates absorb incomplete/missing slots. Archive playback
    # has to reach further back than the loop length, so it sweeps every slot --
    # the bucket only holds ~48 h, and that ceiling is what limits how far back
    # Level II can go at all.
    span = 999 if start is not None else limit + 8
    cands = [((newest - 1 - i) % 999) + 1 for i in range(span)]
    with ThreadPoolExecutor(24) as ex:
        got = list(ex.map(lambda v: (v, _chunks_for(site, v)), cands))

    out: list[dict] = []
    for v, ch in got:
        if not ch or not any(k.endswith("-E") for k, _ in ch):
            continue  # still being written
        st = _stamp(ch)
        out.append({"vol": v, "stamp": st, "time": _stamp_unix(st),
                    "key": f"L2:{v}:{st}"})
    out.sort(key=lambda d: d["time"])
    _LIST_CACHE[site] = (now, out[-limit:])
    if start is not None:
        # archive playback: the first `limit` volumes at or after the instant.
        # The chunk bucket only holds ~48 h, so anything older simply isn't here.
        out = [v for v in out if v["time"] >= start][:limit]
    else:
        out = out[-limit:]
    while len(_LIST_CACHE) > 8:
        _LIST_CACHE.popitem(last=False)
    return out


def _decode_volume(site: str, vol: int) -> tuple[Any, str]:
    """Fetch a specific volume's chunks and decode it. Never cached -- the
    caller extracts what it needs and lets the volume go."""
    ch = _chunks_for(site, vol)
    if not ch:
        raise RuntimeError(f"Level II volume {vol} missing for {site}.")
    ch.sort(key=lambda kv: int(kv[0].split("/")[2].split("-")[1]))
    with ThreadPoolExecutor(24) as ex:
        parts = list(ex.map(lambda kv: _SESSION.get(CHUNKS + kv[0], timeout=_TIMEOUT).content, ch))
    return Level2File(io.BytesIO(b"".join(parts))), _stamp(ch)


def _sweeps_with(f: Any, src: bytes) -> list[tuple[int, float, int, int]]:
    """(index, elevation, radial count, gate count) per sweep carrying a moment.

    The gate count matters: in a split cut the same moment can appear twice at
    one nominal elevation with different range coverage.
    """
    out = []
    for i, sw in enumerate(f.sweeps):
        if not sw or src not in sw[0][4]:
            continue
        blk = sw[0][4][src][0]
        out.append((i, float(sw[0][0].el_angle), len(sw), int(blk.num_gates)))
    return out


def available_tilts(f: Any, fam: str) -> list[dict]:
    """Nominal tilt slots this moment can actually be served at.

    Low cuts are *split*: the surveillance sweep carries REF + dual-pol, the
    doppler sweep carries VEL/SW, both at 720 radials. So the same nominal 0.5
    deg maps to a different sweep depending on the moment.
    """
    src = L2_MOMENTS[fam]["src"]
    cand = _sweeps_with(f, src)
    tilts = []
    for slot, nominal in TILT_SLOTS:
        best = _pick(cand, nominal)
        if best is None:
            continue
        _, elev, nrad, ngates = best
        tilts.append({"code": f"L2{fam}{slot}", "tilt": slot, "elev": nominal,
                      "actualElev": round(elev, 2), "radials": nrad, "gates": ngates})
    return tilts


def _pick(cand: list[tuple[int, float, int, int]], nominal: float):
    """The best sweep for a nominal elevation.

    RANGE FIRST, then radials, then closeness in angle. The VCPs split the low
    cuts into a *surveillance* sweep (REF + dual-pol, full 458 km) and a
    *doppler* sweep (REF + VEL/SW, range-folded to ~298 km). Both report ~0.5
    deg, and picking purely by nearest angle handed reflectivity the doppler
    cut -- which paints a hard circular edge where its range simply stops.
    """
    if not cand:
        return None
    near = [c for c in cand if abs(c[1] - nominal) <= 0.45]
    if not near:
        return None
    return sorted(near, key=lambda c: (-c[3], -c[2], abs(c[1] - nominal)))[0]


def _extract(f: Any, fam: str, slot: str, site: str, stamp: str) -> Optional[dict]:
    """One moment out of an already-decoded volume, in the polar wire format."""
    spec = L2_MOMENTS[fam]
    chosen = _pick(_sweeps_with(f, spec["src"]), _ELEV[slot])
    if chosen is None:
        return None
    idx, elev, _, _ = chosen
    sweep = f.sweeps[idx]

    # Radials arrive in scan order and can wrap past 360; sort so the azimuth
    # edges the renderer builds are monotonic.
    radials = sorted(sweep, key=lambda r: float(r[0].az_angle))
    hdr0 = radials[0][4][spec["src"]][0]
    ngates = int(hdr0.num_gates)
    first_km = float(hdr0.first_gate)
    width_km = float(hdr0.gate_width)

    vals = np.full((len(radials), ngates), np.nan, dtype=np.float32)
    az = np.empty(len(radials) + 1, dtype=np.float32)
    for i, r in enumerate(radials):
        az[i] = float(r[0].az_angle)
        blk = r[4].get(spec["src"])
        if blk is None:
            continue
        d = np.asarray(blk[1], dtype=np.float32)
        n = min(d.size, ngates)
        vals[i, :n] = d[:n]
    az[-1] = az[0] + 360.0

    if spec.get("kt"):
        vals *= _MS_TO_KT

    motion = None
    if spec.get("srv"):
        speed_kt, toward = _mean_storm_motion(site)
        az_mid = 0.5 * (az[:-1] + az[1:])
        vals = vals - (speed_kt * np.cos(np.radians(az_mid - toward)))[:, None]
        motion = (round(speed_kt, 1), round(toward, 1))

    # Quantise to the 256-code wire format (code 0 = no data).
    pid = _KIND_DEFAULT_PALETTE.get(spec["kind"], "REF")
    _, vmin, vmax = get_cmap(pid)
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)
    t = (vals - vmin) / ((vmax - vmin) or 1.0)
    codes = np.clip(np.rint(t * 254.0) + 1.0, 1, 255)
    codes[~np.isfinite(vals)] = 0
    codes = codes.astype(np.uint8)

    unix = _stamp_unix(stamp)
    vol_hdr = radials[0][1]
    out = {
        "az": az,
        "lut": lut,
        "codes": codes,
        "meta": {
            "site": f"K{site}",
            "siteLat": float(vol_hdr.lat),
            "siteLon": float(vol_hdr.lon),
            "product": f"L2{fam}{slot}",
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": fam,
            "tilt": slot,
            "elevation": round(elev, 2),
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": int(codes.shape[0]),
            "nGates": int(codes.shape[1]),
            "rangeStartKm": first_km,
            "gateWidthKm": width_km,
            "maxRangeKm": first_km + ngates * width_km,
            "validUnix": unix,
            "scanUnix": unix,
            "key": f"L2:{stamp}",
            "source": "level2",
            "superRes": int(codes.shape[0]) >= 720,
            "vcp": int(getattr(vol_hdr, "vcp", 0)) or None,
            "elevations": _VOL_ELEVS.get((site, stamp), []),
        },
    }
    if motion:
        out["meta"]["stormMotionKt"] = motion[0]
        out["meta"]["stormMotionDeg"] = motion[1]
    return out


def polar_data_l2(site: str, product: str, key: str = "") -> dict:
    """A Level II moment in the same wire format as `nexrad_core.polar_data`.

    `product` is `L2<fam><slot>` (e.g. `L2C0` = correlation coefficient at 0.5
    deg); `key` is `L2:<vol>:<stamp>` from `list_volumes`, or empty for newest.

    One volume download is ~7 MB, so when a volume is decoded EVERY Level II
    moment at that tilt is extracted and cached, not just the one asked for.
    Scrubbing a 30-frame CC loop and then switching to ZDR costs no new traffic.
    """
    site = (site or "").upper().strip().lstrip("K")
    if not product.startswith("L2") or len(product) < 4:
        raise RuntimeError(f"Not a Level II product: {product}")
    fam, slot = product[2], product[3]
    if fam not in L2_MOMENTS or slot not in _ELEV:
        raise RuntimeError(f"Unknown Level II product: {product}")

    vol: Optional[int] = None
    if key.startswith("L2:"):
        bits = key.split(":")
        if len(bits) >= 3 and bits[1].isdigit():
            vol = int(bits[1])
    if vol is None:
        # The newest volume number is the one still being WRITTEN -- decoding it
        # yields a couple of sweeps and a truncated elevation ladder. Take the
        # newest volume that has its end chunk instead.
        recent = list_volumes(f"K{site}", 1)
        if not recent:
            raise RuntimeError(f"No complete Level II volume for K{site}.")
        vol = int(recent[-1]["key"].split(":")[1])

    cache_key = (site, fam, slot, vol)
    hit = _GRID_CACHE.get(cache_key)
    if hit is not None:
        _GRID_CACHE.move_to_end(cache_key)
        return hit

    with _DECODE_SEM:  # bound the memory spike, not the downloads
        # another thread may have finished it while we waited
        hit = _GRID_CACHE.get(cache_key)
        if hit is not None:
            _GRID_CACHE.move_to_end(cache_key)
            return hit
        f, stamp = _decode_volume(f"K{site}", vol)
        _VOL_ELEVS[(site, stamp)] = volume_elevations(f)
        while len(_VOL_ELEVS) > 8:
            _VOL_ELEVS.pop(next(iter(_VOL_ELEVS)))
        wanted: Optional[dict] = None
        for other in L2_MOMENTS:
            grid = _extract(f, other, slot, site, stamp)
            if grid is None:
                continue
            k = (site, other, slot, vol)
            _GRID_CACHE[k] = grid
            _GRID_CACHE.move_to_end(k)
            if other == fam:
                wanted = grid
        del f  # release the decoded volume before returning
        while len(_GRID_CACHE) > _GRID_MAX:
            _GRID_CACHE.popitem(last=False)

    if wanted is None:
        raise RuntimeError(f"{L2_MOMENTS[fam]['label']} not cut at {_ELEV[slot]}deg in this volume.")
    return wanted


# Which nominal cuts come back super-res. The VCPs run *split cuts* at the three
# lowest elevations -- a surveillance sweep (REF + dual-pol) and a doppler sweep
# (VEL/SW), both at 720 radials. From 1.8 deg up the cuts merge and drop to 360,
# which is no better than Level III, so the picker says so.
_SUPER_RES_SLOTS = {"0", "A", "1"}

# The nominal elevation ladder NEXRAD VCPs are cut at. Measured angles drift
# from these (a "0.5 deg" cut comes back as 0.44-0.67 depending on where in the
# volume it was flown), so sweeps are snapped to the nearest rung for labelling.
_ELEV_LADDER = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0,
                10.0, 12.5, 14.0, 15.6, 19.5]


def volume_elevations(f: Any) -> list[dict]:
    """The distinct cuts a volume actually flew, low to high.

    Two things make this more than `sorted(set(...))`:
      * **split cuts** -- the low elevations are flown twice (surveillance +
        doppler) a few hundredths apart;
      * **SAILS** -- extra low-level sweeps spliced into the middle of the
        volume, so the raw sweep order is NOT ascending.
    Group anything within 0.25 deg, then snap to the nominal ladder.
    """
    els = sorted({round(float(sw[0][0].el_angle), 2) for sw in f.sweeps if sw})
    groups: list[float] = []
    for e in els:
        if not groups or e - groups[-1] > 0.25:
            groups.append(e)
    out = []
    for g in groups:
        nominal = min(_ELEV_LADDER, key=lambda r: abs(r - g))
        if out and out[-1]["elev"] == nominal:
            continue
        out.append({"elev": nominal, "actual": g})
    return out

# Where Level II is actually WORTH its cost. Measured against Level III on the
# same volume:
#   REF  L3 720az/0.5deg/460km  ==  L2 720az/0.5deg/458km   -> tie
#   VEL  L3 720az/0.5deg/300km  ==  L2 720az/0.5deg/298km   -> tie
#   CC   L3 360az/1.0deg        vs  L2 720az/0.5deg         -> L2, 2x azimuthal
#   ZDR  L3 360az/1.0deg        vs  L2 720az/0.5deg         -> L2, 2x azimuthal
#   SW   not published in L3    vs  L2 720az/0.5deg         -> L2 only
# A Level II volume is a single snapshot, so choosing it costs the animated
# loop. On a tie that's a pure loss -- reflectivity, velocity and SRV stay on
# Level III and keep their 60-frame loop.
_L2_WINS = {"C", "X", "W"}


# Short labels + display order for the two product grids, mirroring the
# SupercellWX toolbox. SRV ("S") is deliberately absent from Level 2: it's a
# derived field, so it belongs to the Level 3 grid even though we compute it.
_L2_ORDER = ["B", "G", "W", "X", "P", "C", "F"]
_L2_SHORT = {"B": "REF", "G": "VEL", "W": "SW", "X": "ZDR", "P": "PHI", "C": "RHO", "F": "CFP"}
_L3_ORDER = ["B", "G", "S", "X", "K", "C", "DVL", "EET", "H", "HHC", "OHA", "DAA", "DTA"]
_L3_SHORT = {
    "B": "REF", "G": "VEL", "S": "SRM", "C": "CC", "X": "ZDR", "K": "KDP",
    "H": "HC", "HHC": "HHC", "EET": "ET", "DVL": "VIL",
    "OHA": "ACC", "DAA": "ACC-D", "DTA": "STA",
}


def _l2_family(fam: str) -> dict:
    """One Level II moment as a picker entry, at all the tilts a volume carries."""
    spec = L2_MOMENTS[fam]
    return {
        "id": f"L2{fam}",
        "short": _L2_SHORT.get(fam, fam),
        "label": spec["label"],
        "units": spec["units"],
        "kind": spec["kind"],
        "source": "level2",
        "superResTilts": sorted(_SUPER_RES_SLOTS),
        "tilts": [
            {"code": f"L2{fam}{slot}", "tilt": slot, "elev": nominal,
             "superRes": slot in _SUPER_RES_SLOTS}
            for slot, nominal in TILT_SLOTS
        ],
    }


def _l3_family(fam: dict) -> dict:
    e = dict(fam)
    e["short"] = _L3_SHORT.get(fam["id"], fam["id"])
    e["source"] = "level3"
    return e


# The single product list: each moment from its best source, no duplicates.
#
# Level III wins almost everywhere and is the default -- it carries the animated
# 60-frame loop and the archive, loads faster, and ties or beats Level II on
# resolution for REF/VEL/SRM and the derived fields. Level II is used ONLY where
# it genuinely wins, which is exactly _L2_WINS: CC and ZDR at twice the azimuthal
# sampling (720 vs 360), and the moments Level III does not publish at all -- SW,
# PHI, CFP. Having both sources of the same product on screen was just a way to
# pick the worse one by mistake.
#
# Each entry is (moment id, source). L2-win moments carry the L2 id (L2C, ...);
# everything else is the plain Level III id.
_MERGED: list[tuple[str, str]] = [
    ("B", "level3"),    # Reflectivity
    ("G", "level3"),    # Velocity
    ("S", "level3"),    # Storm-relative velocity (derived, L3 only)
    ("C", "level2"),    # Correlation coefficient  -- L2 wins
    ("X", "level2"),    # Differential reflectivity -- L2 wins
    ("W", "level2"),    # Spectrum width            -- L2 only
    ("K", "level3"),    # Specific differential phase
    ("P", "level2"),    # Differential phase        -- L2 only
    ("F", "level2"),    # Clutter filter power      -- L2 only
    ("H", "level3"),    # Hydrometeor classification
    ("HHC", "level3"),  # Hybrid hydrometeor classification
    ("EET", "level3"),  # Enhanced echo tops
    ("DVL", "level3"),  # Vertically integrated liquid
    ("OHA", "level3"),  # One-hour precip accumulation
    ("DAA", "level3"),  # One-hour precip accumulation (digital)
    ("DTA", "level3"),  # Storm-total precip accumulation
]


# Canonical name + short for the merged list's Level II entries. In a single
# list the "Super-Res" prefix is noise (there's no plain version to tell it
# apart from), and the product should read by the name people use -- CC, not the
# L2 toolbox's "RHO".
_MERGED_L2_NAMES = {
    "C": ("CC", "Correlation Coefficient"),
    "X": ("ZDR", "Differential Reflectivity"),
    "W": ("SW", "Spectrum Width"),
    "P": ("PHI", "Differential Phase"),
    "F": ("CFP", "Clutter Filter Power"),
}


def merged_catalog(l3: list[dict]) -> list[dict]:
    """One flat product list, each moment resolved to its best source.

    Replaces the old two-grid (Level 2 / Level 3) layout: the user never wanted
    to choose a source, only a product, and the source that's best for each is a
    settled question (see _MERGED / _L2_WINS). Level III products come straight
    from `l3`; Level II ones (CC, ZDR, SW, PHI, CFP) are built from L2_MOMENTS
    and renamed to their canonical, non-"Super-Res" names.
    """
    by_id = {f["id"]: f for f in l3}
    out: list[dict] = []
    seen: set[str] = set()
    for fam, source in _MERGED:
        if source == "level2":
            if fam in L2_MOMENTS:
                e = _l2_family(fam)
                name = _MERGED_L2_NAMES.get(fam)
                if name:
                    e["short"], e["label"] = name
                out.append(e)
                seen.add(fam)
        else:
            if fam in by_id:
                out.append(_l3_family(by_id[fam]))
                seen.add(fam)
    # Anything the catalogue gained that isn't in the curated order still shows,
    # from Level III, so a new product is never silently dropped.
    for fam in l3:
        if fam["id"] not in seen:
            out.append(_l3_family(fam))
    return out


def static_catalog() -> list[dict]:
    """Level II families for the picker, without downloading a volume.

    Tilt availability technically depends on the live VCP, but every VCP cuts
    these angles; `polar_data_l2` raises cleanly if a given volume doesn't.
    """
    cat = []
    for fam, spec in L2_MOMENTS.items():
        tilts = [
            {
                "code": f"L2{fam}{slot}",
                "tilt": slot,
                "elev": nominal,
                "superRes": slot in _SUPER_RES_SLOTS,
            }
            for slot, nominal in TILT_SLOTS
        ]
        cat.append({
            "id": f"L2{fam}",
            "label": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "source": "level2",
            "tilts": tilts,
        })
    return cat


def catalog_l2(site: str) -> list[dict]:
    """Level II families + the tilts this site's current volume actually offers."""
    f, _ = _load_volume(site)
    cat = []
    for fam, spec in L2_MOMENTS.items():
        tilts = available_tilts(f, fam)
        if tilts:
            cat.append({"id": fam, "label": spec["label"], "units": spec["units"],
                        "kind": spec["kind"], "tilts": tilts})
    return cat
