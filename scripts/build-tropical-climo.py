"""Build public/data/tropical-climo.json from IBTrACS: the tropical record of
every basin, small enough to ship with the app.

IBTrACS is 360 MB of CSV for the whole world -- far too much for every copy
of the app to download -- while what the Tropical screen needs from it is
small: each season's ACE day by day, and a line per storm. Past seasons do
not change, so this runs once a year (after IBTrACS's spring update) and the
result is committed; the current season comes live from the best-track decks.

Usage:
  python scripts/build-tropical-climo.py <dir with ibtracs.<BASIN>.list.v04r01.csv or ibtracs.<BASIN>.csv>

Winds are the USA agencies' one-minute winds (NHC, CPHC, JTWC), the same
convention as the live decks; ACE sums v^2/10^4 over the 00/06/12/18 UTC
fixes at 34 kt or more while the system is tropical or subtropical.
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# The app's basins: IBTrACS basin codes that make each one.
BASINS = {
    "al": ["NA"],
    "ep": ["EP"],
    "wp": ["WP"],
    "io": ["NI"],
    "sh": ["SI", "SP"],
}
SOUTH = {"sh"}
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def ms(t: datetime) -> int:
    return int((t - EPOCH).total_seconds() * 1000)


def num(s: str) -> float | None:
    s = s.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def season_start(year: int, south: bool) -> datetime:
    # A Southern Hemisphere season runs July to June and is named for the
    # year it ends in (IBTrACS's SEASON field does the same).
    return datetime(year - 1, 7, 1, tzinfo=timezone.utc) if south else datetime(year, 1, 1, tzinfo=timezone.utc)


def read(path: Path):
    with path.open(newline="", encoding="utf-8", errors="replace") as fh:
        rd = csv.reader(fh)
        head = next(rd)
        next(rd)  # units
        idx = {k: i for i, k in enumerate(head)}
        for row in rd:
            yield idx, row


def build(src: Path, current_year: int) -> dict:
    out: dict = {"source": "IBTrACS v04r01 (USA agency winds)", "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                 "basins": {}}
    for basin, codes in BASINS.items():
        south = basin in SOUTH
        storms: dict[str, dict] = {}
        # A storm that crosses from one IBTrACS basin to the other (South
        # Indian to South Pacific) is in both files whole: each fix once.
        seen: set[tuple[str, str]] = set()
        for code in codes:
            path = next((p for p in (src / f"ibtracs.{code}.list.v04r01.csv", src / f"ibtracs.{code}.csv") if p.exists()), None)
            if path is None:
                print("missing", code, file=sys.stderr)
                continue
            for idx, row in read(path):
                sid = row[idx["SID"]]
                if (sid, row[idx["ISO_TIME"]]) in seen:
                    continue
                seen.add((sid, row[idx["ISO_TIME"]]))
                season = int(row[idx["SEASON"]])
                if season >= current_year:
                    continue
                t = datetime.strptime(row[idx["ISO_TIME"]], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                wind = num(row[idx["USA_WIND"]])
                pres = num(row[idx["USA_PRES"]]) or num(row[idx["WMO_PRES"]])
                nature = row[idx["NATURE"]].strip()
                s = storms.get(sid)
                if s is None:
                    name = row[idx["NAME"]].strip().title()
                    s = storms[sid] = {"sid": sid, "name": "" if name in ("Not_Named", "Unnamed") else name,
                                       "season": season, "start": t, "end": t, "peak": 0.0, "minp": None,
                                       "ace": 0.0, "daily": {}}
                s["end"] = max(s["end"], t)
                s["start"] = min(s["start"], t)
                if wind is not None and nature in ("TS", "SS"):
                    s["peak"] = max(s["peak"], wind)
                if pres is not None and pres > 800 and (s["minp"] is None or pres < s["minp"]):
                    s["minp"] = pres
                if wind is not None and wind >= 34 and nature in ("TS", "SS") and t.minute == 0 and t.hour % 6 == 0:
                    a = wind * wind / 1e4
                    s["ace"] += a
                    day = (t - season_start(season, south)).days
                    s["daily"][day] = s["daily"].get(day, 0.0) + a
        years: dict[int, dict] = {}
        lines = []
        for s in sorted(storms.values(), key=lambda s: s["start"]):
            y = years.setdefault(s["season"], {"ace": 0.0, "named": 0, "hurr": 0, "major": 0, "daily": {}})
            y["ace"] += s["ace"]
            if s["peak"] >= 34:
                y["named"] += 1
            if s["peak"] >= 64:
                y["hurr"] += 1
            if s["peak"] >= 96:
                y["major"] += 1
            for d, a in s["daily"].items():
                y["daily"][d] = y["daily"].get(d, 0.0) + a
            if s["peak"] >= 34:
                lines.append([s["sid"], s["name"], s["season"], ms(s["start"]), ms(s["end"]), s["peak"],
                              s["minp"], round(s["ace"], 2)])
        out["basins"][basin] = {
            "south": south,
            "first": min(years) if years else None,
            "last": max(years) if years else None,
            "years": {str(k): {"ace": round(v["ace"], 1), "named": v["named"], "hurr": v["hurr"], "major": v["major"],
                               "daily": [[d, round(a, 2)] for d, a in sorted(v["daily"].items())]}
                      for k, v in sorted(years.items())},
            # sid, name, season, start ms, end ms, peak kt, min mb, ACE
            "storms": lines,
        }
        print(basin, len(years), "seasons", len(lines), "storms", file=sys.stderr)
    return out


if __name__ == "__main__":
    src = Path(sys.argv[1])
    data = build(src, datetime.now(timezone.utc).year)
    dest = Path(__file__).resolve().parents[1] / "public" / "data" / "tropical-climo.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print("wrote", dest, dest.stat().st_size, "bytes", file=sys.stderr)
