import type { Map as MapLibreMap } from "maplibre-gl";

import type { AccountFeature } from "../store/useAccountGate";

export type LayerCategoryId =
  | "alerts"
  | "chasers"
  | "outlooks"
  | "aviation"
  | "reference"
  | "boundaries"
  | "weather";

export interface LayerCategoryMeta {
  id: LayerCategoryId;
  label: string;
}

/** Category groups for the layer panel, in display order (top -> bottom). */
export const LAYER_CATEGORIES: LayerCategoryMeta[] = [
  { id: "alerts", label: "Alerts" },
  // Second only to warnings: on a chase day, where the others are is checked
  // as often as the radar itself.
  { id: "chasers", label: "Chasers" },
  { id: "outlooks", label: "Outlooks" },
  { id: "weather", label: "Weather Products" }, // reserved for future phases
  { id: "aviation", label: "Aviation" },
  { id: "boundaries", label: "Political Boundaries" },
  { id: "reference", label: "Reference & Grid" },
];

/**
 * A self-contained map layer. This is the extension point for the whole app:
 * future phases add a product by exporting one of these and registering it in
 * layers/index.ts — the store, the layer panel and the map manager all consume
 * the registry, so nothing else needs to change.
 */
export interface LayerModule {
  id: string;
  name: string;
  description?: string;
  category: LayerCategoryId;
  /** Human-readable data source / attribution shown in the panel. */
  source: string;
  defaultVisible: boolean;
  defaultOpacity: number; // 0..1
  /**
   * Set on layers that show people rather than weather. Switching one on
   * without an account puts up that feature's account prompt instead, and one
   * already on when a visitor has no account stays off until they sign in.
   */
  requiresAccount?: AccountFeature;

  /** Add this module's source(s) + map layer(s). May be async (e.g. fetch). */
  addTo(map: MapLibreMap): void | Promise<void>;
  /**
   * Remove everything this module added. Must be safe if already absent.
   *
   * `styleSwap` is set when the map's style was just replaced and the module
   * goes straight back on (LayerManager.reset). Whatever is tied to this map
   * still goes -- store and map listeners, timers, DOM markers -- but not what
   * it shares with other panes or what the user has open: the alerts already
   * read, a selected report. A theme flip is not the layer being turned off.
   */
  removeFrom(map: MapLibreMap, styleSwap?: boolean): void;
  /** Apply opacity (0..1) to this module's map layers. */
  setOpacity(map: MapLibreMap, opacity: number): void;
  /** MapLibre layer ids this module owns, bottom -> top, used for z-ordering. */
  getLayerIds(): string[];
  /**
   * Ids that must stay above every other module regardless of layer order.
   * For outlines that have to stay readable over an opaque product underneath —
   * an alert polygon's border should never be buried by radar, even though its
   * fill should be. Applied after the normal ordering pass.
   */
  topLayerIds?(): string[];
  /**
   * Which module wins when several claim the top. Higher is nearer the front;
   * the default 0 keeps the previous behaviour, where the lift pass followed
   * the layer order and whichever module came last happened to end up above
   * the rest.
   */
  topPriority?: number;
}
