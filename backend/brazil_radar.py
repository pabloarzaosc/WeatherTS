"""
Brazilian weather radars, read into the polar format the NEXRAD viewer draws,
with every moment they fly and the products made from them.

No Brazilian network publishes its volumes openly in real time. CEMADEN lists
every volume of its nine dual-polarization S-band radars (every moment, every
10 minutes, about 17 days kept), but each download passes a CAPTCHA, which
nothing here answers or goes around; the Santa Catarina Defesa Civil, the
SIPAM and the REDEMET publish pictures only. So every volume reaches the store
through import_file, by one of three roads:

    a file of the user's own   one they already have, handed to import_file
    NASA's GPM-VN archive      the CEMADEN volumes of the days a GPM satellite
                               passes over, republished openly by NASA
                               (scripts/import_nasa_cemaden.py): the archive cases
    the WeatherTS radar relay  live, once CEMADEN grants the relay access: it
                               fetches each file once and the app follows it
                               (radar_relay_client.py marks those volumes
                               "source": "relay" and prunes them; EXTRA_SITES
                               lists its radars before their first volume lands)

in any of the formats these radars write:

    Rainbow 5 (.vol)      Gematronik, one moment a file: CEMADEN, Santa Catarina
    GAMIC HDF5            Rainbow's HDF5 export, every moment in one file
    ODIM_H5               the European standard
    CF/Radial (netCDF4)   NCAR's standard; how NASA's GPM Ground Validation
                          archive republishes whole CEMADEN volumes (.cf.gz)

Any of them may come gzipped (read_any unpacks it); the store keeps the file
as it came.

Each volume is kept on disk under ~/.weatherts/radar-br/<radar>/<time>/ and
offered to the radar viewer as if the radar were one more NEXRAD site, through
the same /api/nexrad routes. Per elevation: reflectivity (filtered and not),
velocity (unfolded against the model's wind), storm-relative velocity,
spectrum width, ZDR, correlation coefficient, KDP, differential phase, NROT,
hydrometeor classification (Park et al. 2009) and dual-pol rain rate. From the
whole volume: composite reflectivity, echo tops, VIL, and the hail products
of Witt et al. (1998): SHI, MEHS and POSH, against the model's 0 C and -20 C
heights over the radar.
"""
from __future__ import annotations

import io
import json
import math
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
import zlib
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Collection, Optional

import numpy as np
import requests

STORE = Path(os.environ.get("WEATHERTS_RADAR_BR", str(Path.home() / ".weatherts" / "radar-br")))
RE_EFF_KM = 6371.0 * 4.0 / 3.0
_MS_TO_KT = 1.943844
_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# The radars
# ---------------------------------------------------------------------------
# Positions: from a volume where one has been read, otherwise the middle of
# the 250 km coverage box each operator publishes (the first file read
# corrects it).
RADARS: dict[str, dict[str, Any]] = {
    "BR-ALM": {"name": "Almenara (MG)", "op": "CEMADEN", "lat": -16.1862, "lon": -40.6507, "band": "S", "cemaden": "almenara"},
    "BR-JAR": {"name": "Jaraguari (MS)", "op": "CEMADEN", "lat": -20.2592, "lon": -54.4424, "band": "S", "cemaden": "jaraguari"},
    "BR-MCZ": {"name": "Maceió (AL)", "op": "CEMADEN", "lat": -9.5409, "lon": -35.7587, "band": "S", "cemaden": "maceio"},
    "BR-NAT": {"name": "Natal (RN)", "op": "CEMADEN", "lat": -5.8969, "lon": -35.2479, "band": "S", "cemaden": "natal"},
    "BR-PTL": {"name": "Petrolina (PE)", "op": "CEMADEN", "lat": -9.3567, "lon": -40.5613, "band": "S", "cemaden": "petrolina"},
    "BR-SSA": {"name": "Salvador (BA)", "op": "CEMADEN", "lat": -12.9025, "lon": -38.3267, "band": "S", "cemaden": "salvador"},
    "BR-STE": {"name": "Santa Teresa (ES)", "op": "CEMADEN", "lat": -19.9698, "lon": -40.5484, "band": "S", "cemaden": "santa_teresa"},
    "BR-SFR": {"name": "São Francisco (MG)", "op": "CEMADEN", "lat": -15.9932, "lon": -44.6726, "band": "S", "cemaden": "sao_francisco"},
    "BR-TMA": {"name": "Três Marias (MG)", "op": "CEMADEN", "lat": -18.1896, "lon": -45.4328, "band": "S", "cemaden": "tres_marias"},
    "BR-LON": {"name": "Lontras (SC)", "op": "Defesa Civil SC", "lat": -27.230154, "lon": -49.461029, "band": "S"},
    "BR-CHP": {"name": "Chapecó (SC)", "op": "Defesa Civil SC", "lat": -27.0366, "lon": -52.6023, "band": "S"},
    "BR-ARA": {"name": "Araranguá (SC)", "op": "Defesa Civil SC", "lat": -28.9321, "lon": -49.3623, "band": "S"},
    "BR-PNV": {"name": "Ponte Nova (SP)", "op": "DAEE/SAISP", "lat": -23.600795, "lon": -45.97279, "band": "S"},
}
# The site codes of NASA's GPM Ground Validation archive (pmm-gv.gsfc.nasa.gov,
# Radar/VN/GPM/<code>/), which republishes CEMADEN volumes of the days a GPM
# satellite passes over: the code is the file's instrument_name.
NASA_GV_SITES = {"AL1": "BR-ALM", "JG1": "BR-JAR", "MC1": "BR-MCZ", "NT1": "BR-NAT", "PE1": "BR-PTL",
                 "SV1": "BR-SSA", "ST1": "BR-STE", "SF1": "BR-SFR", "TM1": "BR-TMA"}
# What the files call the radars, beside their position.
_ALIASES = {"LONT": "BR-LON", "LONTRAS": "BR-LON", "PNOVA2": "BR-PNV", "PNOVA": "BR-PNV", "CHAP": "BR-CHP",
            "CHAPECO": "BR-CHP", "ARAR": "BR-ARA", "ARARANGUA": "BR-ARA", **NASA_GV_SITES}


def is_br(site: str) -> bool:
    """A radar read through this module: Brazil's, or Europe's (opera_radar.py)."""
    return str(site or "").upper().startswith(("BR-", "EU-"))


# Radars whose volumes are put together from somewhere when asked for, not kept
# beforehand: set by opera_radar.install(). Has handles(radar), scans(), nearest(),
# inventory(), parts(), volume(), frame_paths(), is_young() and quiet_note().
REMOTE: Any = None


def _remote(radar: str) -> bool:
    return REMOTE is not None and REMOTE.handles(radar)


class NoData(LookupError):
    """A remote radar has nothing for this request: gone quiet, or no such moment in
    this frame. Asking again gets the same answer, so no retries (main.py: 400)."""


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(min(1.0, a)))


def _radar_for(ident: str, name: str, lat: Optional[float], lon: Optional[float]) -> str:
    """Our id for the radar a file came from: by its name, else by where it is."""
    for token in (ident, name):
        t = re.sub(r"[^A-Z0-9]", "", str(token or "").upper())
        if t in _ALIASES:
            return _ALIASES[t]
        for rid, r in RADARS.items():
            if t and t in re.sub(r"[^A-Z0-9]", "", r["name"].upper()):
                return rid
    if lat is not None and lon is not None:
        best = min(RADARS.items(), key=lambda kv: _km(lat, lon, kv[1]["lat"], kv[1]["lon"]))
        if _km(lat, lon, best[1]["lat"], best[1]["lon"]) < 25.0:
            return best[0]
    t = re.sub(r"[^A-Z0-9]", "", str(ident or name or "RADAR").upper())[:6] or "RADAR"
    return f"BR-{t}"


# ---------------------------------------------------------------------------
# A volume: sweeps of moments
# ---------------------------------------------------------------------------
@dataclass
class Sweep:
    elev: float
    az: np.ndarray            # ray start azimuths, sorted ascending (deg)
    r0_km: float              # start of the first gate
    dr_km: float              # gate length
    unix: int
    data: dict[str, np.ndarray] = field(default_factory=dict)   # moment -> (rays, gates), physical units
    nyquist: Optional[float] = None                             # m/s

    @property
    def nrays(self) -> int:
        return int(self.az.size)


@dataclass
class Volume:
    radar: str
    ident: str
    name: str
    lat: float
    lon: float
    alt_m: float
    unix: int
    sweeps: list[Sweep]
    files: list[str] = field(default_factory=list)
    wavelength_m: Optional[float] = None
    zdr_offset_db: Optional[float] = None   # ZDR calibration offset the reader took out (dB), if it did
    listed: Optional[frozenset] = None      # info.json's "files" when load() read the folder
    ladder: Optional[list[dict]] = None     # a remote radar's tilts as meta.elevations lists them


# Canonical moment names, from what each format calls them.
_RAINBOW_MOMENTS = {"dBZ": "DBZH", "dBuZ": "TH", "V": "VRAD", "W": "WRAD", "ZDR": "ZDR", "uZDR": "UZDR",
                    "RhoHV": "RHOHV", "uRhoHV": "URHOHV", "KDP": "KDP", "uKDP": "UKDP", "PhiDP": "PHIDP",
                    "uPhiDP": "UPHIDP", "SQI": "SQI", "SNR": "SNR", "LDR": "LDR", "dBZv": "DBZV"}
_GAMIC_MOMENTS = {"Z": "DBZH", "UZ": "TH", "V": "VRAD", "W": "WRAD", "ZDR": "ZDR", "PHIDP": "PHIDP",
                  "UPHIDP": "UPHIDP", "KDP": "KDP", "RHOHV": "RHOHV", "UZDR": "UZDR", "URHOHV": "URHOHV",
                  "SQI": "SQI", "SNR": "SNR", "LDR": "LDR", "ZV": "DBZV"}
_ODIM_MOMENTS = {"DBZH": "DBZH", "DBZ": "DBZH", "TH": "TH", "VRADH": "VRAD", "VRAD": "VRAD", "VRADDH": "VRAD",
                 "WRADH": "WRAD", "WRAD": "WRAD", "ZDR": "ZDR", "RHOHV": "RHOHV", "KDP": "KDP", "PHIDP": "PHIDP",
                 "UPHIDP": "UPHIDP", "SQIH": "SQI", "SNRH": "SNR", "LDR": "LDR", "DBZV": "DBZV"}


def _sorted(az: np.ndarray, data: dict[str, np.ndarray]) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Rays in azimuth order, so the renderer's edges are monotonic."""
    az = np.mod(np.asarray(az, dtype=np.float64), 360.0)
    order = np.argsort(az, kind="stable")
    return az[order].astype(np.float32), {k: v[order] for k, v in data.items()}


def _scaled(raw: np.ndarray, vmin: float, vmax: float, bits: int) -> np.ndarray:
    """Rainbow and GAMIC both keep 0 for no data and spread the rest over the
    range: value = min + (raw - 1) * (max - min) / (2^bits - 2)."""
    out = vmin + (raw.astype(np.float32) - 1.0) * np.float32((vmax - vmin) / (2 ** bits - 2))
    out[raw == 0] = np.nan
    return out


def _unix(s: str) -> Optional[int]:
    s = (s or "").strip().replace("Z", "+00:00")
    for fmt in (None, "%Y-%m-%dT%H:%M:%S", "%Y%m%d%H%M%S", "%Y-%m-%d %H:%M:%S"):
        try:
            d = datetime.fromisoformat(s) if fmt is None else datetime.strptime(s[:19], fmt)
            if d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            return int(d.timestamp())
        except ValueError:
            continue
    return None


# --- Rainbow 5 -------------------------------------------------------------
def _rb_blobs(raw: bytes) -> dict[int, bytes]:
    out: dict[int, bytes] = {}
    pos = raw.find(b"<BLOB ")
    while pos >= 0:
        head_end = raw.find(b">", pos)
        head = raw[pos:head_end].decode("latin-1")
        bid = int(re.search(r'blobid="(\d+)"', head).group(1))
        size = int(re.search(r'size="(\d+)"', head).group(1))
        comp = re.search(r'compression="([^"]*)"', head)
        start = head_end + 1
        if raw[start:start + 1] == b"\n":
            start += 1
        body = raw[start:start + size]
        # "qt": Qt's qCompress -- four bytes of the uncompressed length, then zlib.
        if comp and comp.group(1) == "qt":
            body = zlib.decompress(body[4:])
        out[bid] = body
        pos = raw.find(b"<BLOB ", start + size)
    return out


