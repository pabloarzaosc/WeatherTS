/**
 * Where the sun is at an instant and place: NOAA's low-precision solar
 * position (declination, equation of time, hour angle), good to a few tenths
 * of a degree -- plenty to light a cloud. Elevation without refraction.
 */

const RAD = Math.PI / 180;

export interface SunPos {
  /** Degrees above the horizon (negative = below). */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

export function sunPosition(unix: number, lat: number, lon: number): SunPos {
  const d = new Date(unix * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((unix * 1000 - start) / 86400000) + 1;
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const leap = (d.getUTCFullYear() % 4 === 0 && d.getUTCFullYear() % 100 !== 0) || d.getUTCFullYear() % 400 === 0;
  const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (dayOfYear - 1 + (hours - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const trueSolarMin = hours * 60 + eqTime + 4 * lon;
  const ha = (trueSolarMin / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZen = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  // Azimuth clockwise from north.
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi));
  return { elevation: 90 - zen / RAD, azimuth: ((az / RAD + 180) % 360 + 360) % 360 };
}

/** Unit vector toward a body at elevation/azimuth, in the box frame
 *  (x east, y north, z up). */
export function dirFrom(elevationDeg: number, azimuthDeg: number): [number, number, number] {
  const e = elevationDeg * RAD;
  const a = azimuthDeg * RAD;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

export interface Lighting {
  /** Toward the light that shades the cloud (the sun, or the moon at night). */
  dir: [number, number, number];
  /** That light's colour and strength. */
  color: [number, number, number];
  /** The sky's light from every side. */
  ambient: [number, number, number];
  /** Sky colour overhead and at the horizon, for the background. */
  zenith: [number, number, number];
  horizon: [number, number, number];
  night: boolean;
  label: string;
}

const mix = (a: number[], b: number[], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * The light for a sun position: white high sun, warm low sun, a twilight that
 * fades to a dim blue moonlight below -6 degrees.
 */
export function lightingFor(sun: SunPos): Lighting {
  const el = sun.elevation;
  const day = clamp01((el + 4) / 10); // 0 at -4 deg, 1 at +6 deg
  const high = clamp01((el - 4) / 30);
  const sunColor = mix([1.35, 0.72, 0.4], [1.55, 1.5, 1.42], high);
  // Past nautical twilight (-6 deg) the only light is a dim display
  // "moonlight", 40% dimmer again by -12 deg: the storm stays readable, but
  // nobody mistakes it for day (the panel says so in its sun line).
  const deep = clamp01((-6 - el) / 6);
  const moonColor = mix([0.16, 0.19, 0.27], [0.096, 0.114, 0.162], deep);
  const color = mix(moonColor, sunColor, day);
  // At night the moon lights the cloud from the other side of the sky, fixed
  // at a moderate height: honest enough for "it is night".
  const dir =
    el > -4
      ? dirFrom(Math.max(el, 1.5), sun.azimuth)
      : dirFrom(38, (sun.azimuth + 180) % 360);
  const ambientDay = mix([0.3, 0.26, 0.27], [0.3, 0.36, 0.46], high);
  const ambient = mix(mix([0.045, 0.055, 0.08], [0.027, 0.033, 0.048], deep), ambientDay, day);
  const zenith = mix([0.012, 0.016, 0.03], mix([0.16, 0.2, 0.33], [0.24, 0.42, 0.68], high), day);
  const horizon = mix([0.03, 0.035, 0.055], mix([0.75, 0.48, 0.32], [0.66, 0.74, 0.82], high), day);
  const label = el >= 6 ? "Day" : el >= -6 ? "Twilight" : "Night";
  return { dir, color, ambient, zenith, horizon, night: el < -4, label };
}
