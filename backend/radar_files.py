"""A loop frame's original radar file: what it is (name, size, source) and its
bytes, for the Frames panel's "Download radar file".

Frame keys, as the scan lists hand them out:

  * Level III   ``TLX_N0B_2026_10_25_04_08_17``  -- the object in Unidata's
    Level III bucket (SRV / NROT frames carry their source velocity's key).
  * Level II    ``L2:<vol>:<YYYYMMDD-HHMMSS>[:c<k>]`` -- a volume of the live
    chunk feed; the file is its chunks joined in order (start chunk with the
    volume header, then the LDM records), which is an ordinary Archive II file.
    ``:c<k>`` (a SAILS rescan) is the same volume.
  * Level II    ``L2P:<vol>:<stamp>`` -- the volume being written: the chunks
    that are there so far.
  * Level II    ``L2A:<file name>`` -- a volume of the Level II archive bucket.
  * Brazil      ``L2BR:<YYYYMMDDHHMMSS>`` -- a kept volume's files (one file is
    sent as it is, several as a zip).

Keys are matched against these shapes before anything is fetched, so a key
can never name another object, host or path.
"""
from __future__ import annotations

import io
import re
import threading
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import nexrad_core
import nexrad_level2 as l2

_L3_KEY = re.compile(r"[A-Z0-9]{3,4}_[A-Z0-9]{2,4}_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}")
_L2_LIVE = re.compile(r"L2(P?):(\d{1,4}):(\d{8}-\d{6})(?::c\d{1,2})?")
_L2_ARCHIVE = re.compile(r"L2A:([A-Z]{4}\d{8}_\d{6}(?:_V\d{2})?(?:\.gz)?)")
_BR_KEY = re.compile(r"L2BR:(\d{14})")

# What a frame's file is, per (site, key): whole files never change.
_INFO: "OrderedDict[tuple, dict]" = OrderedDict()
_INFO_MAX = 600
_LOCK = threading.Lock()


class FileError(ValueError):
    """The key is not a frame this can name a file for."""


def _keep(k: tuple, info: dict) -> dict:
    if info.get("partial"):
        return info  # the volume being written grows; never kept
    with _LOCK:
        _INFO[k] = info
        while len(_INFO) > _INFO_MAX:
            _INFO.popitem(last=False)
    return info


