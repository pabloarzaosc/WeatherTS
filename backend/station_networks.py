"""
Weather stations beyond the airports, for the station plots.

The METARs (surface_obs, AWC) are airports only: 18 plots across the south of
Brazil where a dense map shows hundreds. Two open sources fill the rest in:

  * SYNOP, the WMO's synoptic stations -- ~9,500 of them reporting worldwide,
    the national weather services' own sites, many away from any airport.
    Decoded here from the raw messages OGIMET collects (one global request per
    refresh), placed with the NWS copy of the WMO station list.
  * NOAA MADIS's public mesonet feed -- ~36,000 stations an hour: state and
    university mesonets, road weather, RAWS, tide gauges and the citizen
    stations of CWOP/APRS worldwide (32,000 across the US, a few hundred in
    Europe and Brazil). One netCDF file per hour, 32 MB gzipped; MADIS's own
    quality control marks the readings it failed, and those are dropped.

Neither is an airport, so neither has a flight category nor a METAR: the
station page shows what they do have instead (see StationPanel).

INMET's automatic network (520 stations in Brazil) would be the densest source
there, but its data now need a personal token (the public pages sit behind a
reCAPTCHA), so it is not read here.
"""
from __future__ import annotations

import gzip
import io
import math
import re
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import numpy as np
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

_UA = "WeatherTS/1.5 (desktop weather app)"
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = _UA
_SESSION.mount("https://", HTTPAdapter(pool_maxsize=8, max_retries=Retry(
    total=2, connect=2, read=1, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=frozenset(["GET"]))))

CACHE = Path(tempfile.gettempdir()) / "weatherts-obs"
# Four: the live refreshes, and the past hours a scrubbed-back timeline asks for.
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="stations-net")

KT_PER_MS = 1.943844


def _cache_path(*parts: str) -> Path:
    p = CACHE.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------
# WMO station list (for SYNOP positions)
# ---------------------------------------------------------------------------
NSD_URL = "https://tgftp.nws.noaa.gov/data/nsd_bbsss.txt"
_WMO: Optional[dict[str, tuple[float, float, str, str, Optional[float]]]] = None
_WMO_LOCK = threading.Lock()


def _dms(s: str) -> Optional[float]:
    """'65-58-56N' or '70-56N' -> degrees."""
    m = re.fullmatch(r"(\d+)-(\d+)(?:-(\d+))?([NSEW])", s.strip())
    if not m:
        return None
    v = int(m.group(1)) + int(m.group(2)) / 60 + (int(m.group(3)) / 3600 if m.group(3) else 0)
    return -v if m.group(4) in "SW" else v


ISD_URL = "https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv"


def _isd_stations() -> dict[str, tuple[float, float, str, str, Optional[float]]]:
    """WMO stations from NOAA's ISD history: the NWS list misses a third of the
    ids reporting SYNOP today (Canada, Australia, much of Europe). A USAF id is
    the WMO id and a 0; only stations still reporting this year are kept."""
    import csv  # noqa: PLC0415

    path = _cache_path("isd-history.csv")
    text = ""
    if path.exists() and time.time() - path.stat().st_mtime < 30 * 86400:
        text = path.read_text(encoding="latin-1")
    else:
        try:
            r = _SESSION.get(ISD_URL, timeout=(8, 90))
            r.raise_for_status()
            text = r.text
            path.write_text(text, encoding="latin-1")
        except requests.RequestException:
            text = path.read_text(encoding="latin-1") if path.exists() else ""
    out: dict[str, tuple[float, float, str, str, Optional[float]]] = {}
    year = str(datetime.now(timezone.utc).year - 1)
    for row in csv.DictReader(io.StringIO(text)):
        usaf = row.get("USAF", "")
        if len(usaf) != 6 or not usaf.endswith("0") or not usaf[:5].isdigit():
            continue
        if (row.get("END") or "") < year:
            continue
        try:
            lat, lon = float(row["LAT"]), float(row["LON"])
        except (KeyError, ValueError):
            continue
        if abs(lat) < 0.001 and abs(lon) < 0.001:
            continue
        try:
            elev = float(row.get("ELEV(M)") or "")
        except ValueError:
            elev = None
        out[usaf[:5]] = (lat, lon, (row.get("STATION NAME") or "").strip(), (row.get("CTRY") or "").strip(), elev)
    return out


def wmo_stations() -> dict[str, tuple[float, float, str, str, Optional[float]]]:
    """WMO id (5 digits) -> (lat, lon, name, country, elevation m). Kept on disk
    for a month: the list changes a few times a year."""
    global _WMO
    with _WMO_LOCK:
        if _WMO is not None:
            return _WMO
        path = _cache_path("nsd_bbsss.txt")
        text = None
        if path.exists() and time.time() - path.stat().st_mtime < 30 * 86400:
            text = path.read_text(encoding="latin-1")
        if text is None:
            try:
                r = _SESSION.get(NSD_URL, timeout=(8, 60))
                r.raise_for_status()
                text = r.text
                path.write_text(text, encoding="latin-1")
            except requests.RequestException:
                text = path.read_text(encoding="latin-1") if path.exists() else ""
        out: dict[str, tuple[float, float, str, str, Optional[float]]] = _isd_stations()
        for line in text.splitlines():
            f = line.split(";")
            if len(f) < 12:
                continue
            lat, lon = _dms(f[7]), _dms(f[8])
            if lat is None or lon is None:
                continue
            try:
                elev = float(f[11]) if f[11].strip() else None
            except ValueError:
                elev = None
            out[f[0] + f[1]] = (lat, lon, f[3].strip(), f[5].strip(), elev)
        _WMO = out
        return out


# ---------------------------------------------------------------------------
# SYNOP (FM-12) decoding
# ---------------------------------------------------------------------------
_VIS_91 = {90: 0.05, 91: 0.05, 92: 0.2, 93: 0.5, 94: 1, 95: 2, 96: 4, 97: 10, 98: 20, 99: 50}
_PRECIP_HOURS = {"1": 6, "2": 12, "3": 18, "4": 24, "5": 1, "6": 2, "7": 3, "8": 9, "9": 15}
_CLOUD_BASE_M = {"0": 25, "1": 75, "2": 150, "3": 250, "4": 450, "5": 800, "6": 1250, "7": 1750, "8": 2250}


def _vis_km(vv: str) -> Optional[float]:
    if not vv.isdigit():
        return None
    v = int(vv)
    if v <= 50:
        return v / 10
    if 56 <= v <= 80:
        return float(v - 50)
    if 81 <= v <= 88:
        return 30.0 + (v - 80) * 5
    if v == 89:
        return 70.0
    return _VIS_91.get(v)


