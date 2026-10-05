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
    /** A product published empty -- "No precipitation detected since ..." */
    note?: string;
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

export interface GateSample {
  /** Physical value at the gate, in `scan.meta.units`. */
  value: number;
  azimuth: number; // degrees from north
  rangeKm: number;
  /** Indices into the polar grid, for anything that wants the raw code. */
  azIndex: number;
  gateIndex: number;
}

/**
 * The value the radar actually measured under a point.
 *
 * Read from the polar data, not from the rendered pixel: the mesh bakes colour
 * into vertices, so sampling the framebuffer would mean inverting a palette --
 * lossy wherever two values share a colour band, and wrong entirely once
 * another layer is drawn on top. Inverting the geometry instead gives the exact
 * gate, which is also what makes the azimuth and range available.
 *
 * This is the inverse of the projection buildMesh uses, flat-earth about the
 * site and all: sampling and drawing have to agree about which gate is under a
 * point, so they share the same (approximate) geometry rather than each being
 * right in its own way.
 */
export function sampleScan(scan: PolarScan, lat: number, lon: number): GateSample | null {
  const { az, lut, codes, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;

  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((siteLat * Math.PI) / 180);
  const dx = (lon - siteLon) * kmPerDegLon;
  const dy = (lat - siteLat) * KM_PER_DEG_LAT;
  const rangeKm = Math.hypot(dx, dy);

  const gateIndex = Math.floor((rangeKm - rangeStartKm) / gateWidthKm);
  if (gateIndex < 0 || gateIndex >= nGates) return null;

  // atan2(dx, dy), not (dy, dx): azimuth is clockwise from north, not
  // counter-clockwise from east.
  let azimuth = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;

  const azIndex = findAzBin(az, nAz, azimuth);
  if (azIndex < 0) return null;

  const value = lut[codes[azIndex * nGates + gateIndex]];
  if (!Number.isFinite(value)) return null;

  return { value, azimuth, rangeKm, azIndex, gateIndex };
}

/**
 * Which azimuth bin contains `deg`.
 *
 * The edges are not a uniform grid -- a real scan's rays are unevenly spaced,
 * and the sweep crosses north somewhere in the middle of the array -- so this
 * walks the bins and compares each one's span with the wrap folded in, rather
 * than assuming edges[i] <= edges[i+1].
 */
function findAzBin(edges: Float32Array, nAz: number, deg: number): number {
  for (let a = 0; a < nAz; a++) {
    const lo = edges[a];
    let span = edges[a + 1] - lo;
    if (span < 0) span += 360; // this bin straddles north
    let off = deg - lo;
    if (off < 0) off += 360;
    if (off < span) return a;
  }
  return -1;
}

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
  // the effect was invisible ("smooth does nothing"). Now, when smoothing is on,
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

  if (doSmooth) {
    return buildSmoothMesh(scan, pal, gv, gvSrc, sinAz, cosAz, kmPerDegLon, mx, my);
  }

  // Flat gates. Count first so the typed arrays are allocated once
  let quads = 0;
  for (let i = 0; i < gv.length; i++) if (Number.isFinite(gv[i])) quads++;

  const verts = quads * 6; // two triangles
  const positions = new Float32Array(verts * 2);
  const colors = new Uint8Array(verts * 4);
  const vertValues = new Float32Array(verts);

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

      emit(x00, y00, v);
      emit(x10, y10, v);
      emit(x11, y11, v);
      emit(x00, y00, v);
      emit(x11, y11, v);
      emit(x01, y01, v);
    }
  }

  return { positions, colors, values: vertValues, lut, vertexCount: verts };
}

// Marching squares, per cell mask (bit i = corner i has data): how many
// vertices the cell's polygon has. The polygon walks the four corners in order,
// keeping the corners with data and adding an edge midpoint wherever data
// starts or stops -- so 1 corner is a triangle, 2 a quad, 3 a pentagon, the
// diagonal pair a hexagon (joined, which keeps diagonal echoes in one piece).
const POLY_VERTS = (() => {
  const t = new Uint8Array(16);
  for (let m = 0; m < 16; m++) {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const here = (m >> i) & 1;
      const next = (m >> ((i + 1) & 3)) & 1;
      if (here) n++;
      if (here !== next) n++;
    }
    t[m] = n;
  }
  return t;
})();

