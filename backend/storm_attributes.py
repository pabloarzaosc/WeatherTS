"""Per-cell hail and structure attributes for the tracked SCIT storm cells.

These come from two Level III products that the Unidata S3 archive stopped
carrying in 2022, so they are read from the NWS's live NIDS feed instead:

  * DS.p59hi (Hail Index, product 59)      -> POSH/POH, max hail size
  * DS.p62ss (Storm Structure, product 62) -> base, top, cell-based VIL,
                                              max reflectivity and its height

That feed only holds the most recent volumes, so attributes exist for live
radar and simply are not there when the timeline is scrubbed into the archive.
Every failure here is non-fatal: the caller still has tracks without them.

Decoding notes, both found by probing live data:

  * The Hail Index arrives in `graph_pages`, which decodes cleanly. Its columns
    are RIGHT-ALIGNED under each storm id and the values themselves contain
    spaces (`10/ 90`), so they are cut by column position, never by splitting
    on whitespace.
  * Storm Structure arrives in `tab_pages`, which MetPy yields one character
    per line. Joining the page back into a string restores the whole table --
    the data is intact, only the line breaks are lost.
"""
from __future__ import annotations

import io
import re
import time
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from typing import Any, Optional

import requests
from metpy.io import Level3File

TGFTP = "https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar"
HAIL_DIR = "DS.p59hi"
STRUCTURE_DIR = "DS.p62ss"

_TIMEOUT = 30
_TTL = 60.0
# How long a site is assumed to have no feed after every ICAO spelling missed.
# Bounded rather than permanent: a network blip during the first lookup would
# otherwise disable attributes for that radar until the process restarts.
_ICAO_MISS_TTL = 600.0
# Attributes from a volume this much older/newer than the tracks belong to
# different weather; better to show none than to mislabel a cell.
_MAX_SKEW_S = 900
# tgftp keeps only recent volumes, so anything older than this is archive
# playback and is not worth a request.
_LIVE_WINDOW_S = 1800

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "WeatherTS/1.2 (+storm attributes)"
# The history index fans out well past requests' default pool of 10, and a
# short pool silently serialises those threads.
_SESSION.mount("https://", requests.adapters.HTTPAdapter(pool_maxsize=32))

_CACHE: dict[tuple, tuple[float, dict]] = {}
# Which ICAO spelling this site answers to, learned on first success. Most are
# K + the 3-letter id, but Alaska/Hawaii/Guam are P and Puerto Rico is T.
# A None value is a miss, timestamped so it can be retried later.
_ICAO_CACHE: dict[str, tuple[Optional[str], float]] = {}


def _fetch_product(site: str, directory: str) -> Optional[Level3File]:
    """Latest volume of one product, or None if the feed hasn't got it."""
    known = _ICAO_CACHE.get(site)
    if known is not None:
        prefix, at = known
        if prefix is None:
            # A recorded miss, still inside its retry window.
            if time.time() - at < _ICAO_MISS_TTL:
                return None
            candidates = ["k", "p", "t"]
        else:
            candidates = [prefix]
    else:
        candidates = ["k", "p", "t"]

    for cand in candidates:
        prefix = cand if len(cand) > 1 else f"{cand}{site.lower()}"
        try:
            r = _SESSION.get(f"{TGFTP}/{directory}/SI.{prefix}/sn.last", timeout=_TIMEOUT)
        except requests.RequestException:
            # A timeout says nothing about whether this site has the feed, so
            # it must not be recorded as a miss.
            return None
        if not r.ok or len(r.content) < 100:
            continue
        try:
            f = Level3File(io.BytesIO(r.content))
        except Exception:  # noqa: BLE001 - a malformed volume is not fatal
            continue
        _ICAO_CACHE[site] = (prefix, time.time())
        return f
    # Every spelling answered, none usably: this site really has no such feed.
    _ICAO_CACHE[site] = (None, time.time())
    return None


def _prod_unix(f: Level3File) -> Optional[int]:
    from datetime import timezone

    dt = (getattr(f, "metadata", {}) or {}).get("prod_time")
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


