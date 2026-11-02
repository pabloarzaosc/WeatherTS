"""
radar_detect: storm detections from a radar volume's own base data.

Everything runs on synthetic sweeps -- a Rankine vortex placed in a field of
reflectivity, folded at a chosen Nyquist velocity, with or without a patch of
low correlation (debris) at its centre -- so nothing is downloaded.

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

import radar_detect as rd  # noqa: E402

RLAT, RLON = 35.33, -97.28            # a radar in the northern hemisphere
TILTS = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1]
AZ0, R0 = 40.0, 60.0                  # the vortex: azimuth (deg) and ground range (km)
VMAX, RC = 35.0, 1.5                  # Rankine peak wind (m/s) and core radius (km)
ENV = (8.0, 4.0)                      # the storm's environmental wind, u and v (m/s)


def rankine(d_km: np.ndarray, vmax: float = VMAX, rc: float = RC) -> np.ndarray:
    """Tangential wind of a Rankine vortex at distance d from its axis."""
    d = np.maximum(d_km, 1e-6)
    return np.where(d < rc, vmax * d / rc, vmax * rc / d)


def vortex_sweep(elev: float, *, sense: int = 1, vmax: float = VMAX, nyq: float | None = None,
                 storm_km: float = 18.0, gates: int = 400, rays: int = 720, debris: bool = False,
                 center: tuple[float, float] | None = None, debris_dbz: float = 55.0,
                 debris_cc: float = 0.6) -> rd.Sweep:
    """One sweep through a storm with a vortex in it.

    `sense` +1 turns the vortex anticlockwise seen from above (cyclonic in the
    north), -1 clockwise. `nyq` folds the velocity into +-nyq. `debris` puts
    low correlation, near-zero ZDR and high reflectivity at the vortex's core.
    """
    az = (np.arange(rays, dtype=np.float64) + 0.5) * (360.0 / rays)
    r = 2.125 + 0.25 * np.arange(gates, dtype=np.float64)
    sw = rd.Sweep(elev=elev, az=az, r_km=r.astype(np.float32), nyq=nyq, unix=1_700_000_000.0)
    x, y, _ = rd._gate_xy(sw)
    x = x.astype(np.float64)
    y = y.astype(np.float64)
    if center is None:
        cx, cy = R0 * math.sin(math.radians(AZ0)), R0 * math.cos(math.radians(AZ0))
    else:
        cx, cy = center
    dx, dy = x - cx, y - cy
    d = np.hypot(dx, dy)
    vt = rankine(d, vmax) * sense
    with np.errstate(invalid="ignore", divide="ignore"):
        u = ENV[0] + vt * (-dy / np.maximum(d, 1e-6))
        v = ENV[1] + vt * (dx / np.maximum(d, 1e-6))
    rr = np.hypot(x, y)
    vr = (u * x / rr + v * y / rr) * math.cos(math.radians(elev))
    storm = d <= storm_km
    ref = np.where(storm, 45.0, np.nan)
    vel = np.where(storm, vr, np.nan)
    if nyq:
        vel = np.where(storm, rd._wrap(vel, nyq), np.nan)
    cc = np.where(storm, 0.985, np.nan)
    zdr = np.where(storm, 1.2, np.nan)
    if debris:
        core = d <= 0.9
        ref = np.where(core, debris_dbz, ref)
        cc = np.where(core, debris_cc, cc)
        zdr = np.where(core, 0.1, zdr)
    sw.data = {"REF": ref.astype(np.float32), "VEL": vel.astype(np.float32),
               "RHO": cc.astype(np.float32), "ZDR": zdr.astype(np.float32)}
    return sw


def volume(**kw) -> list[rd.Tilt]:
    out = []
    for e in TILTS:
        sw = vortex_sweep(e, **kw)
        out.append(rd.Tilt(elev=e, vel=sw, pol=sw))
    return out


def vortex_xy() -> tuple[float, float]:
    return R0 * math.sin(math.radians(AZ0)), R0 * math.cos(math.radians(AZ0))


class GeometryTest(unittest.TestCase):
    def test_beam_height_and_ground_range(self):
        # 0.5 deg at 100 km: about 1.45 km above the antenna in the 4/3 earth.
        h = float(rd.beam_height_km(100.0, 0.5))
        self.assertAlmostEqual(h, 1.46, delta=0.05)
        s = float(rd.ground_km(100.0, 0.5))
        self.assertLess(s, 100.0)
        self.assertGreater(s, 99.9)
        # The inverse of ground_km.
        self.assertAlmostEqual(rd._slant_from_ground(s, 0.5), 100.0, delta=0.01)

    def test_xy_lat_lon_round_trip(self):
        la, lo = rd._xy_to_ll(RLAT, RLON, 30.0, -40.0)
        x, y = rd._ll_to_xy(RLAT, RLON, la, lo)
        self.assertAlmostEqual(x, 30.0, delta=0.01)
        self.assertAlmostEqual(y, -40.0, delta=0.01)


class ShearTest(unittest.TestCase):
    def test_shear_peaks_at_the_vortex_with_the_core_value(self):
        sw = vortex_sweep(0.5)
        vf = rd.vel_field(sw, 1)
        i, j = np.unravel_index(int(np.nanargmax(vf.shear)), vf.shear.shape)
        cx, cy = vortex_xy()
        self.assertLess(math.hypot(vf.x[i, j] - cx, vf.y[i, j] - cy), 1.0)
        # Across the core the radial wind changes by Vmax per core radius; the
        # least-squares window spreads it a little.
        want = VMAX / (RC * 1000.0)
        self.assertGreater(vf.shear[i, j], 0.55 * want)
        self.assertLess(vf.shear[i, j], 1.1 * want)
        # Normalised: far past "significant" (1) at 60 km.
        self.assertGreater(vf.nrot[i, j], 2.0)

    def test_anticyclonic_shear_is_negative_in_the_north(self):
        sw = vortex_sweep(0.5, sense=-1)
        vf = rd.vel_field(sw, 1)
        self.assertLess(np.nanmin(vf.shear), -0.5 * VMAX / (RC * 1000.0))
        # Outside the core the shear turns the other way, but weaker.
        self.assertGreater(-np.nanmin(vf.nrot), 1.5 * np.nanmax(vf.nrot))

    def test_rank_steps(self):
        self.assertEqual(rd.rank_2d(5.0), 1)
        self.assertEqual(rd.rank_2d(15.0), 5)
        self.assertEqual(rd.rank_2d(25.0), 9)
        self.assertEqual(rd.strength_label(13), "Intense")
        self.assertEqual(rd.strength_label(3), "Weak")


class UnfoldTest(unittest.TestCase):
    def test_a_folded_vortex_comes_back(self):
        truth = vortex_sweep(0.5, vmax=40.0)
        folded = vortex_sweep(0.5, vmax=40.0, nyq=24.0)
        self.assertGreater(np.nanmax(np.abs(truth.data["VEL"])), 30.0)  # really folds
        out = rd.dealias(folded.data["VEL"], 24.0, r_km=folded.r_km, az=folded.az, dbz=folded.data["REF"])
        ok = np.isfinite(out) & np.isfinite(truth.data["VEL"])
        err = np.abs(out[ok] - truth.data["VEL"][ok])
        self.assertGreater(ok.sum(), 0.95 * np.isfinite(truth.data["VEL"]).sum())
        self.assertGreater(float(np.mean(err < 0.5)), 0.99)

    def test_detection_survives_the_fold(self):
        plain = rd.detect(volume(vmax=40.0), RLAT, RLON)
        folded = rd.detect(volume(vmax=40.0, nyq=24.0), RLAT, RLON)
        self.assertTrue(plain["mesos"] and folded["mesos"])
        self.assertAlmostEqual(folded["mesos"][0]["maxVrotKt"], plain["mesos"][0]["maxVrotKt"], delta=2.0)

    def test_speckle_is_dropped(self):
        rng = np.random.default_rng(3)
        sw = vortex_sweep(0.5, nyq=26.0)
        v = sw.data["VEL"].copy()
        # A patch of pure noise in weak echo beside the storm.
        noise = np.zeros(v.shape, dtype=bool)
        noise[100:160, 300:360] = True
        v[noise] = rng.uniform(-26.0, 26.0, int(noise.sum()))
        dbz = np.where(noise, 5.0, sw.data["REF"])
        out = rd.dealias(v, 26.0, r_km=sw.r_km, az=sw.az, dbz=dbz)
        self.assertLess(float(np.isfinite(out[noise]).mean()), 0.2)

    def test_median3_matches_nanmedian(self):
        rng = np.random.default_rng(1)
        v = rng.normal(size=(20, 30)).astype(np.float32)
        v[rng.random(v.shape) < 0.3] = np.nan
        got = rd._median3(v)
        vs = np.stack([np.roll(v, s, axis=1) for s in (-1, 0, 1)])
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                want = np.nanmedian(vs, axis=0)
        np.testing.assert_allclose(got, want, equal_nan=True, atol=1e-6)


class MesocycloneTest(unittest.TestCase):
    def test_a_rankine_column_is_one_mesocyclone(self):
        res = rd.place(rd.detect(volume(), RLAT, RLON), RLAT, RLON)
        self.assertEqual(len(res["mesos"]), 1)
        m = res["mesos"][0]
        self.assertEqual(m["kind"], "meso")
        self.assertEqual(m["nTilts"], len(TILTS))
        # Sampled at the gates: the peaks sit within a gate of the core radius.
        self.assertGreater(m["maxVrotKt"], 0.8 * VMAX * rd.MS_TO_KT)
        self.assertLess(m["maxVrotKt"], 1.05 * VMAX * rd.MS_TO_KT)
        self.assertAlmostEqual(m["rangeKm"], R0, delta=1.0)
        self.assertAlmostEqual(m["azDeg"], AZ0, delta=1.0)
        # Base on the lowest beam, top on the highest, at 60 km.
        self.assertAlmostEqual(m["baseKm"], float(rd.beam_height_km(R0, 0.5)), delta=0.15)
        self.assertAlmostEqual(m["topKm"], float(rd.beam_height_km(R0, TILTS[-1])), delta=0.15)
        self.assertGreater(m["depthKm"], 3.0)
        self.assertEqual([f["elev"] for f in m["features"]], TILTS)
        # Placed on the map where the vortex is.
        la, lo = rd._xy_to_ll(RLAT, RLON, *vortex_xy())
        self.assertAlmostEqual(m["lat"], la, delta=0.01)
        self.assertAlmostEqual(m["lon"], lo, delta=0.01)
        self.assertFalse(m["tds"])

    def test_a_shallow_column_is_only_a_circulation(self):
        tilts = volume()[:2]
        res = rd.detect(tilts, RLAT, RLON)
        self.assertEqual(len(res["mesos"]), 1)
        self.assertEqual(res["mesos"][0]["kind"], "circulation")

    def test_features_too_far_apart_are_not_joined(self):
        tilts = volume()
        cx, cy = vortex_xy()
        # The upper three tilts carry a vortex 15 km away instead.
        for t in tilts[3:]:
            sw = vortex_sweep(t.elev, center=(cx + 15.0, cy))
            t.vel = t.pol = sw
        res = rd.detect(tilts, RLAT, RLON)
        self.assertEqual(len(res["mesos"]), 2)
        self.assertEqual(sorted(m["nTilts"] for m in res["mesos"]), [3, len(TILTS) - 3])

    def test_anticyclones_count_only_in_the_south(self):
        north = rd.detect(volume(sense=-1), RLAT, RLON)
        self.assertEqual(north["mesos"], [])
        south = rd.detect(volume(sense=-1), -RLAT, RLON)
        self.assertEqual(len(south["mesos"]), 1)

    def test_associate_steps_over_one_empty_tilt(self):
        f = lambda t, x: {"tilt": t, "x": x, "y": 0.0, "nrot": 2.0, "heightKm": 0.5 + t, "vrot": 20.0, "rangeKm": 60.0,  # noqa: E731
                          "vin": -20.0, "vout": 20.0, "shear": 0.01, "diamKm": 2.0, "rank": 7, "elev": t}
        chains = rd.associate([[f(0, 0.0)], [], [f(2, 3.0)], [f(3, 3.5)]])
        self.assertEqual(len(chains), 1)
        self.assertEqual(chains[0]["nTilts"], 3)
        apart = rd.associate([[f(0, 0.0)], [], [], [f(3, 0.0)]])
        self.assertEqual(apart, [])

    def test_couplet_at_the_low_tilts(self):
        res = rd.detect(volume(vmax=40.0), RLAT, RLON)
        self.assertTrue(res["couplets"])
        c = res["couplets"][0]
        self.assertAlmostEqual(c["rangeKm"], R0, delta=2.0)
        # Gate to gate across the core: most of 2 x Vmax.
        self.assertGreater(c["dvKt"], 1.3 * 40.0 * rd.MS_TO_KT)
        self.assertTrue(c["straddles"])
        self.assertEqual(res["mesos"][0]["couplet"], c["rank"])


class DebrisTest(unittest.TestCase):
    def _patch(self, **kw) -> list[dict]:
        return rd.debris_in(vortex_sweep(0.5, debris=True, **kw))

    def test_low_cc_in_strong_echo_is_a_patch(self):
        ps = self._patch()
        self.assertEqual(len(ps), 1)
        p = ps[0]
        self.assertLessEqual(p["minCc"], 0.61)
        self.assertGreaterEqual(p["maxDbz"], 54.0)
        cx, cy = vortex_xy()
        self.assertLess(math.hypot(p["x"] - cx, p["y"] - cy), 0.6)

    def test_weak_echo_or_high_cc_is_not_debris(self):
        self.assertEqual(self._patch(debris_dbz=25.0), [])
        self.assertEqual(self._patch(debris_cc=0.9), [])

    def test_debris_needs_rotation_beside_it(self):
        per = [self._patch()]
        self.assertEqual(rd.merge_debris(per, [], 0.0), [])
        cx, cy = vortex_xy()
        rot = [{"x": cx + 1.0, "y": cy, "dvKt": 120.0}]
        out = rd.merge_debris(per, rot, 0.0)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0]["rotKm"], 1.0, delta=0.6)
        far = [{"x": cx + 10.0, "y": cy, "dvKt": 120.0}]
        self.assertEqual(rd.merge_debris(per, far, 0.0), [])

    def test_patches_join_across_tilts_and_beside_each_other(self):
        a = {"elev": 0.5, "x": 10.0, "y": 10.0, "heightKm": 0.5, "maxDbz": 55.0, "minCc": 0.6, "zdr": 0.2,
             "gates": 5, "areaKm2": 0.3}
        b = dict(a, elev=0.5, x=12.5, gates=4)          # beside it, same tilt
        c = dict(a, elev=0.9, x=11.0, heightKm=1.0)     # above it
        lone = dict(a, elev=0.5, x=40.0, gates=4)       # small and alone on one tilt
        rot = [{"x": 10.5, "y": 10.0, "dvKt": 90.0}, {"x": 40.0, "y": 10.0, "dvKt": 90.0}]
        out = rd.merge_debris([[a, b, lone], [c]], rot, 0.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["tilts"], [0.5, 0.9])
        self.assertEqual(out[0]["gates"], 14)

    def test_detect_marks_the_mesocyclone_with_debris(self):
        res = rd.detect(volume(vmax=40.0, debris=True), RLAT, RLON)
        self.assertTrue(res["dualPol"])
        self.assertEqual(len(res["tds"]), 1)
        t = res["tds"][0]
        self.assertEqual(t["tilts"][0], 0.5)
        self.assertGreaterEqual(len(t["tilts"]), 4)
        self.assertTrue(res["mesos"][0]["tds"])

    def test_no_dual_pol_no_debris(self):
        tilts = volume(vmax=40.0, debris=True)
        for t in tilts:
            t.vel.data.pop("RHO")
            t.vel.data.pop("ZDR")
        res = rd.detect(tilts, RLAT, RLON)
        self.assertFalse(res["dualPol"])
        self.assertEqual(res["tds"], [])
        self.assertTrue(res["mesos"])


class TrackTest(unittest.TestCase):
    def test_link_follows_the_motion(self):
        prev = [{"x": 0.0, "y": 0.0, "rank": 8, "_uv": (20.0, 0.0)},
                {"x": 30.0, "y": 0.0, "rank": 5, "_uv": None}]
        # Five minutes on at 20 m/s east: 6 km.
        cur = [{"x": 6.2, "y": 0.1, "rank": 8}, {"x": 30.5, "y": 0.2, "rank": 4}, {"x": 90.0, "y": 0.0, "rank": 9}]
        links = dict(rd.link_tracks(cur, prev, 300.0))
        self.assertEqual(links[0], 0)
        self.assertEqual(links[1], 1)
        self.assertIsNone(links[2])

    def test_tracks_give_ids_motion_and_a_trail(self):
        site = "ZZZ"
        rd._CACHE.clear()
        first = rd.place(rd.detect(volume(), RLAT, RLON), RLAT, RLON)
        first.update({"key": "k1", "scanUnix": 1000.0})
        rd._apply_tracks(site, first)
        rd._CACHE[(site, "k1")] = first
        cx, cy = vortex_xy()
        moved = []
        for e in TILTS:
            sw = vortex_sweep(e, center=(cx + 3.0, cy + 4.0))   # 5 km in 300 s
            moved.append(rd.Tilt(elev=e, vel=sw, pol=sw))
        second = rd.place(rd.detect(moved, RLAT, RLON), RLAT, RLON)
        second.update({"key": "k2", "scanUnix": 1300.0})
        rd._apply_tracks(site, second)
        m0, m1 = first["mesos"][0], second["mesos"][0]
        self.assertEqual(m1["trackId"], m0["trackId"])
        self.assertAlmostEqual(m1["motion"]["speedKt"], 5000.0 / 300.0 * rd.MS_TO_KT, delta=3.0)
        self.assertAlmostEqual(m1["motion"]["toward"], math.degrees(math.atan2(3.0, 4.0)), delta=8.0)
        self.assertEqual(len(m1["track"]), 1)
        self.assertNotIn("_uv", rd._public(second)["mesos"][0])
        rd._CACHE.clear()

    def test_a_kept_result_links_once_the_volume_before_arrives(self):
        # The viewer asks for a frame first and for the one before it after:
        # the kept frame must come back tracked then, not stay untracked.
        site = "ZZY"
        rd._CACHE.clear()
        cx, cy = vortex_xy()
        moved = []
        for e in TILTS:
            sw = vortex_sweep(e, center=(cx + 3.0, cy + 4.0))
            moved.append(rd.Tilt(elev=e, vel=sw, pol=sw))
        second = rd.place(rd.detect(moved, RLAT, RLON), RLAT, RLON)
        second.update({"key": "k2", "scanUnix": 1300.0})
        rd._apply_tracks(site, second)
        rd._CACHE[(site, "k2")] = second
        self.assertFalse(rd._public(second)["tracked"])
        self.assertNotIn("_prevUnix", rd._public(second))
        first = rd.place(rd.detect(volume(), RLAT, RLON), RLAT, RLON)
        first.update({"key": "k1", "scanUnix": 1000.0})
        rd._apply_tracks(site, first)
        rd._CACHE[(site, "k1")] = first
        rd._relink(site, second)
        pub = rd._public(second)
        self.assertTrue(pub["tracked"])
        self.assertEqual(pub["mesos"][0]["trackId"], first["mesos"][0]["trackId"])
        self.assertEqual(len(pub["mesos"][0]["track"]), 1)
        rd._CACHE.clear()


def _chain(x: float, tilts: range, rank: int = 8) -> list[dict]:
    return [{"tilt": t, "x": x, "y": 0.0, "nrot": 2.0, "heightKm": 0.5 + 0.6 * t, "vrot": 10.0 + rank + t * 0.1,
             "rangeKm": 60.0, "vin": -20.0, "vout": 20.0, "shear": 0.01, "diamKm": 2.0, "rank": rank,
             "elev": 0.5 + t} for t in tilts]


class MergeTest(unittest.TestCase):
    """KTLX 2013-05-20 20:20 (Moore) came out as three columns -- the tornado's
    vortex (0.2-1.4 km), the mesocyclone 3-4 km beside it (0.3-4.8 km) and a
    piece of it aloft -- and KDGX 2023-03-25 01:06 (Rolling Fork) as two."""

    def test_columns_of_one_circulation_merge(self):
        low = _chain(0.0, range(0, 4))          # the tornado's vortex, low down
        beside = _chain(3.2, range(0, 9))       # the mesocyclone beside it
        out = rd.merge_chains([low, beside])
        self.assertEqual(len(out), 1)
        ch, parts = out[0]
        self.assertEqual(parts, 2)
        self.assertEqual([f["tilt"] for f in ch], list(range(0, 9)))
        # Where both had a feature, the stronger stayed.
        self.assertEqual(ch[0]["x"], 3.2 if beside[0]["vrot"] > low[0]["vrot"] else 0.0)

    def test_stacked_pieces_merge(self):
        below, above = _chain(0.0, range(0, 4)), _chain(2.5, range(4, 8))
        out = rd.merge_chains([below, above])
        self.assertEqual(len(out), 1)
        det = rd._detection(out[0][0], 0.0)
        self.assertEqual(det["kind"], "meso")
        self.assertEqual(det["nTilts"], 8)

    def test_separate_or_weak_columns_stay_apart(self):
        self.assertEqual(len(rd.merge_chains([_chain(0.0, range(0, 4)), _chain(6.0, range(0, 4))])), 2)
        weak = _chain(2.0, range(0, 4), rank=3)
        self.assertEqual(len(rd.merge_chains([_chain(0.0, range(0, 4)), weak])), 2)
        # Not on the same or adjacent tilts.
        self.assertEqual(len(rd.merge_chains([_chain(0.0, range(0, 3)), _chain(1.0, range(5, 8))])), 2)

    def test_detect_reports_parts(self):
        res = rd.detect(volume(), RLAT, RLON)
        self.assertEqual(res["mesos"][0]["parts"], 1)


class TvsTest(unittest.TestCase):
    def _c(self, **kw) -> dict:
        c = {"straddles": True, "dvKt": 90.0, "tilts": [0.5, 0.9], "rangeKm": 60.0}
        c.update(kw)
        return c

    def test_classes(self):
        self.assertEqual(rd.tvs_class(self._c(), 0.5), "TVS")
        self.assertEqual(rd.tvs_class(self._c(tilts=[0.9, 1.3]), 0.5), "ETVS")
        self.assertIsNone(rd.tvs_class(self._c(tilts=[0.5]), 0.5))
        self.assertIsNone(rd.tvs_class(self._c(straddles=False), 0.5))
        self.assertIsNone(rd.tvs_class(self._c(dvKt=45.0), 0.5))
        # KDGX 2023-03-25 01:06 had a 75 kt couplet at 186 km: too far to tell.
        self.assertIsNone(rd.tvs_class(self._c(rangeKm=186.0), 0.5))

    def test_detect_marks_the_vortex_a_tvs(self):
        res = rd.detect(volume(vmax=40.0), RLAT, RLON)
        c = res["couplets"][0]
        self.assertEqual(c["tvs"], "TVS")
        self.assertAlmostEqual(c["baseKm"], float(rd.beam_height_km(R0, 0.5)), delta=0.2)


class FarDebrisTest(unittest.TestCase):
    def test_low_cc_high_up_is_not_debris(self):
        # KDGX 2023-03-25 at 196 km and KTLX 2013-05-20 at 166-172 km: patches
        # starting 3-4 km up beside a far couplet.
        p = {"elev": 0.5, "x": 100.0, "y": 100.0, "heightKm": 3.4, "maxDbz": 58.0, "minCc": 0.65, "zdr": 0.3,
             "gates": 12, "areaKm2": 2.0}
        rot = [{"x": 100.5, "y": 100.0, "dvKt": 80.0}]
        self.assertEqual(rd.merge_debris([[p], [dict(p, elev=0.9, heightKm=4.6)]], rot, 0.0), [])
        self.assertEqual(len(rd.merge_debris([[dict(p, heightKm=1.5)]], rot, 0.0)), 1)

    def test_debris_starts_on_the_lowest_tilts(self):
        # KTLX 2013-05-20 20:25: low-CC patches 13-20 km out seen only at
        # 1.8-3.1 deg beside weak shear -- fallout, not a tornado's debris.
        p = {"elev": 2.4, "x": 10.0, "y": 10.0, "heightKm": 0.6, "maxDbz": 46.0, "minCc": 0.52, "zdr": 0.1,
             "gates": 16, "areaKm2": 0.4}
        rot = [{"x": 11.0, "y": 10.0, "dvKt": 48.0}]
        low = [0.5, 0.9]
        self.assertEqual(rd.merge_debris([[p], [dict(p, elev=3.1, heightKm=0.8)]], rot, 0.0, low), [])
        # Starting on the second tilt and lofted through the next one is fine
        # (14 km out, a one-tilt patch would also fail the near-radar rule).
        two = [[dict(p, elev=0.9)], [dict(p, elev=1.3, heightKm=0.8)]]
        self.assertEqual(len(rd.merge_debris(two, rot, 0.0, low)), 1)


class DebrisPlacementTest(unittest.TestCase):
    """KTLX 2013-05-20 19:59: a chain of low-CC patches walked 7.7 km into the
    inflow and the marker went with it, still reporting the TVS 0.58 km away."""

    def _p(self, elev, x, gates=6, dbz=52.0):
        return {"elev": elev, "x": x, "y": 0.0, "heightKm": 0.4 + elev, "maxDbz": dbz, "minCc": 0.3, "zdr": 0.0,
                "gates": gates, "areaKm2": 0.2}

    def test_marker_stays_beside_the_rotation(self):
        core = [self._p(0.5, 0.5, 20), self._p(0.9, 0.3, 14)]
        chain = [self._p(0.5, x, 40) for x in (3.5, 7.0, 10.5)]   # 3.5 km steps, heavier than the core
        rot = [{"x": 0.0, "y": 0.0, "dvKt": 124.0}]
        out = rd.merge_debris([core[:1] + chain, core[1:]], rot, 0.0, [0.5, 0.9])
        self.assertEqual(len(out), 1)
        d = out[0]
        self.assertLessEqual(abs(d["x"]), rd.TDS_ROT_KM)
        self.assertAlmostEqual(d["rotKm"], math.hypot(d["x"], d["y"]), places=2)
        # Nothing further than TDS_GROUP_KM from the seed joined it.
        self.assertEqual(d["gates"], 20 + 14 + 40)

    def test_weak_echo_is_not_debris(self):
        rot = [{"x": 0.0, "y": 0.0, "dvKt": 90.0}]
        weak = [self._p(0.5, 0.5, 12, dbz=40.0), self._p(0.9, 0.5, 12, dbz=41.0)]
        self.assertEqual(rd.merge_debris([weak[:1], weak[1:]], rot, 0.0, [0.5, 0.9]), [])


class QuietDayTest(unittest.TestCase):
    """KAMA 2026-10-26 16:32Z, ordinary showers, no tornado anywhere: the
    lowest tilt's couplets and debris patches as couplets_in / debris_in found
    them (backend/tests/data). It used to give a TDS (11 gates, 0.5 km2, one
    tilt, 20 km out) and an "Intense" 101 kt couplet seen on one tilt with its
    outbound past the Nyquist."""

    @classmethod
    def setUpClass(cls):
        import json
        import os
        with open(os.path.join(os.path.dirname(__file__), "data", "kama_20261026_1632_detect.json")) as fh:
            cls.fx = json.load(fh)

    def _couplets(self):
        return rd.merge_couplets(self.fx["couplets"], self.fx["feedKm"], 0.5)

    def test_no_intense_couplet_and_the_one_tilt_ones_are_doubted(self):
        cs = self._couplets()
        self.assertTrue(cs)
        self.assertFalse([c for c in cs if c["class"] == "Intense"])
        big = max(cs, key=lambda c: c["dvKt"])
        self.assertGreater(big["dvKt"], 95.0)
        self.assertEqual(big["class"], "Unconfirmed")
        self.assertIn("Nyquist", big["suspect"])
        self.assertFalse([c for c in cs if c["tvs"]])
        # Believable ones rank first.
        self.assertFalse(cs[0]["suspect"])

    def test_no_debris_signature(self):
        cs = self._couplets()
        rot = rd.debris_rotation(cs, [])
        self.assertEqual(rot, [])
        self.assertEqual(rd.merge_debris(self.fx["debris"], rot, self.fx["feedKm"], self.fx["polElevs"]), [])
        # Even beside the old, looser rotation (any straddling couplet of
        # 30+ kt) the small one-tilt patches near the radar are not debris.
        loose = [dict(c, kind="couplet") for c in cs if c["dvKt"] >= 30.0 and c["straddles"]]
        self.assertTrue(loose)
        self.assertEqual(rd.merge_debris(self.fx["debris"], loose, self.fx["feedKm"], self.fx["polElevs"]), [])

    def test_one_tilt_doubts(self):
        base = {"tilts": [0.5], "vin": -20.0, "vout": 20.0, "nyq": 26.0, "echoDbz": 45.0}
        self.assertIsNone(rd.couplet_doubt(base))
        self.assertIn("Nyquist", rd.couplet_doubt(dict(base, vout=31.0)))
        self.assertIn("echo", rd.couplet_doubt(dict(base, echoDbz=22.0)))
        # On two tilts the column vouches for an unfolded speed, not for clear air.
        self.assertIsNone(rd.couplet_doubt(dict(base, tilts=[0.5, 0.9], vout=31.0)))
        self.assertIn("echo", rd.couplet_doubt(dict(base, tilts=[0.5, 0.9], echoDbz=12.0)))

    def test_clear_air_two_tilt_couplet_is_no_tvs(self):
        # KTLX 2026-10-26 17:20Z, clear air: a 66 kt couplet on 0.5 + 0.9 deg,
        # 20 km out, 0.4 km up, was drawn as a TVS.
        import json
        import os
        with open(os.path.join(os.path.dirname(__file__), "data", "ktlx_20261026_1720_detect.json")) as fh:
            fx = json.load(fh)
        cs = rd.merge_couplets(fx["couplets"], fx["feedKm"], 0.5)
        big = max(cs, key=lambda c: c["dvKt"])
        self.assertGreater(big["dvKt"], 60.0)
        self.assertEqual(len(big["tilts"]), 2)
        self.assertIsNone(big["tvs"])
        self.assertEqual(big["class"], "Unconfirmed")
        self.assertFalse([c for c in cs if c["tvs"]])


if __name__ == "__main__":
    unittest.main()