def read_rainbow(raw: bytes, name: str = "") -> Volume:
    """A Rainbow 5 volume file (one moment, every slice of the scan)."""
    end = raw.find(b"<!-- END XML -->")
    if end < 0:
        end = raw.find(b"<BLOB ")
    root = ET.fromstring(raw[:end].decode("latin-1"))
    blobs = _rb_blobs(raw)
    sens = root.find("sensorinfo")
    if sens is None:
        sens = root.find("radarinfo")
    lat = float(sens.findtext("lat")) if sens is not None and sens.findtext("lat") else None
    lon = float(sens.findtext("lon")) if sens is not None and sens.findtext("lon") else None
    alt = float(sens.findtext("alt") or 0.0) if sens is not None else 0.0
    ident = sens.get("id", "") if sens is not None else ""
    rname = sens.get("name", "") if sens is not None else ""
    wavelen = float(sens.findtext("wavelen")) if sens is not None and sens.findtext("wavelen") else None
    scan = root.find("scan")
    slices = scan.findall("slice") if scan is not None else []
    first = slices[0] if slices else None

    def param(sl: ET.Element, tag: str, default: Any = None) -> Any:
        # Later slices only carry what differs from the first.
        for s in (sl, first):
            if s is None:
                continue
            el = s.find(tag)
            if el is not None and (el.text or el.attrib):
                return el
        return default

    sweeps: list[Sweep] = []
    for sl in slices:
        sd = sl.find("slicedata")
        if sd is None:
            continue
        rd = sd.find("rawdata")
        ri = sd.find("rayinfo[@refid='startangle']")
        if ri is None:
            ri = sd.find("rayinfo")
        if rd is None or ri is None:
            continue
        rays, bins = int(rd.get("rays")), int(rd.get("bins"))
        depth = int(rd.get("depth", "8"))
        vmin, vmax = float(rd.get("min")), float(rd.get("max"))
        moment = _RAINBOW_MOMENTS.get(rd.get("type", ""), rd.get("type", "").upper())
        dt = ">u1" if depth == 8 else ">u2" if depth == 16 else ">u4"
        arr = np.frombuffer(blobs[int(rd.get("blobid"))], dtype=dt)[: rays * bins].reshape(rays, bins)
        vals = _scaled(arr, vmin, vmax, depth)
        adepth = int(ri.get("depth", "16"))
        adt = ">u1" if adepth == 8 else ">u2"
        ang = np.frombuffer(blobs[int(ri.get("blobid"))], dtype=adt)[:rays].astype(np.float64) * 360.0 / (2 ** adepth)
        elev_el = param(sl, "posangle")
        elev = float(elev_el.text) if elev_el is not None else 0.5
        step_el = param(sl, "rangestep")
        start_el = param(sl, "start_range")
        dr = float(step_el.text) if step_el is not None else 0.25
        r0 = float(start_el.text) if start_el is not None and start_el.text else 0.0
        t = _unix(f"{sd.get('date', scan.get('date', ''))}T{sd.get('time', scan.get('time', ''))}")
        nyq = None
        dynv = param(sl, "dynv")
        if dynv is not None and dynv.get("max"):
            nyq = abs(float(dynv.get("max")))
        az, data = _sorted(ang, {moment: vals})
        sweeps.append(Sweep(elev=elev, az=az, r0_km=r0, dr_km=dr, unix=t or 0, data=data, nyquist=nyq))
    when = _unix(root.get("datetime", "")) or (sweeps[0].unix if sweeps else 0)
    return Volume(radar=_radar_for(ident, rname, lat, lon), ident=ident, name=rname, lat=lat or 0.0, lon=lon or 0.0,
                  alt_m=alt, unix=when, sweeps=sweeps, files=[name], wavelength_m=wavelen)


# --- HDF5: GAMIC and ODIM --------------------------------------------------
def _attrs(o: Any) -> dict:
    out = {}
    for k, v in o.attrs.items():
        if isinstance(v, bytes):
            v = v.decode("utf-8", "replace")
        elif isinstance(v, np.ndarray) and v.dtype.kind == "S" and v.size == 1:
            v = v.item().decode("utf-8", "replace")
        out[k] = v
    return out


def read_hdf5(raw: bytes, name: str = "") -> Volume:
    import h5py  # noqa: PLC0415 - only for HDF5 files
    with h5py.File(io.BytesIO(raw), "r") as f:
        # CF/Radial first: its top-level "scan_rate" would pass for GAMIC's scan groups.
        if all(k in f for k in _CF_NEEDS):
            return read_cfradial(f, name)
        if any(k.startswith("scan") for k in f.keys()):
            return _read_gamic(f, name)
        return _read_odim(f, name)


def _read_gamic(f: Any, name: str) -> Volume:
    where = _attrs(f["where"]) if "where" in f else {}
    how = _attrs(f["how"]) if "how" in f else {}
    what = _attrs(f["what"]) if "what" in f else {}
    lat, lon = float(where.get("lat", 0.0)), float(where.get("lon", 0.0))
    ident = str(how.get("host_name", "") or "")
    wl = None
    sweeps: list[Sweep] = []
    for key in sorted((k for k in f.keys() if k.startswith("scan")), key=lambda s: int(s[4:])):
        S = f[key]
        sh = _attrs(S["how"])
        if str(_attrs(S["what"]).get("scan_type", "PPI")).upper() != "PPI":
            continue
        rh = S["ray_header"][()]
        az = np.asarray(rh["azimuth_start"], dtype=np.float64)
        data: dict[str, np.ndarray] = {}
        for mk in (k for k in S.keys() if k.startswith("moment_")):
            d = S[mk]
            a = _attrs(d)
            moment = _GAMIC_MOMENTS.get(str(a.get("moment", "")).upper(), str(a.get("moment", "")).upper())
            arr = d[()]
            fmt = str(a.get("format", ""))
            if arr.dtype.kind == "f":
                vals = arr.astype(np.float32)
            else:
                bits = 16 if "16" in fmt or arr.dtype.itemsize == 2 else 8
                vals = _scaled(arr, float(a.get("dyn_range_min", 0.0)), float(a.get("dyn_range_max", 1.0)), bits)
            data[moment] = vals
        nyq = None
        if "extended" in S["how"]:
            ext = _attrs(S["how"]["extended"])
            try:
                nyq = float(ext.get("nyquist_velocity"))
            except (TypeError, ValueError):
                nyq = None
        wl = wl or (float(sh["radar_wave_length"]) if "radar_wave_length" in sh else None)
        az, data = _sorted(az, data)
        sweeps.append(Sweep(elev=float(sh.get("elevation", 0.0)), az=az,
                            r0_km=float(sh.get("range_start", 0.0)) / 1000.0,
                            dr_km=float(sh.get("range_step", 250.0)) / 1000.0,
                            unix=_unix(str(sh.get("timestamp", ""))) or 0, data=data, nyquist=nyq))
    sweeps.sort(key=lambda s: s.elev)
    return Volume(radar=_radar_for(ident, ident, lat, lon), ident=ident, name=ident, lat=lat, lon=lon,
                  alt_m=float(where.get("height", 0.0)), unix=_unix(str(what.get("date", ""))) or
                  (sweeps[0].unix if sweeps else 0), sweeps=sweeps, files=[name], wavelength_m=wl)


def _read_odim(f: Any, name: str, keep_elev: Optional[Callable[[float], bool]] = None,
               keep_moments: Optional[Collection[str]] = None) -> Volume:
    """`keep_elev` and `keep_moments` leave the rest of the file unread: a loop on one
    tilt of a 27 MB volume (opera_radar.py) reads one dataset of it."""
    where = _attrs(f["where"]) if "where" in f else {}
    what = _attrs(f["what"]) if "what" in f else {}
    lat, lon = float(where.get("lat", 0.0)), float(where.get("lon", 0.0))
    source = str(what.get("source", ""))
    ident = ""
    for part in source.split(","):
        k, _, v = part.partition(":")
        if k in ("NOD", "RAD", "PLC", "WMO") and v:
            ident = v
            break
    sweeps: list[Sweep] = []
    for key in sorted((k for k in f.keys() if k.startswith("dataset")), key=lambda s: int(s[7:])):
        D = f[key]
        dw = _attrs(D["where"]) if "where" in D else {}
        dwhat = _attrs(D["what"]) if "what" in D else {}
        if str(dwhat.get("product", "SCAN")).upper() not in ("SCAN", ""):
            continue
        if keep_elev is not None and not keep_elev(float(dw.get("elangle", 0.0))):
            continue
        dhow = _attrs(D["how"]) if "how" in D else {}
        nrays = int(dw.get("nrays", 360))
        data: dict[str, np.ndarray] = {}
        for qk in (k for k in D.keys() if k.startswith("data")):
            Q = D[qk]
            qa = {**dwhat, **(_attrs(Q["what"]) if "what" in Q else {})}
            q = str(qa.get("quantity", "")).upper()
            if keep_moments is not None and _ODIM_MOMENTS.get(q, q) not in keep_moments:
                continue
            arr = Q["data"][()]
            vals = arr.astype(np.float32) * np.float32(qa.get("gain", 1.0)) + np.float32(qa.get("offset", 0.0))
            bad = np.zeros(arr.shape, dtype=bool)
            for m in ("nodata", "undetect"):
                if m in qa:
                    bad |= arr == qa[m]
            vals[bad] = np.nan
            data[_ODIM_MOMENTS.get(q, q)] = vals
        if keep_moments is not None and not data:
            continue
        # A single number in some Swiss files, which is no list of rays.
        if np.size(dhow.get("startazA", 0)) == nrays:
            az = np.asarray(dhow["startazA"], dtype=np.float64)
        else:
            a1 = int(dw.get("a1gate", 0))
            az = (np.arange(nrays) - a1) % nrays * (360.0 / nrays)
        nyq = float(dhow["NI"]) if "NI" in dhow else None
        t = _unix(f"{dwhat.get('startdate', what.get('date', ''))}{dwhat.get('starttime', what.get('time', ''))}")
        az, data = _sorted(az, data)
        sweeps.append(Sweep(elev=float(dw.get("elangle", 0.0)), az=az, r0_km=float(dw.get("rstart", 0.0)),
                            dr_km=float(dw.get("rscale", 250.0)) / 1000.0, unix=t or 0, data=data, nyquist=nyq))
    sweeps.sort(key=lambda s: s.elev)
    when = _unix(f"{what.get('date', '')}{what.get('time', '')}") or (sweeps[0].unix if sweeps else 0)
    return Volume(radar=_radar_for(ident, ident, lat, lon), ident=ident, name=ident, lat=lat, lon=lon,
                  alt_m=float(where.get("height", 0.0)), unix=when, sweeps=sweeps, files=[name])


# --- CF/Radial: NASA's GPM Ground Validation volumes ------------------------
# NASA's archive takes CEMADEN's volumes of the days a GPM satellite passes
# over, runs its dual-pol quality control (GVradar) and publishes each whole
# volume as one gzipped CF/Radial netCDF4 file, no CAPTCHA in the way:
# 16 sweeps, 1.0 to 25.0 deg, 250 m gates to 250 km, fields DZ (the radar's
# reflectivity) and CZ (the one quality control kept), VR, SW, DR, RH, PH,
# KD, and its own products (SD the texture of PH, FH its hydrometeor class,
# DM and NW the drop size distribution, MW and MI liquid and ice water, RC
# and RP rain rates). Everything is on one (time, range) grid; a sweep is the
# rays sweep_start_ray_index..sweep_end_ray_index.
_CF_NEEDS = ("sweep_start_ray_index", "sweep_end_ray_index", "fixed_angle", "range", "azimuth", "time")
# Field -> our moment, by preference: the first a file has takes the moment.
# The corrected reflectivity is the main one; the radar's own becomes the
# unfiltered (TH), as Rainbow's dBuZ does. Then the CF/Radial (and Py-ART)
# usual names. Only these eight are read: NASA's own products (SD FH DM NW MW
# MI RC RP) and any other field stay in the file -- nothing here draws them,
# and they were more than half of a loaded volume: Maceio's 2026-02-08 06:40
# volume (16 sweeps, float32) took 429 MB and 3.8 s with them and a copy of
# the published ZDR, 202 MB and 2.0 s without.
_CF_MOMENTS: dict[str, tuple[str, ...]] = {
    "DBZH": ("CZ", "DBZH", "DBZ", "CORRECTED_REFLECTIVITY", "REFLECTIVITY", "DZ"),
    "TH": ("DZ", "TH", "DBTH", "DBT", "TOTAL_POWER"),
    "VRAD": ("VR", "VRADH", "VRAD", "VEL", "VELOCITY"),
    "WRAD": ("SW", "WRADH", "WRAD", "WIDTH", "SPECTRUM_WIDTH"),
    "ZDR": ("DR", "ZDR", "DIFFERENTIAL_REFLECTIVITY"),
    "RHOHV": ("RH", "RHOHV", "RHO", "CROSS_CORRELATION_RATIO"),
    "PHIDP": ("PH", "PHIDP", "PHI", "DIFFERENTIAL_PHASE"),
    "KDP": ("KD", "KDP", "SPECIFIC_DIFFERENTIAL_PHASE"),
}
# Sweep modes that are not a turn of the antenna at one elevation.
_CF_NOT_PPI = {"rhi", "manual_rhi", "elevation_surveillance", "vertical_pointing", "pointing", "idle", "sunscan"}


