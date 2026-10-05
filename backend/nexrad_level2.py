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
    concatenate into something MetPy's Level2File reads directly. It keeps
    about two days, and its oldest volumes are already losing chunks.
  * `unidata-nexrad-level2` is the whole archive, one file per volume, listed
    by day. Archive playback reads from there.

Cost: a volume is ~7 MB / ~70 chunks, 4-25 s to pull in parallel and ~1 s to
decode -- versus ~1 s for a 178 KB Level III product. That's why this is opt-in
and why the decoded volume is cached hard: one download serves *every* moment
and *every* tilt until the next volume lands.
"""
from __future__ import annotations

import io
import logging
import math
import re
import struct
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Optional

import numpy as np
import requests
from metpy.io import Level2File
from requests.adapters import HTTPAdapter

from nexrad_core import (
    icao_for,
    site_id,
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
# The cut some radars fly below 0.5 deg -- 0.3 at KHDC, 0.2 at KLGX, 0.0 at KMUX
# and KMTX. Level III never publishes it (its lowest product is the 0.5 cut at
# every site), so it is served from Level II under its own slot. The number is
# only a label: the sweep is picked as whatever is below LOW_CUT_MAX.
_ELEV["L"] = 0.3
LOW_CUT_MAX = 0.4
# Cuts above 3.1 deg. Level III stops at 3.1; the VCPs go on to 6.4 (clear air)
# or 19.5, and Level II has every one of them, under these slots. VCP 215's
# 12.0 / 14.0 / 16.7 land on 12.5 / 14.0 / 15.6 -- nearest, and the label shows
# the angle flown, not the slot's.
UPPER_SLOTS: list[tuple[str, float]] = [
    ("4", 4.0), ("5", 5.1), ("6", 6.4), ("7", 8.0), ("8", 10.0),
    ("9", 12.5), ("C", 14.0), ("D", 15.6), ("F", 19.5),
]
_ELEV.update(UPPER_SLOTS)

# Which moments a sweep carries, by the waveform the VCP flies it with. From a
# decoded KHDC volume: the split low cuts are a surveillance sweep (reflectivity
# and dual-pol) and a Doppler one (reflectivity, velocity, width); the batch and
# upper Doppler cuts carry everything.
_WAVEFORM_MOMENTS = {
    "Contiguous Surveillance": "BCXPF",
    "Contig. Doppler with Ambiguity Res.": "BGW",
    "Contig. Doppler without Ambiguity Res.": "BGWCXPF",
    "Batch": "BGWCXPF",
    "Staggered Pulse Pair": "BGWCXPF",
}

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
# Whole volumes already found per site: {vol: list entry}.
_WHOLE: dict[str, dict[int, dict]] = {}
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


def _chunk_num(key: str) -> int:
    """KIND/629/20260914-165037-012-I -> 12."""
    return int(key.rsplit("-", 2)[1])


def _whole(ch: list[tuple[str, int]]) -> bool:
    """Every chunk of a volume is there: its start, its end and each in between.

    An end chunk alone does not make a volume. The bucket deletes chunks as they
    age, first ones first: KIND's volume 167, 42 hours old, still had its end
    and chunks 40-55 but none of 1-39 -- the 0.5 deg sweeps -- and a CC loop
    that reached it failed with "not cut at 0.5deg in this volume".
    """
    ends = [k for k, _ in ch if k.endswith("-E")]
    return bool(ends) and any(k.endswith("-S") for k, _ in ch) and len(ch) == _chunk_num(ends[0])


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
        vol = _search_newest_vol(site)
        if vol is not None:
            _VOL_HINT[site] = vol
        return vol
    _, vol = max(found)
    _VOL_HINT[site] = vol
    return vol


def _dir_stamp(site: str, vol: int) -> Optional[str]:
    """When a volume directory was written: its first chunk's name, one key."""
    import re as _re
    r = _SESSION.get(f"{CHUNKS}?list-type=2&prefix={site}/{vol}/&max-keys=1", timeout=10)
    m = _re.search(r"<Key>[^/<]+/\d+/(\d{8}-\d{6})", r.text)
    return m.group(1) if m else None


