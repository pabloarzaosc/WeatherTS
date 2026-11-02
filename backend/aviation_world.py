"""
Aviation the world over.

Most of what aviation.py reads from the Aviation Weather Center already covers
every country -- METARs, TAFs, AIREPs, the international SIGMETs. What was the
United States' alone is filled in here from open sources that reach everywhere:

    Airports    OurAirports (public domain): every airport's name and place,
                its runways with both ends' positions and true headings, every
                frequency it lists, and the navaids around it
    FIRs        the VATSpy data project's boundaries (CC BY-SA 4.0), the real
                four-letter FIRs only, named from its FIR list
    Aloft, map  the GFS on its 0.25 deg grid (NOAA's copy on AWS) at any flight
                level and hour: wind and temperature where the FB forecast has
                no station
    Aloft, one  the GFS profile over one airport hour by hour (Open-Meteo, as
    airport     the soundings read it), worked into the FB table and more:
                cloud, icing and turbulence layers, the freezing level and the
                tropopause
"""
from __future__ import annotations

import csv
import io
import math
import os
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import numpy as np
import requests

import aviation as avn

# ---------------------------------------------------------------------------
# OurAirports
# ---------------------------------------------------------------------------
_OA = "https://davidmegginson.github.io/ourairports-data"
_OA_FILES = ("airports", "runways", "airport-frequencies", "navaids", "countries", "regions")
_WEEK = 7 * 86400.0


def _oa_text(name: str) -> str:
    """One of the OurAirports files, kept on disk a week (the airports alone are
    13 MB) and the old copy used while the site cannot be reached."""
    path = avn._DISK / f"oa-{name}.csv"  # noqa: SLF001
    try:
        fresh = time.time() - path.stat().st_mtime < _WEEK
    except OSError:
        fresh = False
    if not fresh:
        try:
            body = avn._get(f"{_OA}/{name}.csv").content  # noqa: SLF001
            avn._DISK.mkdir(parents=True, exist_ok=True)  # noqa: SLF001
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, path)
        except (requests.RequestException, OSError):
            if not path.exists():
                raise
    return path.read_text(encoding="utf-8", errors="replace")


def _rows(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text)))


