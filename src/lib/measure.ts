import maplibregl, { type Marker, type Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";

export type MeasureMode = "off" | "distance" | "area" | "diameter";
export type MeasureUnits = "metric" | "imperial";
export type Pt = [number, number];

const SRC = "measure-src";
const FILL = "measure-fill";
const LINE = "measure-line";
const PTS = "measure-points";

const EARTH = 6_371_008.8; // mean Earth radius, meters
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/* ------------------------------------------------------------------ geometry */

export function haversine(a: Pt, b: Pt): number {
  const dLat = (b[1] - a[1]) * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const lat1 = a[1] * D2R;
  const lat2 = b[1] * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}

export function pathLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i]);
  return total;
}

export function bearing(a: Pt, b: Pt): number {
  const lat1 = a[1] * D2R;
  const lat2 = b[1] * D2R;
  const dLng = (b[0] - a[0]) * D2R;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Geodesic polygon area (spherical excess), in m². */
export function ringArea(coords: Pt[]): number {
  if (coords.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lng1, lat1] = coords[i];
    const [lng2, lat2] = coords[(i + 1) % coords.length];
    total += (lng2 - lng1) * D2R * (2 + Math.sin(lat1 * D2R) + Math.sin(lat2 * D2R));
  }
  return Math.abs((total * EARTH * EARTH) / 2);
}

export function centroid(coords: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const [lng, lat] of coords) {
    x += lng;
    y += lat;
  }
  return [x / coords.length, y / coords.length];
}

function destination(center: Pt, distM: number, bearingDeg: number): Pt {
  const d = distM / EARTH;
  const brng = bearingDeg * D2R;
  const lat1 = center[1] * D2R;
  const lng1 = center[0] * D2R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lng2 =
    lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lng2 * R2D, lat2 * R2D];
}

function circleRing(center: Pt, radiusM: number, steps = 80): Pt[] {
  const ring: Pt[] = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(center, radiusM, (i / steps) * 360));
  return ring;
}

function midpoint(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/* ---------------------------------------------------------------- formatting */

export function formatDistance(m: number, units: MeasureUnits): string {
  if (units === "imperial") {
    const ft = m * 3.280839895;
    if (ft < 1000) return `${ft.toFixed(0)} ft`;
    const mi = m / 1609.344;
    return `${mi.toFixed(mi < 100 ? 2 : 0)} mi`;
  }
  if (m < 1000) return `${m.toFixed(0)} m`;
  const km = m / 1000;
  return `${km.toFixed(km < 100 ? 2 : 0)} km`;
}

export function formatArea(m2: number, units: MeasureUnits): string {
  if (units === "imperial") {
    const acre = m2 / 4046.8564224;
    if (acre < 0.25) return `${(m2 * 10.763910417).toFixed(0)} ft²`;
    if (acre < 640) return `${acre.toFixed(2)} ac`;
    const mi2 = m2 / 2_589_988.110336;
    return `${mi2.toFixed(mi2 < 100 ? 2 : 0)} mi²`;
  }
  if (m2 < 10_000) return `${m2.toFixed(0)} m²`;
  if (m2 < 1_000_000) return `${(m2 / 10_000).toFixed(2)} ha`;
  const km2 = m2 / 1_000_000;
  return `${km2.toFixed(km2 < 100 ? 2 : 0)} km²`;
}

/* ------------------------------------------------------------------ map layers */

export function ensureMeasureLayers(map: MapLibreMap): void {
  if (!map.getSource(SRC)) {
    map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  }
  if (!map.getLayer(FILL)) {
    map.addLayer({
      id: FILL,
      type: "fill",
      source: SRC,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 },
    });
  }
  if (!map.getLayer(LINE)) {
    map.addLayer({
      id: LINE,
      type: "line",
      source: SRC,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#3b82f6", "line-width": 2, "line-dasharray": [2, 1.5] },
    });
  }
  if (!map.getLayer(PTS)) {
    map.addLayer({
      id: PTS,
      type: "circle",
      source: SRC,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4,
        "circle-color": "#3b82f6",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
  }
  for (const id of [FILL, LINE, PTS]) if (map.getLayer(id)) map.moveLayer(id);
}

export function clearMeasureGeometry(map: MapLibreMap): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  src?.setData({ type: "FeatureCollection", features: [] });
}

export function updateMeasureGeometry(map: MapLibreMap, mode: MeasureMode, points: Pt[], hover: Pt | null): void {
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;
  const features: GeoJSON.Feature[] = [];
  const line = (coords: Pt[]) =>
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
  const poly = (ring: Pt[]) =>
    features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
  const pt = (p: Pt) =>
    features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } });

  if (mode === "distance") {
    const path = hover && points.length >= 1 ? [...points, hover] : points;
    if (path.length >= 2) line(path);
    points.forEach(pt);
  } else if (mode === "area") {
    const ring = hover && points.length >= 2 ? [...points, hover] : points;
    if (ring.length >= 3) {
      poly([...ring, ring[0]]);
      line([...ring, ring[0]]);
    } else if (ring.length === 2) {
      line(ring);
    }
    points.forEach(pt);
  } else if (mode === "diameter") {
    const center = points[0];
    const edge = points[1] ?? hover ?? undefined;
    if (center && edge) {
      poly(circleRing(center, haversine(center, edge)));
      line([center, edge]);
    }
    if (center) pt(center);
    if (points[1]) pt(points[1]);
  }

  src.setData({ type: "FeatureCollection", features });
}

