"""Live standing of every NEXRAD: is it sending, how late, and if not, why.

Sources:

* ``api.weather.gov/radar/stations?stationType=WSR-88D`` -- one request for
  every radar: ``latency.current`` (seconds), ``latency.levelTwoLastReceivedTime``
  (when the NWS last received Level II from it) and the RDA's own report
  (``rda.properties``: VCP as "R35", ``alarmSummary``, ``status``,
  ``operabilityStatus``, ``mode``).
* ``/radar/stations/{icao}/alarms`` -- the RDA's alarm messages.
* ``/products/types/FTM/locations/{sid}`` -- the forecast office's Free Text
  Message (the radar outage notice). It is filed under the radar's 3-letter
  id, not the office's: FTMGRK is issued by KFWD.
* The app's own sources as a cross-check: a radar the NWS feed calls quiet is
  looked up in Unidata's Level III bucket (its newest N0B) -- a radar whose
  scans still reach the bucket is not down for anyone reading it -- and the
  detail of one radar adds the live Level II chunk feed (level2_live.status).

Classes, from the age of the newest data (``classify``):

  ok       data within 5 min, arriving at most 60 s late     (green)
  late     data within 5 min, arriving more than 60 s late   (orange)
  stale    no data for 5 to 30 min                           (yellow)
  down     no data for more than 30 min                      (red: not selectable)
  unknown  no record, or the feed could not be read           (gray)

``newest_scans(ids)`` answers when each radar's newest 0.5 deg reflectivity
(Level III N0B) came in, for the labels that blink when a radar finishes a
scan. One small listing per radar, starting after the last key seen.
"""

from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter

import tdwr

NWS = "https://api.weather.gov"
# TDWR: the FAA's airport radars, in the same feed under the same fields.
STATIONS = f"{NWS}/radar/stations?stationType=WSR-88D,TDWR"
L3_BUCKET = "https://unidata-nexrad-level3.s3.amazonaws.com/"

FRESH_S = 5 * 60
DOWN_S = 30 * 60
LATE_LATENCY_S = 60.0

_TIMEOUT = (6, 20)
_SESSION = requests.Session()
_SESSION.mount("https://", HTTPAdapter(pool_connections=16, pool_maxsize=16, max_retries=1))
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"

_LOCK = threading.Lock()
# The whole feed: (checked unix, {sid: row}) and whether a refresh is running.
_FEED: dict[str, Any] = {"at": 0.0, "sites": {}, "error": None, "busy": False}
_FEED_TTL = 60.0
# A feed older than this is not shown at all: every radar is "unknown".
_FEED_MAX_AGE = 15 * 60
# sid -> (checked, newest N0B unix or None): the Level III cross-check.
_L3_CHECK: dict[str, tuple[float, Optional[int]]] = {}
_L3_CHECK_TTL = 120.0
_CROSS_CHECK_MAX = 16
# sid -> {"key", "unix", "at"}: the newest N0B for the blinking labels.
_SCANS: dict[str, dict[str, Any]] = {}
_SCANS_TTL = 25.0
# sid -> (checked, detail)
_DETAIL: dict[str, tuple[float, dict]] = {}
_DETAIL_TTL = 60.0

_SID_RE = re.compile(r"^[A-Z]{3}$")
_KEY_RE = re.compile(r"<Key>([^<]+)</Key>")


# ---------------------------------------------------------------------------
# Pure parts (the tests feed them documents)
# ---------------------------------------------------------------------------
def classify(age_s: Optional[float], latency_s: Optional[float]) -> str:
    """The class of a radar from how old its newest data is and how late it arrives."""
    if age_s is None:
        return "unknown"
    if age_s > DOWN_S:
        return "down"
    if age_s > FRESH_S:
        return "stale"
    if latency_s is not None and latency_s > LATE_LATENCY_S:
        return "late"
    return "ok"


def iso_unix(text: Any) -> Optional[float]:
    if not text or not isinstance(text, str):
        return None
    try:
        d = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp()


def vcp_number(text: Any) -> Optional[str]:
    """ "R35" / "R215" / "12" -> "35" / "215" / "12"."""
    m = re.search(r"(\d{1,3})", str(text or ""))
    return m.group(1) if m else None


def _num(obj: Any) -> Optional[float]:
    v = obj.get("value") if isinstance(obj, dict) else obj
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def sid_of(icao: str) -> str:
    """The app's 3-letter id from a 4-letter ICAO: KTLX -> TLX, PABC -> ABC, TJUA -> JUA."""
    s = (icao or "").strip().upper()
    return s[1:] if len(s) == 4 else s


