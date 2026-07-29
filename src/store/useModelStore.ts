import { create } from "zustand";
import { persist } from "zustand/middleware";
import { subscribeWithSelector } from "zustand/middleware";

import { fetchModels, snapHour, type ModelInfo } from "../lib/modelFields";

/**
 * The app-wide model selection.
 *
 * Deliberately not owned by any one panel: the picker lives in the sidebar and
 * every model-driven product reads from here, so switching model re-drives all
 * of them at once instead of each panel keeping its own idea of "the model".
 * Today that is the pressure field; satellite and the rest plug into the same
 * two values.
 */
interface ModelState {
  /** Catalogue from the backend, empty until loaded. */
  models: ModelInfo[];
  modelId: string;
  /** Forecast hour into the run. Snapped to what the model publishes. */
  hour: number;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  setModel: (id: string) => void;
  setHour: (hour: number) => void;
  stepHour: (delta: number) => void;
}

// Matches the backend's default. The quarter-degree grid is the point: the half
// degree one visibly rounds short-wave troughs off the isobar pattern.
const DEFAULT_MODEL = "gfs-0p25";

export const useModelStore = create<ModelState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        models: [],
        modelId: DEFAULT_MODEL,
        hour: 0,
        loading: false,
        error: null,

        load: async () => {
          if (get().loading || get().models.length > 0) return;
          set({ loading: true, error: null });
          try {
            const { models, default: fallback } = await fetchModels();
            const current = get().modelId;
            // A persisted id from an older build may no longer exist.
            const modelId = models.some((m) => m.id === current) ? current : fallback;
            const model = models.find((m) => m.id === modelId) ?? null;
            set({ models, modelId, hour: snapHour(model, get().hour), loading: false });
          } catch (err) {
            set({ loading: false, error: err instanceof Error ? err.message : String(err) });
          }
        },

        setModel: (modelId) => {
          const model = get().models.find((m) => m.id === modelId) ?? null;
          // Hours do not line up across models -- HRRR stops at 48 where GFS
          // runs to 384 -- so carry the hour over to the nearest one that
          // exists rather than dropping the user back to f000.
          set({ modelId, hour: snapHour(model, get().hour) });
        },

        setHour: (hour) => {
          const model = get().models.find((m) => m.id === get().modelId) ?? null;
          set({ hour: snapHour(model, Math.max(0, hour)) });
        },

        stepHour: (delta) => {
          const { models, modelId, hour } = get();
          const model = models.find((m) => m.id === modelId);
          if (!model || model.hours.length === 0) {
            set({ hour: Math.max(0, hour + delta) });
            return;
          }
          const i = model.hours.indexOf(snapHour(model, hour));
          const next = Math.min(Math.max(i + delta, 0), model.hours.length - 1);
          set({ hour: model.hours[next] });
        },
      }),
      {
        name: "weatherts.model",
        // The catalogue is refetched every launch; only the choice is worth keeping.
        partialize: (s) => ({ modelId: s.modelId, hour: s.hour }),
        // v1 moved the default to the quarter-degree grid. A stored half-degree
        // choice is almost certainly the old default rather than a deliberate
        // pick, so it is carried over; anything else the user actually chose.
        version: 1,
        migrate: (persisted, from) => {
          const s = persisted as { modelId?: string; hour?: number } | undefined;
          if (from < 1 && s?.modelId === "gfs-0p50") return { ...s, modelId: DEFAULT_MODEL };
          return s as never;
        },
      },
    ),
  ),
);

/** The full record for the current selection, or null before the list loads. */
export const selectCurrentModel = (s: ModelState): ModelInfo | null =>
  s.models.find((m) => m.id === s.modelId) ?? null;
