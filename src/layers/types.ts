import type { Map as MapLibreMap } from "maplibre-gl";

export type LayerCategoryId = "alerts" | "outlooks" | "reference" | "boundaries" | "weather";

export interface LayerCategoryMeta {
  id: LayerCategoryId;
  label: string;
}

/** Category groups for the layer panel, in display order (top -> bottom). */
export const LAYER_CATEGORIES: LayerCategoryMeta[] = [
  { id: "alerts", label: "Alerts (NWS)" },
  { id: "outlooks", label: "Outlooks" },
  { id: "weather", label: "Weather Products" }, // reserved for future phases
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

  /** Add this module's source(s) + map layer(s). May be async (e.g. fetch). */
  addTo(map: MapLibreMap): void | Promise<void>;
  /** Remove everything this module added. Must be safe if already absent. */
  removeFrom(map: MapLibreMap): void;
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
}
