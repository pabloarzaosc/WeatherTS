"""
NEXRAD VAD Wind Profile (VWP) — Level III product NVW (48).

The WSR-88D's Velocity Azimuth Display algorithm fits a wind to each range ring
of a velocity sweep, giving a radar-derived wind profile every volume scan.

Unlike the storm-attribute products, MetPy decodes NVW's TABULAR page cleanly,
and that page is far better than the graphic block: it carries the numbers the
radar actually computed rather than the pixels of the time-height chart.

    VAD Algorithm Output  08/09/26  04:47
    ALT      U       V       W    DIR   SPD   RMS     DIV     SRNG    ELEV
   100ft    m/s     m/s    cm/s   deg   kts   kts    E-3/s     nm      deg
    010    -4.3     7.4     NA    150   017   5.5      NA      4.00    0.5

One file is one volume, i.e. ONE column of the classic time-height display, so
the profile history is built by walking back through the archive keys — which
also means the caller chooses how far back to look instead of being stuck with
the ten columns the radar happened to draw.
"""
from __future__ import annotations

import io
import re
import time
from typing import Any, Optional

from metpy.io import Level3File

from nexrad_core import (
    S3,
    _HTTP_TIMEOUT,
    _SESSION,
    _utc_unix,
    key_time,
    list_scans,
)

PRODUCT = "NVW"
FT_PER_100FT = 100.0
M_PER_FT = 0.3048
MAX_COLUMNS = 24

_CACHE: dict[tuple, tuple[float, dict]] = {}
_TTL = 90.0
# A decoded VWP column never changes, so keep them keyed by S3 key with no TTL.
_COLUMN_CACHE: dict[str, dict] = {}
_COLUMN_CACHE_MAX = 400

_NA = {"NA", "N/A", "", "-", "--"}


def _f(tok: str) -> Optional[float]:
    if tok.upper() in _NA:
        return None
    try:
        v = float(tok)
    except ValueError:
        return None
    return v if v == v else None


def _tab_text(f: "Level3File") -> str:
    """Flatten MetPy's tab_pages into one string, whatever nesting it used."""
    pages = getattr(f, "tab_pages", None)
    if not pages:
        return ""
    out: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            out.append(node)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(pages)
    return "\n".join(out)


def parse_columns(text: str) -> list[dict]:
    """Parse the VAD Algorithm Output table into level rows."""
    levels: list[dict] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("VAD") or s.startswith("ALT") or s.startswith("100ft"):
            continue
        parts = s.split()
        # ALT U V W DIR SPD RMS DIV SRNG ELEV — 10 columns, first must be numeric.
        if len(parts) < 7 or not re.fullmatch(r"\d{1,4}", parts[0]):
            continue
        alt100ft = _f(parts[0])
        if alt100ft is None:
            continue
        u = _f(parts[1])
        v = _f(parts[2])
        w = _f(parts[3]) if len(parts) > 3 else None
        d = _f(parts[4]) if len(parts) > 4 else None
        spd = _f(parts[5]) if len(parts) > 5 else None
        rms = _f(parts[6]) if len(parts) > 6 else None
        div = _f(parts[7]) if len(parts) > 7 else None
        srng = _f(parts[8]) if len(parts) > 8 else None
        elev = _f(parts[9]) if len(parts) > 9 else None
        if d is None or spd is None:
            continue
        ft = alt100ft * FT_PER_100FT
        levels.append({
            "altFt": round(ft),
            "altM": round(ft * M_PER_FT),
            "u": u,
            "v": v,
            "wCmS": w,
            "dirDeg": round(d),
            "spdKt": round(spd),
            "rmsKt": rms,
            "divE3": div,
            "srngNm": srng,
            "elevDeg": elev,
        })
    # Several rows can share an altitude (different elevation cuts); keep the
    # lowest-RMS one so the profile has a single wind per height.
    best: dict[int, dict] = {}
    for lv in levels:
        cur = best.get(lv["altFt"])
        if cur is None or (lv["rmsKt"] or 99) < (cur["rmsKt"] or 99):
            best[lv["altFt"]] = lv
    return sorted(best.values(), key=lambda l: l["altFt"])


def _column(key: str) -> Optional[dict]:
    hit = _COLUMN_CACHE.get(key)
    if hit is not None:
        return hit
    try:
        raw = _SESSION.get(f"{S3}{key}", timeout=_HTTP_TIMEOUT).content
        f = Level3File(io.BytesIO(raw))
    except Exception:
        return None
    levels = parse_columns(_tab_text(f))
    if not levels:
        return None
    col = {
        "key": key,
        "unix": _utc_unix(f.metadata.get("prod_time")) or key_time(key),
        "levels": levels,
        "siteLat": float(f.lat),
        "siteLon": float(f.lon),
        # Filed with the product: the strongest wind the algorithm found and
        # the height it sat at, which is what the VWP's own header shows.
        "maxKt": f.metadata.get("max"),
        # `alt_max` is already in feet here, unlike the table's ALT column which
        # counts hundreds of feet -- scaling it again put the max wind at 1.3
        # million feet.
        "maxAltFt": f.metadata.get("alt_max"),
        "maxDirDeg": f.metadata.get("dir_max"),
    }
    _COLUMN_CACHE[key] = col
    while len(_COLUMN_CACHE) > _COLUMN_CACHE_MAX:
        _COLUMN_CACHE.pop(next(iter(_COLUMN_CACHE)))
    return col


def build_vwp(site: str, columns: int = 12) -> dict:
    """The last `columns` VAD profiles for a radar, oldest -> newest."""
    site = (site or "").upper().strip()
    if len(site) != 3:
        raise ValueError("site must be the 3-letter radar id, e.g. 'FWS'")
    columns = max(1, min(int(columns), MAX_COLUMNS))

    ck = (site, columns)
    now = time.time()
    hit = _CACHE.get(ck)
    if hit and now - hit[0] < _TTL:
        return hit[1]

    scans = list_scans(site, PRODUCT, limit=columns)
    if not scans:
        raise RuntimeError(f"No VAD wind profile available for K{site}.")

    cols: list[dict] = []
    for s in scans:
        c = _column(s["key"])
        if c is not None:
            cols.append(c)
    if not cols:
        raise RuntimeError(f"K{site} published VAD scans but none carried a readable profile.")

    heights = sorted({lv["altFt"] for c in cols for lv in c["levels"]})
    latest = cols[-1]
    out = {
        "meta": {
            "site": f"K{site}",
            "siteLat": latest["siteLat"],
            "siteLon": latest["siteLon"],
            "columns": len(cols),
            "heightsFt": heights,
            "validUnix": latest["unix"],
            "maxKt": latest["maxKt"],
            "maxAltFt": latest["maxAltFt"],
            "maxDirDeg": latest["maxDirDeg"],
            "source": "NEXRAD Level III VAD Wind Profile (NVW) via Unidata",
        },
        "columns": [
            {"unix": c["unix"], "key": c["key"], "levels": c["levels"]} for c in cols
        ],
    }
    _CACHE[ck] = (now, out)
    return out
