"""
Which products and tilts one radar really has, right now -- checked, not assumed.

A tilt button is shown only when there is something behind it:

  * a Level III product (reflectivity 0.5 is N0B, 0.9 is NAB, ...) counts when
    the radar has published that exact code in step with its newest scan. Found
    by listing just the last couple of hours of each code in the archive -- a
    few kilobytes a request, all of them at once.
  * a Level II tilt counts when the scan strategy the radar is flying right now
    (the VCP, read from the head of its newest volume) has a cut there, flown
    with a waveform that carries that moment: a surveillance sweep has no
    velocity, a Doppler one no dual-pol.

Angles are the ones flown, from the VCP: 0.4 at KBMX where Level III says 0.5.
Cuts that Level III does not publish -- below 0.5, or above 3.1 for
reflectivity and above 1.3 for velocity -- come from Level II, and say so.
"""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import nexrad_core as n3
import nexrad_level2 as n2

_CACHE: dict[str, tuple[float, dict]] = {}
# A radar can change mode between volumes: re-checked after three minutes.
_TTL = 3 * 60
_LOCKS: dict[str, threading.Lock] = {}
# How far a product may trail the radar's newest reflectivity scan and still be
# current. Upper tilts are published minutes after the lowest; a clear-air
# volume is ten minutes; the accumulations update hourly.
_SLOT_LAG = 25 * 60
_FLAT_LAG = 90 * 60
_STALE_S = 2 * 3600


_QUICK: dict[str, tuple[float, dict]] = {}
# Each Level III code's newest scan, as the quick answer listed them: the full
# check that follows it reuses them and only reads the Level II volume.
_L3_NEWEST: dict[str, tuple[float, dict[str, Optional[int]]]] = {}
_L3_REUSE_S = 90


def site_availability(site: str, quick: bool = False, at: Optional[int] = None) -> dict[str, Any]:
    """`quick` answers from Level III alone, in well under a second, with
    `level2Pending` set: finding a radar's newest Level II volume and reading
    how far it got is two to five seconds the first time, and the Level III
    tilts need not wait for it.

    `at` (unix seconds) is archive playback: what the radar had then. KIND in
    clear air today stops at 6.4 deg; on July 27th it was in a storm mode
    going to 19.5, and the tilt list has to be that day's."""
    sid = n3.site_id(site)
    ck = sid if at is None else f"{sid}@{at}"
    # The past does not change; only the last few hours are still filling in.
    ttl = _TTL if at is None or time.time() - at < _STALE_S + 3600 else 3600
    hit = _CACHE.get(ck)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    if quick:
        got = _QUICK.get(ck)
        if got and time.time() - got[0] < ttl:
            return got[1]
        out = _check(sid, with_level2=False, at=at, ck=ck)
        _QUICK[ck] = (time.time(), out)
        return out
    lock = _LOCKS.setdefault(ck, threading.Lock())
    with lock:
        hit = _CACHE.get(ck)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        out = _check(sid, at=at, ck=ck)
        _CACHE[ck] = (time.time(), out)
        return out


def _newest(sid: str, code: str, since: datetime, until: Optional[datetime] = None) -> Optional[int]:
    """The newest scan of a code after `since` -- and no later than `until`."""
    end = until or datetime.now(timezone.utc)
    after = f"{sid}_{code}_{since:%Y_%m_%d_%H_%M_%S}"
    for day in sorted({end.date(), since.date()}, reverse=True):
        r = n3._PROBE_SESSION.get(  # noqa: SLF001
            n3.S3, params={"list-type": "2", "prefix": f"{sid}_{code}_{day:%Y_%m_%d}", "start-after": after},
            timeout=(8, 20),
        )
        keys = re.findall(r"<Key>([^<]+)</Key>", r.text)
        if until is not None:
            keys = [k for k in keys if (n3.key_time(k) or 0) <= end.timestamp()]
        if keys:
            return n3.key_time(keys[-1])
    return None


