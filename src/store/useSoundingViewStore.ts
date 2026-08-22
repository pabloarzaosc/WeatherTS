import { create } from "zustand";

/** SHARPpy's parcel names, which is what the renderer selects by. */
export const PARCELS = ["SFC", "ML", "MU", "EFF", "FCST", "USER"] as const;
export type Parcel = (typeof PARCELS)[number];

export const PARCEL_LABELS: Record<Parcel, string> = {
  SFC: "Surface-based",
  ML: "Mixed-layer",
  MU: "Most-unstable",
  EFF: "Effective inflow",
  FCST: "Forecast surface",
  USER: "Custom pressure",
};

export const STORM_MOTIONS = [
  "right",
  "left",
  "mean",
  "corfidi-up",
  "corfidi-down",
  "custom",
] as const;
export type StormMotion = (typeof STORM_MOTIONS)[number];

export const STORM_MOTION_LABELS: Record<StormMotion, string> = {
  right: "Bunkers right",
  left: "Bunkers left",
  mean: "0-6 km mean wind",
  "corfidi-up": "Corfidi upshear",
  "corfidi-down": "Corfidi downshear",
  custom: "Custom",
};

interface SoundingViewState {
  parcel: Parcel;
  /** Only read when parcel is USER. */
  parcelPressure: number;
  motion: StormMotion;
  /** Only read when motion is custom. */
  motionDir: number;
  motionSpd: number;

  setParcel: (p: Parcel) => void;
  setParcelPressure: (mb: number) => void;
  setMotion: (m: StormMotion) => void;
  setMotionDir: (deg: number) => void;
  setMotionSpd: (kt: number) => void;
  reset: () => void;
}

const DEFAULTS = {
  // MU is SHARPpy's own default, so opening a sounding looks the same as before
  // anyone touched these controls.
  parcel: "MU" as Parcel,
  parcelPressure: 900,
  motion: "right" as StormMotion,
  motionDir: 240,
  motionSpd: 30,
};

export const useSoundingViewStore = create<SoundingViewState>((set) => ({
  ...DEFAULTS,
  setParcel: (parcel) => set({ parcel }),
  setParcelPressure: (parcelPressure) => set({ parcelPressure }),
  setMotion: (motion) => set({ motion }),
  setMotionDir: (motionDir) => set({ motionDir }),
  setMotionSpd: (motionSpd) => set({ motionSpd }),
  reset: () => set(DEFAULTS),
}));

/**
 * The plot options as query parameters.
 *
 * Emitted only when they differ from what the renderer would do anyway, so an
 * untouched viewer produces the exact URL it always did -- and keeps hitting
 * the same cache entry on the server.
 */
export function viewQuery(): string {
  const s = useSoundingViewStore.getState();
  const q: string[] = [];
  if (s.parcel !== "MU") q.push(`parcel=${s.parcel}`);
  if (s.parcel === "USER") q.push(`parcelPressure=${s.parcelPressure}`);
  if (s.motion !== "right") q.push(`stormMotion=${s.motion}`);
  if (s.motion === "custom") {
    q.push(`stormMotionDir=${s.motionDir}`, `stormMotionSpd=${s.motionSpd}`);
  }
  return q.length ? `&${q.join("&")}` : "";
}