def parse_stations(doc: dict, now: float) -> dict[str, dict]:
    """The NWS radar station feed -> one row per radar, keyed by the 3-letter id."""
    out: dict[str, dict] = {}
    for f in (doc or {}).get("features") or []:
        p = (f or {}).get("properties") or {}
        icao = str(p.get("id") or "").strip().upper()
        if len(icao) != 4:
            continue
        lat = p.get("latency") or {}
        rda_wrap = p.get("rda") or {}
        rda = rda_wrap.get("properties") or {}
        l2 = iso_unix(lat.get("levelTwoLastReceivedTime"))
        latency = _num(lat.get("current"))
        age = None if l2 is None else max(0.0, now - l2)
        out[sid_of(icao)] = {
            "icao": icao,
            "name": p.get("name"),
            "type": p.get("stationType"),
            "l2": None if l2 is None else int(l2),
            "age": None if age is None else int(round(age)),
            "lat": None if latency is None else round(latency, 2),
            "vcp": vcp_number(rda.get("volumeCoveragePattern")),
            "alarm": rda.get("alarmSummary"),
            "rda": rda.get("status"),
            "op": rda.get("operabilityStatus"),
            "mode": rda.get("mode"),
            "rdaAt": None if iso_unix(rda_wrap.get("timestamp")) is None else int(iso_unix(rda_wrap.get("timestamp"))),
            "st": classify(age, latency),
        }
    return out


def apply_cross_check(row: dict, l3_unix: Optional[int], now: float) -> dict:
    """A radar the NWS calls quiet whose scans still reach the Level III bucket
    is classed by the newer of the two."""
    if l3_unix is None:
        return row
    row = {**row, "l3": int(l3_unix)}
    newest = max(row.get("l2") or 0, int(l3_unix))
    if newest > (row.get("l2") or 0):
        age = max(0.0, now - newest)
        row["age"] = int(round(age))
        row["st"] = classify(age, row.get("lat"))
        row["via"] = "level3"
    return row


_SEVERITY = {"inoperative": 0, "mandatory": 1, "required": 2, "secondary": 3}


def active_alarms(graph: list, limit: int = 8) -> list[dict]:
    """The RDA alarms still standing: each message's newest entry decides,
    a "cleared" one drops it. Worst first, then newest."""
    newest: dict[str, dict] = {}
    for a in graph or []:
        msg = str((a or {}).get("message") or "").strip()
        at = iso_unix((a or {}).get("timestamp"))
        if not msg or at is None:
            continue
        held = newest.get(msg)
        if held is None or at > held["at"]:
            newest[msg] = {"message": msg, "status": str(a.get("status") or "").lower(), "at": int(at)}
    standing = [a for a in newest.values() if a["status"] != "cleared"]
    standing.sort(key=lambda a: (_SEVERITY.get(a["status"], 4), -a["at"]))
    return standing[:limit]


_WMO_RE = re.compile(r"^[A-Z]{4}\d{2}\s+[A-Z]{4}\s+\d{6}")
_AWIPS_RE = re.compile(r"^FTM[A-Z0-9]{3}\s*$")


def clean_ftm(text: str) -> str:
    """An FTM product's text without its transmission header, its hard-wrapped
    lines joined into paragraphs (a line cut at 80 columns mid-word is glued)."""
    lines = (text or "").replace("\r", "").split("\n")
    body: list[str] = []
    started = False
    for ln in lines:
        s = ln.rstrip()
        if not started:
            if not s.strip() or s.strip() == "000" or _WMO_RE.match(s.strip()) or _AWIPS_RE.match(s.strip()):
                continue
            started = True
        if s.strip().lower().startswith("message date:"):
            continue
        body.append(ln.rstrip("\n"))
    paras: list[str] = []
    cur = ""
    prev_full = False
    for ln in body:
        raw = ln.replace("\t", " ")
        s = raw.strip()
        if not s:
            if cur:
                paras.append(cur)
            cur, prev_full = "", False
            continue
        if not cur:
            cur = s
        elif prev_full and s[:1].islower():
            cur += s
        else:
            cur += " " + s
        # cut at the 80-column edge with no space at the cut: a word broken in two
        prev_full = len(raw.rstrip()) >= 79 and len(raw) == len(raw.rstrip()) and raw.rstrip()[-1:].isalnum()
    if cur:
        paras.append(cur)
    return "\n\n".join(re.sub(r"\s{2,}", " ", p).strip() for p in paras).strip()


