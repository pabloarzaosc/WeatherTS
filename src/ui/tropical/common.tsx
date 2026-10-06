import { CAT_COLORS, CAT_SHORT, catOf, type Cat } from "../../lib/tropical/data";

/** A category chip in the track-map colours (dark ink: they are all light). */
export function CatBadge({ cat, vmax, big }: { cat?: Cat; vmax?: number | null; big?: boolean }) {
  const c = cat ?? catOf(vmax);
  return (
    <span className={`trp-cat${big ? " trp-cat--big" : ""}`} style={{ background: CAT_COLORS[c] }} title={CAT_SHORT[c]}>
      {CAT_SHORT[c]}
    </span>
  );
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** 75 kt (85 mph, 140 km/h). */
export function windText(kt: number | null | undefined): string {
  if (kt == null) return "--";
  return `${Math.round(kt)} kt · ${Math.round(kt * 1.15078)} mph · ${Math.round(kt * 1.852)} km/h`;
}

export function latlonText(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
}

export function motionText(dir: number | null | undefined, speed: number | null | undefined): string {
  if (dir == null || speed == null) return "--";
  if (speed === 0) return "Stationary";
  return `${compass(dir)} at ${Math.round(speed)} kt`;
}

/** How long ago, in hours and minutes. */
export function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min ago` : `${Math.round(h / 24)} days ago`;
}

export const kt2mph = (kt: number) => kt * 1.15078;
