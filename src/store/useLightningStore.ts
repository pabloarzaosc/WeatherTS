import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

import type { LightningSat } from "../lib/lightning";

/** Trailing windows. 60 min is offered but costs ~180 granules on a cold load. */
export const WINDOWS = [5, 15, 30, 60] as const;

export const SATS: { id: LightningSat; label: string; hint: string }[] = [
  { id: "east", label: "GOES-East", hint: "Americas and the Atlantic (75.2°W)" },
  { id: "west", label: "GOES-West", hint: "Pacific and the western states (137°W)" },
  { id: "both", label: "Both", hint: "Full two-satellite coverage — twice the granules" },
];

interface LightningState {
  /** Trailing window in minutes. */
  minutes: number;
  sat: LightningSat;
  /** Size each flash by its energy instead of drawing them all the same. */
  sizeByEnergy: boolean;
  /** Draw the counter over the map. */
  counter: boolean;
  /**
   * Whether toggling the layer applies to every pane or only the focused one.
   * Split screen is the whole reason this exists: comparing products across
   * panes means sometimes you want lightning on one of them only.
   */
  sync: boolean;
  /** Keep the camera on the newest flash as it arrives. */
  followNewest: boolean;
  /**
   * Per-pane on/off, consulted only while `sync` is false. A missing entry
   * means on, so turning sync off never blanks a pane by surprise.
   */
  panes: Record<string, boolean>;

  busy: boolean;
  error: string | null;
  count: number;
  perMinute: number;
  rateSeries: number[];
  newestUnix: number | null;
  granules: number;
  satellites: string[];
  /** When the last successful poll landed, for the "updated" readout. */
  updatedAt: number | null;
  /** End of the displayed window. Null means the live edge. */
  endUnix: number | null;

  setMinutes: (m: number) => void;
  setEndUnix: (unix: number | null) => void;
  setSat: (s: LightningSat) => void;
  setSizeByEnergy: (v: boolean) => void;
  setCounter: (v: boolean) => void;
  setSync: (v: boolean) => void;
  setFollowNewest: (v: boolean) => void;
  setPaneVisible: (paneId: string, on: boolean) => void;
  setStatus: (
    s: Partial<
      Pick<
        LightningState,
        | "busy"
        | "error"
        | "count"
        | "perMinute"
        | "rateSeries"
        | "newestUnix"
        | "granules"
        | "satellites"
        | "updatedAt"
      >
    >,
  ) => void;
}

export const useLightningStore = create<LightningState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        minutes: 15,
        sat: "east",
        sizeByEnergy: false,
        counter: true,
        sync: true,
        followNewest: false,
        panes: {},

        busy: false,
        error: null,
        count: 0,
        perMinute: 0,
        rateSeries: [],
        newestUnix: null,
        granules: 0,
        satellites: [],
        updatedAt: null,
        endUnix: null,

        setMinutes: (minutes) => set({ minutes }),
        setEndUnix: (endUnix) => set({ endUnix }),
        setSat: (sat) => set({ sat }),
        setSizeByEnergy: (sizeByEnergy) => set({ sizeByEnergy }),
        setCounter: (counter) => set({ counter }),
        setSync: (sync) => set({ sync }),
        setFollowNewest: (followNewest) => set({ followNewest }),
        setPaneVisible: (paneId, on) => set((s) => ({ panes: { ...s.panes, [paneId]: on } })),
        setStatus: (s) => set(s),
      }),
      {
        name: "weatherts.lightning",
        partialize: (s) => ({
          minutes: s.minutes,
          sat: s.sat,
          sizeByEnergy: s.sizeByEnergy,
          counter: s.counter,
          sync: s.sync,
          followNewest: s.followNewest,
        }),
      },
    ),
  ),
);