def _temp(g: str) -> Optional[float]:
    """1sTTT / 2sTTT: tenths of a degree, s = 0 above zero, 1 below."""
    if len(g) != 5 or not g[2:].isdigit() or g[1] not in "01":
        return None
    t = int(g[2:]) / 10
    return -t if g[1] == "1" else t


def _hpa(g: str) -> Optional[float]:
    """3PPPP / 4PPPP: tenths of a hectopascal with the thousands dropped."""
    if not g[1:].isdigit():
        return None
    p = int(g[1:]) / 10
    return p + 1000 if p < 400 else p


def _precip_mm(rrr: str) -> Optional[float]:
    if not rrr.isdigit():
        return None
    v = int(rrr)
    if v == 990:
        return 0.0  # a trace
    if v > 990:
        return (v - 990) / 10
    return float(v)


def _ww_words(ww: int) -> Optional[str]:
    """Present weather code 00-99, in a few words (the ones worth a plot)."""
    if ww < 4:
        return None
    if ww in (4, 5):
        return "Haze" if ww == 5 else "Smoke"
    if ww in (6, 7, 8, 9):
        return "Dust"
    if ww == 10:
        return "Mist"
    if ww in (11, 12, 28, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49):
        return "Fog"
    if ww == 13:
        return "Lightning"
    if ww in (14, 15, 16):
        return "Rain in sight"
    if ww == 17 or ww == 29 or 91 <= ww <= 99:
        return "Thunderstorm"
    if ww == 18:
        return "Squalls"
    if ww == 19:
        return "Funnel cloud"
    if 20 <= ww <= 27:
        return "Recent precipitation"
    if 30 <= ww <= 39:
        return "Dust or snow storm"
    if 50 <= ww <= 59:
        return "Drizzle"
    if 60 <= ww <= 69:
        return "Freezing rain" if ww in (66, 67) else "Rain"
    if 70 <= ww <= 79:
        return "Snow"
    if 80 <= ww <= 84:
        return "Rain showers"
    if 85 <= ww <= 90:
        return "Snow or hail showers"
    return None


def _ww_code(ww: int) -> Optional[str]:
    """Present weather code 00-99 as the METAR letters a plot prints beside the
    station (TSGR, +SHRA...), so a synoptic station reads like an airport."""
    table = {
        4: "FU", 5: "HZ", 6: "DU", 7: "DU", 8: "PO", 9: "SS", 10: "BR", 11: "MIFG", 12: "MIFG", 13: "LTG",
        17: "TS", 18: "SQ", 19: "FC", 30: "DS", 31: "DS", 32: "DS", 33: "+DS", 34: "+DS", 35: "+DS",
        36: "DRSN", 37: "DRSN", 38: "BLSN", 39: "BLSN", 50: "-DZ", 51: "-DZ", 52: "DZ", 53: "DZ", 54: "+DZ",
        55: "+DZ", 56: "-FZDZ", 57: "FZDZ", 58: "-RADZ", 59: "RADZ", 60: "-RA", 61: "-RA", 62: "RA", 63: "RA",
        64: "+RA", 65: "+RA", 66: "-FZRA", 67: "FZRA", 68: "-RASN", 69: "RASN", 70: "-SN", 71: "-SN",
        72: "SN", 73: "SN", 74: "+SN", 75: "+SN", 76: "IC", 77: "SG", 78: "SN", 79: "PL", 80: "-SHRA",
        81: "SHRA", 82: "+SHRA", 83: "-SHRASN", 84: "SHRASN", 85: "-SHSN", 86: "SHSN", 87: "-SHGS",
        88: "SHGS", 89: "-SHGR", 90: "SHGR", 91: "-RA", 92: "RA", 93: "-SN", 94: "SN", 95: "TSRA",
        96: "TSGR", 97: "+TSRA", 98: "TSDS", 99: "+TSGR",
    }
    if 40 <= ww <= 49:
        return "FG"
    return table.get(ww)


def decode_synop(msg: str) -> Optional[dict[str, Any]]:
    """The readings of one AAXX message (land station), or None."""
    parts = msg.replace("=", " ").split()
    if len(parts) < 5 or parts[0] != "AAXX" or "NIL" in parts[:4]:
        return None
    yyggi = parts[1]
    knots = len(yyggi) == 5 and yyggi[4] in "34"
    wmo = parts[2]
    if not (len(wmo) == 5 and wmo.isdigit()):
        return None
    i = 3
    irix = parts[i] if i < len(parts) else ""
    i += 1
    nddff = parts[i] if i < len(parts) else ""
    i += 1
    if len(irix) != 5 or len(nddff) != 5:
        return None
    rec: dict[str, Any] = {"wmo": wmo}
    rec["vis_km"] = _vis_km(irix[3:5])
    rec["cloud_base_m"] = _CLOUD_BASE_M.get(irix[2])
    n = nddff[0]
    rec["oktas"] = int(n) if n.isdigit() else None
    dd, ff = nddff[1:3], nddff[3:5]
    speed = None
    if ff.isdigit():
        speed = float(ff)
        if ff == "99" and i < len(parts) and parts[i].startswith("00") and parts[i][2:].isdigit():
            speed = float(parts[i][2:])
            i += 1
    if speed is not None and not knots:
        speed *= KT_PER_MS
    rec["wspd"] = speed
    rec["wdir"] = int(dd) * 10 if dd.isdigit() and 1 <= int(dd) <= 36 else None
    if dd == "00":
        rec["wspd"] = 0.0
    precip_ir = irix[0]
    section = 1
    seen_other_s3 = False
    for g in parts[i:]:
        if len(g) != 5:
            if g in ("333", "555", "444"):
                section = int(g[0])
            continue
        if section == 1 and g.startswith("222"):
            section = 2
            continue
        if section == 1:
            c = g[0]
            if c == "1":
                rec["temp"] = _temp(g)
            elif c == "2":
                if g[1] == "9" and g[2:].isdigit():
                    rec["rh"] = float(min(100, int(g[2:])))
                else:
                    rec["dewp"] = _temp(g)
            elif c == "3":
                rec["stn_pres"] = _hpa(g)
            elif c == "4" and g[1] in "09":
                rec["mslp"] = _hpa(g)
            elif c == "5" and g[1:].isdigit():
                a, ppp = int(g[1]), int(g[2:]) / 10
                rec["tend3h"] = -ppp if a >= 5 else (0.0 if a == 4 else ppp)
            elif c == "6" and g[1:4].isdigit():
                rec["precip_mm"] = _precip_mm(g[1:4])
                rec["precip_h"] = _PRECIP_HOURS.get(g[4])
            elif c == "7" and g[1:3].isdigit():
                rec["ww"] = int(g[1:3])
            elif c == "8":
                pass
        elif section == 3:
            c = g[0]
            # Max and min lead section 3; after the sunshine and radiation
            # groups (5...), digits 0-6 mean something else again.
            if c in "345" or g.startswith("55"):
                seen_other_s3 = True
            if c == "1" and not seen_other_s3:
                rec["tmax"] = _temp(g)
            elif c == "2" and not seen_other_s3:
                rec["tmin"] = _temp(g)
            elif g[:3] in ("910", "911") and g[3:].isdigit():
                gust = float(g[3:])
                rec["wgst"] = gust if knots else gust * KT_PER_MS
    if precip_ir == "3" and "precip_mm" not in rec:
        rec["precip_mm"] = 0.0
    if "ww" in rec:
        rec["wx"] = _ww_words(rec["ww"])
        rec["wxCode"] = _ww_code(rec["ww"])
    return rec


