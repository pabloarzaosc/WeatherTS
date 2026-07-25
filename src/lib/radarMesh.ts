import type maplibregl from "maplibre-gl";

import { buildLut, lookup, parsePal } from "./pal";

// Turns a polar radar scan into a coloured triangle mesh for a MapLibre custom
// layer. Technique adapted from SparkRadar (c) Tyler G (@tgranz), used with
// permission: one quad per gate, colour baked into the vertex on the CPU, drawn
// with a pass-through shader. Recolouring on a palette change only rewrites the
// colour bytes -- the positions are untouched.

export interface PolarScan {
  az: Float32Array; // nAz + 1 edges, degrees from north
  lut: Float32Array; // 256 entries: code -> physical value (NaN = no data)
  codes: Uint8Array; // nAz * nGates native 8-bit gate codes
  meta: {
    site: string;
    siteLat: number;
    siteLon: number;
    product: string;
    productLabel: string;
    units: string;
    kind: string;
    family: string | null;
    tilt: string | null;
    elevation: number | null; // the cut this scan was actually taken at
    defaultPalette: string;
    vmin: number;
    vmax: number;
    nAz: number;
    nGates: number;
    rangeStartKm: number;
    gateWidthKm: number;
    maxRangeKm: number;
    validUnix: number | null;
    scanUnix: number | null;
    key: string;
    vcp?: number | null;
    mode?: string;
  };
}

/** Decode the backend's [len][json][az f32][lut f32 x256][codes u8] payload. */
export function decodeScan(buf: ArrayBuffer): PolarScan {
  const dv = new DataView(buf);
  const hlen = dv.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
  const azOff = 4 + hlen;
  const azBytes = (meta.nAz + 1) * 4;
  const az = new Float32Array(buf.slice(azOff, azOff + azBytes));
  const lutOff = azOff + azBytes;
  const lut = new Float32Array(buf.slice(lutOff, lutOff + 256 * 4));
  const codesOff = lutOff + 256 * 4;
  const codes = new Uint8Array(buf.slice(codesOff, codesOff + meta.nAz * meta.nGates));
  return { az, lut, codes, meta };
}

export interface RadarMesh {
  positions: Float32Array; // x,y mercator per vertex
  colors: Uint8Array; // r,g,b,a per vertex
  values: Float32Array; // physical value per vertex (kept so we can recolour)
  lut: Float32Array; // the scan's code -> value table
  vertexCount: number;
}

const KM_PER_DEG_LAT = 111.32;

/**
 * Build the mesh. Gates with no data are skipped entirely, which is what keeps
 * this tractable: a typical scan is ~15% covered, so ~200k quads instead of 1.3M.
 *
 * Gates are drawn FLAT by default -- one colour per gate, hard edges, showing the
 * radar's actual sampling. `smooth` opts into corner-averaging (each quad's four
 * corners take the mean of the gates meeting there, so the GPU interpolates a
 * gradient); it is OFF unless asked for, and never applied to classification
 * products, where averaging category numbers is meaningless.
 *
 * `threshold` drops gates below a value entirely -- the usual "hide anything
 * under N dBZ" filter, applied to the geometry so the hidden gates cost nothing.
 */
