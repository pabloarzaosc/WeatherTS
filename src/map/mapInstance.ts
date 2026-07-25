import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Registry of the live MapLibre maps, one per pane.
 *
 * The app used to have exactly one map and a module-level holder. Split-screen
 * makes that N maps, but every tool (search, zoom, measure, the pixel readout,
 * the sounding menu) is written against "the map" -- so `getMap()` is kept and
 * now answers with the **focused** pane. Those call sites need no change; they
 * simply act on whichever pane the user is working in.
 */
const panes = new Map<string, MapLibreMap>();
let activeId: string | null = null;
const listeners = new Set<() => void>();

export const PRIMARY_PANE = "pane-0";

function notify() {
  for (const fn of listeners) fn();
}

/** Subscribe to pane registration / focus changes. */
export function subscribeMaps(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerMap(id: string, map: MapLibreMap | null): void {
  if (map) {
    panes.set(id, map);
    if (activeId === null) activeId = id;
  } else {
    panes.delete(id);
    if (activeId === id) activeId = panes.keys().next().value ?? null;
  }
  notify();
}

/** Focus a pane: `getMap()` and every tool built on it now target this one. */
export function setActivePane(id: string): void {
  if (!panes.has(id) || activeId === id) return;
  activeId = id;
  notify();
}

export function getActivePaneId(): string | null {
  return activeId;
}

/** The focused pane's map. */
export function getMap(): MapLibreMap | null {
  return activeId ? panes.get(activeId) ?? null : null;
}

export function getMapById(id: string): MapLibreMap | null {
  return panes.get(id) ?? null;
}

/** Which pane a map belongs to -- layers need this to draw their own pane's data. */
export function paneIdOf(map: MapLibreMap): string | null {
  for (const [id, m] of panes) if (m === map) return id;
  return null;
}

/** Every live map, for things that must apply everywhere (e.g. camera sync). */
export function allMaps(): MapLibreMap[] {
  return [...panes.values()];
}

/** Back-compat for the single-map path: MapView still calls this. */
export function setMap(map: MapLibreMap | null): void {
  registerMap(PRIMARY_PANE, map);
}
