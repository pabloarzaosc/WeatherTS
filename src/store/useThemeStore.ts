import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "auto" follows the user's local clock -- see resolveTheme() in lib/theme.ts. */
export type ThemeMode = "light" | "dark" | "auto";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: "auto",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "weatherts-theme",
      version: 1,
    },
  ),
);
