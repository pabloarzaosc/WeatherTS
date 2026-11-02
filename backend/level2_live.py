"""Live Level II: the volume still being written, and each scan of a tilt.

The chunk bucket (unidata-nexrad-level2-chunks) fills a volume directory as
the radar flies it: a 2 kB start chunk with the scan strategy, then 120
radials of one cut per chunk, in the order flown (reference: nexrad_level2's
notes on _slot_part). So while a volume is coming in, which cuts are done is
a matter of counting chunks against the plan -- no decoding.

Three things live here:

* ``status(site)`` -- the volume being written: how many cuts of the plan are
  in, megabytes so far against what the volume will weigh, and the scans that
  are already whole. The app shows it as "Streaming KTLX - cut 5 of 12 -
  7.0 / 10.6 MB" and adds the in-progress volume to the end of the loop.
* ``reps_for(site, vol)`` -- the tilts a volume flies more than once. SAILS
  goes back to the lowest cut once to three times in the middle of a volume
  (KOKX VCP 212: 0.5 0.5 0.9 0.9 1.3 1.3 | 0.5 0.5 | 1.8 ...), MRLE repeats
  the lowest few; each return is its own picture a couple of minutes newer.
  A run of consecutive cuts at one tilt is one scan of it (the split
  surveillance + Doppler pair counts once). Each scan's time comes from when
  its first chunk landed, relative to the start chunk.
* ``polar(site, product, key)`` -- the frames those two add:
  ``L2P:<vol>:<stamp>`` (the volume being written) and ``...:c<k>`` (the k-th
  scan of the tilt, k >= 2, live or whole). A tilt the radar has not reached
  yet comes back as a ``pending`` frame (meta.pending, a note "1.3 deg isn't
  scanned yet"), never cached, which the app answers with the previous
  volume's picture.
"""

from __future__ import annotations

import io
import math
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from typing import Any, Optional

import numpy as np

import nexrad_level2 as l2
from nexrad_core import _KIND_DEFAULT_PALETTE, get_cmap, icao_for, site_id

_REP_RE = re.compile(r":c(\d+)$")
# A volume whose newest chunk is older than this is not streaming: the radar
# is down or between strategies, and "cut 5 of 12" would be a lie.
STALE_S = 15 * 60
# How long a status answer is reused (several panes and polls at once).
_STATUS_TTL = 3.0

_LOCK = threading.Lock()
_STATUS: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
# (icao, vol, stamp) -> {slot: [unix of each scan]} for whole volumes.
_REPS: "OrderedDict[tuple, dict]" = OrderedDict()
# Extracted grids of rescans / in-progress cuts: (icao, fam, slot, vol, stamp, rep).
_GRIDS: "OrderedDict[tuple, dict]" = OrderedDict()
_GRIDS_MAX = 160
# Previous volumes' chunk sizes, for "of 10.6 MB": (icao, vol) -> {num: size}.
_PREV_SIZES: "OrderedDict[tuple, dict]" = OrderedDict()


# ---------------------------------------------------------------------------
# The plan, and where each cut sits in the chunk list
# ---------------------------------------------------------------------------

def parse_key(key: str) -> tuple[bool, int, str, int]:
    """``L2P:929:20261019-015131:c2`` -> (partial, vol, stamp, rep)."""
    partial = key.startswith("L2P:")
    m = _REP_RE.search(key)
    rep = int(m.group(1)) if m else 1
    base = key[: m.start()] if m else key
    bits = base.split(":")
    if len(bits) < 3 or bits[0] not in ("L2", "L2P") or not bits[1].isdigit():
        raise RuntimeError(f"Not a live Level II key: {key}")
    return partial, int(bits[1]), bits[2], max(1, rep)


