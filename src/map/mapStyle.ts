/**
 * The basemap styles themselves now live in ./basemaps, one entry per look.
 * This module stays as the map's camera defaults, plus a re-export so the old
 * import path keeps working.
 */
export { BASEMAPS, DEFAULT_BASEMAP, basemapInfo, buildBasemapStyle } from "./basemaps";
export type { BasemapGroup, BasemapInfo } from "./basemaps";

/** Continental US, per the Phase 1 spec. */
export const INITIAL_VIEW = {
  center: [-98, 39] as [number, number],
  zoom: 4,
};
