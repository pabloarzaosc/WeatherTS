"""
Surface fronts, troughs and pressure centres from the WPC Coded Surface Bulletin.

Source: https://www.wpc.ncep.noaa.gov/discussions/codsus — the plain-text coded
form of the Unified Surface Analysis that WPC issues every 3 hours. Structure:

    VALID 080900Z
    HIGHS 1017 4190 1020 3685 ...        pressure then position, repeating
    LOWS  1006 43104 ...
    COLD WK 46101 46103 45106 ...        type, strength, then the polyline
    WARM WK 79-11 76-2 757
    STNRY WK 5258 5361 5767 5872
    OCFNT WK 6188 6387 6382 6076 5872
    TROF 54126 52124 51122 ...           troughs carry no strength field
    $$

COORDINATES are whole degrees packed into one token: latitude first, then
longitude WEST-positive (a negative longitude means east, e.g. `37-3` is 37N 3E).
The split is genuinely ambiguous for short tokens -- `360` is both "3N 60W" and
"36N 0W" -- so it is resolved by CONTINUITY along each polyline, which is the
only signal the format actually gives. Verified against a live bulletin: the
Moroccan trough `327 345 352 360` decodes as 32N7W -> 34N5W -> 35N2W -> 36N0W,
and the Atlantic tropical wave `835 1335 1636 1937` as 8N35W -> 13N35W, both of
which a fixed-width split gets wrong.
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BULLETIN = "https://www.wpc.ncep.noaa.gov/discussions/codsus"

# The same coded grammar is issued as three products. api.weather.gov carries
# all of them WITH history, which is what lets the fronts ride the timeline
# instead of being stuck on "latest".
NWS_API = "https://api.weather.gov"
PRODUCT_TYPE = "COD"          # "Coded Analysis and Forecasts"
LOC_ANALYSIS = "SUS"          # CODSUS  -- surface frontal positions (analysis)
LOC_FORECAST = "SRP"          # CODSRP  -- the 12 h and 24 h progs

# Line keywords. Anything else at the start of a line is a CONTINUATION of the
# previous one -- the forecast bulletin wraps at ~72 characters, mid-polyline.
_KEYWORDS = {"HIGHS", "LOWS", "COLD", "WARM", "STNRY", "OCFNT", "TROF"}

_HTTP_TIMEOUT = (8, 30)
_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.0 (desktop weather app)"
_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(total=3, connect=3, read=2, backoff_factor=0.5,
                          status_forcelist=(429, 500, 502, 503, 504),
                          allowed_methods=frozenset(["GET"]))
    ),
)

# Bulletin keyword -> what the map draws.
FRONT_KINDS: dict[str, dict[str, str]] = {
    "COLD": {"id": "cold", "label": "Cold front"},
    "WARM": {"id": "warm", "label": "Warm front"},
    "STNRY": {"id": "stationary", "label": "Stationary front"},
    "OCFNT": {"id": "occluded", "label": "Occluded front"},
    "TROF": {"id": "trough", "label": "Trough"},
}
STRENGTHS = {"WK": "weak", "MDT": "moderate", "STG": "strong"}

# Keyed on the (history, forecast) arguments, because those change which frames
# are built. This was declared but never read, so every request re-parsed every
# bulletin from scratch -- the endpoint measured ~15 s. The product TEXT was
# already cached; the expensive part is decoding the coded fronts into GeoJSON.
_CACHE: dict[tuple[int, bool], tuple[float, dict]] = {}
_TTL = 600.0  # the bulletin is 3-hourly; 10 min is plenty fresh


def _candidates(tok: str) -> list[tuple[float, float]]:
    """Every (lat, lon) a coded token could mean, best guess first.

    Longitude is the tail of the token and may carry a leading '-' (east).
    Latitude is whatever precedes it, 1 or 2 digits.
    """
    m = re.fullmatch(r"(\d{1,2})(-?\d{1,3})", tok)
    out: list[tuple[float, float]] = []
    seen: set[tuple[float, float]] = set()
    # Walk every legal split; a 2-digit latitude is listed first because it is
    # right for the overwhelming majority of tokens.
    for cut in (2, 1):
        if cut >= len(tok):
            continue
        head = tok[:cut]
        tail = tok[cut:]
        if not head.isdigit() or not re.fullmatch(r"-?\d{1,3}", tail):
            continue
        lat = float(head)
        lon = -float(tail)  # bulletin is west-positive
        if not (0 <= lat <= 90) or not (-180 <= lon <= 180):
            continue
        if (lat, lon) in seen:
            continue
        seen.add((lat, lon))
        out.append((lat, lon))
    if not out and m:
        out.append((float(m.group(1)), -float(m.group(2))))
    return out


def _wrap180(d: float) -> float:
    """Longitude difference folded into [-180, 180]."""
    return (d + 180.0) % 360.0 - 180.0


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Rough great-circle distance in degrees; good enough to pick a split.

    The longitude difference is folded, or every Pacific front looks like a
    350-degree jump and the continuity decoder picks the wrong split.
    """
    dlat = a[0] - b[0]
    dlon = _wrap180(a[1] - b[1]) * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