def layout(plan: list[tuple[float, int]]) -> list[tuple[int, int]]:
    """(first chunk number, chunk count) of each cut. Chunk 1 is the start."""
    out = []
    first = 2
    for _, radials in plan:
        n = max(1, radials // 120)
        out.append((first, n))
        first += n
    return out


def flown_plan(plan: list[tuple[float, int]], n_chunks: int) -> list[tuple[float, int]]:
    """The cuts a whole volume actually holds: AVSET ends a volume early when
    nothing is up high, and its chunks then add up to the first cuts only."""
    total = 1
    for k, (_, radials) in enumerate(plan):
        total += max(1, radials // 120)
        if total == n_chunks:
            return plan[: k + 1]
    return plan


def slot_of_cuts(plan: list[tuple[float, int]]) -> list[Optional[str]]:
    """Each cut's tilt slot: the slot whose cut angle is nearest (KBMX flies
    0.40 and 0.48; within 0.1 of both, each belongs to its own)."""
    angles = [a for a, _ in plan]
    slots = l2.slots_for_cuts(sorted(set(angles)))
    out: list[Optional[str]] = []
    for a in angles:
        best = min(slots, key=lambda s: abs(s[1] - a), default=None)
        out.append(best[0] if best is not None and abs(best[1] - a) <= 0.1 else None)
    return out


def slot_runs(plan: list[tuple[float, int]]) -> dict[str, list[list[int]]]:
    """Per slot, its scans: runs of consecutive cuts (indices into the plan).
    A split cut's surveillance + Doppler pair is one run; SAILS adds another
    run of the lowest cut later in the volume."""
    runs: dict[str, list[list[int]]] = {}
    prev: Optional[str] = None
    for i, slot in enumerate(slot_of_cuts(plan)):
        if slot is None:
            prev = None
            continue
        if slot == prev:
            runs[slot][-1].append(i)
        else:
            runs.setdefault(slot, []).append([i])
        prev = slot
    return runs


SURVEILLANCE_FAMS = "BCXPF"   # read from a split cut's first (surveillance) half
DOPPLER_FAMS = "GSW"          # ... from its Doppler half


def cut_for(run: list[int], fam: str) -> tuple[list[int], str]:
    """The cuts of a run (one scan of a tilt) that carry moment family `fam`,
    and every family those cuts answer for. A split cut is two: surveillance
    then Doppler; anything else is read whole."""
    if len(run) >= 2:
        if fam in SURVEILLANCE_FAMS:
            return run[:1], SURVEILLANCE_FAMS
        if fam in DOPPLER_FAMS:
            return run[1:], DOPPLER_FAMS
    return run, "".join(l2.L2_MOMENTS)


def run_chunks(run: list[int], lay: list[tuple[int, int]]) -> list[int]:
    return [n for i in run for n in range(lay[i][0], lay[i][0] + lay[i][1])]


def _iso_unix(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _chunk_unix(icao: str, vol: int, stamp: str, ch: list[tuple[str, int]]) -> dict[int, float]:
    """When each chunk landed, by number (from the listings' LastModified)."""
    out: dict[int, float] = {}
    for k, _ in ch:
        t = _iso_unix(l2._CHUNK_TIMES.get(k))  # noqa: SLF001
        if t is not None:
            out[l2._chunk_num(k)] = t  # noqa: SLF001
    return out


def run_times(runs: list[list[int]], lay: list[tuple[int, int]], landed: dict[int, float],
              start_unix: float, n_planned_chunks: int) -> list[float]:
    """When each scan of a tilt began, on the volume's clock: the first is the
    volume's own time (what every whole-volume frame is labelled with), a later
    one that plus how long after the first scan's first chunk its own first
    chunk landed -- both chunks a sixth of a rotation in, with the same upload
    lag. Without landing times, the share of the volume's chunks between them
    of ~5 min."""
    out = []
    first0 = lay[runs[0][0]][0] if runs else 2
    head = landed.get(first0)
    for k, run in enumerate(runs):
        first = lay[run[0]][0]
        if k == 0:
            out.append(float(start_unix))
            continue
        t = landed.get(first)
        if head is not None and t is not None:
            out.append(float(start_unix) + max(0.0, t - head))
        else:
            out.append(float(start_unix) + 300.0 * (first - first0) / max(1, n_planned_chunks))
    return out


# ---------------------------------------------------------------------------
# Whole volumes: the tilts flown more than once
# ---------------------------------------------------------------------------

def reps_for(site: str, vol: int) -> dict[str, list[int]]:
    """{slot: [unix of each scan]} for the slots a whole live volume flies
    more than once. {} when none (or when it cannot be read)."""
    icao = icao_for(site_id(site))
    try:
        ch = l2._volume_chunks(icao, vol)  # noqa: SLF001
        stamp = l2._stamp(ch)  # noqa: SLF001
    except Exception:  # noqa: BLE001 - a volume gone from the bucket has none
        return {}
    ck = (icao, vol, stamp)
    with _LOCK:
        hit = _REPS.get(ck)
    if hit is not None:
        return hit
    try:
        plan = l2._volume_plan(icao, vol, stamp, ch)  # noqa: SLF001
    except Exception:  # noqa: BLE001
        return {}
    planned_chunks = 1 + sum(n for _, n in layout(plan))
    if l2._whole(ch):  # noqa: SLF001
        plan = flown_plan(plan, len(ch))
    lay = layout(plan)
    landed = _chunk_unix(icao, vol, stamp, ch)
    out: dict[str, list[int]] = {}
    for slot, runs in slot_runs(plan).items():
        if len(runs) > 1:
            out[slot] = [int(round(t)) for t in run_times(runs, lay, landed, l2._stamp_unix(stamp),  # noqa: SLF001
                                                              planned_chunks)]
    with _LOCK:
        _REPS[ck] = out
        while len(_REPS) > 600:
            _REPS.popitem(last=False)
    return out


# ---------------------------------------------------------------------------
# The volume being written
# ---------------------------------------------------------------------------

def _current_vol(icao: str) -> Optional[int]:
    """The directory being written now: the last one found, or the one after
    it once that has started (each poll walks forward at most a few)."""
    vol = l2._VOL_HINT.get(icao)  # noqa: SLF001
    if vol is None:
        return l2._newest_vol_num(icao)  # noqa: SLF001
    return vol


def _prev_sizes(icao: str, vol: int) -> dict[int, int]:
    ck = (icao, vol)
    with _LOCK:
        hit = _PREV_SIZES.get(ck)
    if hit is not None:
        return hit
    known = l2._CHUNK_LISTS.get((icao, vol))  # noqa: SLF001
    ch = list(known) if known else l2._chunks_for(icao, vol)  # noqa: SLF001
    out = {l2._chunk_num(k): s for k, s in ch}  # noqa: SLF001
    if ch and l2._whole(ch):  # noqa: SLF001 - only a whole one is worth keeping
        with _LOCK:
            _PREV_SIZES[ck] = out
            while len(_PREV_SIZES) > 64:
                _PREV_SIZES.popitem(last=False)
    return out


def summarize(icao: str, vol: int, ch: list[tuple[str, int]], plan: list[tuple[float, int]],
              prev: dict[int, int], now: float) -> dict:
    """The status of one volume directory (pure: the tests feed it listings)."""
    ch = sorted(ch, key=lambda kv: l2._chunk_num(kv[0]))  # noqa: SLF001
    stamp = l2._stamp(ch)  # noqa: SLF001
    unix = l2._stamp_unix(stamp)  # noqa: SLF001
    have = {l2._chunk_num(k): s for k, s in ch}  # noqa: SLF001
    whole = l2._whole(ch)  # noqa: SLF001
    planned_chunks = 1 + sum(n for _, n in layout(plan))
    if whole:
        plan = flown_plan(plan, len(ch))
    lay = layout(plan)
    slots = slot_of_cuts(plan)
    cuts = []
    done = 0
    for i, ((angle, _), (first, n)) in enumerate(zip(plan, lay)):
        got = sum(1 for c in range(first, first + n) if c in have)
        cuts.append({"angle": round(angle, 2), "slot": slots[i], "got": got, "of": n, "done": got == n})
        if got == n and done == i:
            done = i + 1
    size = sum(have.values())
    if whole:
        expected = size
    else:
        total_chunks = 1 + sum(n for _, n in lay)
        if prev and len(prev) == total_chunks:
            expected = size + sum(s for c, s in prev.items() if c not in have)
        else:
            expected = int(size / max(1, len(have)) * total_chunks)
    landed = _chunk_unix(icao, vol, stamp, ch)
    last = max(landed.values()) if landed else None
    reps: dict[str, list[int]] = {}
    scanned: list[str] = []
    for slot, runs in slot_runs(plan).items():
        whole_runs = [r for r in runs if all(c in have for c in run_chunks(r, lay))]
        if whole_runs:
            scanned.append(slot)
        if len(whole_runs) > 0:
            times = run_times(runs, lay, landed, unix, planned_chunks)
            reps[slot] = [int(round(times[k])) for k, r in enumerate(runs) if r in whole_runs]
    return {
        "site": icao,
        "vol": vol,
        "stamp": stamp,
        "unix": unix,
        "key": f"L2P:{vol}:{stamp}",
        "wholeKey": f"L2:{vol}:{stamp}",
        "complete": whole,
        "cutsPlanned": len(plan),
        "cutsDone": done,
        "cuts": cuts,
        "chunks": len(have),
        "chunksPlanned": 1 + sum(n for _, n in lay),
        "bytes": size,
        "bytesExpected": max(size, expected),
        "lastChunkUnix": last,
        "stale": last is not None and now - last > STALE_S,
        "scanned": scanned,
        "reps": {s: t for s, t in reps.items() if len(t) > 0},
    }


def status(site: str) -> dict:
    """The volume being written at a NEXRAD, now (see the module notes)."""
    icao = icao_for(site_id(site))
    now = time.time()
    with _LOCK:
        hit = _STATUS.get(icao)
    if hit is not None and now - hit[0] < _STATUS_TTL:
        return hit[1]
    vol = _current_vol(icao)
    if vol is None:
        raise RuntimeError(f"No Level II volumes for {icao} in the live feed.")
    ch = l2._chunks_for(icao, vol)  # noqa: SLF001
    # Walk forward while the next directory holds a newer volume.
    for _ in range(4):
        nxt = vol % 999 + 1
        ch2 = l2._chunks_for(icao, nxt)  # noqa: SLF001
        if not ch2 or (ch and l2._stamp(ch2) <= l2._stamp(ch)):  # noqa: SLF001
            break
        vol, ch = nxt, ch2
        l2._VOL_HINT[icao] = vol  # noqa: SLF001
    if not ch:
        raise RuntimeError(f"Level II volume {vol} of {icao} is empty.")
    ch.sort(key=lambda kv: l2._chunk_num(kv[0]))  # noqa: SLF001
    stamp = l2._stamp(ch)  # noqa: SLF001
    plan: list[tuple[float, int]] = []
    if any(l2._chunk_num(k) == 1 for k, _ in ch):  # noqa: SLF001
        plan = l2._volume_plan(icao, vol, stamp, ch)  # noqa: SLF001
    prev_vol = (vol - 2) % 999 + 1
    try:
        prev = _prev_sizes(icao, prev_vol)
    except Exception:  # noqa: BLE001 - only the size estimate needs it
        prev = {}
    out = summarize(icao, vol, ch, plan, prev, now)
    with _LOCK:
        _STATUS[icao] = (time.time(), out)
        while len(_STATUS) > 32:
            _STATUS.popitem(last=False)
    _drop_stale_listing(icao, vol, bool(out["complete"]))
    return out


def _drop_stale_listing(icao: str, vol: int, complete: bool) -> None:
    """The loop's volume list is kept 2 minutes (nexrad_level2._LIST_TTL): a
    volume that has just finished would be missing from the loop that long,
    between the in-progress frame going and its whole frame arriving. When the
    newest whole volume (this one if complete, else the one before it) is not
    the cached list's newest, the list is read again on the next ask."""
    whole = vol if complete else (vol - 2) % 999 + 1
    hit = l2._LIST_CACHE.get(icao)  # noqa: SLF001
    if not hit or not hit[1]:
        return
    try:
        newest = int(hit[1][-1]["vol"])
    except (KeyError, TypeError, ValueError):
        return
    # Not more than every 10 s: a volume that never became whole (the radar
    # restarted mid-scan) would otherwise have the list read on every poll.
    if newest != whole and time.time() - hit[0] > 10:
        l2._LIST_CACHE.pop(icao, None)  # noqa: SLF001


# ---------------------------------------------------------------------------
# Frames
# ---------------------------------------------------------------------------

def _pending(icao: str, site: str, fam: str, slot: str, stamp: str, angle: Optional[float],
             note: str, key: str) -> dict:
    """A frame for a tilt with nothing to show yet. Never cached, never drawn:
    the app shows the previous volume under its note."""
    spec = l2.L2_MOMENTS[fam]
    pid = _KIND_DEFAULT_PALETTE.get(spec["kind"], "REF")
    _, vmin, vmax = get_cmap(pid)
    unix = l2._stamp_unix(stamp)  # noqa: SLF001
    return {
        "az": np.linspace(0, 360, 361, dtype=np.float32),
        "lut": np.full(256, np.nan, dtype=np.float32),
        "codes": np.zeros((360, 1), dtype=np.uint8),
        "meta": {
            "site": icao, "siteLat": 0.0, "siteLon": 0.0,
            "product": f"L2{fam}{slot}", "productLabel": spec["label"], "units": spec["units"],
            "kind": spec["kind"], "family": fam, "tilt": slot,
            "elevation": None, "defaultPalette": pid, "vmin": vmin, "vmax": vmax,
            "nAz": 360, "nGates": 1, "rangeStartKm": 0.0, "gateWidthKm": 460.0, "maxRangeKm": 460.0,
            "validUnix": unix, "scanUnix": unix, "key": key, "source": "level2", "superRes": False,
            "pending": True, "partial": True, "note": note,
            "pendingAngle": round(angle, 1) if angle is not None else None,
        },
    }


def polar(site: str, product: str, key: str) -> dict:
    """A frame of the volume being written, or a later scan of a tilt."""
    site = site_id(site)
    icao = icao_for(site)
    if not product.startswith("L2") or len(product) < 4:
        raise RuntimeError(f"Not a Level II product: {product}")
    fam, slot = product[2], product[3]
    if fam not in l2.L2_MOMENTS or slot not in l2._ELEV:  # noqa: SLF001
        raise RuntimeError(f"Unknown Level II product: {product}")
    partial, vol, stamp, rep = parse_key(key)

    ch = l2._volume_chunks(icao, vol)  # noqa: SLF001
    if l2._stamp(ch) != stamp:  # noqa: SLF001
        raise RuntimeError(f"Level II volume {stamp} of {icao} has left the live feed.")
    whole = l2._whole(ch)  # noqa: SLF001
    plan = l2._volume_plan(icao, vol, stamp, ch)  # noqa: SLF001
    if whole:
        plan = flown_plan(plan, len(ch))
    lay = layout(plan)
    runs = slot_runs(plan).get(slot) or []
    angles = [a for a, _ in plan]
    want = dict(l2.slots_for_cuts(sorted(set(angles)))).get(slot)
    have = {l2._chunk_num(k) for k, _ in ch}  # noqa: SLF001
    nominal = l2._ELEV[slot]  # noqa: SLF001

    if not runs:
        out = _pending(icao, site, fam, slot, stamp, None, f"Not scanned at {nominal}° in this volume", key)
        out["meta"]["pending"] = False  # not coming: the strategy has no such cut
        out["meta"]["elevations"] = l2._ladder(angles)  # noqa: SLF001
        return out
    k = min(rep, len(runs))
    ck = (icao, fam, slot, vol, stamp, k)
    with _LOCK:
        hit = _GRIDS.get(ck)
        if hit is not None:
            _GRIDS.move_to_end(ck)
            return _keyed(hit, key)
    # Only the cut that carries this moment: a split cut's surveillance half
    # (first) holds reflectivity and dual-pol, its Doppler half velocity and
    # width. Waiting for the whole run kept CC hidden for the length of the
    # Doppler cut while the pane said "0.5 deg isn't scanned yet".
    run = runs[k - 1]
    cut_run, fams = cut_for(run, fam)
    nums = run_chunks(cut_run, lay)
    if any(n not in have for n in nums):
        if not partial:
            raise RuntimeError(f"Level II volume {stamp} of {icao} is missing chunks of {nominal}°.")
        shown = want if want is not None else nominal
        out = _pending(icao, site, fam, slot, stamp, shown, f"{shown:.1f}° isn't scanned yet", key)
        out["meta"]["elevations"] = l2._ladder(angles)  # noqa: SLF001
        return out

    raw = b"".join(l2._get_chunks(icao, vol, stamp, ch, [1, *nums]))  # noqa: SLF001
    # The scan's time on the same clock as the loop's list (reps_for).
    when = run_times(runs, lay, _chunk_unix(icao, vol, stamp, ch), l2._stamp_unix(stamp),  # noqa: SLF001
                     1 + sum(n for _, n in lay))[k - 1]
    with l2._DECODE_SEM:  # noqa: SLF001
        with _LOCK:
            hit = _GRIDS.get(ck)
        if hit is not None:
            return _keyed(hit, key)
        f = l2._L2RF(io.BytesIO(raw))  # noqa: SLF001
        l2._VOL_ELEVS[(site, stamp)] = l2._ladder(angles)  # noqa: SLF001
        wanted: Optional[dict] = None
        for other in l2.L2_MOMENTS:
            if other not in fams:
                # Read from half a split cut: the other half's moments (the
                # Doppler half's short-range reflectivity) are not this slot's.
                continue
            grid = l2._extract(f, other, slot, site, stamp, angles)  # noqa: SLF001
            if grid is None:
                continue
            meta = grid["meta"]
            meta["scanUnix"] = meta["validUnix"] = int(math.floor(when))
            meta["rep"] = k
            meta["reps"] = len(runs)
            meta["partial"] = partial and not whole
            with _LOCK:
                _GRIDS[(icao, other, slot, vol, stamp, k)] = grid
                while len(_GRIDS) > _GRIDS_MAX:
                    _GRIDS.popitem(last=False)
            if other == fam:
                wanted = grid
        if wanted is None:
            wanted = l2._not_scanned(f, fam, slot, site, stamp)  # noqa: SLF001
            with _LOCK:
                _GRIDS[ck] = wanted
        del f
    return _keyed(wanted, key)


def _keyed(grid: dict, key: str) -> dict:
    """The cached grid under the key it was asked by (rep 1 of a volume answers
    both its in-progress and its rescan spelling)."""
    if grid["meta"].get("key") == key:
        return grid
    return {**grid, "meta": {**grid["meta"], "key": key}}
