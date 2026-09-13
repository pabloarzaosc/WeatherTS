import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

import type { ChaserPresence } from "../lib/chasers";
import { requireAccount } from "./useAccountGate";

/**
 * Live chaser positions, and whether this device is broadcasting its own.
 *
 * `sharing` is persisted so the choice survives a restart, but the actual
 * broadcast is re-established by ChaserController on mount -- persisting a flag
 * is not the same as silently resuming a location broadcast, and the controller
 * still has to get a fix (and therefore the browser's permission) first.
 */
interface ChaserState {
  /** Opt-in: broadcast this device's position to the others. */
  sharing: boolean;
  /** Channel state, for the indicator. */
  status: "off" | "joining" | "live" | "error";
  /** Everyone else currently on the channel. */
  chasers: ChaserPresence[];
  /** Why sharing could not start, e.g. location permission refused. */
  shareError: string | null;
  /** This device's own last fix while sharing, so the map can show where you
   *  are putting yourself on everyone else's screen. */
  myPosition: { lat: number; lon: number; heading: number | null } | null;
  /** Which chaser's card is open, by presence id. */
  selectedId: string | null;

  setSharing: (sharing: boolean) => void;
  setStatus: (status: ChaserState["status"]) => void;
  setChasers: (chasers: ChaserPresence[]) => void;
  setShareError: (message: string | null) => void;
  setMyPosition: (p: ChaserState["myPosition"]) => void;
  select: (id: string | null) => void;
}

export const useChaserStore = create<ChaserState>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        sharing: false,
        status: "off",
        chasers: [],
        shareError: null,
        myPosition: null,
        selectedId: null,

        // Flipping the switch clears any previous failure, so a refused
        // permission from last time isn't still on screen after a retry.
        // Switching off also drops the last known position: leaving a "you are
        // here" dot up after you stopped sharing would misrepresent what other
        // people can currently see.
        // Broadcasting puts a name on a position, and without an account there
        // is no name to put on it -- so switching on asks for one first.
        setSharing: (sharing) => {
          if (sharing && !requireAccount("share")) return;
          set(sharing ? { sharing, shareError: null } : { sharing, shareError: null, myPosition: null });
        },
        setStatus: (status) => set({ status }),
        setChasers: (chasers) => set({ chasers }),
        setShareError: (shareError) => set({ shareError }),
        setMyPosition: (myPosition) => set({ myPosition }),
        select: (selectedId) => set({ selectedId }),
      }),
      {
        name: "weatherts-chasers",
        version: 1,
        // Only the choice is remembered. Positions are live state and must
        // never be written to disk.
        partialize: (s) => ({ sharing: s.sharing }),
      },
    ),
  ),
);