def _safe(name: str) -> str:
    """A file name fit for a Content-Disposition header."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120] or "radar"


def _l2_name(icao: str, stamp: str, partial: bool = False) -> str:
    """KTLX + 20261025-034005 -> KTLX20261025_034005_V06 (the archive's names)."""
    return f"{icao}{stamp[:8]}_{stamp[9:15]}_V06{'_partial' if partial else ''}"


def _live_chunks(icao: str, vol: int, stamp: str, partial: bool) -> list[tuple[str, int]]:
    """The volume's chunks in order -- checked to be the volume the key names:
    the feed reuses volume numbers, so a stale key must not get another file."""
    ch = l2._chunks_for(icao, vol) if partial else l2._volume_chunks(icao, vol)
    ch = sorted(ch, key=lambda kv: l2._chunk_num(kv[0]))
    if not ch or l2._stamp(ch) != stamp:
        raise LookupError(f"Volume {stamp} has left {icao}'s live feed.")
    return ch


def _head_size(url: str) -> Optional[int]:
    try:
        r = nexrad_core._SESSION.head(url, timeout=nexrad_core._HTTP_TIMEOUT)
        if r.status_code == 404:
            raise LookupError("The file is no longer on the server.")
        r.raise_for_status()
        n = r.headers.get("Content-Length")
        return int(n) if n else None
    except LookupError:
        raise
    except Exception:  # noqa: BLE001 - the size is a nicety
        return None


def _br_files(site: str, stamp: str) -> list[Path]:
    import brazil_radar  # noqa: PLC0415 - heavy; only for BR- radars

    if not brazil_radar._ID_RE.fullmatch(site):
        raise FileError(f"Unknown radar {site}")
    vdir = brazil_radar.STORE / site / stamp
    if not vdir.is_dir():
        raise LookupError(f"No volume {stamp} kept for {site}.")
    files = sorted(p for p in vdir.iterdir() if p.is_file() and p.name != "info.json")
    if not files:
        raise LookupError(f"No volume {stamp} kept for {site}.")
    return files


def describe(site: str, key: str) -> dict:
    """{name, bytes, source, level, partial, url?} for a frame's original file."""
    site = (site or "").upper().strip()
    key = (key or "").strip()
    ck = (site, key)
    with _LOCK:
        hit = _INFO.get(ck)
    if hit is not None:
        return hit

    if m := _BR_KEY.fullmatch(key):
        files = _br_files(site, m.group(1))
        size = sum(p.stat().st_size for p in files)
        name = _safe(files[0].name) if len(files) == 1 else f"{site}_{m.group(1)}.zip"
        return _keep(ck, {"name": name, "bytes": size, "files": len(files), "level": "Volume",
                          "source": "Kept volume (imported or relayed)", "partial": False})
    if m := _L2_LIVE.fullmatch(key):
        partial = m.group(1) == "P"
        icao = nexrad_core.icao_for(site)
        ch = _live_chunks(icao, int(m.group(2)), m.group(3), partial)
        return _keep(ck, {"name": _l2_name(icao, m.group(3), partial), "bytes": sum(n for _, n in ch),
                          "chunks": len(ch), "level": "Level II", "partial": partial,
                          "source": "NOAA Level II chunks (Unidata, AWS)"})
    if m := _L2_ARCHIVE.fullmatch(key):
        name = m.group(1)
        url = l2.ARCHIVE + l2._archive_path(name)
        return _keep(ck, {"name": name, "bytes": _head_size(url), "level": "Level II",
                          "partial": False, "source": "NOAA Level II archive (Unidata, AWS)", "url": url})
    if _L3_KEY.fullmatch(key):
        url = nexrad_core.scan_url(key)
        return _keep(ck, {"name": key, "bytes": _head_size(url), "level": "Level III",
                          "partial": False,
                          "source": "NOAA Level III (Unidata, AWS)" if url.startswith(nexrad_core.S3) else "NWS radar feed (tgftp)",
                          "url": url})
    raise FileError(f"Not a radar frame key: {key[:60]}")


def original(site: str, key: str) -> tuple[str, bytes]:
    """(file name, bytes) of a frame's original radar file."""
    site = (site or "").upper().strip()
    key = (key or "").strip()
    if m := _BR_KEY.fullmatch(key):
        files = _br_files(site, m.group(1))
        if len(files) == 1:
            return _safe(files[0].name), files[0].read_bytes()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            for p in files:
                z.write(p, p.name)
        return f"{site}_{m.group(1)}.zip", buf.getvalue()
    if m := _L2_LIVE.fullmatch(key):
        partial = m.group(1) == "P"
        icao = nexrad_core.icao_for(site)
        vol, stamp = int(m.group(2)), m.group(3)
        ch = _live_chunks(icao, vol, stamp, partial)
        nums = [l2._chunk_num(k) for k, _ in ch]
        raw = b"".join(l2._get_chunks(icao, vol, stamp, ch, nums))
        return _l2_name(icao, stamp, partial), raw
    if m := _L2_ARCHIVE.fullmatch(key):
        name = m.group(1)
        return name, l2._kept(("archive", name), lambda: l2._archive_get(l2._archive_path(name)))
    if _L3_KEY.fullmatch(key):
        r = nexrad_core._SESSION.get(nexrad_core.scan_url(key), timeout=nexrad_core._HTTP_TIMEOUT)
        if r.status_code == 404:
            raise LookupError("The file is no longer on the server.")
        r.raise_for_status()
        return key, r.content
    raise FileError(f"Not a radar frame key: {key[:60]}")
