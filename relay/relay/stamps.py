"""
A radar file's name -> the volume it belongs to.

A volume is named by its scan start, the "stamp": UTC "YYYYMMDDHHMMSS". Every
file of one volume (one per moment, for Rainbow) shares it, and the relay keys
storage, the index and the API on it. Three ways a name carries it, tried in
this order:

    CEMADEN Rainbow 5   <stamp><2 digits><moment>.vol | .vol.h5
                        "2026101207400500dBZ.vol" -> 20261012074005, dBZ
    NASA GPM-VN         <SITE>_<YYYY>_<MMDD>_<HHMMSS>.cf.gz
                        "MC1_2026_0224_133002.cf.gz" -> 20260224133002
    anything else       the first 14-digit run, or YYYYMMDD-HHMMSS,
                        YYYYMMDD_HHMMSS, YYYYMMDDTHHMMSS

The names themselves are never changed: a ".cf.gz" stays gzip, a ".vol" stays
Rainbow. The relay does not read a file's contents at all.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

# Rainbow 5: 14 digits of scan start, two more (Rainbow's own counter), the
# moment as the radar names it (dBZ, dBuZ, V, W, ZDR, uZDR, RhoHV, KDP, PhiDP,
# uPhiDP, SQI, SNR, ...), then .vol, or .vol.h5 for the HDF5 copy.
_RAINBOW = re.compile(r"^(\d{14})(\d{2})([A-Za-z][A-Za-z0-9_]*)\.(vol(?:\.h5)?)$")
# NASA GPM Validation Network: CfRadial, gzipped, one file per volume.
_NASA_VN = re.compile(r"^([A-Z0-9]{2,4})_(\d{4})_(\d{4})_(\d{6})\.cf\.gz$")
# Fallbacks: a 14-digit run (the first 14 of a longer one), or date and time
# with a separator between them.
_GENERIC_14 = re.compile(r"(?<!\d)(\d{14})")
_GENERIC_SPLIT = re.compile(r"(?<!\d)(\d{8})[-_T](\d{6})(?!\d)")

STAMP_RE = re.compile(r"^\d{14}$")
# What a stored file may be called: the API serves only names like this, so
# no name can climb out of its folder ("..", slashes, drive letters).
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$")


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name or "")) and ".." not in name


@dataclass(frozen=True)
class Parsed:
    stamp: str                 # UTC YYYYMMDDHHMMSS
    unix: int
    kind: str                  # "rainbow" | "nasa_vn" | "generic"
    moment: Optional[str] = None   # Rainbow only: "dBZ", "V", ...
    fmt: Optional[str] = None      # Rainbow only: "vol" | "vol.h5"
    site: Optional[str] = None     # NASA only: "MC1", ...


def stamp_unix(stamp: str) -> Optional[int]:
    """The stamp's UTC time as a unix second, or None when it is no real time
    (month 13, year 0001...). Years outside 1990-2100 are refused too: a run of
    14 digits in a name is not always a date."""
    if not STAMP_RE.match(stamp or ""):
        return None
    try:
        d = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    if not 1990 <= d.year <= 2100:
        return None
    return int(d.timestamp())


def unix_stamp(unix: float) -> str:
    return datetime.fromtimestamp(int(unix), tz=timezone.utc).strftime("%Y%m%d%H%M%S")


def parse_rainbow(name: str) -> Optional[Parsed]:
    m = _RAINBOW.match(name)
    if not m:
        return None
    u = stamp_unix(m.group(1))
    if u is None:
        return None
    return Parsed(m.group(1), u, "rainbow", moment=m.group(3), fmt=m.group(4))


def parse_nasa_vn(name: str) -> Optional[Parsed]:
    m = _NASA_VN.match(name)
    if not m:
        return None
    stamp = m.group(2) + m.group(3) + m.group(4)
    u = stamp_unix(stamp)
    if u is None:
        return None
    return Parsed(stamp, u, "nasa_vn", site=m.group(1))


def parse_generic(name: str) -> Optional[Parsed]:
    for rx in (_GENERIC_SPLIT, _GENERIC_14):
        for m in rx.finditer(name):
            stamp = "".join(m.groups())
            u = stamp_unix(stamp)
            if u is not None:
                return Parsed(stamp, u, "generic")
    return None


def parse_name(name: str) -> Optional[Parsed]:
    """The volume a file belongs to, from its name alone; None when the name
    carries no scan time (a picture, a checksum file, a README)."""
    return parse_rainbow(name) or parse_nasa_vn(name) or parse_generic(name)
