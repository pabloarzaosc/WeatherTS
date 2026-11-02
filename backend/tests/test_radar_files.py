"""
radar_files: a loop frame's original radar file (the Frames panel's download).

Nothing downloaded: the chunk listing and fetch are stubbed, the Brazilian
store is a temporary folder.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import nexrad_core  # noqa: E402
import nexrad_level2 as l2  # noqa: E402
import radar_files as rf  # noqa: E402

STAMP = "20261025-040817"
CHUNKS = [  # listed out of order on purpose
    (f"KTLX/41/{STAMP}-002-I", 300),
    (f"KTLX/41/{STAMP}-001-S", 100),
    (f"KTLX/41/{STAMP}-003-E", 200),
]


class KeyShapeTest(unittest.TestCase):
    def test_rejects_keys_that_are_not_frames(self):
        for key in ["../etc/passwd", "http://x/y", "TLX_N0B_2026", "L2:abc:20261025-040817",
                    "L2A:../../KTLX20130520_195941_V06", "L2BR:2026", "", "TLX_N0B_2026_10_25_04_15_20/../x"]:
            with self.subTest(key=key):
                with self.assertRaises(rf.FileError):
                    rf.describe("KTLX", key)
                with self.assertRaises(rf.FileError):
                    rf.original("KTLX", key)

    def test_level2_names_follow_the_archive(self):
        self.assertEqual(rf._l2_name("KTLX", STAMP), "KTLX20261025_040817_V06")
        self.assertEqual(rf._l2_name("KTLX", STAMP, True), "KTLX20261025_040817_V06_partial")
        self.assertEqual(rf._safe('a "b"/c.h5'), "a__b__c.h5")


class LiveVolumeTest(unittest.TestCase):
    def setUp(self):
        rf._INFO.clear()
        self.got: list[list[int]] = []

        def get_chunks(site, vol, stamp, ch, nums, pool=None):
            self.got.append(list(nums))
            return [f"<{n}>".encode() for n in nums]

        self.patches = [
            mock.patch.object(nexrad_core, "icao_for", lambda s: "KTLX"),
            mock.patch.object(l2, "_volume_chunks", lambda s, v: list(CHUNKS)),
            mock.patch.object(l2, "_chunks_for", lambda s, v: list(CHUNKS[:2])),
            mock.patch.object(l2, "_get_chunks", get_chunks),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_whole_volume_is_its_chunks_in_order(self):
        name, raw = rf.original("KTLX", f"L2:41:{STAMP}")
        self.assertEqual(name, "KTLX20261025_040817_V06")
        self.assertEqual(raw, b"<1><2><3>")
        info = rf.describe("KTLX", f"L2:41:{STAMP}:c2")  # a SAILS rescan: same volume
        self.assertEqual((info["bytes"], info["chunks"], info["partial"]), (600, 3, False))

    def test_volume_being_written_is_what_is_there(self):
        name, raw = rf.original("KTLX", f"L2P:41:{STAMP}")
        self.assertEqual(name, "KTLX20261025_040817_V06_partial")
        self.assertEqual(raw, b"<1><2>")
        info = rf.describe("KTLX", f"L2P:41:{STAMP}")
        self.assertTrue(info["partial"])
        self.assertNotIn(("KTLX", f"L2P:41:{STAMP}"), rf._INFO)  # grows: never kept

    def test_a_reused_volume_number_is_not_another_file(self):
        with self.assertRaises(LookupError):
            rf.original("KTLX", "L2:41:20261024-120000")


class BrazilVolumeTest(unittest.TestCase):
    def test_one_file_as_is_several_zipped(self):
        import brazil_radar

        with tempfile.TemporaryDirectory() as tmp:
            vdir = Path(tmp) / "BR-MCZ" / "20260208064002"
            vdir.mkdir(parents=True)
            (vdir / "info.json").write_text("{}")
            (vdir / "a.hdf5").write_bytes(b"AAA")
            with mock.patch.object(brazil_radar, "STORE", Path(tmp)):
                rf._INFO.clear()
                self.assertEqual(rf.original("BR-MCZ", "L2BR:20260208064002"), ("a.hdf5", b"AAA"))
                (vdir / "b.hdf5").write_bytes(b"BB")
                name, raw = rf.original("BR-MCZ", "L2BR:20260208064002")
                self.assertEqual(name, "BR-MCZ_20260208064002.zip")
                with zipfile.ZipFile(io.BytesIO(raw)) as z:
                    self.assertEqual(sorted(z.namelist()), ["a.hdf5", "b.hdf5"])
                rf._INFO.clear()
                self.assertEqual(rf.describe("BR-MCZ", "L2BR:20260208064002")["bytes"], 5)
                with self.assertRaises(LookupError):
                    rf.original("BR-MCZ", "L2BR:20260208064003")


if __name__ == "__main__":
    unittest.main()