# ---------------------------------------------------------------------------
# The feed
# ---------------------------------------------------------------------------
def _newest_n0b(sid: str, after: Optional[str] = None, back_min: int = 120) -> tuple[Optional[str], Optional[int]]:
    """The newest N0B key of a radar after `after`, else within the last
    `back_min` minutes. S3 lists upwards from the start key, so the search
    widens (40 min, 6 h, then `back_min`) instead of starting far back."""
    from nexrad_core import key_time  # late: nexrad_core is heavy to import in tests
    code = "TZ0" if tdwr.is_tdwr(sid) else "N0B"  # a TDWR's lowest reflectivity
    if after is not None:
        starts = [after]
    else:
        now = datetime.now(timezone.utc)
        spans = sorted({min(40, back_min), min(360, back_min), back_min})
        starts = [f"{sid}_{code}_{now - timedelta(minutes=m):%Y_%m_%d_%H_%M_%S}" for m in spans]
    for start in starts:
        key = None
        params = {"list-type": "2", "prefix": f"{sid}_{code}_", "start-after": start, "max-keys": "1000"}
        for _ in range(3):  # a page holds 1000 keys: a day of SAILS scans fits in one
            r = _SESSION.get(L3_BUCKET, params=params, timeout=_TIMEOUT)
            r.raise_for_status()
            keys = _KEY_RE.findall(r.text)
            if keys:
                key = keys[-1]
            token = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
            if "<IsTruncated>true</IsTruncated>" not in r.text or not token:
                break
            params = {"list-type": "2", "prefix": f"{sid}_{code}_", "continuation-token": token.group(1), "max-keys": "1000"}
        if key:
            return key, key_time(key)
    return None, None


def _l3_check(sid: str) -> Optional[int]:
    now = time.time()
    with _LOCK:
        hit = _L3_CHECK.get(sid)
    if hit and now - hit[0] < _L3_CHECK_TTL:
        return hit[1]
    try:
        _, unix = _newest_n0b(sid, back_min=24 * 60)
    except Exception:  # noqa: BLE001 - says nothing about the radar
        return hit[1] if hit else None
    with _LOCK:
        _L3_CHECK[sid] = (now, unix)
    return unix


def _refresh() -> None:
    try:
        r = _SESSION.get(STATIONS, timeout=_TIMEOUT, headers={"Accept": "application/geo+json"})
        r.raise_for_status()
        now = time.time()
        rows = parse_stations(r.json(), now)
        quiet = [sid for sid, row in rows.items() if row["st"] in ("stale", "down", "unknown") and _SID_RE.match(sid)]
        if quiet:
            with ThreadPoolExecutor(6) as pool:
                found = dict(zip(quiet[:_CROSS_CHECK_MAX], pool.map(_l3_check, quiet[:_CROSS_CHECK_MAX])))
            for sid, unix in found.items():
                rows[sid] = apply_cross_check(rows[sid], unix, now)
        with _LOCK:
            _FEED.update(at=now, sites=rows, error=None)
    except Exception as exc:  # noqa: BLE001 - the last answer stands, marked
        with _LOCK:
            _FEED["error"] = f"{type(exc).__name__}: {exc}"[:200]
    finally:
        with _LOCK:
            _FEED["busy"] = False


def statuses() -> dict:
    """Every radar's class now: {at, age (of the feed), error, sites: {sid: row}}.
    Refreshed behind the answer once a minute; the first call waits for it."""
    with _LOCK:
        now = time.time()
        # since the last answer, or the last try: a feed that is down is asked
        # once a minute, not on every call
        age = now - max(float(_FEED["at"]), float(_FEED.get("tried") or 0))
        empty = not _FEED["sites"]
        start = not _FEED["busy"] and age > _FEED_TTL
        if start:
            _FEED["busy"] = True
            _FEED["tried"] = now
    if start:
        if empty:
            _refresh()
        else:
            threading.Thread(target=_refresh, daemon=True, name="radar-status").start()
    with _LOCK:
        at = float(_FEED["at"])
        sites = _FEED["sites"] if at and time.time() - at < _FEED_MAX_AGE else {}
        return {"at": int(at) if at else None, "now": int(time.time()), "error": _FEED["error"], "sites": sites}


def status_row(sid: str) -> Optional[dict]:
    return statuses()["sites"].get(sid.upper())


# ---------------------------------------------------------------------------
# One radar in full
# ---------------------------------------------------------------------------
def _alarms(icao: str) -> list[dict]:
    r = _SESSION.get(f"{NWS}/radar/stations/{icao}/alarms", timeout=_TIMEOUT, headers={"Accept": "application/ld+json"})
    r.raise_for_status()
    return active_alarms((r.json() or {}).get("@graph") or [])