# --------------------------------------------------------------- hail index ---

def _header_columns(line: str, label: str) -> list[tuple[str, int]]:
    """Storm ids in a graph-page header, each with the column it ends at.

    The right edge is what matters: every value below a given id is right
    aligned to it, which is the only reliable way to cut a row whose values
    contain spaces.
    """
    at = line.find(label)
    if at < 0:
        return []
    after = at + len(label)
    return [(m.group(), after + m.end() - 1) for m in re.finditer(r"\S+", line[after:])]


def _row_values(line: str, label: str, columns: list[tuple[str, int]]) -> list[str]:
    """One labelled row, cut at the header's column boundaries."""
    at = line.find(label)
    if at < 0:
        return []
    out: list[str] = []
    prev = at + len(label)
    for _, right in columns:
        out.append(line[prev:right + 1].strip())
        prev = right + 1
    return out


def _num(text: str) -> Optional[float]:
    """A cell value as a number. `<0.50` is a below-threshold reading, which is
    a real answer ('under half an inch'), so it keeps its magnitude.

    `UNKNOWN` is what the hail algorithm prints for cells beyond its useful
    range (observed on every cell past ~130 nm), so it means "not computed"
    rather than "no hail" -- those cells end up with no hail fields at all.
    """
    t = text.strip().lstrip("<").strip()
    if not t or t in {"NA", "N/A", "---", "UNKNOWN"}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _parse_hail(f: Level3File) -> dict[str, dict]:
    pages = getattr(f, "graph_pages", None) or []
    out: dict[str, dict] = {}
    for page in pages:
        lines = [it["text"] for it in page if isinstance(it, dict) and "text" in it]
        header = next((ln for ln in lines if "STORM ID" in ln), None)
        if not header:
            continue
        columns = _header_columns(header, "STORM ID")
        if not columns:
            continue
        probs = next((ln for ln in lines if "POSH/POH" in ln), "")
        sizes = next((ln for ln in lines if "MAX HAIL SIZE" in ln), "")
        prob_vals = _row_values(probs, "POSH/POH", columns) if probs else []
        size_vals = _row_values(sizes, "MAX HAIL SIZE", columns) if sizes else []

        for i, (cell_id, _) in enumerate(columns):
            posh = poh = None
            if i < len(prob_vals) and "/" in prob_vals[i]:
                left, _, right = prob_vals[i].partition("/")
                posh, poh = _num(left), _num(right)
            size_txt = size_vals[i].strip() if i < len(size_vals) else ""
            entry = {
                "probSevereHailPct": posh,
                "probHailPct": poh,
                "maxHailSizeIn": _num(size_txt),
                # `<0.50` means the algorithm saw hail but under the reporting
                # floor; the UI shows it as "<0.50" rather than a bare number.
                "hailSizeBelowThreshold": size_txt.startswith("<"),
            }
            if any(v is not None for v in (posh, poh, entry["maxHailSizeIn"])):
                out[cell_id] = entry
    return out


def _hail(site: str) -> tuple[dict[str, dict], Optional[int]]:
    f = _fetch_product(site, HAIL_DIR)
    if f is None:
        return {}, None
    return _parse_hail(f), _prod_unix(f)


# ----------------------------------------------------------- storm structure ---

# id, az/ran (the slash pair can carry a space), base (optionally '<'), top,
# VIL, max reflectivity, height of that maximum.
_STRUCTURE_ROW = re.compile(
    r"^\s*(?P<id>[A-Z]\d)\s+"
    r"(?P<az>\d+)/\s*(?P<ran>\d+)\s+"
    r"(?P<base><?\s*[\d.]+)\s+"
    r"(?P<top>[\d.]+)\s+"
    r"(?P<vil>\d+)\s+"
    r"(?P<maxref>\d+)\s+"
    r"(?P<height>[\d.]+)\s*$"
)


