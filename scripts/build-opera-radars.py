"""Builds backend/data/opera_radars.json: the European radars with data in EUMETNET's
open bucket, with what OPERA's station table says of each, and every folder each has
files in today (Ireland has two: SCAN for reflectivity, PVOL for velocity). The backend
looks the folders up again each day; these are what it falls back on.

    backend/.venv/Scripts/python.exe scripts/build-opera-radars.py
"""
from __future__ import annotations

import csv
import io
import json
import re
import time
from pathlib import Path

import h5py
import requests

BUCKET = "https://s3.waw3-1.cloudferro.com/openradar-24h/"
TABLE = (
    "https://raw.githubusercontent.com/EUMETNET/openradardata-validator/main/"
    "src/openradardata_validator/stations/OPERA_RADARS.csv"
)
OPERATORS = {
    "BE": "RMI", "CH": "MeteoSwiss", "CZ": "CHMI", "DE": "DWD", "DK": "DMI", "EE": "EEA", "ES": "AEMET", "FI": "FMI",
    "FR": "Météo-France", "HR": "DHMZ", "HU": "HungaroMet", "IE": "Met Éireann", "IS": "IMO", "LT": "LHMT", "MT": "Malta Met",
    "NL": "KNMI", "NO": "MET Norway", "PL": "IMGW", "RO": "ANM", "SE": "SMHI", "SK": "SHMU",
}


# The radars OPERA's table leaves out, by where their files say they are.
NAMES = {
    "esahr": "Málaga", "esatn": "Gran Canaria", "esclg": "Sevilla", "esgld": "Barcelona", "espdg": "Zaragoza",
    "essft": "Cáceres", "estjv": "Madrid", "isx2": "Mobile X-band",
}


def prefixes(prefix: str) -> list[str]:
    r = requests.get(BUCKET, params={"list-type": 2, "prefix": prefix, "delimiter": "/", "max-keys": 1000}, timeout=40)
    r.raise_for_status()
    return re.findall(r"<CommonPrefixes><Prefix>([^<]+)</Prefix>", r.text)


def position_in_file(folder: str) -> tuple[float, float]:
    r = requests.get(BUCKET, params={"list-type": 2, "prefix": folder, "max-keys": 1}, timeout=40)
    key = re.search(r"<Key>([^<]+)</Key>", r.text).group(1)
    with h5py.File(io.BytesIO(requests.get(BUCKET + key, timeout=120).content), "r") as f:
        return float(f["where"].attrs["lat"]), float(f["where"].attrs["lon"])


def main() -> None:
    day = time.strftime("%Y/%m/%d", time.gmtime())
    rows = csv.DictReader(io.StringIO(requests.get(TABLE, timeout=30).content.decode("utf-8", "replace")))
    table = {(row.get("ODIM code") or "").strip().lower(): row for row in rows}
    out = []
    for country_dir in prefixes(f"{day}/"):
        cc = country_dir.split("/")[-2]
        if cc == "OPERA":
            continue
        for radar_dir in prefixes(country_dir):
            code = radar_dir.split("/")[-2]
            row = table.get(code) or {}
            folders = [p.split("/")[-2] for p in prefixes(radar_dir)]
            try:
                lat, lon = float(row["Latitude"]), float(row["Longitude"])
            except (TypeError, ValueError, KeyError):
                # Not in the table, or a mobile radar with no position there: the
                # scans themselves say where they were made.
                lat, lon = position_in_file(f"{radar_dir}{folders[0]}/")
                print("position from a file:", code, lat, lon)
            out.append({
                "code": code,
                "cc": cc,
                "name": (row.get("Location") or NAMES.get(code) or code.upper()).strip(),
                "op": OPERATORS.get(cc, ""),
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "band": (row.get("Band") or "").strip(),
                "pol": (row.get("Polarization") or "").strip(),
                "km": (row.get("Max Range (km)") or "").strip(),
                "folders": folders,
            })
    target = Path(__file__).resolve().parent.parent / "backend" / "data" / "opera_radars.json"
    target.write_text(json.dumps(sorted(out, key=lambda r: r["code"]), ensure_ascii=False, indent=0), encoding="utf-8")
    print(len(out), "radars,", target.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
