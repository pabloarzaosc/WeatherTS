import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

import { getLayerModule, getLayerModules } from "../layers/registry";
import { DEFAULT_BASEMAP } from "../map/basemaps";
import type { MeasureMode } from "../lib/measure";

export type Projection = "mercator" | "globe";
/** Left data-panel tabs. */
export type DataView = "catalog" | "layers" | "settings";
/** Catalog sub-tabs (only "default" is populated in Phase 1). */
export type CatalogTab = "default" | "my" | "favorite" | "advanced";
export type CoordFormat = "decimal" | "dms";

function coerceDataView(value: unknown): DataView {
  return value === "layers" || value === "settings" ? value : "catalog";
}

export interface LayerUIState {
  visible: boolean;
  opacity: number; // 0..1
}

interface AppState {
  // ---- view --------------------------------------------------------------
  projection: Projection;
  /** Which basemap the panes wear; see map/basemaps.ts for the roster. */
  basemapId: string;

  // ---- app shell ---------------------------------------------------------
  leftPanelOpen: boolean;
  dataView: DataView;
  catalogTab: CatalogTab;
  measureMode: MeasureMode;
  /** Split-screen: how many map panes are on screen. */
  paneCount: 1 | 2 | 4 | 6;

  // ---- product catalog (model + variable selection) ----------------------
  selectedModel: string | null;
  selectedVariable: string | null;

  // ---- preferences -------------------------------------------------------
  reduceMotion: boolean;
  coordFormat: CoordFormat;
  /** Display unit per radar product kind. Absent = that kind's default.
   *  Only affects what is printed; the colours are decided by the palette. */
  radarUnits: Record<string, string>;

  // ---- live map readout --------------------------------------------------
  cursor: { lng: number; lat: number } | null;
  zoom: number;

  // ---- layer system ------------------------------------------------------
  layers: Record<string, LayerUIState>;
  layerOrder: string[]; // bottom -> top

  // ---- actions -----------------------------------------------------------
  setProjection: (projection: Projection) => void;
  toggleProjection: () => void;
  setBasemap: (basemapId: string) => void;
  toggleLeftPanel: () => void;
  setDataView: (view: DataView) => void;
  setCatalogTab: (tab: CatalogTab) => void;
  setSelectedModel: (id: string | null) => void;
  setSelectedVariable: (id: string | null) => void;
  setMeasureMode: (mode: MeasureMode) => void;
  setPaneCount: (n: 1 | 2 | 4 | 6) => void;
  setReduceMotion: (reduceMotion: boolean) => void;
  setCoordFormat: (coordFormat: CoordFormat) => void;
  setRadarUnit: (kind: string, unit: string) => void;
  setReadout: (lng: number, lat: number, zoom: number) => void;
  setZoom: (zoom: number) => void;
  initLayers: () => void;
  toggleLayer: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  setLayerVisibilityBatch: (updates: Record<string, boolean>) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  moveLayer: (id: string, dir: "up" | "down") => void;
}

function applyOutlookSideEffects(layers: Record<string, LayerUIState>, id: string, visible: boolean) {
  if (!visible || getLayerModule(id)?.category !== "outlooks") return;
  const alerts = layers["nws-alerts"];
  if (alerts) layers["nws-alerts"] = { ...alerts, visible: false };
}

/**
 * First-run default for the side panel. On a phone it's an overlay covering
 * most of the map, so opening the app to a wall of panel hides the thing you
 * came for. Only the default -- once the user toggles it, that's persisted.
 */
function panelOpenByDefault(): boolean {
  if (typeof window === "undefined") return true;
  return !window.matchMedia("(max-width: 820px), (max-height: 500px)").matches;
}