def _plain(s: str) -> str:
    """Upper case with the accents taken off, for searching: 'São Paulo' -> 'SAO PAULO'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).upper()


_TYPE_RANK = {"large_airport": 0, "medium_airport": 1, "small_airport": 2, "seaplane_base": 3, "heliport": 4,
              "balloonport": 5, "closed": 6}
_TYPE_WORD = {"large_airport": "Large airport", "medium_airport": "Medium airport", "small_airport": "Small airport",
              "seaplane_base": "Seaplane base", "heliport": "Heliport", "balloonport": "Balloon port",
              "closed": "Closed"}


def _world() -> dict:
    """Every airport, runway, frequency and navaid, indexed."""
    def make() -> dict:
        with ThreadPoolExecutor(max_workers=len(_OA_FILES)) as pool:
            texts = dict(zip(_OA_FILES, pool.map(_oa_text, _OA_FILES)))
        countries = {r["code"]: r["name"] for r in _rows(texts["countries"])}
        regions = {r["code"]: r["name"] for r in _rows(texts["regions"])}
        airports: dict[str, dict] = {}
        codes: dict[str, str] = {}
        for r in _rows(texts["airports"]):
            lat, lon = avn._num(r["latitude_deg"]), avn._num(r["longitude_deg"])  # noqa: SLF001
            if lat is None or lon is None:
                continue
            ref = r["id"]
            a = {
                "ref": ref, "ident": r["ident"], "icao": r["icao_code"] or None, "gps": r["gps_code"] or None,
                "iata": r["iata_code"] or None, "local": r["local_code"] or None, "name": r["name"],
                "type": r["type"], "lat": lat, "lon": lon, "elevFt": avn._num(r["elevation_ft"]),  # noqa: SLF001
                "country": r["iso_country"], "countryName": countries.get(r["iso_country"]),
                "region": regions.get(r["iso_region"]), "municipality": r["municipality"] or None,
                "scheduled": r["scheduled_service"] == "yes", "wiki": r["wikipedia_link"] or None,
                "home": r["home_link"] or None,
                "find": _plain(" ".join(filter(None, (r["name"], r["municipality"], r["keywords"],
                                                      countries.get(r["iso_country"]))))),
            }
            airports[ref] = a
        # Codes, the strongest claim first: an airport's own ICAO code beats
        # another's GPS code that happens to be the same.
        for field in ("icao", "ident", "gps", "iata", "local"):
            for ref, a in airports.items():
                v = a[field]
                if v and v.upper() not in codes:
                    codes[v.upper()] = ref
        runways: dict[str, list[dict]] = {}
        for r in _rows(texts["runways"]):
            runways.setdefault(r["airport_ref"], []).append(r)
        freqs: dict[str, list[dict]] = {}
        for r in _rows(texts["airport-frequencies"]):
            freqs.setdefault(r["airport_ref"], []).append(r)
        navaids = []
        for r in _rows(texts["navaids"]):
            lat, lon = avn._num(r["latitude_deg"]), avn._num(r["longitude_deg"])  # noqa: SLF001
            if lat is None or lon is None:
                continue
            navaids.append({
                "ident": r["ident"], "name": r["name"], "type": r["type"], "khz": avn._num(r["frequency_khz"]),  # noqa: SLF001
                "lat": lat, "lon": lon, "elevFt": avn._num(r["elevation_ft"]),  # noqa: SLF001
                "dme": r["dme_channel"] or None, "var": avn._num(r["magnetic_variation_deg"]),  # noqa: SLF001
                "power": r["power"] or None, "usage": r["usageType"] or None,
            })
        nav_lat = np.array([n["lat"] for n in navaids], dtype=np.float64)
        nav_lon = np.array([n["lon"] for n in navaids], dtype=np.float64)
        return {"airports": airports, "codes": codes, "runways": runways, "freqs": freqs,
                "navaids": navaids, "nav_lat": nav_lat, "nav_lon": nav_lon}
    return avn._cached("world", _WEEK, make)  # noqa: SLF001


def lookup(code: str) -> Optional[dict]:
    """An airport by any code it goes by (ICAO, GPS, IATA, local), or None."""
    w = _world()
    ref = w["codes"].get(code.strip().upper())
    return w["airports"].get(ref) if ref else None


def _distances(lat: float, lon: float, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    r = np.radians
    a = (np.sin(r(lats - lat) / 2) ** 2
         + math.cos(math.radians(lat)) * np.cos(r(lats)) * np.sin(r(lons - lon) / 2) ** 2)
    return 3440.065 * 2 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))


def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = math.radians
    y = math.sin(r(lon2 - lon1)) * math.cos(r(lat2))
    x = math.cos(r(lat1)) * math.sin(r(lat2)) - math.sin(r(lat1)) * math.cos(r(lat2)) * math.cos(r(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def navaids_near(lat: float, lon: float, nm: float = 60.0, most: int = 14,
                 declination: Optional[float] = None) -> list[dict]:
    """The radio navaids within `nm`, nearest first, with the bearing and
    distance from the airport to each (true, and magnetic where known)."""
    w = _world()
    if not len(w["nav_lat"]):
        return []
    d = _distances(lat, lon, w["nav_lat"], w["nav_lon"])
    out = []
    for i in np.argsort(d)[:most * 2]:
        if d[i] > nm:
            break
        n = w["navaids"][int(i)]
        brg = _bearing(lat, lon, n["lat"], n["lon"])
        khz = n["khz"]
        # VORs, DMEs and TACANs are in the VHF band and given in kHz; NDBs are in kHz.
        freq = (f"{khz / 1000:.2f} MHz" if khz and khz >= 100000 else f"{khz:.0f} kHz" if khz else None)
        out.append({
            "ident": n["ident"], "name": n["name"], "type": n["type"], "freq": freq, "dme": n["dme"],
            "nm": round(float(d[i]), 1), "brgTrue": round(brg),
            "brgMag": round((brg - declination) % 360) if declination is not None else None,
            "elevFt": n["elevFt"], "power": n["power"], "usage": n["usage"],
        })
        if len(out) >= most:
            break
    return out


def declination_near(lat: float, lon: float) -> Optional[float]:
    """The magnetic variation of the nearest navaid within 150 nm, east positive:
    near enough to turn a true heading into the one on the compass."""
    w = _world()
    if not len(w["nav_lat"]):
        return None
    d = _distances(lat, lon, w["nav_lat"], w["nav_lon"])
    for i in np.argsort(d)[:20]:
        if d[i] > 150:
            return None
        v = w["navaids"][int(i)]["var"]
        if v is not None:
            return float(v)
    return None


_SURFACE = {
    "ASP": "Asphalt", "ASPH": "Asphalt", "BIT": "Bitumen", "CON": "Concrete", "CONC": "Concrete",
    "PEM": "Asphalt/concrete", "GRS": "Grass", "GRASS": "Grass", "TURF": "Turf", "GRE": "Gravel", "GRVL": "Gravel",
    "GVL": "Gravel", "GRAVEL": "Gravel", "DIRT": "Dirt", "SAND": "Sand", "CLAY": "Clay", "WATER": "Water",
    "SNOW": "Snow", "ICE": "Ice", "COR": "Coral", "LAT": "Laterite", "MAC": "Macadam", "PSP": "Steel planking",
    "UNK": "Unknown", "H": "Hard surface", "T": "Turf", "G": "Gravel", "W": "Water",
}


def surface_word(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    s = code.strip().upper()
    if s in _SURFACE:
        return _SURFACE[s]
    head = re.split(r"[-/ ]", s)[0]
    word = _SURFACE.get(head) or _SURFACE.get(head[:3])
    if word and "-G" in s:
        return f"{word} (good)"
    if word and "-F" in s:
        return f"{word} (fair)"
    if word and "-P" in s:
        return f"{word} (poor)"
    return word or code.strip().title()


_RWY_NAME = re.compile(r"^(\d{1,2})([LRCWGTSU]?)$")


def runways(a: dict, declination: Optional[float]) -> list[dict]:
    """The airport's runways with both ends: true heading, magnetic heading,
    threshold position and elevation, displaced threshold. Helipads are left out."""
    out = []
    for r in _world()["runways"].get(a["ref"], []):
        le, he = r["le_ident"].strip().upper(), r["he_ident"].strip().upper()
        if le.startswith("H") and not _RWY_NAME.match(le):
            continue
        ends = []
        for side, name in (("le", le), ("he", he)):
            if not name:
                continue
            lat, lon = avn._num(r[f"{side}_latitude_deg"]), avn._num(r[f"{side}_longitude_deg"])  # noqa: SLF001
            true = avn._num(r[f"{side}_heading_degT"])  # noqa: SLF001
            ends.append({"name": name, "true": true, "lat": lat, "lon": lon,
                         "elevFt": avn._num(r[f"{side}_elevation_ft"]),  # noqa: SLF001
                         "displacedFt": avn._num(r[f"{side}_displaced_threshold_ft"])})  # noqa: SLF001
        if not ends:
            continue
        # Both thresholds placed: the bearing between them is the heading.
        if len(ends) == 2 and None not in (ends[0]["lat"], ends[0]["lon"], ends[1]["lat"], ends[1]["lon"]):
            brg = _bearing(ends[0]["lat"], ends[0]["lon"], ends[1]["lat"], ends[1]["lon"])
            if ends[0]["true"] is None:
                ends[0]["true"] = brg
            if ends[1]["true"] is None:
                ends[1]["true"] = (brg + 180.0) % 360.0
        for i, e in enumerate(ends):
            m = _RWY_NAME.match(e["name"])
            number = int(m.group(1)) * 10 if m else None
            if e["true"] is None and len(ends) == 2 and ends[1 - i]["true"] is not None:
                e["true"] = (ends[1 - i]["true"] + 180.0) % 360.0
            if e["true"] is None and number is not None:
                e["true"] = (number + (declination or 0.0)) % 360.0
            if e["true"] is None:
                continue
            e["true"] = round(float(e["true"]) % 360.0, 1)
            e["mag"] = (round((e["true"] - declination) % 360.0) if declination is not None
                        else number if number is not None else round(e["true"]))
        ends = [e for e in ends if e.get("true") is not None]
        if not ends:
            continue
        out.append({
            "id": "/".join(e["name"] for e in ends), "ends": ends,
            "length": avn._num(r["length_ft"]), "width": avn._num(r["width_ft"]),  # noqa: SLF001
            "surface": surface_word(r["surface"]), "lighted": r["lighted"] == "1", "closed": r["closed"] == "1",
            "alignment": ends[0]["true"],
        })
    out.sort(key=lambda r: (r["closed"], -(r["length"] or 0)))
    return out


_FREQ_ORDER = ("ATIS", "D-ATIS", "AWOS", "ASOS", "CLD", "DEL", "CD", "GND", "TWR", "TOWER", "APP", "DEP", "A/D",
               "CTR", "CTAF", "UNIC", "UNICOM", "AFIS", "FSS", "RDO", "RADIO", "MULTICOM")


def frequencies(a: dict) -> list[dict]:
    """Every frequency the airport lists, the ones a departure needs first."""
    out = []
    for r in _world()["freqs"].get(a["ref"], []):
        mhz = avn._num(r["frequency_mhz"])  # noqa: SLF001
        if mhz is None:
            continue
        kind = r["type"].strip().upper()
        out.append({"type": kind, "name": (r["description"] or kind).strip(), "mhz": f"{mhz:.3f}".rstrip("0").rstrip(".")
                    if mhz % 1 else f"{mhz:.1f}"})
    rank = {k: i for i, k in enumerate(_FREQ_ORDER)}
    out.sort(key=lambda f: (rank.get(f["type"], len(rank)), float(f["mhz"])))
    return out


def info(a: dict, declination: Optional[float]) -> dict:
    """An OurAirports airport in the page's terms."""
    return {
        "ident": a["ident"], "icao": a["icao"] or a["gps"] or a["ident"], "iata": a["iata"], "local": a["local"],
        "name": a["name"], "type": a["type"], "typeWord": _TYPE_WORD.get(a["type"]), "lat": a["lat"], "lon": a["lon"],
        "elevFt": a["elevFt"], "country": a["country"], "countryName": a["countryName"], "region": a["region"],
        "municipality": a["municipality"], "scheduled": a["scheduled"], "wiki": a["wiki"], "home": a["home"],
        "runways": runways(a, declination), "freqs": frequencies(a),
    }