# ---------------------------------------------------------------------------
# SYNOP feed (OGIMET)
# ---------------------------------------------------------------------------
OGIMET = "https://www.ogimet.com/cgi-bin/getsynop"
SYNOP_REFRESH_S = 20 * 60
SYNOP_WINDOW_H = 6
_SYNOP: dict[str, Any] = {"at": 0.0, "rows": {}}
_SYNOP_LOCK = threading.Lock()
_SYNOP_BUSY = threading.Lock()


def _ogimet_lines(begin: datetime, end: datetime, block: Optional[str] = None) -> list[str]:
    params = {"begin": begin.strftime("%Y%m%d%H%M"), "end": end.strftime("%Y%m%d%H%M")}
    if block:
        params["block"] = block
    r = _SESSION.get(OGIMET, params=params, timeout=(8, 90))
    r.raise_for_status()
    return [ln for ln in r.text.splitlines() if ln.count(",") >= 6]


def _synop_row(line: str) -> Optional[dict[str, Any]]:
    f = line.split(",", 6)
    try:
        when = datetime(int(f[1]), int(f[2]), int(f[3]), int(f[4]), int(f[5]), tzinfo=timezone.utc)
    except (ValueError, IndexError):
        return None
    rec = decode_synop(f[6])
    if rec is None:
        return None
    rec["time"] = when.timestamp()
    rec["raw"] = f[6].strip()
    return rec


def _refresh_synop() -> None:
    now = datetime.now(timezone.utc)
    end = now.replace(minute=0, second=0, microsecond=0)
    lines = _ogimet_lines(end - timedelta(hours=SYNOP_WINDOW_H), end)
    latest: dict[str, dict[str, Any]] = {}
    for ln in lines:
        rec = _synop_row(ln)
        if rec is None:
            continue
        have = latest.get(rec["wmo"])
        # The newest report, unless it lacks the temperature an older one has
        # (a 3-hourly station's intermediate report can be wind only).
        if have is None or (rec["time"] >= have["time"] and (rec.get("temp") is not None or have.get("temp") is None)):
            latest[rec["wmo"]] = rec
    with _SYNOP_LOCK:
        _SYNOP["rows"] = latest
        _SYNOP["at"] = time.time()


def synop_latest() -> dict[str, dict[str, Any]]:
    """WMO id -> newest decoded report (last six hours). Refreshed in the
    background when older than 20 minutes: a request never waits for OGIMET
    (40 s at times); until the first set is in, it gets none."""
    with _SYNOP_LOCK:
        age = time.time() - _SYNOP["at"]
        rows = _SYNOP["rows"]
    if age > SYNOP_REFRESH_S and _SYNOP_BUSY.acquire(blocking=False):
        def run() -> None:
            try:
                _refresh_synop()
            except Exception:  # noqa: BLE001 - keep the last good set
                with _SYNOP_LOCK:
                    _SYNOP["at"] = time.time() - SYNOP_REFRESH_S + 120  # try again in 2 min
            finally:
                _SYNOP_BUSY.release()
        _POOL.submit(run)
    return rows


# Past instants: OGIMET's six hours before each, read once per hour of the
# timeline (a loop crosses a few) and kept for a while.
_SYNOP_PAST: dict[int, list[dict[str, Any]]] = {}
_SYNOP_PAST_LOADING: set[int] = set()


def synop_at(at: float) -> tuple[dict[str, dict[str, Any]], str]:
    """Each station's last report in the six hours before `at` -- the same
    choice synop_latest makes for now -- and "ok" or "pending"."""
    end_hour = int(math.ceil(at / 3600))
    rows = _SYNOP_PAST.get(end_hour)
    if rows is None:
        if end_hour not in _SYNOP_PAST_LOADING:
            _SYNOP_PAST_LOADING.add(end_hour)

            def load() -> None:
                try:
                    end = datetime.fromtimestamp(end_hour * 3600, timezone.utc)
                    lines = _ogimet_lines(end - timedelta(hours=SYNOP_WINDOW_H + 1), end)
                    _SYNOP_PAST[end_hour] = [r for r in (_synop_row(ln) for ln in lines) if r is not None]
                    for old in sorted(_SYNOP_PAST)[:-6]:
                        _SYNOP_PAST.pop(old, None)
                except Exception:  # noqa: BLE001 - asked again on the next request
                    pass
                finally:
                    _SYNOP_PAST_LOADING.discard(end_hour)
            _POOL.submit(load)
        return {}, "pending"
    latest: dict[str, dict[str, Any]] = {}
    for rec in rows:
        if rec["time"] > at or at - rec["time"] > SYNOP_WINDOW_H * 3600:
            continue
        have = latest.get(rec["wmo"])
        if have is None or (rec["time"] >= have["time"] and (rec.get("temp") is not None or have.get("temp") is None)):
            latest[rec["wmo"]] = rec
    return latest, "ok"


def feeds_pending(at: Optional[float] = None) -> bool:
    """Whether a network is still being read for the first time: the map asks
    again shortly rather than wait for its next five-minute refresh."""
    if at is not None:
        return bool(_SYNOP_PAST_LOADING or _MADIS_LOADING or _INMET_PAST_LOADING)
    with _SYNOP_LOCK:
        synop_empty = not _SYNOP["rows"]
    with _MADIS_LOCK:
        madis_empty = _MADIS["latest"] is None
    return (synop_empty and _SYNOP_BUSY.locked()) or (madis_empty and _MADIS_BUSY.locked())


