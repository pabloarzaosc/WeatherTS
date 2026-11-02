"""
archive-l2: whole days of the Level II archive (nexrad_level2.archive_day and
friends), back to the 1990s.

Nothing downloaded: the bucket listing is stubbed with the file names the
archive really uses over the years (1999 .gz, 2011 _V03.gz, 2016 plain _V06,
_MDM metadata, fragments, a change-over day holding both forms).

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import nexrad_level2 as l2  # noqa: E402


def _xml(objs: list[tuple[str, int]], token: str | None = None) -> str:
    body = "".join(f"<Contents><Key>{k}</Key><Size>{s}</Size></Contents>" for k, s in objs)
    more = f"<NextContinuationToken>{token}</NextContinuationToken>" if token else ""
    return f"<ListBucketResult>{body}{more}</ListBucketResult>"


class _Resp:
    def __init__(self, text: str):
        self.text = text
        self.status_code = 200

    def raise_for_status(self) -> None:
        pass


class ArchiveRowsTest(unittest.TestCase):
    def test_names_over_the_years(self):
        rows = l2._archive_rows([
            {"path": "1999/05/03/KTLX/KTLX19990503_231633.gz", "size": 2_222_162},
            {"path": "1999/05/03/KTLX/KTLX19990503_230052.gz", "size": 9_424},  # fragment
            {"path": "2011/04/27/KBMX/KBMX20110427_000826_V03.gz", "size": 1_495_211},
            {"path": "2024/05/06/KTLX/KTLX20240506_000100_V06", "size": 4_958_196},
            {"path": "2024/05/06/KTLX/KTLX20240506_000100_V06_MDM", "size": 696_998},
        ])
        keys = [r["key"] for r in rows]
        self.assertEqual(keys, [
            "L2A:KTLX19990503_230052.gz",
            "L2A:KTLX19990503_231633.gz",
            "L2A:KBMX20110427_000826_V03.gz",
            "L2A:KTLX20240506_000100_V06",
        ])  # oldest first; the _MDM file is not a volume
        frag = rows[0]
        self.assertTrue(frag["partial"])
        self.assertFalse(rows[1]["partial"])
        self.assertEqual(rows[1]["time"], 925773393)  # 1999-05-03 23:16:33Z
        self.assertEqual(rows[1]["stamp"], "19990503-231633")
        self.assertEqual(rows[1]["size"], 2_222_162)

    def test_change_over_day_keeps_one_copy(self):
        rows = l2._archive_rows([
            {"path": "2016/06/01/KTLX/KTLX20160601_235004_V06.gz", "size": 7_000_000},
            {"path": "2016/06/01/KTLX/KTLX20160601_235004_V06", "size": 7_818_734},
            {"path": "2016/06/01/KTLX/KTLX20160601_235436_V06.gz", "size": 7_000_000},
        ])
        self.assertEqual([r["key"] for r in rows],
                         ["L2A:KTLX20160601_235004_V06", "L2A:KTLX20160601_235436_V06.gz"])


class ArchiveDayTest(unittest.TestCase):
    def setUp(self):
        l2._DAY_LISTS.clear()
        l2._ARCHIVE_LISTS.clear()

    def test_pages_and_caches(self):
        pages = [
            _xml([("1999/05/03/KTLX/KTLX19990503_000321.gz", 465_549)], token="t1"),
            _xml([("1999/05/03/KTLX/KTLX19990503_235621.gz", 2_338_885)]),
        ]
        calls: list[dict] = []

        def get(url, params=None, timeout=None, **kw):
            calls.append(dict(params or {}))
            return _Resp(pages[len(calls) - 1])

        with mock.patch.object(l2._SESSION, "get", side_effect=get):
            day = l2.archive_day("TLX", "1999-05-03")
            again = l2.archive_day("KTLX", "1999-05-03")
        self.assertEqual([v["key"] for v in day],
                         ["L2A:KTLX19990503_000321.gz", "L2A:KTLX19990503_235621.gz"])
        self.assertIs(day, again)  # a past day is listed once
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["prefix"], "1999/05/03/KTLX/")
        self.assertEqual(calls[1].get("continuation-token"), "t1")

    def test_bad_and_future_dates(self):
        with self.assertRaises(ValueError):
            l2.archive_day("KTLX", "1999-5-3")
        with self.assertRaises(ValueError):
            l2.archive_day("KTLX", "../../x")
        with mock.patch.object(l2._SESSION, "get") as get:
            self.assertEqual(l2.archive_day("KTLX", "2999-01-01"), [])
            get.assert_not_called()

    def test_loop_window_skips_fragments(self):
        page = _xml([
            ("1999/05/03/KTLX/KTLX19990503_225552.gz", 1_916_389),
            ("1999/05/03/KTLX/KTLX19990503_230052.gz", 9_424),
            ("1999/05/03/KTLX/KTLX19990503_231633.gz", 2_222_162),
        ])
        with mock.patch.object(l2._SESSION, "get", return_value=_Resp(page)):
            vols = l2.archive_volumes("KTLX", 2, 925772000)
        self.assertEqual([v["key"] for v in vols],
                         ["L2A:KTLX19990503_225552.gz", "L2A:KTLX19990503_231633.gz"])


class AzimuthHoleTest(unittest.TestCase):
    """A sweep that begins mid-way (after an outage) has a hole: an empty
    radial covers it instead of the radial before it stretching across."""

    def test_hole_gets_an_empty_radial(self):
        import numpy as np

        az = np.array([0.0, 1.0, 2.0, 3.0, 40.0, 41.0, 42.0], dtype=np.float32)
        az = np.append(az, az[0] + 360.0).astype(np.float32)
        vals = np.arange(7 * 2, dtype=np.float32).reshape(7, 2)
        rows, edges = l2._fill_az_gaps(vals, az)
        self.assertEqual(rows.shape, (9, 2))  # the wrap past 42 deg is a hole too
        self.assertEqual(edges.tolist(), [0, 1, 2, 3, 4, 40, 41, 42, 43, 360])
        self.assertTrue(np.isnan(rows[4]).all())
        self.assertEqual(rows[3].tolist(), vals[3].tolist())
        self.assertEqual(rows[5].tolist(), vals[4].tolist())

    def test_whole_sweep_unchanged(self):
        import numpy as np

        az = np.append(np.arange(0, 360, 1.0), 360.0).astype(np.float32)
        vals = np.zeros((360, 3), dtype=np.float32)
        rows, edges = l2._fill_az_gaps(vals, az)
        self.assertIs(rows, vals)
        self.assertIs(edges, az)


class LegacyCutsTest(unittest.TestCase):
    """A legacy volume has no scan strategy: the cuts come from its sweeps."""

    def _sweep(self, el_num: int, angle: float, moments: tuple[str, ...]):
        hdr = SimpleNamespace(el_num=el_num, el_angle=angle, vcp=11)
        # message 1 layout: (header, {name: data}, ...) -- names in text
        return [(hdr, {m: (SimpleNamespace(num_gates=460), None) for m in moments}, None)] * 4

    def test_cuts_from_sweeps(self):
        f = SimpleNamespace(sweeps=[
            self._sweep(1, 0.44, ("REF",)),
            self._sweep(2, 0.45, ("VEL", "SW")),
            self._sweep(3, 1.45, ("REF",)),
            self._sweep(4, 1.44, ("VEL", "SW")),
            self._sweep(5, 2.40, ("REF", "VEL", "SW")),
        ])
        out = l2._cuts_from_volume("KTLX", f, "L2A:KTLX19990503_231633.gz", 925774593)
        self.assertEqual(out["cuts"], [0.4, 1.4, 2.4])
        self.assertEqual(out["moments"]["0.44"], "BGW")
        self.assertEqual(out["moments"]["2.4"], "BGW")
        self.assertEqual(out["elevationsFlown"], 3)
        self.assertEqual(out["volume"], "L2A:KTLX19990503_231633.gz")

    def test_gz_volume_is_read_whole(self):
        l2._ARCHIVE_CUTS.clear()
        f = SimpleNamespace(sweeps=[self._sweep(1, 0.48, ("REF", "VEL", "SW"))])
        vols = [{"key": "L2A:KTLX20080510_233217.gz", "time": 1210462337}]
        with mock.patch.object(l2, "archive_volumes", return_value=vols), \
             mock.patch.object(l2, "_decode_archive", return_value=(f, "20080510-233217")) as dec, \
             mock.patch.object(l2, "_archive_ends") as ends:
            out = l2.site_cuts("KTLX", 1210462000)
        dec.assert_called_once_with("KTLX20080510_233217.gz")
        ends.assert_not_called()  # a gzip's two ends cannot be read apart
        self.assertEqual(out["cuts"], [0.5])
        self.assertEqual(out["moments"]["0.48"], "BGW")  # no dual-pol in 2008


if __name__ == "__main__":
    unittest.main()
