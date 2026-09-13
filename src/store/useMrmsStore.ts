import { create } from "zustand";
import { BACKEND_BASE } from "../lib/apiConfig";

/**
 * Which MRMS product is on the map, and what is known about it.
 *
 * MRMS is one layer with a hundred faces: the map only ever shows a single
 * grid, so the choice of product belongs here rather than in the layer module,
 * the same way the radar's product picker works. Switching product replaces
 * the image in place instead of adding a second one.
 */

export interface MrmsProduct {
  id: string;
  label: string;
  group: string;
  units: string;
  /** Whether the CURRENT region publishes it. Coverage differs: Alaska carries
   *  no rotation tracks, the island domains no lightning or FLASH. */
  available: boolean;
}

export interface MrmsRegion {
  id: string;
  label: string;
}

export interface MrmsFrame {
  key: string;
  unix: number;
}

export interface MrmsMeta {
  product: string;
  label: string;
  group: string;
  units: string;
  region: string;
  key: string;
  unix: number;
  vmin: number;
  vmax: number;
  /** The colour ramp as hex stops, straight from the table that drew the
   *  pixels — so the legend cannot disagree with the image. */
  bar: string[];
  /** west, south, east, north of the whole product domain — what the crop may
   *  not exceed. */
  domain: [number, number, number, number];
  /** Ground size of one output pixel, in km. */
  resolutionKm: number;
  source: string;
}

interface MrmsState {
  products: MrmsProduct[];
  regions: MrmsRegion[];
  product: string;
  region: string;
  frames: MrmsFrame[];
  /** The frame on screen; "" means whatever is newest. */
  frameKey: string;
  meta: MrmsMeta | null;
  loading: boolean;
  error: string | null;

  loadCatalog: (region?: string) => Promise<void>;
  setProduct: (id: string) => void;
  setRegion: (id: string) => void;
  setFrameKey: (key: string) => void;
  setFrames: (frames: MrmsFrame[]) => void;
  setMeta: (meta: MrmsMeta | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useMrmsStore = create<MrmsState>((set, get) => ({
  products: [],
  regions: [],
  product: "cref",
  region: "conus",
  frames: [],
  frameKey: "",
  meta: null,
  loading: false,
  error: null,

  loadCatalog: async (region) => {
    const want = region ?? get().region;
    // Unlike a product list that never changes, this one is per region, so it
    // is refetched on every region change rather than cached once forever.
    try {
      const res = await fetch(
        `${BACKEND_BASE}/api/mrms/catalog?region=${encodeURIComponent(want)}`,
      );
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const json = (await res.json()) as {
        products: MrmsProduct[];
        regions: MrmsRegion[];
        region: string;
        defaultProduct: string;
        defaultRegion: string;
      };
      // A slow answer for a region the user has already left would otherwise
      // overwrite the right list with a stale one.
      if (get().region !== want) return;

      const chosen = get().product || json.defaultProduct;
      const stillThere = json.products.find((p) => p.id === chosen)?.available;
      set({
        products: json.products,
        regions: json.regions,
        // Landing on a region that does not carry what you were looking at is
        // not an error to report -- it is a fall back to something it does
        // carry, which for every region is the composite.
        product: stillThere ? chosen : json.defaultProduct,
        error: null,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // A frame key belongs to the product it was listed under, so it has to go
  // when the product does -- otherwise the next render asks for a filename
  // that only exists in the previous product's directory.
  setProduct: (product) => set({ product, frameKey: "", frames: [], meta: null }),
  // A region change invalidates the frame list for the same reason a product
  // change does: the filenames live in that region's directory and nowhere
  // else. Not every product exists in every region, so a miss here is a normal
  // "no frames", not a fault.
  setRegion: (region) => {
    set({ region, frameKey: "", frames: [], meta: null, error: null });
    void get().loadCatalog(region);
  },
  setFrameKey: (frameKey) => set({ frameKey }),
  setFrames: (frames) => set({ frames }),
  setMeta: (meta) => set({ meta }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