def _unwrap(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Make a polyline's longitudes continuous across the antimeridian.

    A front running 177E -> 179W is two points 4 degrees apart, but as raw
    coordinates they read +177 and -179, so a renderer draws the 356-degree way
    round -- which is the red and blue lines that were striping the whole map.
    Letting longitude run past +/-180 (e.g. -181) keeps the segment short;
    MapLibre wraps it back for display.
    """
    if not pts:
        return pts
    out = [pts[0]]
    for lat, lon in pts[1:]:
        prev_lon = out[-1][1]
        out.append((lat, prev_lon + _wrap180(lon - prev_lon)))
    return out


def _decode_line(tokens: list[str]) -> list[tuple[float, float]]:
    """Decode a polyline, choosing each token's split to keep the line continuous."""
    cands = [_candidates(t) for t in tokens]
    cands = [c for c in cands if c]
    if not cands:
        return []

    # Seed: if the first token is ambiguous, pick the reading that sits closest
    # to any reading of the second token.
    pts: list[tuple[float, float]] = []
    if len(cands) == 1:
        return [cands[0][0]]
    best = None
    for a in cands[0]:
        for b in cands[1]:
            d = _dist(a, b)
            if best is None or d < best[0]:
                best = (d, a)
    pts.append(best[1] if best else cands[0][0])

    for c in cands[1:]:
        prev = pts[-1]
        # Nearest reading wins; ties fall back to the 2-digit-latitude default,
        # which is first in the candidate list.
        pick = min(c, key=lambda p: _dist(prev, p))
        pts.append(pick)
    return _unwrap(pts)


def _decode_point(tok: str) -> Optional[tuple[float, float]]:
    """Isolated position (a high/low centre) -- no neighbours to lean on, so the
    2-digit-latitude reading wins, which is correct for every centre observed."""
    c = _candidates(tok)
    return c[0] if c else None


def _valid_candidates(tok: str, ref: datetime) -> list[datetime]:
    """Every date the 6-digit VALID token could mean, near a reference time.

    The two coded products do NOT agree on field order, which is only visible by
    checking them against their own issuance times:

        CODSUS  VALID 080921Z  issued 09 22:30Z  ->  MMDDHH  (Aug 9, 21Z)
        CODSRP  VALID 100600Z  issued 09 18:58Z  ->  DDHHMM  (Aug 10, 06:00Z)

    Reading CODSUS as DDHHMM yields "day 8, 09:21" -- three analyses three
    MINUTES apart on the previous day, which is nonsense but parses cleanly. So
    both readings are generated and the caller picks by fit rather than by
    trusting a documented order that the products do not share.
    """
    a, b, c = int(tok[0:2]), int(tok[2:4]), int(tok[4:6])
    out: list[datetime] = []
    for month, day, hour, minute in ((a, b, c, 0), (None, a, b, c)):
        for year_shift in (0, -1, 1):
            try:
                yr = ref.year
                mo = month if month is not None else ref.month
                if month is None:
                    # DDHHMM: the day belongs to the month around `ref`, which
                    # may have rolled over.
                    mo = (ref.month + year_shift - 1) % 12 + 1
                    yr = ref.year + ((ref.month + year_shift - 1) // 12)
                elif year_shift:
                    yr = ref.year + year_shift
                out.append(datetime(yr, mo, day, hour, minute, tzinfo=timezone.utc))
            except ValueError:
                continue
    return out


def _valid_time(text: str, issued: Optional[datetime] = None,
                lead_hours: float = 0.0) -> tuple[Optional[str], Optional[int]]:
    """The VALID time, chosen as whichever reading sits closest to where it
    should be: an analysis just before its issuance, a prog `lead_hours` after."""
    m = re.search(r"VALID\s+(\d{6})Z", text)
    if not m:
        return None, None
    ref = issued or datetime.now(timezone.utc)
    target = ref + timedelta(hours=lead_hours)
    cands = _valid_candidates(m.group(1), ref)
    if not cands:
        return None, None
    best = min(cands, key=lambda d: abs((d - target).total_seconds()))
    # More than a week from where it should be means neither reading made
    # sense; report nothing rather than a confidently wrong timestamp.
    if abs((best - target).total_seconds()) > 7 * 86400:
        return None, None
    return best.strftime("%Y-%m-%dT%H:%MZ"), int(best.timestamp())


def _join_wrapped(text: str) -> list[str]:
    """Rejoin lines the bulletin wrapped mid-record.

    CODSRP wraps at ~72 characters, so a HIGHS row or a front polyline
    continues on the next line starting with a bare coordinate. Parsing line by
    line drops every continuation -- silently, because a stray `4794` simply is
    not a keyword. Anything that does not start with a keyword belongs to the
    line above it.
    """
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("$$"):
            continue
        first = line.split()[0].upper()
        if first in _KEYWORDS or not out:
            out.append(line)
        else:
            out[-1] = out[-1] + " " + line
    return out


def parse_bulletin(text: str, issued_at: Optional[int] = None,
                   lead_hours: float = 0.0) -> dict:
    """Coded bulletin text -> GeoJSON of fronts (lines) and centres (points)."""
    features: list[dict] = []
    ref = datetime.fromtimestamp(issued_at, timezone.utc) if issued_at else None
    issued, issued_unix = _valid_time(text, ref, lead_hours)
    counts: dict[str, int] = {}

    for line in _join_wrapped(text):
        words = line.split()
        kw = words[0].upper()

        if kw in ("HIGHS", "LOWS"):
            kind = "high" if kw == "HIGHS" else "low"
            rest = words[1:]
            # pressure/position pairs
            for i in range(0, len(rest) - 1, 2):
                pres = rest[i]
                pos = rest[i + 1]
                if not re.fullmatch(r"\d{3,4}", pres):
                    continue
                pt = _decode_point(pos)
                if pt is None:
                    continue
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [round(pt[1], 2), round(pt[0], 2)]},
                    "properties": {
                        "kind": kind,
                        "symbol": "H" if kind == "high" else "L",
                        "pressure": int(pres),
                        "label": f"{'High' if kind == 'high' else 'Low'} {int(pres)} hPa",
                    },
                })
                counts[kind] = counts.get(kind, 0) + 1
            continue

        spec = FRONT_KINDS.get(kw)
        if not spec:
            continue
        rest = words[1:]
        strength = None
        if rest and rest[0].upper() in STRENGTHS:
            strength = STRENGTHS[rest[0].upper()]
            rest = rest[1:]
        tokens = [t for t in rest if re.fullmatch(r"\d{1,2}-?\d{1,3}", t)]
        pts = _decode_line(tokens)
        if len(pts) < 2:
            continue
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": [[round(p[1], 2), round(p[0], 2)] for p in pts],
            },
            "properties": {
                "kind": spec["id"],
                "label": spec["label"],
                "strength": strength or "",
                "points": len(pts),
            },
        })
        counts[spec["id"]] = counts.get(spec["id"], 0) + 1

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "issued": issued,
            "issuedUnix": issued_unix,
            "counts": counts,
            "total": len(features),
            "source": "NWS Weather Prediction Center — Coded Surface Bulletin",
        },
    }


