import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * User-arranged layout.
 *
 * Two mechanisms, because the two kinds of surface behave differently:
 *
 *  * The big docked regions (side panel, alert rail) pick a SIDE. They reserve
 *    a column and push the map, so they cannot float without covering it.
 *  * The floating HUD overlays carry a free OFFSET. The offset is a delta on
 *    top of whatever the CSS anchors them to -- not an absolute position -- so
 *    they stay responsive: closing the panel or resizing the window still moves
 *    them correctly, and the user's nudge rides along.
 */

export type Side = "left" | "right";

export interface Offset {
  x: number;
  y: number;
}

/** The draggable HUD overlays. These are stable storage keys -- renaming one
 *  silently drops a user's saved position, so treat them as persisted data. */
export type DraggableId = "products" | "zoom" | "readout" | "colorbar" | "lightning";

interface LayoutState {
  panelSide: Side;
  alertSide: Side;
  offsets: Partial<Record<DraggableId, Offset>>;

  setPanelSide: (side: Side) => void;
  setAlertSide: (side: Side) => void;
  setOffset: (id: DraggableId, offset: Offset) => void;
  resetOffset: (id: DraggableId) => void;
  resetLayout: () => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      panelSide: "left",
      alertSide: "right",
      offsets: {},

      setPanelSide: (panelSide) => set({ panelSide }),
      setAlertSide: (alertSide) => set({ alertSide }),
      setOffset: (id, offset) => set((s) => ({ offsets: { ...s.offsets, [id]: offset } })),
      resetOffset: (id) =>
        set((s) => {
          const offsets = { ...s.offsets };
          delete offsets[id];
          return { offsets };
        }),
      resetLayout: () => set({ panelSide: "left", alertSide: "right", offsets: {} }),
    }),
    {
      name: "weatherts-layout",
      // Bump when the shape below changes; without a version, an old payload
      // rehydrates silently and the layout comes back subtly wrong.
      version: 1,
    },
  ),
);

/** True when anything has been moved from its default place. */
export function layoutIsCustom(s: LayoutState): boolean {
  return s.panelSide !== "left" || s.alertSide !== "right" || Object.keys(s.offsets).length > 0;
}
