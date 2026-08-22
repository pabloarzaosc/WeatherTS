"""Mesoscale discussions from SPC and WPC, as GeoJSON.

An MD is what SPC writes between the scheduled outlooks: a forecaster looking at
one area right now, saying what they think is about to happen and whether a
watch is coming. On a chase day it is the product that decides the target, and
it is the thing the outlooks cannot tell you because they are hours old. WPC
writes the same product for heavy rain and flooding, numbered separately, and
calls it a Mesoscale Precipitation Discussion.

Neither centre publishes a GeoJSON feed. Both publish the issued product as
fixed-width text, and that text carries its own polygon in a LAT...LON block --
so the text page is the single source used here for both. The KML feeds were
the obvious route and turned out to be the wrong one: they carry only what is
active this minute, which cannot answer "what was running an hour ago", and on
a quiet evening they are empty.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests

MD_PAGE = "https://www.spc.noaa.gov/products/md"

_TIMEOUT = 25
_TTL = 60.0  # MDs are issued continuously, and a refresh is cheap: the
             # per-product cache means only genuinely new numbers are fetched.

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.2 (+SPC mesoscale discussions)"

_CACHE: tuple[float, dict] | None = None


def _strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _first(pattern: str, text: str) -> Optional[str]:
    m = re.search(pattern, text, re.S | re.I)
    return m.group(1).strip() if m else None


def _head_field(text: str, name: str) -> Optional[str]:
    """A wrapped header line such as "Areas affected...", as one line.

    Both centres wrap these to the product's fixed width, so reading to the
    first newline lost half of "portions of Ohio into West Virginia, western /
    Virginia, and eastern Kentucky". This reads to the blank line that ends the
    field and reflows it, since it is rendered as running text.
    """
    m = re.search(rf"^\s*{name}\.*\s*(.+?)(?=\n\s*\n|\Z)", text or "", re.S | re.M | re.I)
    return re.sub(r"\s*\n\s*", " ", m.group(1)).strip() if m else None


def _section(text: str, name: str) -> Optional[str]:
    """One SUMMARY.../DISCUSSION... section, to the next section or the end.

    Anchored to the start of a line and required to end in "...", because the
    product's own title is "Mesoscale Discussion 2003" and a loose match for
    "DISCUSSION" grabbed the header and returned the whole product. The anchor
    is what does that work, so the name itself can stay case-insensitive --
    SPC shouts its section heads, WPC writes "Summary..." and "Discussion...".
    """
    m = re.search(
        rf"^\s*{name}\.\.\.\s*(.+?)(?=\n\s*[A-Za-z]{{4,}}\.\.\.|\Z)",
        text,
        re.S | re.M | re.I,
    )
    if not m:
        return None
    return re.sub(r"\s*\n\s*", " ", m.group(1)).strip() or None


# What the polygon is about, which is what decides its colour. Severe and flood
# are genuinely different hazards and chasers treat them differently, so they
# must not share one "SPC said something here" styling.
_FLOOD = re.compile(r"flash flood|heavy rain|excessive rain|flood", re.I)
_SEVERE = re.compile(
    r"tornado|hail|damaging wind|severe (?:thunderstorm|potential|weather)|wind gust|derecho",
    re.I,
)


def _hazard(concerning: Optional[str], text: str) -> str:
    """'severe' | 'flood' | 'other'.

    `concerning` is the forecaster's own one-line statement of what the MD is
    for, so it decides when it says anything; the body is only consulted when
    that line is missing or silent on the hazard.
    """
    head = concerning or ""
    if _FLOOD.search(head):
        return "flood"
    if _SEVERE.search(head):
        return "severe"
    # Fall back to the body, preferring whichever hazard it actually discusses.
    body = text or ""
    flood, severe = _FLOOD.search(body), _SEVERE.search(body)
    if flood and not severe:
        return "flood"
    if severe:
        return "severe"
    return "other"


def _ddhhmm(stamp: str) -> Optional[int]:
    """A DDHHMM UTC stamp as unix seconds.

    The stamps carry no month, so the month is taken from the current clock and
    rolled back one if that lands in the future -- which is what happens for a
    discussion issued just before a month boundary.
    """
    m = re.fullmatch(r"\s*(\d{2})(\d{2})(\d{2})\s*", stamp or "")
    if not m:
        return None
    day, hh, mm = (int(g) for g in m.groups())
    now = datetime.now(timezone.utc)
    for months_back in (0, 1):
        ref = now if not months_back else now.replace(day=1) - timedelta(days=1)
        try:
            dt = ref.replace(day=day, hour=hh, minute=mm, second=0, microsecond=0)
        except ValueError:
            continue
        if dt <= now + timedelta(days=2):
            return int(dt.timestamp())
    return int(now.timestamp())


def _valid_window(text: str) -> tuple[Optional[int], Optional[int]]:
    """"Valid 162200Z - 162300Z" as a unix start/end pair."""
    m = re.search(r"Valid\s+(\d{6})Z\s*-\s*(\d{6})Z", text or "", re.I)
    if not m:
        return None, None
    return _window(m.group(1), m.group(2))


def _window(start_stamp: str, end_stamp: str) -> tuple[Optional[int], Optional[int]]:
    start, end = _ddhhmm(start_stamp), _ddhhmm(end_stamp)
    # A window that ends before it starts crossed midnight UTC.
    if start is not None and end is not None and end < start:
        end += 86400
    return start, end


WPC_MPD_PAGE = "https://www.wpc.ncep.noaa.gov/metwatch/metwatch_mpd_multi.php"


def _latlon_ring(text: str) -> Optional[list[list[float]]]:
    """The polygon out of the product's own LAT...LON block.

    Every discussion carries its outline as packed pairs -- "38760467" is
    38.76N 104.67W -- which is the only place to get the shape of one that is
    no longer active: the KML feeds carry the live products and nothing else.

    Longitude is four digits with the leading hundred dropped, so anything
    under 30.00 is really 100 degrees further west. Nothing in the US falls
    between 0 and 30 west, so the test is unambiguous.
    """
    m = re.search(r"LAT\.\.\.LON\s+(.+?)(?=\n\s*\n|\Z)", text or "", re.S | re.I)
    if not m:
        return None
    ring: list[list[float]] = []
    for lat_s, lon_s in re.findall(r"(\d{4})(\d{4})", m.group(1)):
        lon = int(lon_s)
        if lon < 3000:
            lon += 10000
        ring.append([-lon / 100.0, int(lat_s) / 100.0])
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


# A discussion is worth keeping around long after it lapses: scrubbing the
# radar loop back three hours is exactly when the MD that was running then
# matters, and the live feeds have already dropped it by definition.
HISTORY_HOURS = 24
# How many numbers back to walk from the newest. SPC rarely writes more than
# forty in a day, and already-fetched products are cached, so this is one small
# request per newly issued discussion rather than forty every refresh.
WALK_BACK = 40

MD_TEXT_URL = "https://www.spc.noaa.gov/products/md/md{n:04d}.html"
MPD_TEXT_URL = "https://www.wpc.ncep.noaa.gov/archives/metwatch/{year}/mcd{n}.html"

# Issued products never change, so they are held for the life of the process.
_PRODUCT_CACHE: dict[tuple[str, int], dict] = {}


def _product_text(kind: str, number: int) -> str:
    url = (
        MD_TEXT_URL.format(n=number)
        if kind == "md"
        else MPD_TEXT_URL.format(year=datetime.now(timezone.utc).year, n=number)
    )
    r = _SESSION.get(url, timeout=_TIMEOUT)
    if r.status_code == 404:
        return ""
    r.raise_for_status()
    blocks = re.findall(r"<pre>(.*?)</pre>", r.text, re.S | re.I)
    return _strip_html(max(blocks, key=len)) if blocks else ""


def _build_feature(kind: str, number: int) -> Optional[dict]:
    """One discussion, from its text product alone."""
    cached = _PRODUCT_CACHE.get((kind, number))
    if cached:
        return cached

    text = _product_text(kind, number)
    if not text:
        return None
    ring = _latlon_ring(text)
    if not ring:
        return None

    concerning = _head_field(text, "Concerning")
    start, end = _valid_window(text)
    is_mpd = kind == "mpd"
    feature = {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {
            "id": f"{kind}-{number}",
            "number": number,
            "label": f"{'MPD' if is_mpd else 'MD'} {number}",
            "kind": kind,
            # A precipitation discussion is about flooding by definition; an SPC
            # one has to be read to know which hazard it is about.
            "hazard": "flood" if is_mpd else _hazard(concerning, text),
            "validUntil": None,
            "valid": _first(r"Valid\s+(\d{6}Z\s*-\s*\d{6}Z)", text),
            "validStartUnix": start,
            "validEndUnix": end,
            "issued": _first(r"\n\s*(\d{3,4}\s*[AP]M\s+\w+\s+\w{3}\s+\w{3}\s+\d+\s+\d{4})", text),
            "areas": _head_field(text, "Areas affected"),
            "concerning": concerning,
            "summary": _section(text, "SUMMARY"),
            "discussion": _section(text, "DISCUSSION"),
            "text": text,
            "url": (
                f"{WPC_MPD_PAGE}?md={number}"
                if is_mpd
                else f"{MD_PAGE}/md{number:04d}.html"
            ),
        },
    }
    _PRODUCT_CACHE[(kind, number)] = feature
    return feature


# The highest number seen for each centre. Both index pages list what is live
# or recent, so a quiet spell can empty one of them -- and losing the number
# would drop the whole day's history rather than just the new arrivals.
_HIGHEST: dict[str, int] = {}


def _latest_number(kind: str) -> Optional[int]:
    """The newest discussion number each centre has issued."""
    if kind == "md":
        page = _SESSION.get(f"{MD_PAGE}/", timeout=_TIMEOUT).text
        nums = [int(n) for n in re.findall(r"md(\d{4})\.html", page)]
    else:
        page = _SESSION.get(WPC_MPD_PAGE, timeout=_TIMEOUT).text
        nums = [int(n) for n in re.findall(r"md=(\d+)", page)]
    if nums:
        _HIGHEST[kind] = max(nums + [_HIGHEST.get(kind, 0)])
    return _HIGHEST.get(kind)


def _safe_feature(kind: str, number: int) -> Optional[dict]:
    try:
        return _build_feature(kind, number)
    except Exception:  # noqa: BLE001
        return None


# How far past the index's newest number to look. Both index pages lag behind
# the products themselves -- WPC listed 1079 as its latest while MPD 1080 was
# already published and in force -- so anchoring on the index alone means the
# discussion you are looking at right now is the one the map never shows.
PROBE_AHEAD = 3


def _extend_forward(kind: str, latest: int) -> int:
    """Walk past the index's newest number while products keep turning up."""
    for _ in range(3):  # bounded, so a run of published numbers cannot loop
        candidates = list(range(latest + 1, latest + 1 + PROBE_AHEAD))
        with ThreadPoolExecutor(max_workers=PROBE_AHEAD) as pool:
            found = [n for n, f in zip(candidates, pool.map(lambda n: _safe_feature(kind, n), candidates)) if f]
        if not found:
            break
        latest = max(found)
    return latest


