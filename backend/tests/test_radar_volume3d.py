"""
radar_volume3d: the box of voxels the 3D view ray-marches.

The geometry (the box's projection, the 4/3-earth beam), which beam each voxel
takes, the cone of silence, filling it from a neighbour, the lightning's echo
tops and the wire format -- all on synthetic sweeps, so nothing is downloaded.

Run from the repository root:
    backend/.venv/Scripts/python.exe -m unittest discover -s backend/tests -v
"""
from __future__ import annotations

import json
import math
import struct
import sys
import unittest
from pathlib import Path
from unittest import mock

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import numpy as np  # noqa: E402

import radar_volume3d as v3  # noqa: E402

RLAT, RLON = 35.33, -97.28
# The angles VCP 212 flies.
VCP212 = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5]


def sweep(elev: float, value, gates: int = 1200, width: float = 0.25, rays: int = 360) -> dict:
    """A sweep whose every gate is `value` -- or value(azimuth) when callable."""
    az = (np.arange(rays, dtype=np.float32) + 0.5) * (360.0 / rays)
    if callable(value):
        vals = np.repeat(np.asarray([value(a) for a in az], dtype=np.float32)[:, None], gates, axis=1)
    else:
        vals = np.full((rays, gates), value, dtype=np.float32)
    return {"elev": elev, "az": az, "first": 0.0, "width": width, "vals": vals.astype(np.float16)}


def stack(elevs, value=None, lat=RLAT, lon=RLON, height=0.4, ground=0.38, **kw) -> dict:
    sws = [sweep(e, (value if value is not None else e * 10.0), **kw) for e in elevs]
    return {"sweeps": sws, "lat": lat, "lon": lon, "heightKm": height, "groundKm": ground,
            "stamp": "20130520-200000", "vcp": 212}


def code_of(v: float, vmin: float = -20.0, vmax: float = 75.0) -> int:
    return int(v3.quantize(np.array([v], np.float32), vmin, vmax)[0])


class Geometry(unittest.TestCase):
    def test_box_projection_round_trip(self):
        lat, lon = v3.grid_lonlat(RLAT, RLON, 160.0, 64)
        x, y = v3.to_grid_km(RLAT, RLON, lat, lon)
        axis = v3.grid_axis(160.0, 64)
        gx, gy = np.meshgrid(axis, axis)
        self.assertLess(float(np.abs(x - gx).max()), 1e-6)
        self.assertLess(float(np.abs(y - gy).max()), 1e-6)

    def test_box_rows_run_south_to_north_columns_west_to_east(self):
        lat, lon = v3.grid_lonlat(RLAT, RLON, 100.0, 32)
        self.assertLess(lat[0, 16], RLAT)
        self.assertGreater(lat[-1, 16], RLAT)
        self.assertLess(lon[16, 0], RLON)
        self.assertGreater(lon[16, -1], RLON)
        # 100 km north is about 0.9 deg of latitude.
        self.assertAlmostEqual(float(lat[-1, 16] - RLAT), 100.0 * (31.5 / 16 - 1) / 111.2, delta=0.005)

    def test_beam_height_and_elevation_agree(self):
        for s in (5.0, 40.0, 120.0, 230.0):
            for e in (0.5, 3.1, 19.5):
                z = float(v3.beam_height_km(s, e, 0.4))
                back = float(v3.elevation_deg(s, z, 0.4))
                self.assertAlmostEqual(back, e, delta=2e-3, msg=f"s={s} e={e}")

    def test_beam_height_matches_the_four_thirds_rule(self):
        # h = sqrt(r^2 + Re'^2 + 2 r Re' sin e) - Re' at the slant range the
        # beam reaches the vertical at s: the WSR-88D 0.5 deg beam is ~3.0 km
        # up 150 km out (radar at sea level).
        z = float(v3.beam_height_km(150.0, 0.5, 0.0))
        self.assertAlmostEqual(z, 150 * math.tan(math.radians(0.5)) + 150 ** 2 / (2 * v3.RE_EFF_KM), delta=0.05)

    def test_beam_range_is_slant_range(self):
        r = float(v3.beam_range_km(100.0, 2.4, 0.3))
        ra = v3.RE_EFF_KM + 0.3
        e = math.radians(2.4)
        # The point at slant range r is at ground distance s = Re' * asin(r cos e / (Re' + h)).
        h = math.sqrt(r * r + ra * ra + 2 * r * ra * math.sin(e)) - v3.RE_EFF_KM
        s = v3.RE_EFF_KM * math.asin(r * math.cos(e) / (v3.RE_EFF_KM + h))
        self.assertAlmostEqual(s, 100.0, delta=1e-6)