def search(query: str, reporting: set[str], limit: int = 20) -> list[dict]:
    """Airports by code (ICAO, IATA, GPS, local) or by words of their name,
    town or country: the ones that report weather first, then the bigger."""
    q = _plain(query.strip())
    if not q:
        return []
    w = _world()
    hits: list[tuple[tuple, dict]] = []
    seen = set()
    for code in (q, "K" + q):
        ref = w["codes"].get(code)
        if ref and ref not in seen:
            seen.add(ref)
            hits.append(((0, 0, 0), w["airports"][ref]))
    words = q.split()
    for ref, a in w["airports"].items():
        if ref in seen or a["type"] == "closed":
            continue
        codes = {c.upper() for c in (a["icao"], a["iata"], a["gps"], a["ident"], a["local"]) if c}
        if len(words) == 1 and q in codes:
            hits.append(((0, 0, 1), a))
            seen.add(ref)
            continue
        if all(t in a["find"] for t in words):
            key = a["icao"] or a["gps"] or a["ident"]
            starts = 0 if a["find"].startswith(q) else 1
            hits.append(((1, 0 if key in reporting else 1, _TYPE_RANK.get(a["type"], 9), starts), a))
            seen.add(ref)
    hits.sort(key=lambda h: h[0])
    out = []
    for _, a in hits[:limit]:
        key = a["icao"] or a["gps"] or a["ident"]
        out.append({"icao": key, "iata": a["iata"], "faa": a["local"] if a["country"] == "US" else None,
                    "name": a["name"], "municipality": a["municipality"], "state": a["region"],
                    "country": a["countryName"] or a["country"], "type": _TYPE_WORD.get(a["type"]),
                    "lat": a["lat"], "lon": a["lon"], "reporting": key in reporting})
    return out


