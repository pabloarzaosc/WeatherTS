import { create } from "zustand";
import type { Session, User } from "@supabase/supabase-js";

import { forgetDirectory } from "../lib/chasers";
import {
  fetchProfile,
  getSession,
  graceRemaining,
  markVerified,
  onAuthChange,
  saveProfile,
  signOut as authSignOut,
  supabase,
  type Profile,
  type ProfileEdit,
} from "../lib/auth";

/**
 * Who is signed in.
 *
 * `status` is what the gate reads, and it has four answers rather than a
 * boolean because they need different screens: still asking, nobody, someone,
 * and someone whose session cannot be checked right now.
 */
export type AuthStatus = "checking" | "signedOut" | "signedIn" | "offline";

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  /** Set when a recovery link brought us in: the app asks for a new password
   *  before it opens, because that is the only thing this session is for. */
  recovering: boolean;
  banned: boolean;

  init: () => () => void;
  refreshProfile: () => Promise<void>;
  updateProfile: (edit: ProfileEdit) => Promise<void>;
  setRecovering: (recovering: boolean) => void;
  signOut: () => Promise<void>;
}

let unsub: (() => void) | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "checking",
  session: null,
  user: null,
  profile: null,
  recovering: false,
  banned: false,

  init: () => {
    // Called from a React effect that can run twice in development; the second
    // call must not leave two listeners writing the same state.
    unsub?.();

    const adopt = async (session: Session | null) => {
      // Who you are decides which profile rows you can read, so anything
      // remembered about other people belongs to the previous session.
      forgetDirectory();
      if (!session) {
        set({
          status: graceRemaining() > 0 ? "offline" : "signedOut",
          session: null,
          user: null,
          profile: null,
        });
        return;
      }
      const profile = await fetchProfile(session.user.id).catch(() => null);
      // A banned account is signed straight back out: keeping the session alive
      // would leave it able to write as itself.
      if (profile && profile.active === false) {
        await authSignOut();
        set({ status: "signedOut", session: null, user: null, profile: null, banned: true });
        return;
      }
      markVerified(profile?.username ?? null);
      set({ status: "signedIn", session, user: session.user, profile, banned: false });
    };

    unsub = onAuthChange((session) => {
      // PASSWORD_RECOVERY arrives as a normal session; the flag is what stops
      // the app opening behind the reset form.
      void adopt(session);
    });

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") set({ recovering: true });
    });

    void getSession()
      .then(adopt)
      .catch(() => {
        set({ status: graceRemaining() > 0 ? "offline" : "signedOut" });
      });

    return () => {
      unsub?.();
      unsub = null;
      data.subscription.unsubscribe();
    };
  },

  refreshProfile: async () => {
    const uid = get().user?.id;
    if (!uid) return;
    const profile = await fetchProfile(uid).catch(() => null);
    if (profile) set({ profile });
  },

  updateProfile: async (edit) => {
    const uid = get().user?.id;
    if (!uid) throw new Error("Not signed in.");
    const profile = await saveProfile(uid, edit);
    markVerified(profile.username);
    set({ profile });
  },

  setRecovering: (recovering) => set({ recovering }),

  signOut: async () => {
    await authSignOut();
    set({ status: "signedOut", session: null, user: null, profile: null, recovering: false });
  },
}));