def _notice(sid: str) -> Optional[dict]:
    r = _SESSION.get(f"{NWS}/products/types/FTM/locations/{sid}", timeout=_TIMEOUT, headers={"Accept": "application/ld+json"})
    r.raise_for_status()
    graph = (r.json() or {}).get("@graph") or []
    graph = sorted(graph, key=lambda g: iso_unix(g.get("issuanceTime")) or 0, reverse=True)
    if not graph:
        return None
    top = graph[0]
    pid = top.get("id")
    if not pid:
        return None
    p = _SESSION.get(f"{NWS}/products/{pid}", timeout=_TIMEOUT, headers={"Accept": "application/ld+json"})
    p.raise_for_status()
    doc = p.json() or {}
    at = iso_unix(doc.get("issuanceTime") or top.get("issuanceTime"))
    return {
        "text": clean_ftm(str(doc.get("productText") or "")),
        "at": None if at is None else int(at),
        "office": str(doc.get("issuingOffice") or top.get("issuingOffice") or "") or None,
        "name": doc.get("productName") or top.get("productName"),
        "count": len(graph),
    }


def _l2_feed(sid: str) -> Optional[dict]:
    import level2_live  # late: pulls numpy and the Level II reader
    st = level2_live.status(sid)
    return {
        "lastChunkUnix": None if st.get("lastChunkUnix") is None else int(st["lastChunkUnix"]),
        "volumeUnix": st.get("unix"),
        "vol": st.get("vol"),
        "complete": bool(st.get("complete")),
        "stale": bool(st.get("stale")),
    }


def site_detail(site: str) -> dict:
    """The standing of one radar with its reasons: the RDA's alarms, the
    office's outage notice, and when its newest Level II chunk and Level III
    scan reached Unidata. Each part that does not answer within 8 s is left out."""
    sid = sid_of(site) if len(site.strip()) == 4 else site.strip().upper()
    if not _SID_RE.match(sid):
        raise ValueError(f"Not a radar id: {site!r}")
    now = time.time()
    with _LOCK:
        hit = _DETAIL.get(sid)
    if hit and now - hit[0] < _DETAIL_TTL:
        return hit[1]
    row = status_row(sid) or {}
    icao = row.get("icao")
    if not icao:
        from nexrad_core import icao_for
        icao = icao_for(sid)
    out: dict[str, Any] = {"id": sid, "icao": icao, **row, "checked": int(now)}
    jobs = {"alarms": (_alarms, icao), "notice": (_notice, sid), "level3": (_l3_check, sid)}
    if not tdwr.is_tdwr(sid):
        jobs["level2"] = (_l2_feed, sid)
    pool = ThreadPoolExecutor(len(jobs))
    futs = {name: pool.submit(fn, arg) for name, (fn, arg) in jobs.items()}
    wait(list(futs.values()), timeout=8.0)
    errors: dict[str, str] = {}
    for name, fut in futs.items():
        if not fut.done():
            errors[name] = "no answer in 8 s"
            continue
        try:
            out[name] = fut.result()
        except Exception as exc:  # noqa: BLE001 - one part missing is not a failure
            errors[name] = f"{type(exc).__name__}"[:80]
    pool.shutdown(wait=False, cancel_futures=True)
    if out.get("level3") is not None and row:
        out.update({k: v for k, v in apply_cross_check(row, out["level3"], now).items() if k in ("age", "st", "via", "l3")})
    out["errors"] = errors
    with _LOCK:
        # a part that did not answer is asked again soon, not in a minute
        _DETAIL[sid] = (now - _DETAIL_TTL + 5.0 if errors else now, out)
        while len(_DETAIL) > 64:
            _DETAIL.pop(next(iter(_DETAIL)))
    return out


# ---------------------------------------------------------------------------
# New scans, for the labels that blink
# ---------------------------------------------------------------------------
def _scan_one(sid: str) -> Optional[int]:
    now = time.time()
    with _LOCK:
        st = dict(_SCANS.get(sid) or {})
    if st and now - st.get("at", 0) < _SCANS_TTL:
        return st.get("unix")
    try:
        key, unix = _newest_n0b(sid, after=st.get("key"), back_min=40)
    except Exception:  # noqa: BLE001 - try again on the next poll
        return st.get("unix")
    if key:
        st.update(key=key, unix=unix)
    st["at"] = now
    with _LOCK:
        _SCANS[sid] = st
    return st.get("unix")


def newest_scans(ids: list[str], limit: int = 60) -> dict[str, Optional[int]]:
    """{sid: unix of its newest N0B} for up to `limit` radars."""
    want = []
    for raw in ids:
        sid = str(raw or "").strip().upper()
        if _SID_RE.match(sid) and sid not in want:
            want.append(sid)
    want = want[:limit]
    if not want:
        return {}
    with ThreadPoolExecutor(min(8, len(want))) as pool:
        return dict(zip(want, pool.map(_scan_one, want)))