def nearby_airports(lat: float, lon: float, nm: float, skip: str, metars: dict[str, dict], most: int = 12) -> list[dict]:
    """The airports reporting weather within `nm`, nearest first, with their latest category."""
    out = []
    for icao, m in metars.items():
        if icao == skip:
            continue
        plon, plat = m["geometry"]["coordinates"]
        d = avn._nm(lat, lon, plat, plon)  # noqa: SLF001
        if d <= nm:
            p = m["properties"]
            a = lookup(icao)
            out.append({"icao": icao, "name": a["name"] if a else None, "nm": round(d), "brg": round(_bearing(lat, lon, plat, plon)),
                        "cat": p.get("cat"), "ceil": p.get("ceil"), "vis": p.get("vis"), "wdir": p.get("wdir"),
                        "wspd": p.get("wspd"), "wgst": p.get("wgst"), "wx": p.get("wx"), "temp": p.get("temp"),
                        "obs": p.get("obs"), "raw": p.get("raw")})
    out.sort(key=lambda x: x["nm"])
    return out[:most]


# ---------------------------------------------------------------------------
# FIRs
# ---------------------------------------------------------------------------
_VATSPY = "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master"
_FIR_ID = re.compile(r"^[A-Z]{4}$")


def _vatspy_text(name: str) -> str:
    path = avn._DISK / f"vatspy-{name}"  # noqa: SLF001
    try:
        fresh = time.time() - path.stat().st_mtime < _WEEK
    except OSError:
        fresh = False
    if not fresh:
        try:
            body = avn._get(f"{_VATSPY}/{name}").content  # noqa: SLF001
            avn._DISK.mkdir(parents=True, exist_ok=True)  # noqa: SLF001
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, path)
        except (requests.RequestException, OSError):
            if not path.exists():
                raise
    return path.read_text(encoding="utf-8", errors="replace")


