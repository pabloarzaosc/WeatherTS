"""CPC's 8-14 day hazards outlook, read from CPC's own shapefiles.

NOAA's MapServer (hazards/cpc_weather_hazards) still has its 8-14 day layers,
but they come back empty: CPC now issues these hazards as probabilities
("Slight Risk of Heavy Precipitation" where the chance passes 20%), filed as
*prob shapefiles next to deterministic ones that are empty too -- checked
2026-09-25, when CPC's page listed heavy rain, cold and wind risks and the
MapServer had none. The prob files are linked from CPC's hazards page, dated,
in a Lambert conformal projection; this reads them with no GIS library (the
packaged backend has none) and hands back GeoJSON in degrees.
"""
from __future__ import annotations

import io
import math
import re
import struct
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import requests

PAGE = "https://www.cpc.ncep.noaa.gov/products/predictions/threats/threats.php"
_ZIP = re.compile(r"https://ftp\.cpc\.ncep\.noaa\.gov/GIS/us_hazards/([A-Za-z]+)_D8-14_(\d{8})\.zip")
_TTL = 1800.0
_CACHE: dict[str, tuple[float, dict]] = {}
_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Shapefile and dBASE, the few record types these files use
# ---------------------------------------------------------------------------

def _dbf(data: bytes) -> list[dict[str, str]]:
    n = struct.unpack("<I", data[4:8])[0]
    hlen, rlen = struct.unpack("<HH", data[8:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode("latin-1")
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for i in range(n):
        rec = data[hlen + i * rlen: hlen + (i + 1) * rlen]
        off = 1
        row = {}
        for name, flen in fields:
            row[name] = rec[off:off + flen].decode("latin-1").strip()
            off += flen
        rows.append(row)
    return rows


def _shp(data: bytes) -> list[Optional[list[list[tuple[float, float]]]]]:
    """Polygon records (type 5) as rings of (x, y)."""
    shapes: list[Optional[list[list[tuple[float, float]]]]] = []
    pos = 100
    while pos + 8 <= len(data):
        clen = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        rec = data[pos + 8: pos + 8 + clen * 2]
        pos += 8 + clen * 2
        if struct.unpack("<i", rec[:4])[0] == 0:
            shapes.append(None)
            continue
        nparts, npoints = struct.unpack("<ii", rec[36:44])
        parts = struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])
        pts = struct.unpack(f"<{2 * npoints}d", rec[44 + 4 * nparts: 44 + 4 * nparts + 16 * npoints])
        coords = [(pts[2 * i], pts[2 * i + 1]) for i in range(npoints)]
        shapes.append([coords[parts[k]: parts[k + 1] if k + 1 < nparts else npoints] for k in range(nparts)])
    return shapes


# ---------------------------------------------------------------------------
# Lambert conformal conic, inverse (Snyder, Map Projections, 15-7 and 15-9)
# ---------------------------------------------------------------------------

def _prj_params(wkt: str) -> dict[str, float]:
    def param(name: str, default: float) -> float:
        m = re.search(rf'PARAMETER\["{name}",\s*(-?[\d.]+)\]', wkt, re.I)
        return float(m.group(1)) if m else default

    sph = re.search(r'SPHEROID\["[^"]*",\s*([\d.]+),\s*([\d.]+)\]', wkt)
    a = float(sph.group(1)) if sph else 6378137.0
    inv_f = float(sph.group(2)) if sph else 298.257222101
    return {
        "a": a,
        "f": 1.0 / inv_f,
        "x0": param("False_Easting", 0.0),
        "y0": param("False_Northing", 0.0),
        "lon0": param("Central_Meridian", -96.0),
        "lat1": param("Standard_Parallel_1", 20.0),
        "lat2": param("Standard_Parallel_2", 60.0),
        "lat0": param("Latitude_Of_Origin", 40.0),
    }


