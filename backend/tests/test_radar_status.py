"""
radar_status: the live standing of each NEXRAD from the NWS radar feed.

Classes by the age of the newest data and its latency, the feed parsed into
one row per radar under the app's 3-letter id, the Level III cross-check for
a radar the feed calls quiet, the alarms still standing, and the outage
notice (FTM) without its transmission header.

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

import radar_status as rs  # noqa: E402

NOW = 1_793_513_520.0  # 2026-11-01 06:12 UTC


def _iso(unix: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()


def _station(icao: str, l2_age: float | None, latency: float | None, vcp="R35", alarm="No Alarms",
             op="RDA - On-line", status="Operate") -> dict:
    lat: dict = {}
    if latency is not None:
        lat["current"] = {"unitCode": "nwsUnit:s", "value": latency}
    if l2_age is not None:
        lat["levelTwoLastReceivedTime"] = _iso(NOW - l2_age)
    props = {"id": icao, "name": icao, "stationType": "WSR-88D", "latency": lat or None}
    if vcp is not None:
        props["rda"] = {"timestamp": _iso(NOW - 60), "properties": {
            "volumeCoveragePattern": vcp, "alarmSummary": alarm, "operabilityStatus": op, "status": status, "mode": "Operational"}}
    return {"type": "Feature", "properties": props}


class ClassifyTest(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(rs.classify(None, None), "unknown")
        self.assertEqual(rs.classify(0, 0.3), "ok")
        self.assertEqual(rs.classify(299, None), "ok")
        self.assertEqual(rs.classify(120, 75.0), "late")
        self.assertEqual(rs.classify(120, 60.0), "ok")  # exactly a minute is not late
        self.assertEqual(rs.classify(301, 0.2), "stale")
        self.assertEqual(rs.classify(1800, 0.2), "stale")
        self.assertEqual(rs.classify(1801, 0.2), "down")
        # an old radar is stale or down whatever its latency says
        self.assertEqual(rs.classify(900, 120.0), "stale")

    def test_vcp_and_ids(self):
        self.assertEqual(rs.vcp_number("R35"), "35")
        self.assertEqual(rs.vcp_number("R215"), "215")
        self.assertEqual(rs.vcp_number(12), "12")
        self.assertIsNone(rs.vcp_number(None))
        self.assertEqual(rs.sid_of("KTLX"), "TLX")
        self.assertEqual(rs.sid_of("PABC"), "ABC")
        self.assertEqual(rs.sid_of("TJUA"), "JUA")
        self.assertEqual(rs.sid_of("RKJK"), "KJK")


class ParseTest(unittest.TestCase):
    def setUp(self):
        doc = {"features": [
            _station("KTLX", 40, 0.17),
            _station("KEAX", 30, 75.3),
            _station("KDDC", 600, 0.2),
            _station("KHGX", 22_210, 0.13, vcp="R215", alarm="Pedestal", op="RDA - Inoperable", status="Start-Up"),
            _station("RODN", None, None, vcp=None),
            {"type": "Feature", "properties": {"id": "BAD"}},  # not an ICAO: skipped
        ]}
        self.rows = rs.parse_stations(doc, NOW)

    def test_rows(self):
        self.assertEqual(set(self.rows), {"TLX", "EAX", "DDC", "HGX", "ODN"})
        tlx = self.rows["TLX"]
        self.assertEqual((tlx["st"], tlx["vcp"], tlx["icao"], tlx["age"]), ("ok", "35", "KTLX", 40))
        self.assertEqual(self.rows["EAX"]["st"], "late")
        self.assertEqual(self.rows["DDC"]["st"], "stale")
        hgx = self.rows["HGX"]
        self.assertEqual((hgx["st"], hgx["vcp"], hgx["alarm"], hgx["op"], hgx["rda"]),
                         ("down", "215", "Pedestal", "RDA - Inoperable", "Start-Up"))
        odn = self.rows["ODN"]
        self.assertEqual((odn["st"], odn["l2"], odn["vcp"]), ("unknown", None, None))

    def test_cross_check(self):
        # the feed says 10 min, the Level III bucket has a scan from a minute ago
        fresh = rs.apply_cross_check(self.rows["DDC"], int(NOW - 60), NOW)
        self.assertEqual((fresh["st"], fresh["age"], fresh["via"], fresh["l3"]), ("ok", 60, "level3", int(NOW - 60)))
        # an older Level III scan changes nothing but is recorded
        older = rs.apply_cross_check(self.rows["HGX"], int(NOW - 70_000), NOW)
        self.assertEqual((older["st"], older["age"], older["l3"]), ("down", 22_210, int(NOW - 70_000)))
        self.assertNotIn("via", older)
        # no record in the feed, scans in the bucket: classed by those
        odn = rs.apply_cross_check(self.rows["ODN"], int(NOW - 400), NOW)
        self.assertEqual(odn["st"], "stale")
        self.assertIs(rs.apply_cross_check(self.rows["TLX"], None, NOW), self.rows["TLX"])


class AlarmsTest(unittest.TestCase):
    def test_standing(self):
        graph = [
            {"status": "secondary", "message": "RADIAL DATA LOST", "timestamp": _iso(NOW - 300)},
            {"status": "mandatory", "message": "AZIMUTH ENCODER LIGHT FAILURE", "timestamp": _iso(NOW - 200)},
            {"status": "cleared", "message": "AZIMUTH ENCODER LIGHT FAILURE", "timestamp": _iso(NOW - 100)},
            {"status": "inoperative", "message": "RCP AZ CONTROL UNRESPONSIVE", "timestamp": _iso(NOW - 50)},
            {"status": "secondary", "message": "RADIAL DATA LOST", "timestamp": _iso(NOW - 20)},
            {"status": "secondary", "message": "", "timestamp": _iso(NOW - 10)},
        ]
        got = rs.active_alarms(graph)
        self.assertEqual([a["message"] for a in got], ["RCP AZ CONTROL UNRESPONSIVE", "RADIAL DATA LOST"])
        self.assertEqual(got[0]["status"], "inoperative")
        self.assertEqual(got[1]["at"], int(NOW - 20))  # the newest entry of a message
        self.assertEqual(rs.active_alarms([]), [])


class NoticeTest(unittest.TestCase):
    def test_header_and_wrapped_word(self):
        text = (
            "\n000\nNOUS64 KFWD 311737\nFTMGRK\nMessage Date:  Oct 31 2026 17:37:14\n\n"
            "Technicians have identified the issue with Radar KGRK. Due to the estimated repa\n"
            "ir time, KGRK will likely be down through Wednesday, November 4.                \n\n"
        )
        self.assertEqual(
            rs.clean_ftm(text),
            "Technicians have identified the issue with Radar KGRK. Due to the estimated repair time, "
            "KGRK will likely be down through Wednesday, November 4.",
        )

    def test_paragraphs(self):
        text = (
            "\n000\nNOUS64 KHGX 010026\nFTMHGX\n\nKHGX radar is offline due to a technical issue. Our radar technician \n"
            "has been notified and will be troubleshooting early Sunday morning.\n"
        )
        self.assertEqual(
            rs.clean_ftm(text),
            "KHGX radar is offline due to a technical issue. Our radar technician has been notified "
            "and will be troubleshooting early Sunday morning.",
        )
        self.assertEqual(rs.clean_ftm("\n000\nNOUS64 KOUN 291851\nFTMTLX\n\nTHE KTLX WSR-88D IS OPERATIONAL.\n\nRB/WFO OUN\n"),
                         "THE KTLX WSR-88D IS OPERATIONAL.\n\nRB/WFO OUN")


class DetailTest(unittest.TestCase):
    """site_detail with the network parts replaced: no request leaves."""

    def _patch(self, notice):
        def undo(name, was):
            self.addCleanup(setattr, rs, name, was)

        for name, fn in {
            "status_row": lambda sid: {"icao": "KHGX", "st": "down", "age": 7200, "l2": 1},
            "_alarms": lambda icao: [{"message": "RADIAL DATA LOST", "status": "secondary", "at": 2}],
            "_notice": notice,
            "_l2_feed": lambda sid: None,
            "_l3_check": lambda sid: None,
        }.items():
            undo(name, getattr(rs, name))
            setattr(rs, name, fn)
        rs._DETAIL.pop("HGX", None)
        self.addCleanup(rs._DETAIL.pop, "HGX", None)

    def test_whole_answer_is_kept_a_minute(self):
        calls = []
        self._patch(lambda sid: calls.append(sid) or {"text": "Offline.", "at": 3, "office": "KHGX", "name": "FTM", "count": 1})
        got = rs.site_detail("KHGX")
        self.assertEqual(got["id"], "HGX")
        self.assertEqual(got["notice"]["text"], "Offline.")
        self.assertEqual(got["alarms"][0]["message"], "RADIAL DATA LOST")
        self.assertEqual(got["errors"], {})
        rs.site_detail("hgx")
        self.assertEqual(len(calls), 1)

    def test_part_that_failed_is_asked_again_soon(self):
        def boom(sid):
            raise OSError("no route")

        self._patch(boom)
        got = rs.site_detail("HGX")
        self.assertEqual(got["errors"], {"notice": "OSError"})
        self.assertNotIn("notice", got)
        # the partial answer holds 5 s, not the minute of a whole one
        at, _ = rs._DETAIL["HGX"]
        self.assertLess(at, rs.time.time() - rs._DETAIL_TTL + 6)

    def test_not_a_radar_id(self):
        with self.assertRaises(ValueError):
            rs.site_detail("../etc")


if __name__ == "__main__":
    unittest.main()