export function buildMesh(
  scan: PolarScan,
  palText: string,
  opts: { smooth?: boolean; threshold?: number | null } = {},
): RadarMesh {
  const { az, lut, codes, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;
  const pal = buildLut(parsePal(palText));
  const doSmooth = !!opts.smooth && meta.kind !== "hca";
  const threshold = opts.threshold ?? null;

  // Per-gate physical value (NaN = no data), so colouring is one lookup path.
  const gv = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) {
    const v = lut[codes[i]];
    gv[i] = threshold !== null && v < threshold ? NaN : v;
  }

  // count first so the typed arrays are allocated once
  let quads = 0;
  for (let i = 0; i < gv.length; i++) if (Number.isFinite(gv[i])) quads++;

  const verts = quads * 6; // two triangles
  const positions = new Float32Array(verts * 2);
  const colors = new Uint8Array(verts * 4);
  const vertValues = new Float32Array(verts);

  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);
  // Azimuths repeat for every gate, so the trig is hoisted out of the hot loop.
  const sinAz = new Float64Array(nAz + 1);
  const cosAz = new Float64Array(nAz + 1);
  for (let a = 0; a <= nAz; a++) {
    const r = (az[a] * Math.PI) / 180;
    sinAz[a] = Math.sin(r);
    cosAz[a] = Math.cos(r);
  }

  // Mercator, inlined. MercatorCoordinate.fromLngLat allocates an object per
  // call and this runs ~1.3M times per frame, which dominated the build.
  const RAD = Math.PI / 360;
  const DEG = 180 / Math.PI;
  const mx = (lon: number) => (180 + lon) / 360;
  const my = (lat: number) => (180 - DEG * Math.log(Math.tan(Math.PI / 4 + lat * RAD))) / 360;

  // Smoothing source. The old smooth only averaged the 4 gates at each corner,
  // which leaves gate interiors at their raw value -- so with a banded palette
  // the effect was invisible ("smooth não funciona"). Now, when smoothing is on,
  // the value field is first blurred with a 3x3 mean (azimuth wraps; range is
  // bounded), so gradients show across the whole echo, not just at gate seams.
  // Gates that were empty STAY empty -- we never smear an echo into clear air.
  let gvSrc = gv;
  if (doSmooth) {
    const b = new Float32Array(gv.length);
    for (let a = 0; a < nAz; a++) {
      for (let g = 0; g < nGates; g++) {
        const ctr = gv[a * nGates + g];
        if (!Number.isFinite(ctr)) {
          b[a * nGates + g] = NaN;
          continue;
        }
        let sum = 0;
        let n = 0;
        for (let da = -1; da <= 1; da++) {
          const aa = (a + da + nAz) % nAz;
          for (let dg = -1; dg <= 1; dg++) {
            const gg = g + dg;
            if (gg < 0 || gg >= nGates) continue;
            const v = gv[aa * nGates + gg];
            if (Number.isFinite(v)) {
              sum += v;
              n += 1;
            }
          }
        }
        b[a * nGates + g] = n ? sum / n : ctr;
      }
    }
    gvSrc = b;
  }

  // Value at a gate-grid corner: mean of the up-to-4 (blurred, when smoothing)
  // gates touching it. Azimuth wraps; the owning gate is always one of them, so
  // a drawn gate's corners are never empty.
  const cornerVal = (ai: number, gi: number): number => {
    let sum = 0;
    let n = 0;
    for (let da = -1; da <= 0; da++) {
      const aa = (ai + da + nAz) % nAz;
      for (let dg = -1; dg <= 0; dg++) {
        const gg = gi + dg;
        if (gg < 0 || gg >= nGates) continue;
        const v = gvSrc[aa * nGates + gg];
        if (Number.isFinite(v)) {
          sum += v;
          n += 1;
        }
      }
    }
    return n ? sum / n : NaN;
  };

  const rgba = new Uint8Array(4);
  let p = 0;
  let c = 0;
  let vi = 0;

  const emit = (x: number, y: number, v: number) => {
    positions[p++] = x;
    positions[p++] = y;
    lookup(pal, v, rgba);
    colors[c++] = rgba[0];
    colors[c++] = rgba[1];
    colors[c++] = rgba[2];
    colors[c++] = rgba[3];
    vertValues[vi++] = v;
  };

  for (let a = 0; a < nAz; a++) {
    const s0 = sinAz[a];
    const c0 = cosAz[a];
    const s1 = sinAz[a + 1];
    const c1 = cosAz[a + 1];
    const row = a * nGates;
    for (let g = 0; g < nGates; g++) {
      const v = gv[row + g];
      if (!Number.isFinite(v)) continue;
      const r0 = rangeStartKm + g * gateWidthKm;
      const r1 = r0 + gateWidthKm;

      // the gate's four corners, each computed once and reused by both triangles
      const x00 = mx(siteLon + (r0 * s0) / kmPerDegLon);
      const y00 = my(siteLat + (r0 * c0) / KM_PER_DEG_LAT);
      const x10 = mx(siteLon + (r1 * s0) / kmPerDegLon);
      const y10 = my(siteLat + (r1 * c0) / KM_PER_DEG_LAT);
      const x11 = mx(siteLon + (r1 * s1) / kmPerDegLon);
      const y11 = my(siteLat + (r1 * c1) / KM_PER_DEG_LAT);
      const x01 = mx(siteLon + (r0 * s1) / kmPerDegLon);
      const y01 = my(siteLat + (r0 * c1) / KM_PER_DEG_LAT);

      const v00 = doSmooth ? cornerVal(a, g) : v;
      const v10 = doSmooth ? cornerVal(a, g + 1) : v;
      const v11 = doSmooth ? cornerVal(a + 1, g + 1) : v;
      const v01 = doSmooth ? cornerVal(a + 1, g) : v;

      emit(x00, y00, v00);
      emit(x10, y10, v10);
      emit(x11, y11, v11);
      emit(x00, y00, v00);
      emit(x11, y11, v11);
      emit(x01, y01, v01);
    }
  }

  return { positions, colors, values: vertValues, lut, vertexCount: verts };
}