def _fir_name(raw: str) -> str:
    """'Brasilia (Completo) - Brasilia' -> 'Brasilia'; 'Moscow Control' stays."""
    name = re.sub(r"\s*\([^)]*\)", "", raw).strip()
    if " - " in name:
        name = name.split(" - ")[-1].strip()
    return name


def firs() -> dict:
    """The world's flight information regions, outlined and named."""
    def make() -> dict:
        import json  # noqa: PLC0415 - only here
        names: dict[str, tuple[str, bool]] = {}
        section = ""
        for line in _vatspy_text("VATSpy.dat").splitlines():
            if line.startswith("["):
                section = line.strip()
                continue
            if section != "[FIRs]" or not line or line.startswith(";"):
                continue
            parts = line.split("|")
            if len(parts) < 4:
                continue
            icao, name, prefix, boundary = parts[0], parts[1], parts[2], parts[3]
            # The FIR's own entry (no callsign prefix) names it; an upper
            # sector of the same boundary does not.
            key = boundary or icao
            upper = "upper" in name.lower() or "FL" in name and "+" in name
            if key not in names or (not prefix and not upper):
                names[key] = (_fir_name(name), upper)
        data = json.loads(_vatspy_text("Boundaries.geojson"))
        out = []
        for f in data.get("features", []):
            p = f.get("properties") or {}
            fid = str(p.get("id") or "")
            if not _FIR_ID.match(fid):
                continue
            name = names.get(fid, (fid, False))[0]
            out.append({"type": "Feature", "geometry": f.get("geometry"), "properties": {
                "id": fid, "name": name, "oceanic": str(p.get("oceanic")) == "1",
                "labelLon": avn._num(p.get("label_lon")), "labelLat": avn._num(p.get("label_lat")),  # noqa: SLF001
                "region": p.get("region"),
            }})
        return avn._fc(out)  # noqa: SLF001
    return avn._cached("firs", _WEEK, make)  # noqa: SLF001


def fir_at(lat: float, lon: float) -> Optional[dict]:
    for f in firs()["features"]:
        if avn._contains(f["geometry"], lon, lat):  # noqa: SLF001
            return f["properties"]
    return None


# ---------------------------------------------------------------------------
# Standard atmosphere and flight levels
# ---------------------------------------------------------------------------
# The FB forecast's heights; the two highest are where the FB stops being given.
ALOFT_FT = (3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000, 30000, 34000, 39000, 45000, 53000)


def std_pressure(ft: float) -> float:
    """The pressure (hPa) at a pressure altitude: a flight level is a pressure."""
    return 1013.25 * (1.0 - ft / 145366.45) ** (1.0 / 0.190284)


def pressure_altitude(hpa: float) -> float:
    return 145366.45 * (1.0 - (hpa / 1013.25) ** 0.190284)


# ---------------------------------------------------------------------------
# GFS winds and temperatures aloft, for the map
# ---------------------------------------------------------------------------
_GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.0p25.f{fff}"
_GFS_LEVELS = (1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200,
               150, 100, 70, 50)
_HAVE: dict[str, tuple[float, bool]] = {}


def _gfs_url(run: datetime, fh: int) -> str:
    return _GFS.format(ymd=run.strftime("%Y%m%d"), hh=run.strftime("%H"), fff=f"{fh:03d}")


def _exists(url: str) -> bool:
    hit = _HAVE.get(url)
    if hit and (hit[1] or time.time() - hit[0] < 300):
        return hit[1]
    try:
        r = avn._SESSION.head(url + ".idx", timeout=(8, 20))  # noqa: SLF001
        ok = r.status_code == 200
    except requests.RequestException:
        ok = False
    _HAVE[url] = (time.time(), ok)
    return ok


def gfs_run(lead_h: float) -> tuple[datetime, int, str]:
    """The newest GFS run with the hour nearest now + `lead_h` already out:
    (run, forecast hour, file URL)."""
    now = datetime.now(timezone.utc)
    target = now + timedelta(hours=lead_h)
    run = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 6)
    for _ in range(6):
        fh = int(round((target - run).total_seconds() / 3600.0))
        fh = max(0, min(fh, 120))
        url = _gfs_url(run, fh)
        if _exists(url):
            return run, fh, url
        run -= timedelta(hours=6)
    raise RuntimeError("No GFS run is out on AWS for that hour yet")