def _cf_text(v: Any) -> str:
    """A netCDF text: an attribute, a string, or a char array of one string."""
    if v is None:
        return ""
    if isinstance(v, bytes):
        return v.decode("utf-8", "replace").strip("\x00 ")
    a = np.asarray(v)
    if a.dtype.kind == "S":
        return b"".join(a.ravel().tolist()).decode("utf-8", "replace").strip("\x00 ")
    if a.dtype.kind == "O" and a.size == 1:
        return _cf_text(a.ravel()[0])
    return str(a.ravel()[0] if a.size == 1 else v).strip("\x00 ")


def _cf_field(var: Any, rows: slice) -> np.ndarray:
    """Rays `rows` of one field in physical units (float32), no data as NaN:
    _FillValue and missing_value masked on the stored numbers, then
    scale_factor and add_offset."""
    raw = np.asarray(var[rows])
    at = var.attrs
    bad = np.zeros(raw.shape, dtype=bool)
    for key in ("_FillValue", "missing_value"):
        if key in at:
            for fv in np.atleast_1d(np.asarray(at[key])).ravel():
                try:
                    bad |= raw == fv
                except (TypeError, ValueError):
                    continue
    if raw.dtype.kind == "i" and _cf_text(at.get("_Unsigned")).lower() == "true":
        raw = raw.view(raw.dtype.str.replace("i", "u"))   # same width and byte order
    with np.errstate(over="ignore", invalid="ignore"):
        vals = raw.astype(np.float32)   # a float64 mark past float32's range goes inf, then NaN
    if "scale_factor" in at:
        vals *= np.float32(np.atleast_1d(at["scale_factor"])[0])
    if "add_offset" in at:
        vals += np.float32(np.atleast_1d(at["add_offset"])[0])
    vals[bad | ~np.isfinite(vals)] = np.nan
    # NASA's files went through Universal Format on the way, which leaves its
    # own no-data marks beside the declared one: -327.68 in velocity and
    # width, -999 and -32767 in the rain rates and drop sizes whose
    # _FillValue is 0. Nothing a radar measures is that low.
    vals[vals <= -327.0] = np.nan
    return vals


def _dms_slip(x: float) -> float:
    """A negative coordinate whose minutes and seconds were added to its
    negative degrees instead of taken away (9 deg 33' 04" S written
    -9 + 33/60 + 4/3600 = -8.4489): what it should have been (-9.5511)."""
    if x >= 0 or x == math.floor(x):
        return x
    d = math.floor(x)
    return d - (x - d)


def _cf_position(ident: str, name: str, lat: Optional[float], lon: Optional[float]) -> tuple:
    """Where the radar is. NASA's VN files of the CEMADEN radars carry the
    slip above in both coordinates: Maceio's radar (9 deg 33' 04" S,
    35 deg 46' 14" W, on the UFAL campus at 102 m) comes out at -8.4489,
    -34.2294, in the sea 200 km away. When the file names a radar of the
    table and stands more than 30 km from it while the mended position
    stands within 30 km, the mended one is taken; anything else is left as
    the file says."""
    if lat is None or lon is None:
        return lat, lon
    known = RADARS.get(_radar_for(ident, name, None, None))
    if known is None:
        return lat, lon

    def off(p: tuple) -> float:
        return _km(p[0], p[1], known["lat"], known["lon"])

    if off((lat, lon)) <= 30.0:
        return lat, lon
    best = min(((_dms_slip(lat), _dms_slip(lon)), (_dms_slip(lat), lon), (lat, _dms_slip(lon))), key=off)
    return best if off(best) <= 30.0 else (lat, lon)


# ZDR of light rain (20-28 dBZ): small drops, nearly round, about a quarter dB
# whatever the rain -- the light-rain method of dual-pol calibration.
_LIGHT_RAIN_ZDR = 0.25


def _zdr_offset(sweeps: list[Sweep], alt_m: float) -> Optional[float]:
    """The ZDR calibration offset, measured on the volume's own light rain:
    the median ZDR of gates at 20-28 dBZ with correlation 0.98 or more, on
    sweeps up to 4.5 deg, past 10 km (clutter) and under 2.5 km above the
    radar (rain, under any Brazilian melting layer), less what such rain
    reads. NASA's VN volumes of Maceio read -2.6 to -3.0 dB there, in every
    case of 2026 and at every low sweep (300 to 1600 gates a volume): the
    radar's ZDR is off by about 3 dB, which paints all rain negative and
    sends some of it to ground clutter in the classification. None without
    200 such gates (their median is then good to a few hundredths of a dB)."""
    got = []
    for sw in sweeps:
        z, zdr, rho = sw.data.get("DBZH"), sw.data.get("ZDR"), sw.data.get("RHOHV")
        if sw.elev > 4.5 or z is None or zdr is None or rho is None:
            continue
        h, s = _beam(sw, alt_m)
        where = ((h - alt_m) < 2500.0) & (s > 10.0)
        with np.errstate(invalid="ignore"):
            m = where[None, :] & np.isfinite(zdr) & (z >= 20.0) & (z <= 28.0) & (rho >= 0.98)
        got.append(zdr[m])
    vals = np.concatenate(got) if got else np.empty(0, dtype=np.float32)
    return float(np.median(vals)) - _LIGHT_RAIN_ZDR if vals.size >= 200 else None


def read_cfradial(src: Any, name: str = "") -> Volume:
    """A CF/Radial volume: every sweep and every field in one netCDF4 file
    (the bytes, gzipped or not, or an open h5py file). Ray azimuths are
    CF/Radial's centres, turned into where each ray starts; range is gate
    centres in metres, so the first gate starts half a gate before the first
    centre. Time: the time units' "seconds since" (else time_coverage_start)
    plus each sweep's first ray; the volume's own time is
    time_coverage_start. The Nyquist velocity is the sweep's median of the
    per-ray nyquist_velocity, when one is there and not zero (NASA's VN files
    write zeros: their velocity is then left folded as it came). Only the
    moments of _CF_MOMENTS are read. A ZDR calibration offset over half a dB,
    measured on the volume's light rain, is taken out of ZDR in place
    (_zdr_offset); the published field is not kept, only the number
    (Volume.zdr_offset_db, which polar() shows as zdrOffsetDb)."""
    if isinstance(src, (bytes, bytearray, memoryview)):
        raw = bytes(src)
        if raw[:2] == b"\x1f\x8b":
            raw = _gunzip(raw)
        if raw[:8] != b"\x89HDF\r\n\x1a\n":
            raise ValueError("CF/Radial is read from netCDF4 (HDF5) files only.")
        import h5py  # noqa: PLC0415 - only for HDF5 files
        with h5py.File(io.BytesIO(raw), "r") as f:
            return read_cfradial(f, name)
    f = src
    gat = f.attrs

    def num(key: str) -> Optional[float]:
        if key not in f:
            return None
        a = np.asarray(f[key][()], dtype=np.float64).ravel()
        a = a[np.isfinite(a)]
        return float(a[0]) if a.size else None

    def var_text(key: str) -> str:
        return _cf_text(f[key][()]) if key in f else ""

    ntime = int(f["time"].shape[0])
    tsec = np.asarray(f["time"][()], dtype=np.float64).ravel()
    rng = np.asarray(f["range"][()], dtype=np.float64).ravel()
    to_km = 1.0 if _cf_text(f["range"].attrs.get("units")).lower() in ("km", "kilometers", "kilometres") else 0.001
    nrange = rng.size
    if nrange > 1:
        dr = float(np.median(np.diff(rng))) * to_km
    else:
        step = f["range"].attrs.get("meters_between_gates")
        dr = float(np.atleast_1d(step)[0]) / 1000.0 if step is not None else 0.25
    r0 = max(float(rng[0]) * to_km - dr / 2.0, 0.0) if nrange else 0.0

    # The fields: numbers on the (time, range) grid.
    fields: dict[str, str] = {}
    for k in f.keys():
        v = f[k]
        if getattr(v, "shape", None) == (ntime, nrange) and getattr(v, "dtype", np.dtype("S1")).kind in "fiu":
            fields[k.upper()] = k
    if not fields:
        if "ray_n_gates" in f:
            raise ValueError("CF/Radial with ragged rays (n_points) is not read; only the (time, range) grid.")
        raise ValueError("The CF/Radial file holds no (time, range) fields.")
    take: dict[str, str] = {}
    used: set[str] = set()
    for moment, names in _CF_MOMENTS.items():
        for n in names:
            if n in fields and n not in used:
                take[moment] = fields[n]
                used.add(n)
                break
    if not take:
        raise ValueError("The CF/Radial file holds none of the moments this app draws "
                         f"({', '.join(sorted(fields))[:200]}).")

    tunits = _cf_text(f["time"].attrs.get("units"))
    since = re.match(r"\s*seconds?\s+since\s+(.+)$", tunits, re.I)
    tcs = _unix(var_text("time_coverage_start") or _cf_text(gat.get("time_coverage_start")))
    base = (_unix(since.group(1).strip()) if since else None) or tcs
    s0 = np.asarray(f["sweep_start_ray_index"][()]).astype(np.int64).ravel()
    s1 = np.asarray(f["sweep_end_ray_index"][()]).astype(np.int64).ravel()
    fixed = np.asarray(f["fixed_angle"][()], dtype=np.float64).ravel()
    azim = np.asarray(f["azimuth"][()], dtype=np.float64).ravel()
    elev_rays = np.asarray(f["elevation"][()], dtype=np.float64).ravel() if "elevation" in f else None
    modes = [_cf_text(m).lower() for m in f["sweep_mode"][()]] if "sweep_mode" in f else []
    nyq = None
    if "nyquist_velocity" in f and f["nyquist_velocity"].shape == (ntime,):
        nyq = np.asarray(f["nyquist_velocity"][()], dtype=np.float64)

    sweeps: list[Sweep] = []
    for i in range(min(s0.size, s1.size)):
        a, b = int(s0[i]), int(s1[i]) + 1
        if a < 0 or b > ntime or b - a < 2 or (i < len(modes) and modes[i] in _CF_NOT_PPI):
            continue
        rows = slice(a, b)
        centres = np.mod(azim[rows], 360.0)
        gaps = np.diff(np.sort(centres))
        gaps = gaps[gaps > 1e-3]
        step = float(np.median(gaps)) if gaps.size else 1.0
        data = {m: _cf_field(f[k], rows) for m, k in take.items()}
        az, data = _sorted(centres - step / 2.0, data)
        if i < fixed.size and np.isfinite(fixed[i]):
            elev = float(fixed[i])
        else:
            elev = float(np.nanmedian(elev_rays[rows])) if elev_rays is not None else 0.0
        t = (base + int(math.floor(tsec[a]))) if base is not None and np.isfinite(tsec[a]) else (tcs or 0)
        nq = None
        if nyq is not None:
            nv = nyq[rows]
            nv = nv[np.isfinite(nv) & (nv > 0.0) & (nv < 200.0)]
            nq = float(np.median(nv)) if nv.size else None
        sweeps.append(Sweep(elev=elev, az=az, r0_km=r0, dr_km=dr, unix=t, data=data, nyquist=nq))
    sweeps.sort(key=lambda s: s.elev)

    ident = _cf_text(gat.get("instrument_name")) or var_text("instrument_name")
    rname = _cf_text(gat.get("site_name")) or _cf_text(gat.get("radar_name")) or ident
    lat, lon = _cf_position(ident, rname, num("latitude"), num("longitude"))
    alt = num("altitude") or 0.0
    freq = num("frequency")
    when = tcs or ((base + int(math.floor(np.nanmin(tsec)))) if base is not None and tsec.size else None) \
        or (sweeps[0].unix if sweeps else 0)
    # A ZDR off by more than half a dB is calibration, not weather: taken out
    # in place (the arrays are this reader's own), only the number kept --
    # the published field would be one more full moment in memory. Within
    # half a dB, untouched.
    zoff = _zdr_offset(sweeps, alt)
    if zoff is None or abs(zoff) < 0.5:
        zoff = None
    else:
        for sw in sweeps:
            if "ZDR" in sw.data:
                sw.data["ZDR"] -= np.float32(zoff)
    return Volume(radar=_radar_for(ident, rname, lat, lon), ident=ident, name=rname, lat=lat or 0.0,
                  lon=lon or 0.0, alt_m=alt, unix=when, sweeps=sweeps, files=[name],
                  wavelength_m=299792458.0 / freq if freq and freq > 0 else None,
                  zdr_offset_db=round(zoff, 2) if zoff is not None else None)


