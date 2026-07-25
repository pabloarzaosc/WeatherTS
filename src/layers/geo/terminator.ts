/**
 * Day/night terminator computed client-side from the sun's position.
 * The night side is returned as a single GeoJSON polygon (terminator curve
 * closed to the dark pole). Adapted from the MIT-licensed Leaflet.Terminator
 * algorithm. MapLibre repeats the polygon across world copies in mercator and
 * renders it once on the globe.
 */
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function toJulian(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function gmstHours(jd: number): number {
  const d = jd - 2_451_545.0;
  return mod(18.697_374_558 + 24.065_709_824_419_08 * d, 24);
}

function sunEclipticLongitude(jd: number): number {
  const n = jd - 2_451_545.0;
  const meanLongitude = mod(280.46 + 0.985_647_4 * n, 360);
  const meanAnomaly = mod(357.528 + 0.985_600_3 * n, 360) * D2R;
  return meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly);
}

function eclipticObliquity(jd: number): number {
  const n = jd - 2_451_545.0;
  return 23.4393 - 0.000_000_4 * n;
}

export function buildTerminator(date: Date = new Date(), step = 2): GeoJSON.Feature<GeoJSON.Polygon> {
  const jd = toJulian(date);
  const lambda = sunEclipticLongitude(jd);
  const obliquity = eclipticObliquity(jd);
  const delta =
    Math.asin(Math.sin(obliquity * D2R) * Math.sin(lambda * D2R)) * R2D; // declination
  const alpha =
    Math.atan2(Math.cos(obliquity * D2R) * Math.sin(lambda * D2R), Math.cos(lambda * D2R)) *
    R2D; // right ascension
  const gst = gmstHours(jd);

  const poleLat = delta < 0 ? 90 : -90; // fill toward the dark pole
  const ring: [number, number][] = [[-180, poleLat]];

  for (let lon = -180; lon <= 180; lon += step) {
    const hourAngle = (gst * 15 + lon - alpha) * D2R;
    const lat = Math.atan(-Math.cos(hourAngle) / Math.tan(delta * D2R)) * R2D;
    ring.push([lon, lat]);
  }

  ring.push([180, poleLat], [-180, poleLat]);

  return {
    type: "Feature",
    properties: { kind: "night" },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