class Resampling(unittest.TestCase):
    ELEVS = [0.5, 1.5, 2.5, 3.5, 4.5, 6.5, 9.5]

    def box(self, st, kind="ref", half=60.0, n=48, nz=40, top=20.0, vmin=-20.0, vmax=75.0):
        lat, lon = v3.grid_lonlat(st["lat"], st["lon"], half, n)
        levels = (np.arange(nz, dtype=np.float32) + 0.5) * (top / nz)
        codes, info = v3.resample(st, lat, lon, levels, kind, vmin, vmax)
        return codes, info, lat, lon, levels

    def voxel(self, codes, levels, half, s_east_km, z_agl_km):
        nz, ny, nx = codes.shape
        i = int((s_east_km + half) / (2 * half) * nx)
        j = ny // 2
        k = int(np.argmin(np.abs(levels - z_agl_km)))
        return int(codes[k, j, i]), float(levels[k])

    def test_shape_and_the_beam_each_voxel_sits_in(self):
        st = stack(self.ELEVS)
        codes, info, lat, lon, levels = self.box(st, nz=200, top=12.0)
        self.assertEqual(codes.shape, (200, 48, 48))
        self.assertEqual(info["elevations"], self.ELEVS)
        half = 60.0
        # A voxel near each beam's centre carries that tilt's value.
        for e in (1.5, 3.5, 6.5):
            s = 40.0
            z = float(v3.beam_height_km(s, e, st["heightKm"])) - st["groundKm"]
            code, zk = self.voxel(codes, levels, half, s, z)
            # The voxel the grid has nearest that point, and the column it is in.
            nz, ny, nx = codes.shape
            i = int((s + half) / (2 * half) * nx)
            sx = float(v3.grid_axis(half, nx)[i])
            th = float(v3.elevation_deg(abs(sx), zk + st["groundKm"], st["heightKm"]))
            self.assertLess(abs(th - e), v3.HALF_BEAM, msg=f"e={e} th={th}")
            self.assertEqual(code, code_of(e * 10.0), msg=f"e={e}")

    def test_gaps_blend_smooth_moments_and_take_the_nearer_beam_for_velocity(self):
        # Two beams 3 deg apart: the voxel midway is the mean for reflectivity,
        # one of the two for velocity.
        st = stack([1.0, 4.0], value=None)
        st["sweeps"][0]["vals"][:] = 10.0
        st["sweeps"][1]["vals"][:] = 40.0
        s = np.array([50.0], np.float32)
        az = np.array([90.0], np.float32)
        fields, elevs, _ = v3.beam_fields(st, s, az)
        theta = np.array([2.5], np.float32)
        cols = np.array([0])
        self.assertAlmostEqual(float(v3.pick(elevs, fields, theta, cols, "ref")[0]), 25.0, places=3)
        self.assertIn(float(v3.pick(elevs, fields, np.array([2.4], np.float32), cols, "vel")[0]), (10.0,))
        self.assertIn(float(v3.pick(elevs, fields, np.array([2.6], np.float32), cols, "vel")[0]), (40.0,))

    def test_storm_look_slopes_echo_edges_across_a_gap(self):
        # Echo on the 1 deg tilt, nothing on the 4 deg one: the beams' look
        # steps at the upper beam's edge; the storm look fades toward nothing,
        # so a strong echo reaches higher into the gap than a weak one.
        st = stack([1.0, 4.0], value=None)
        st["sweeps"][1]["vals"][:] = np.nan
        s = np.array([50.0], np.float32)
        az = np.array([90.0], np.float32)
        cols = np.array([0])
        thetas = np.linspace(1.0, 4.0, 61).astype(np.float32)

        def top(v: float) -> float:
            st["sweeps"][0]["vals"][:] = v
            fields, elevs, _ = v3.beam_fields(st, s, az)
            vals = v3.pick_smooth(elevs, fields, thetas, np.repeat(cols, thetas.size), "ref")
            seen = thetas[np.isfinite(vals) & (vals >= 12.0)]
            return float(seen.max())

        self.assertGreater(top(55.0), top(25.0) + 0.5)
        self.assertLess(top(55.0), 4.0 - v3.HALF_BEAM)
        st["sweeps"][0]["vals"][:] = 40.0
        fields, elevs, _ = v3.beam_fields(st, s, az)
        sm = v3.pick_smooth(elevs, fields, thetas, np.repeat(cols, thetas.size), "ref")
        # Strictly falling from the tilt with echo toward the one without.
        fin = sm[np.isfinite(sm)]
        self.assertTrue(np.all(np.diff(fin) < 0))
        # Both tilts with echo: a straight line between their centres.
        st["sweeps"][1]["vals"][:] = 10.0
        fields, elevs, _ = v3.beam_fields(st, s, az)
        mid = v3.pick_smooth(elevs, fields, np.array([1.3, 2.5], np.float32), np.array([0, 0]), "ref")
        self.assertAlmostEqual(float(mid[0]), 37.0, places=3)
        self.assertAlmostEqual(float(mid[1]), 25.0, places=3)
        # Velocity has no "nothing" value: unchanged.
        self.assertEqual(float(v3.pick_smooth(elevs, fields, np.array([2.4], np.float32), np.array([0]), "vel")[0]),
                         float(v3.pick(elevs, fields, np.array([2.4], np.float32), np.array([0]), "vel")[0]))

    def test_storm_look_top_fade_is_a_few_levels_tall_near_the_radar(self):
        # 8 km out, 1.5 deg over the top tilt is ~0.2 km: under one 0.25 km
        # level, so each level showed as a ring. The fade per column is at
        # least _TOP_FADE_KM tall (resample passes it as `top_fade`).
        st = stack([0.5, 19.5], value=40.0)
        s = np.array([8.0], np.float32)
        fields, elevs, _ = v3.beam_fields(st, s, np.array([0.0], np.float32))
        thetas = np.array([19.5, 21.0, 22.5, 24.0], np.float32)
        cols = np.zeros(thetas.size, np.int64)
        plain = v3.pick_smooth(elevs, fields, thetas, cols, "ref")
        self.assertTrue(np.isnan(plain[2]) and np.isnan(plain[3]))
        tf = np.degrees(np.arctan2(v3._TOP_FADE_KM, 8.0))
        wide = v3.pick_smooth(elevs, fields, thetas, cols, "ref", top_fade=np.full(thetas.size, tf, np.float32))
        self.assertTrue(np.all(np.isfinite(wide[:3])))
        self.assertTrue(np.all(np.diff(wide[np.isfinite(wide)]) < 0))
        self.assertGreater(float(wide[2]), 12.0)

    def test_a_gap_too_wide_stays_empty(self):
        st = stack([0.5, 1.5, 7.5])
        s = np.array([30.0], np.float32)
        fields, elevs, _ = v3.beam_fields(st, s, np.array([0.0], np.float32))
        mid = v3.pick(elevs, fields, np.array([4.5], np.float32), np.array([0]), "ref")
        self.assertTrue(np.isnan(mid[0]))

    def test_cone_of_silence_above_the_top_tilt_and_nothing_below_the_lowest(self):
        st = stack(self.ELEVS)
        codes, info, lat, lon, levels = self.box(st, nz=80)
        self.assertEqual(info["topElev"], 9.5)
        nz, ny, nx = codes.shape
        # Straight over the radar, every level above the beams is the cone.
        mid = nx // 2
        column = codes[:, mid, mid]
        self.assertTrue(np.all(column[levels > 3.0] == v3.CONE))
        # Far out, low down: under the 0.5 deg beam's bottom edge, empty air.
        s = float(v3.grid_axis(60.0, nx)[-1])
        under = float(v3.beam_height_km(s, 0.5 - v3.HALF_BEAM - 0.1, st["heightKm"])) - st["groundKm"]
        ks = np.nonzero(levels < under)[0]
        self.assertTrue(len(ks) > 0)
        self.assertTrue(np.all(codes[ks, mid, -1] == 0))
        # The cone is only where the angle is past the top tilt. The middle row
        # passes half a cell south of the radar, so a column's distance from it
        # is hypot(x, y) -- the box is equidistant about its centre.
        ax = v3.grid_axis(60.0, nx)
        s_row = np.hypot(ax, ax[mid]).astype(np.float32)
        th = v3.elevation_deg(s_row[None, :], (levels + st["groundKm"])[:, None], st["heightKm"])
        row = codes[:, mid, :]
        self.assertTrue(np.all((row == v3.CONE) == (th > 9.5 + v3.HALF_BEAM)))

    def test_azimuth_follows_compass_bearings(self):
        # Value = azimuth / 10: a column east of the radar reads 9, west 27.
        st = stack([0.5, 1.5, 2.5], value=lambda a: a / 10.0)
        codes, info, lat, lon, levels = self.box(st, n=49, vmin=0.0, vmax=40.0)
        nz, ny, nx = codes.shape
        k = int(np.argmin(np.abs(levels - 1.0)))
        east, west = int(codes[k, ny // 2, nx - 3]), int(codes[k, ny // 2, 2])
        south = int(codes[k, 2, nx // 2])
        self.assertAlmostEqual(east, code_of(9.0, 0.0, 40.0), delta=1)
        self.assertAlmostEqual(west, code_of(27.0, 0.0, 40.0), delta=1)
        self.assertAlmostEqual(south, code_of(18.0, 0.0, 40.0), delta=1)

    def test_past_the_last_gate_is_empty(self):
        st = stack([0.5, 1.5], gates=200, width=0.25)  # 50 km of range
        codes, info, lat, lon, levels = self.box(st, half=100.0, n=40)
        k = int(np.argmin(np.abs(levels - 1.0)))
        self.assertEqual(int(codes[k, 20, 39]), 0)   # ~97 km east: beyond reach
        self.assertNotEqual(int(codes[k, 20, 26]), 0)   # ~32 km: seen

    def test_storm_relative_motion_is_taken_out(self):
        st = stack([0.5, 1.5], value=20.0)
        s = np.array([30.0, 30.0], np.float32)
        az = np.array([90.0, 270.0], np.float32)
        fields, _, _ = v3.beam_fields(st, s, az, motion=(10.0, 90.0))
        self.assertAlmostEqual(float(fields[0, 0]), 10.0, places=2)
        self.assertAlmostEqual(float(fields[0, 1]), 30.0, places=2)


class ConeFill(unittest.TestCase):
    def test_neighbour_fills_only_the_cone(self):
        main = stack([0.5, 1.5, 2.5], value=20.0)
        lat, lon = v3.grid_lonlat(RLAT, RLON, 60.0, 40)
        levels = (np.arange(40, dtype=np.float32) + 0.5) * 0.5
        codes, _ = v3.resample(main, lat, lon, levels, "ref", -20.0, 75.0)
        before = codes.copy()
        cone = before == v3.CONE
        self.assertGreater(int(cone.sum()), 0)
        # A neighbour 120 km east seeing 45 dBZ everywhere, tilts to 19.5.
        nlat, nlon = RLAT, RLON + 120.0 / (111.2 * math.cos(math.radians(RLAT)))
        nb = stack(VCP212, value=45.0, lat=nlat, lon=nlon,
                   gates=1840, width=0.25)
        filled = v3.fill_cone(codes, nb, lat, lon, levels, main["groundKm"], "ref", -20.0, 75.0)
        self.assertGreater(filled, 0)
        # Outside the cone nothing moved.
        self.assertTrue(np.array_equal(codes[~cone], before[~cone]))
        # Inside, the neighbour's value where it sees, and 255 left where it
        # does not (low over the main radar, under the neighbour's lowest beam).
        got = codes[cone]
        self.assertTrue(set(np.unique(got)).issubset({v3.CONE, code_of(45.0)}))
        self.assertGreater(int((got == code_of(45.0)).sum()), int(0.5 * cone.sum()))
        self.assertGreater(int((got == v3.CONE).sum()), 0)

    def test_seen_but_empty_becomes_air(self):
        main = stack([0.5, 1.5], value=20.0)
        lat, lon = v3.grid_lonlat(RLAT, RLON, 30.0, 20)
        levels = (np.arange(20, dtype=np.float32) + 0.5) * 1.0
        codes, _ = v3.resample(main, lat, lon, levels, "ref", -20.0, 75.0)
        nlat = RLAT + 100.0 / 111.2
        nb = stack(VCP212, value=np.nan, lat=nlat, lon=RLON, gates=1840)
        v3.fill_cone(codes, nb, lat, lon, levels, main["groundKm"], "ref", -20.0, 75.0)
        high = codes[levels > 6.0]
        self.assertTrue(np.all(high == 0))


class Lightning(unittest.TestCase):
    def test_buckets_follow_the_goes_eras(self):
        self.assertEqual(v3.glm_buckets(1369080000), (None, None))   # 2013: no GLM
        self.assertEqual(v3.glm_buckets(1621540800), ("gcp-public-data-goes-16", "gcp-public-data-goes-17"))
        self.assertEqual(v3.glm_buckets(1700000000), ("gcp-public-data-goes-16", "gcp-public-data-goes-18"))
        self.assertEqual(v3.glm_buckets(1770532800), ("gcp-public-data-goes-19", "gcp-public-data-goes-18"))

    def test_only_the_goes_that_sees_the_box(self):
        now = 1770532800
        sides = lambda box: [s for s, _ in v3.glm_sides(now, box)]  # noqa: E731
        self.assertEqual(sides((-98.2, 34.8, -96.8, 35.9)), ["east"])          # Oklahoma
        self.assertEqual(sides((-111.3, 31.3, -109.9, 32.4)), ["west"])        # Tucson
        self.assertEqual(sides((-108.0, 30.0, -104.0, 33.0)), ["east", "west"])  # across the split
        self.assertEqual(sides((-157.0, 19.0, -154.0, 21.0)), ["west"])        # Hawaii
        self.assertEqual(sides((-36.4, -10.1, -35.1, -9.0)), ["east"])         # Maceio
        self.assertEqual(sides((143.5, 12.5, 146.5, 15.5)), [])                # Guam: neither
        self.assertEqual(v3.glm_sides(1369080000, (-98.2, 34.8, -96.8, 35.9)), [])  # 2013
        _, info = v3.flashes_in(now, now + 60, (143.5, 12.5, 146.5, 15.5), 0.0)
        self.assertFalse(info["available"])
        self.assertIn("sees this area", info["reason"])

    def test_flash_hangs_from_the_echo_top_over_it(self):
        nz, n, half = 20, 20, 50.0
        codes = np.zeros((nz, n, n), np.uint8)
        levels = (np.arange(nz, dtype=np.float32) + 0.5) * 1.0
        codes[:12, 10, 10] = code_of(40.0)   # a core to 12 km over the centre
        codes[12:, 10, 10] = code_of(5.0)    # weaker above: not the top
        arr = np.zeros(3, v3.glm.FLASH)
        arr["lat"] = [RLAT + 0.02, RLAT, RLAT + 5.0]
        arr["lon"] = [RLON + 0.02, RLON - 0.4, RLON]
        arr["t"] = [100.0, 130.0, 160.0]
        arr["energy"] = [10.0, 20.0, 30.0]
        rows = v3.flash_rows(arr, codes, RLAT, RLON, half, levels, -20.0, 75.0, 50.0)
        self.assertEqual(rows.shape, (2, 5))   # the third is off the box
        self.assertAlmostEqual(float(rows[0, 4]), 12.0, delta=0.6)
        self.assertEqual(float(rows[1, 4]), 0.0)   # no echo there
        self.assertAlmostEqual(float(rows[0, 2]), 50.0)
        self.assertLess(float(rows[1, 0]), -30.0)


class Build(unittest.TestCase):
    def handle(self, st, key="L2:1:20130520-200000"):
        vol = {"st": st, "key": key, "unix": 1369080000, "label": "Super-Res Reflectivity", "units": "dBZ",
               "kind": "ref", "site": "KTLX", "vcp": 212, "motion": None}
        return {"key": key, "unix": 1369080000, "lat": st["lat"], "lon": st["lon"], "load": lambda: vol}

    def setUp(self):
        v3._CACHE.clear()

    def test_meta_cache_and_fill(self):
        st = stack([0.5, 1.5, 2.5, 3.5])
        nlat = RLAT + 1.2
        nb = stack(VCP212, value=30.0, lat=nlat, lon=RLON, gates=1840)
        calls = []

        def nb_loader(site, lat, lon, unix, fam):
            calls.append((site, unix, fam))
            return {"st": nb, "site": "KVNX", "unix": unix + 60, "key": "L2:2:x", "km": 133.0}

        h = self.handle(st)
        out = v3.build("TLX", fam="B", fill="neighbor", half_km=80.0, n=32, nz=24, top_km=18.0, handle=h,
                       neighbour_loader=nb_loader)
        m = out["meta"]
        self.assertEqual(out["codes"].shape, (24, 32, 32))
        self.assertEqual((m["nx"], m["ny"], m["nz"]), (32, 32, 24))
        self.assertEqual(m["elevations"], [0.5, 1.5, 2.5, 3.5])
        self.assertEqual(m["fill"]["status"], "filled")
        self.assertEqual(m["fill"]["site"], "KVNX")
        self.assertLess(m["cone"]["left"], m["cone"]["voxels"])
        self.assertAlmostEqual(m["radarXKm"], 0.0, places=6)
        self.assertEqual(len(m["lut"]), 256)
        self.assertIsNone(m["lut"][0])
        self.assertIsNone(m["lut"][255])
        self.assertAlmostEqual(m["lut"][1], m["vmin"])
        self.assertAlmostEqual(m["lut"][254], m["vmax"])
        self.assertEqual(calls, [("TLX", 1369080000, "B")])
        again = v3.build("TLX", fam="B", fill="neighbor", half_km=80.0, n=32, nz=24, top_km=18.0, handle=h,
                         neighbour_loader=nb_loader)
        self.assertIs(again, out)
        self.assertEqual(len(calls), 1)

    def test_velocity_is_never_filled_from_another_radar(self):
        st = stack([0.5, 1.5])
        h = self.handle(st, key="L2:3:v")
        h["load"]()["kind"] = "vel"
        out = v3.build("TLX", fam="G", fill="neighbor", half_km=40.0, n=16, nz=8, handle=h,
                       neighbour_loader=lambda *a: self.fail("asked a neighbour for velocity"))
        self.assertEqual(out["meta"]["fill"]["status"], "off")

    def test_wire_format(self):
        st = stack([0.5, 1.5, 2.5])
        h = self.handle(st, key="L2:4:w")
        with mock.patch.object(v3, "resolve", return_value=h):
            payload = v3.volume3d("TLX", fam="B", half_km=50.0, n=24, nz=12, lightning=False)
            only = v3.volume3d("TLX", fam="B", half_km=50.0, n=24, nz=12, lightning=False, part="glm")
        n = struct.unpack("<I", payload[:4])[0]
        meta = json.loads(payload[4:4 + n])
        self.assertEqual(meta["volumeBytes"], 24 * 24 * 12)
        self.assertEqual(len(payload), 4 + n + meta["volumeBytes"] + meta["flashCount"] * 20)
        codes = np.frombuffer(payload, np.uint8, meta["volumeBytes"], 4 + n).reshape(12, 24, 24)
        self.assertTrue(np.array_equal(codes, v3._CACHE[next(reversed(v3._CACHE))]["codes"]))
        n2 = struct.unpack("<I", only[:4])[0]
        self.assertEqual(json.loads(only[4:4 + n2])["volumeBytes"], 0)
        self.assertEqual(v3.gzip.decompress(v3.gz(payload)), payload)


class Boxes(unittest.TestCase):
    """A box drawn on the map: its grid, and the boxes the view refuses."""

    def test_storm_box_gets_half_km_cells_and_quarter_km_levels(self):
        # ~60 x 40 km over Moore, the radar ~25 km east of it.
        b = v3.box_spec((-97.83, 35.15, -97.17, 35.51), RLAT, RLON, "ref", "KTLX")
        self.assertAlmostEqual(b["cellKm"], 0.5)
        self.assertEqual(b["nz"], 80)
        self.assertAlmostEqual(b["top_km"] / b["nz"], 0.25)
        self.assertAlmostEqual(2 * b["half_km"] / b["n"], 0.5, delta=0.02)
        self.assertAlmostEqual(2 * b["half_y_km"] / b["ny"], 0.5, delta=0.02)
        self.assertGreater(b["n"], b["ny"])   # wider than tall
        self.assertEqual(b["nearestKm"], 0.0)  # the radar is inside it

    def test_wide_box_coarsens_to_320_cells(self):
        b = v3.box_spec((-99.4, 33.6, -95.1, 37.1), RLAT, RLON, "ref", "KTLX")
        self.assertLessEqual(max(b["n"], b["ny"]), v3.BOX_MAX_CELLS)
        self.assertGreater(b["cellKm"], 1.0)
        self.assertLess(b["n"] * b["ny"] * b["nz"], 9_000_000)

    def test_out_of_range_too_big_and_too_small(self):
        far = (-90.6, 35.0, -90.0, 35.4)   # ~600 km east of KTLX
        with self.assertRaises(v3.BoxError) as e:
            v3.box_spec(far, RLAT, RLON, "ref", "KTLX", "Reflectivity")
        self.assertIn("out of KTLX's range", str(e.exception))
        # 350 km out is inside reflectivity's 460 km, outside velocity's 300.
        mid = (-93.4, 35.0, -93.0, 35.4)
        v3.box_spec(mid, RLAT, RLON, "ref", "KTLX")
        with self.assertRaises(v3.BoxError):
            v3.box_spec(mid, RLAT, RLON, "vel", "KTLX")
        with self.assertRaises(v3.BoxError):
            v3.box_spec((-102.0, 32.0, -92.0, 38.0), RLAT, RLON, "ref", "KTLX")
        with self.assertRaises(v3.BoxError):
            v3.box_spec((-97.3, 35.3, -97.29, 35.31), RLAT, RLON, "ref", "KTLX")

    def test_rectangular_grid_round_trip(self):
        lat, lon = v3.grid_lonlat(RLAT, RLON, 80.0, 40, 30.0, 12)
        self.assertEqual(lat.shape, (12, 40))
        x, y = v3.to_grid_km(RLAT, RLON, lat, lon)
        self.assertLess(float(np.abs(x[0] - v3.grid_axis(80.0, 40)).max()), 1e-6)
        self.assertLess(float(np.abs(y[:, 0] - v3.grid_axis(30.0, 12)).max()), 1e-6)

    def test_build_on_a_rectangle(self):
        v3._CACHE.clear()
        st = stack([0.5, 1.5, 2.5])
        vol = {"st": st, "key": "L2:9:r", "unix": 1369080000, "label": "R", "units": "dBZ", "kind": "ref",
               "site": "KTLX", "vcp": 212, "motion": None}
        h = {"key": "L2:9:r", "unix": 1369080000, "lat": RLAT, "lon": RLON, "load": lambda: vol}
        out = v3.build("TLX", fam="B", center=(RLAT + 0.2, RLON), half_km=30.0, n=60, half_y_km=10.0, ny=20,
                       nz=16, handle=h)
        self.assertEqual(out["codes"].shape, (16, 20, 60))
        m = out["meta"]
        self.assertEqual((m["nx"], m["ny"], m["halfXKm"], m["halfYKm"]), (60, 20, 30.0, 10.0))
        self.assertAlmostEqual(m["radarYKm"], -0.2 * 111.2, delta=0.5)


class Kdp(unittest.TestCase):
    def test_a_steady_phase_rise_reads_as_its_kdp(self):
        # PhiDP rising 2 deg/km (KDP 1 deg/km) over 100 km of 0.25 km gates.
        gates = 400
        r = (np.arange(gates) + 0.5) * 0.25
        phi = np.repeat((60.0 + 2.0 * r)[None, :], 4, axis=0).astype(np.float32)
        k = v3.kdp_from_phi(phi, 0.25)
        mid = k[:, 50:350]
        self.assertTrue(np.all(np.isfinite(mid)))
        self.assertAlmostEqual(float(np.nanmean(mid)), 1.0, places=3)

    def test_noisy_or_missing_phase_reads_as_nothing(self):
        rng = np.random.default_rng(3)
        phi = (rng.uniform(0, 360, (3, 300))).astype(np.float32)
        self.assertTrue(np.all(np.isnan(v3.kdp_from_phi(phi, 0.25))))
        gappy = np.full((2, 300), np.nan, np.float32)
        gappy[:, ::4] = 80.0
        self.assertTrue(np.all(np.isnan(v3.kdp_from_phi(gappy, 0.25))))


class UnderBeamFill(unittest.TestCase):
    def test_a_nearer_radar_fills_under_the_lowest_beam(self):
        v3._CACHE.clear()
        main = stack([0.5, 1.5, 2.5, 3.5], value=20.0, gates=1840)
        vol = {"st": main, "key": "L2:5:u", "unix": 1369080000, "label": "R", "units": "dBZ", "kind": "ref",
               "site": "KTLX", "vcp": 212, "motion": None}
        h = {"key": "L2:5:u", "unix": 1369080000, "lat": RLAT, "lon": RLON, "load": lambda: vol}
        # A box 200 km north, where the 0.5 deg beam is ~3 km up; a radar
        # under the box sees down to its ground.
        clat = RLAT + 200.0 / 111.2
        nb = stack(VCP212, value=45.0, lat=clat, lon=RLON, gates=1840)
        out = v3.build("TLX", fam="B", fill="neighbor", center=(clat, RLON), half_km=20.0, n=20, nz=40,
                       top_km=10.0, handle=h,
                       neighbour_loader=lambda *a: {"st": nb, "site": "KVNX", "unix": 1369080000, "key": "k",
                                                    "km": 5.0})
        codes = out["codes"]
        fill = out["meta"]["fill"]
        self.assertEqual(fill["status"], "filled")
        self.assertGreater(fill["underVoxels"], 0)
        # Low levels away from the neighbour's own cone carry its 45 dBZ now.
        low = codes[1, :, 2]
        self.assertTrue(np.any(low == code_of(45.0)))
        # Under-beam air the neighbour did not reach goes back to empty, not
        # to the cone: this box is 200 km from the radar's own cone.
        self.assertFalse(np.any(codes == v3.CONE))


if __name__ == "__main__":
    unittest.main()
