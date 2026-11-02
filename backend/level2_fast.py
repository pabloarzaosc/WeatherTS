"""
One moment of a Level II volume, read straight from its bytes.

MetPy's Level2File scales every moment of every radial as it parses -- REF,
VEL, SW, ZDR, PHI, RHO, CFP -- about 2.2 s for a modern volume, all of it in
Python under the GIL. The 3D view and the cross-section want one moment at a
time, so this walks message 31's headers, keeps the blocks of that moment
only, and scales each sweep in one numpy step: ~0.3 s. Message 5 gives the
commanded angle of each cut, which is what nexrad_level2._sweep_angle files a
sweep under.

The bz2 records a volume is stored as are decompressed side by side first
(bz2 lets go of the GIL), which MetPy's own parse gets too when it is the one
reading (`plain`).

What it does not know -- a legacy message 1 volume (before 2008), a compressed
message 31, anything that does not parse -- answers None, and the caller
decodes with MetPy as before.
"""
from __future__ import annotations

import bz2
import gzip
import struct
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import numpy as np

CTM = 12              # the old channel-terminal-manager bytes before every message
BLOCK = 2432          # a fixed-size message's frame: CTM + 2416 + 4 (FCS)
_HDR = struct.Struct(">HBBHHIHH")                 # message header, 16 bytes
_D31 = struct.Struct(">4sIHHfBxHBBBBfBBH")        # message 31 data header, 32
_DBLK = struct.Struct(">4sIHHHHhBBff")            # a moment's block header, 28
_VOL = struct.Struct(">4sHBBffhHfffffHH")         # volume constants, 44
_VCP = struct.Struct(">HHHHBBBB4xHH2x")           # message 5's header, 22
_VCP_EL = 46                                      # one cut of message 5
# Radial status (low nibble) that opens a sweep: start of an elevation, of the
# volume, of the last elevation.
_START = (0, 3, 5)

_BZ_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="l2bz")


def _bz(block: Any) -> Optional[bytes]:
    try:
        return bz2.decompress(block)
    except (OSError, ValueError):
        return None


