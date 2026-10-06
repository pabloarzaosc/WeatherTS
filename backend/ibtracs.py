"""IBTrACS v04r01 read in pieces: one storm, or one year of storms, out of the
whole world's record (1842 on, every basin) without downloading its 330 MB.

The ALL file is sorted by storm id -- the SID is the year, the day of the year,
the hemisphere and a position (2005236N23285 is Katrina) -- and NCEI serves
byte ranges, so a binary search over small range reads finds where any storm
or year starts in a dozen reads. Each read's position is remembered for as long
as the file is the same, so the searches after the first are shorter still.

Winds are the US agencies' one-minute winds (NHC, CPHC, JTWC) when there are
any, as in the decks and HURDAT2; ACE follows scripts/build-tropical-climo.py,
so a storm's total here matches the record the Climatology tab shows.
"""
from __future__ import annotations

import bisect
import csv
import io
import json
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests

URL = (
    "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.ALL.list.v04r01.csv"
)
CACHE = Path(tempfile.gettempdir()) / "weatherts-tropical" / "ibtracs"
# Bumped when the cached shape changes, so old files are passed over.
_V = 3

_S = requests.Session()
_S.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_LOCK = threading.Lock()
_SEARCH = threading.Lock()

# What the file is right now (size, Last-Modified), when that was checked, and
# where rows were found in it: offset -> SID, sorted offsets alongside.
_state: dict[str, Any] = {"checked": 0.0, "size": 0, "stamp": "", "head": [], "data": 0}
_known: dict[int, str] = {}
_offsets: list[int] = []

# IBTrACS basin -> the app's basins.
BASINS = {"NA": "al", "EP": "ep", "WP": "wp", "NI": "io", "SI": "sh", "SP": "sh", "SA": "sl"}
SUFFIX = {"al": "L", "ep": "E", "cp": "C", "wp": "W", "io": "A", "sh": "S", "sl": "Q"}
CATEGORIES = ((137, "C5"), (113, "C4"), (96, "C3"), (83, "C2"), (64, "C1"), (34, "TS"), (0, "TD"))
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _ms(t: datetime) -> int:
    return int((t - _EPOCH) / timedelta(milliseconds=1))


def category(v: Optional[float]) -> str:
    v = v if v and v > 0 else 0
    return next(name for floor, name in CATEGORIES if v >= floor)


def _range(a: int, b: int, tries: int = 3) -> bytes:
    last: Optional[Exception] = None
    for attempt in range(tries):
        try:
            r = _S.get(URL, headers={"Range": f"bytes={a}-{b}"}, timeout=(10, 60))
            if r.status_code == 206:
                return r.content
            if r.status_code == 200:
                # A server that ignores ranges: never download the lot by accident.
                r.close()
                raise RuntimeError("IBTrACS ignored the byte range")
            raise requests.HTTPError(f"{r.status_code} for IBTrACS")
        except requests.RequestException as exc:
            last = exc
            time.sleep(0.6 * (attempt + 1))
    raise last if last else RuntimeError("IBTrACS")


def _check() -> None:
    """The file's size and stamp, every hour: a new weekly file moves every
    row after the first change, so what was learned about the old one goes."""
    if time.time() - _state["checked"] < 3600 and _state["size"]:
        return
    r = _S.head(URL, timeout=(10, 30))
    r.raise_for_status()
    size = int(r.headers.get("Content-Length", "0"))
    stamp = r.headers.get("Last-Modified", "")
    with _LOCK:
        if size != _state["size"] or stamp != _state["stamp"]:
            _known.clear()
            _offsets.clear()
            head = _range(0, 8191).decode("utf-8", "replace").split("\n")
            _state.update(size=size, stamp=stamp, head=head[0].strip().split(","),
                          data=len(head[0]) + 1 + len(head[1]) + 1)
        _state["checked"] = time.time()


def _row_at(off: int) -> tuple[int, str]:
    """The first whole row at or after a byte offset: where it starts, its SID."""
    if off <= _state["data"]:
        off = _state["data"]
        chunk = _range(off, off + 63)
        return off, chunk.split(b",", 1)[0].decode()
    chunk = _range(off - 1, off + 4095)
    nl = chunk.find(b"\n")
    if nl < 0 or nl + 14 > len(chunk):
        chunk = _range(off - 1, off + 32767)
        nl = chunk.find(b"\n")
    start = off - 1 + nl + 1
    if start >= _state["size"]:
        return _state["size"], "￿"
    return start, chunk[nl + 1:nl + 14].decode()


def _remember(off: int, sid: str) -> None:
    with _LOCK:
        if off not in _known:
            _known[off] = sid
            bisect.insort(_offsets, off)


