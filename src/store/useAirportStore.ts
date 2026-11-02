import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The airport page: which airport is open, and how far back its charts reach. */
interface AirportState {
  icao: string | null;
  /** Hours of METARs on the charts (the AWC keeps about 15 days). */
  hours: number;
  open: (icao: string) => void;
  close: () => void;
  setHours: (h: number) => void;
}

export const AIRPORT_RANGES = [12, 24, 48, 72, 168, 360] as const;

export const useAirportStore = create<AirportState>()(
  persist(
    (set) => ({
      icao: null,
      hours: 24,
      open: (icao) => set({ icao: icao.trim().toUpperCase() }),
      close: () => set({ icao: null }),
      setHours: (hours) => set({ hours }),
    }),
    { name: "weatherts.airport", partialize: (s) => ({ hours: s.hours }) },
  ),
);