/**
 * The smoothed mesh. Flat gates are quads on the radar's own grid, so an echo's
 * edge is a staircase of whole gates -- smoothing the colours inside left the
 * edges square, gates over a kilometre wide far from the radar. Here the mesh
 * joins the gates' CENTRES instead, colours interpolating between them, and a
 * cell at the edge of an echo is cut halfway between the gate with data and the
 * one without (marching squares). The staircase becomes diagonals: the outline
 * follows the echo, not the grid.
 *
 * The cut sits where the gate's own edge was, so an echo keeps its size; a lone
 * gate becomes a diamond on its centre. Gates with no data stay empty, and
 * colours come from the (blurred) values exactly as before.
 */
function buildSmoothMesh(
  scan: PolarScan,
  pal: ReturnType<typeof buildLut>,
  gv: Float32Array,
  gvSrc: Float32Array,
  sinAz: Float64Array,
  cosAz: Float64Array,
  kmPerDegLon: number,
  mx: (lon: number) => number,
  my: (lat: number) => number,
): RadarMesh {
  const { lut, meta } = scan;
  const { nAz, nGates, siteLat, siteLon, rangeStartKm, gateWidthKm } = meta;

  // How surrounded by echo each gate is: its own presence and its eight
  // neighbours', weighted 4-2-1 (centre, sides, corners) over 16. A gate in a
  // solid echo is 1, one on a straight edge 0.75 and the empty gate across from
  // it 0.25 -- so a cut placed where this crosses 0.5 is the gate's own edge,
  // and the echo keeps its size. At a jutting corner the field is lower and the
  // cut moves in (the corner rounds off); in a notch it is higher and the cut
  // moves out (the notch fills in). Marching squares on a blurred mask is what
  // turns the staircase into a curve.
  const nCells = nAz * nGates;
  const pres = new Float32Array(nCells);
  for (let a = 0; a < nAz; a++) {
    const rows = [(a - 1 + nAz) % nAz, a, (a + 1) % nAz];
    const wa = [1, 2, 1];
    for (let g = 0; g < nGates; g++) {
      let s = 0;
      for (let k = 0; k < 3; k++) {
        const base = rows[k] * nGates;
        const w = wa[k];
        if (g > 0 && Number.isFinite(gv[base + g - 1])) s += w;
        if (Number.isFinite(gv[base + g])) s += 2 * w;
        if (g < nGates - 1 && Number.isFinite(gv[base + g + 1])) s += w;
      }
      pres[a * nGates + g] = s / 16;
    }
  }
  // A gate is drawn if it has data, or if it is an empty gate deep enough in
  // an echo (a one-gate hole) -- holes that small are speckle, not clear air.
  const inside = new Uint8Array(nCells);
  for (let i = 0; i < nCells; i++) inside[i] = Number.isFinite(gv[i]) || pres[i] >= 0.5 ? 1 : 0;
  // The colour of a filled hole: its neighbours' mean.
  const valueAt = (i: number): number => {
    const v = gvSrc[i];
    if (Number.isFinite(v)) return v;
    const a = Math.floor(i / nGates);
    const g = i - a * nGates;
    let s = 0;
    let k = 0;
    for (let da = -1; da <= 1; da++) {
      const base = ((a + da + nAz) % nAz) * nGates;
      for (let dg = -1; dg <= 1; dg++) {
        const gg = g + dg;
        if (gg < 0 || gg >= nGates) continue;
        const w = gvSrc[base + gg];
        if (Number.isFinite(w)) {
          s += w;
          k++;
        }
      }
    }
    return k ? s / k : NaN;
  };
  // Where along an edge from an inside gate to an outside one the cut falls.
  // A gate too thin to reach 0.5 itself (a lone gate, a one-gate line) keeps
  // the plain midpoint, so small echoes are never dropped.
  const cutAt = (pin: number, pout: number): number => {
    if (pin <= 0.5 || pin - pout <= 1e-6) return 0.5;
    const t = (pin - 0.5) / (pin - pout);
    return t < 0.15 ? 0.15 : t > 0.85 ? 0.85 : t;
  };
  const has = (a: number, g: number) => inside[a * nGates + g] === 1;

  // Pass 1: count, so the arrays are allocated once.
  let tris = 0;
  for (let a = 0; a < nAz; a++) {
    const b = (a + 1) % nAz;
    for (let g = 0; g < nGates - 1; g++) {
      const m = (has(a, g) ? 1 : 0) | (has(a, g + 1) ? 2 : 0) | (has(b, g + 1) ? 4 : 0) | (has(b, g) ? 8 : 0);
      if (m) tris += POLY_VERTS[m] - 2;
    }
  }
  const verts = tris * 3;
  const positions = new Float32Array(verts * 2);
  const colors = new Uint8Array(verts * 4);
  const vertValues = new Float32Array(verts);

  // Gate centres, a radial at a time: the azimuth halfway between its edges
  // (as a vector, so a radial straddling north is right) and each gate's
  // middle range. Two rows are live at once, plus the first for the wrap.
  const centreRow = (a: number, out: Float64Array) => {
    let s = sinAz[a] + sinAz[a + 1];
    let c = cosAz[a] + cosAz[a + 1];
    const n = Math.hypot(s, c) || 1;
    s /= n;
    c /= n;
    for (let g = 0; g < nGates; g++) {
      const r = rangeStartKm + (g + 0.5) * gateWidthKm;
      out[2 * g] = mx(siteLon + (r * s) / kmPerDegLon);
      out[2 * g + 1] = my(siteLat + (r * c) / KM_PER_DEG_LAT);
    }
  };
  const first = new Float64Array(nGates * 2);
  let rowA = new Float64Array(nGates * 2);
  let rowB = new Float64Array(nGates * 2);
  centreRow(0, first);
  rowA.set(first);

  const rgba = new Uint8Array(4);
  let p = 0;
  let c = 0;
  let vi = 0;
  const put = (x: number, y: number, v: number) => {
    positions[p++] = x;
    positions[p++] = y;
    lookup(pal, v, rgba);
    colors[c++] = rgba[0];
    colors[c++] = rgba[1];
    colors[c++] = rgba[2];
    colors[c++] = rgba[3];
    vertValues[vi++] = v;
  };

  // The cell's polygon, at most six points: x, y, value.
  const px = new Float64Array(6);
  const py = new Float64Array(6);
  const pv = new Float64Array(6);
  const cx = new Float64Array(4);
  const cy = new Float64Array(4);
  const cv = new Float64Array(4);
  const ch = new Uint8Array(4);
  const ci = new Int32Array(4);

  for (let a = 0; a < nAz; a++) {
    const b = (a + 1) % nAz;
    if (b === 0) rowB.set(first);
    else centreRow(b, rowB);
    for (let g = 0; g < nGates - 1; g++) {
      // Corners in order round the cell: (a,g) (a,g+1) (b,g+1) (b,g).
      const i0 = a * nGates + g;
      const i1 = i0 + 1;
      const i3 = b * nGates + g;
      const i2 = i3 + 1;
      ch[0] = inside[i0];
      ch[1] = inside[i1];
      ch[2] = inside[i2];
      ch[3] = inside[i3];
      const m = ch[0] | (ch[1] << 1) | (ch[2] << 2) | (ch[3] << 3);
      if (!m) continue;
      ci[0] = i0;
      ci[1] = i1;
      ci[2] = i2;
      ci[3] = i3;
      cx[0] = rowA[2 * g];
      cy[0] = rowA[2 * g + 1];
      cx[1] = rowA[2 * g + 2];
      cy[1] = rowA[2 * g + 3];
      cx[2] = rowB[2 * g + 2];
      cy[2] = rowB[2 * g + 3];
      cx[3] = rowB[2 * g];
      cy[3] = rowB[2 * g + 1];
      cv[0] = ch[0] ? valueAt(i0) : NaN;
      cv[1] = ch[1] ? valueAt(i1) : NaN;
      cv[2] = ch[2] ? valueAt(i2) : NaN;
      cv[3] = ch[3] ? valueAt(i3) : NaN;

      if (m === 15) {
        put(cx[0], cy[0], cv[0]);
        put(cx[1], cy[1], cv[1]);
        put(cx[2], cy[2], cv[2]);
        put(cx[0], cy[0], cv[0]);
        put(cx[2], cy[2], cv[2]);
        put(cx[3], cy[3], cv[3]);
        continue;
      }

      let n = 0;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) & 3;
        if (ch[i]) {
          px[n] = cx[i];
          py[n] = cy[i];
          pv[n] = cv[i];
          n++;
        }
        if (ch[i] !== ch[j]) {
          // On the edge where the echo ends (see cutAt), in the colour of the
          // end that is drawn.
          const from = ch[i] ? i : j;
          const to = ch[i] ? j : i;
          const t = cutAt(pres[ci[from]], pres[ci[to]]);
          px[n] = cx[from] + t * (cx[to] - cx[from]);
          py[n] = cy[from] + t * (cy[to] - cy[from]);
          pv[n] = cv[from];
          n++;
        }
      }
      // Every case's polygon is convex: a fan from its first point.
      for (let k = 1; k < n - 1; k++) {
        put(px[0], py[0], pv[0]);
        put(px[k], py[k], pv[k]);
        put(px[k + 1], py[k + 1], pv[k + 1]);
      }
    }
    const t = rowA;
    rowA = rowB;
    rowB = t;
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