_GUNZIP_MAX = 1 << 30   # a volume unpacks to tens of MB; nothing real reaches 1 GB


def _gunzip(raw: bytes) -> bytes:
    """A gzip file's contents, every member of it, refusing past 1 GB."""
    out: list[bytes] = []
    total = 0
    rest = raw
    while rest[:2] == b"\x1f\x8b":
        d = zlib.decompressobj(wbits=31)
        try:
            part = d.decompress(rest, _GUNZIP_MAX + 1 - total)
        except zlib.error as exc:
            raise ValueError(f"The gzip file is damaged: {exc}") from exc
        total += len(part)
        if total > _GUNZIP_MAX or d.unconsumed_tail:
            raise ValueError("The gzip file unpacks to more than any radar volume.")
        if not d.eof:
            raise ValueError("The gzip file is cut short.")
        out.append(part)
        rest = d.unused_data
    return b"".join(out)


def read_any(raw: bytes, name: str = "") -> Volume:
    # Gzipped (NASA's .cf.gz, a .vol.gz): unpacked here, so the store keeps
    # the file as it came and every reader sees the plain bytes.
    if raw[:2] == b"\x1f\x8b":
        raw = _gunzip(raw)
    if raw[:8] == b"\x89HDF\r\n\x1a\n":
        return read_hdf5(raw, name)
    head = raw[:4096].lstrip()
    if head.startswith(b"<volume") or head.startswith(b"<?xml") and b"<volume" in head:
        return read_rainbow(raw, name)
    if raw[:3] == b"CDF":
        raise ValueError("A netCDF3 file: CF/Radial is read from netCDF4 (HDF5) only.")
    raise ValueError("Not a radar volume this app reads (Rainbow .vol, GAMIC or ODIM HDF5, CF/Radial netCDF4; "
                     "gzipped or not).")


