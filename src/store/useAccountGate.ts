import { create } from "zustand";

import { useAuthStore } from "./useAuthStore";

/**
 * What a visitor without an account can reach, and the prompts that tell them.
 *
 * The app opens for everyone. Radar, warnings, outlooks and soundings come off
 * public feeds and never needed an account. What does need one is the part tied
 * to a person -- where they are, the other chasers, the pins people publish --
 * and each of those asks at the moment someone reaches for it, instead of the
 * whole window being locked up front.
 */

/** The account-only features. Each has its own explanation in the prompt. */
export type AccountFeature = "location" | "share" | "chasers" | "homes";

export type AuthMode = "signin" | "signup";

interface AccountGateState {
  /** The sign-in screen, opened over the app; null while it is closed. */
  auth: AuthMode | null;
  /** The feature a guest just reached for, while its prompt is up. */
  need: AccountFeature | null;
  openAuth: (mode: AuthMode) => void;
  closeAuth: () => void;
  ask: (feature: AccountFeature) => void;
  dismiss: () => void;
}

export const useAccountGate = create<AccountGateState>((set) => ({
  auth: null,
  need: null,
  // Opening the sign-in screen answers whatever prompt led to it.
  openAuth: (auth) => set({ auth, need: null }),
  closeAuth: () => set({ auth: null }),
  ask: (need) => set({ need }),
  dismiss: () => set({ need: null }),
}));

/** Signed in, or inside the offline grace a verified sign-in leaves behind. */
export const hasAccount = (): boolean => {
  const { status } = useAuthStore.getState();
  return status === "signedIn" || status === "offline";
};

/**
 * The check an account-only feature makes before doing anything. True means go
 * ahead; otherwise the prompt for `feature` goes up and the answer is false, so
 * the caller just stops.
 */
export function requireAccount(feature: AccountFeature): boolean {
  if (hasAccount()) return true;
  useAccountGate.getState().ask(feature);
  return false;
}
