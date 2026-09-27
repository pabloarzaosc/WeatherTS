"""
Pictures from map servers that already draw in Web Mercator: EUMETSAT
EUMETView (Meteosat rapid scan, Metop, some Meteosat-12 RGBs) and NASA GIBS
(NOAA-20 / NOAA-21 VIIRS).

Both answer a WMS GetMap for any box in EPSG:3857 with the time as a
parameter, so a frame is one request. Two products are channels of a
composite rather than layers of their own -- the AVHRR visible channels, and
VIIRS I1-I3, which NASA only publishes inside RGBs: each colour channel of an
RGB is one band's picture, so taking it out gives that band.
"""
from __future__ import annotations

import io
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

import sat_geo as geo
import sat_net as net

EUMETVIEW = "https://view.eumetsat.int/geoserver/wms"
GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi"
_R = 6378137.0
_HALF = 20037508.342789244

_CAPS_LOCK = threading.Lock()
_CAPS: dict[str, tuple[float, dict[str, str]]] = {}


def _eumetview_dims() -> dict[str, str]:
    """layer -> its time dimension "start/end/period", from the capabilities
    (kept five minutes: new scans every five to fifteen)."""
    with _CAPS_LOCK:
        hit = _CAPS.get("ev")
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    try:
        text = net.get(EUMETVIEW, params={"service": "WMS", "request": "GetCapabilities", "version": "1.3.0"},
                       timeout=(8, 40)).text
    except Exception:  # noqa: BLE001
        return hit[1] if hit else {}
    out: dict[str, str] = {}
    for m in re.finditer(r"<Layer[^>]*>\s*<Name>([^<]+)</Name>(.*?)</Layer>", text, re.S):
        d = re.search(r'<Dimension name="time"[^>]*>([^<]+)</Dimension>', m.group(2))
        if d:
            out[m.group(1)] = d.group(1).strip()
    with _CAPS_LOCK:
        _CAPS["ev"] = (time.time(), out)
    return out


def _period(p: str) -> timedelta:
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", p)
    if not m:
        return timedelta(minutes=15)
    d, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return timedelta(days=d, hours=h, minutes=mi, seconds=s)


def _parse(t: str) -> datetime:
    t = t.replace(".000Z", "Z")
    return datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def times(params: dict, count: int) -> list[datetime]:
    if params["service"] == "gibs":
        # A picture a day; today's fills in as the day's passes arrive.
        # Until midday UTC today's is mostly empty, so the newest is yesterday's.
        now = datetime.now(timezone.utc)
        newest = now.replace(hour=0, minute=0, second=0, microsecond=0)
        if now.hour < 12:
            newest -= timedelta(days=1)
        return [newest - timedelta(days=k) for k in range(count - 1, -1, -1)]
    dims = _eumetview_dims()
    dim = dims.get(params["layer"])
    if not dim and params["layer"].startswith("eps:"):
        # EUMETView drops a Metop layer from its capabilities now and then
        # (Metop-B's IR and ASCAT on 2026-09-26) while still drawing it for a
        # time asked: the same orbit's RGB layer lists the passes.
        sat = params["layer"].split(":", 1)[1].split("_", 1)[0]
        dim = dims.get(f"eps:{sat}_rgb_124") or dims.get(f"eps:{sat}_rgb_natural_fog")
    if not dim:
        return []
    parts = dim.split(",")[-1].split("/")
    if len(parts) != 3:
        return []
    start, end, step = _parse(parts[0]), _parse(parts[1]), _period(parts[2])
    out = []
    t = end
    while len(out) < count and t >= start:
        out.append(t)
        t -= step
    return sorted(out)


def _merc_x(lon: float) -> float:
    return lon / 180.0 * _HALF


def _getmap(params: dict, when: datetime, box: tuple[float, float, float, float], w: int, h: int) -> np.ndarray:
    from PIL import Image  # noqa: PLC0415

    west, south, east, north = box
    y0 = float(geo.merc_y(south)) * _R
    y1 = float(geo.merc_y(north)) * _R
    if params["service"] == "gibs":
        base = GIBS
        fmt = "image/png" if params.get("png") else "image/jpeg"
        tstr = when.strftime("%Y-%m-%d")
    else:
        base = EUMETVIEW
        fmt = "image/png"
        tstr = when.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    q = {"service": "WMS", "request": "GetMap", "version": "1.3.0", "layers": params["layer"], "styles": "",
         "crs": "EPSG:3857", "bbox": f"{_merc_x(west)},{y0},{_merc_x(east)},{y1}", "width": str(w),
         "height": str(h), "format": fmt, "transparent": "true", "time": tstr}
    ck = base + "?" + "&".join(f"{k}={v}" for k, v in sorted(q.items()))
    data = net.disk_get("wms", ck)
    if data is None:
        r = net.get(base, params=q, tries=3, timeout=(8, 60))
        if "image" not in r.headers.get("content-type", ""):
            raise net.Missing(f"{params['layer']}: {r.text[:200]}")
        data = r.content
        net.disk_put("wms", ck, data)
    img = Image.open(io.BytesIO(data)).convert("RGBA")
    return np.asarray(img).copy()


def _wrapped(params: dict, when: datetime, box, w: int, h: int) -> np.ndarray:
    """A box past the date line is asked for in its world copy, or in two
    halves stitched together when it straddles the line."""
    west, south, east, north = box
    shift = 0.0
    if west >= 180.0:
        shift = -360.0
    elif east <= -180.0:
        shift = 360.0
    west, east = west + shift, east + shift
    if west >= -180.0 and east <= 180.0:
        return _getmap(params, when, (west, south, east, north), w, h)
    cut = 180.0 if east > 180.0 else -180.0
    wl = int(round(w * (cut - west) / (east - west)))
    wl = min(max(wl, 1), w - 1)
    if cut == 180.0:
        a = _getmap(params, when, (west, south, 180.0, north), wl, h)
        b = _getmap(params, when, (-180.0, south, east - 360.0, north), w - wl, h)
    else:
        a = _getmap(params, when, (west + 360.0, south, 180.0, north), wl, h)
        b = _getmap(params, when, (-180.0, south, east, north), w - wl, h)
    return np.concatenate([a, b], axis=1)


def render(params: dict, when: datetime, box, w: int, h: int) -> np.ndarray:
    img = _wrapped(params, when, box, w, h)
    ch = params.get("channel")
    if ch is not None:
        v = img[..., ch]
        img = np.dstack([v, v, v, img[..., 3]])
    if params["service"] == "gibs" and not params.get("png"):
        # JPEG composites: no alpha, black where no pass covered the ground.
        dark = img[..., :3].max(axis=2) <= 6
        img[..., 3] = np.where(dark, 0, 255)
    if params.get("day_only"):
        lon, lat = geo.mercator_grid(*box, w, h)
        sza = geo.solar_zenith(lon, lat, when)
        img[..., 3] = np.where(sza < 84.0, img[..., 3], 0)
    return img.astype("uint8")