_SESSION.headers["Accept"] = "application/geo+json"

_FRAME_CACHE: dict[str, tuple[float, dict]] = {}
_LIST_CACHE: dict[str, tuple[float, list[dict]]] = {}
_LIST_TTL = 300.0


def _list_products(loc: str) -> list[dict]:
    """Recent issuances of one coded product, newest first."""
    now = time.time()
    hit = _LIST_CACHE.get(loc)
    if hit and now - hit[0] < _LIST_TTL:
        return hit[1]
    r = _SESSION.get(f"{NWS_API}/products/types/{PRODUCT_TYPE}/locations/{loc}",
                     timeout=_HTTP_TIMEOUT)
    r.raise_for_status()
    items = r.json().get("@graph", []) or []
    _LIST_CACHE[loc] = (now, items)
    return items


def _product_text(pid: str) -> str:
    """One issuance's raw text. Immutable once published, so cached for good."""
    hit = _FRAME_CACHE.get(pid)
    if hit:
        return hit[1]["text"]
    r = _SESSION.get(f"{NWS_API}/products/{pid}", timeout=_HTTP_TIMEOUT)
    r.raise_for_status()
    txt = r.json().get("productText", "") or ""
    _FRAME_CACHE[pid] = (time.time(), {"text": txt})
    while len(_FRAME_CACHE) > 64:
        _FRAME_CACHE.pop(next(iter(_FRAME_CACHE)))
    return txt


