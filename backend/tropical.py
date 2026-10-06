"""Tropical cyclones, worldwide: the storms that are up now, their tracks and
guidance, whole seasons, the record, Hurricane Hunter flights and the ocean
and climate indices behind it all.

Where each piece comes from, and why it goes through the backend:
- NHC's own list of the storms it is advising on (CurrentStorms.json) and its
  best-track and guidance decks (ftp.nhc.noaa.gov/atcf). No CORS headers.
- Every other basin -- JTWC's West Pacific, Indian Ocean and Southern
  Hemisphere -- from UCAR RAL's mirror of the ATCF decks, which carries the
  invests too, for this year and back to 2011. No CORS headers.
- HURDAT2, NHC's reanalysed record for the Atlantic (1851-) and the Northeast
  and Central Pacific (1949-), for seasons before UCAR's mirror starts.
- IBTrACS for everything older elsewhere: any storm or season since 1842 in
  any basin, read a piece at a time (backend/ibtracs.py).
- The Hurricane Hunters' high-density observations (HDOBs, a line every 30 s)
  from NHC's recon archive, 1989 on.
- CPC's and PSL's ENSO indices.

Everything that a browser can read for itself (NHC's GIS MapServer, the NWS
text products, STAR's satellite loops, GIBS sea surface temperature) is read
by the frontend directly and never passes through here.
"""
from __future__ import annotations

import json
import math
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests

import atcf
import ibtracs

NHC = "https://www.nhc.noaa.gov"
NHC_BTK = "https://ftp.nhc.noaa.gov/atcf/btk/"
NHC_AID = "https://ftp.nhc.noaa.gov/atcf/aid_public/"
UCAR = "https://hurricanes.ral.ucar.edu/repository/data/"
CACHE = Path(tempfile.gettempdir()) / "weatherts-tropical"

_S = requests.Session()
_S.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_LOCK = threading.Lock()
_MEM: dict[str, tuple[float, Any]] = {}
_POOL = ThreadPoolExecutor(max_workers=6)

# NHC's basins go to NHC; the rest are JTWC's.
NHC_BASINS = ("al", "ep", "cp")
BASIN_NAMES = {
    "al": "Atlantic", "ep": "East Pacific", "cp": "Central Pacific", "wp": "West Pacific",
    "io": "North Indian", "sh": "Southern Hemisphere", "sl": "South Atlantic",
}
# Saffir-Simpson by the maximum one-minute wind, kt.
CATEGORIES = ((137, "C5"), (113, "C4"), (96, "C3"), (83, "C2"), (64, "C1"), (34, "TS"), (0, "TD"))
# The system types that count toward ACE: tropical and subtropical storms and
# stronger (ATCF's TY/ST are typhoons and super typhoons, TC an unspecified TC).
ACE_TYPES = {"TS", "HU", "TY", "ST", "TC", "SS",
             # JTWC's decks as UCAR mirrors them mark every fix XX (unknown):
             # their storms are tropical unless a fix says otherwise.
             "XX"}


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _dt(ms: float) -> datetime:
    """A UTC datetime from epoch ms. Windows' fromtimestamp() refuses times
    before 1970, and HURDAT2 starts in 1851."""
    return _EPOCH + timedelta(milliseconds=ms)


def _ms(t: datetime) -> int:
    return int((t - _EPOCH) / timedelta(milliseconds=1))


# The letter after a storm's number: 09L, 18E, 26W, 01A ...
SUFFIX = {"al": "L", "ep": "E", "cp": "C", "wp": "W", "io": "A", "sh": "S", "sl": "Q"}


def category(vmax: Optional[float]) -> str:
    # HURDAT2 writes an unknown early wind as -99.
    v = vmax if vmax and vmax > 0 else 0
    return next(name for floor, name in CATEGORIES if v >= floor)


# ---------------------------------------------------------------- fetching


def _fetch(url: str, *, ttl: float, binary: bool = False, headers: Optional[dict] = None, tries: int = 3) -> Any:
    """GET with a memory cache; a failure keeps serving the last good copy."""
    key = url + (json.dumps(headers, sort_keys=True) if headers else "")
    now = time.time()
    with _LOCK:
        hit = _MEM.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    last: Optional[Exception] = None
    for attempt in range(tries):
        try:
            r = _S.get(url, timeout=(10, 60), headers=headers)
            if r.status_code == 404:
                body: Any = None
            else:
                if r.status_code >= 400:
                    raise requests.HTTPError(f"{r.status_code} for {url}")
                body = r.content if binary else r.text
            with _LOCK:
                _MEM[key] = (now, body)
            return body
        except requests.RequestException as exc:
            last = exc
            time.sleep(0.7 * (attempt + 1))
    if hit:
        return hit[1]
    raise last if last else RuntimeError(url)


