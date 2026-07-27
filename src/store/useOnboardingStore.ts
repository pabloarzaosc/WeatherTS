import { create } from "zustand";

/**
 * Drives the two first-run surfaces: Quick Start (a setup pass) and What's New
 * (the release log). Both can also be reopened from Settings, so the open state
 * lives here rather than inside either component.
 */

const K_SEEN_VERSION = "weatherts.whatsNew.seenVersion";
const K_QUICKSTART = "weatherts.quickStart.done";

/** localStorage is unavailable in some embeddings; never let that break boot. */
function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore -- these are conveniences, not state the app depends on */
  }
}

export const getSeenVersion = () => readKey(K_SEEN_VERSION);
export const markVersionSeen = (v: string) => writeKey(K_SEEN_VERSION, v);
export const quickStartDone = () => readKey(K_QUICKSTART) === "1";
export const markQuickStartDone = () => writeKey(K_QUICKSTART, "1");

interface OnboardingState {
  whatsNewOpen: boolean;
  quickStartOpen: boolean;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
  openQuickStart: () => void;
  closeQuickStart: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  whatsNewOpen: false,
  quickStartOpen: false,
  openWhatsNew: () => set({ whatsNewOpen: true }),
  closeWhatsNew: () => set({ whatsNewOpen: false }),
  openQuickStart: () => set({ quickStartOpen: true }),
  closeQuickStart: () => set({ quickStartOpen: false }),
}));