def synop_history(wmo: str, hours: int) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    lines = _ogimet_lines(now - timedelta(hours=hours), now, block=wmo)
    out = [r for r in (_synop_row(ln) for ln in lines) if r is not None and r["wmo"] == wmo]
    out.sort(key=lambda r: r["time"])
    return out


# ---------------------------------------------------------------------------
# MADIS public mesonet feed
# ---------------------------------------------------------------------------
MADIS_DIR = "https://madis-data.ncep.noaa.gov/madisPublic1/data/LDAD/mesonet/netCDF/"
MADIS_REFRESH_S = 15 * 60
_MADIS_FIELDS = ("temperature", "dewpoint", "relHumidity", "windDir", "windSpeed", "windGust",
                 "altimeter", "seaLevelPressure", "visibility", "precipAccum", "precipRate",
                 "maxTemp24Hour", "minTemp24Hour", "elevation")
_QC_BAD = (b"X", b"B")


@dataclass
class MadisHour:
    """Every record of one hourly file, trimmed to what a plot needs."""
    ids: np.ndarray        # str
    names: np.ndarray      # str
    provider: np.ndarray   # str
    lat: np.ndarray
    lon: np.ndarray
    time: np.ndarray       # unix s
    f: dict[str, np.ndarray]


_MADIS: dict[str, Any] = {"at": 0.0, "latest": None, "hours": {}}
_MADIS_LOCK = threading.Lock()
_MADIS_BUSY = threading.Lock()


def _chars(var) -> np.ndarray:
    a = np.ascontiguousarray(var.data)
    return np.char.strip(np.char.decode(a.view(f"S{a.shape[1]}").ravel(), "latin-1"))


def _parse_madis(gz: bytes) -> MadisHour:
    from scipy.io import netcdf_file  # noqa: PLC0415

    raw = gzip.decompress(gz)
    ds = netcdf_file(io.BytesIO(raw), mmap=False)
    try:
        v = ds.variables

        def num(name: str) -> np.ndarray:
            if name not in v:
                return np.full(v["latitude"].shape, np.nan, dtype="float32")
            a = np.array(v[name].data, dtype="float64")
            bad = ~np.isfinite(a) | (a > 1e30) | (a == -9999.0)
            dd = name + "DD"
            if dd in v:
                q = np.array(v[dd].data).ravel()
                bad |= np.isin(q, _QC_BAD)
            a[bad] = np.nan
            return a.astype("float32")

        hour = MadisHour(
            ids=_chars(v["stationId"]), names=_chars(v["stationName"]), provider=_chars(v["dataProvider"]),
            lat=np.array(v["latitude"].data, dtype="float64"), lon=np.array(v["longitude"].data, dtype="float64"),
            time=np.array(v["observationTime"].data, dtype="float64"),
            f={name: num(name) for name in _MADIS_FIELDS},
        )
    finally:
        ds.close()
        del raw
    ok = np.isfinite(hour.lat) & np.isfinite(hour.lon) & np.isfinite(hour.time) & (hour.time < 1e12)
    if not ok.all():
        hour = MadisHour(hour.ids[ok], hour.names[ok], hour.provider[ok], hour.lat[ok], hour.lon[ok], hour.time[ok],
                         {k: a[ok] for k, a in hour.f.items()})
    return hour


def _madis_files() -> list[str]:
    r = _SESSION.get(MADIS_DIR, timeout=(8, 30))
    r.raise_for_status()
    return sorted(set(re.findall(r'href="(\d{8}_\d{4}\.gz)"', r.text)))


def _madis_hour(name: str, current: bool) -> Optional[MadisHour]:
    """One hourly file, from disk when it is there and final. The current
    hour's file keeps growing, so it is asked for again (if it changed)."""
    path = _cache_path("madis", name)
    headers = {}
    if path.exists():
        if not current and time.time() - path.stat().st_mtime > 3600:
            return _parse_madis(path.read_bytes())
        headers["If-Modified-Since"] = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime(
            "%a, %d %b %Y %H:%M:%S GMT")
    r = _SESSION.get(MADIS_DIR + name, headers=headers, timeout=(8, 240))
    if r.status_code == 304 and path.exists():
        return _parse_madis(path.read_bytes())
    r.raise_for_status()
    tmp = path.with_suffix(".part")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return _parse_madis(r.content)


# Rain in the last hour, mm, as a plot shows it. MADIS's precipAccum is no
# help as it stands: its period is each provider's own -- a rolling 24 hours
# for the CWOP stations, the hour for LCRA, the water year for NRCS (1,778 mm
# on one gauge) -- and the app showed it as "Rain" with no period at all.
# precipRate is the last hour's rain for the networks that carry both (checked
# 2026-09-28 against the accumulation's change over the hour: CWOP, HADS,
# RAWS, LCRA), so it comes first; where only an accumulation is sent, its rise
# over the last hour stands in, and a fall (a reset) says nothing.
RAIN_MAX_MM = 250.0


def _rain_last_hour(ids: np.ndarray, t: np.ndarray, acc: np.ndarray, rate: np.ndarray,
                    pick: np.ndarray) -> np.ndarray:
    """The last hour's rain (mm) at each picked reading, NaN where unknown.

    Where a station sends both, the rate has to be borne out by its own
    accumulation, which rose at least as much over the hour whatever its
    period (unless it was reset): a CWOP station in Ada sent 33 mm/h for an
    hour while its accumulation fell, and one faulty gauge like that is a
    downpour on the map in the middle of dry neighbours."""
    out = np.full(len(pick), np.nan, dtype="float32")
    r = rate[pick].astype("float64") * 3.6e6
    good = np.isfinite(r) & (r >= 0) & (r <= RAIN_MAX_MM)
    rise = np.full(len(pick), np.nan)
    has_acc = np.nonzero(np.isfinite(acc[pick]))[0]
    if len(has_acc):
        order = np.lexsort((t, ids))
        sid, st, sacc = ids[order], t[order], acc[order]
        for k in has_acc:
            p = pick[k]
            lo, hi = np.searchsorted(sid, ids[p], "left"), np.searchsorted(sid, ids[p], "right")
            tt, aa = st[lo:hi], sacc[lo:hi]
            want = t[p] - 3600
            ok = np.nonzero(np.isfinite(aa) & (np.abs(tt - want) <= 900))[0]
            if len(ok):
                rise[k] = float(acc[p]) - float(aa[ok[np.argmin(np.abs(tt[ok] - want))]])
    for k in range(len(pick)):
        if good[k]:
            d = rise[k]
            now_acc = float(acc[pick[k]])
            # A reset within the hour (to at most half of what it held): what
            # it holds since then is the hour's.
            reset = np.isfinite(d) and d < 0 and now_acc <= 0.5 * (now_acc - d)
            backed = (not np.isfinite(d) or d >= 0.5 * r[k] - 0.5
                      or (reset and now_acc >= 0.5 * r[k] - 0.5))
            if backed:
                out[k] = round(float(r[k]), 1)
        elif np.isfinite(rise[k]) and 0 <= rise[k] <= RAIN_MAX_MM:
            out[k] = round(float(rise[k]), 1)
    return out