/** Swap the palette without touching geometry — the instant path. */
export function recolor(mesh: RadarMesh, palText: string): void {
  const pal = buildLut(parsePal(palText));
  const { colors, values, vertexCount } = mesh;
  const rgba = new Uint8Array(4);
  for (let i = 0; i < vertexCount; i++) {
    lookup(pal, values[i], rgba);
    const o = i * 4;
    colors[o] = rgba[0];
    colors[o + 1] = rgba[1];
    colors[o + 2] = rgba[2];
    colors[o + 3] = rgba[3];
  }
}

/**
 * What the scan says at a lat/lon. "outside" (beyond the sweep, or inside the
 * cone of silence) and "nodata" (in the sweep, nothing returned) are genuinely
 * different answers and must not collapse into one message -- clear air is not
 * an error.
 */
export type Sample =
  | { status: "ok"; value: number }
  | { status: "nodata" }
  | { status: "outside" };

/** Inverts the polar->mercator mapping `buildMesh` draws with. */
export function sampleAt(scan: PolarScan, lat: number, lon: number): Sample {
  const { az, lut, codes, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;

  const yKm = (lat - siteLat) * KM_PER_DEG_LAT;
  const xKm = (lon - siteLon) * KM_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);

  const range = Math.hypot(xKm, yKm);
  const g = Math.floor((range - rangeStartKm) / gateWidthKm);
  if (g < 0 || g >= nGates) return { status: "outside" };

  // Azimuth edges ascend but don't necessarily start at 0 (a Level II sweep
  // starts wherever the antenna was), so fold the bearing into their span.
  const bearing = ((Math.atan2(xKm, yKm) * 180) / Math.PI + 360) % 360;
  const start = az[0];
  let t = bearing - start;
  if (t < 0) t += 360;

  let lo = 0;
  let hi = nAz - 1;
  let a = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let e0 = az[mid] - start;
    if (e0 < 0) e0 += 360;
    let e1 = az[mid + 1] - start;
    if (e1 <= 0) e1 += 360;
    if (t < e0) hi = mid - 1;
    else if (t >= e1) lo = mid + 1;
    else {
      a = mid;
      break;
    }
  }
  if (a < 0) return { status: "outside" };

  const v = lut[codes[a * nGates + g]];
  return Number.isFinite(v) ? { status: "ok", value: v } : { status: "nodata" };
}

export function meshBounds(scan: PolarScan): maplibregl.LngLatBoundsLike {
  const { siteLat, siteLon, maxRangeKm } = scan.meta;
  const dLat = maxRangeKm / KM_PER_DEG_LAT;
  const dLon = maxRangeKm / (KM_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180));
  return [
    [siteLon - dLon, siteLat - dLat],
    [siteLon + dLon, siteLat + dLat],
  ];
}