def _lower_bound(key: str) -> int:
    """Where the first row whose SID is at or after `key` starts (a SID, or a
    bare year for the first storm of that year)."""
    _check()
    with _LOCK:
        lo, hi = _state["data"], _state["size"]
        # Start from the closest places already seen.
        for off in _offsets:
            if _known[off] < key:
                lo = max(lo, off)
            else:
                hi = min(hi, off)
                break
    while hi - lo > 48 * 1024:
        mid = (lo + hi) // 2
        pos, sid = _row_at(mid)
        _remember(pos, sid)
        if sid < key:
            lo = pos
        else:
            hi = mid
    # The last stretch in one read, row by row.
    chunk = _range(lo, min(_state["size"] - 1, hi + 8192))
    pos = 0
    while pos < len(chunk):
        nl = chunk.find(b"\n", pos)
        if nl < 0:
            break
        if chunk[pos:pos + 13].decode("ascii", "replace") >= key:
            return lo + pos
        pos = nl + 1
    return min(_state["size"], hi + 8192)


def _read_rows(a: int, b: int) -> list[list[str]]:
    if b <= a:
        return []
    text = _range(a, b - 1).decode("utf-8", "replace")
    return [r for r in csv.reader(io.StringIO(text)) if len(r) > 20]


def _num(s: str) -> Optional[float]:
    s = s.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


_NATURE_TYPE = {"TS": "TS", "SS": "SS", "ET": "EX", "DS": "DB", "MX": "EX", "NR": "NR"}