def _parse_structure(f: Level3File) -> dict[str, dict]:
    pages = getattr(f, "tab_pages", None) or []
    out: dict[str, dict] = {}
    for page in pages:
        # MetPy hands back one character per line; rejoining restores the table.
        text = "".join(page)
        if "STORM STRUCTURE" not in text:
            continue  # the trailing pages are adaptation-parameter dumps
        for line in text.split("\n"):
            m = _STRUCTURE_ROW.match(line)
            if not m:
                continue
            base_txt = m.group("base")
            out[m.group("id")] = {
                "cellBaseKft": _num(base_txt),
                "cellBaseBelowThreshold": base_txt.strip().startswith("<"),
                "cellTopKft": _num(m.group("top")),
                "vilKgM2": _num(m.group("vil")),
                "maxRefDbz": _num(m.group("maxref")),
                "maxRefHeightKft": _num(m.group("height")),
            }
    return out


def _structure(site: str) -> tuple[dict[str, dict], Optional[int]]:
    f = _fetch_product(site, STRUCTURE_DIR)
    if f is None:
        return {}, None
    return _parse_structure(f), _prod_unix(f)


# ---------------------------------------------------------------------------

def fetch_attributes(site: str, track_unix: Optional[int]) -> dict[str, dict]:
    """Hail + structure keyed by storm cell id, empty when unavailable.

    `track_unix` is when the storm-track volume was valid. Attributes from a
    materially different time are dropped rather than pinned to the wrong scan.
    """
    site = (site or "").upper().strip()
    if len(site) != 3:
        return {}

    now = time.time()
    # Archive playback: the live feed cannot answer for it, so don't ask.
    if track_unix is not None and now - track_unix > _LIVE_WINDOW_S:
        return {}

    hit = _CACHE.get((site,))
    if hit and now - hit[0] < _TTL:
        merged = hit[1]
    else:
        try:
            hail, hail_unix = _hail(site)
        except Exception:  # noqa: BLE001
            hail, hail_unix = {}, None
        try:
            structure, structure_unix = _structure(site)
        except Exception:  # noqa: BLE001
            structure, structure_unix = {}, None

        merged = {}
        for cell_id in set(hail) | set(structure):
            merged[cell_id] = {
                **structure.get(cell_id, {}),
                **hail.get(cell_id, {}),
                "validUnix": hail_unix or structure_unix,
            }
        _CACHE[(site,)] = (now, merged)
        while len(_CACHE) > 100:
            _CACHE.pop(next(iter(_CACHE)))

    if track_unix is not None:
        merged = {
            cid: a for cid, a in merged.items()
            if a.get("validUnix") is None or abs(a["validUnix"] - track_unix) <= _MAX_SKEW_S
        }
    return merged


# --------------------------------------------------------------- history ---
#
# The feed keeps ~250 volumes per product, roughly a day. They live in a
# circular buffer -- `sn.0000`..`sn.0250` are written in order and wrap, so the
# file number says nothing about age and `sn.last` only pins the newest. The
# index is therefore built from Last-Modified headers (HEAD is cheap, and 250
# of them run concurrently in about four seconds) and cached for a volume.

_INDEX_TTL = 240.0
_INDEX_CACHE: dict[tuple, tuple[float, list[tuple[str, float]]]] = {}
_HISTORY_TTL = 120.0
_HISTORY_CACHE: dict[tuple, tuple[float, list[dict]]] = {}

_BUFFER_SLOTS = 251
_INDEX_WORKERS = 24
_FETCH_WORKERS = 14
DEFAULT_HISTORY_VOLUMES = 14


