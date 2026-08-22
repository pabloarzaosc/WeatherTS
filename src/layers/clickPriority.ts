import type { Map as MapLibreMap, Point } from "maplibre-gl";

/**
 * Which layer wins a click when several are stacked under the cursor.
 *
 * MapLibre has no arbitration here: every layer with a click listener under
 * the pointer fires, in registration order. So clicking a radar dot that
 * happens to sit inside a warning polygon opened the sounding AND swapped the
 * side panel to that warning -- two unrelated things from one click, with the
 * one the user aimed at buried.
 *
 * The rule is the obvious one: a small deliberate marker beats the area fill
 * it is drawn on top of. Markers register themselves here when they go on the
 * map, and the area layers ask before acting.
 */
const markerLayers = new Set<string>();

export function registerMarkerLayers(ids: string[]): void {
  for (const id of ids) markerLayers.add(id);
}

export function unregisterMarkerLayers(ids: string[]): void {
  for (const id of ids) markerLayers.delete(id);
}

/** True when a registered marker is under `point` on this map. */
export function markerUnderPoint(map: MapLibreMap, point: Point): boolean {
  // Only layers actually in this map's style: querying a missing layer throws,
  // and panes do not all carry the same layers.
  const present = [...markerLayers].filter((id) => map.getLayer(id));
  if (!present.length) return false;
  return map.queryRenderedFeatures(point, { layers: present }).length > 0;
}