# ---------------------------------------------------------------------------
# The store on disk
# ---------------------------------------------------------------------------
def _stamp(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y%m%d%H%M%S")


def _stamp_unix(stamp: str) -> int:
    return int(datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp())


def import_file(name: str, raw: bytes) -> dict:
    """Keep one volume file: read it to know the radar and the time, then file
    it beside the other moments of the same volume."""
    if len(raw) > 400 * 1024 * 1024:
        raise ValueError("File too large for a radar volume.")
    vol = read_any(raw, name)
    if not vol.sweeps:
        raise ValueError("The file holds no PPI sweeps.")
    # Moments of one volume written in separate files share the start time to
    # within a few seconds; a volume already kept within 90 s is the same one.
    stamp = _stamp(vol.unix)
    rdir = STORE / vol.radar
    if rdir.is_dir():
        for d in rdir.iterdir():
            if d.is_dir() and re.fullmatch(r"\d{14}", d.name) and abs(_stamp_unix(d.name) - vol.unix) <= 90:
                stamp = d.name
                break
    vdir = rdir / stamp
    vdir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", Path(name).name) or f"{stamp}.vol"
    tmp = vdir / (safe + ".part")
    tmp.write_bytes(raw)
    os.replace(tmp, vdir / safe)
    moments = sorted({m for s in vol.sweeps for m in s.data})
    meta_path = vdir / "info.json"
    info = {}
    try:
        info = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    info.update({
        "radar": vol.radar, "ident": vol.ident, "name": vol.name, "lat": vol.lat, "lon": vol.lon,
        "altM": vol.alt_m, "unix": _stamp_unix(stamp), "stamp": stamp,
        "moments": sorted(set(info.get("moments", [])) | set(moments)),
        "elevations": sorted({round(s.elev, 2) for s in vol.sweeps} | set(info.get("elevations", []))),
        "files": sorted(set(info.get("files", [])) | {safe}),
    })
    meta_path.write_text(json.dumps(info), encoding="utf-8")
    with _LOCK:
        _VOLUMES.pop((vol.radar, stamp), None)
        for k in [k for k in _GRIDS if k[0] == vol.radar and k[1] == stamp]:
            _GRIDS.pop(k, None)
    # A radar found in a file and not in the table joins it, where the file says it is.
    if vol.radar not in RADARS:
        RADARS[vol.radar] = {"name": vol.name or vol.ident or vol.radar, "op": "", "lat": vol.lat, "lon": vol.lon,
                             "band": ""}
    else:
        RADARS[vol.radar].update(lat=vol.lat or RADARS[vol.radar]["lat"], lon=vol.lon or RADARS[vol.radar]["lon"])
    return {"radar": vol.radar, "site": vol.radar, "name": RADARS[vol.radar]["name"], "stamp": stamp,
            "unix": info["unix"], "moments": moments, "sweeps": len(vol.sweeps), "file": safe}


# A radar id as a store folder: "BR-" or "EU-" and letters or digits, never a path.
_ID_RE = re.compile(r"(?:BR|EU)-[A-Z0-9]{1,12}")


def volumes(radar: str) -> list[dict]:
    """Every volume kept for a radar, oldest first: each folder's info.json,
    its stamp and time from the folder's name when it lacks them. A radar
    with no folder yet (one the relay lists before its first volume lands)
    has none."""
    out: list[dict] = []
    if not _ID_RE.fullmatch(str(radar or "")):
        return out
    rdir = STORE / radar
    try:
        dirs = [d for d in rdir.iterdir() if re.fullmatch(r"\d{14}", d.name) and d.is_dir()] if rdir.is_dir() else []
    except OSError:
        return out
    for d in dirs:
        try:
            info = json.loads((d / "info.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(info, dict):
            continue
        info.setdefault("stamp", d.name)
        if not isinstance(info.get("unix"), (int, float)):
            try:
                info["unix"] = _stamp_unix(d.name)
            except ValueError:
                continue    # fourteen digits that are no time
        out.append(info)
    out.sort(key=lambda i: str(i["stamp"]))
    return out


def _known() -> dict[str, dict]:
    """The radar table, with any radar met only in a kept file."""
    if STORE.is_dir():
        for d in STORE.iterdir():
            if d.is_dir() and d.name.startswith("BR-") and d.name not in RADARS:
                vs = volumes(d.name)
                if vs:
                    v = vs[-1]
                    RADARS[d.name] = {"name": v.get("name") or d.name, "op": "", "lat": v.get("lat") or 0.0,
                                      "lon": v.get("lon") or 0.0, "band": ""}
    return RADARS


# The radars someone else knows to be coming in: set by the relay client
# (radar_relay_client.py) to a function answering, from memory, the radars its
# relay serves -- [{"id", "name", "lat", "lon", "newest": unix or None,
# "live": bool, "operator": str}]. sites() calls it on every listing; what it
# raises or returns malformed is ignored.
EXTRA_SITES: Optional[Callable[[], list[dict]]] = None


def _coord(x: Any, lim: float) -> Optional[float]:
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or abs(x) > lim:
        return None
    return float(x)


def _extra_sites() -> dict[str, dict]:
    """EXTRA_SITES' radars by id, the entries without a usable id left out."""
    hook = EXTRA_SITES
    if hook is None:
        return {}
    out: dict[str, dict] = {}
    try:
        for e in hook() or ():
            rid = str(e.get("id") or "").upper() if isinstance(e, dict) else ""
            if _ID_RE.fullmatch(rid):
                out[rid] = e
    except Exception:  # noqa: BLE001 - the radars kept here are listed regardless
        return out
    return out


def _day(unix: Any) -> Optional[str]:
    if isinstance(unix, bool) or not isinstance(unix, (int, float)) or not math.isfinite(unix) or unix <= 0:
        return None
    try:
        return datetime.fromtimestamp(unix, tz=timezone.utc).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return None


def sites() -> list[dict]:
    """The Brazilian radars as sites of the radar picker: every radar with a
    volume kept, then every radar EXTRA_SITES lists that has none here yet
    (no volumes, its last scan day from the hook's newest, online while the
    hook calls it live). "live" says the volumes are coming in now: the
    hook's word, so False for the archive radars (BR-PNV, the NASA cases of
    BR-MCZ) and for everything when no hook is set."""
    extra = _extra_sites()
    out = []
    for rid, r in list(_known().items()):     # import_file may add a radar meanwhile
        if _remote(rid):
            continue    # listed by their own module
        vs = volumes(rid)
        if not vs:
            continue
        last = vs[-1]
        r = {**r, "lat": last.get("lat") or r["lat"], "lon": last.get("lon") or r["lon"]}
        out.append({
            "id": rid, "icao": rid[3:], "name": f"{r['name']} · {r['op']}".strip(" ·"), "lat": r["lat"], "lon": r["lon"],
            "country": "BR", "online": True, "lastScanDay": _day(last.get("unix")),
            "volumes": len(vs), "operator": r["op"], "band": r.get("band"), "cemaden": r.get("cemaden"),
            "live": bool(extra.get(rid, {}).get("live")),
        })
    have = {s["id"] for s in out}
    for rid, e in extra.items():
        if rid in have:
            continue
        known = RADARS.get(rid, {})
        lat = _coord(e.get("lat"), 90.0)
        lon = _coord(e.get("lon"), 180.0)
        if lat is None or lon is None:
            lat, lon = known.get("lat"), known.get("lon")
        if lat is None or lon is None:
            continue    # nowhere to draw it
        name = str(e.get("name") or known.get("name") or rid)
        op = str(e.get("operator") or known.get("op") or "")
        live = bool(e.get("live"))
        out.append({
            "id": rid, "icao": rid[3:], "name": f"{name} · {op}".strip(" ·") if op and op not in name else name,
            "lat": lat, "lon": lon, "country": "BR", "online": live, "lastScanDay": _day(e.get("newest")),
            "volumes": 0, "operator": op, "band": known.get("band"), "cemaden": known.get("cemaden"), "live": live,
        })
    return out


_VOLUMES: "OrderedDict[tuple[str, str], Volume]" = OrderedDict()
_VOL_MAX = 3


def _listed(vdir: Path) -> Optional[frozenset]:
    """The files a volume folder's info.json lists; None when it cannot be read."""
    try:
        info = json.loads((vdir / "info.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    files = info.get("files") if isinstance(info, dict) else None
    return frozenset(str(f) for f in files) if isinstance(files, list) else None


def _stale(vol: Volume, now: Optional[frozenset]) -> bool:
    """Whether a volume read earlier misses a file its folder now lists.
    import_file drops the cached volume, but a load() that was reading the
    folder meanwhile puts back what it had read, without the new moment; the
    importer of another process (scripts/import_nasa_cemaden.py) drops
    nothing at all. A file listed but unreadable reloads once, not on every
    call: only a list that changed since the read counts."""
    if now is None or now == vol.listed:
        return False
    if now <= set(vol.files):
        vol.listed = now
        return False
    return True


def load(radar: str, stamp: str) -> Volume:
    """A kept volume, every file of it merged: sweeps matched by elevation.
    The cached copy is checked against the folder's info.json first (a
    small read) and read again when it misses a file listed since (_stale).
    A remote radar's frame has no folder: the cached copy stands while the
    frame is made of the same files."""
    key = (radar, stamp)
    if not _ID_RE.fullmatch(str(radar or "")) or not re.fullmatch(r"\d{14}", str(stamp or "")):
        raise ValueError(f"No volume {stamp} for {radar}")
    if _remote(radar):
        names = frozenset(REMOTE.parts(radar, stamp))
        with _LOCK:
            hit = _VOLUMES.get(key)
            if hit is not None and hit.listed == names:
                _VOLUMES.move_to_end(key)
                return hit
        made = REMOTE.volume(radar, stamp)
        made.listed = names
        with _LOCK:
            _VOLUMES[key] = made
            _VOLUMES.move_to_end(key)
            while len(_VOLUMES) > _VOL_MAX:
                _VOLUMES.popitem(last=False)
        return made
    vdir = STORE / radar / stamp
    with _LOCK:
        hit = _VOLUMES.get(key)
    if hit is not None:
        now = _listed(vdir)
        with _LOCK:
            if not _stale(hit, now):
                if _VOLUMES.get(key) is hit:
                    _VOLUMES.move_to_end(key)
                return hit
    if not vdir.is_dir():
        raise ValueError(f"No volume {stamp} for {radar}")
    # What info.json lists before the folder is read: a file filed while it
    # is read then shows up as a change on the next call.
    listed = _listed(vdir)
    merged: Optional[Volume] = None
    for p in sorted(vdir.iterdir()):
        if p.name in ("info.json",) or p.suffix == ".part":
            continue
        try:
            v = read_any(p.read_bytes(), p.name)
        except Exception:  # noqa: BLE001 - one bad file leaves the rest
            continue
        if merged is None:
            merged = v
            continue
        merged.files += v.files
        took_zdr = False
        for s in v.sweeps:
            twin = next((m for m in merged.sweeps if abs(m.elev - s.elev) < 0.05 and m.nrays == s.nrays
                         and abs(m.dr_km - s.dr_km) < 1e-6), None)
            if twin is None:
                merged.sweeps.append(s)
                took_zdr |= "ZDR" in s.data
            else:
                for k, arr in s.data.items():
                    if k not in twin.data and arr.shape[0] == twin.nrays:
                        # Same rays in the same order once both are sorted by azimuth.
                        twin.data[k] = arr
                        took_zdr |= k == "ZDR"
                twin.nyquist = twin.nyquist or s.nyquist
        # The ZDR correction goes with the file whose ZDR was kept.
        if took_zdr and merged.zdr_offset_db is None:
            merged.zdr_offset_db = v.zdr_offset_db
        merged.sweeps.sort(key=lambda s: s.elev)
    if merged is None:
        raise ValueError(f"Volume {stamp} of {radar} could not be read")
    merged.radar = radar
    merged.listed = listed
    with _LOCK:
        _VOLUMES[key] = merged
        while len(_VOLUMES) > _VOL_MAX:
            _VOLUMES.popitem(last=False)
    return merged


# ---------------------------------------------------------------------------
# The environment over the radar: freezing level, -20 C, the wind
# ---------------------------------------------------------------------------
_ENV: dict[tuple, dict] = {}
_ENV_LEVELS = (1000, 925, 850, 700, 600, 500, 400, 300, 250, 200)


def environment(lat: float, lon: float, unix: int) -> dict:
    """The model's column over the radar at the volume's hour (GFS through
    Open-Meteo: the forecast archive back three months, the historical
    forecasts before that), for the hail products, the classification's
    melting layer, the storm motion and the velocity unfolding. When neither
    answers, typical values for Brazil stand in, and say so."""
    hour = unix - unix % 3600
    key = (round(lat, 1), round(lon, 1), hour)
    if key in _ENV:
        return _ENV[key]
    day = datetime.fromtimestamp(hour, tz=timezone.utc).strftime("%Y-%m-%d")
    hourly = []
    for lv in _ENV_LEVELS:
        hourly += [f"temperature_{lv}hPa", f"geopotential_height_{lv}hPa", f"wind_speed_{lv}hPa",
                   f"wind_direction_{lv}hPa"]
    params = {"latitude": round(lat, 3), "longitude": round(lon, 3), "hourly": ",".join(hourly),
              "start_date": day, "end_date": day, "wind_speed_unit": "ms", "timeformat": "unixtime"}
    got = None
    for url, extra in (("https://api.open-meteo.com/v1/forecast", {"models": "gfs_seamless"}),
                       ("https://historical-forecast-api.open-meteo.com/v1/forecast", {"models": "gfs_seamless"}),
                       ("https://historical-forecast-api.open-meteo.com/v1/forecast", {})):
        try:
            r = requests.get(url, params={**params, **extra}, timeout=(8, 30))
            d = r.json()
            if r.ok and isinstance(d, dict) and d.get("hourly", {}).get("time"):
                h = d["hourly"]
                k = min(range(len(h["time"])), key=lambda i: abs(h["time"][i] - hour))
                col = []
                for lv in _ENV_LEVELS:
                    t, z = h.get(f"temperature_{lv}hPa", [None])[k], h.get(f"geopotential_height_{lv}hPa", [None])[k]
                    s, dd = h.get(f"wind_speed_{lv}hPa", [None])[k], h.get(f"wind_direction_{lv}hPa", [None])[k]
                    if t is not None and z is not None:
                        col.append({"p": lv, "z": float(z), "t": float(t), "spd": s, "dir": dd})
                if len(col) >= 5:
                    got = {"column": sorted(col, key=lambda c: c["z"]), "source": "GFS (Open-Meteo)"}
                    break
        except (requests.RequestException, ValueError):
            continue
    if got is None:
        got = {"column": [], "source": "typical values (no model column)"}
    col = got["column"]

    def height_of(temp: float) -> Optional[float]:
        for a, b in zip(col, col[1:]):
            if (a["t"] - temp) * (b["t"] - temp) <= 0 and a["t"] != b["t"]:
                return a["z"] + (temp - a["t"]) / (b["t"] - a["t"]) * (b["z"] - a["z"])
        return None

    h0 = height_of(0.0)
    h20 = height_of(-20.0)
    if h0 is None:
        h0 = 4600.0 if not col else (col[0]["z"] if col[0]["t"] < 0 else 4600.0)
    if h20 is None or h20 <= h0:
        h20 = h0 + 3300.0
    # The wind at each level (u, v, m/s), for the unfolding and the storm motion.
    wind = []
    for c in col:
        if c["spd"] is None or c["dir"] is None:
            continue
        sp, dr = float(c["spd"]), math.radians(float(c["dir"]))
        wind.append((c["z"], -sp * math.sin(dr), -sp * math.cos(dr)))
    # Storm motion: the mean wind of the lowest 6 km above the ground (the
    # "mean wind" motion of the Bunkers family, without the deviation).
    mean = [w for w in wind if w[0] <= (col[0]["z"] if col else 0.0) + 6000.0]
    if mean:
        mu, mv = float(np.mean([w[1] for w in mean])), float(np.mean([w[2] for w in mean]))
    else:
        mu = mv = 0.0
    speed = math.hypot(mu, mv)
    toward = (math.degrees(math.atan2(mu, mv)) + 360.0) % 360.0
    out = {"h0": round(h0), "h20": round(h20), "source": got["source"], "wind": wind,
           "motion": {"speedKt": round(speed * _MS_TO_KT, 1), "toward": round(toward, 1)}}
    _ENV[key] = out
    while len(_ENV) > 64:
        _ENV.pop(next(iter(_ENV)))
    return out


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def _beam(sw: Sweep, alt_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Height above sea level (m) and ground range (km) of each gate's centre."""
    nb = next(iter(sw.data.values())).shape[1]
    r = sw.r0_km + (np.arange(nb) + 0.5) * sw.dr_km
    th = math.radians(sw.elev)
    h = np.sqrt(r * r + RE_EFF_KM ** 2 + 2.0 * r * RE_EFF_KM * math.sin(th)) - RE_EFF_KM
    s = RE_EFF_KM * np.arcsin(np.clip(r * math.cos(th) / (RE_EFF_KM + h), -1, 1))
    return h * 1000.0 + alt_m, s


def _ray_index(src_az: np.ndarray, want: np.ndarray) -> np.ndarray:
    """For each wanted azimuth, the source ray whose span holds it."""
    n = src_az.size
    j = np.searchsorted(src_az, want, side="right") - 1
    return np.mod(j, n)


def _columns(vol: Volume, base: Sweep, moment: str = "DBZH") -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Every sweep's `moment` and beam height, on the base sweep's grid: what
    sits above each of its gates, sweep by sweep (low to high)."""
    _, s_base = _beam(base, vol.alt_m)
    centres = np.mod(base.az + 0.5 * float(np.median(np.diff(base.az)) if base.nrays > 1 else 1.0), 360.0)
    vals, heights = [], []
    for sw in vol.sweeps:
        if moment not in sw.data:
            continue
        h, s = _beam(sw, vol.alt_m)
        g = np.searchsorted(s, s_base)
        g = np.clip(g, 0, s.size - 1)
        ok = (s_base <= s[-1] + sw.dr_km) & (s_base >= s[0] - sw.dr_km)
        rows = _ray_index(sw.az, centres)
        v = sw.data[moment][rows[:, None], g[None, :]].astype(np.float32)
        v[:, ~ok] = np.nan
        vals.append(v)
        heights.append(np.broadcast_to(h[g][None, :], v.shape))
    return vals, heights


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
def _dealias(sw: Sweep, alt_m: float, env: dict) -> Optional[np.ndarray]:
    """Velocity unfolded against the model's wind: each gate takes the fold
    nearest the radial component the environment would give there, then a
    pass against its neighbours' median puts back what a storm's own
    circulation pushed past the reference. m/s."""
    v = sw.data.get("VRAD")
    vn = sw.nyquist
    if v is None or not vn or not env.get("wind"):
        return None
    h, _ = _beam(sw, alt_m)
    zs = np.array([w[0] for w in env["wind"]])
    us = np.array([w[1] for w in env["wind"]])
    vs = np.array([w[2] for w in env["wind"]])
    u_h, v_h = np.interp(h, zs, us), np.interp(h, zs, vs)
    centres = np.radians(np.mod(sw.az + 0.5, 360.0))
    cos_e = math.cos(math.radians(sw.elev))
    ref = (np.sin(centres)[:, None] * u_h[None, :] + np.cos(centres)[:, None] * v_h[None, :]) * cos_e
    two = 2.0 * vn
    out = v + two * np.round((ref - v) / two)
    # The neighbourhood pass, twice: the mean of the gates around (7 rays x 7
    # gates) -- a fold sticks out from it by most of 2 Nyquist.
    try:
        from scipy.ndimage import uniform_filter  # noqa: PLC0415
        for _ in range(2):
            ok = np.isfinite(out)
            s = uniform_filter(np.where(ok, out, 0.0), size=(7, 7), mode=("wrap", "nearest"))
            c = uniform_filter(ok.astype(np.float32), size=(7, 7), mode=("wrap", "nearest"))
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = np.where(c > 0.3, s / c, np.nan)
            fix = np.isfinite(mean) & ok
            out = np.where(fix, out + two * np.round((mean - out) / two), out)
    except Exception:  # noqa: BLE001 - the model pass alone still stands
        pass
    return out.astype(np.float32)


def _texture(a: np.ndarray, n: int = 9) -> np.ndarray:
    """Standard deviation along the ray over n gates."""
    x = np.where(np.isfinite(a), a, 0.0).astype(np.float64)
    m = np.isfinite(a).astype(np.float64)
    k = np.ones(n)
    s = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, x)
    s2 = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, x * x)
    c = np.apply_along_axis(lambda r: np.convolve(r, k, "same"), 1, m)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / c
        var = s2 / c - mean * mean
    out = np.sqrt(np.maximum(var, 0.0))
    out[c < n // 2] = np.nan
    return out.astype(np.float32)


def _trap(x: np.ndarray, a: Any, b: Any, c: Any, d: Any) -> np.ndarray:
    """Trapezoid membership: 0 below a, rising to 1 at b, 1 to c, 0 at d."""
    with np.errstate(invalid="ignore", divide="ignore"):
        up = np.clip((x - a) / np.maximum(b - a, 1e-6), 0, 1)
        down = np.clip((d - x) / np.maximum(d - c, 1e-6), 0, 1)
    out = np.minimum(up, down)
    return np.where(np.isfinite(x), out, np.nan)


# NEXRAD's class codes, so the hydrometeor palette and legend read the same.
HCA_CODES = {"BS": 10, "GC": 20, "CR": 30, "DS": 40, "WS": 50, "RA": 60, "HR": 70, "BD": 80, "GR": 90, "RH": 100,
             "LH": 110, "UK": 140}


def _hca(sw: Sweep, alt_m: float, env: dict) -> Optional[np.ndarray]:
    """Hydrometeor classification after Park et al. (2009): fuzzy membership
    of reflectivity, ZDR, correlation, log KDP and the textures of
    reflectivity and differential phase, then the melting layer (from the
    model's freezing level) says which classes can be where."""
    z = sw.data.get("DBZH", sw.data.get("TH"))
    zdr, rho = sw.data.get("ZDR"), sw.data.get("RHOHV")
    if z is None or zdr is None or rho is None:
        return None
    kdp = sw.data.get("KDP")
    phi = sw.data.get("PHIDP")
    with np.errstate(invalid="ignore", divide="ignore"):
        lkdp = np.where(np.isfinite(kdp) & (kdp > 0.001), 10.0 * np.log10(np.maximum(kdp, 0.001)), -30.0) \
            if kdp is not None else np.full(z.shape, np.nan, dtype=np.float32)
    sdz = _texture(z)
    sdp = _texture(phi) if phi is not None else np.full(z.shape, np.nan, dtype=np.float32)
    f1 = -0.50 + 2.50e-3 * z + 7.50e-4 * z * z
    f2 = 0.68 - 4.81e-2 * z + 2.92e-3 * z * z
    f3 = 1.42 + 6.67e-2 * z + 4.85e-4 * z * z
    g1 = -44.0 + 0.8 * z
    g2 = -22.0 + 0.5 * z
    sd_z_ok = (0, 0.5, 3, 6)
    sd_p_ok = (0, 1, 15, 30)
    # class: (Z, ZDR, RHOHV, LKDP, SD(Z), SD(PHI)) trapezoids, and the weights.
    spec = {
        "GC": ((15, 20, 70, 80), (-4, -2, 1, 2), (0.5, 0.6, 0.9, 0.95), (-30, -25, 10, 20), (2, 4, 10, 15),
               (30, 40, 50, 60), (0.2, 0.4, 1.0, 0.0, 0.6, 0.8)),
        "BS": ((5, 10, 20, 30), (0, 2, 10, 12), (0.3, 0.5, 0.8, 0.83), (-30, -25, 10, 10), (1, 2, 4, 7),
               (8, 10, 40, 60), (0.4, 0.6, 1.0, 0.0, 0.8, 0.8)),
        "DS": ((5, 10, 35, 40), (-0.3, 0, 0.3, 0.6), (0.95, 0.98, 1, 1.01), (-30, -25, 10, 20), sd_z_ok, sd_p_ok,
               (1.0, 0.8, 0.6, 0.0, 0.2, 0.2)),
        "WS": ((25, 30, 40, 50), (0.5, 1, 2, 3), (0.88, 0.92, 0.95, 0.985), (-30, -25, 10, 20), sd_z_ok, sd_p_ok,
               (0.6, 0.8, 1.0, 0.0, 0.2, 0.2)),
        "CR": ((0, 5, 20, 25), (0.1, 0.4, 3, 3.3), (0.95, 0.98, 1, 1.01), (-5, 0, 10, 15), sd_z_ok, sd_p_ok,
               (1.0, 0.6, 0.4, 0.5, 0.2, 0.2)),
        "GR": ((25, 35, 50, 55), (-0.3, 0, f1, f1 + 0.3), (0.9, 0.97, 1, 1.01), (-30, -25, 10, 20), sd_z_ok, sd_p_ok,
               (0.8, 1.0, 0.4, 0.0, 0.2, 0.2)),
        "BD": ((20, 25, 45, 50), (f2 - 0.3, f2, f3, f3 + 1), (0.92, 0.95, 1, 1.01), (g1 - 1, g1, g2, g2 + 1),
               sd_z_ok, sd_p_ok, (0.8, 1.0, 0.6, 0.0, 0.2, 0.2)),
        "RA": ((5, 10, 45, 50), (f1 - 0.3, f1, f2, f2 + 0.5), (0.95, 0.97, 1, 1.01), (-30, -25, g1, g1 + 1), sd_z_ok,
               sd_p_ok, (1.0, 0.8, 0.6, 0.0, 0.2, 0.2)),
        "HR": ((40, 45, 55, 60), (f1 - 0.3, f1, f2, f2 + 0.5), (0.92, 0.95, 1, 1.01), (g1 - 1, g1, g2, g2 + 1),
               sd_z_ok, sd_p_ok, (1.0, 0.8, 0.6, 1.0, 0.2, 0.2)),
        "RH": ((45, 50, 75, 80), (-0.3, 0, f1, f1 + 0.5), (0.75, 0.8, 0.95, 0.97), (-10, -4, g1, g1 + 1), sd_z_ok,
               sd_p_ok, (1.0, 0.8, 0.6, 1.0, 0.2, 0.2)),
    }
    fields = (z, zdr, rho, lkdp, sdz, sdp)
    h, _ = _beam(sw, alt_m)
    h0 = float(env["h0"])
    above = (h >= h0)[None, :]                 # above the freezing level
    melt = ((h < h0) & (h >= h0 - 700.0))[None, :]   # the melting layer, ~700 m under 0 C
    below = (h < h0 - 700.0)[None, :]
    allowed = {
        "GC": below | melt, "BS": below | melt, "DS": above | melt, "WS": melt, "CR": above, "GR": above | melt,
        "BD": below | melt, "RA": below | melt, "HR": below, "RH": np.ones_like(above),
    }
    names = list(spec)
    scores = np.full((len(names),) + z.shape, -1.0, dtype=np.float32)
    for i, n in enumerate(names):
        *traps, weights = spec[n]
        num = np.zeros(z.shape, dtype=np.float32)
        den = np.zeros(z.shape, dtype=np.float32)
        for fld, tr, w in zip(fields, traps, weights):
            if w == 0:
                continue
            p = _trap(fld, *tr)
            ok = np.isfinite(p)
            num += np.where(ok, w * p, 0.0)
            den += np.where(ok, w, 0.0)
        with np.errstate(invalid="ignore", divide="ignore"):
            a = np.where(den > 0, num / den, -1.0)
        scores[i] = np.where(allowed[n], a, -1.0)
    best = np.argmax(scores, axis=0)
    top = np.max(scores, axis=0)
    codes = np.array([HCA_CODES[n] for n in names], dtype=np.float32)[best]
    # Hail big enough to matter: rain/hail where reflectivity reaches 60 dBZ.
    codes = np.where((codes == HCA_CODES["RH"]) & (z >= 60.0), HCA_CODES["LH"], codes)
    codes = np.where(top < 0.35, HCA_CODES["UK"], codes)
    codes[~np.isfinite(z)] = np.nan
    return codes.astype(np.float32)


def _rain_rate(sw: Sweep, alt_m: float, env: dict, hca: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """Instantaneous rain rate (mm/h): R(KDP) where hail or heavy rain makes
    reflectivity unreliable, R(Z, ZDR) in rain, R(Z) where nothing else is
    there; nothing above the melting layer."""
    z = sw.data.get("DBZH", sw.data.get("TH"))
    if z is None:
        return None
    zl = np.power(10.0, np.clip(z, -10, 60) / 10.0)
    r_z = 1.70e-2 * np.power(zl, 0.714)                      # Z = 300 R^1.4
    out = r_z
    zdr = sw.data.get("ZDR")
    if zdr is not None:
        zdr_l = np.power(10.0, np.clip(zdr, 0.2, 6.0) / 10.0)
        r_zz = 6.70e-3 * np.power(zl, 0.927) * np.power(zdr_l, -3.43)
        out = np.where(np.isfinite(zdr) & (z > 20), r_zz, out)
    kdp = sw.data.get("KDP")
    if kdp is not None:
        r_k = 44.0 * np.power(np.abs(np.where(np.isfinite(kdp), kdp, 0.0)), 0.822)
        heavy = np.isfinite(kdp) & (kdp > 0.3) & (z > 40)
        if hca is not None:
            heavy |= np.isin(hca, [HCA_CODES["RH"], HCA_CODES["LH"], HCA_CODES["HR"]]) & np.isfinite(kdp)
        out = np.where(heavy, r_k, out)
    h, _ = _beam(sw, alt_m)
    out = np.where((h < float(env["h0"]) - 500.0)[None, :], out, np.nan)
    out[~np.isfinite(z) | (z < 10)] = np.nan
    return np.clip(out, 0, 400).astype(np.float32)


def _volume_products(vol: Volume, env: dict) -> dict[str, tuple[Sweep, np.ndarray]]:
    """Composite reflectivity, echo tops (kft), VIL (kg/m2), SHI, MEHS (mm)
    and POSH (%), on the lowest reflectivity sweep's grid."""
    zname = "DBZH" if any("DBZH" in s.data for s in vol.sweeps) else "TH"
    base = next((s for s in vol.sweeps if zname in s.data), None)
    if base is None:
        return {}
    vals, heights = _columns(vol, base, zname)
    if not vals:
        return {}
    Z = np.stack(vals)                      # sweeps x rays x gates
    H = np.stack(heights).astype(np.float32)
    out: dict[str, tuple[Sweep, np.ndarray]] = {}
    with np.errstate(invalid="ignore"):
        cref = np.nanmax(Z, axis=0)
    out["CR"] = (base, cref.astype(np.float32))

    # Echo tops at 18 dBZ: the highest sweep still at 18, raised to where the
    # sweep above it falls under 18 (linear in height).
    thr = 18.0
    ok = Z >= thr
    n = Z.shape[0]
    idx = np.where(ok.any(axis=0), n - 1 - np.argmax(ok[::-1], axis=0), -1)
    rows, cols = np.indices(idx.shape)
    safe = np.clip(idx, 0, n - 1)
    top_h = H[safe, rows, cols]
    nxt = np.clip(idx + 1, 0, n - 1)
    z_lo, z_hi = Z[safe, rows, cols], Z[nxt, rows, cols]
    h_hi = H[nxt, rows, cols]
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.clip((z_lo - thr) / (z_lo - np.where(np.isfinite(z_hi), z_hi, -30.0)), 0, 1)
    # Where the sweep above does not reach (out of its range), the top stays the highest sweep's.
    interp = np.where((idx < n - 1) & (idx >= 0) & np.isfinite(z_hi), top_h + frac * (h_hi - top_h), top_h)
    et = np.where(idx >= 0, interp / 304.8, np.nan)       # kft
    out["ET"] = (base, et.astype(np.float32))

    # VIL (Greene and Clark): 3.44e-6 x mean(Z)^(4/7) x dh, reflectivity capped at 56 dBZ.
    zc = np.where(np.isfinite(Z), np.minimum(Z, 56.0), np.nan)
    zl = np.where(np.isfinite(zc) & (zc >= 18), np.power(10.0, zc / 10.0), 0.0)
    vil = np.zeros(Z.shape[1:], dtype=np.float64)
    for k in range(n - 1):
        dh = np.maximum(H[k + 1] - H[k], 0.0)
        vil += 3.44e-6 * np.power((zl[k] + zl[k + 1]) / 2.0, 4.0 / 7.0) * dh
    vil = np.where(np.isfinite(cref) & (cref >= 18), vil, np.nan)
    out["VIL"] = (base, vil.astype(np.float32))

    # Hail (Witt et al. 1998): the kinetic energy flux of hail above the
    # freezing level, weighted toward -20 C, summed through the column.
    h0, h20 = float(env["h0"]), float(env["h20"])
    w_z = np.clip((Z - 40.0) / 10.0, 0, 1)
    e = 5e-6 * np.power(10.0, 0.084 * np.where(np.isfinite(Z), Z, 0.0)) * np.where(np.isfinite(Z), w_z, 0.0)
    w_t = np.clip((H - h0) / max(h20 - h0, 1.0), 0, 1)
    # Each sweep stands for the layer from halfway to the one below to halfway to the one above.
    mid = (H[1:] + H[:-1]) / 2.0
    lo = np.concatenate([H[:1], mid], axis=0)
    hi = np.concatenate([mid, H[-1:] + (H[-1:] - mid[-1:] if n > 1 else 500.0)], axis=0)
    dh = np.maximum(hi - lo, 0.0)
    shi = 0.1 * np.nansum(w_t * e * dh * (H >= h0), axis=0)
    mehs = np.where(shi > 0, 2.54 * np.sqrt(shi), np.nan)
    wt = max(57.5 * (h0 / 1000.0) - 121.0, 20.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        posh = np.clip(29.0 * np.log(shi / wt) + 50.0, 0, 100)
    posh = np.where(shi > 0, np.round(posh / 10.0) * 10.0, np.nan)
    posh = np.where(posh > 0, posh, np.nan)
    mehs = np.where(mehs >= 1.0, mehs, np.nan)
    out["SHI"] = (base, np.where(shi > 0, shi, np.nan).astype(np.float32))
    out["MEHS"] = (base, mehs.astype(np.float32))
    out["POSH"] = (base, posh.astype(np.float32))
    return out


# ---------------------------------------------------------------------------
# The radar viewer's terms: families, tilts, the wire format
# ---------------------------------------------------------------------------
SLOTS = "0123456789ABCDEFGHIJKLMNOPQRSTUV"

# family id (as the viewer's catalogue has it) -> what it is made of.
TILTED = {
    "B": {"tok": "B", "label": "Reflectivity", "units": "dBZ", "kind": "ref", "moment": "DBZH"},
    "BU": {"tok": "U", "label": "Unfiltered Reflectivity", "units": "dBZ", "kind": "ref", "moment": "TH"},
    "G": {"tok": "G", "label": "Velocity", "units": "kt", "kind": "vel", "moment": "VRAD"},
    "S": {"tok": "S", "label": "Storm Relative Velocity", "units": "kt", "kind": "srv", "moment": "VRAD"},
    "R": {"tok": "R", "label": "Normalized Rotation (NROT)", "units": "", "kind": "nrot", "moment": "VRAD"},
    "L2W": {"tok": "W", "label": "Spectrum Width", "units": "kt", "kind": "sw", "moment": "WRAD"},
    "L2X": {"tok": "X", "label": "Differential Reflectivity", "units": "dB", "kind": "zdr", "moment": "ZDR"},
    "L2C": {"tok": "C", "label": "Correlation Coefficient", "units": "", "kind": "cc", "moment": "RHOHV"},
    "K": {"tok": "K", "label": "Specific Differential Phase", "units": "°/km", "kind": "kdp", "moment": "KDP"},
    "L2P": {"tok": "P", "label": "Differential Phase", "units": "°", "kind": "phi", "moment": "PHIDP"},
    "H": {"tok": "H", "label": "Hydrometeor Classification", "units": "", "kind": "hca", "needs": ("ZDR", "RHOHV")},
    "RR": {"tok": "Q", "label": "Rain Rate (dual-pol)", "units": "mm/h", "kind": "rate", "needs": ()},
}
VOLUME = {
    "CR": {"code": "L2VCR", "label": "Composite Reflectivity", "units": "dBZ", "kind": "ref"},
    "EET": {"code": "L2VET", "label": "Echo Tops (18 dBZ)", "units": "kft", "kind": "tops"},
    "DVL": {"code": "L2VVIL", "label": "Vertically Integrated Liquid", "units": "kg/m²", "kind": "vil"},
    "MEHS": {"code": "L2VMEHS", "label": "Max. Expected Hail Size (MEHS)", "units": "mm", "kind": "mehs"},
    "POSH": {"code": "L2VPOSH", "label": "Prob. of Severe Hail (POSH)", "units": "%", "kind": "posh"},
}
_TOK_FAMILY = {v["tok"]: k for k, v in TILTED.items()}
_CODE_VOLUME = {v["code"]: k for k, v in VOLUME.items()}

# Families the viewer's catalogue has only because of these radars.
EXTRA_FAMILIES = [
    {"id": "BU", "label": "Unfiltered Reflectivity", "units": "dBZ", "kind": "ref", "short": "UZ"},
    {"id": "RR", "label": "Rain Rate (dual-pol)", "units": "mm/h", "kind": "rate", "short": "RR"},
    {"id": "CR", "label": "Composite Reflectivity", "units": "dBZ", "kind": "ref", "short": "CREF"},
    {"id": "MEHS", "label": "Max. Expected Hail Size", "units": "mm", "kind": "mehs", "short": "MEHS"},
    {"id": "POSH", "label": "Prob. of Severe Hail", "units": "%", "kind": "posh", "short": "POSH"},
]


def extra_catalog() -> list[dict]:
    """The families above as the viewer's catalogue lists them (tilts filled
    per radar by its availability)."""
    out = []
    for f in EXTRA_FAMILIES:
        tilts = ([{"code": VOLUME[f["id"]]["code"], "tilt": None, "elev": None, "source": "level2"}]
                 if f["id"] in VOLUME else [{"code": f"L2{TILTED[f['id']]['tok']}0", "tilt": "0", "elev": 0.5,
                                             "source": "level2"}])
        out.append({**f, "tilts": tilts, "source": "level2"})
    return out


def _newest_stamp(radar: str, at: Optional[int] = None) -> Optional[str]:
    if _remote(radar):
        return REMOTE.nearest(radar, at)
    vs = volumes(radar)
    if not vs:
        return None
    if at:
        return min(vs, key=lambda v: abs(v["unix"] - at))["stamp"]
    return vs[-1]["stamp"]


def _carries(fid: str, spec: dict, m: Any) -> bool:
    """Whether a tilt with these moments makes a family."""
    if fid == "H":
        return ("DBZH" in m or "TH" in m) and "ZDR" in m and "RHOHV" in m
    if fid == "RR":
        return "DBZH" in m or "TH" in m
    return spec["moment"] in m


def availability(site: str, at: Optional[int] = None) -> dict:
    """What a Brazilian radar's newest (or nearest `at`) volume carries, in the
    viewer's terms: every family's tilts at the angles flown. A radar with no
    volume kept yet (one the relay lists before its first volume lands)
    answers every family empty, no cuts. A remote radar answers from its file
    index, nothing downloaded: what it has flown of late, by stable slot, and
    when it last sent if it has stopped."""
    fams: dict[str, list] = {fid: [] for fid in (*TILTED, *VOLUME)}
    cuts: list[float] = []
    newest = None
    said: dict[str, Any] = {}
    if _remote(site):
        inv = REMOTE.inventory(site, at)
        newest = inv["newest"]
        said = {"lastSeenUnix": inv["lastSeen"], "note": inv["note"]}
        cuts = [round(elev, 2) for _, elev, _m in inv["tilts"]]
        has_any = {m for _s, _e, ms in inv["tilts"] for m in ms}
        for fid, spec in TILTED.items():
            fams[fid] = [{"tilt": SLOTS[s], "code": f"L2{spec['tok']}{SLOTS[s]}", "elev": round(elev, 2), "source": "level2",
                          "superRes": False} for s, elev, ms in inv["tilts"] if _carries(fid, spec, ms)]
        if "DBZH" in has_any or "TH" in has_any:
            for fid, spec in VOLUME.items():
                fams[fid] = [{"tilt": None, "code": spec["code"], "elev": None, "source": "level2"}]
    else:
        stamp = _newest_stamp(site, at)
        if stamp:
            vol = load(site, stamp)
            newest = vol.unix
            cuts = [round(s.elev, 2) for s in vol.sweeps]
            has_any = {m for s in vol.sweeps for m in s.data}
            for fid, spec in TILTED.items():
                tilts = []
                for i, sw in enumerate(vol.sweeps):
                    if _carries(fid, spec, sw.data):
                        tilts.append({"tilt": SLOTS[i], "code": f"L2{spec['tok']}{SLOTS[i]}", "elev": round(sw.elev, 2),
                                      "source": "level2", "superRes": sw.nrays >= 720})
                fams[fid] = tilts
            zname = "DBZH" in has_any or "TH" in has_any
            for fid, spec in VOLUME.items():
                fams[fid] = [{"tilt": None, "code": spec["code"], "elev": None, "source": "level2"}] if zname else []
    # What only the NEXRADs make (clutter filter power, the precipitation
    # accumulations, the hybrid classification): not here.
    for fid in ("L2F", "HHC", "OHA", "DAA", "DTA"):
        fams.setdefault(fid, [])
    # The Level II derived group (radar_derived: CREF/ET/VIL/DVIL/VROT/PTDS,
    # SRV on every tilt) reads NEXRAD volumes only; these radars have their
    # own composite/tops/VIL/SRV rows above.
    try:
        import radar_derived
        for f in radar_derived.catalog():
            fams.setdefault(f["id"], [])
    except Exception:  # noqa: BLE001 -- availability must answer regardless
        pass
    return {"site": site, "live": at is None, "at": at, "newestScan": newest, "volumeUnix": newest, "cuts": cuts,
            "families": fams, "level2": True, "brazil": True, "checkedAt": int(time.time()), **said}


def empty_families(fams: dict) -> dict:
    """For a NEXRAD radar: the Brazil-only families, as not available there."""
    for f in EXTRA_FAMILIES:
        fams.setdefault(f["id"], [])
    return fams


def cuts(site: str, at: Optional[int] = None) -> dict:
    a = availability(site, at)
    return {"site": site, "cuts": a["cuts"], "elevations": [{"elev": c} for c in a["cuts"]], "volume": a["newestScan"]}


def scans(site: str, limit: int = 0, start: Optional[int] = None) -> list[dict]:
    """The kept volumes as the viewer's scan list, oldest first (none for a
    radar with no volume here yet)."""
    if _remote(site):
        return REMOTE.scans(site, limit, start)
    vs = volumes(site)
    if start:
        vs = [v for v in vs if v["unix"] >= start]
    if limit:
        vs = vs[-limit:]
    return [{"key": f"L2BR:{v['stamp']}", "time": v["unix"]} for v in vs]


_GRIDS: "OrderedDict[tuple, dict]" = OrderedDict()
_GRID_MAX = 96


def _palette(kind: str) -> tuple[str, float, float]:
    from nexrad_core import _KIND_DEFAULT_PALETTE, get_cmap  # noqa: PLC0415
    pid = _KIND_DEFAULT_PALETTE.get(kind, "FILE_DR")
    _, vmin, vmax = get_cmap(pid)
    return pid, vmin, vmax


def _wire(vol: Volume, sw: Sweep, vals: np.ndarray, *, product: str, label: str, units: str, kind: str,
          family: str, tilt: Optional[str], stamp: str, extra: Optional[dict] = None) -> dict:
    pid, vmin, vmax = _palette(kind)
    lut = np.empty(256, dtype=np.float32)
    lut[0] = np.nan
    lut[1:] = np.linspace(vmin, vmax, 255, dtype=np.float32)
    t = (vals - vmin) / ((vmax - vmin) or 1.0)
    codes = np.clip(np.rint(t * 254.0) + 1.0, 1, 255)
    codes[~np.isfinite(vals)] = 0
    codes = codes.astype(np.uint8)
    az = np.empty(sw.nrays + 1, dtype=np.float32)
    az[:-1] = sw.az
    az[-1] = sw.az[0] + 360.0
    nb = codes.shape[1]
    meta = {
        "site": vol.radar[3:], "siteId": vol.radar, "siteLat": vol.lat, "siteLon": vol.lon, "product": product,
        "productLabel": label, "units": units, "kind": kind, "family": family, "tilt": tilt,
        "elevation": round(sw.elev, 2) if tilt is not None else None, "defaultPalette": pid, "vmin": vmin, "vmax": vmax,
        "nAz": int(codes.shape[0]), "nGates": int(nb), "rangeStartKm": sw.r0_km, "gateWidthKm": sw.dr_km,
        "maxRangeKm": sw.r0_km + nb * sw.dr_km, "validUnix": vol.unix, "scanUnix": vol.unix, "key": f"L2BR:{stamp}",
        "source": "level2", "superRes": sw.nrays >= 720, "vcp": None,
        "elevations": vol.ladder if vol.ladder is not None else [
            {"elev": round(s.elev, 2), "actual": round(s.elev, 2), "slot": SLOTS[i]} for i, s in enumerate(vol.sweeps)],
        "radarName": RADARS.get(vol.radar, {}).get("name", vol.name), "files": vol.files,
    }
    if extra:
        meta.update(extra)
    return {"az": az, "lut": lut, "codes": codes, "meta": meta}


# Products drawn from ZDR: their meta says how much the reader moved it.
_ZDR_FAMILIES = ("L2X", "H", "RR")
_Z_MOMENTS = frozenset({"DBZH", "TH"})
_DUALPOL_MOMENTS = _Z_MOMENTS | {"ZDR", "RHOHV", "KDP", "PHIDP"}


# The angles of the NEXRAD's Level III codes (N0B, NAB, N1B...), and the families that
# exist at a remote radar under its own codes.
_L3_ANGLE = {"0": 0.5, "A": 0.9, "1": 1.3, "B": 1.8, "2": 2.4, "3": 3.1}
_L3_CODE = re.compile(r"^N([0A1B23])([BGSRK])$")
_L3_VOLUME = {"EET": "L2VET", "DVL": "L2VVIL"}


def _remote_code(site: str, product: str) -> str:
    """A remote radar's own code for a Level III one: a pane with a radar of its own
    holds the focused NEXRAD's code (as tdwr.to_tdwr does for an airport radar), and a
    first frame can go out before the radar has said what it flies. The tilt nearest
    that angle of that family's; anything else goes through as it is."""
    if product in _L3_VOLUME:
        return _L3_VOLUME[product]
    m = _L3_CODE.match(product)
    if not m:
        return product
    fam = m.group(2)
    spec = TILTED[fam]
    tilts = [(s, elev) for s, elev, ms in REMOTE.inventory(site)["tilts"] if _carries(fam, spec, ms)]
    if not tilts:
        return product
    want = _L3_ANGLE[m.group(1)]
    slot = min(tilts, key=lambda t: abs(t[1] - want))[0]
    return f"L2{spec['tok']}{SLOTS[slot]}"


def _remote_need(product: str) -> tuple[Optional[int], frozenset]:
    """The tilt (None: all) and moments a product of a remote radar is made from."""
    if product in _CODE_VOLUME:
        return None, _Z_MOMENTS
    tok, slot = product[2:3], product[3:]
    fam = _TOK_FAMILY.get(tok)
    if not product.startswith("L2") or fam is None or len(slot) != 1 or slot not in SLOTS:
        raise NoData(f"This radar has no product {product}.")
    moments = _DUALPOL_MOMENTS if fam in ("H", "RR") else frozenset({TILTED[fam]["moment"]})
    return SLOTS.index(slot), moments


def _remote_sweep(vol: Volume, fam: str, spec: dict) -> Optional[Sweep]:
    """The sweep of a remote radar's one-tilt volume that holds what a family needs.
    The classification and the rain rate take several moments, which may sit in
    separate sweeps when they were sent at different times."""
    if fam not in ("H", "RR"):
        return next((s for s in vol.sweeps if spec["moment"] in s.data), None)
    base = next((s for s in vol.sweeps if "DBZH" in s.data or "TH" in s.data), None)
    if base is None:
        return None
    shape = next(iter(base.data.values())).shape
    data = dict(base.data)
    for s in vol.sweeps:
        for k, arr in s.data.items():
            if arr.shape == shape:
                data.setdefault(k, arr)
    return replace(base, data=data)


def polar(site: str, product: str, key: str = "") -> dict:
    """One product of one kept volume (the one `key` names, else the newest),
    in the viewer's polar wire format. Volumes are kept only as import_file
    files them: a file of the user's own, NASA's GPM-VN archive
    (scripts/import_nasa_cemaden.py) or the radar relay
    (radar_relay_client.py); a radar the relay lists before its first volume
    lands has nothing to draw yet. ZDR, the classification and the rain rate
    of a volume whose ZDR the reader corrected carry zdrOffsetDb: the dB
    added to the published ZDR (0.1 dB steps)."""
    remote = _remote(site)
    stamp = key.split(":", 1)[1] if key.startswith("L2BR:") else _newest_stamp(site)
    if not stamp:
        if remote:
            raise NoData(REMOTE.quiet_note(site))
        raise RuntimeError(f"No volume kept for {site} yet: import a file of it, an archive case "
                           "(scripts/import_nasa_cemaden.py), or wait for the radar relay's first volume.")
    if remote:
        product = _remote_code(site, product)
    ck: tuple = (site, stamp, product)
    if remote:
        # A young frame still gains files: a grid stands for the files it was built from.
        need = _remote_need(product)
        names = REMOTE.parts(site, stamp, *need)
        if not names:
            raise NoData(f"{product} is not in this frame of {site}.")
        ck += (names,)
    with _LOCK:
        hit = _GRIDS.get(ck)
        if hit is not None:
            _GRIDS.move_to_end(ck)
            # Young is about now, not about when the grid was built: a frame kept
            # no-store for good would be read again at every new frame.
            if remote:
                hit["meta"]["young"] = REMOTE.is_young(_stamp_unix(stamp))
            return hit
    vol = REMOTE.volume(site, stamp, *need) if remote else load(site, stamp)
    env = None

    def need_env() -> dict:
        nonlocal env
        if env is None:
            env = environment(vol.lat, vol.lon, vol.unix)
        return env

    if product in _CODE_VOLUME:
        fam = _CODE_VOLUME[product]
        spec = VOLUME[fam]
        prods = _volume_products(vol, need_env())
        name = {"CR": "CR", "EET": "ET", "DVL": "VIL", "MEHS": "MEHS", "POSH": "POSH"}[fam]
        if name not in prods:
            raise (NoData if remote else RuntimeError)("This volume has no reflectivity to build it from.")
        base, vals = prods[name]
        out = _wire(vol, base, vals, product=product, label=spec["label"], units=spec["units"], kind=spec["kind"],
                    family=fam, tilt=None, stamp=stamp,
                    extra={"freezingM": env["h0"] if env else None, "minus20M": env["h20"] if env else None,
                           "envSource": env["source"] if env else None})
    else:
        if not product.startswith("L2") or len(product) < 4:
            raise RuntimeError(f"Unknown product {product}")
        tok, slot = product[2], product[3:]
        fam = _TOK_FAMILY.get(tok)
        if fam is None or slot not in SLOTS or (not remote and SLOTS.index(slot) >= len(vol.sweeps)):
            raise RuntimeError(f"Unknown product {product}")
        spec = TILTED[fam]
        if remote:
            sw = _remote_sweep(vol, fam, spec)
            if sw is None:
                raise NoData(f"No {spec['label']} at this elevation in this frame.")
        else:
            sw = vol.sweeps[SLOTS.index(slot)]
        extra: dict[str, Any] = {"nyquistKt": round(sw.nyquist * _MS_TO_KT, 1) if sw.nyquist else None}
        if remote:
            # A frame's sweeps are not all of its moment: scanUnix (the frame, the
            # loop's order) stays, and the labels go by when this one was really made.
            extra.update(validUnix=sw.unix or vol.unix, sweepUnix=sw.unix or vol.unix)
        if fam in _ZDR_FAMILIES and vol.zdr_offset_db is not None and "ZDR" in sw.data:
            # The reader took the offset out: the published ZDR plus this is what is drawn.
            extra["zdrOffsetDb"] = round(-vol.zdr_offset_db, 1)
        if fam in ("G", "S", "R"):
            v = sw.data.get("VRAD")
            if v is None:
                raise RuntimeError("No velocity at this elevation.")
            unfolded = _dealias(sw, vol.alt_m, need_env())
            if unfolded is not None:
                v = unfolded
                extra["dealiased"] = "against the model wind"
            vals = v * _MS_TO_KT
            if fam == "S":
                m = need_env()["motion"]
                centres = np.mod(sw.az + 0.5, 360.0)
                vals = vals - (m["speedKt"] * np.cos(np.radians(centres - m["toward"])))[:, None]
                extra.update(stormMotionKt=m["speedKt"], stormMotionDeg=m["toward"])
            elif fam == "R":
                from nexrad_core import _nrot_field  # noqa: PLC0415
                az_edges = np.append(sw.az, sw.az[0] + 360.0)
                nb = vals.shape[1]
                rng = sw.r0_km + np.arange(nb + 1) * sw.dr_km
                vals = _nrot_field(vals.astype(np.float32), az_edges, rng)
        elif fam == "L2W":
            vals = sw.data["WRAD"] * _MS_TO_KT
        elif fam == "H":
            vals = _hca(sw, vol.alt_m, need_env())
            if vals is None:
                raise (NoData if remote else RuntimeError)("Classification needs reflectivity, ZDR and correlation at this elevation.")
            extra.update(freezingM=env["h0"], envSource=env["source"])
        elif fam == "RR":
            hca = _hca(sw, vol.alt_m, need_env()) if "ZDR" in sw.data and "RHOHV" in sw.data else None
            vals = _rain_rate(sw, vol.alt_m, need_env(), hca)
            if vals is None:
                raise (NoData if remote else RuntimeError)("No reflectivity at this elevation.")
            extra.update(freezingM=env["h0"], envSource=env["source"])
        else:
            m = spec["moment"]
            if m not in sw.data:
                raise RuntimeError(f"No {spec['label']} at this elevation.")
            vals = sw.data[m]
        out = _wire(vol, sw, np.asarray(vals, dtype=np.float32), product=product, label=spec["label"],
                    units=spec["units"], kind=spec["kind"], family=fam, tilt=slot, stamp=stamp, extra=extra)
    if remote:
        meta = out["meta"]
        if product in _CODE_VOLUME:
            meta["validUnix"] = max((s.unix for s in vol.sweeps), default=0) or vol.unix
        # Kept from the browser's day-long cache while its files can still change.
        meta["young"] = REMOTE.is_young(vol.unix)
    # Not cached when a file was filed while it was built (import_file
    # dropped the grids before this one was done): the next call builds it
    # again from the whole volume.
    now = _listed(STORE / site / stamp)
    with _LOCK:
        if not _stale(vol, now):
            _GRIDS[ck] = out
            while len(_GRIDS) > _GRID_MAX:
                _GRIDS.popitem(last=False)
    return out


# ---------------------------------------------------------------------------
# Cross-sections: the volume as radar_xsect's stack
# ---------------------------------------------------------------------------
_XS_MOMENT = {"B": "DBZH", "G": "VRAD", "S": "VRAD", "W": "WRAD", "C": "RHOHV", "X": "ZDR", "P": "PHIDP",
              "K": "KDP", "U": "TH"}


def stack(site: str, key: str, at: Optional[float], fam: str) -> dict:
    """Every sweep of one moment, as radar_xsect.cross_section_stack wants it."""
    stamp = key.split(":", 1)[1] if key.startswith("L2BR:") else _newest_stamp(site, int(at) if at else None)
    if not stamp:
        raise ValueError(REMOTE.quiet_note(site, at=at) if _remote(site) else f"No volume kept for {site}")
    vol = load(site, stamp)
    moment = _XS_MOMENT.get(fam, "DBZH")
    if moment == "DBZH" and not any("DBZH" in s.data for s in vol.sweeps):
        moment = "TH"
    env = environment(vol.lat, vol.lon, vol.unix) if moment == "VRAD" else None
    sweeps = []
    for sw in vol.sweeps:
        if moment not in sw.data:
            continue
        vals = sw.data[moment]
        if moment == "VRAD":
            unfolded = _dealias(sw, vol.alt_m, env)
            vals = (unfolded if unfolded is not None else vals) * _MS_TO_KT
        elif moment == "WRAD":
            vals = vals * _MS_TO_KT
        sweeps.append({"elev": float(sw.elev), "az": sw.az, "first": sw.r0_km, "width": sw.dr_km,
                       "vals": vals.astype(np.float16)})
    if not sweeps:
        raise ValueError("This volume does not carry that moment.")
    out = {"sweeps": sweeps, "lat": vol.lat, "lon": vol.lon, "heightKm": vol.alt_m / 1000.0,
           "groundKm": max(vol.alt_m - 20.0, 0.0) / 1000.0, "stamp": stamp, "vcp": None,
           "key": f"L2BR:{stamp}", "unix": vol.unix}
    if env is not None:
        out["motion"] = env["motion"]
    return out