def _volume_index(site: str, directory: str) -> list[tuple[str, float]]:
    """Every retained volume as (filename, unix), newest first."""
    ck = (site, directory)
    now = time.time()
    hit = _INDEX_CACHE.get(ck)
    if hit and now - hit[0] < _INDEX_TTL:
        return hit[1]

    known = _ICAO_CACHE.get(site)
    prefix = known[0] if known and known[0] else f"k{site.lower()}"
    base = f"{TGFTP}/{directory}/SI.{prefix}"

    def head(i: int) -> Optional[tuple[str, float]]:
        name = f"sn.{i:04d}"
        try:
            r = _SESSION.head(f"{base}/{name}", timeout=_TIMEOUT)
            stamp = r.headers.get("Last-Modified")
            if not r.ok or not stamp:
                return None
            return name, parsedate_to_datetime(stamp).timestamp()
        except (requests.RequestException, ValueError, TypeError):
            return None

    with ThreadPoolExecutor(max_workers=_INDEX_WORKERS) as pool:
        found = [r for r in pool.map(head, range(_BUFFER_SLOTS)) if r]
    found.sort(key=lambda r: -r[1])
    _INDEX_CACHE[ck] = (now, found)
    while len(_INDEX_CACHE) > 40:
        _INDEX_CACHE.pop(next(iter(_INDEX_CACHE)))
    return found


def _series(site: str, directory: str, volumes: int, parse) -> list[tuple[float, dict[str, dict]]]:
    """The newest `volumes` scans of one product, parsed."""
    index = _volume_index(site, directory)[:volumes]
    if not index:
        return []
    known = _ICAO_CACHE.get(site)
    prefix = known[0] if known and known[0] else f"k{site.lower()}"
    base = f"{TGFTP}/{directory}/SI.{prefix}"

    def load(entry: tuple[str, float]):
        name, stamp = entry
        try:
            r = _SESSION.get(f"{base}/{name}", timeout=_TIMEOUT)
            if not r.ok or len(r.content) < 100:
                return None
            f = Level3File(io.BytesIO(r.content))
            return _prod_unix(f) or stamp, parse(f)
        except Exception:  # noqa: BLE001 - one bad volume must not sink the series
            return None

    with ThreadPoolExecutor(max_workers=_FETCH_WORKERS) as pool:
        return [r for r in pool.map(load, index) if r]


def fetch_history(site: str, cell_id: str,
                  volumes: int = DEFAULT_HISTORY_VOLUMES) -> list[dict[str, Any]]:
    """How one cell's hail and structure evolved, oldest sample first.

    SCIT keeps a cell's id for as long as it stays tracked, so the id is what
    joins the volumes together. Scans from before the cell existed simply have
    no row for it and drop out.
    """
    site = (site or "").upper().strip()
    cell_id = (cell_id or "").strip().upper()
    if len(site) != 3 or not cell_id:
        return []

    now = time.time()
    ck = (site, volumes)
    hit = _HISTORY_CACHE.get(ck)
    if hit and now - hit[0] < _HISTORY_TTL:
        frames = hit[1]
    else:
        hail = _series(site, HAIL_DIR, volumes, _parse_hail)
        structure = _series(site, STRUCTURE_DIR, volumes, _parse_structure)
        # Volumes of the two products share a timestamp to within a second or
        # two, so they are merged on the rounded minute rather than on equality.
        merged: dict[int, dict[str, dict]] = {}
        for stamp, cells in hail + structure:
            slot = int(round(stamp / 60.0))
            bucket = merged.setdefault(slot, {})
            for cid, attrs in cells.items():
                bucket.setdefault(cid, {}).update(attrs)
        frames = [{"unix": slot * 60, "cells": cells} for slot, cells in sorted(merged.items())]
        _HISTORY_CACHE[ck] = (now, frames)
        while len(_HISTORY_CACHE) > 20:
            _HISTORY_CACHE.pop(next(iter(_HISTORY_CACHE)))

    out: list[dict[str, Any]] = []
    for frame in frames:
        attrs = frame["cells"].get(cell_id)
        if attrs:
            out.append({"unix": frame["unix"], **attrs})
    return out


def attach(cells: list[dict[str, Any]], site: str, track_unix: Optional[int]) -> int:
    """Merge attributes onto tracked cells in place; returns how many matched."""
    attrs = fetch_attributes(site, track_unix)
    if not attrs:
        return 0
    matched = 0
    for cell in cells:
        a = attrs.get(cell.get("id"))
        if not a:
            continue
        cell.update({k: v for k, v in a.items() if k != "validUnix"})
        matched += 1
    return matched
