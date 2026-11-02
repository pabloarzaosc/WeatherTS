import { create } from "zustand";

import { fetchLocalWeather, type LocalWeather } from "../lib/localWeather";
import { currentFix } from "../lib/geolocate";
import { requireAccount } from "./useAccountGate";

/**
 * The Local weather card: which point it is for and what api.weather.gov said
 * about it. Opened from the map's right-click menu ("Local weather") or for
 * the device's own position ("My local weather").
 */

type Status = "idle" | "locating" | "loading" | "ready" | "error";

interface LocalWeatherState {
  open: boolean;
  lat: number | null;
  lon: number | null;
  /** "Your location" when it came from the device. */
  label: string | null;
  status: Status;
  error: string | null;
  data: LocalWeather | null;

  openAt: (lat: number, lon: number, label?: string | null) => void;
  openMine: () => Promise<void>;
  reload: () => void;
  close: () => void;
}

let ac: AbortController | null = null;

export const useLocalWeatherStore = create<LocalWeatherState>((set, get) => ({
  open: false,
  lat: null,
  lon: null,
  label: null,
  status: "idle",
  error: null,
  data: null,

  openAt: (lat, lon, label = null) => {
    ac?.abort();
    const ctl = new AbortController();
    ac = ctl;
    set({ open: true, lat, lon, label, status: "loading", error: null, data: null });
    fetchLocalWeather(lat, lon, ctl.signal)
      .then((data) => {
        if (!ctl.signal.aborted) set({ data, status: "ready" });
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) set({ status: "error", error: String((e as Error)?.message ?? e) });
      });
  },

  openMine: async () => {
    // Locating reads the device's position (or an IP lookup when it cannot):
    // the same account gate as "Go to my location".
    if (!requireAccount("location")) return;
    ac?.abort();
    set({ open: true, status: "locating", error: null, data: null, label: "Your location" });
    try {
      const fix = await currentFix({ maximumAge: 120_000 });
      if (!get().open) return;
      get().openAt(fix.lat, fix.lon, fix.source === "device" ? "Your location" : "Your location (approximate)");
    } catch (e) {
      const denied = (e as GeolocationPositionError | undefined)?.code === 1;
      set({ status: "error", error: denied ? "Location access was refused." : "Could not find your location." });
    }
  },

  reload: () => {
    const { lat, lon, label } = get();
    if (lat != null && lon != null) get().openAt(lat, lon, label);
  },

  close: () => {
    ac?.abort();
    set({ open: false });
  },
}));

if (import.meta.env.DEV) {
  (window as unknown as { __local: unknown }).__local = useLocalWeatherStore;
}