def _split_progs(text: str) -> list[tuple[str, float, str]]:
    """CODSRP holds several progs in one product -> [(label, lead_h, section)]."""
    out: list[tuple[str, float, str]] = []
    label: Optional[str] = None
    lead = 0.0
    buf: list[str] = []
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)\s*HR PROG VALID", line, re.I)
        if m:
            if label and buf:
                out.append((label, lead, "\n".join(buf)))
            lead = float(m.group(1))
            label = f"{int(lead)} h forecast"
            buf = [line]
        elif label:
            buf.append(line)
    if label and buf:
        out.append((label, lead, "\n".join(buf)))
    return out


def _frame(kind: str, label: str, text: str, issued_unix: Optional[int] = None,
           lead_hours: float = 0.0) -> Optional[dict]:
    parsed = parse_bulletin(text, issued_unix, lead_hours)
    if not parsed["features"]:
        return None
    meta = parsed["meta"]
    return {
        "id": f"{kind}-{meta.get('issuedUnix') or issued_unix or 0}-{label}",
        "kind": kind,
        "label": label,
        "valid": meta.get("issued"),
        "validUnix": meta.get("issuedUnix"),
        "issuedUnix": issued_unix,
        "counts": meta.get("counts", {}),
        "features": parsed["features"],
    }


def build_fronts(history: int = 0, forecast: bool = True) -> dict:
    """Every frame the coded bulletins offer, oldest -> newest -> forecast.

    `history` past analyses let the map scrub backwards; the 12 h and 24 h progs
    let it scrub forward, so the surface analysis rides the same timeline as
    every other product instead of being pinned to "now".
    """
    ck = (max(0, min(int(history), 24)), bool(forecast))
    hit = _CACHE.get(ck)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]

    frames: list[dict] = []
    errors: list[str] = []

    # --- analyses -----------------------------------------------------------
    want = max(0, min(int(history), 24)) + 1
    used_api = False
    try:
        items = _list_products(LOC_ANALYSIS)[:want]
        for it in items:
            try:
                txt = _product_text(it["id"])
                if len(txt) < 200:
                    continue  # WPC publishes the occasional empty issuance
                f = _frame("analysis", "Analysis", txt, _iso_unix(it.get("issuanceTime")))
                if f:
                    frames.append(f)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"analysis {it.get('id','?')[:8]}: {exc}")
        used_api = bool(frames)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"analysis list: {exc}")

    if not used_api:
        # Fall back to WPC's own always-current copy, so a flaky api.weather.gov
        # costs the history but never the analysis itself.
        r = _SESSION.get(BULLETIN, timeout=_HTTP_TIMEOUT)
        r.raise_for_status()
        if len(r.text) < 200:
            raise RuntimeError("WPC coded surface bulletin came back empty")
        f = _frame("analysis", "Analysis", r.text)
        if f:
            frames.append(f)

    # --- forecasts ----------------------------------------------------------
    if forecast:
        try:
            for it in _list_products(LOC_FORECAST)[:4]:
                txt = _product_text(it["id"])
                if len(txt) < 400:
                    continue
                progs = [
                    _frame("forecast", label, sect, _iso_unix(it.get("issuanceTime")), lead)
                    for label, lead, sect in _split_progs(txt)
                ]
                progs = [f for f in progs if f]
                if progs:
                    frames.extend(progs)
                    break  # newest issuance that actually carried progs
        except Exception as exc:  # noqa: BLE001
            errors.append(f"forecast: {exc}")

    frames.sort(key=lambda f: (f.get("validUnix") or 0))
    # De-duplicate on valid time: a re-issued analysis is the same frame.
    seen: set = set()
    unique: list[dict] = []
    for f in frames:
        key = (f["kind"], f.get("validUnix"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(f)

    if not unique:
        # Not cached: a failure now should not be replayed for ten minutes.
        raise RuntimeError("No coded surface bulletin could be read")

    out = {
        "frames": unique,
        "meta": {
            "count": len(unique),
            "analyses": sum(1 for f in unique if f["kind"] == "analysis"),
            "forecasts": sum(1 for f in unique if f["kind"] == "forecast"),
            "errors": errors,
            "source": "NWS Weather Prediction Center -- Coded Surface Bulletin (CODSUS/CODSRP)",
        },
    }
    _CACHE[ck] = (time.time(), out)
    while len(_CACHE) > 32:
        _CACHE.pop(next(iter(_CACHE)))
    return out


def _iso_unix(iso: Any) -> Optional[int]:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None