def plain(raw: bytes) -> bytes:
    """A volume (archive file or joined live chunks) with its bz2 records
    decompressed in parallel: the 24-byte volume header and the messages. As
    it came when it is not bz2 records -- an old gzipped file is gunzipped
    and is plain underneath. A record that fails ends the volume there, as
    MetPy does."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    if len(raw) < 31 or raw[28:31] != b"BZh":
        return raw
    view = memoryview(raw)
    blocks = []
    off = 24
    while off + 4 <= len(raw):
        n = abs(int.from_bytes(raw[off:off + 4], "big", signed=True))
        off += 4
        if n:
            blocks.append(view[off:off + n])
        off += n
    parts = list(_BZ_POOL.map(_bz, blocks))
    keep = []
    for p in parts:
        if p is None:
            break
        keep.append(p)
    if not keep:
        return raw
    return bytes(raw[:24]) + b"".join(keep)


def _sweep_angle(vcp_els: Optional[list[float]], el_num: int, el_angles: list[float]) -> float:
    """nexrad_level2._sweep_angle: the cut's commanded angle from the scan
    strategy, else the median the antenna read."""
    if vcp_els is not None and 1 <= el_num <= len(vcp_els):
        return float(vcp_els[el_num - 1])
    return float(np.median(el_angles))


def read_moment(buf: bytes, src: bytes, kt_factor: Optional[float] = None) -> Optional[dict]:
    """One moment of a plain volume (see `plain`) the way radar_xsect._stack
    lays it out: {"sweeps": [{"elev", "az", "first", "width", "vals", "nyq"
    (m/s or None)}] low to
    high, one per angle (the furthest-reaching sweep of a split cut), "lat",
    "lon", "vcp", "siteAmslM", "feedhornM"}. None when the volume is not one
    this reads, or no sweep carries the moment."""
    try:
        return _read(buf, src, kt_factor)
    except (struct.error, ValueError, IndexError, TypeError):
        return None


def _read(buf: bytes, src: bytes, kt_factor: Optional[float]) -> Optional[dict]:
    if buf[:4] != b"AR2V":
        return None
    size = len(buf)
    vcp_els: Optional[list[float]] = None
    vol = None
    # Sweeps as MetPy builds them: a new one at each start-of-elevation
    # radial, padded with empty ones up to the radial's elevation number.
    sweeps: list[dict] = []
    off = 24
    hdr_unpack, d31_unpack, dblk_unpack = _HDR.unpack_from, _D31.unpack_from, _DBLK.unpack_from
    while off + CTM + _HDR.size <= size:
        size_hw, _ch, mtype, _seq, _date, _ms, nseg, segn = hdr_unpack(buf, off + CTM)
        step = BLOCK
        if size_hw:
            if size_hw == 65535:
                step = (nseg << 16) | (segn + CTM)
            elif mtype in (29, 31):
                step = CTM + 2 * size_hw
            body = off + CTM + _HDR.size
            if mtype == 31:
                (_id, _t, _d, _azn, az, comp, _rl, _azs, status, el_num, _sec, el_angle, _sb, _aim,
                 nblk) = d31_unpack(buf, body)
                if comp:
                    return None
                if (status & 0x0F) in _START:
                    sweeps.append({"el_num": el_num, "az": [], "el": [], "blk": [], "nyq": None})
                while len(sweeps) < el_num:
                    sweeps.append({"el_num": el_num, "az": [], "el": [], "blk": [], "nyq": None})
                sw = sweeps[-1]
                if not sw["az"]:
                    sw["el_num"] = el_num
                found = None
                for ptr in struct.unpack_from(f">{nblk}I", buf, body + _D31.size):
                    if not ptr:
                        continue
                    p = body + ptr
                    tag = buf[p:p + 4]
                    if tag[:1] == b"D":
                        if tag[1:4].strip() == src:
                            found = p
                    elif vol is None and tag == b"RVOL":
                        vol = _VOL.unpack_from(buf, p)
                    elif tag == b"RRAD" and not sw["az"]:
                        # The sweep's Nyquist velocity (m/s), for unfolding.
                        sw["nyq"] = (struct.unpack_from(">H", buf, p + 16)[0] * 0.01) or None
                sw["az"].append(az)
                sw["el"].append(el_angle)
                sw["blk"].append(found)
            elif mtype == 5:
                head = _VCP.unpack_from(buf, body)
                if head[0]:
                    els = []
                    for i in range(head[3]):
                        code = struct.unpack_from(">H", buf, body + _VCP.size + i * _VCP_EL)[0]
                        els.append(code * 360.0 / 65536.0)
                    vcp_els = els
            elif mtype == 1:
                return None  # a legacy volume: MetPy reads those
        off += step
    if vol is None:
        return None
    # One sweep per angle: the one whose first radial carries the most gates
    # of the moment (a split cut flies the angle twice).
    by_angle: dict[float, tuple[dict, int]] = {}
    for sw in sweeps:
        if not sw["az"] or sw["blk"][0] is None:
            continue
        gates = dblk_unpack(buf, sw["blk"][0])[2]
        angle = round(_sweep_angle(vcp_els, sw["el_num"], sw["el"]), 1)
        if angle not in by_angle or gates > by_angle[angle][1]:
            by_angle[angle] = (sw, gates)
    if not by_angle:
        return None
    out = []
    for angle in sorted(by_angle):
        sw, ngates = by_angle[angle]
        az = np.asarray(sw["az"], dtype=np.float32)
        order = np.argsort(az, kind="stable")
        nrad = az.size
        raw = np.zeros((nrad, ngates), dtype=np.uint16)
        scale = np.ones(nrad, dtype=np.float32)
        offset = np.zeros(nrad, dtype=np.float32)
        h0 = None
        for k, i in enumerate(order):
            p = sw["blk"][i]
            if p is None:
                continue
            _tn, _r, ng, first, width, _tv, _snr, _rc, dsize, sc, of = dblk_unpack(buf, p)
            if h0 is None:
                h0 = (first, width)
            n = min(ng, ngates)
            raw[k, :n] = np.frombuffer(buf, dtype=">u2" if dsize == 16 else ">u1", count=n, offset=p + _DBLK.size)
            scale[k], offset[k] = sc, of
        vals = (raw.astype(np.float32) - offset[:, None]) / scale[:, None]
        vals[raw < 2] = np.nan  # 0 below threshold, 1 range folded
        if kt_factor:
            vals *= np.float32(kt_factor)
        out.append({"elev": float(angle), "az": az[order], "first": h0[0] * 0.001, "width": h0[1] * 0.001,
                    "vals": vals.astype(np.float16), "nyq": sw["nyq"]})
    return {"sweeps": out, "lat": float(vol[4]), "lon": float(vol[5]), "vcp": int(vol[13]) or None,
            "siteAmslM": float(vol[6]), "feedhornM": float(vol[7])}


# ---------------------------------------------------------------------------
# Every sweep with several moments (the storm detections)
# ---------------------------------------------------------------------------
def read_sweeps(buf: bytes, moments: tuple[bytes, ...]) -> Optional[dict]:
    """Every sweep of a plain volume (see `plain`), split cuts apart, for
    radar_detect.nexrad_tilts: {"sweeps": [{"elev", "elNum", "unix", "nyq"
    (m/s, from the first radial's RRAD block, or None), "az" [...], "ptr"
    [{moment: block offset} per radial]}] in the order flown, "lat", "lon",
    "vcp", "siteAmslM", "feedhornM"}. Values come from `sweep_values`. None as
    read_moment answers None."""
    try:
        return _read_sweeps(buf, set(moments))
    except (struct.error, ValueError, IndexError, TypeError):
        return None


def _read_sweeps(buf: bytes, want: set) -> Optional[dict]:
    if buf[:4] != b"AR2V":
        return None
    size = len(buf)
    vcp_els: Optional[list[float]] = None
    vol = None
    sweeps: list[dict] = []
    off = 24
    hdr_unpack, d31_unpack = _HDR.unpack_from, _D31.unpack_from

    def new(el_num: int) -> dict:
        return {"el_num": el_num, "az": [], "el": [], "ptr": [], "unix": None, "nyq": None}

    while off + CTM + _HDR.size <= size:
        size_hw, _ch, mtype, _seq, _date, _ms, nseg, segn = hdr_unpack(buf, off + CTM)
        step = BLOCK
        if size_hw:
            if size_hw == 65535:
                step = (nseg << 16) | (segn + CTM)
            elif mtype in (29, 31):
                step = CTM + 2 * size_hw
            body = off + CTM + _HDR.size
            if mtype == 31:
                (_id, t_ms, d, _azn, az, comp, _rl, _azs, status, el_num, _sec, el_angle, _sb, _aim,
                 nblk) = d31_unpack(buf, body)
                if comp:
                    return None
                if (status & 0x0F) in _START:
                    sweeps.append(new(el_num))
                while len(sweeps) < el_num:
                    sweeps.append(new(el_num))
                sw = sweeps[-1]
                if not sw["az"]:
                    sw["el_num"] = el_num
                    sw["unix"] = (int(d) - 1) * 86400 + int(t_ms) / 1000.0
                ptrs: dict = {}
                for ptr in struct.unpack_from(f">{nblk}I", buf, body + _D31.size):
                    if not ptr:
                        continue
                    p = body + ptr
                    tag = bytes(buf[p:p + 4])
                    if tag[:1] == b"D":
                        name = tag[1:4].strip()
                        if name in want:
                            ptrs[name] = p
                    elif tag == b"RVOL":
                        if vol is None:
                            vol = _VOL.unpack_from(buf, p)
                    elif tag == b"RRAD" and sw["nyq"] is None and not sw["az"]:
                        sw["nyq"] = (struct.unpack_from(">H", buf, p + 16)[0] * 0.01) or None
                sw["az"].append(az)
                sw["el"].append(el_angle)
                sw["ptr"].append(ptrs)
            elif mtype == 5:
                head = _VCP.unpack_from(buf, body)
                if head[0]:
                    vcp_els = [struct.unpack_from(">H", buf, body + _VCP.size + i * _VCP_EL)[0] * 360.0 / 65536.0
                               for i in range(head[3])]
            elif mtype == 1:
                return None
        off += step
    if vol is None:
        return None
    out = []
    for sw in sweeps:
        if not sw["az"]:
            continue
        out.append({"elev": _sweep_angle(vcp_els, sw["el_num"], sw["el"]), "elNum": sw["el_num"],
                    "unix": sw["unix"], "nyq": sw["nyq"], "az": sw["az"], "ptr": sw["ptr"]})
    if not out:
        return None
    return {"sweeps": out, "lat": float(vol[4]), "lon": float(vol[5]), "vcp": int(vol[13]) or None,
            "siteAmslM": float(vol[6]), "feedhornM": float(vol[7])}


def sweep_gates(buf: bytes, sw: dict, src: bytes) -> Optional[tuple[float, float, int]]:
    """(first gate km, gate width km, gates) of a moment on the sweep's first
    radial (in azimuth order), None when that radial lacks it."""
    order = np.argsort(np.asarray(sw["az"], dtype=np.float64), kind="stable")
    p = sw["ptr"][int(order[0])].get(src)
    if p is None:
        return None
    _tn, _r, ng, first, width, *_rest = _DBLK.unpack_from(buf, p)
    return first * 0.001, width * 0.001, int(ng)


def sweep_values(buf: bytes, sw: dict, src: bytes, ngates: int) -> tuple[np.ndarray, np.ndarray]:
    """(azimuths ascending, values float32 radials x `ngates`) of one moment of
    a sweep from read_sweeps; NaN below threshold, range folded, or missing --
    MetPy's values, scaled the same way."""
    az = np.asarray(sw["az"], dtype=np.float64)
    order = np.argsort(az, kind="stable")
    out = np.full((az.size, ngates), np.nan, dtype=np.float32)
    for k, i in enumerate(order):
        p = sw["ptr"][int(i)].get(src)
        if p is None:
            continue
        _tn, _r, ng, _first, _width, _tv, _snr, _rc, dsize, sc, of = _DBLK.unpack_from(buf, p)
        n = min(ng, ngates)
        raw = np.frombuffer(buf, dtype=">u2" if dsize == 16 else ">u1", count=n, offset=p + _DBLK.size)
        v = (raw.astype(np.float32) - np.float32(of)) / np.float32(sc)
        v[raw < 2] = np.nan
        out[k, :n] = v
    return az[order], out