def _storms(rows: list[list[str]]) -> list[dict[str, Any]]:
    """Rows -> storms in the shape tropical.track() returns."""
    h = {k: i for i, k in enumerate(_state["head"])}
    col = lambda r, k: r[h[k]] if k in h and h[k] < len(r) else ""  # noqa: E731
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        if col(r, "TRACK_TYPE").startswith("spur"):
            continue
        sid = r[0]
        t = datetime.strptime(col(r, "ISO_TIME"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        lat, lon = _num(col(r, "LAT")), _num(col(r, "LON"))
        if lat is None or lon is None:
            continue
        if lon > 180:
            lon -= 360
        s = out.get(sid)
        if s is None:
            s = out[sid] = {
                "id": sid, "sid": sid, "atcf": "", "season": int(col(r, "SEASON") or t.year), "name": "",
                "basin": BASINS.get(col(r, "BASIN").strip(), ""), "basins": set(), "points": [], "ace": 0.0,
            }
        # The name and the US agencies' number can turn up a few rows in,
        # after the first agencies' early fixes.
        if not s["name"] and name_of(col(r, "NAME")):
            s["name"] = name_of(col(r, "NAME"))
        atcf = col(r, "USA_ATCF_ID").strip().lower()
        if not s["atcf"] and atcf:
            s["atcf"] = atcf
        s["basins"].add(BASINS.get(col(r, "BASIN").strip(), ""))
        if col(r, "SUBBASIN").strip() == "CP":
            s["basins"].add("cp")
        nature = col(r, "NATURE").strip()
        wind = _num(col(r, "USA_WIND"))
        pres = _num(col(r, "USA_PRES")) or _num(col(r, "WMO_PRES"))
        status = col(r, "USA_STATUS").strip()
        radii: dict[str, list[float]] = {}
        for kt in ("34", "50", "64"):
            q = [_num(col(r, f"USA_R{kt}_{d}")) or 0 for d in ("NE", "SE", "SW", "NW")]
            if any(q):
                radii[kt] = q
        p = {
            "t": _ms(t), "lat": lat, "lon": lon, "vmax": wind if wind is None else round(wind),
            "mslp": pres if pres and pres > 800 else None,
            "type": status or _NATURE_TYPE.get(nature, nature),
            "radii": radii, "rmw": _num(col(r, "USA_RMW")), "roci": _num(col(r, "USA_ROCI")),
            "poci": _num(col(r, "USA_POCI")), "dir": _num(col(r, "STORM_DIR")), "speed": _num(col(r, "STORM_SPEED")),
            "cat": category(wind),
        }
        # A landfall: over land now, over water at the row before.
        land = _num(col(r, "DIST2LAND"))
        p["landfall"] = land == 0 and (s.get("_land") or 0) > 0
        s["_land"] = land
        s["points"].append(p)
        if wind is not None and wind >= 34 and nature in ("TS", "SS") and t.minute == 0 and t.hour % 6 == 0:
            s["ace"] += wind * wind / 1e4
    result = []
    for s in out.values():
        s.pop("_land", None)
        _fill(s["points"], "vmax", 0)
        _fill(s["points"], "mslp", 1)
        for p in s["points"]:
            p["cat"] = category(p["vmax"])
        s["basins"] = sorted(b for b in s["basins"] if b)
        s["ace"] = round(s["ace"], 2)
        # The agencies' number (12L, 19W) when it belongs to this basin's
        # numbering; South Atlantic oddities like Catarina's AL50 do not.
        a = s["atcf"]
        same = a[:2] == s["basin"] or (a[:2] == "cp" and s["basin"] == "ep")
        s["code"] = f"{a[2:4]}{SUFFIX[a[:2]]}" if same and a[2:4].isdigit() and a[:2] in SUFFIX else ""
        if not s["name"]:
            s["name"] = f"Depression {s['code']}" if s["code"] and int(s["code"][:2]) < 50 else "Unnamed"
        result.append(s)
    return result


def name_of(raw: str) -> str:
    name = raw.strip().title()
    return "" if name in ("Not_Named", "Unnamed", "Nameless", "") else name


def _fill(points: list[dict[str, Any]], key: str, digits: int) -> None:
    """The three-hourly rows between the agencies' six-hourly fixes often have
    no wind or pressure of their own (old seasons especially): drawn as they
    are, a typhoon's track turns depression-blue every other segment. Fill
    them from the fixes either side, never across more than twelve hours and
    never past the first or last fix."""
    known = [i for i, p in enumerate(points) if p[key] is not None]
    for a, b in zip(known, known[1:]):
        ta, tb = points[a]["t"], points[b]["t"]
        if b - a < 2 or tb - ta > 12 * 3_600_000:
            continue
        va, vb = points[a][key], points[b][key]
        for i in range(a + 1, b):
            u = (points[i]["t"] - ta) / (tb - ta)
            points[i][key] = round(va + (vb - va) * u, digits) if digits else round(va + (vb - va) * u)


def _disk_json(name: str, max_age_s: float) -> Optional[Any]:
    path = CACHE / name
    if path.exists() and time.time() - path.stat().st_mtime < max_age_s:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            return None
    return None


def _save_json(name: str, data: Any) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def _age_limit(year: int) -> float:
    """Old years are settled; the last two still get revised every week."""
    return 7 * 86400 if year >= datetime.now(timezone.utc).year - 2 else 180 * 86400


def year_storms(year: int) -> list[dict[str, Any]]:
    """Every storm whose id starts in a year, every basin."""
    name = f"year-{year}.v{_V}.json"
    hit = _disk_json(name, _age_limit(year))
    if hit is not None:
        return hit
    with _SEARCH:
        a = _lower_bound(str(year))
        b = _lower_bound(str(year + 1))
    storms = _storms(_read_rows(a, b))
    _save_json(name, storms)
    return storms


def _storm_rows(a: int, sid: str) -> list[list[str]]:
    """A storm's rows from where it starts, a megabyte at a time (the longest
    storms run to a few hundred kB), whole lines only."""
    rows: list[list[str]] = []
    pos, size = a, _state["size"]
    while pos < size:
        raw = _range(pos, min(size, pos + 1024 * 1024) - 1)
        cut = raw.rfind(b"\n") + 1
        if cut <= 0:
            break
        for r in csv.reader(io.StringIO(raw[:cut].decode("utf-8", "replace"))):
            if len(r) < 20:
                continue
            if r[0] != sid:
                return rows
            rows.append(r)
        pos += cut
    return rows


def storm(sid: str) -> Optional[dict[str, Any]]:
    """One storm by its IBTrACS SID: from its year when that is on disk,
    otherwise from its own rows alone (a storm is far less than a year)."""
    year = int(sid[:4])
    hit = _disk_json(f"year-{year}.v{_V}.json", _age_limit(year))
    if hit is not None:
        return next((s for s in hit if s["sid"] == sid), None)
    name = f"storm-{sid}.v{_V}.json"
    one = _disk_json(name, _age_limit(year))
    if one is not None:
        return one
    with _SEARCH:
        a = _lower_bound(sid)
    storms = _storms(_storm_rows(a, sid))
    if not storms:
        return None
    _save_json(name, storms[0])
    return storms[0]


def season(basin: str, year: int) -> list[dict[str, Any]]:
    """A season's storms in one of the app's basins. A Southern Hemisphere
    season runs July to June and is named for the year it ends in, so it
    starts in the ids of the year before."""
    years = [year - 1, year] if basin == "sh" else [year]
    out = []
    for y in years:
        for s in year_storms(y):
            if s["season"] == year and basin in s["basins"]:
                out.append(s)
    out.sort(key=lambda s: s["points"][0]["t"] if s["points"] else 0)
    return out
