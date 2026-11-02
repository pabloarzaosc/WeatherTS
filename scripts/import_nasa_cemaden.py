"""
Real volumes of CEMADEN's radars, from NASA's GPM Ground Validation archive,
into the app's Brazilian radar store -- an archive of real cases the radar
viewer plays like any other kept volume.

NASA's archive republishes, for each day a GPM satellite passes over a ground
radar, that radar's whole volume of the overpass: every sweep, every field,
after its dual-pol quality control, as one gzipped CF/Radial file:

    https://pmm-gv.gsfc.nasa.gov/pub/gpmarchive/Radar/VN/GPM/
        <SITE>/<YYYY>/<MMDD>/<SITE>_<YYYY>_<MMDD>_<HHMMSS>.cf.gz

(Apache listings at every level). The nine CEMADEN radars are there under
NASA's own codes -- AL1 Almenara, JG1 Jaraguari, MC1 Maceio, NT1 Natal, PE1
Petrolina, SV1 Salvador, ST1 Santa Teresa, SF1 Sao Francisco, TM1 Tres
Marias -- one volume a day, a few days a month. These are NASA's public
files: nothing here touches CEMADEN's own site or its CAPTCHA.

Each file is downloaded once -- skipped when the store already holds it --
and filed by brazil_radar.import_file exactly as it came (still gzipped;
the reader unpacks it). The store is brazil_radar.STORE: ~/.weatherts/radar-br,
or WEATHERTS_RADAR_BR (or --store here).

Usage, from the repo root:

    backend/.venv/Scripts/python.exe scripts/import_nasa_cemaden.py MC1 --years 2026
    backend/.venv/Scripts/python.exe scripts/import_nasa_cemaden.py MC1 NT1 --years 2025 2026 --days 0212,0224
    backend/.venv/Scripts/python.exe scripts/import_nasa_cemaden.py BR-MCZ --years 2026 --list
    backend/.venv/Scripts/python.exe scripts/import_nasa_cemaden.py all --years 2026 --list
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
ARCHIVE = "https://pmm-gv.gsfc.nasa.gov/pub/gpmarchive/Radar/VN/GPM"
USER_AGENT = "WeatherTS radar archive import (https://weatherts.tech)"
_DAY = re.compile(r'href="(\d{4})/"')


def _args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Import CEMADEN radar volumes from NASA's GPM Ground Validation archive.")
    p.add_argument("sites", nargs="+",
                   help="NASA site codes (MC1, NT1, ...), the app's ids (BR-MCZ, ...), or 'all' for the nine.")
    p.add_argument("--years", nargs="+", default=[str(datetime.now(timezone.utc).year)],
                   help="Years to look in (default: this year). Space or comma separated.")
    p.add_argument("--days", default="", help="Only these days, MMDD, comma separated (default: every day listed).")
    p.add_argument("--list", action="store_true", help="Only list what the archive has; download nothing.")
    p.add_argument("--store", default="", help="Store folder (default: WEATHERTS_RADAR_BR or ~/.weatherts/radar-br).")
    return p.parse_args()


def _split(values: list[str]) -> list[str]:
    return [v.strip() for x in values for v in str(x).split(",") if v.strip()]


def main() -> int:
    args = _args()
    # The store is fixed when brazil_radar loads, so --store goes in first.
    if args.store:
        os.environ["WEATHERTS_RADAR_BR"] = str(Path(args.store).expanduser().resolve())
    sys.path.insert(0, str(BACKEND))
    import requests  # noqa: PLC0415 - after the path is set, like the module
    import brazil_radar as br  # noqa: PLC0415

    by_id = {rid: code for code, rid in br.NASA_GV_SITES.items()}
    sites: list[str] = []
    for s in _split(args.sites):
        u = s.upper()
        if u == "ALL":
            sites += list(br.NASA_GV_SITES)
        elif u in br.NASA_GV_SITES:
            sites.append(u)
        elif u in by_id:
            sites.append(by_id[u])
        else:
            print(f"Unknown site {s}: one of {', '.join(br.NASA_GV_SITES)} or {', '.join(by_id)}.", file=sys.stderr)
            return 2
    sites = list(dict.fromkeys(sites))
    years = _split(args.years)
    if any(not re.fullmatch(r"\d{4}", y) for y in years):
        print("Years are four digits.", file=sys.stderr)
        return 2
    days = set(_split([args.days]))
    if any(not re.fullmatch(r"\d{4}", d) for d in days):
        print("Days are MMDD.", file=sys.stderr)
        return 2

    http = requests.Session()
    http.headers["User-Agent"] = USER_AGENT

    def get(url: str, *, listing: bool) -> requests.Response | None:
        """The response, or None for a folder the archive does not have."""
        for attempt in range(3):
            try:
                r = http.get(url, timeout=(15, 60 if listing else 300))
                if r.status_code == 404:
                    return None
                if r.status_code >= 500:
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                return r
            except requests.RequestException as exc:
                if attempt == 2:
                    raise
                print(f"  retrying {url}: {exc}", file=sys.stderr)
                time.sleep(3 * (attempt + 1))
        return None

    def kept(name: str) -> Path | None:
        # import_file keeps the name as it is (letters, digits, _ and .).
        return next(iter(br.STORE.glob(f"BR-*/*/{name}")), None)

    print(f"Store: {br.STORE}")
    found = imported = skipped = failed = 0
    for site in sites:
        rid = br.NASA_GV_SITES[site]
        file_re = re.compile(rf'href="({site}_\d{{4}}_\d{{4}}_\d{{6}}\.cf\.gz)"')
        for year in years:
            listing = get(f"{ARCHIVE}/{site}/{year}/", listing=True)
            if listing is None:
                print(f"{site} ({rid}) {year}: no folder in the archive")
                continue
            listed = sorted(set(_DAY.findall(listing.text)))
            want = [d for d in listed if not days or d in days]
            print(f"{site} ({rid}) {year}: {len(listed)} days listed ({', '.join(listed) or 'none'})"
                  + (f"; taking {', '.join(want) or 'none'}" if days else ""))
            for day in want:
                folder = f"{ARCHIVE}/{site}/{year}/{day}/"
                page = get(folder, listing=True)
                names = sorted(set(file_re.findall(page.text))) if page is not None else []
                if not names:
                    print(f"  {day}: no volume")
                for name in names:
                    found += 1
                    url = folder + name
                    have = kept(name)
                    if args.list:
                        print(f"  {name}  {url}" + ("  (kept)" if have else ""))
                        continue
                    if have:
                        skipped += 1
                        print(f"  {name}: already kept ({have.parent.name})")
                        continue
                    try:
                        t0 = time.time()
                        r = get(url, listing=False)
                        if r is None:
                            raise RuntimeError("gone from the archive (404)")
                        raw = r.content
                        if raw[:2] != b"\x1f\x8b":
                            raise RuntimeError("not a gzip file")
                        got = br.import_file(name, raw)
                        imported += 1
                        print(f"  {name}: {len(raw) / 1e6:.1f} MB in {time.time() - t0:.1f} s -> {got['radar']} "
                              f"{got['stamp']}, {got['sweeps']} sweeps, {', '.join(got['moments'])}")
                    except Exception as exc:  # noqa: BLE001 - one bad file leaves the rest
                        failed += 1
                        print(f"  {name}: FAILED: {exc}", file=sys.stderr)
                    time.sleep(0.5)   # one file at a time, gently
    if args.list:
        print(f"{found} volumes listed.")
    else:
        print(f"{found} volumes listed: {imported} imported, {skipped} already kept, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