def _latest_per_station(hours: list[MadisHour], at: Optional[float] = None) -> Optional[MadisHour]:
    """Each station's newest reading -- or, with `at`, its last one in the hour
    before that instant -- with the last hour's rain beside it."""
    hours = [h for h in hours if h is not None and len(h.ids)]
    if not hours:
        return None
    ids = np.concatenate([h.ids for h in hours])
    t = np.concatenate([h.time for h in hours])
    temp = np.concatenate([h.f["temperature"] for h in hours])
    acc = np.concatenate([h.f["precipAccum"] for h in hours])
    rate = np.concatenate([h.f["precipRate"] for h in hours])
    # Newest first, a reading with a temperature before one without.
    order = np.lexsort((-np.isfinite(temp).astype(int), -t))
    if at is not None:
        order = order[(t[order] <= at) & (t[order] > at - 3600)]
        if not len(order):
            return None
    _u, first = np.unique(ids[order], return_index=True)
    pick = order[first]

    def cat(get):
        return np.concatenate([get(h) for h in hours])[pick]

    f = {k: cat(lambda h, k=k: h.f[k]) for k in _MADIS_FIELDS}
    f["rain1h"] = _rain_last_hour(ids, t, acc, rate, pick)
    return MadisHour(
        ids=cat(lambda h: h.ids), names=cat(lambda h: h.names), provider=cat(lambda h: h.provider),
        lat=cat(lambda h: h.lat), lon=cat(lambda h: h.lon), time=cat(lambda h: h.time), f=f,
    )


def _refresh_madis() -> None:
    files = _madis_files()[-2:]
    hours: dict[str, MadisHour] = {}
    for idx, name in enumerate(files):
        h = _madis_hour(name, current=idx == len(files) - 1)
        if h is not None:
            hours[name] = h
    latest = _latest_per_station(list(hours.values()))
    with _MADIS_LOCK:
        kept = dict(_MADIS["hours"])
        kept.update(hours)
        # A day of hours for the station pages' history, oldest dropped first.
        for old in sorted(kept)[:-24]:
            kept.pop(old, None)
        _MADIS["hours"] = kept
        _MADIS["latest"] = latest
        _MADIS["at"] = time.time()


def madis_latest() -> Optional[MadisHour]:
    with _MADIS_LOCK:
        age = time.time() - _MADIS["at"]
        latest = _MADIS["latest"]
    if age > MADIS_REFRESH_S and _MADIS_BUSY.acquire(blocking=False):
        def run() -> None:
            try:
                _refresh_madis()
            except Exception:  # noqa: BLE001 - keep what we had
                with _MADIS_LOCK:
                    _MADIS["at"] = time.time() - MADIS_REFRESH_S + 180
            finally:
                _MADIS_BUSY.release()
        # Never wait on 32 MB: the first map gets METAR and SYNOP, the
        # mesonets join on the next refresh of the view.
        _POOL.submit(run)
    return latest


# Hours older than the live pair, read for a past instant on the timeline:
# a few kept, each one is ~40 MB in memory.
_MADIS_PAST: dict[str, MadisHour] = {}
_MADIS_PAST_KEEP = 4
_MADIS_AT: dict[int, Optional[MadisHour]] = {}
_MADIS_LOADING: set[str] = set()


def _hour_names(at: float) -> list[str]:
    """The hourly files holding the hour before `at`: its own and the one before."""
    d = datetime.fromtimestamp(at, timezone.utc).replace(minute=0, second=0, microsecond=0)
    return [f"{x:%Y%m%d_%H}00.gz" for x in (d - timedelta(hours=1), d)]


