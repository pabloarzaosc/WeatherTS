// Canvas-drawn icons for the surface station-plot layer: wind barbs (by speed,
// rotated by direction on the map) and sky-cover circles. Registered on the map
// once via addImage; the symbol layers reference them by id.

import type { Map as MapLibreMap } from "maplibre-gl";

const PR = 2; // draw at 2x for crisp icons; addImage told pixelRatio 2
const BARB_SIZE = 46; // logical px (icon is BARB_SIZE*PR canvas px)

// Barb speed bins we pre-render (kt). icon-image picks the nearest via barbKey.
export const BARB_BINS = Array.from({ length: 21 }, (_, i) => i * 5); // 0..100

export function barbKey(wspd: number | null | undefined): number {
  if (wspd == null || !Number.isFinite(wspd)) return 0;
  return Math.min(100, Math.round(wspd / 5) * 5);
}

function drawBarb(speed: number): HTMLCanvasElement {
  const S = BARB_SIZE * PR;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  ctx.strokeStyle = "#e8edf4";
  ctx.fillStyle = "#e8edf4";
  ctx.lineWidth = 1.4 * PR;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const cx = S / 2;
  const cy = S / 2;
  if (speed < 3) return cv; // calm -> no barb (the calm ring is a separate icon)

  const top = 6 * PR; // far end of the shaft (points "up" = north; map rotates it)
  // shaft from station centre up to the top
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, top);
  ctx.stroke();

  let flags = Math.floor(speed / 50);
  let fulls = Math.floor((speed % 50) / 10);
  let halfs = Math.round((speed % 10) / 5); // 0 or 1

  const step = 4.5 * PR; // spacing between feathers along the shaft
  const len = 12 * PR; // feather length
  const dy = 5 * PR; // feather vertical drop
  let y = top;

  // pennants (50 kt): filled triangles
  for (let i = 0; i < flags; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx - len, y + dy * 0.5);
    ctx.lineTo(cx, y + step);
    ctx.closePath();
    ctx.fill();
    y += step + 1.5 * PR;
  }
  if (flags > 0) y += 1.5 * PR;
  // full barbs (10 kt)
  for (let i = 0; i < fulls; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx - len, y - dy);
    ctx.stroke();
    y += step;
  }
  // half barb (5 kt) -- offset in a bit from the end if it's the only feather
  if (halfs > 0) {
    if (fulls === 0 && flags === 0) y += step; // move off the very tip
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx - len * 0.5, y - dy * 0.5);
    ctx.stroke();
  }
  return cv;
}

function drawSky(cover: string): HTMLCanvasElement {
  const S = 20 * PR;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d")!;
  const cx = S / 2;
  const cy = S / 2;
  const r = 6 * PR;
  ctx.lineWidth = 1.4 * PR;
  ctx.strokeStyle = "#e8edf4";
  ctx.fillStyle = "#e8edf4";

  // outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const fillFrac: Record<string, number> = { SKC: 0, CLR: 0, FEW: 0.25, SCT: 0.5, BKN: 0.75, OVC: 1 };
  const frac = fillFrac[cover] ?? -1; // -1 = missing -> draw an X-less empty ring

  if (frac >= 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else if (frac > 0) {
    // pie fill from top, clockwise
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.closePath();
    ctx.fill();
  }
  return cv;
}

function canvasToImageData(cv: HTMLCanvasElement) {
  const ctx = cv.getContext("2d")!;
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

export const SKY_COVERS = ["SKC", "CLR", "FEW", "SCT", "BKN", "OVC", "MISSING"] as const;

/** Register all barb + sky-cover icons on the map (idempotent). */
export function registerStationIcons(map: MapLibreMap): void {
  for (const spd of BARB_BINS) {
    const id = `sfc-barb-${spd}`;
    if (!map.hasImage(id)) {
      map.addImage(id, canvasToImageData(drawBarb(spd)), { pixelRatio: PR });
    }
  }
  for (const cov of SKY_COVERS) {
    const id = `sfc-sky-${cov}`;
    if (!map.hasImage(id)) {
      const cover = cov === "MISSING" ? "" : cov;
      map.addImage(id, canvasToImageData(drawSky(cover)), { pixelRatio: PR });
    }
  }
}