export const useAppStore = create<AppState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        projection: "mercator",
        basemapId: DEFAULT_BASEMAP,
        leftPanelOpen: panelOpenByDefault(),
        dataView: "catalog",
        catalogTab: "default",
        selectedModel: "Global::USA::GFS",
        selectedVariable: "Surface::TEMPERATURE::2m Temperature",
        measureMode: "off",
        paneCount: 1,
        reduceMotion: false,
        coordFormat: "decimal",
        radarUnits: {},
        cursor: null,
        zoom: 4,
        layers: {},
        layerOrder: [],

        setProjection: (projection) => set({ projection }),
        setBasemap: (basemapId) => set({ basemapId }),
        toggleProjection: () =>
          set({ projection: get().projection === "globe" ? "mercator" : "globe" }),

        toggleLeftPanel: () => set({ leftPanelOpen: !get().leftPanelOpen }),
        setDataView: (dataView) => set({ dataView, leftPanelOpen: true }),
        setCatalogTab: (catalogTab) => set({ catalogTab }),
        setSelectedModel: (selectedModel) => set({ selectedModel }),
        setSelectedVariable: (selectedVariable) => set({ selectedVariable }),
        setMeasureMode: (measureMode) => set({ measureMode }),
        setPaneCount: (paneCount) => set({ paneCount }),

        setReduceMotion: (reduceMotion) => set({ reduceMotion }),
        setCoordFormat: (coordFormat) => set({ coordFormat }),
        setRadarUnit: (kind, unit) =>
          set({ radarUnits: { ...get().radarUnits, [kind]: unit } }),

        setReadout: (lng, lat, zoom) => set({ cursor: { lng, lat }, zoom }),
        setZoom: (zoom) => set({ zoom }),

        initLayers: () => {
          const layers: Record<string, LayerUIState> = {};
          const layerOrder: string[] = [];
          for (const module of getLayerModules()) {
            layers[module.id] = {
              visible: module.defaultVisible,
              opacity: module.defaultOpacity,
            };
            layerOrder.push(module.id);
          }
          set({ layers, layerOrder });
        },

        toggleLayer: (id) => {
          const layer = get().layers[id];
          if (!layer) return;
          const visible = !layer.visible;
          const layers = { ...get().layers, [id]: { ...layer, visible } };
          applyOutlookSideEffects(layers, id, visible);
          set({ layers });
        },
        setLayerVisible: (id, visible) => {
          const layer = get().layers[id];
          if (!layer) return;
          const layers = { ...get().layers, [id]: { ...layer, visible } };
          applyOutlookSideEffects(layers, id, visible);
          set({ layers });
        },
        setLayerVisibilityBatch: (updates) => {
          const layers = { ...get().layers };
          for (const [id, visible] of Object.entries(updates)) {
            const layer = layers[id];
            if (!layer) continue;
            layers[id] = { ...layer, visible };
            applyOutlookSideEffects(layers, id, visible);
          }
          set({ layers });
        },
        setLayerOpacity: (id, opacity) => {
          const layer = get().layers[id];
          if (!layer) return;
          set({ layers: { ...get().layers, [id]: { ...layer, opacity } } });
        },
        moveLayer: (id, dir) => {
          const order = [...get().layerOrder];
          const i = order.indexOf(id);
          if (i < 0) return;
          const j = dir === "up" ? i + 1 : i - 1;
          if (j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          set({ layerOrder: order });
        },
      }),
      {
        name: "weatherts-ui",
        merge: (persisted, current) => {
          const incoming = persisted as Partial<AppState> | undefined;
          return {
            ...current,
            ...incoming,
            dataView: coerceDataView(incoming?.dataView),
          };
        },
        partialize: (s) => ({
          projection: s.projection,
          basemapId: s.basemapId,
          reduceMotion: s.reduceMotion,
          coordFormat: s.coordFormat,
          radarUnits: s.radarUnits,
          paneCount: s.paneCount,
          leftPanelOpen: s.leftPanelOpen,
          dataView: s.dataView,
          selectedModel: s.selectedModel,
          selectedVariable: s.selectedVariable,
        }),
      },
    ),
  ),
);
