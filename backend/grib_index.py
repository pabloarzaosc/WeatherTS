"""
A wgrib2-style inventory for a GRIB2 file that came without one.

NCEP's files on NOMADS and AWS each have an .idx beside them -- one line per
record, "12:345678:d=2013053123:TMP:850 mb:anl:" -- and every reader in this
app finds its fields through it. NCEI's archive of the same analyses keeps the
files but not the .idx. This writes the .idx from the file itself.

The record's identity is read straight from the message's bytes (discipline,
parameter, product template, the two fixed surfaces and the statistic), with
no eccodes involved: the walk takes a few milliseconds and is safe on any
thread. What wgrib2 calls each identity comes from a table read once off a
file that has both (scripts/build-rap-records.py writes it, into
grib_names.py); a record the table does not know is still listed, under a
name no reader asks for.
"""
from __future__ import annotations

from typing import Iterator, NamedTuple

try:
    from grib_names import NAMES
except ImportError:  # the table is being built
    NAMES: dict[str, tuple[str, str]] = {}


class Record(NamedTuple):
    number: int      # the message's place in the file, from 1
    sub: int         # which field of the message (NCEP packs u and v in one)
    fields: int      # how many fields the message holds
    offset: int      # where the message starts
    key: str         # the identity the names table is keyed by
    date: str        # the reference time, YYYYMMDDHH


def identity(disc: int, s4: bytes) -> str:
    """'discipline|category|parameter|template|t1|f1|v1|t2|f2|v2|statistic'
    from section 4 (octet n is s4[n - 1]). The statistic is only in the
    templates over a time window (4.8); anything else leaves it blank."""
    pdtn = int.from_bytes(s4[7:9], "big")
    parts = [disc, s4[9], s4[10], pdtn,
             s4[22], s4[23], int.from_bytes(s4[24:28], "big"),
             s4[28], s4[29], int.from_bytes(s4[30:34], "big")]
    stat = s4[46] if pdtn == 8 and len(s4) > 46 else ""
    return "|".join(str(p) for p in parts) + f"|{stat}"


def records(buf: bytes) -> Iterator[Record]:
    """Every field of every GRIB2 message in `buf`, in file order."""
    at, number = 0, 0
    while True:
        at = buf.find(b"GRIB", at)
        if at < 0 or at + 16 > len(buf) or buf[at + 7] != 2:
            return
        total = int.from_bytes(buf[at + 8:at + 16], "big")
        if total <= 16 or at + total > len(buf):
            return
        number += 1
        disc, end, pos = buf[at + 6], at + total, at + 16
        found: list[tuple[str, str]] = []
        date = ""
        while pos + 5 <= end and buf[pos:pos + 4] != b"7777":
            size = int.from_bytes(buf[pos:pos + 4], "big")
            if size < 5:
                break
            num = buf[pos + 4]
            if num == 1:
                s1 = buf[pos:pos + size]
                date = "%04d%02d%02d%02d" % (int.from_bytes(s1[12:14], "big"), s1[14], s1[15], s1[16])
            elif num == 4:
                found.append((identity(disc, buf[pos:pos + size]), date))
            pos += size
        for sub, (key, d) in enumerate(found, 1):
            yield Record(number, sub, len(found), at, key, d)
        at += total


def idx_lines(buf: bytes) -> list[str]:
    """The .idx wgrib2 would have written for `buf`."""
    out = []
    for r in records(buf):
        n = f"{r.number}.{r.sub}" if r.fields > 1 else str(r.number)
        name, desc = NAMES.get(r.key, (f"VAR{r.key.replace('|', '_')}:unknown", "anl"))
        out.append(f"{n}:{r.offset}:d={r.date}:{name}:{desc}:")
    return out
