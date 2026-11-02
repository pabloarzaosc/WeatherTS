import { create } from "zustand";
import { persist } from "zustand/middleware";

/** The four blocks of the product info panel. */
export type InfoBlock = "scan" | "sampling" | "radar" | "pointer";

interface ProductInfoState {
  open: boolean;
  /** Folded blocks keep a one-line summary; remembered across sessions. */
  folded: Partial<Record<InfoBlock, boolean>>;
  setOpen: (open: boolean) => void;
  toggleFold: (block: InfoBlock) => void;
}

export const useProductInfoStore = create<ProductInfoState>()(
  persist(
    (set, get) => ({
      open: false,
      folded: {},
      setOpen: (open) => set({ open }),
      toggleFold: (block) => set({ folded: { ...get().folded, [block]: !get().folded[block] } }),
    }),
    { name: "weatherts-product-info" },
  ),
);