/* ----------------------------------------------------------------- stats + labels */

export interface MeasureStats {
  primary: string;
  secondary: string[];
}

export function computeStats(mode: MeasureMode, points: Pt[], hover: Pt | null, units: MeasureUnits): MeasureStats {
  const ptLabel = `${points.length} pt${points.length === 1 ? "" : "s"}`;

  if (mode === "distance") {
    const path = hover && points.length >= 1 ? [...points, hover] : points;
    if (path.length < 2) return { primary: "—", secondary: [ptLabel] };
    const secondary = [ptLabel, `${Math.round(bearing(path[path.length - 2], path[path.length - 1]))}° brg`];
    return { primary: formatDistance(pathLength(path), units), secondary };
  }

  if (mode === "area") {
    const ring = hover && points.length >= 2 ? [...points, hover] : points;
    if (ring.length < 3) return { primary: "—", secondary: [ptLabel] };
    const perim = pathLength([...ring, ring[0]]);
    return { primary: formatArea(ringArea(ring), units), secondary: [ptLabel, `${formatDistance(perim, units)} perim`] };
  }

  const center = points[0];
  const edge = points[1] ?? hover;
  if (!center || !edge) return { primary: "—", secondary: [] };
  const r = haversine(center, edge);
  return {
    primary: `Ø ${formatDistance(r * 2, units)}`,
    secondary: [
      `r ${formatDistance(r, units)}`,
      `${formatDistance(2 * Math.PI * r, units)} circ`,
      formatArea(Math.PI * r * r, units),
    ],
  };
}

export interface MeasureLabel {
  lngLat: Pt;
  text: string;
  variant?: "total" | "seg";
}

export function computeLabels(mode: MeasureMode, points: Pt[], hover: Pt | null, units: MeasureUnits): MeasureLabel[] {
  const labels: MeasureLabel[] = [];

  if (mode === "distance") {
    for (let i = 1; i < points.length; i++) {
      labels.push({
        lngLat: midpoint(points[i - 1], points[i]),
        text: formatDistance(haversine(points[i - 1], points[i]), units),
        variant: "seg",
      });
    }
    const path = hover && points.length >= 1 ? [...points, hover] : points;
    if (path.length >= 2) {
      labels.push({ lngLat: path[path.length - 1], text: formatDistance(pathLength(path), units), variant: "total" });
    }
  } else if (mode === "area") {
    const ring = hover && points.length >= 2 ? [...points, hover] : points;
    if (ring.length >= 3) {
      labels.push({ lngLat: centroid(ring), text: formatArea(ringArea(ring), units), variant: "total" });
    }
  } else if (mode === "diameter") {
    const center = points[0];
    const edge = points[1] ?? hover;
    if (center && edge) {
      labels.push({
        lngLat: midpoint(center, edge),
        text: `Ø ${formatDistance(haversine(center, edge) * 2, units)}`,
        variant: "total",
      });
    }
  }

  return labels;
}

/** Pool of reusable HTML marker chips for on-map labels. */
export class MeasureLabels {
  private markers: Marker[] = [];
  constructor(private readonly map: MapLibreMap) {}

  sync(labels: MeasureLabel[]): void {
    while (this.markers.length < labels.length) {
      const el = document.createElement("div");
      el.className = "measure-label";
      this.markers.push(new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([0, 0]).addTo(this.map));
    }
    while (this.markers.length > labels.length) this.markers.pop()?.remove();

    labels.forEach((l, i) => {
      const m = this.markers[i];
      m.setLngLat(l.lngLat);
      const el = m.getElement();
      el.textContent = l.text;
      el.className = `measure-label${l.variant ? ` measure-label--${l.variant}` : ""}`;
    });
  }

  clear(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }
}