def _search_newest_vol(site: str) -> Optional[int]:
    """The newest volume directory without opening all 999 of them.

    The directories that exist come back from one listing. Numbered in order,
    their times rise until the number wraps from the newest back to the oldest.
    So a first pass times thirty-odd directories spread across them; the newest
    lies between the latest of those and the next one along, and a second pass
    times only that stretch. About sixty small requests where the old way was
    999 -- which from here was 13 s at best and a minute and a half with the
    timeouts, the first time Level II was opened at a radar.
    """
    import re as _re
    r = _SESSION.get(f"{CHUNKS}?list-type=2&prefix={site}/&delimiter=/&max-keys=1000", timeout=15)
    nums = sorted({int(n) for n in _re.findall(rf"<Prefix>{site}/(\d+)/</Prefix>", r.text)})
    if not nums:
        return None

    def stamps(vols: list[int]) -> dict[int, str]:
        with ThreadPoolExecutor(32) as ex:
            got = list(ex.map(lambda v: (v, _dir_stamp(site, v)), vols))
        return {v: st for v, st in got if st}

    step = max(1, len(nums) // 32)
    first = stamps(nums[::step])
    if not first:
        return None
    best = max(first, key=lambda v: first[v])
    i = nums.index(best)
    stretch = [nums[(i + k) % len(nums)] for k in range(1, step + 1)]
    second = {**first, **stamps(stretch)}
    return max((v for v in [best, *stretch] if v in second), key=lambda v: second[v])


def list_volumes(site: str, limit: int = 30, start: Optional[int] = None) -> list[dict]:
    """The newest `limit` complete volumes, oldest first.

    Volumes are numbered sequentially as they're written, so once the newest is
    known the previous ones are just N-1, N-2, ... (wrapping at 1). No need to
    rescan every directory.

    `start` is archive playback, which the archive answers (`archive_volumes`).
    """
    if start is not None:
        return archive_volumes(site, limit, start)
    site = icao_for(site)
    now = time.time()
    hit = _LIST_CACHE.get(site)
    cached = hit[1] if hit and now - hit[0] < _LIST_TTL else None
    if cached is not None and len(cached) >= limit:
        _LIST_CACHE.move_to_end(site)
        return cached[-limit:]

    newest = _newest_vol_num(site)
    if newest is None:
        return []
    # A few extra candidates absorb incomplete/missing slots. A volume already
    # found whole in the last few hours is not listed again -- it cannot change
    # -- so a refresh asks about the newest few, not forty.
    cands = [((newest - 1 - i) % 999) + 1 for i in range(limit + 8)]
    known = _WHOLE.setdefault(site, {})
    cutoff = now - 6 * 3600
    for v in [v for v, e in known.items() if e["time"] < cutoff]:
        known.pop(v, None)
        _CHUNK_LISTS.pop((site, v), None)
    ask = [v for v in cands if v not in known]
    with ThreadPoolExecutor(24) as ex:
        got = list(ex.map(lambda v: (v, _chunks_for(site, v)), ask))

    for v, ch in got:
        if not _whole(ch):
            continue  # still being written, or old enough to be losing chunks
        st = _stamp(ch)
        known[v] = {"vol": v, "stamp": st, "time": _stamp_unix(st), "key": f"L2:{v}:{st}"}
        _CHUNK_LISTS[(site, v)] = ch
    out: list[dict] = [known[v] for v in cands if v in known]
    out.sort(key=lambda d: d["time"])
    out = out[-limit:]
    _LIST_CACHE[site] = (now, out)
    while len(_LIST_CACHE) > 8:
        _LIST_CACHE.popitem(last=False)
    return out


# The last few volumes as downloaded -- compressed, 5-16 MB each. A decoded
# volume is far too big to keep, but with these another tilt of the same frame
# costs a decode, a couple of seconds, instead of the whole download again.
_RAW: "OrderedDict[tuple, bytes]" = OrderedDict()
_RAW_BUDGET = 96 * 1024 * 1024
_RAW_LOCK = threading.Lock()


def _kept(key: tuple, fetch) -> bytes:
    with _RAW_LOCK:
        hit = _RAW.get(key)
        if hit is not None:
            _RAW.move_to_end(key)
            return hit
    raw = fetch()
    with _RAW_LOCK:
        _RAW[key] = raw
        while len(_RAW) > 1 and sum(map(len, _RAW.values())) > _RAW_BUDGET:
            _RAW.popitem(last=False)
    return raw


def _volume_chunks(site: str, vol: int) -> list[tuple[str, int]]:
    """A volume's chunk keys in order -- from the listing list_volumes already
    made when there is one (a whole volume never changes), else listed now."""
    known = _CHUNK_LISTS.get((site, vol))
    ch = list(known) if known else _chunks_for(site, vol)
    if not ch:
        raise RuntimeError(f"Level II volume {vol} missing for {site}.")
    ch.sort(key=lambda kv: _chunk_num(kv[0]))
    return ch


def _volume_raw(site: str, vol: int) -> tuple[bytes, str]:
    """A whole volume's bytes, and its stamp."""
    ch = _volume_chunks(site, vol)
    stamp = _stamp(ch)
    nums = [_chunk_num(k) for k, _ in ch]
    return b"".join(_get_chunks(site, vol, stamp, ch, nums)), stamp


def _decode_volume(site: str, vol: int) -> tuple[Any, str]:
    """Fetch a specific volume's chunks and decode it. The decoded volume is
    never cached -- the caller extracts what it needs and lets it go."""
    raw, stamp = _volume_raw(site, vol)
    return Level2File(io.BytesIO(raw)), stamp


# ---------------------------------------------------------------------------
# One tilt without the rest of the volume.
#
# The chunk bucket cuts a volume into pieces of exactly 120 radials of one
# elevation, in the order flown (read from KFWS 2026-09-25: 55 chunks -- the
# start chunk, 6 per 720-radial cut, 3 per 360-radial one). The start chunk,
# 2 kB, carries the scan strategy: every cut's angle and whether it is flown at
# 0.5 deg. So the chunks of one tilt are known before any of them is fetched,
# and the 0.5 deg split cut is chunks 2-13: 2.3 MB of an 8.4 MB volume, and a
# decode of that much instead of all of it -- the whole volume took 3.6 s to
# pull and 1.4 s to decode, every frame of a loop.
# ---------------------------------------------------------------------------
_CHUNK_BYTES: "OrderedDict[tuple, bytes]" = OrderedDict()
_CHUNK_BUDGET = 192 * 1024 * 1024
_CHUNK_SIZE = {"n": 0}
_CHUNK_LOCK = threading.Lock()
# Chunks being fetched, so a tilt asked for while the rest of its volume is
# being filled in waits for the same download instead of starting another.
_INFLIGHT: dict[tuple, "Future[bytes]"] = {}
# Chunk listings of whole volumes, as list_volumes found them.
_CHUNK_LISTS: dict[tuple, list[tuple[str, int]]] = {}
# The scan strategy of each volume: [(angle, radials)] per elevation number.
_VOL_PLAN: "OrderedDict[tuple, list[tuple[float, int]]]" = OrderedDict()
_POOL = ThreadPoolExecutor(32, thread_name_prefix="l2-chunk")
# A tilt read alone is a volume with the cuts before it missing, and MetPy says
# so for every one ("Missed start of volume!", "Missed elevation"), rightly and
# uselessly -- as it does for message types it skips in a whole one.
logging.getLogger("metpy.io.nexrad").setLevel(logging.ERROR)


def _get_chunks(site: str, vol: int, stamp: str, ch: list[tuple[str, int]], nums: list[int],
                pool: Optional[ThreadPoolExecutor] = None) -> list[bytes]:
    """Chunks `nums` of a volume, in that order: kept ones from memory, the rest
    fetched at once (on `pool`, the foreground one unless told otherwise)."""
    by_num = {_chunk_num(k): k for k, _ in ch}
    out: dict[int, bytes] = {}
    waits: dict[int, Future] = {}
    with _CHUNK_LOCK:
        for n in nums:
            key = (site, vol, stamp, n)
            hit = _CHUNK_BYTES.get(key)
            if hit is not None:
                _CHUNK_BYTES.move_to_end(key)
                out[n] = hit
                continue
            # A chunk already on its way is waited for, not fetched twice --
            # unless it is only queued behind the rest of a volume being filled
            # in: then it is taken off that queue and fetched now.
            fut = _INFLIGHT.get(key)
            if fut is not None and not fut.running() and not fut.done() and pool is None and fut.cancel():
                fut = None
            if fut is None:
                fut = (pool or _POOL).submit(_fetch_chunk, key, CHUNKS + by_num[n])
                _INFLIGHT[key] = fut
            waits[n] = fut
    for n, fut in waits.items():
        out[n] = fut.result()
    return [out[n] for n in nums]


def _fetch_chunk(key: tuple, url: str) -> bytes:
    """One chunk, kept once it is here -- by whoever fetched it."""
    try:
        data = _SESSION.get(url, timeout=_TIMEOUT).content
        with _CHUNK_LOCK:
            if key not in _CHUNK_BYTES:
                _CHUNK_BYTES[key] = data
                _CHUNK_SIZE["n"] += len(data)
            while _CHUNK_SIZE["n"] > _CHUNK_BUDGET and len(_CHUNK_BYTES) > 1:
                _, old = _CHUNK_BYTES.popitem(last=False)
                _CHUNK_SIZE["n"] -= len(old)
        return data
    finally:
        with _CHUNK_LOCK:
            _INFLIGHT.pop(key, None)


# The rest of the volume on screen, fetched behind it on connections of their
# own, so another tilt of it is a decode (0.3 s) rather than a download (2.5 s
# measured at KAMA) -- and never ahead of a frame someone is waiting for.
_REST = ThreadPoolExecutor(6, thread_name_prefix="l2-rest")
_RESTED: "OrderedDict[tuple, None]" = OrderedDict()


def _fetch_rest(site: str, vol: int) -> None:
    """Queue every chunk of a live volume, once."""
    if (site, vol) in _RESTED:
        return
    _RESTED[(site, vol)] = None
    while len(_RESTED) > 64:
        _RESTED.popitem(last=False)

    def run() -> None:
        try:
            ch = _volume_chunks(site, vol)
            _get_chunks(site, vol, _stamp(ch), ch, [_chunk_num(k) for k, _ in ch], pool=_REST)
        except Exception:  # noqa: BLE001 - a tilt asked for later fetches its own
            _RESTED.pop((site, vol), None)

    threading.Thread(target=run, daemon=True, name="l2-rest-volume").start()


def _volume_plan(site: str, vol: int, stamp: str, ch: list[tuple[str, int]]) -> list[tuple[float, int]]:
    """Each elevation's (angle, radials) from the volume's start chunk."""
    key = (site, vol, stamp)
    plan = _VOL_PLAN.get(key)
    if plan is not None:
        return plan
    head = _get_chunks(site, vol, stamp, ch, [1])[0]
    vcp = Level2File(io.BytesIO(head)).vcp_info
    plan = []
    for e in vcp.els:
        fine = any("0.5 azimuth" in str(x) for x in (getattr(e, "super_res", None) or []))
        plan.append((round(float(e.el_angle), 2), 720 if fine else 360))
    _VOL_PLAN[key] = plan
    while len(_VOL_PLAN) > 256:
        _VOL_PLAN.popitem(last=False)
    return plan


def _slot_part(site: str, vol: int, slot: str) -> Optional[tuple[bytes, str, list[float], set[int]]]:
    """The start chunk and the chunks of the cuts filed under `slot`, joined --
    a volume MetPy reads as one holding just those sweeps -- with its stamp,
    every cut angle of the volume (the slot mapping needs them all) and the
    elevation numbers fetched. None when the chunks do not add up to the scan
    strategy (a volume cut short, a strategy this does not know): the caller
    then reads the whole volume."""
    ch = _volume_chunks(site, vol)
    stamp = _stamp(ch)
    if not _whole(ch):
        return None
    plan = _volume_plan(site, vol, stamp, ch)
    counts = [radials // 120 for _, radials in plan]
    # A volume can stop short of its strategy (AVSET ends it when there is
    # nothing up high): then its chunks add up to the first cuts only.
    total = 1
    for k, c in enumerate(counts):
        total += c
        if total == len(ch):
            plan, counts = plan[:k + 1], counts[:k + 1]
            break
    else:
        return None
    angles = [a for a, _ in plan]
    wanted = dict(slots_for_cuts(sorted(set(angles)))).get(slot)
    first = 2
    nums: list[int] = []
    els: set[int] = set()
    for i, (angle, _) in enumerate(plan):
        if wanted is not None and abs(angle - wanted) <= 0.1:
            nums.extend(range(first, first + counts[i]))
            els.add(i + 1)
        first += counts[i]
    if not nums:
        nums = list(range(2, 2 + counts[0]))  # not flown: one sweep, for the site's header
    return b"".join(_get_chunks(site, vol, stamp, ch, [1, *nums])), stamp, angles, els


def _ladder(angles: list[float]) -> list[dict]:
    """The distinct cuts of a scan strategy, low to high, snapped to the ladder
    (volume_elevations, from the plan instead of decoded sweeps)."""
    groups: list[float] = []
    for e in sorted(set(angles)):
        if not groups or e - groups[-1] > 0.25:
            groups.append(e)
    out = []
    for g in groups:
        nominal = min(_ELEV_LADDER, key=lambda r: abs(r - g))
        if out and out[-1]["elev"] == nominal:
            continue
        out.append({"elev": nominal, "actual": g})
    return out


def _sweep_angle(f: Any, sweep: list) -> float:
    """The elevation a sweep was commanded to fly, from the scan strategy.

    Looked up by the radials' elevation number, not read off the first radial:
    the antenna's own reading is still settling there, by as much as 0.2 deg.
    At KHDC the 0.3 deg cut's first radial read 0.5 -- which filed that sweep,
    dual-pol and all, under 0.5 -- and the 0.9 cut's read 0.75.
    """
    vcp = getattr(f, "vcp_info", None)
    num = int(sweep[0][0].el_num)
    if vcp is not None and 1 <= num <= len(vcp.els):
        return float(vcp.els[num - 1].el_angle)
    return float(np.median([r[0].el_angle for r in sweep]))


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
        out.append((i, _sweep_angle(f, sw), len(sw), int(blk.num_gates)))
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
    for slot, nominal in [("L", _ELEV["L"]), *TILT_SLOTS, *UPPER_SLOTS]:
        best = _pick(cand, nominal, slot)
        if best is None:
            continue
        _, elev, nrad, ngates = best
        tilts.append({"code": f"L2{fam}{slot}", "tilt": slot, "elev": nominal,
                      "actualElev": round(elev, 2), "radials": nrad, "gates": ngates})
    return tilts


def _pick(cand: list[tuple[int, float, int, int]], nominal: float, slot: str = "",
          cuts: Optional[list[float]] = None):
    """The best sweep for a nominal elevation.

    First the ANGLE: only the sweeps at the elevation nearest the one asked for.
    At a radar with a 0.3 deg cut, "0.5" used to accept the 0.3 sweep too -- it
    is within the tolerance -- and the range-first sort below could then serve
    it under the 0.5 label. The low slot takes only what is under LOW_CUT_MAX.

    Then RANGE, then radials. The VCPs split the low cuts into a *surveillance*
    sweep (REF + dual-pol, full 458 km) and a *doppler* sweep (REF + VEL/SW,
    range-folded to ~298 km). Both report the same angle, and picking the
    doppler one for reflectivity paints a hard circular edge where its range
    simply stops.
    """
    # Only the sweeps whose cut belongs to this slot: at VCP 31's 1.5 deg cut the
    # "1.8" slot would otherwise take 1.5 as the nearest thing it has.
    # `cuts`: every cut of the volume, when only some of its sweeps were read.
    angles = sorted(set(cuts)) if cuts is not None else sorted({round(c[1], 2) for c in cand})
    wanted = dict(slots_for_cuts(angles)).get(slot)
    near = [c for c in cand if wanted is not None and abs(c[1] - wanted) <= 0.1]
    if not near:
        return None
    return sorted(near, key=lambda c: (-c[3], -c[2], abs(c[1] - nominal)))[0]


def _extract(f: Any, fam: str, slot: str, site: str, stamp: str,
             cuts: Optional[list[float]] = None) -> Optional[dict]:
    """One moment out of an already-decoded volume, in the polar wire format."""
    spec = L2_MOMENTS[fam]
    chosen = _pick(_sweeps_with(f, spec["src"]), _ELEV[slot], slot, cuts)
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
            "site": icao_for(site),
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
    deg); `key` is `L2:<vol>:<stamp>` from `list_volumes`, `L2A:<file name>`
    for an archive volume, or empty for newest.

    One volume download is ~7 MB, so when a volume is decoded EVERY Level II
    moment at that tilt is extracted and cached, not just the one asked for.
    Scrubbing a 30-frame CC loop and then switching to ZDR costs no new traffic.
    """
    site = site_id(site)
    if not product.startswith("L2") or len(product) < 4:
        raise RuntimeError(f"Not a Level II product: {product}")
    fam, slot = product[2], product[3]
    if fam not in L2_MOMENTS or slot not in _ELEV:
        raise RuntimeError(f"Unknown Level II product: {product}")

    vol: Optional[int | str] = None
    if key.startswith("L2A:"):
        vol = key[4:]  # an archive volume, by its file name
    elif key.startswith("L2:"):
        bits = key.split(":")
        if len(bits) >= 3 and bits[1].isdigit():
            vol = int(bits[1])
    if vol is None:
        # The newest volume number is the one still being WRITTEN -- decoding it
        # yields a couple of sweeps and a truncated elevation ladder. Take the
        # newest volume that has its end chunk instead.
        recent = list_volumes(site, 1)
        if not recent:
            raise RuntimeError(f"No complete Level II volume for {icao_for(site)}.")
        vol = int(recent[-1]["key"].split(":")[1])

    cache_key = (site, fam, slot, vol)
    hit = _GRID_CACHE.get(cache_key)
    if hit is not None:
        _GRID_CACHE.move_to_end(cache_key)
        return hit

    # The bytes first, outside the decode gate: the gate bounds the memory of
    # a decode, and with the downloads inside it a loop pulled two volumes at a
    # time -- ten volumes took 49 s. A live volume brings only this tilt's
    # chunks (see _slot_part); an archive one, or a volume the plan does not
    # fit, comes whole.
    cuts: Optional[list[float]] = None
    els: set[int] = set()
    if isinstance(vol, str):
        raw = _kept(("archive", vol), lambda: _archive_get(_archive_path(vol)))
        stamp = f"{vol[4:12]}-{vol[13:19]}"
    else:
        part = None
        try:
            part = _slot_part(icao_for(site), vol, slot)
        except Exception:  # noqa: BLE001 - the whole volume still answers
            part = None
        if part is not None:
            raw, stamp, cuts, els = part
            # The newest volume is the one on screen until the next lands: its
            # other tilts are the next thing asked for.
            listed = _LIST_CACHE.get(icao_for(site))
            if listed and listed[1] and listed[1][-1]["vol"] == vol:
                _fetch_rest(icao_for(site), vol)
        else:
            raw, stamp = _volume_raw(icao_for(site), vol)

    with _DECODE_SEM:  # bound the memory spike, not the downloads
        # another thread may have finished it while we waited
        hit = _GRID_CACHE.get(cache_key)
        if hit is not None:
            _GRID_CACHE.move_to_end(cache_key)
            return hit
        f = Level2File(io.BytesIO(raw))
        if cuts is not None and els:
            # Each fetched cut whole (120 radials a chunk), or the full volume.
            flown = {int(sw[0][0].el_num): len(sw) for sw in f.sweeps if sw}
            if any(el not in flown for el in els):
                raw, stamp = _volume_raw(icao_for(site), vol)
                f = Level2File(io.BytesIO(raw))
                cuts = None
        _VOL_ELEVS[(site, stamp)] = _ladder(cuts) if cuts is not None else volume_elevations(f)
        while len(_VOL_ELEVS) > 8:
            _VOL_ELEVS.pop(next(iter(_VOL_ELEVS)))
        wanted: Optional[dict] = None
        for other in L2_MOMENTS:
            grid = _extract(f, other, slot, site, stamp, cuts)
            if grid is None:
                continue
            k = (site, other, slot, vol)
            _GRID_CACHE[k] = grid
            _GRID_CACHE.move_to_end(k)
            if other == fam:
                wanted = grid
        if wanted is None:
            wanted = _not_scanned(f, fam, slot, site, stamp)
            _GRID_CACHE[cache_key] = wanted
        del f  # release the decoded volume before returning
        while len(_GRID_CACHE) > _GRID_MAX:
            _GRID_CACHE.popitem(last=False)
    return wanted


def _not_scanned(f: Any, fam: str, slot: str, site: str, stamp: str) -> dict:
    """An empty frame for a volume with no sweep of this moment at this tilt.

    A radar changes scan strategy with the weather, so across a loop some
    volumes have an elevation and some do not: clear air stops at 6.4 deg, and
    before 2013 there was no dual-pol at all. One such frame used to turn the
    whole radar panel into an error. It is an empty frame that says why.
    """
    first = next((sw[0] for sw in f.sweeps if sw), None)
    if first is None:
        raise RuntimeError(f"Level II volume {stamp} for {icao_for(site)} has no sweeps.")
    spec = L2_MOMENTS[fam]
    pid = _KIND_DEFAULT_PALETTE.get(spec["kind"], "REF")
    _, vmin, vmax = get_cmap(pid)
    vcp = int(getattr(first[1], "vcp", 0)) or None
    unix = _stamp_unix(stamp)
    return {
        "az": np.linspace(0, 360, 361, dtype=np.float32),
        "lut": np.full(256, np.nan, dtype=np.float32),
        "codes": np.zeros((360, 1), dtype=np.uint8),
        "meta": {
            "site": icao_for(site),
            "siteLat": float(first[1].lat),
            "siteLon": float(first[1].lon),
            "product": f"L2{fam}{slot}",
            "productLabel": spec["label"],
            "units": spec["units"],
            "kind": spec["kind"],
            "family": fam,
            "tilt": slot,
            "elevation": None,
            "defaultPalette": pid,
            "vmin": vmin,
            "vmax": vmax,
            "nAz": 360,
            "nGates": 1,
            "rangeStartKm": 0.0,
            "gateWidthKm": 460.0,
            "maxRangeKm": 460.0,
            "validUnix": unix,
            "scanUnix": unix,
            "key": f"L2:{stamp}",
            "source": "level2",
            "superRes": False,
            "vcp": vcp,
            "elevations": _VOL_ELEVS.get((site, stamp), []),
            "note": f"Not scanned at {_ELEV[slot]}° in this volume" + (f" (VCP {vcp})" if vcp else ""),
        },
    }


# Which nominal cuts come back super-res. The VCPs run *split cuts* at the three
# lowest elevations -- a surveillance sweep (REF + dual-pol) and a doppler sweep
# (VEL/SW), both at 720 radials. From 1.8 deg up the cuts merge and drop to 360,
# which is no better than Level III, so the picker says so.
_SUPER_RES_SLOTS = {"L", "0", "A", "1"}
SUPER_RES_SLOTS = _SUPER_RES_SLOTS


def slots_for_cuts(cuts: list[float]) -> list[tuple[str, float]]:
    """Which tilt slot each of a radar's cuts is, lowest first.

    A cut goes to its NEAREST slot, and a slot takes only the cut nearest to it:
    so VCP 31's 0.5 / 1.5 / 2.5 / 3.5 fill the 0.5, 1.3, 2.4 and 3.1 slots and
    leave 0.9 and 1.8 empty -- those tilts do not exist in that mode -- where a
    tolerance alone would put the 1.5 cut under both 1.3 and 1.8. A cut below
    the 0.5 one is the low slot; the upper ones go to UPPER_SLOTS.
    """
    ladder = [(slot, nominal) for slot, nominal in [*TILT_SLOTS, *UPPER_SLOTS]]
    best: dict[str, float] = {}
    distinct: list[float] = []
    for a in sorted(cuts):
        # 0.05, not 0.1: KBMX flies 0.40 AND 0.48, and merging them lost a tilt.
        if not distinct or a - distinct[-1] > 0.05:
            distinct.append(a)
    has_half = any(0.45 <= a <= 0.6 for a in distinct)
    for a in distinct:
        # Below 0.35 is always the low cut; 0.35-0.45 is the low cut only when the
        # radar also flies a 0.5 one (KBMX), and otherwise simply its 0.5 slot.
        if a < 0.35 or (a < 0.45 and has_half):
            best.setdefault("L", a)
            continue
        slot, nominal = min(ladder, key=lambda sn: abs(sn[1] - a))
        # The ladder spreads out as it climbs: 0.4 deg apart at the bottom,
        # 4 deg at the top, so the tolerance grows with it.
        if abs(nominal - a) > max(0.45, 0.15 * nominal):
            continue
        if slot not in best or abs(nominal - a) < abs(nominal - best[slot]):
            best[slot] = a
    order = ["L"] + [slot for slot, _ in ladder]
    return [(slot, best[slot]) for slot in order if slot in best]

# The nominal elevation ladder NEXRAD VCPs are cut at. Measured angles drift
# from these (a "0.5 deg" cut comes back as 0.44-0.67 depending on where in the
# volume it was flown), so sweeps are snapped to the nearest rung for labelling.
_ELEV_LADDER = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0,
                10.0, 12.5, 14.0, 15.6, 19.5]


ARCHIVE = "https://unidata-nexrad-level2.s3.amazonaws.com/"
_ARCHIVE_NAME = re.compile(r"/([A-Z]{4})(\d{8})_(\d{6})(_V\d{2})?(\.gz)?$")
_ARCHIVE_LISTS: "OrderedDict[tuple, tuple[float, list[dict]]]" = OrderedDict()
_ARCHIVE_CUTS: "OrderedDict[str, dict]" = OrderedDict()
# The start of a bzip2 stream, which is how every Level II record begins.
_BZ_MAGIC = b"BZh91AY&SY"


def _archive_path(name: str) -> str:
    """KIND20260727_202449_V06 -> 2026/07/27/KIND/KIND20260727_202449_V06."""
    return f"{name[4:8]}/{name[8:10]}/{name[10:12]}/{name[:4]}/{name}"


def archive_volumes(site: str, limit: int, start: int) -> list[dict]:
    """The first `limit` volumes at or after `start`, from the Level II archive.

    Archive playback used to sweep the chunk bucket, which keeps two days:
    asked for KIND on July 27th it handed back the oldest thing it had -- a
    volume from two days ago with its first 39 chunks already deleted.
    """
    import datetime as _dt

    icao = icao_for(site)
    ck = (icao, int(start), limit)
    hit = _ARCHIVE_LISTS.get(ck)
    if hit and time.time() - hit[0] < _LIST_TTL:
        return hit[1]
    t0 = _dt.datetime.fromtimestamp(start, _dt.timezone.utc)
    today = _dt.datetime.now(_dt.timezone.utc).date()
    out: list[dict] = []
    for d in range(3):  # a loop that starts late in the day runs on into the next
        day = t0.date() + _dt.timedelta(days=d)
        if day > today:
            break
        params = {"list-type": "2", "prefix": f"{day:%Y/%m/%d}/{icao}/"}
        if d == 0:
            params["start-after"] = f"{day:%Y/%m/%d}/{icao}/{icao}{t0:%Y%m%d_%H%M%S}"
        r = _SESSION.get(ARCHIVE, params=params, timeout=_TIMEOUT)
        r.raise_for_status()
        for key in re.findall(r"<Key>([^<]+)</Key>", r.text):
            m = _ARCHIVE_NAME.search(key)
            if not m:
                continue  # the _MDM metadata files
            stamp = f"{m.group(2)}-{m.group(3)}"
            out.append({"vol": None, "stamp": stamp, "time": _stamp_unix(stamp),
                        "key": f"L2A:{key.rsplit('/', 1)[1]}"})
        if len(out) >= limit:
            break
    out = out[:limit]
    _ARCHIVE_LISTS[ck] = (time.time(), out)
    while len(_ARCHIVE_LISTS) > 16:
        _ARCHIVE_LISTS.popitem(last=False)
    return out


def _archive_get(path: str) -> bytes:
    """One archive volume, ~16 MB, pulled in parallel ranges: S3 serves a big
    object several times faster in pieces -- 8 s here where one stream took 36."""
    part = 1024 * 1024
    first = _SESSION.get(ARCHIVE + path, headers={"Range": f"bytes=0-{part - 1}"}, timeout=_TIMEOUT)
    if first.status_code == 404:
        raise RuntimeError(f"Level II volume {path.rsplit('/', 1)[-1]} is not in the archive.")
    first.raise_for_status()
    total = int(first.headers.get("Content-Range", "/0").rsplit("/", 1)[-1] or 0)
    if not total or len(first.content) >= total:
        return first.content

    def piece(lo: int) -> bytes:
        hi = min(lo + part, total) - 1
        r = _SESSION.get(ARCHIVE + path, headers={"Range": f"bytes={lo}-{hi}"}, timeout=_TIMEOUT)
        r.raise_for_status()
        if len(r.content) != hi - lo + 1:
            raise RuntimeError(f"Level II volume {path.rsplit('/', 1)[-1]} came back short.")
        return r.content

    with ThreadPoolExecutor(16) as ex:
        rest = list(ex.map(piece, range(part, total, part)))
    return first.content + b"".join(rest)


def _decode_archive(name: str) -> tuple[Any, str]:
    """An archive volume by file name, decoded, and its stamp."""
    raw = _kept(("archive", name), lambda: _archive_get(_archive_path(name)))
    return Level2File(io.BytesIO(raw)), f"{name[4:12]}-{name[13:19]}"


def _last_el_num(head: bytes, tail: bytes) -> Optional[int]:
    """The last elevation a volume reached, from its first record and its last."""
    quiet = logging.getLogger("metpy.io.nexrad")
    level = quiet.level
    quiet.setLevel(logging.ERROR)  # it complains about the records in between, rightly
    try:
        part = Level2File(io.BytesIO(head + tail))
        nums = [int(r[0].el_num) for sw in part.sweeps for r in sw]
        return max(nums) if nums else None
    finally:
        quiet.setLevel(level)


def _archive_ends(path: str) -> tuple[Any, Optional[int]]:
    """An archive volume's scan strategy and how far it got, from its two ends:
    the first record is the VCP, the last one holds the final elevation. About
    100 KB of a 16 MB file."""
    size = struct.unpack(">i", _SESSION.get(ARCHIVE + path, headers={"Range": "bytes=24-27"},
                                            timeout=_TIMEOUT).content[:4])[0]
    head = _SESSION.get(ARCHIVE + path, headers={"Range": f"bytes=0-{28 + abs(size) - 1}"}, timeout=_TIMEOUT).content
    vcp = Level2File(io.BytesIO(head)).vcp_info
    for span in (400_000, 3_000_000):
        tail = _SESSION.get(ARCHIVE + path, headers={"Range": f"bytes=-{span}"}, timeout=_TIMEOUT).content
        i = tail.rfind(_BZ_MAGIC)
        # The last record runs exactly to the end of the file; anything else is
        # not a record boundary (or an old gzip-wrapped file with none to find).
        if i >= 4 and abs(struct.unpack(">i", tail[i - 4:i])[0]) == len(tail) - i:
            return vcp, _last_el_num(head, tail[i - 4:])
    return vcp, None


def _archive_cuts(site: str, at: int) -> dict:
    """What the radar flew at `at`: the first archive volume from then on."""
    vols = archive_volumes(site, 1, at)
    if not vols:
        raise RuntimeError(f"No Level II volume for {site} from that time.")
    name = vols[0]["key"][4:]
    hit = _ARCHIVE_CUTS.get(name)
    if hit is not None:
        return hit
    vcp, flown = _archive_ends(_archive_path(name))
    if vcp is None:
        raise RuntimeError(f"{site}'s volume {name} carries no scan strategy.")
    out = _cuts_summary(site, vcp, flown, vols[0]["key"], vols[0]["time"])
    _ARCHIVE_CUTS[name] = out
    while len(_ARCHIVE_CUTS) > 64:
        _ARCHIVE_CUTS.popitem(last=False)
    return out


_CUTS_CACHE: dict[str, tuple[float, dict]] = {}
# The volume list itself is cached two minutes; the cuts follow it.
_CUTS_TTL = 2 * 60


def _newest_archive_key(site: str) -> Optional[str]:
    """The newest complete volume in the Level II archive, listing only its tail.

    A day's directory is ~250 volumes; `start-after` a key from 40 minutes ago
    brings back the last few instead, which is most of the difference between
    a tilt check that takes seconds and one that takes a fraction of one.
    """
    import datetime as _dt
    import re as _re

    now = _dt.datetime.now(_dt.timezone.utc)
    since = now - _dt.timedelta(minutes=40)
    tries = [(since, f"{since:%Y/%m/%d}/{site}/{site}{since:%Y%m%d_%H%M%S}")]
    if since.date() != now.date():
        tries.append((now, None))
    # Nothing that recent: the radar is down or the archive is behind -- look at
    # the whole of today and yesterday before saying so.
    tries += [(now, None), (now - _dt.timedelta(days=1), None)]
    for day, after in tries:
        params = {"list-type": "2", "prefix": f"{day:%Y/%m/%d}/{site}/"}
        if after:
            params["start-after"] = after
        r = _SESSION.get(ARCHIVE, params=params, timeout=_TIMEOUT)
        keys = [k for k in _re.findall(r"<Key>([^<]+)</Key>", r.text) if not k.endswith("_MDM")]
        if keys:
            return keys[-1]
    return None


def site_cuts(site: str, at: Optional[int] = None) -> dict:
    """The elevations this radar is flying, and which moments each cut carries.

    Every radar's tilts are its own: KHDC flies 0.3 deg below the 0.5 cut, KLGX
    0.2, KMUX and KMTX 0.0; clear air stops at 6.4 deg where storm modes go to
    19.5. The VCP -- the list of cuts -- sits in the first chunk of a volume,
    about 2 KB.

    Read from the newest complete volume in the chunk bucket, the very volume a
    Level II tilt then loads. It was read from the archive, which runs minutes
    behind: KLGX changed mode in between, and the list offered 8.0 to 19.5 deg
    cuts the volume on screen did not have. The archive is only the fallback.

    `at` asks what it flew then instead, for archive playback.
    """
    site = icao_for(site)
    if at is not None:
        return _archive_cuts(site, at)
    hit = _CUTS_CACHE.get(site)
    if hit and time.time() - hit[0] < _CUTS_TTL:
        return hit[1]

    vcp = None
    volume = volume_unix = None
    flown = None  # how many of the VCP's elevations the volume actually got through
    vols = list_volumes(site, 1)
    if vols:
        newest = vols[-1]
        # Through the chunk store: the first Level II frame of this volume then
        # finds its start chunk (the scan strategy) already here.
        chunks = _volume_chunks(site, newest["vol"])
        if chunks and chunks[0][0].endswith("-S"):
            ends = chunks[-1][0].endswith("-E")
            got = _get_chunks(site, newest["vol"], newest["stamp"], chunks,
                              [1, _chunk_num(chunks[-1][0])] if ends else [1])
            head = got[0]
            vcp = Level2File(io.BytesIO(head)).vcp_info
            volume, volume_unix = newest["key"], newest["time"]
            # The radar ends a volume early when there is nothing up high
            # (AVSET): KLGX's VCP runs to 19.5 deg and the volume stopped at 6.4.
            # The last chunk carries the last elevation it reached.
            if ends:
                flown = _last_el_num(head, got[1])
    if vcp is None:
        key = _newest_archive_key(site)
        if key is None:
            raise RuntimeError(f"No Level II volume for {site} today or yesterday.")
        vcp, flown = _archive_ends(key)
        volume, volume_unix = key.rsplit("/", 1)[-1], _volume_unix(key)
    if vcp is None:
        raise RuntimeError(f"{site}'s newest volume carries no scan strategy.")
    out = _cuts_summary(site, vcp, flown, volume, volume_unix)
    _CUTS_CACHE[site] = (time.time(), out)
    return out


def _cuts_summary(site: str, vcp: Any, flown: Optional[int], volume: Optional[str],
                  volume_unix: Optional[int]) -> dict:
    """A volume's cuts, as flown, and the moments each one carries."""
    els = list(vcp.els)[:flown] if flown else list(vcp.els)
    angles = sorted({round(float(e.el_angle), 2) for e in els})
    cuts: list[float] = []
    for a in angles:
        if not cuts or a - cuts[-1] > 0.05:
            cuts.append(a)
    # The moments each cut carries, across every sweep flown at it.
    moments: dict[float, set[str]] = {c: set() for c in cuts}
    for e in els:
        cut = min(cuts, key=lambda c: abs(c - float(e.el_angle)))
        moments[cut] |= set(_WAVEFORM_MOMENTS.get(str(e.waveform), "BGWCXPF"))
    low = dict(slots_for_cuts(cuts)).get("L")
    out = {
        "site": site,
        # As flown, to a tenth: 0.48 is the 0.5 cut, 0.31 the 0.3 one.
        "cuts": [round(a, 1) for a in cuts],
        "exact": cuts,
        "low": None if low is None else round(low, 1),
        "volume": volume,
        "volumeUnix": volume_unix,
        "moments": {str(c): "".join(sorted(m)) for c, m in moments.items()},
        "elevationsFlown": flown,
        "elevationsPlanned": len(vcp.els),
    }
    return out


def _volume_unix(key: str) -> Optional[int]:
    """KHDC20260914_002938_V06 -> its start time."""
    import datetime as _dt
    name = key.rsplit("/", 1)[-1]
    try:
        stamp = _dt.datetime.strptime(name[4:19], "%Y%m%d_%H%M%S").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return None
    return int(stamp.timestamp())


def volume_elevations(f: Any) -> list[dict]:
    """The distinct cuts a volume actually flew, low to high.

    Two things make this more than `sorted(set(...))`:
      * **split cuts** -- the low elevations are flown twice (surveillance +
        doppler) a few hundredths apart;
      * **SAILS** -- extra low-level sweeps spliced into the middle of the
        volume, so the raw sweep order is NOT ascending.
    Group anything within 0.25 deg, then snap to the nominal ladder.
    """
    els = sorted({round(_sweep_angle(f, sw), 2) for sw in f.sweeps if sw})
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
_L3_ORDER = ["B", "G", "S", "R", "X", "K", "C", "DVL", "EET", "H", "HHC", "OHA", "DAA", "DTA"]
_L3_SHORT = {
    "B": "REF", "G": "VEL", "S": "SRM", "R": "NROT", "C": "CC", "X": "ZDR", "K": "KDP",
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
    ("R", "level3"),    # Normalized rotation (derived from velocity, L3 only)
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