def _lcc_inverse(p: dict[str, float]):
    a, f = p["a"], p["f"]
    e = math.sqrt(2 * f - f * f)
    rad = math.radians

    def m(phi: float) -> float:
        return math.cos(phi) / math.sqrt(1 - (e * math.sin(phi)) ** 2)

    def t(phi: float) -> float:
        return math.tan(math.pi / 4 - phi / 2) / ((1 - e * math.sin(phi)) / (1 + e * math.sin(phi))) ** (e / 2)

    p1, p2, p0 = rad(p["lat1"]), rad(p["lat2"]), rad(p["lat0"])
    n = (math.log(m(p1)) - math.log(m(p2))) / (math.log(t(p1)) - math.log(t(p2))) if p1 != p2 else math.sin(p1)
    F = m(p1) / (n * t(p1) ** n)
    rho0 = a * F * t(p0) ** n
    lon0 = rad(p["lon0"])

    def inv(x: float, y: float) -> tuple[float, float]:
        dx = x - p["x0"]
        dy = rho0 - (y - p["y0"])
        rho = math.copysign(math.hypot(dx, dy), n)
        tt = (rho / (a * F)) ** (1 / n)
        theta = math.atan2(math.copysign(1, n) * dx, math.copysign(1, n) * dy)
        lon = theta / n + lon0
        phi = math.pi / 2 - 2 * math.atan(tt)
        for _ in range(8):
            es = e * math.sin(phi)
            phi = math.pi / 2 - 2 * math.atan(tt * ((1 - es) / (1 + es)) ** (e / 2))
        return round(math.degrees(lon), 4), round(math.degrees(phi), 4)

    return inv


# ---------------------------------------------------------------------------

def _read_zip(url: str) -> list[dict]:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    shp = next((n for n in names if n.lower().endswith(".shp")), None)
    dbf = next((n for n in names if n.lower().endswith(".dbf")), None)
    prj = next((n for n in names if n.lower().endswith(".prj")), None)
    if not shp or not dbf:
        return []
    shapes = _shp(z.read(shp))
    rows = _dbf(z.read(dbf))
    wkt = z.read(prj).decode("latin-1") if prj else ""
    inv = _lcc_inverse(_prj_params(wkt)) if "Lambert" in wkt else (lambda x, y: (round(x, 4), round(y, 4)))
    out = []
    for rings, row in zip(shapes, rows):
        if not rings:
            continue
        # Shapefile rings: clockwise outer boundaries, each followed by its
        # counter-clockwise holes.
        polys: list[list[list[list[float]]]] = []
        for ring in rings:
            area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))
            coords = [list(inv(x, y)) for x, y in ring]
            if area <= 0 or not polys:
                polys.append([coords])
            else:
                polys[-1].append(coords)
        out.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1
            else {"type": "MultiPolygon", "coordinates": polys},
            "properties": {
                "label": row.get("Label") or row.get("LABEL") or "Hazard",
                "start": row.get("Start_Date") or None,
                "end": row.get("End_Date") or None,
            },
        })
    return out


def hazards_8_14() -> dict[str, Any]:
    """Every 8-14 day hazard CPC has out now, as one GeoJSON collection."""
    with _LOCK:
        hit = _CACHE.get("8-14")
        if hit and time.time() - hit[0] < _TTL:
            return hit[1]
    page = requests.get(PAGE, timeout=30).text
    links = sorted(set(_ZIP.findall(page)))
    issued = max((d for _, d in links), default=None)
    urls = [f"https://ftp.cpc.ncep.noaa.gov/GIS/us_hazards/{kind}_D8-14_{d}.zip" for kind, d in links]
    with ThreadPoolExecutor(8) as ex:
        parts = list(ex.map(lambda u: _safe(_read_zip, u), urls))
    features = [f for part in parts for f in part]
    out = {"type": "FeatureCollection", "features": features,
           "issued": f"{issued[:4]}-{issued[4:6]}-{issued[6:8]}T00:00:00Z" if issued else None}
    with _LOCK:
        _CACHE["8-14"] = (time.time(), out)
    return out


def _safe(fn, *args):
    try:
        return fn(*args)
    except Exception:  # noqa: BLE001 - one file missing leaves the rest
        return []