def _check(sid: str, with_level2: bool = True, at: Optional[int] = None, ck: str = "") -> dict[str, Any]:
    catalog = n2.merged_catalog(n3.product_catalog())

    l3_codes = sorted({n3._SRV_SOURCE.get(t["code"], t["code"])  # noqa: SLF001
                       for fam in catalog if fam.get("source") != "level2" for t in fam["tilts"]} | {"N0B"})
    # Now, or the moment archive playback starts: the two hours before it, and
    # the first minutes of the loop that runs on from it.
    anchor = datetime.fromtimestamp(at, timezone.utc) if at is not None else None
    since = (anchor or datetime.now(timezone.utc)) - timedelta(hours=2)
    until = anchor + timedelta(minutes=20) if anchor is not None else None
    when = at if at is not None else time.time()

    def vcp() -> Optional[dict]:
        try:
            return n2.site_cuts(sid, at)
        except Exception:  # noqa: BLE001 - no Level II: only Level III tilts
            return None

    listed = _L3_NEWEST.get(ck)
    with ThreadPoolExecutor(16) as pool:
        cuts_job = pool.submit(vcp) if with_level2 else None
        if listed and time.time() - listed[0] < _L3_REUSE_S and set(listed[1]) >= set(l3_codes):
            newest = listed[1]
        else:
            newest = dict(zip(l3_codes, pool.map(lambda c: _newest(sid, c, since, until), l3_codes)))
            now = time.time()
            for k in [k for k, (t, _) in _L3_NEWEST.items() if now - t > _L3_REUSE_S]:
                _L3_NEWEST.pop(k, None)
            _L3_NEWEST[ck] = (now, newest)
        info = cuts_job.result() if cuts_job else None

    ref = newest.get("N0B") or max((v for v in newest.values() if v), default=None)

    def l3_has(code: str) -> bool:
        got = newest.get(code)
        if got is None or ref is None:
            return False
        lag = _FLAT_LAG if n3.PRODUCTS.get(code, {}).get("tilt") is None else _SLOT_LAG
        return got >= ref - lag

    level2 = bool(info) and info.get("volumeUnix") is not None and abs(when - info["volumeUnix"]) < _STALE_S
    slots = n2.slots_for_cuts(info["exact"]) if level2 else []
    by_slot = dict(slots)
    carries: dict[str, str] = {}
    if level2:
        for slot, angle in slots:
            carries[slot] = info["moments"].get(str(angle), "BGWCXPF")

    def l2_tilts(fid: str, moment: str, skip: set[str]) -> list[dict]:
        out = []
        for slot, angle in slots:
            if slot in skip or moment not in carries.get(slot, ""):
                continue
            tilt = {"tilt": slot, "code": f"L2{fid}{slot}", "elev": round(angle, 1), "source": "level2",
                    "superRes": slot in n2.SUPER_RES_SLOTS}
            if slot == "L":
                tilt["lowCut"] = True
            out.append(tilt)
        return out

    families: dict[str, list[dict]] = {}
    for fam in catalog:
        fid = fam["id"]
        if fam.get("source") == "level2":
            moment = fid[2:] if fid.startswith("L2") else fid
            families[fid] = l2_tilts(moment, moment, set())
            continue
        if all(t["tilt"] is None for t in fam["tilts"]):
            code = fam["tilts"][0]["code"]
            families[fid] = [{"tilt": None, "code": code, "elev": None, "source": "level3"}] if l3_has(code) else []
            continue
        tilts = []
        for t in fam["tilts"]:
            src = n3._SRV_SOURCE.get(t["code"], t["code"])  # noqa: SLF001
            if not l3_has(src):
                continue
            angle = by_slot.get(t["tilt"])
            tilts.append({"tilt": t["tilt"], "code": t["code"], "source": "level3",
                          "elev": round(angle, 1) if angle is not None else t["elev"]})
        if fid in n2.L2_MOMENTS and tilts:
            # Storm-relative velocity is made from velocity, so it needs velocity's cuts.
            moment = "G" if fid == "S" else fid
            tilts += l2_tilts(fid, moment, {t["tilt"] for t in tilts})
        tilts.sort(key=lambda t: t["elev"] if t["elev"] is not None else 0)
        families[fid] = tilts

    return {
        "site": n3.icao_for(sid),
        "live": ref is not None and abs(when - ref) < _STALE_S,
        "at": at,
        "newestScan": ref,
        "volumeUnix": info.get("volumeUnix") if info else None,
        "cuts": [round(a, 1) for a in info["exact"]] if info else [],
        "families": families,
        "level2": level2,
        "level2Pending": not with_level2,
        "checkedAt": int(time.time()),
    }
