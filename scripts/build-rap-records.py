"""Write backend/grib_names.py: what wgrib2 calls each record of a RAP 13 km
file, keyed by the identity grib_index reads from the bytes.

One RAP analysis from AWS has both the file and its .idx; pairing them record
by record gives the table. NCEI's archive (RUC 2005-2012, RAP 2012-2021) is
the same family of files without the .idx, and grib_index names its records
with this table.

    backend/.venv/Scripts/python.exe scripts/build-rap-records.py
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import grib_index  # noqa: E402

URL = "https://noaa-rap-pds.s3.amazonaws.com/rap.20230325/rap.t00z.awp130pgrbf00.grib2"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def main() -> int:
    buf = fetch(URL)
    lines = fetch(URL + ".idx").decode("ascii").splitlines()
    recs = list(grib_index.records(buf))
    if len(recs) != len(lines):
        print(f"{len(recs)} records but {len(lines)} .idx lines", file=sys.stderr)
        return 1
    table: dict[str, tuple[str, str]] = {}
    for rec, line in zip(recs, lines):
        p = line.split(":")
        if int(p[1]) != rec.offset:
            print(f"offsets differ at {line}", file=sys.stderr)
            return 1
        name = f"{p[3]}:{p[4]}"
        if rec.key in table and table[rec.key][0] != name:
            print(f"one identity, two names: {rec.key} {table[rec.key][0]} / {name}", file=sys.stderr)
            return 1
        table[rec.key] = (name, p[5])
    out = ROOT / "backend" / "grib_names.py"
    body = "\n".join(f"    {k!r}: {v!r}," for k, v in sorted(table.items()))
    out.write_text(
        '"""What wgrib2 calls each record of a RAP 13 km file, by the identity\n'
        "grib_index reads from its bytes. Written by scripts/build-rap-records.py\n"
        f'from {URL} and its .idx; do not edit."""\n\n'
        "NAMES: dict[str, tuple[str, str]] = {\n" + body + "\n}\n",
        encoding="utf-8",
    )
    print(f"{len(table)} records -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
