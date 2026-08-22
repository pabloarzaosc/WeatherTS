import { create } from "zustand";

/** One mesoscale discussion, as the backend hands it over. */
export interface MesoscaleMD {
  id: string;
  number: number | null;
  label: string;
  /** SPC's severe MD, or WPC's precipitation discussion. */
  kind: "md" | "mpd";
  validUntil: string | null;
  valid: string | null;
  /** The window the discussion is in force, so it can ride the timeline. */
  validStartUnix: number | null;
  validEndUnix: number | null;
  issued: string | null;
  /** What the discussion is about, which is what colours it. */
  hazard: "severe" | "flood" | "other";
  areas: string | null;
  concerning: string | null;
  summary: string | null;
  discussion: string | null;
  /** The complete product text, for the full report. */
  text: string;
  url: string;
  /** Polygon centroid, so the card can anchor without re-deriving it. */
  lon: number;
  lat: number;
}

/**
 * Which discussion is open, in the same two steps the storm cells use: the map
 * card names it, and clicking that card opens the whole product.
 */
interface MesoscaleState {
  mds: MesoscaleMD[];
  /** The one whose map card is open. */
  selectedId: string | null;
  /** The one whose full report is open. */
  reportId: string | null;

  setMds: (mds: MesoscaleMD[]) => void;
  select: (id: string | null) => void;
  openReport: (id: string | null) => void;
}

export const useMesoscaleStore = create<MesoscaleState>((set) => ({
  mds: [],
  selectedId: null,
  reportId: null,
  setMds: (mds) => set({ mds }),
  select: (selectedId) => set({ selectedId }),
  openReport: (reportId) => set({ reportId }),
}));
