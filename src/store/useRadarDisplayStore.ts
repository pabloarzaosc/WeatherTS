import { create } from "zustand";

/**
 * Radar display state that belongs to one pane rather than to the app
 * (the shared display options are settings: radar.gate*, radar.flash*,
 * radar.scanLine* in settings/schema.ts).
 *
 *  - trail: the pane shows the maximum value trail -- each point's highest
 *    value since the loop's first frame (lib/radarDisplay.ts). T toggles it on
 *    the focused pane.
 *  - opacity: the pane's own radar opacity; unset = the Radar layer's opacity
 *    from Layers.
 */
interface RadarDisplayState {
  trail: Record<string, boolean>;
  opacity: Record<string, number>;
  setTrail: (paneId: string, on: boolean) => void;
  toggleTrail: (paneId: string) => void;
  /** null = follow the layer opacity again. */
  setPaneOpacity: (paneId: string, value: number | null) => void;
  /** A pane closed: forget what it had. */
  forget: (paneId: string) => void;
}

export const useRadarDisplayStore = create<RadarDisplayState>((set, get) => ({
  trail: {},
  opacity: {},
  setTrail: (paneId, on) => {
    if (!!get().trail[paneId] === on) return;
    const trail = { ...get().trail };
    if (on) trail[paneId] = true;
    else delete trail[paneId];
    set({ trail });
  },
  toggleTrail: (paneId) => get().setTrail(paneId, !get().trail[paneId]),
  setPaneOpacity: (paneId, value) => {
    const opacity = { ...get().opacity };
    if (value == null) delete opacity[paneId];
    else opacity[paneId] = Math.max(0, Math.min(1, value));
    set({ opacity });
  },
  forget: (paneId) => {
    const { trail, opacity } = get();
    if (!(paneId in trail) && !(paneId in opacity)) return;
    const t = { ...trail };
    const o = { ...opacity };
    delete t[paneId];
    delete o[paneId];
    set({ trail: t, opacity: o });
  },
}));

/** Is the trail on for this pane? (outside React) */
export const trailOn = (paneId: string | null | undefined): boolean =>
  !!paneId && !!useRadarDisplayStore.getState().trail[paneId];
