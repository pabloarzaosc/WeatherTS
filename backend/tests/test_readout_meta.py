"""The sweep details the Shift readout and the product info panel read from a
scan's metadata (nexrad_level2._sweep_consts, nexrad_core._l3_antenna), and
the range-folded marking."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import nexrad_core  # noqa: E402
import nexrad_level2  # noqa: E402


def _radial(nyq_ms: float, unamb_km: float, date: int, time_ms: int) -> tuple:
    hdr = SimpleNamespace(date=date, time_ms=time_ms, az_angle=0.0)
    vol = SimpleNamespace(site_amsl=369, feedhorn_agl=19, lat=35.333, lon=-97.278, vcp=12)
    rad = SimpleNamespace(nyq_vel=nyq_ms, unamb_range=unamb_km)
    return (hdr, vol, None, rad, {})


class SweepConstsTest(unittest.TestCase):
    def test_message_31_sweep(self):
        # 2013-05-20 is day 15846 of the NEXRAD calendar (1 = 1970-01-01).
        radials = [_radial(26.13, 148.0, 15846, 72008900 + k) for k in range(5)]
        f = SimpleNamespace(rda={"BEAMWIDTH": 0.91, "TFREQ_MHZ": 2910})
        out = nexrad_level2._sweep_consts(f, radials)
        self.assertAlmostEqual(out["nyquistKt"], 50.8, places=1)
        self.assertEqual(out["unambRangeKm"], 148.0)
        self.assertEqual(out["beamWidthDeg"], 0.91)
        self.assertEqual(out["freqMHz"], 2910)
        self.assertEqual(out["band"], "S")
        self.assertEqual(out["siteAmslM"] + out["feedhornM"], 388.0)
        self.assertAlmostEqual(out["sweepUnix"], 1369080008.9, places=1)

    def test_no_adaptation_data_falls_back_to_nominal_beam(self):
        radials = [_radial(0.0, 0.0, 15846, 0)]
        out = nexrad_level2._sweep_consts(SimpleNamespace(), radials)
        self.assertEqual(out["beamWidthDeg"], nexrad_level2._WSR88D_BEAM_DEG)
        self.assertNotIn("nyquistKt", out)  # zero means unknown, not 0 kt
        self.assertNotIn("freqMHz", out)

    def test_range_folded_sentinel(self):
        self.assertEqual(nexrad_level2._L2RF.RANGE_FOLD, nexrad_level2._RF_SENTINEL)
        # MetPy's own value is NaN, the same as an empty gate; ours is not.
        self.assertTrue(nexrad_level2._L2RF.RANGE_FOLD == nexrad_level2._L2RF.RANGE_FOLD)
        self.assertNotEqual(nexrad_level2._L2RF.MISSING, nexrad_level2._L2RF.MISSING)


class Level3AntennaTest(unittest.TestCase):
    def test_height_in_feet(self):
        out = nexrad_core._l3_antenna(SimpleNamespace(height=1277))
        self.assertAlmostEqual(out["siteAmslM"], 389.2, places=1)
        self.assertEqual(out["beamWidthDeg"], 0.95)

    def test_missing_height(self):
        self.assertNotIn("siteAmslM", nexrad_core._l3_antenna(SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