def _bracket(p: float) -> tuple[int, int, float]:
    """The GFS levels either side of `p` hPa, and how far between them (in log p)."""
    levels = _GFS_LEVELS
    if p >= levels[0]:
        return levels[0], levels[0], 0.0
    for lo, hi in zip(levels, levels[1:]):
        if lo >= p >= hi:
            w = math.log(lo / p) / math.log(lo / hi)
            return lo, hi, w
    return levels[-1], levels[-1], 0.0


def gfs_aloft(height_ft: int, lead_h: float = 6.0, step: float = 2.5) -> dict:
    """GFS wind and temperature at one altitude, on a `step`-degree grid over
    the world: the FB forecast's numbers where it has no station.

    Below 18,000 ft the altitude is taken as a pressure altitude too: the
    difference from the true altitude is a few hundred feet, less than the
    space between the FB's own heights."""
    height_ft = int(height_ft)
    lead_h = float(lead_h)
    run, fh, url = gfs_run(lead_h)

    def make() -> dict:
        from model_sources import values_at  # noqa: PLC0415 - the byte-range reader the models use

        p = std_pressure(height_ft)
        lo, hi, w = _bracket(p)
        names = [f"{v}:{lv} mb" for lv in sorted({lo, hi}) for v in ("UGRD", "VGRD", "TMP")] + ["HGT:surface"]
        with ThreadPoolExecutor(max_workers=len(names)) as pool:
            got = dict(zip(names, pool.map(lambda n: values_at(url, n), names)))
        if any(v is None for v in got.values()):
            raise RuntimeError("The GFS file is missing a level")
        lats = np.arange(-80.0, 80.0 + 1e-6, step)
        lons = np.arange(-180.0, 180.0 - 1e-6, step)
        glat, glon = np.meshgrid(lats, lons, indexing="ij")
        # The 0.25 deg file runs from 90N down and from 0E round.
        rows = np.clip(np.round((90.0 - glat) / 0.25).astype(int), 0, 720)
        cols = np.round((glon % 360.0) / 0.25).astype(int) % 1440

        def at(name: str) -> np.ndarray:
            return got[name][rows, cols].astype(np.float64)

        def level(var: str) -> np.ndarray:
            a, b = at(f"{var}:{lo} mb"), at(f"{var}:{hi} mb")
            return a + (b - a) * w

        u, v, t = level("UGRD"), level("VGRD"), level("TMP") - 273.15
        terrain_ft = at("HGT:surface") * 3.28084
        spd = np.hypot(u, v) * 1.943844
        wdir = (np.degrees(np.arctan2(-u, -v)) + 360.0) % 360.0
        feats = []
        key = str(height_ft)
        for j in range(glat.shape[0]):
            for i in range(glat.shape[1]):
                # Like the FB: nothing within 1,500 ft of the ground.
                if terrain_ft[j, i] > height_ft - 1500:
                    continue
                s = float(spd[j, i])
                feats.append({"type": "Feature",
                              "geometry": {"type": "Point", "coordinates": [round(float(glon[j, i]), 2),
                                                                            round(float(glat[j, i]), 2)]},
                              "properties": {"id": f"{glat[j, i]:.1f},{glon[j, i]:.1f}", "levels": {key: {
                                  "dir": None if s < 5 else int(round(float(wdir[j, i]) / 10.0) * 10) % 360 or 360,
                                  "spd": int(round(s)), "temp": int(round(float(t[j, i]))), "lv": s < 5}}}})
        valid = run + timedelta(hours=fh)
        return {"type": "FeatureCollection", "features": feats, "heights": [height_ft], "source": "gfs",
                "run": int(run.timestamp()), "fh": fh, "validUnix": int(valid.timestamp()),
                "valid": valid.strftime("%d%H%M"), "use": f"GFS {run:%H}Z +{fh} h, valid {valid:%d %H}Z",
                "pressure": round(p, 1), "levelsUsed": sorted({lo, hi}, reverse=True)}
    return avn._cached(f"gfsaloft:{height_ft}:{url}:{step}", 3600.0, make)  # noqa: SLF001


# ---------------------------------------------------------------------------
# One airport's profile, hour by hour (Open-Meteo)
# ---------------------------------------------------------------------------
_OM = "https://api.open-meteo.com/v1/forecast"
_OM_LEVELS = (1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50)
_OM_MODELS = {"gfs": ("gfs_seamless", "GFS"), "ecmwf": ("ecmwf_ifs025", "ECMWF IFS"),
              "icon": ("icon_seamless", "ICON")}
_SURFACE_VARS = ("temperature_2m", "dew_point_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
                 "visibility", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "freezing_level_height",
                 "cape", "pressure_msl", "precipitation", "weather_code")


