import { create } from "zustand";
import { persist } from "zustand/middleware";

/** A saved arrangement of the map: which layers are on, and how strong. */
export interface Workspace {
  id: string;
  name: string;
  savedAt: number;
  /** layer id -> { visible, opacity }, exactly the shape useAppStore holds. */
  layers: Record<string, { visible: boolean; opacity: number }>;
}

interface CatalogState {
  /** Layer ids the user starred. */
  favorites: string[];
  /** Saved layer arrangements, newest first. */
  workspaces: Workspace[];

  toggleFavorite: (layerId: string) => void;
  isFavorite: (layerId: string) => boolean;
  saveWorkspace: (name: string, layers: Workspace["layers"]) => void;
  deleteWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
}

export const useCatalogStore = create<CatalogState>()(
  persist(
    (set, get) => ({
      favorites: [],
      workspaces: [],

      toggleFavorite: (layerId) =>
        set((s) => ({
          favorites: s.favorites.includes(layerId)
            ? s.favorites.filter((id) => id !== layerId)
            : [...s.favorites, layerId],
        })),
      isFavorite: (layerId) => get().favorites.includes(layerId),

      saveWorkspace: (name, layers) =>
        set((s) => ({
          workspaces: [
            {
              // Date.now() alone collides when two are saved in the same
              // millisecond, which a double-click can do.
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: name.trim() || "Untitled",
              savedAt: Date.now(),
              // Copied, not referenced: the store this came from keeps mutating
              // as the user toggles layers, and a saved workspace must not.
              layers: JSON.parse(JSON.stringify(layers)) as Workspace["layers"],
            },
            ...s.workspaces,
          ],
        })),
      deleteWorkspace: (id) =>
        set((s) => ({ workspaces: s.workspaces.filter((w) => w.id !== id) })),
      renameWorkspace: (id, name) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, name: name.trim() || w.name } : w,
          ),
        })),
    }),
    { name: "weatherts-catalog" },
  ),
);