def madis_at(at: float) -> tuple[Optional[MadisHour], str]:
    """Each station's last reading in the hour before `at`: (hour, "ok") -- or
    (None, "pending") while its files come in, (None, "unavailable") when MADIS
    no longer keeps them (it holds about five days)."""
    bucket = int(at // 300 * 300)
    if bucket in _MADIS_AT:
        return _MADIS_AT[bucket], "ok"
    names = _hour_names(bucket)
    with _MADIS_LOCK:
        have = {n: _MADIS["hours"].get(n) or _MADIS_PAST.get(n) for n in names}
    missing = [n for n, h in have.items() if h is None]
    if missing:
        try:
            listed = set(_madis_files())
        except Exception:  # noqa: BLE001
            return None, "pending"
        if not any(n in listed or _cache_path("madis", n).exists() for n in missing):
            return None, "unavailable"
        todo = [n for n in missing if n not in _MADIS_LOADING and (n in listed or _cache_path("madis", n).exists())]
        for n in todo:
            _MADIS_LOADING.add(n)

            def load(n=n) -> None:
                try:
                    h = _madis_hour(n, current=False)
                    with _MADIS_LOCK:
                        _MADIS_PAST[n] = h
                        for old in sorted(_MADIS_PAST)[:-_MADIS_PAST_KEEP]:
                            _MADIS_PAST.pop(old, None)
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    _MADIS_LOADING.discard(n)
            _POOL.submit(load)
        if todo or any(n in _MADIS_LOADING for n in missing):
            return None, "pending"
    latest = _latest_per_station([h for h in have.values() if h is not None], at=bucket)
    _MADIS_AT[bucket] = latest
    for old in sorted(_MADIS_AT)[:-12]:
        _MADIS_AT.pop(old, None)
    return latest, "ok"


def madis_history(station: str, hours: int) -> list[dict[str, Any]]:
    with _MADIS_LOCK:
        kept = list(_MADIS["hours"].values())
    since = time.time() - hours * 3600
    rows: list[dict[str, Any]] = []
    for h in kept:
        sel = np.nonzero((h.ids == station) & (h.time >= since))[0]
        for j in sel:
            rows.append(_madis_props(h, int(j)))
            rows[-1]["_acc"] = _f(h.f["precipAccum"][j])
    rows.sort(key=lambda r: r["obsTime"])
    dedup: list[dict[str, Any]] = []
    for r in rows:
        if not dedup or r["obsTime"] != dedup[-1]["obsTime"]:
            dedup.append(r)
    # The last hour's rain where the rate is missing: the accumulation's rise
    # since the reading nearest an hour before.
    accs = [r.pop("_acc", None) for r in dedup]
    for i, r in enumerate(dedup):
        if r["precip"] is not None or accs[i] is None:
            continue
        want = r["obsTime"] - 3600
        near = [k for k in range(i) if accs[k] is not None and abs(dedup[k]["obsTime"] - want) <= 900]
        if near:
            k = min(near, key=lambda k: abs(dedup[k]["obsTime"] - want))
            d = accs[i] - accs[k]
            if 0 <= d <= RAIN_MAX_MM:
                r["precip"], r["precipHours"] = round(d, 1), 1
    return dedup


# ---------------------------------------------------------------------------
# Features for the map
# ---------------------------------------------------------------------------
def _f(v) -> Optional[float]:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _r(v, nd=1) -> Optional[float]:
    x = _f(v)
    return None if x is None else round(x, nd)


def _rh(temp: Optional[float], dewp: Optional[float]) -> Optional[float]:
    if temp is None or dewp is None:
        return None
    e = math.exp((17.625 * dewp) / (243.04 + dewp))
    es = math.exp((17.625 * temp) / (243.04 + temp))
    return round(100.0 * e / es, 0)


def _dewp_from_rh(temp: Optional[float], rh: Optional[float]) -> Optional[float]:
    if temp is None or rh is None or rh <= 0:
        return None
    a, b = 17.625, 243.04
    g = math.log(rh / 100.0) + a * temp / (b + temp)
    return round(b * g / (a - g), 1)


def _cover_from_oktas(n: Optional[int]) -> Optional[str]:
    if n is None:
        return None
    if n == 0:
        return "CLR"
    if n <= 2:
        return "FEW"
    if n <= 4:
        return "SCT"
    if n <= 7:
        return "BKN"
    return "OVC"


def synop_props(wmo: str, rec: dict[str, Any], info: tuple) -> dict[str, Any]:
    lat, lon, name, country, elev = info
    temp, dewp = rec.get("temp"), rec.get("dewp")
    if dewp is None and rec.get("rh") is not None:
        dewp = _dewp_from_rh(temp, rec.get("rh"))
    vis_km = rec.get("vis_km")
    return {
        "id": wmo,
        "name": name.title() if name.isupper() else name,
        "kind": "synop",
        "network": "SYNOP",
        "country": country,
        "elev": elev,
        "temp": temp,
        "dewp": dewp,
        "wdir": rec.get("wdir"),
        "wspd": _r(rec.get("wspd"), 0),
        "wgst": _r(rec.get("wgst"), 0),
        # Sea-level pressure where the station computes it (the plot's "pressure").
        "altim": rec.get("mslp"),
        "mslp": rec.get("mslp"),
        "stnPres": rec.get("stn_pres"),
        "tend3h": rec.get("tend3h"),
        "visib": None if vis_km is None else round(vis_km / 1.609344, 2),
        "cover": _cover_from_oktas(rec.get("oktas")),
        "oktas": rec.get("oktas"),
        "cloudBase": rec.get("cloud_base_m"),
        "clouds": [],
        "wx": rec.get("wx"),
        "wxCode": rec.get("wxCode"),
        "raw": None,
        "synop": rec.get("raw"),
        "precip": rec.get("precip_mm"),
        "precipHours": rec.get("precip_h"),
        "tmax": rec.get("tmax"),
        "tmin": rec.get("tmin"),
        "rh": rec.get("rh") if rec.get("rh") is not None else _rh(temp, dewp),
        "obsTime": int(rec["time"]),
    }


def _madis_props(h: MadisHour, j: int) -> dict[str, Any]:
    f = h.f
    k = lambda name: _f(f[name][j])  # noqa: E731
    temp = k("temperature")
    dewp = k("dewpoint")
    temp = None if temp is None else round(temp - 273.15, 1)
    dewp = None if dewp is None else round(dewp - 273.15, 1)
    rh = k("relHumidity")
    if dewp is None and rh is not None:
        dewp = _dewp_from_rh(temp, rh)
    wspd = k("windSpeed")
    wgst = k("windGust")
    slp = k("seaLevelPressure")
    alt = k("altimeter")
    vis = k("visibility")
    tmax = k("maxTemp24Hour")
    tmin = k("minTemp24Hour")
    if "rain1h" in f:
        rain = _r(k("rain1h"), 1)
    else:
        rate = k("precipRate")
        rain = None if rate is None or not 0 <= rate * 3.6e6 <= RAIN_MAX_MM else round(rate * 3.6e6, 1)
    # CWOP names come padded out to a fixed width ("EW7074 Teutania      BR").
    name = " ".join(str(h.names[j]).split())
    return {
        "id": str(h.ids[j]),
        "name": name.title() if name.isupper() else name,
        "kind": "mesonet",
        "network": str(h.provider[j]),
        "elev": _r(k("elevation"), 0),
        "temp": temp,
        "dewp": dewp,
        "wdir": None if k("windDir") is None else int(round(k("windDir"))),
        "wspd": None if wspd is None else round(wspd * KT_PER_MS, 0),
        "wgst": None if wgst is None else round(wgst * KT_PER_MS, 0),
        # The altimeter setting when a station sends one, else sea-level pressure.
        "altim": round(alt / 100, 1) if alt is not None else (round(slp / 100, 1) if slp is not None else None),
        "mslp": None if slp is None else round(slp / 100, 1),
        "visib": None if vis is None else round(vis / 1609.344, 2),
        "cover": None,
        "clouds": [],
        "wx": None,
        "raw": None,
        # The last hour's rain (see _rain_last_hour); a single reading has its
        # rate at most, the latest-per-station set its accumulation's rise too.
        "precip": rain,
        "precipHours": None if rain is None else 1,
        "tmax": None if tmax is None else round(tmax - 273.15, 1),
        "tmin": None if tmin is None else round(tmin - 273.15, 1),
        "rh": rh if rh is not None else _rh(temp, dewp),
        "obsTime": int(h.time[j]),
    }


def features_in_box(lat0: float, lon0: float, lat1: float, lon1: float,
                    cell: Optional[float] = None, synop: bool = True, mesonet: bool = True,
                    at: Optional[float] = None) -> tuple[list[dict[str, Any]], list[str]]:
    """SYNOP and mesonet stations inside the box, as GeoJSON features, and the
    networks that have nothing for `at` (a past instant; None is now). With
    `cell` (degrees), the mesonets are thinned first to the best station of
    each cell -- a view of the US holds 32,000 of them."""
    out: list[dict[str, Any]] = []
    missing: list[str] = []
    try:
        if not synop:
            raise LookupError
        wmo = wmo_stations()
        rows = synop_latest() if at is None else synop_at(at)[0]
        for sid, rec in rows.items():
            info = wmo.get(sid)
            if info is None:
                continue
            lat, lon = info[0], info[1]
            if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
                out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": synop_props(sid, rec, info)})
    except Exception:  # noqa: BLE001 - the METARs still come
        pass
    if synop:
        for props in (inmet_latest() if at is None else inmet_at(at)[0]).values():
            lat, lon = props["lat"], props["lon"]
            if lat0 <= lat <= lat1 and lon0 <= lon <= lon1:
                out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": props})
    h = None
    if mesonet:
        if at is None:
            h = madis_latest()
        else:
            h, state = madis_at(at)
            if state == "unavailable":
                missing.append("mesonet")
    if h is not None:
        inside = np.nonzero((h.lat >= lat0) & (h.lat <= lat1) & (h.lon >= lon0) & (h.lon <= lon1))[0]
        if cell and len(inside):
            f = h.f
            full = (np.isfinite(f["temperature"][inside]).astype(int) * 4
                    + np.isfinite(f["windSpeed"][inside]).astype(int) * 2
                    + (np.isfinite(f["altimeter"][inside]) | np.isfinite(f["seaLevelPressure"][inside])).astype(int)
                    + np.isfinite(f["dewpoint"][inside]).astype(int))
            order = np.lexsort((-h.time[inside], -full))
            gy = np.floor(h.lat[inside][order] / cell).astype(np.int64)
            gx = np.floor(h.lon[inside][order] / cell).astype(np.int64)
            _u, first = np.unique(gy * 1_000_003 + gx, return_index=True)
            inside = inside[order[np.sort(first)]]
        for j in inside:
            props = _madis_props(h, int(j))
            if props["temp"] is None and props["wspd"] is None:
                continue
            out.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(h.lon[j]), float(h.lat[j])]},
                        "properties": props})
    return out, missing


