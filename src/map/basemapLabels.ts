import type { Map as MapLibreMap } from "maplibre-gl";

import { BASEMAP_PLACE_LAYERS } from "./basemaps";

/**
 * Who has asked for the basemap's own place names to be hidden, per map.
 *
 * Products that cover the basemap draw place names over themselves and hide
 * the basemap's copies. More than one can be on at once -- satellite under the
 * analyses -- so each holds the hide and the names come back only when the last
 * one lets go, not when the first one is switched off.
 */
const holders = new WeakMap<MapLibreMap, Set<string>>();

export function holdBasemapLabels(map: MapLibreMap, owner: string, hide: boolean): void {
  const set = holders.get(map) ?? new Set<string>();
  if (hide) set.add(owner);
  else set.delete(owner);
  holders.set(map, set);
  const visibility = set.size > 0 ? "none" : "visible";
  for (const id of BASEMAP_PLACE_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
  }
}
