"""
radar_derived: products computed from a Level II volume.

All synthetic, nothing downloaded: a column of reflectivity sampled by a
volume of cuts (CREF, ET, VIL, DVIL), a Rankine vortex in a uniform wind,
folded at a Nyquist velocity (both unfolding methods, VROT), the debris
score's rules gate by gate, echo tracking of a shifted field, and the codes.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import numpy as np  # noqa: E402

import radar_derived as rdv  # noqa: E402
import radar_detect as rd  # noqa: E402

CUTS = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5]


def column_sweeps(dbz_of_height, s_km=60.0, cuts=CUTS, n_az=360, gate=0.25, ngates=1200):
    """Sweeps whose every gate within 2 km (ground) of s_km, between azimuths
    80 and 100, holds dbz_of_height(beam-centre height above the antenna, km);
    no echo elsewhere."""
    az = (np.arange(n_az) + 0.5) * (360.0 / n_az)
    sweeps = []
    for el in cuts:
        r = 2.0 + np.arange(ngates) * gate
        h = rd.beam_height_km(r, el)
        s = rd.ground_km(r, el)
        vals = np.full((n_az, ngates), np.nan, dtype=np.float32)
        cols = np.abs(s - s_km) <= 2.0
        rows = (az > 80) & (az < 100)
        for j in np.nonzero(cols)[0]:
            vals[rows, j] = dbz_of_height(float(h[j]))
        sweeps.append({"elev": el, "az": az, "first": 2.0, "width": gate, "vals": vals.astype(np.float16)})
    return sweeps


def rankine(az, r_km, az0=40.0, r0=60.0, vmax=35.0, rc=1.5, env=(8.0, 4.0)):
    """Radial velocity (m/s) of a cyclonic Rankine vortex at (az0, r0) in a
    uniform wind `env` (u, v), on a 0.5 deg x 0.25 km polar grid."""
    a = np.radians(az)[:, None]
    x = np.sin(a) * r_km[None, :]
    y = np.cos(a) * r_km[None, :]
    cx, cy = math.sin(math.radians(az0)) * r0, math.cos(math.radians(az0)) * r0
    dx, dy = x - cx, y - cy
    d = np.hypot(dx, dy)
    vt = np.where(d <= rc, vmax * d / rc, vmax * rc / np.maximum(d, 1e-6))
    # cyclonic (counter-clockwise): tangential unit vector (-dy, dx) / d
    with np.errstate(invalid="ignore", divide="ignore"):
        u = env[0] + np.where(d > 0, -vt * dy / d, 0.0)
        v = env[1] + np.where(d > 0, vt * dx / d, 0.0)
    return ((u * x + v * y) / np.maximum(np.hypot(x, y), 1e-6)).astype(np.float32)


def fold(v, nyq):
    return ((v + nyq) % (2 * nyq) - nyq).astype(np.float32)


class CodeTest(unittest.TestCase):
    def test_parse_and_canonical(self):
        self.assertEqual(rdv.parse("L2CREF").name, "CREF")
        self.assertEqual(rdv.parse("L2VIL").canonical, "L2VIL")
        self.assertEqual(rdv.parse("L2VROT0").canonical, "L2VROT0_DR")
        self.assertEqual(rdv.parse("l2s1").canonical, "L2S1_DR_MA")
        c = rdv.parse("L2S0_DV_M240-30")
        self.assertEqual((c.dealias, c.motion, c.manual), ("vad", "manual", (240.0, 30.0)))
        self.assertEqual(c.canonical, "L2S0_DV_M240-30")
        self.assertIsNone(rdv.parse("L2ET0"))        # a volume product has no tilt
        self.assertIsNone(rdv.parse("L2VROT"))       # a tilted one needs one
        self.assertIsNone(rdv.parse("L2B0"))         # plain moments are not derived
        self.assertIsNone(rdv.parse("L2G0_DX"))

    def test_raw_velocity_stays_on_the_plain_path(self):
        self.assertFalse(rdv.handles("L2G0_D0"))
        self.assertTrue(rdv.handles("L2G0"))
        self.assertTrue(rdv.handles("L2S0_D0"))      # SRV always needs its motion
        self.assertFalse(rdv.handles("L2C0"))

    def test_query_parameters_fold_into_the_code(self):
        self.assertEqual(rdv.with_options("L2S0", "vad", "240/30"), "L2S0_DV_M240-30")
        self.assertEqual(rdv.with_options("L2G1", "off", ""), "L2G1_D0")
        self.assertEqual(rdv.with_options("L2S0", "", "sti"), "L2S0_DR_MS")
        self.assertEqual(rdv.with_options("L2CREF", "vad", "sti"), "L2CREF")
        self.assertEqual(rdv.with_options("L2C0", "vad", ""), "L2C0")

    def test_catalog_families(self):
        cat = {f["id"]: f for f in rdv.catalog()}
        self.assertEqual(set(cat), {"L2CREF", "L2ET", "L2VIL", "L2DVIL", "L2VROT", "L2PTDS", "L2S"})
        self.assertEqual(cat["L2VIL"]["tilts"][0]["code"], "L2VIL")
        self.assertIsNone(cat["L2VIL"]["tilts"][0]["tilt"])
        self.assertEqual(cat["L2PTDS"]["needs"], "C")
        self.assertIn("L2VROT0", [t["code"] for t in cat["L2VROT"]["tilts"]])
        for f in cat.values():
            for t in f["tilts"]:
                self.assertIsNotNone(rdv.parse(t["code"]), t["code"])


class ColumnTest(unittest.TestCase):
    def test_uniform_column(self):
        # 40 dBZ from the ground to 8 km, nothing above.
        sw = column_sweeps(lambda h: 40.0 if h <= 8.0 else np.nan)
        az = np.array([90.0, 200.0])
        s = np.array([60.0])
        out = rdv.column_products(sw, az, s, antenna_msl_km=0.4, antenna_agl_km=0.02)
        self.assertAlmostEqual(float(out["CREF"][0, 0]), 40.0, places=1)
        self.assertTrue(np.isnan(out["CREF"][1, 0]))
        # ET: the highest beam centre at or under 8 km, in kft above sea level.
        tops = [rd.beam_height_km(rdv.slant_and_height(s, e)[0], e)[0] for e in CUTS]
        top = max(h for h in tops if h <= 8.0)
        self.assertAlmostEqual(float(out["ET"][0, 0]), (top + 0.4) * 3.28084, delta=0.15)
        # VIL: 3.44e-6 ((Z_i + Z_i+1) / 2)^(4/7) dh layer by layer -- full Z
        # from the lowest beam to the top one with echo, then half of it up to
        # the next beam (which sees none).
        low = tops[0]
        above = min(h for h in tops if h > 8.0)
        want = (3.44e-6 * (10 ** 4.0) ** (4 / 7) * (top - low) * 1000.0
                + 3.44e-6 * (0.5 * 10 ** 4.0) ** (4 / 7) * (above - top) * 1000.0)
        self.assertAlmostEqual(float(out["VIL"][0, 0]), want, delta=0.05 * want)
        self.assertAlmostEqual(float(out["DVIL"][0, 0]), out["VIL"][0, 0] / ((top + 0.02) * 1000) * 1000, places=3)

    def test_hail_cap_and_composite(self):
        sw_hail = column_sweeps(lambda h: 70.0 if h <= 6.0 else np.nan)
        sw_cap = column_sweeps(lambda h: 56.0 if h <= 6.0 else np.nan)
        az, s = np.array([90.0]), np.array([60.0])
        a = rdv.column_products(sw_hail, az, s, 0.0)
        b = rdv.column_products(sw_cap, az, s, 0.0)
        self.assertAlmostEqual(float(a["CREF"][0, 0]), 70.0, places=1)
        self.assertAlmostEqual(float(a["VIL"][0, 0]), float(b["VIL"][0, 0]), places=3)   # capped at 56

    def test_top_above_the_volume_is_flagged(self):
        sw = column_sweeps(lambda h: 50.0, s_km=20.0)       # echo all the way up
        out = rdv.column_products(sw, np.array([90.0]), np.array([20.0]), 0.0)
        self.assertTrue(out["capped"][0, 0])
        self.assertTrue(np.isnan(out["DVIL"][0, 0]))
        self.assertTrue(np.isfinite(out["ET"][0, 0]))

    def test_slant_and_height_invert_ground_range(self):
        r = np.array([10.0, 80.0, 200.0])
        for el in (0.5, 4.0, 19.5):
            s = rd.ground_km(r, el)
            rr, hh = rdv.slant_and_height(s, el)
            np.testing.assert_allclose(rr, r, rtol=1e-6)
            np.testing.assert_allclose(hh, rd.beam_height_km(r, el), rtol=1e-6, atol=1e-6)


class UnfoldTest(unittest.TestCase):
    az = (np.arange(720) + 0.5) * 0.5
    r = 2.0 + np.arange(600) * 0.25

    def truth(self):
        return rankine(self.az, self.r, vmax=45.0, env=(14.0, 10.0))

    def check(self, alg):
        nyq = 20.0
        v = self.truth()
        out = rdv.unfold(fold(v, nyq), nyq, self.r, self.az, 0.5, alg)
        ok = np.isfinite(out)
        self.assertGreater(ok.mean(), 0.99)             # every gate comes back
        right = np.abs(out[ok] - v[ok]) < 0.5
        self.assertGreater(right.mean(), 0.97, f"{alg}: {right.mean():.3f}")
        # the vortex itself (within 3 km of its centre) is unfolded
        a = np.radians(self.az)[:, None]
        cx, cy = math.sin(math.radians(40)) * 60, math.cos(math.radians(40)) * 60
        near = np.hypot(np.sin(a) * self.r - cx, np.cos(a) * self.r - cy) < 3.0
        self.assertGreater((np.abs(out[near] - v[near]) < 0.5).mean(), 0.9, alg)
        return out

    def test_region_based(self):
        self.check("region")

    def test_vad_seeded(self):
        self.check("vad")

    def test_off_is_as_observed(self):
        f = fold(self.truth(), 20.0)
        np.testing.assert_array_equal(rdv.unfold(f, 20.0, self.r, self.az, 0.5, "off"), f)

    def test_vad_rings_find_the_wind(self):
        nyq = 15.0
        v = rankine(self.az, self.r, vmax=0.0, env=(-22.0, 9.0))
        rings = rdv.vad_rings(fold(v, nyq), nyq, self.r, self.az, 0.5)
        self.assertGreater(len(rings), 10)
        for _, u, w, coh in rings:
            self.assertAlmostEqual(u, -22.0 * 1.0, delta=1.0)
            self.assertAlmostEqual(w, 9.0, delta=1.0)
            self.assertGreater(coh, 0.9)


class VrotTest(unittest.TestCase):
    def test_rankine_vrot_is_the_peak_wind(self):
        az = (np.arange(720) + 0.5) * 0.5
        r = 2.0 + np.arange(400) * 0.25
        vmax = 30.0
        v = rankine(az, r, vmax=vmax, rc=1.0, env=(0.0, 0.0))
        out = rdv.vrot_field(v, r, 0.5)
        peak = float(np.nanmax(out))
        # Half the spread of the gates across the vortex -- the sampled peak
        # winds, a little under the true one (gates do not fall on the core edge).
        a = np.radians(az)[:, None]
        cx, cy = math.sin(math.radians(40.0)) * 60.0, math.cos(math.radians(40.0)) * 60.0
        near = np.hypot(np.sin(a) * r - cx, np.cos(a) * r - cy) < 2.5
        self.assertAlmostEqual(peak, 0.5 * (v[near].max() - v[near].min()), delta=0.5)
        self.assertGreater(peak, 0.75 * vmax)
        # where: at the vortex, not elsewhere
        i, j = np.unravel_index(int(np.nanargmax(out)), out.shape)
        self.assertLess(abs(az[i] - 40.0), 3.0)
        self.assertLess(abs(r[j] - 60.0), 3.0)
        # 15 km away it is weak
        far = (np.abs(az - 40.0) < 1.0)[:, None] & (np.abs(r - 75.0) < 0.5)[None, :]
        self.assertLess(float(np.nanmax(out[far])), 0.35 * vmax)

    def test_nothing_near_the_radar(self):
        az = (np.arange(720) + 0.5) * 0.5
        r = 0.5 + np.arange(100) * 0.25
        v = np.random.default_rng(1).normal(0, 10, (720, 100)).astype(np.float32)
        out = rdv.vrot_field(v, r, 0.5)
        self.assertTrue(np.isnan(out[:, r < rdv.VROT_MIN_RANGE_KM]).all())


class DebrisScoreTest(unittest.TestCase):
    def score(self, dbz, cc, zdr, nrot, sw):
        a = lambda x: np.array([x], dtype=np.float32)  # noqa: E731
        return float(rdv.ptds_score(a(dbz), a(cc), a(zdr), a(nrot), a(sw))[0])

    def test_debris_scores_a_detection(self):
        self.assertGreater(self.score(52, 0.55, 0.2, 2.0, 12.0), rdv.PTDS_DETECTION)

    def test_hard_rules(self):
        self.assertTrue(math.isnan(self.score(24.0, 0.5, 0.0, 3.0, 12.0)))     # too weak
        self.assertTrue(math.isnan(self.score(55.0, 0.92, 0.0, 3.0, 12.0)))    # meteorological CC
        self.assertTrue(math.isnan(self.score(55.0, float("nan"), 0.0, 3.0, 12.0)))

    def test_rain_hail_and_no_rotation_stay_low(self):
        self.assertLess(self.score(50, 0.98 - 0.07, 1.8, 0.2, 3.0), 60)           # rain, CC 0.91
        self.assertLess(self.score(62, 0.86, -0.2, 1.0, 6.0), rdv.PTDS_SIGNIFICANT)  # hail in a meso
        self.assertLess(self.score(52, 0.55, 0.2, 0.0, 2.0), rdv.PTDS_SIGNIFICANT)   # no vortex, calm

    def test_monotonic_in_each_part(self):
        base = self.score(40, 0.6, 0.5, 0.8, 7.0)
        self.assertGreater(self.score(45, 0.6, 0.5, 0.8, 7.0), base)
        self.assertGreater(self.score(40, 0.6, 0.5, 1.4, 7.0), base)
        self.assertGreater(self.score(40, 0.6, 0.5, 0.8, 9.0), base)
        self.assertLess(self.score(40, 0.88, 0.5, 0.8, 7.0), base)
        self.assertLess(self.score(40, 0.6, 2.5, 0.8, 7.0), base)

    def test_a_lone_gate_is_not_a_signature(self):
        dbz = np.full((40, 60), 45.0, dtype=np.float32)
        cc = np.full((40, 60), 0.98, dtype=np.float32)
        cc[10, 10] = 0.5                     # one gate: a ship, a turbine
        cc[25:31, 30:40] = 0.5               # a patch: lofted debris
        f = rdv.support_factor(rdv.debris_support(dbz, cc))
        self.assertAlmostEqual(float(f[28, 35]), 1.0, places=3)
        self.assertLess(float(f[10, 10]) * 100.0, rdv.PTDS_SIGNIFICANT)

    def test_clutter_and_far_range_fade(self):
        f = rdv.clutter_factor(np.array([np.nan, 0.0, 30.0], dtype=np.float32))
        np.testing.assert_allclose(f, [1.0, 1.0, rdv.PTDS_CFP_FLOOR], atol=1e-6)
        self.assertEqual(rdv.clutter_factor(None), 1.0)
        g = rdv.range_factor(np.array([100.0, 175.0, 250.0]))
        self.assertAlmostEqual(float(g[0]), 1.0)
        self.assertLess(float(g[1]), 1.0)
        self.assertAlmostEqual(float(g[2]), rdv.PTDS_FAR_FLOOR)

    def test_missing_doppler_parts_score_zero(self):
        a = lambda x: np.array([x], dtype=np.float32)  # noqa: E731
        s = float(rdv.ptds_score(a(52), a(0.55), a(0.2), None, None)[0])
        self.assertAlmostEqual(s, rdv.PTDS_W_REF + rdv.PTDS_W_CC + rdv.PTDS_W_ZDR, places=3)


class TrackTest(unittest.TestCase):
    def test_a_shifted_field_gives_its_motion(self):
        rng = np.random.default_rng(3)
        m = 160
        base = np.zeros((m + 40, m + 40), dtype=np.float32)
        for _ in range(25):        # cells of 30-55 dBZ
            cy, cx = rng.integers(20, m + 20, 2)
            yy, xx = np.ogrid[: m + 40, : m + 40]
            base = np.maximum(base, (55 - 25 * rng.random()) * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / 30.0))
        dx, dy = 4, 3              # cells east, north over the interval
        a = base[20:20 + m, 20:20 + m]
        b = base[20 - dy:20 - dy + m, 20 - dx:20 - dx + m]
        got = rdv.track(a, b, 300.0)
        self.assertIsNotNone(got)
        self.assertAlmostEqual(got["u"], dx * 2000.0 / 300.0, delta=1.0)
        self.assertAlmostEqual(got["v"], dy * 2000.0 / 300.0, delta=1.0)

    def test_no_echo_no_motion(self):
        z = np.zeros((160, 160), dtype=np.float32)
        self.assertIsNone(rdv.track(z, z, 300.0))


class PackTest(unittest.TestCase):
    def test_round_trip_and_range_folded_code(self):
        vals = np.array([[-50.0, 0.0, np.nan, 30.0]], dtype=np.float32)
        rf = np.array([[False, False, True, False]])
        codes, lut, rfc, pid, vmin, vmax = rdv.pack(vals, "vel", rf)
        self.assertEqual(rfc, 255)
        self.assertEqual(int(codes[0, 2]), 255)
        back = lut[codes]
        np.testing.assert_allclose(back[0, [0, 1, 3]], vals[0, [0, 1, 3]], atol=(vmax - vmin) / 254)
        self.assertTrue(np.isnan(back[0, 2]))

    def test_regrid_copies_the_nearest_gate(self):
        az_s = (np.arange(360) + 0.5).astype(np.float64)
        r_s = 2.0 + np.arange(100) * 0.25
        vals = np.tile(r_s.astype(np.float32), (360, 1))
        az_d = (np.arange(720) + 0.5) * 0.5
        r_d = 2.125 + np.arange(150) * 0.25
        out = rdv.regrid(vals, az_s, r_s, az_d, r_d)
        self.assertEqual(out.shape, (720, 150))
        np.testing.assert_allclose(out[:, 10], r_s[np.rint((r_d[10] - 2.0) / 0.25).astype(int)])
        self.assertTrue(np.isnan(out[:, -1]).all())          # beyond the source's reach


if __name__ == "__main__":
    unittest.main()