def _om_fetch(lat: float, lon: float, model: str) -> dict:
    om = _OM_MODELS[model][0]
    hourly = list(_SURFACE_VARS)
    for lv in _OM_LEVELS:
        for v in ("temperature", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height",
                  "cloud_cover"):
            hourly.append(f"{v}_{lv}hPa")
    r = avn._SESSION.get(_OM, params={  # noqa: SLF001
        "latitude": round(lat, 3), "longitude": round(lon, 3), "hourly": ",".join(hourly), "models": om,
        "forecast_hours": 72, "past_hours": 3, "wind_speed_unit": "kn", "timeformat": "unixtime",
        "cell_selection": "nearest",
    }, timeout=(8, 40))
    data = r.json()
    if not r.ok or (isinstance(data, dict) and data.get("error")):
        raise RuntimeError(data.get("reason") if isinstance(data, dict) else f"Open-Meteo HTTP {r.status_code}")
    return data


def _layer_risk(t_c: float, rh: float, cc: float) -> int:
    """Icing potential in a model level: 0 none, 1 light, 2 moderate, 3 severe.
    Supercooled cloud is the ingredient: below freezing, above -20 C, saturated
    or cloudy; the worst is the few degrees below zero in saturated air, where
    the drops are biggest."""
    if t_c is None or rh is None or not (-20.0 <= t_c <= 0.0):
        return 0
    cloudy = (cc or 0) >= 50.0 or rh >= 90.0
    if not cloudy and rh < 85.0:
        return 0
    if rh >= 97.0 and -10.0 <= t_c <= -1.0:
        return 3 if (cc or 0) >= 90.0 else 2
    if rh >= 92.0 and -15.0 <= t_c <= 0.0:
        return 2
    return 1


