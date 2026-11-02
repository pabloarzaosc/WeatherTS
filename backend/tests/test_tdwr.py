"""
TDWR, the FAA's airport radars: the site table, the codes on either kind of
radar, the renamed West Palm Beach radar, the true gate spacing, a raster product
on radials and the NWS feed's directory page. No network.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import numpy as np  # noqa: E402

import nexrad_core as n3  # noqa: E402
import radar_status as rs  # noqa: E402
import tdwr  # noqa: E402


class Sites(unittest.TestCase):
    def test_the_network(self):
        rows = tdwr.sites()
        self.assertEqual(len(rows), 45)
        self.assertEqual({r["type"] for r in rows}, {"TDWR"})
        by_id = {r["id"]: r for r in rows}
        # The radars the owner named, and the ones the first list had wrong:
        # TJUA is San Juan's WSR-88D, TLKA publishes nothing, TPBI became TDJT.
        for sid in ("BNA", "MEM", "RDU", "CLT", "ADW", "BWI", "SJU", "DJT"):
            self.assertIn(sid, by_id)
        for sid in ("JUA", "LKA", "PBI"):
            self.assertNotIn(sid, by_id)
        self.assertEqual(by_id["BWI"]["icao"], "TBWI")
        for r in rows:
            self.assertTrue(15 < r["lat"] < 50 and -120 < r["lon"] < -60, r["id"])
            self.assertEqual(len(r["state"]), 2)

    def test_is_tdwr(self):
        for yes in ("BWI", "TBWI", "bwi", "tbwi", " TBNA "):
            self.assertTrue(tdwr.is_tdwr(yes), yes)
        # KJUA / TJUA: the NEXRAD; KBWI is no radar of this kind.
        for no in ("TLX", "KTLX", "JUA", "TJUA", "BR-PNV", "", None, "KBWI"):
            self.assertFalse(tdwr.is_tdwr(no), no)

    def test_icao(self):
        self.assertEqual(n3.icao_for("BWI"), "TBWI")
        self.assertEqual(n3.site_id("TBWI"), "BWI")
        self.assertEqual(n3.live_code("BWI"), "TZ0")
        self.assertEqual(n3.live_code("TLX"), "N0B")


class Codes(unittest.TestCase):
    def test_a_nexrad_code_on_a_tdwr(self):
        cases = {
            "N0B": "TZ0", "NAB": "TZ1", "N1B": "TZ1", "NBB": "TZ1", "N2B": "TZ2", "N3B": "TZ2",
            "N0G": "TV0", "NAG": "TV1", "N1G": "TV1",
            "EET": "NET", "DVL": "NVL",
            "L2B0": "TZ0", "L2G1": "TV1", "L2ET": "NET", "L2VIL": "NVL", "L2DVIL": "NVL",
        }
        for code, want in cases.items():
            self.assertEqual(tdwr.to_tdwr(code), want, code)

    def test_a_moment_a_tdwr_does_not_have_is_refused(self):
        # Answered with reflectivity, a pane said CC over reflectivity data.
        for code in ("N0C", "NAX", "N1K", "N0H", "N0S", "N1R", "HHC", "OHA", "DAA", "DTA",
                     "L2C0", "L2X1", "L2CREF", "L2NROT0", "L2SRV2"):
            with self.assertRaises(tdwr.NotOnTdwr, msg=code):
                tdwr.to_tdwr(code)
            with self.assertRaises(tdwr.NotOnTdwr, msg=code):
                n3.polar_data("BWI", code)

    def test_what_a_tdwr_has_stays(self):
        for code in tdwr.PRODUCTS:
            self.assertEqual(tdwr.to_tdwr(code), code)
        # Not moments: a TDWR publishes these under the same codes.
        for code in ("NVW", "NST", "NMD"):
            self.assertEqual(tdwr.to_tdwr(code), code)

    def test_a_tdwr_code_on_a_nexrad(self):
        cases = {"TZ0": "N0B", "TZ1": "N1B", "TZ2": "N2B", "TZL": "N0B", "TV0": "N0G", "TV1": "N1G", "TV2": "N1G",
                 "NVL": "DVL", "NET": "EET"}
        for code, want in cases.items():
            self.assertEqual(tdwr.to_nexrad(code), want, code)
            self.assertEqual(tdwr.for_site("TLX", code), want)
        for code in ("N0B", "L2C0", "NVW", "DVL"):
            self.assertEqual(tdwr.for_site("TLX", code), code)
        self.assertEqual(tdwr.for_site("BWI", "N0B"), "TZ0")

    def test_catalogue(self):
        cat = n3.product_catalog()
        tz = [f for f in cat if f["id"] == "TZL"]
        self.assertEqual(len(tz), 1)
        # hidden until a TDWR's availability fills it in
        self.assertTrue(tz[0]["unavailable"] and tz[0]["tdwrOnly"])
        for code, spec in tdwr.PRODUCTS.items():
            self.assertEqual(n3.PRODUCTS[code]["kind"], spec["kind"], code)


class Rename(unittest.TestCase):
    def test_west_palm_beach(self):
        self.assertEqual(tdwr.archive_id("DJT", "2026_11_01"), "DJT")
        self.assertEqual(tdwr.archive_id("DJT", "2026-08-12"), "DJT")
        self.assertEqual(tdwr.archive_id("DJT", "2026_07_31"), "PBI")
        self.assertEqual(tdwr.archive_id("DJT", "2021-05-01"), "PBI")
        self.assertEqual(tdwr.archive_id("BWI", "2021_05_01"), "BWI")


class Geometry(unittest.TestCase):
    def test_gate_spacing(self):
        # A TDWR's own Level II says it: first gate 0, 150 m x 592, 300 m x 1390.
        self.assertEqual(tdwr.gate_km("TZ0"), 0.15)
        self.assertEqual(tdwr.gate_km("TV2"), 0.15)
        self.assertEqual(tdwr.gate_km("TZL"), 0.3)
        self.assertIsNone(tdwr.gate_km("NVL"))
        self.assertIsNone(tdwr.gate_km("N0B"))
        self.assertAlmostEqual(592 * tdwr.gate_km("TZ0"), tdwr.DOPPLER_RANGE_KM)
        self.assertAlmostEqual(1390 * tdwr.gate_km("TZL"), tdwr.LONG_RANGE_KM)

    def test_raster_on_radials(self):
        # 116 x 116 at 4 km around the radar: first row north, first column west.
        grid = np.zeros((116, 116), dtype=np.uint8)
        grid[56, 60] = 7  # x 8..12 km east, y 4..8 km north
        grid[78, 38] = 9  # x 76..80 km west, y 80..84 km south
        codes, az = n3._raster_to_polar(grid, 4.0, 230.0)  # noqa: SLF001
        self.assertEqual(codes.shape, (360, 230))
        self.assertEqual(len(az), 361)
        rows, cols = np.nonzero(codes == 7)
        self.assertTrue(rows.size > 0)
        # bearing 45 to 72 deg, 9 to 15 km out
        self.assertTrue(44 <= rows.min() and rows.max() <= 72, (rows.min(), rows.max()))
        self.assertTrue(7 <= cols.min() and cols.max() <= 15, (cols.min(), cols.max()))
        rows, cols = np.nonzero(codes == 9)
        # bearing about 223 deg, about 113 km out
        self.assertTrue(220 <= rows.min() and rows.max() <= 230, (rows.min(), rows.max()))
        self.assertTrue(107 <= cols.min() and cols.max() <= 118, (cols.min(), cols.max()))
        # past the range: not drawn, and the grid's corners are off the radials
        grid = np.zeros((116, 116), dtype=np.uint8)
        grid[0, 0] = 5
        codes, _ = n3._raster_to_polar(grid, 4.0, 230.0)  # noqa: SLF001
        self.assertEqual(int((codes == 5).sum()), 0)


class Feed(unittest.TestCase):
    PAGE = """
