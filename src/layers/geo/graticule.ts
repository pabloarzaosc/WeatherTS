/**
 * Builds a lat/lon graticule as GeoJSON at runtime — no data file. Meridians
 * and parallels at `step` degrees; the equator and prime meridian are flagged
 * `major` so the style can emphasize them.
 */
export function buildGraticule(step = 15): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const LAT_LIMIT = 85;
  const PARALLEL_LIMIT = 75;

  // Meridians (constant longitude).
  for (let lon = -180; lon <= 180; lon += step) {
    const coordinates: [number, number][] = [];
    for (let lat = -LAT_LIMIT; lat <= LAT_LIMIT; lat += 2) coordinates.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: { kind: "meridian", value: lon, major: lon === 0 },
      geometry: { type: "LineString", coordinates },
    });
  }

  // Parallels (constant latitude) — stop short of the poles.
  for (let lat = -PARALLEL_LIMIT; lat <= PARALLEL_LIMIT; lat += step) {
    const coordinates: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) coordinates.push([lon, lat]);
    features.push({
      type: "Feature",
      properties: { kind: "parallel", value: lat, major: lat === 0 },
      geometry: { type: "LineString", coordinates },
    });
  }

  return { type: "FeatureCollection", features };
}