def profile(lat: float, lon: float, elev_ft: Optional[float], model: str = "gfs") -> dict:
    """What the model says the air over the airport does for three days, hour
    by hour and level by level, and what that means for flying: the FB table
    at any airport, the cloud, icing and turbulence layers, the freezing level
    and the tropopause."""
    model = model if model in _OM_MODELS else "gfs"

    def make() -> dict:
        data = _om_fetch(lat, lon, model)
        h = data.get("hourly") or {}
        times = [int(t) for t in h.get("time") or []]
        nt = len(times)

        def col(name: str) -> list[Optional[float]]:
            v = h.get(name) or [None] * nt
            return [None if x is None else float(x) for x in v]

        levels = []
        for lv in _OM_LEVELS:
            gh = col(f"geopotential_height_{lv}hPa")
            if all(x is None for x in gh):
                continue
            levels.append({
                "p": lv, "ft": [None if x is None else round(x * 3.28084) for x in gh],
                "t": col(f"temperature_{lv}hPa"), "rh": col(f"relative_humidity_{lv}hPa"),
                "spd": col(f"wind_speed_{lv}hPa"), "dir": col(f"wind_direction_{lv}hPa"),
                "cc": col(f"cloud_cover_{lv}hPa"),
            })
        ground = elev_ft if elev_ft is not None else (data.get("elevation") or 0) * 3.28084
        sfc = {k: col(k) for k in _SURFACE_VARS}

        # Per hour: the turbulence (Richardson number and shear) and icing in
        # each layer between two levels, the tropopause, the freezing level.
        layers_turb, layers_ice, trop, frz = [], [], [], []
        for k in range(nt):
            prof = []
            for L in levels:
                ft, t, rh, spd, d, cc = (L["ft"][k], L["t"][k], L["rh"][k], L["spd"][k], L["dir"][k], L["cc"][k])
                if ft is None or t is None or spd is None or d is None or ft < ground:
                    continue
                u = -spd * math.sin(math.radians(d))
                v = -spd * math.cos(math.radians(d))
                prof.append((L["p"], ft, t, rh, u, v, cc))
            tk, ik = [], []
            for a, b in zip(prof, prof[1:]):
                dz_ft = b[1] - a[1]
                if dz_ft <= 0:
                    continue
                dz = dz_ft * 0.3048
                shear_kt = math.hypot(b[4] - a[4], b[5] - a[5])
                per_k = shear_kt / dz_ft * 1000.0
                th_a = (a[2] + 273.15) * (1000.0 / a[0]) ** 0.2857
                th_b = (b[2] + 273.15) * (1000.0 / b[0]) ** 0.2857
                n2 = 9.81 / (0.5 * (th_a + th_b)) * (th_b - th_a) / dz
                s2 = (shear_kt * 0.514444 / dz) ** 2
                ri = n2 / s2 if s2 > 1e-10 else 99.0
                # Shear of 6 kt per 1,000 ft, or a Richardson number under a
                # half with 4 kt, is where clear-air turbulence starts: 9 kt
                # (or Ri under a quarter with 6) moderate, 12 severe.
                risk = 0
                if per_k >= 12 or (ri < 0.25 and per_k >= 9):
                    risk = 3
                elif per_k >= 9 or (ri < 0.25 and per_k >= 6):
                    risk = 2
                elif per_k >= 6 or (ri < 0.5 and per_k >= 4):
                    risk = 1
                if risk:
                    tk.append({"base": a[1], "top": b[1], "risk": risk, "shear": round(per_k, 1),
                               "ri": round(ri, 2) if ri < 99 else None})
                ice = max(_layer_risk(a[2], a[3], a[6]), _layer_risk(b[2], b[3], b[6]))
                if ice and _layer_risk(a[2], a[3], a[6]) and _layer_risk(b[2], b[3], b[6]):
                    ik.append({"base": a[1], "top": b[1], "risk": ice})
            layers_turb.append(tk)
            layers_ice.append(ik)
            # The WMO tropopause: the lowest level above 500 hPa where the lapse
            # rate drops to 2 K/km or less.
            tp = None
            for a, b in zip(prof, prof[1:]):
                if a[0] > 500:
                    continue
                dz_km = (b[1] - a[1]) * 0.0003048
                if dz_km > 0 and (a[2] - b[2]) / dz_km <= 2.0:
                    tp = a[1]
                    break
            trop.append(tp)
            fl = sfc["freezing_level_height"][k]
            if fl is not None:
                frz.append(round(fl * 3.28084))
            else:
                # Not every model gives it (the IFS on Open-Meteo does not):
                # the lowest height where the column crosses 0 C going up.
                cross = None
                for a, b in zip(prof, prof[1:]):
                    if a[2] >= 0.0 > b[2]:
                        cross = a[1] + (a[2] / (a[2] - b[2])) * (b[1] - a[1])
                        break
                frz.append(None if cross is None else round(cross))

        # The FB table: wind and temperature at its heights, now and 6, 12, 24 h on.
        now = time.time()
        fb = []
        for lead in (0, 6, 12, 24):
            k = min(range(nt), key=lambda i: abs(times[i] - (now + lead * 3600))) if nt else None
            if k is None:
                continue
            row = {"lead": lead, "t": times[k], "levels": {}}
            pts = []
            for L in levels:
                ft, t, spd, d = L["ft"][k], L["t"][k], L["spd"][k], L["dir"][k]
                if None in (ft, t, spd, d):
                    continue
                pts.append((ft, t, -spd * math.sin(math.radians(d)), -spd * math.cos(math.radians(d)), L["p"]))
            pts.sort()
            for hft in ALOFT_FT:
                if hft < ground + 1500 or len(pts) < 2:
                    continue
                # Under 18,000 ft by altitude; above it a flight level is a pressure.
                if hft >= 18000:
                    p = std_pressure(hft)
                    seq = sorted(pts, key=lambda x: -x[4])
                    a = b = None
                    for x, y in zip(seq, seq[1:]):
                        if x[4] >= p >= y[4]:
                            a, b = x, y
                            break
                    if a is None:
                        continue
                    w = math.log(a[4] / p) / math.log(a[4] / b[4])
                else:
                    a = b = None
                    for x, y in zip(pts, pts[1:]):
                        if x[0] <= hft <= y[0]:
                            a, b = x, y
                            break
                    if a is None:
                        continue
                    w = (hft - a[0]) / max(b[0] - a[0], 1)
                tt = a[1] + (b[1] - a[1]) * w
                uu = a[2] + (b[2] - a[2]) * w
                vv = a[3] + (b[3] - a[3]) * w
                s = math.hypot(uu, vv)
                dd = (math.degrees(math.atan2(-uu, -vv)) + 360.0) % 360.0
                row["levels"][str(hft)] = {"dir": None if s < 5 else round(dd), "spd": round(s),
                                           "temp": round(tt), "lv": s < 5}
            fb.append(row)
        return {
            "model": model, "modelLabel": _OM_MODELS[model][1], "lat": data.get("latitude"),
            "lon": data.get("longitude"), "gridElevFt": round((data.get("elevation") or 0) * 3.28084),
            "groundFt": round(ground), "times": times, "levels": levels, "surface": sfc,
            "turbulence": layers_turb, "icing": layers_ice, "tropopause": trop, "freezing": frz, "fb": fb,
            "heights": list(ALOFT_FT),
        }
    return avn._cached(f"profile:{model}:{lat:.2f}:{lon:.2f}", 1800.0, make)  # noqa: SLF001
