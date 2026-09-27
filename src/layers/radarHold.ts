import type { Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from "maplibre-gl";

import type { NexradSite } from "../lib/nexrad";
import { useNexradStore } from "../store/useNexradStore";
import { markerUnderPoint } from "./clickPriority";

/**
 * Press and hold anywhere on the map to switch to the radar nearest that spot.
 *
 * A chase moves from one radar's range into the next; finding the next one's
 * badge among a dozen, or its name in a list, is the slow way. Holding on the
 * storm itself picks the radar that sees it best -- the closest, where the beam
 * is lowest. A ring fills under the pointer while held, so a click never turns
 * into a switch by accident, and the radar's name and distance show when it
 * lands.
 */

/** How long to hold, and how far the pointer may wander meanwhile. */
const HOLD_MS = 550;
const SLOP_PX = 7;
/** The ring appears only once a press is clearly not a click. */
const SHOW_AFTER_MS = 140;
/** Past this range no radar sees the spot usefully. */
const MAX_KM = 460;

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The online radar nearest a point, and how far it is. */
export function nearestRadar(lat: number, lon: number): { site: NexradSite; km: number } | null {
  let best: { site: NexradSite; km: number } | null = null;
  for (const site of useNexradStore.getState().sites) {
    if (site.online === false) continue;
    const km = distanceKm(lat, lon, site.lat, site.lon);
    if (!best || km < best.km) best = { site, km };
  }
  return best;
}

/** Switch to the radar nearest a point. Returns what happened, for the caller to show. */
export function switchToNearestRadar(lat: number, lon: number): { text: string; ok: boolean } {
  const near = nearestRadar(lat, lon);
  if (!near) return { text: "No radar list yet", ok: false };
  if (near.km > MAX_KM) return { text: `Nearest radar ${near.site.icao} is ${Math.round(near.km)} km away`, ok: false };
  const store = useNexradStore.getState();
  const km = `${Math.round(near.km)} km`;
  if (store.site === near.site.id) return { text: `Already on ${near.site.icao} · ${km}`, ok: true };
  store.selectSite(near.site.id);
  return { text: `${near.site.icao} · ${near.site.name} · ${km}`, ok: true };
}

/** Attach the gesture to one map. Returns the detach. */
export function attachRadarHold(map: MapLibreMap): () => void {
  const container = map.getCanvasContainer();
  let timer: number | null = null;
  let showTimer: number | null = null;
  let start: { x: number; y: number } | null = null;
  let ring: HTMLDivElement | null = null;

  const clearRing = () => {
    ring?.remove();
    ring = null;
  };
  const cancel = () => {
    if (timer != null) window.clearTimeout(timer);
    if (showTimer != null) window.clearTimeout(showTimer);
    timer = showTimer = null;
    start = null;
    if (ring && !ring.classList.contains("is-done")) clearRing();
  };

  const place = (el: HTMLElement, x: number, y: number) => {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const toast = (x: number, y: number, text: string, ok: boolean) => {
    const el = document.createElement("div");
    el.className = `radarhold-toast${ok ? "" : " is-warn"}`;
    el.textContent = text;
    place(el, x, y);
    map.getContainer().appendChild(el);
    window.setTimeout(() => el.remove(), 2200);
  };

  const begin = (e: MapMouseEvent | MapTouchEvent, touches = 1) => {
    // One finger, the main button, nothing held: a pinch, a right-click or a
    // shift-drag box is not this.
    const oe = e.originalEvent as MouseEvent & TouchEvent;
    if (touches !== 1 || (oe.button != null && oe.button !== 0) || oe.shiftKey || oe.ctrlKey || oe.metaKey) return;
    // Pressing a radar's badge, a report or any other marker is that thing's click.
    const badge = map.getLayer("nexrad-sites-label") && map.queryRenderedFeatures(e.point, { layers: ["nexrad-sites-label"] }).length > 0;
    if (badge || markerUnderPoint(map, e.point)) return;
    cancel();
    const point = { x: e.point.x, y: e.point.y };
    const lngLat = e.lngLat;
    start = point;
    showTimer = window.setTimeout(() => {
      clearRing();
      ring = document.createElement("div");
      ring.className = "radarhold";
      ring.style.setProperty("--hold", `${HOLD_MS - SHOW_AFTER_MS}ms`);
      place(ring, point.x, point.y);
      map.getContainer().appendChild(ring);
    }, SHOW_AFTER_MS);
    timer = window.setTimeout(() => {
      timer = null;
      const result = switchToNearestRadar(lngLat.lat, lngLat.lng);
      if (ring) {
        ring.classList.add("is-done");
        const done = ring;
        window.setTimeout(() => {
          done.remove();
          if (ring === done) ring = null;
        }, 380);
      }
      toast(point.x, point.y, result.text, result.ok);
      // The release that follows is the end of the hold, not a click on the map.
      container.addEventListener(
        "click",
        (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        },
        { capture: true, once: true },
      );
    }, HOLD_MS);
  };

  const move = (e: MapMouseEvent | MapTouchEvent) => {
    if (!start) return;
    if (Math.hypot(e.point.x - start.x, e.point.y - start.y) > SLOP_PX) cancel();
  };

  const onMouseDown = (e: MapMouseEvent) => begin(e);
  const onTouchStart = (e: MapTouchEvent) => begin(e, e.points.length);
  const onUp = () => cancel();
  map.on("mousedown", onMouseDown);
  map.on("touchstart", onTouchStart);
  map.on("mousemove", move);
  map.on("touchmove", move);
  map.on("mouseup", onUp);
  map.on("touchend", onUp);
  map.on("dragstart", onUp);
  map.on("zoomstart", onUp);
  map.on("contextmenu", onUp);

  return () => {
    cancel();
    clearRing();
    map.off("mousedown", onMouseDown);
    map.off("touchstart", onTouchStart);
    map.off("mousemove", move);
    map.off("touchmove", move);
    map.off("mouseup", onUp);
    map.off("touchend", onUp);
    map.off("dragstart", onUp);
    map.off("zoomstart", onUp);
    map.off("contextmenu", onUp);
  };
}