<tr><td><a href="/SL.us008001/DF.of/DC.radar/DS.p41et/">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td></tr>
<tr><td><a href="sn.0001">sn.0001</a></td><td align="right">01-Nov-2026 06:18  </td><td align="right">1.3K</td></tr>
<tr><td><a href="sn.0000">sn.0000</a></td><td align="right">01-Nov-2026 06:12  </td><td align="right">1.3K</td></tr>
<tr><td><a href="sn.last">sn.last</a></td><td align="right">01-Nov-2026 06:18  </td><td align="right">1.3K</td></tr>
"""

    def test_listing(self):
        got = n3.parse_feed_listing(self.PAGE, "BWI", "NET", "https://x/")
        # oldest first, in the bucket's key shape, not sn.last (a copy of the newest)
        self.assertEqual(list(got), ["BWI_NET_2026_11_01_06_12_00", "BWI_NET_2026_11_01_06_18_00"])
        self.assertEqual(got["BWI_NET_2026_11_01_06_18_00"], "https://x/sn.0001")
        self.assertIsNotNone(n3.key_time("BWI_NET_2026_11_01_06_18_00"))

    def test_scan_url_is_the_bucket_otherwise(self):
        self.assertEqual(n3.scan_url("BWI_TZ0_2026_11_01_06_12_00"), n3.S3 + "BWI_TZ0_2026_11_01_06_12_00")
        # an old NET is in the bucket; nothing is fetched to find that out
        self.assertEqual(n3.scan_url("MEM_NET_2023_06_05_13_29_15"), n3.S3 + "MEM_NET_2023_06_05_13_29_15")
        self.assertEqual(n3.scan_url("TLX_NET_2026_11_01_06_12_00"), n3.S3 + "TLX_NET_2026_11_01_06_12_00")


class Paging(unittest.TestCase):
    def test_a_day_past_one_page(self):
        # A hazardous-mode TZ0 day is up to 1440 keys, and a page holds 1000.
        pages = [
            "<IsTruncated>true</IsTruncated><Key>MEM_TZ0_2026_11_01_00_00_00</Key><NextContinuationToken>abc</NextContinuationToken>",
            "<IsTruncated>false</IsTruncated><Key>MEM_TZ0_2026_11_01_23_59_00</Key>",
        ]
        asked = []

        class Resp:
            ok = True

            def __init__(self, text):
                self.text = text

        def fake_get(url, params=None, timeout=None):
            asked.append(dict(params))
            return Resp(pages[len(asked) - 1])

        keep = n3._SESSION.get  # noqa: SLF001
        n3._SESSION.get = fake_get  # noqa: SLF001
        try:
            keys = n3._list_keys("MEM", "TZ0", "2026_11_01")  # noqa: SLF001
        finally:
            n3._SESSION.get = keep  # noqa: SLF001
        self.assertEqual(keys, ["MEM_TZ0_2026_11_01_00_00_00", "MEM_TZ0_2026_11_01_23_59_00"])
        self.assertEqual(asked[1]["continuation-token"], "abc")


class Availability(unittest.TestCase):
    def _run(self, newest: dict, at=None):
        import nexrad_availability as na

        now = 1_793_513_520
        keep = (na._newest, n3.l3_elevation, n3.feed_keys)  # noqa: SLF001
        na._newest = lambda sid, code, since, until=None: newest.get(code)  # noqa: SLF001
        n3.l3_elevation = lambda key: {"TZ0": 0.3, "TZ1": 1.0, "TZ2": 2.3, "TV0": 0.3, "TV1": 1.0, "TV2": 2.3}[key.split("_")[1]]
        n3.feed_keys = lambda sid, code: [f"{sid}_{code}_2026_11_01_06_10_00"] if newest.get("_feed") else []
        na._TDWR_ELEV.clear()  # noqa: SLF001
        try:
            return na._check_tdwr("MEM", at)  # noqa: SLF001
        finally:
            na._newest, n3.l3_elevation, n3.feed_keys = keep  # noqa: SLF001

    def test_what_a_tdwr_lists(self):
        t = 1_793_513_400
        got = self._run({"TZ0": t, "TZ1": t, "TZ2": t, "TV0": t, "TV1": t, "TV2": t, "TZL": t, "NVL": t - 300, "_feed": True})
        fam = got["families"]
        self.assertEqual([(x["code"], x["tilt"], x["elev"]) for x in fam["B"]], [("TZ0", "0", 0.3), ("TZ1", "1", 1.0), ("TZ2", "2", 2.3)])
        self.assertEqual([x["code"] for x in fam["G"]], ["TV0", "TV1", "TV2"])
        self.assertEqual([x["code"] for x in fam["TZL"]], ["TZL"])
        self.assertEqual([x["code"] for x in fam["DVL"]], ["NVL"])
        self.assertEqual([x["code"] for x in fam["EET"]], ["NET"])  # the NWS feed
        self.assertEqual(got["labels"]["EET"], "Echo Tops")
        # Nothing else: no Level II, nothing derived from it, no dual-pol.
        for fid in ("L2C", "L2X", "L2W", "L2CREF", "L2S", "K", "S", "R", "H", "HHC", "OHA", "DAA", "DTA"):
            self.assertEqual(fam.get(fid), [], fid)
        self.assertFalse(got["level2"])
        self.assertFalse(got["level2Pending"])
        self.assertEqual(got["site"], "TMEM")
        self.assertEqual(got["cuts"], [0.3, 1.0, 2.3])

    def test_the_archive_has_no_feed(self):
        t = 1_793_513_400
        got = self._run({"TZ0": t, "TV0": t, "_feed": True}, at=t)
        self.assertEqual(got["families"]["EET"], [])
        self.assertEqual([x["code"] for x in got["families"]["B"]], ["TZ0"])

    def test_a_silent_radar_lists_nothing(self):
        got = self._run({})
        self.assertIsNone(got["newestScan"])
        self.assertEqual(got["families"]["B"], [])
        self.assertFalse(got["live"])


class Status(unittest.TestCase):
    def test_a_tdwr_row(self):
        # as api.weather.gov has it: the same fields, VCP "L80"
        now = 1_793_513_520.0
        from datetime import datetime, timezone
        iso = datetime.fromtimestamp(now - 30, tz=timezone.utc).isoformat()
        doc = {"features": [{"properties": {
            "id": "TBWI", "name": "Baltimore/Wash", "stationType": "TDWR",
            "latency": {"current": {"value": 0.06}, "levelTwoLastReceivedTime": iso},
            "rda": {"timestamp": iso, "properties": {"volumeCoveragePattern": "L80", "alarmSummary": "No Alarms",
                                                     "status": "Operate", "operabilityStatus": "RDA - On-line", "mode": "Operational"}},
        }}]}
        rows = rs.parse_stations(doc, now)
        self.assertEqual(rows["BWI"]["icao"], "TBWI")
        self.assertEqual(rows["BWI"]["type"], "TDWR")
        self.assertEqual(rows["BWI"]["vcp"], "80")
        self.assertEqual(rows["BWI"]["st"], "ok")

    def test_the_feed_asks_for_both(self):
        self.assertIn("WSR-88D", rs.STATIONS)
        self.assertIn("TDWR", rs.STATIONS)


if __name__ == "__main__":
    unittest.main()