def _recent(kind: str, cutoff: float) -> tuple[list[dict], list[str]]:
    """Every discussion this centre has issued back to `cutoff`."""
    errors: list[str] = []
    try:
        latest = _latest_number(kind)
    except Exception as exc:  # noqa: BLE001
        return [], [f"{kind} index: {exc}"]
    if not latest:
        return [], []
    latest = _extend_forward(kind, latest)
    _HIGHEST[kind] = max(latest, _HIGHEST.get(kind, 0))

    numbers = [n for n in range(latest, max(0, latest - WALK_BACK), -1)]
    found: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_build_feature, kind, n): n for n in numbers}
        for fut in as_completed(futures):
            try:
                feature = fut.result()
            except Exception as exc:  # noqa: BLE001 - one bad number is not fatal
                errors.append(f"{kind} {futures[fut]}: {exc}")
                continue
            if not feature:
                continue
            end = feature["properties"]["validEndUnix"]
            # An unreadable window keeps the discussion rather than dropping it.
            if end is None or end >= cutoff:
                found.append(feature)
    return found, errors


def build_mds() -> dict[str, Any]:
    """Every mesoscale discussion from the last day, as GeoJSON.

    Both centres, and deliberately not just the live ones. The map filters to
    the instant on the timeline, so what it needs is the day's discussions with
    their valid windows attached -- scrubbing back an hour then shows the MD
    that was running an hour ago instead of an empty map. On a quiet evening
    "live only" meant nothing at all was ever drawn.
    """
    global _CACHE
    now = time.time()
    if _CACHE and now - _CACHE[0] < _TTL:
        return _CACHE[1]

    cutoff = now - HISTORY_HOURS * 3600
    features: list[dict] = []
    errors: list[str] = []
    for kind in ("md", "mpd"):
        try:
            found, errs = _recent(kind, cutoff)
        except Exception as exc:  # noqa: BLE001 - one centre must not sink the other
            errors.append(f"{kind}: {exc}")
            continue
        features.extend(found)
        errors.extend(errs)

    features.sort(key=lambda f: -(f["properties"]["number"] or 0))
    out = {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "count": len(features),
            "errors": errors,
            "source": "NOAA/NWS Storm Prediction Center and Weather Prediction Center",
        },
    }
    _CACHE = (now, out)
    return out