def _disk(name: str, url: str, max_age_s: float) -> Optional[str]:
    """A file kept on disk for a while: HURDAT2, past seasons' decks, recon
    messages -- things that do not change, or change once a year."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.exists() and time.time() - path.stat().st_mtime < max_age_s:
        return path.read_text(encoding="latin-1")
    try:
        text = _fetch(url, ttl=60)
    except Exception:  # noqa: BLE001
        return path.read_text(encoding="latin-1") if path.exists() else None
    if text is None:
        return None
    tmp = path.with_suffix(".part")
    tmp.write_text(text, encoding="latin-1")
    tmp.replace(path)
    return text


# ---------------------------------------------------------------- decks


def _latlon(lat: str, lon: str) -> Optional[tuple[float, float]]:
    return atcf._latlon(lat, lon)


def _num(s: str) -> Optional[float]:
    s = s.strip()
    try:
        v = float(s)
    except ValueError:
        return None
    return None if v in (-999, 9999) else v


def _rows(text: Optional[str]) -> list[list[str]]:
    if not text:
        return []
    return [[f.strip() for f in line.split(",")] for line in text.splitlines() if line.count(",") > 8]


def _btk_text(sid: str, year: int) -> Optional[str]:
    """A storm's best-track deck: NHC's own for its basins this year, UCAR's
    mirror for everything else and for past years (kept on disk)."""
    this_year = datetime.now(timezone.utc).year
    if year >= this_year:
        # A storm of this season that has not changed in two days is done: its
        # deck goes to disk under its modification time, so a season of thirty
        # storms is not thirty slow downloads every few minutes.
        try:
            stamp = dict(_ucar_listing(year)).get(sid)
        except Exception:  # noqa: BLE001
            stamp = None
        if stamp and datetime.now(timezone.utc) - stamp > timedelta(days=2):
            return _disk(f"b{sid}-{stamp:%Y%m%d%H%M}.dat", f"{UCAR}bdecks_open/{year}/b{sid}.dat", 365 * 86400)
        if sid[:2] in NHC_BASINS:
            text = _fetch(f"{NHC_BTK}b{sid}.dat", ttl=300)
            if text:
                return text
        return _fetch(f"{UCAR}bdecks_open/{year}/b{sid}.dat", ttl=300)
    if year < 2011:
        return None  # UCAR's mirror starts in 2011; track() falls back to HURDAT2
    return _disk(f"b{sid}.dat", f"{UCAR}bdecks_open/{year}/b{sid}.dat", 30 * 86400)


IB_SID = re.compile(r"^\d{7}[NS]\d{5}$")


def _ib_track(s: dict[str, Any]) -> dict[str, Any]:
    return {"id": s["sid"], "name": s["name"], "points": s["points"], "ace": s["ace"],
            "basin": s["basin"], "year": s["season"], "code": s["code"], "source": "IBTrACS"}


def track(sid: str) -> dict[str, Any]:
    """The best track, one point per fix time, with the wind radii merged in
    from the deck's one-row-per-threshold layout. An IBTrACS id (2005236N23285)
    reads that storm out of the world record instead."""
    if IB_SID.match(sid):
        hit = ibtracs.storm(sid)
        if hit is None:
            return {"id": sid, "name": "", "points": [], "ace": 0, "basin": "", "year": int(sid[:4]), "code": "",
                    "source": "IBTrACS"}
        return _ib_track(hit)
    year = int(sid[4:8])
    code = f"{sid[2:4]}{SUFFIX.get(sid[:2], '')}"
    pts: dict[str, dict[str, Any]] = {}
    name = ""
    for row in _rows(_btk_text(sid, year)):
        if len(row) < 11:
            continue
        when = row[2]
        pos = _latlon(row[6], row[7])
        if pos is None or not when.isdigit():
            continue
        p = pts.get(when)
        if p is None:
            t = datetime.strptime(when, "%Y%m%d%H").replace(tzinfo=timezone.utc)
            p = pts[when] = {
                "t": _ms(t), "lat": pos[0], "lon": pos[1],
                "vmax": _num(row[8]), "mslp": _num(row[9]), "type": row[10],
                "radii": {}, "rmw": None, "roci": None, "poci": None, "dir": None, "speed": None,
            }
        rad = row[11] if len(row) > 11 else ""
        if rad in ("34", "50", "64") and len(row) > 16:
            quads = [_num(row[i]) or 0 for i in range(13, 17)]
            if any(quads):
                p["radii"][rad] = quads
        if len(row) > 19:
            p["poci"] = p["poci"] or _num(row[17])
            p["roci"] = p["roci"] or _num(row[18])
            p["rmw"] = p["rmw"] or _num(row[19])
        if len(row) > 26:
            p["dir"] = p["dir"] if p["dir"] is not None else _num(row[25])
            p["speed"] = p["speed"] if p["speed"] is not None else _num(row[26])
        if len(row) > 27 and row[27] and not row[27].upper().startswith(("INVEST", "GENESIS")):
            name = row[27].title()
    points = [pts[k] for k in sorted(pts)]
    if not points and sid[:2] in _HURDAT_FILES:
        # Before UCAR's mirror (2011), or a storm it lacks: HURDAT2 has every
        # Atlantic storm since 1851 and every Northeast Pacific one since 1949.
        hit = next((s for s in _hurdat(sid[:2]) if s["id"] == sid), None)
        if hit:
            pts_h = [dict(p, radii={}, rmw=None, roci=None, poci=None, dir=None, speed=None) for p in hit["points"]]
            return {"id": sid, "name": hit["name"], "points": pts_h, "ace": hit["ace"],
                    "basin": sid[:2], "year": year, "code": code, "source": "HURDAT2"}
    for p in points:
        p["cat"] = category(p["vmax"] or 0)
    return {"id": sid, "name": name or default_name(sid), "points": points, "ace": _ace(points),
            "basin": sid[:2], "year": year, "code": code, "source": "ATCF"}


def default_name(sid: str) -> str:
    """What a system without a name is called: Invest 92L, Depression 27W."""
    n = int(sid[2:4])
    code = f"{n:02d}{SUFFIX.get(sid[:2], sid[0].upper())}"
    return f"Invest {code}" if n >= 90 else f"Depression {code}"


def _ace(points: list[dict[str, Any]]) -> float:
    total = 0.0
    for p in points:
        hour = _dt(p["t"]).hour
        v = p["vmax"] or 0
        if hour % 6 == 0 and v >= 34 and p["type"] in ACE_TYPES:
            total += v * v / 1e4
    return round(total, 2)


# ---------------------------------------------------------------- active storms


def _ucar_listing(year: int) -> list[tuple[str, datetime]]:
    html = _fetch(f"{UCAR}bdecks_open/{year}/", ttl=180) or ""
    out = []
    for sid, stamp in re.findall(r'href="b([a-z]{2}\d{6})\.dat">[^<]*</a></td><td[^>]*>(\d{4}-\d\d-\d\d \d\d:\d\d)', html):
        out.append((sid, datetime.strptime(stamp, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)))
    return out


def _nhc_current() -> list[dict[str, Any]]:
    try:
        j = json.loads(_fetch(f"{NHC}/CurrentStorms.json", ttl=120) or "{}")
    except (ValueError, requests.RequestException):
        return []
    return j.get("activeStorms") or []


_STORMS: list[Any] = [0.0, None, False]  # read at, answer, refreshing


def storms() -> dict[str, Any]:
    """The active list, kept for two minutes; an older one is answered at once
    while a new one is gathered behind it (UCAR's mirror is slow to read)."""
    age = time.time() - _STORMS[0]
    if _STORMS[1] is not None and age < 120:
        return _STORMS[1]
    if _STORMS[1] is not None and age < 3600:
        if not _STORMS[2]:
            _STORMS[2] = True

            def bg() -> None:
                try:
                    _STORMS[1], _STORMS[0] = _gather_storms(), time.time()
                finally:
                    _STORMS[2] = False

            threading.Thread(target=bg, daemon=True).start()
        return _STORMS[1]
    out = _gather_storms()
    _STORMS[0], _STORMS[1] = time.time(), out
    return out


def _gather_storms() -> dict[str, Any]:
    """Every system with a best track updated in the last 30 hours, named
    storms and invests, in every basin; NHC's advisory details on its own."""
    now = datetime.now(timezone.utc)
    years = {now.year} | ({now.year - 1} if now.month == 1 else set()) | ({now.year + 1} if now.month == 12 else set())
    recent: list[str] = []
    for y in sorted(years):
        try:
            for sid, when in _ucar_listing(y):
                if now - when < timedelta(hours=30):
                    recent.append(sid)
        except Exception:  # noqa: BLE001
            continue
    nhc = {s["id"]: s for s in _nhc_current()}
    for sid in nhc:
        if sid not in recent:
            recent.append(sid)

    def one(sid: str) -> Optional[dict[str, Any]]:
        try:
            tr = track(sid)
        except Exception:  # noqa: BLE001
            return None
        if not tr["points"]:
            return None
        last = tr["points"][-1]
        # A deck whose last fix is old is a storm that has gone.
        if now.timestamp() * 1000 - last["t"] > 36 * 3600 * 1000:
            return None
        n = int(sid[2:4])
        info = nhc.get(sid)
        s: dict[str, Any] = {
            "id": sid, "basin": sid[:2], "number": n, "year": int(sid[4:]),
            "name": (info or {}).get("name") or tr["name"],
            "invest": n >= 90, "agency": "NHC" if sid[:2] in NHC_BASINS else "JTWC",
            "lat": last["lat"], "lon": last["lon"], "vmax": last["vmax"], "mslp": last["mslp"],
            "type": last["type"], "cat": last["cat"], "t": last["t"], "dir": last["dir"], "speed": last["speed"],
            "ace": tr["ace"], "first": tr["points"][0]["t"],
            "trail": [[p["lon"], p["lat"]] for p in tr["points"][-24:]],
            "code": f"{n:02d}{SUFFIX.get(sid[:2], '')}",
        }
        if sid[:2] == "cp" or (info and info.get("binNumber", "").startswith("CP")):
            s["agency"] = "CPHC"
        if info:
            s["nhc"] = {
                "bin": info.get("binNumber"), "classification": info.get("classification"),
                "intensity": _num(str(info.get("intensity", ""))), "pressure": _num(str(info.get("pressure", ""))),
                "movementDir": info.get("movementDir"), "movementSpeed": info.get("movementSpeed"),
                "lastUpdate": info.get("lastUpdate"),
                "advisory": (info.get("publicAdvisory") or {}).get("advNum"),
                "graphics": (info.get("forecastGraphics") or {}).get("url"),
                "lat": info.get("latitudeNumeric"), "lon": info.get("longitudeNumeric"),
            }
            if s["nhc"]["intensity"] is not None:
                s["vmax"] = s["nhc"]["intensity"]
            if s["nhc"]["pressure"] is not None:
                s["mslp"] = s["nhc"]["pressure"]
            if s["nhc"]["lat"] is not None:
                s["lat"], s["lon"] = s["nhc"]["lat"], s["nhc"]["lon"]
            s["cat"] = category(s["vmax"] or 0)
        return s

    found = [s for s in _POOL.map(one, recent) if s]
    # A storm that crossed into another agency's basin keeps two decks (15E
    # in the West Pacific is in bep15 and bwp15): the one updated last stays.
    best: dict[str, dict[str, Any]] = {}
    for s in found:
        key = s["name"].upper() if not s["invest"] and not s["name"].startswith("Depression") else s["id"]
        if key not in best or s["t"] > best[key]["t"]:
            best[key] = s
    out = sorted(best.values(), key=lambda s: (s["invest"], -(s["vmax"] or 0)))
    return {"updated": int(now.timestamp() * 1000), "storms": out}


# ---------------------------------------------------------------- guidance

# Track guidance first, then the intensity aids; the official forecast leads both.
TRACK_TECHS = ("OFCL", "JTWC", "TVCN", "CONW", "HCCA", "AVNI", "EMXI", "EGRI", "UKMI", "CMCI", "NVGI",
               "JGSI", "HWFI", "HMNI", "HFAI", "HFBI", "CTCI", "AEMI", "EEMN", "AEMN",
               # what UCAR's open decks hold for JTWC's storms
               "UKM", "CMC", "CEMN", "AC00")
INTENSITY_TECHS = ("OFCL", "JTWC", "IVCN", "ICNW", "HCCA", "SHIP", "DSHP", "LGEM", "RIPA", "HWFI", "HMNI",
                   "HFAI", "HFBI", "CTCI", "AVNI", "EMXI", "AEMI", "CHIP")
_COLOURS = dict(atcf.COLOURS, JTWC="#ffffff", UKM="#3fb8e8", CMC="#c02a5a", CEMN="#e07aa0", AC00="#8fb4ff", CHIP="#36c5a0", CONW="#f2d23c", HCCA="#ffd27a", UKMI="#3fb8e8", JGSI="#a8d070",
                EEMN="#ff9a6a", IVCN="#f2d23c", ICNW="#f2d23c", SHIP="#ff6fa8", DSHP="#d65a9a", LGEM="#a879ff",
                RIPA="#ff5a4f", AEMN="#6c9dff")


def _adeck(sid: str) -> list[list[str]]:
    """The guidance deck. NHC's compressed copy for its storms; UCAR's for the
    rest, read from the end only -- a West Pacific deck is 8 MB by October and
    the newest cycles are its last lines."""
    if sid[:2] in NHC_BASINS:
        try:
            rows = atcf._deck(f"{NHC_AID}a{sid}.dat.gz", True)
            if rows:
                return rows
        except Exception:  # noqa: BLE001
            pass
    url = f"{UCAR}adecks_open/a{sid}.dat"
    body = _fetch(url, ttl=600, binary=True, headers={"Range": "bytes=-2500000"})
    if not body:
        return []
    text = body.decode("latin-1")
    # A ranged read starts mid-line: drop the partial first one.
    if not text.startswith(sid[:2].upper()):
        text = text.split("\n", 1)[-1]
    return _rows(text)


def guidance(sid: str, cycle: Optional[str] = None, which: str = "selected") -> dict[str, Any]:
    rows = _adeck(sid)
    cycles = sorted({r[2] for r in rows if len(r) > 5 and r[2].isdigit()}, reverse=True)
    if not cycles:
        return {"id": sid, "cycle": None, "cycles": [], "models": []}
    # The newest cycle often holds only the early aids; prefer the newest one
    # with the official forecast in it, unless one was asked for.
    pick = cycle if cycle in cycles else None
    if pick is None:
        official = {r[2] for r in rows if len(r) > 5 and r[4] in ("OFCL", "JTWC")}
        pick = next((c for c in cycles[:3] if c in official), None)
    if pick is None:
        # No official forecast in the deck (JTWC's are not in the open decks):
        # the newest cycle the models have filled in, not one with only CARQ.
        counts = {c: len({r[4] for r in rows if len(r) > 5 and r[2] == c}) for c in cycles[:3]}
        pick = max(cycles[:3], key=lambda c: (counts[c] >= 3, counts[c] > 0, c))
    by: dict[str, dict[int, dict[str, Any]]] = {}
    for r in rows:
        if len(r) < 10 or r[2] != pick:
            continue
        tech = r[4]
        if which != "all" and tech not in TRACK_TECHS and tech not in INTENSITY_TECHS:
            continue
        if not r[5].lstrip("-").isdigit():
            continue
        tau = int(r[5])
        if tau < 0:
            continue
        pos = _latlon(r[6], r[7])
        pt = by.setdefault(tech, {}).setdefault(tau, {"tau": tau, "lat": None, "lon": None, "vmax": None, "mslp": None})
        if pos and not (pos[0] == 0 and pos[1] == 0):
            pt["lat"], pt["lon"] = pos
        v = _num(r[8])
        if v is not None and v > 0:
            pt["vmax"] = v
        p = _num(r[9])
        if p is not None and p > 0:
            pt["mslp"] = p
    t0 = datetime.strptime(pick, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    models = []
    order = [t for t in TRACK_TECHS + INTENSITY_TECHS if t in by]
    order = list(dict.fromkeys(order + sorted(t for t in by if t not in order)))
    for tech in order:
        pts = [by[tech][k] for k in sorted(by[tech])]
        has_track = sum(1 for p in pts if p["lat"] is not None) >= 2
        has_int = sum(1 for p in pts if p["vmax"] is not None) >= 2
        if not has_track and not has_int:
            continue
        for p in pts:
            p["t"] = _ms(t0 + timedelta(hours=p["tau"]))
        models.append({
            "tech": tech, "colour": _COLOURS.get(tech) or atcf._colour(tech),
            "official": tech in ("OFCL", "JTWC"), "track": has_track and (which == "all" or tech in TRACK_TECHS),
            "intensity": has_int and (which == "all" or tech in INTENSITY_TECHS), "points": pts,
        })
    if sid[:2] not in NHC_BASINS:
        jt = jtwc_forecast(sid)
        if jt:
            models.insert(0, jt)
    return {"id": sid, "cycle": _ms(t0), "cycles": cycles[:8], "models": models}


def jtwc_forecast(sid: str) -> Optional[dict[str, Any]]:
    """JTWC's own forecast, read from its warning text (wp2626web.txt): the
    warning position and each forecast position with its wind."""
    basin, num, year = sid[:2], sid[2:4], sid[6:8]
    try:
        text = _fetch(f"https://www.metoc.navy.mil/jtwc/products/{basin}{num}{year}web.txt", ttl=600)
    except Exception:  # noqa: BLE001
        return None
    if not text or "WARNING" not in text:
        return None
    now = datetime.now(timezone.utc)
    pts = []
    pat = (r"(\d{2})(\d{2})(\d{2})Z\s+---\s+(?:NEAR\s+)?(\d+\.\d)([NS])\s+(\d+\.\d)([EW])"
           r"(.*?)MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT")
    for m in re.finditer(pat, text, re.S):
        day, hh, mm = int(m.group(1)), int(m.group(2)), int(m.group(3))
        best = None
        # The text gives the day of the month only: the month that puts it
        # nearest to now.
        for shift in (-1, 0, 1):
            y, mo = now.year, now.month + shift
            if mo == 0:
                y, mo = y - 1, 12
            if mo == 13:
                y, mo = y + 1, 1
            try:
                cand = datetime(y, mo, day, hh, mm, tzinfo=timezone.utc)
            except ValueError:
                continue
            if best is None or abs(cand - now) < abs(best - now):
                best = cand
        if best is None:
            continue
        lat = float(m.group(4)) * (1 if m.group(5) == "N" else -1)
        lon = float(m.group(6)) * (1 if m.group(7) == "E" else -1)
        pts.append({"t": _ms(best), "lat": lat, "lon": lon, "vmax": float(m.group(9)), "mslp": None})
    if len(pts) < 2:
        return None
    t0 = pts[0]["t"]
    seen = set()
    out = []
    for p in pts:
        if p["t"] in seen:
            continue
        seen.add(p["t"])
        p["tau"] = int(round((p["t"] - t0) / 3600000))
        out.append(p)
    return {"tech": "JTWC", "colour": "#ffffff", "official": True, "track": True, "intensity": True, "points": out}


# ---------------------------------------------------------------- seasons

_HURDAT_FILES = {"al": r"hurdat2-1851-\d{4}-\d+\.txt", "ep": r"hurdat2-nepac-1949-\d{4}-\d+\.txt"}


def _hurdat(basin: str) -> list[dict[str, Any]]:
    """HURDAT2, parsed: every storm with its six-hourly fixes. The newest file
    in NHC's directory, kept on disk for a month."""
    key = f"hurdat-{basin}"
    with _LOCK:
        hit = _MEM.get(key)
    if hit and time.time() - hit[0] < 6 * 3600:
        return hit[1]
    listing = _fetch(f"{NHC}/data/hurdat/", ttl=86400) or ""
    names = re.findall(rf'href="({_HURDAT_FILES[basin]})"', listing)

    def stamp(n: str) -> str:
        tail = n.rsplit("-", 1)[-1].split(".")[0]
        # MMDDYY or MMDDYYYY
        return (tail[4:] if len(tail) == 8 else "20" + tail[4:]) + tail[:4]

    names.sort(key=stamp)
    if not names:
        return []
    text = _disk(names[-1], f"{NHC}/data/hurdat/{names[-1]}", 365 * 86400)
    storms_: list[dict[str, Any]] = []
    cur: Optional[dict[str, Any]] = None
    for line in (text or "").splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) >= 3 and re.fullmatch(r"[A-Z]{2}\d{6}", f[0]):
            cur = {"id": f[0].lower(), "name": f[1].title(), "points": []}
            storms_.append(cur)
            continue
        if cur is None or len(f) < 8 or not f[0].isdigit():
            continue
        t = datetime.strptime(f[0] + f[1].zfill(4), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        lat = float(f[4][:-1]) * (1 if f[4].endswith("N") else -1)
        lon = float(f[5][:-1]) * (-1 if f[5].endswith("W") else 1)
        cur["points"].append({
            "t": _ms(t), "lat": lat, "lon": lon, "vmax": _num(f[6]), "mslp": _num(f[7]),
            "type": f[3], "landfall": f[2] == "L",
        })
    for s in storms_:
        for p in s["points"]:
            p["cat"] = category(p["vmax"] or 0)
        s["ace"] = _ace(s["points"])
    with _LOCK:
        _MEM[key] = (time.time(), storms_)
    return storms_


def _summary(s: dict[str, Any], keep_points: bool) -> dict[str, Any]:
    pts = s["points"]
    peak = max((p["vmax"] or 0 for p in pts), default=0)
    lows = [p["mslp"] for p in pts if p["mslp"]]
    out = {
        "id": s["id"], "name": s["name"], "start": pts[0]["t"] if pts else None, "end": pts[-1]["t"] if pts else None,
        "peak": peak, "minp": min(lows) if lows else None, "cat": category(peak), "ace": s["ace"],
        "landfalls": sum(1 for p in pts if p.get("landfall")),
    }
    if keep_points:
        out["points"] = [[p["t"], p["lat"], p["lon"], p["vmax"], p["mslp"], p["type"]] for p in pts]
    return out


def season(basin: str, year: int, invests: bool = False) -> dict[str, Any]:
    """A whole season in one basin: each storm's summary and track, and ACE
    day by day. UCAR's decks from 2011; HURDAT2 before that (Atlantic and
    East Pacific only)."""
    basin = basin.lower()
    this_year = datetime.now(timezone.utc).year
    storms_: list[dict[str, Any]] = []
    if year >= 2011:
        try:
            sids = [sid for sid, _ in _ucar_listing(year) if sid[:2] == basin]
        except Exception:  # noqa: BLE001
            sids = []
        sids = [s for s in sids if invests or int(s[2:4]) < 80]

        def one(sid: str) -> Optional[dict[str, Any]]:
            try:
                return track(sid)
            except Exception:  # noqa: BLE001
                return None

        storms_ = [s for s in _POOL.map(one, sids) if s and s["points"]]
    source = "ATCF" if storms_ else ""
    if not storms_ and basin in _HURDAT_FILES:
        storms_ = [s for s in _hurdat(basin) if int(s["id"][4:8]) == year]
        source = "HURDAT2" if storms_ else ""
    if not storms_ and basin != "cp" and year < this_year:
        # The West Pacific before 2011, the Indian Ocean, the south: IBTrACS,
        # with its own ids (the Central Pacific's storms are in the East's).
        try:
            storms_ = [dict(s, id=s["sid"]) for s in ibtracs.season(basin, year)]
            source = "IBTrACS" if storms_ else ""
        except Exception:  # noqa: BLE001
            storms_ = []
    if basin == "ep" and year >= 2011:
        # The Central Pacific's storms belong to the same season and map.
        try:
            cps = [sid for sid, _ in _ucar_listing(year) if sid[:2] == "cp" and (invests or int(sid[2:4]) < 80)]
            storms_ += [s for s in _POOL.map(lambda x: track(x), cps) if s and s["points"]]
        except Exception:  # noqa: BLE001
            pass
    daily: dict[str, float] = {}
    for s in storms_:
        for p in s["points"]:
            d = _dt(p["t"])
            v = p["vmax"] or 0
            if d.hour % 6 == 0 and v >= 34 and p["type"] in ACE_TYPES:
                k = d.strftime("%Y-%m-%d")
                daily[k] = round(daily.get(k, 0) + v * v / 1e4, 3)
    summaries = sorted((_summary(s, True) for s in storms_), key=lambda s: s["start"] or 0)
    return {
        "basin": basin, "year": year, "storms": summaries, "daily": sorted(daily.items()),
        "ace": round(sum(s["ace"] for s in summaries), 1),
        "named": sum(1 for s in summaries if s["peak"] >= 34),
        "hurricanes": sum(1 for s in summaries if s["peak"] >= 64),
        "majors": sum(1 for s in summaries if s["peak"] >= 96),
        "live": year == this_year,
        "source": source,
    }


def hurdat_tracks(basin: str, year_from: int, year_to: int, min_peak: float = 0) -> dict[str, Any]:
    """Many seasons' tracks at once, for the archive map: thinned to every
    fix at 00/06/12/18 UTC."""
    out = []
    for s in _hurdat(basin):
        y = int(s["id"][4:8])
        if y < year_from or y > year_to:
            continue
        summ = _summary(s, False)
        if summ["peak"] < min_peak:
            continue
        summ["points"] = [[p["t"], p["lat"], p["lon"], p["vmax"]] for p in s["points"]
                          if _dt(p["t"]).hour % 6 == 0]
        out.append(summ)
    return {"basin": basin, "from": year_from, "to": year_to, "storms": out}


def records(basin: str) -> dict[str, Any]:
    """The record book from HURDAT2: strongest, deepest, most ACE, and the
    count of storms forming in each month."""
    all_ = [_summary(s, False) for s in _hurdat(basin)]
    named = [s for s in all_ if s["peak"] >= 34]
    by_month = [0] * 12
    for s in named:
        if s["start"]:
            by_month[_dt(s["start"]).month - 1] += 1
    top = lambda key, rev=True: sorted((s for s in named if s[key] is not None), key=lambda s: s[key], reverse=rev)[:15]  # noqa: E731
    return {"basin": basin, "strongest": top("peak"), "deepest": top("minp", False), "ace": top("ace"),
            "formations": by_month, "years": [int(all_[0]["id"][4:8]), int(all_[-1]["id"][4:8])] if all_ else []}


def density(basin: str, year_from: int, year_to: int, cell: float = 2.0) -> dict[str, Any]:
    """How many named storms passed through each grid cell over the years:
    each storm counted once per cell."""
    counts: dict[tuple[int, int], int] = {}
    n = 0
    for s in _hurdat(basin):
        y = int(s["id"][4:8])
        if y < year_from or y > year_to or max((p["vmax"] or 0 for p in s["points"]), default=0) < 34:
            continue
        n += 1
        seen = set()
        for p in s["points"]:
            if (p["vmax"] or 0) < 34:
                continue
            k = (int((p["lat"] + 90) // cell), int((p["lon"] + 180) // cell))
            seen.add(k)
        for k in seen:
            counts[k] = counts.get(k, 0) + 1
    cells = [[k[0] * cell - 90, k[1] * cell - 180, v] for k, v in counts.items()]
    return {"basin": basin, "cell": cell, "storms": n, "cells": cells}


# ---------------------------------------------------------------- recon

_RECON_PRODUCTS = {"al": ("AHONT1", "REPNT2"), "ep": ("AHOPN1", "REPPN2"), "cp": ("AHOPA1", "REPPN2")}


def _recon_listing(year: int, product: str) -> list[tuple[str, datetime]]:
    url = f"{NHC}/archive/recon/{year}/{product}/"
    html = _fetch(url, ttl=120 if year == datetime.now(timezone.utc).year else 86400) or ""
    out = []
    for name, stamp in re.findall(rf'href="({product}-[A-Z]+\.(\d{{12}})\.txt)"', html):
        out.append((name, datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)))
    return out


def _coord(s: str, deg_digits: int) -> Optional[float]:
    m = re.fullmatch(rf"(\d{{{deg_digits}}})(\d\d)([NSEW])", s)
    if not m:
        return None
    v = int(m.group(1)) + int(m.group(2)) / 60
    return -v if m.group(3) in "SW" else v


def _hdob_val(s: str, scale: float = 1.0, signed: bool = False) -> Optional[float]:
    if not s or "/" in s:
        return None
    try:
        if signed and s[0] in "+-":
            return float(s) / scale
        return float(s) / scale
    except ValueError:
        return None


def _parse_hdob(text: str, day: datetime) -> Optional[dict[str, Any]]:
    """One HDOB message: a header naming the aircraft, mission and storm, then
    up to twenty 30-second observations."""
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    head_i = next((i for i, l in enumerate(lines) if " HDOB " in f" {l} "), None)
    if head_i is None:
        return None
    head = lines[head_i].split()
    try:
        hd = head.index("HDOB")
    except ValueError:
        return None
    aircraft = head[0]
    mission = " ".join(head[1:hd - 0]).strip()
    date = head[hd + 2] if len(head) > hd + 2 else day.strftime("%Y%m%d")
    try:
        base = datetime.strptime(date, "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        base = day.replace(hour=0, minute=0, second=0, microsecond=0)
    obs = []
    for l in lines[head_i + 1:]:
        f = l.split()
        if len(f) < 13 or not re.fullmatch(r"\d{6}", f[0]):
            continue
        hh, mm, ss = int(f[0][:2]), int(f[0][2:4]), int(f[0][4:])
        t = base + timedelta(hours=hh, minutes=mm, seconds=ss)
        # Messages straddling midnight carry the day the mission started.
        if obs and t.timestamp() * 1000 < obs[-1]["t"] - 12 * 3600 * 1000:
            t += timedelta(days=1)
        lat = _coord(f[1], 2)
        lon = _coord(f[2], 3)
        if lat is None or lon is None:
            continue
        # Static pressure in tenths of mb (a leading 0 is +1000), geopotential
        # height in m; the extrapolated surface pressure / D-value with the
        # same 1000 rule; temperatures in tenths of a degree with the sign.
        ps = _hdob_val(f[3], 10)
        if ps is not None and ps < 100:
            ps += 1000
        gph = _hdob_val(f[4])
        xsp = _hdob_val(f[5], 10)
        if xsp is not None:
            xsp = xsp + 1000 if xsp < 100 else xsp
        temp = _hdob_val(f[6], 10, True)
        dew = _hdob_val(f[7], 10, True)
        wind = f[8]
        wdir = _hdob_val(wind[:3]) if len(wind) == 6 else None
        wspd = _hdob_val(wind[3:]) if len(wind) == 6 else None
        peak = _hdob_val(f[9])
        sfmr = _hdob_val(f[10])
        rain = _hdob_val(f[11])
        flags = f[12] if len(f) > 12 else ""
        # NHC's quality flags. First digit: 1 position, 2 height and static
        # pressure (so the extrapolated pressure too), 3 both. Second digit:
        # 1 temperature and dewpoint, 2 flight-level wind, 3 SFMR, 4 = 1+2,
        # 5 = 1+3, 6 = 2+3, 9 all three. Questionable values are dropped.
        if len(flags) == 2:
            if flags[0] in "23":
                xsp = gph = None
            if flags[1] in "1459":
                temp = dew = None
            if flags[1] in "2469":
                wspd = peak = None
            if flags[1] in "3569":
                sfmr = None
        obs.append({
            "t": _ms(t), "lat": lat, "lon": lon, "ps": ps, "gph": gph,
            "xsp": xsp if (xsp is not None and 850 < xsp < 1080) else None,
            "temp": temp, "dew": dew, "wdir": wdir, "wspd": wspd, "peak": peak, "sfmr": sfmr, "rain": rain, "flag": flags,
        })
    if not obs:
        return None
    m = re.search(r"HDOB\s+(\d+)", lines[head_i])
    return {"aircraft": aircraft, "mission": mission, "seq": int(m.group(1)) if m else 0, "obs": obs}


def _recon_file(year: int, product: str, name: str, when: datetime) -> Optional[dict[str, Any]]:
    text = _disk(f"recon-{name}", f"{NHC}/archive/recon/{year}/{product}/{name}", 3650 * 86400)
    return _parse_hdob(text or "", when) if text else None


def recon(basin: str, start: datetime, end: datetime) -> dict[str, Any]:
    """HDOBs between two times, gathered into missions: one flight, its
    track and every 30-second observation."""
    product = _RECON_PRODUCTS.get(basin, ("AHONT1",))[0]
    files: list[tuple[str, datetime, int]] = []
    for year in range(start.year, end.year + 1):
        for name, when in _recon_listing(year, product):
            if start <= when <= end:
                files.append((name, when, year))
    if len(files) > 1500:
        files = files[-1500:]
    parsed = list(_POOL.map(lambda f: _recon_file(f[2], product, f[0], f[1]), files))
    missions: dict[str, dict[str, Any]] = {}
    for msg in parsed:
        if not msg:
            continue
        key = f"{msg['aircraft']}|{msg['mission']}"
        m = missions.setdefault(key, {"id": key, "aircraft": msg["aircraft"], "mission": msg["mission"], "obs": []})
        m["obs"].extend(msg["obs"])
    out = []
    for m in missions.values():
        uniq = {o["t"]: o for o in m["obs"]}
        m["obs"] = [uniq[k] for k in sorted(uniq)]
        if not m["obs"]:
            continue
        m["start"], m["end"] = m["obs"][0]["t"], m["obs"][-1]["t"]
        fl = [o["wspd"] for o in m["obs"] if o["wspd"] is not None]
        sf = [o["sfmr"] for o in m["obs"] if o["sfmr"] is not None]
        xs = [o["xsp"] for o in m["obs"] if o["xsp"] is not None]
        m["maxFl"] = max(fl) if fl else None
        m["maxSfmr"] = max(sf) if sf else None
        m["minXsp"] = min(xs) if xs else None
        # The storm the flight was tasked to is in the mission name
        # ("AF309 0418A HANNA"): the word after the mission number.
        parts = m["mission"].split()
        m["storm"] = parts[-1].title() if parts and not parts[-1].isdigit() else ""
        m["training"] = "TRAIN" in m["mission"].upper()
        out.append(m)
    out.sort(key=lambda m: m["start"])
    return {"basin": basin, "from": int(start.timestamp() * 1000), "to": int(end.timestamp() * 1000), "missions": out}


def recon_years() -> list[int]:
    html = _fetch(f"{NHC}/archive/recon/", ttl=86400) or ""
    return sorted({int(y) for y in re.findall(r'href="(\d{4})/"', html)})


# ---------------------------------------------------------------- climate indices


def enso() -> dict[str, Any]:
    """ONI (3-month Nino 3.4), the weekly Nino region anomalies, MEI v2 and
    the Tropical North Atlantic index."""
    out: dict[str, Any] = {"oni": [], "weekly": [], "mei": [], "tna": []}
    seasons = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"]
    try:
        for line in (_fetch("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt", ttl=21600) or "").splitlines()[1:]:
            f = line.split()
            if len(f) == 4 and f[0] in seasons:
                out["oni"].append([f"{f[1]}-{seasons.index(f[0]) + 1:02d}", float(f[2]), float(f[3])])
    except Exception:  # noqa: BLE001
        pass
    try:
        # Fixed columns: date, then for each of Nino 1+2, 3, 3.4, 4 an SST and its anomaly.
        for line in (_fetch("https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for", ttl=21600) or "").splitlines():
            m = re.match(r"\s*(\d\d)([A-Z]{3})(\d{4})\s+(.*)", line)
            if not m:
                continue
            nums = re.findall(r"-?\d+\.\d", m.group(4))
            if len(nums) < 8:
                continue
            d = datetime.strptime(f"{m.group(1)}{m.group(2).title()}{m.group(3)}", "%d%b%Y")
            out["weekly"].append([d.strftime("%Y-%m-%d"), float(nums[1]), float(nums[3]), float(nums[5]), float(nums[7])])
    except Exception:  # noqa: BLE001
        pass

    def psl_table(url: str) -> list[list[Any]]:
        rows = []
        for line in (_fetch(url, ttl=86400) or "").splitlines():
            f = line.split()
            if len(f) == 13 and f[0].isdigit() and 1850 < int(f[0]) < 2200:
                for i, v in enumerate(f[1:]):
                    x = float(v)
                    if x > -99:
                        rows.append([f"{f[0]}-{i + 1:02d}", x])
        return rows

    try:
        out["mei"] = psl_table("https://psl.noaa.gov/enso/mei/data/meiv2.data")
    except Exception:  # noqa: BLE001
        pass
    try:
        out["tna"] = psl_table("https://psl.noaa.gov/data/correlation/tna.data")
    except Exception:  # noqa: BLE001
        pass
    # The long records: Nino 3.4 from HadISST since 1870, and the Atlantic
    # Multidecadal Oscillation since 1856 (PSL stopped it at the end of 2023).
    try:
        out["nino34long"] = psl_table("https://psl.noaa.gov/data/timeseries/month/data/nino34.long.anom.data")
    except Exception:  # noqa: BLE001
        out["nino34long"] = []
    try:
        out["amo"] = psl_table("https://psl.noaa.gov/data/correlation/amon.us.long.data")
    except Exception:  # noqa: BLE001
        out["amo"] = []
    return out


def mjo() -> dict[str, Any]:
    """The Madden-Julian Oscillation day by day since 1991: PSL's real-time
    OLR MJO index (ROMI), turned to RMM's axes -- RMM1 is ROMI's PC2 and RMM2
    its PC1 reversed -- so the phases read as on the Wheeler-Hendon diagram."""
    rows = []
    for line in (_fetch("https://psl.noaa.gov/mjo/mjoindex/romi.cpcolr.1x.txt", ttl=21600) or "").splitlines():
        f = line.split()
        if len(f) < 7 or not f[0].isdigit():
            continue
        pc1, pc2, amp = float(f[4]), float(f[5]), float(f[6])
        if abs(amp) > 50:
            continue
        r1, r2 = pc2, -pc1
        ang = math.degrees(math.atan2(r2, r1))
        phase = min(8, int((ang + 180) // 45) + 1)
        rows.append([f"{f[0]}-{int(f[1]):02d}-{int(f[2]):02d}", round(r1, 3), round(r2, 3), round(amp, 3), phase])
    return {"source": "PSL ROMI (CPC OLR)", "days": rows}