def warm() -> None:
    """At app start, in the background: the station lists and the SYNOP set
    (2 MB). The mesonets' 64 MB wait until the station plots are turned on."""
    _POOL.submit(lambda: (wmo_stations(), synop_latest()))
    inmet_latest()


# ---------------------------------------------------------------------------
# INMET automatic stations (Brazil) -- with the user's own token
# ---------------------------------------------------------------------------
# 520-odd automatic stations reporting every hour: the densest network in
# Brazil. Their data need a personal token (free, asked for by e-mail to
# cadastro.act@inmet.gov.br); without one this network is simply absent. The
# token is kept in the user's roaming profile, not the temp folder.
INMET_API = "https://apitempo.inmet.gov.br"
# INMET's firewall resets connections from anything that does not look like a browser.
_INMET_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                "(KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Accept": "application/json"}
INMET_REFRESH_S = 20 * 60
_INMET: dict[str, Any] = {"at": 0.0, "rows": {}, "error": None, "hour": None}
_INMET_LOCK = threading.Lock()
_INMET_BUSY = threading.Lock()
_INMET_META: dict[str, Any] = {"at": 0.0, "alt": {}}


def _config_path() -> Path:
    import os  # noqa: PLC0415

    base = Path(os.environ.get("APPDATA") or Path.home())
    p = base / "WeatherTS" / "stations.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _config() -> dict[str, Any]:
    import json  # noqa: PLC0415

    try:
        return json.loads(_config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def inmet_token() -> Optional[str]:
    # The hosted backend (the web version) takes it from its environment only:
    # it serves everyone, so no visitor may set or clear it.
    import os  # noqa: PLC0415

    tok = os.environ.get("INMET_TOKEN") or str(_config().get("inmet_token") or "")
    return tok.strip() or None


def _inmet_get(path: str) -> Any:
    r = requests.get(INMET_API + path, headers=_INMET_HEADERS, timeout=(8, 60))
    if r.status_code == 204:
        return []
    r.raise_for_status()
    return r.json() if r.content else []


def _inmet_altitudes() -> dict[str, float]:
    """Station code -> altitude (m), for reducing station pressure to sea level.
    The station list needs no token."""
    if time.time() - _INMET_META["at"] < 7 * 86400 and _INMET_META["alt"]:
        return _INMET_META["alt"]
    alt: dict[str, float] = {}
    try:
        for s in _inmet_get("/estacoes/T"):
            try:
                alt[str(s["CD_ESTACAO"])] = float(s.get("VL_ALTITUDE"))
            except (TypeError, ValueError, KeyError):
                continue
    except Exception:  # noqa: BLE001
        return _INMET_META["alt"]
    _INMET_META.update({"at": time.time(), "alt": alt})
    return alt


def _num_s(v) -> Optional[float]:
    try:
        x = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def inmet_props(rec: dict[str, Any], alt: dict[str, float]) -> Optional[dict[str, Any]]:
    code = str(rec.get("CD_ESTACAO") or "")
    lat, lon = _num_s(rec.get("VL_LATITUDE")), _num_s(rec.get("VL_LONGITUDE"))
    if not code or lat is None or lon is None:
        return None
    try:
        day = str(rec.get("DT_MEDICAO"))[:10]
        hhmm = str(rec.get("HR_MEDICAO") or "0000").zfill(4)
        when = datetime.strptime(f"{day} {hhmm}", "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    temp, dewp = _num_s(rec.get("TEM_INS")), _num_s(rec.get("PTO_INS"))
    rh = _num_s(rec.get("UMD_INS"))
    pres = _num_s(rec.get("PRE_INS"))
    h = alt.get(code)
    mslp = None
    if pres is not None and h is not None:
        t = temp if temp is not None else 15.0
        mslp = round(pres * (1 - 0.0065 * h / (t + 0.0065 * h + 273.15)) ** -5.257, 1)
    wspd, wgst = _num_s(rec.get("VEN_VEL")), _num_s(rec.get("VEN_RAJ"))
    wdir = _num_s(rec.get("VEN_DIR"))
    name = str(rec.get("DC_NOME") or code)
    return {
        "id": code,
        "name": name.title() if name.isupper() else name,
        "kind": "inmet",
        "network": "INMET",
        "state": rec.get("UF"),
        "elev": h,
        "lat": lat,
        "lon": lon,
        "temp": temp,
        "dewp": dewp if dewp is not None else _dewp_from_rh(temp, rh),
        "wdir": None if wdir is None else int(round(wdir)),
        "wspd": None if wspd is None else round(wspd * KT_PER_MS, 0),
        "wgst": None if wgst is None else round(wgst * KT_PER_MS, 0),
        "altim": mslp,
        "mslp": mslp,
        "stnPres": pres,
        "visib": None,
        "cover": None,
        "clouds": [],
        "wx": None,
        "raw": None,
        "precip": _num_s(rec.get("CHUVA")),
        "precipHours": 1,
        # The hour's extremes (INMET reports them with each hour).
        "tmax": _num_s(rec.get("TEM_MAX")),
        "tmin": _num_s(rec.get("TEM_MIN")),
        "extremesHours": 1,
        "radiation": _num_s(rec.get("RAD_GLO")),
        "rh": rh if rh is not None else _rh(temp, dewp),
        "obsTime": int(when.timestamp()),
    }


def _refresh_inmet() -> None:
    token = inmet_token()
    if not token:
        with _INMET_LOCK:
            _INMET.update({"rows": {}, "error": None, "hour": None, "at": time.time()})
        return
    alt = _inmet_altitudes()
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    rows: dict[str, dict[str, Any]] = {}
    got_hour = None
    error = None
    # The newest hour with data (INMET publishes it within the next hour),
    # with the hour before filling the stations that have not come in yet.
    for back in range(0, 4):
        t = now - timedelta(hours=back)
        try:
            data = _inmet_get(f"/token/estacao/dados/{t:%Y-%m-%d}/{t:%H}00/{token}")
        except requests.HTTPError as err:
            error = f"INMET answered {err.response.status_code}: check the token"
            break
        except requests.RequestException as err:
            error = f"INMET did not answer ({type(err).__name__})"
            break
        if not isinstance(data, list) or not data:
            continue
        for rec in data:
            p = inmet_props(rec, alt)
            if p is None or (p["temp"] is None and p["wspd"] is None):
                continue
            if p["id"] not in rows:
                rows[p["id"]] = p
        got_hour = got_hour or t
        if len(rows) > 300:
            break
    if got_hour is None and error is None:
        error = "No data with this token in the last hours"
    with _INMET_LOCK:
        if rows or error is None:
            _INMET["rows"] = rows
        _INMET.update({"error": error, "hour": got_hour.isoformat() if got_hour else None, "at": time.time()})


_INMET_PAST: dict[int, dict[str, dict[str, Any]]] = {}
_INMET_PAST_LOADING: set[int] = set()


def inmet_at(at: float) -> tuple[dict[str, dict[str, Any]], str]:
    """The hourly readings in force at `at` (the hour it falls in, the one
    before filling gaps): (rows, "ok") or ({}, "pending")."""
    token = inmet_token()
    if not token:
        return {}, "ok"
    hour = int(at // 3600)
    rows = _INMET_PAST.get(hour)
    if rows is not None:
        return rows, "ok"
    if hour not in _INMET_PAST_LOADING:
        _INMET_PAST_LOADING.add(hour)

        def load() -> None:
            try:
                alt = _inmet_altitudes()
                got: dict[str, dict[str, Any]] = {}
                for back in (0, 1):
                    t = datetime.fromtimestamp((hour - back) * 3600, timezone.utc)
                    data = _inmet_get(f"/token/estacao/dados/{t:%Y-%m-%d}/{t:%H}00/{token}")
                    for rec in data if isinstance(data, list) else []:
                        p = inmet_props(rec, alt)
                        if p is None or (p["temp"] is None and p["wspd"] is None) or p["obsTime"] > at:
                            continue
                        got.setdefault(p["id"], p)
                _INMET_PAST[hour] = got
                for old in sorted(_INMET_PAST)[:-8]:
                    _INMET_PAST.pop(old, None)
            except Exception:  # noqa: BLE001 - asked again on the next request
                pass
            finally:
                _INMET_PAST_LOADING.discard(hour)
        _POOL.submit(load)
    return {}, "pending"


def inmet_latest() -> dict[str, dict[str, Any]]:
    with _INMET_LOCK:
        age = time.time() - _INMET["at"]
        rows = _INMET["rows"]
    if age > INMET_REFRESH_S and inmet_token() and _INMET_BUSY.acquire(blocking=False):
        def run() -> None:
            try:
                _refresh_inmet()
            finally:
                _INMET_BUSY.release()
        _POOL.submit(run)
    return rows


def set_inmet_token(token: str) -> dict[str, Any]:
    """Keep (or clear) the user's INMET token and read the network with it."""
    import json  # noqa: PLC0415

    cfg = _config()
    token = (token or "").strip()
    if token:
        cfg["inmet_token"] = token
    else:
        cfg.pop("inmet_token", None)
    _config_path().write_text(json.dumps(cfg), encoding="utf-8")
    with _INMET_LOCK:
        _INMET["at"] = 0.0
    if _INMET_BUSY.acquire(timeout=90):
        try:
            _refresh_inmet()
        finally:
            _INMET_BUSY.release()
    return networks_status()


def inmet_history(code: str, hours: int) -> list[dict[str, Any]]:
    token = inmet_token()
    if not token:
        return []
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=hours)
    data = _inmet_get(f"/token/estacao/{start:%Y-%m-%d}/{end:%Y-%m-%d}/{code}/{token}")
    alt = _inmet_altitudes()
    rows = [p for p in (inmet_props(r, alt) for r in (data or [])) if p is not None and p["obsTime"] >= start.timestamp()]
    rows.sort(key=lambda p: p["obsTime"])
    return rows


def networks_status() -> dict[str, Any]:
    with _SYNOP_LOCK:
        synop_n, synop_at = len(_SYNOP["rows"]), _SYNOP["at"]
    with _MADIS_LOCK:
        latest = _MADIS["latest"]
        madis_at = _MADIS["at"]
    with _INMET_LOCK:
        inmet = dict(_INMET)
    return {
        "synop": {"stations": synop_n, "updated": synop_at or None},
        "mesonet": {"stations": 0 if latest is None else int(len(latest.ids)), "updated": madis_at or None},
        "inmet": {"configured": inmet_token() is not None, "stations": len(inmet["rows"]),
                  "hour": inmet["hour"], "error": inmet["error"]},
    }
