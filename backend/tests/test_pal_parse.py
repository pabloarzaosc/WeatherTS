"""
nexrad_core.parse_pal: the server's reading of GRLevelX .pal colour tables.

The browser colours the radar itself (src/lib/pal.ts); the server's reader
builds the colormaps for what it draws on its own and the value range of each
table. Both must agree on the segment rules: a second colour on a Color line
ends that segment (it is not an alpha), SolidColor holds flat to the next
stop, and the header lines carry no stops.

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

import nexrad_core  # noqa: E402
from nexrad_core import parse_pal, pal_to_cmap  # noqa: E402


def rgba255(c):
    return tuple(round(x * 255) for x in c)


class ParsePalTest(unittest.TestCase):
    def test_two_colour_color_line_is_not_alpha(self):
        stops = parse_pal("Color: 20 0 225 255 0 200 255\nColor: 25 0 150 255\n")
        # first colour opaque at 20, the segment's own end colour just below 25
        self.assertEqual(rgba255(stops[0][1]), (0, 225, 255, 255))
        self.assertAlmostEqual(stops[1][0], 25, places=4)
        self.assertLess(stops[1][0], 25)
        self.assertEqual(rgba255(stops[1][1]), (0, 200, 255, 255))
        self.assertEqual(stops[2], (25.0, (0.0, 150 / 255, 1.0, 1.0)))

    def test_color4_alpha_and_second_colour(self):
        stops = parse_pal("Color4: 0 10 20 30 40 50 60 70 80\nColor4: 10 1 2 3 255\n")
        self.assertEqual(rgba255(stops[0][1]), (10, 20, 30, 40))
        self.assertEqual(rgba255(stops[1][1]), (50, 60, 70, 80))
        self.assertEqual(rgba255(stops[2][1]), (1, 2, 3, 255))

    def test_solid_colours_hold_to_the_next_stop(self):
        stops = parse_pal("SolidColor: 5 94 94 94\nSolidColor4: 10 131 131 131 128\nColor: 15 0 0 0\n")
        values = [round(v, 3) for v, _ in stops]
        self.assertEqual(values, [5, 10.0, 10, 15.0, 15])
        self.assertEqual(stops[0][1], stops[1][1])  # flat 5 -> just under 10
        self.assertEqual(rgba255(stops[2][1]), (131, 131, 131, 128))
        self.assertEqual(stops[2][1], stops[3][1])

    def test_header_lines_carry_no_stops(self):
        text = """; comment line
Product: BV
Units: KTS
Step: 10
Scale: 1.94384
Offset: 0
Label: Velocity
Decimals: 1
RF: 119 0 125
Color: -64 0 255 0
Color: 64 255 0 0
"""
        stops = parse_pal(text)
        self.assertEqual([v for v, _ in stops], [-64.0, 64.0])

    def test_bare_shorthand_and_last_segment_colour(self):
        stops = parse_pal("0 0 0 0 0\n10 255 0 0\n")
        self.assertEqual(rgba255(stops[0][1]), (0, 0, 0, 0))
        self.assertEqual(rgba255(stops[1][1]), (255, 0, 0, 255))
        # a two-colour LAST entry: its end colour is what holds past it
        stops = parse_pal("Color: 0 0 0 0\nColor: 10 255 0 0 0 0 255\n")
        self.assertEqual(rgba255(stops[-1][1]), (0, 0, 255, 255))

    def test_every_palette_builds(self):
        for pid, spec in nexrad_core.PALETTES.items():
            cmap, vmin, vmax = pal_to_cmap(pid, spec["pal"])
            self.assertLess(vmin, vmax, pid)

    def test_winter_and_steps(self):
        self.assertIn("REF_WINTER", nexrad_core.PALETTES)
        self.assertIn("PTDS_STEPS", nexrad_core.PALETTES)
        # both are alternates: hidden from the per-product list
        ids = {p["id"] for p in nexrad_core.list_palettes()}
        self.assertNotIn("REF_WINTER", ids)
        self.assertNotIn("PTDS_STEPS", ids)

        cmap, vmin, vmax = pal_to_cmap("REF_WINTER", nexrad_core.PALETTES["REF_WINTER"]["pal"])
        at = lambda v: rgba255(cmap((v - vmin) / (vmax - vmin)))  # noqa: E731
        self.assertEqual(at(-5)[3], 0)                 # nothing under 0
        self.assertEqual(at(12)[:3], (118, 180, 246))  # the 10-15 band, flat
        self.assertEqual(at(14.9)[:3], (118, 180, 246))
        self.assertEqual(at(32)[:3], (226, 128, 214))  # pink under 35
        self.assertGreater(at(38)[0], 250)             # yellow from 35
        self.assertGreater(at(38)[1], 200)

        cmap, vmin, vmax = pal_to_cmap("PTDS_STEPS", nexrad_core.PALETTES["PTDS_STEPS"]["pal"])
        at = lambda v: rgba255(cmap((v - vmin) / (vmax - vmin)))  # noqa: E731
        self.assertEqual(at(69)[3], 0)                 # nothing under 70
        self.assertEqual(at(91)[:3], (196, 10, 22))    # hard red band from 90
        self.assertEqual(at(94)[:3], (255, 52, 52))
        mid = at(97.5)                                 # magenta -> white
        self.assertEqual(mid[0], 255)
        self.assertGreater(mid[1], 100)
        self.assertLess(mid[1], 155)


if __name__ == "__main__":
    unittest.main()
