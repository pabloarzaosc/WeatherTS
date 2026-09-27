/**
 * Douglas-Peucker simplification of GeoJSON polygons, in degrees.
 *
 * NWS zone shapes come far finer than a map shows them: the alerts of one
 * afternoon were 621 polygons and 2.27 million vertices (44 MB), mostly zone
 * outlines and marine coastlines drawn every few metres. Handed to the map
 * whole, each change of the alert set cost over a second of the main thread,
 * and a playing loop froze at every one (Pablo, 2026-09-26).
 */

type Ring = GeoJSON.Position[];

/** Squared distance from p to the segment a-b. */
function segDist2(p: GeoJSON.Position, a: GeoJSON.Position, b: GeoJSON.Position): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/** A line's vertices kept by Douglas-Peucker (iterative: rings run to 100k points). */
function simplifyLine(points: Ring, tol2: number): Ring {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    let max = tol2;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(points[i], points[first], points[last]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** A closed ring, simplified; the original when too little of it would be left. */
function simplifyRing(ring: Ring, tol2: number): Ring {
  if (ring.length <= 4) return ring;
  const out = simplifyLine(ring, tol2);
  return out.length >= 4 ? out : ring;
}

/** Whether a ring fits in a box `size` degrees across: a speck at map scale. */
function tiny(ring: Ring, size: number): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return x1 - x0 < size && y1 - y0 < size;
}

function simplifyPolygon(rings: Ring[], tol2: number, speck: number): Ring[] {
  const out: Ring[] = [];
  rings.forEach((ring, i) => {
    // Holes smaller than a few times the tolerance go (a lake in a zone).
    if (i > 0 && tiny(ring, speck)) return;
    out.push(simplifyRing(ring, tol2));
  });
  return out;
}

/**
 * A polygon or multipolygon with no vertex further than `tolerance` degrees
 * from the original outline (0.001 degrees: about 100 m, under two pixels even
 * at a city's zoom). Other geometry types pass through.
 */
export function simplifyGeometry(g: GeoJSON.Geometry | null, tolerance = 0.001): GeoJSON.Geometry | null {
  if (!g) return g;
  const tol2 = tolerance * tolerance;
  // About half a kilometre: islets of a marine zone's coast, hundreds of them.
  const speck = tolerance * 5;
  if (g.type === "Polygon") return { type: "Polygon", coordinates: simplifyPolygon(g.coordinates, tol2, speck) };
  if (g.type === "MultiPolygon") {
    const parts = g.coordinates.filter((p) => p.length > 0 && !tiny(p[0], speck));
    const kept = parts.length > 0 ? parts : g.coordinates;
    return { type: "MultiPolygon", coordinates: kept.map((p) => simplifyPolygon(p, tol2, speck)) };
  }
  if (g.type === "GeometryCollection") {
    return { type: "GeometryCollection", geometries: g.geometries.map((x) => simplifyGeometry(x, tolerance)!) };
  }
  return g;
}
