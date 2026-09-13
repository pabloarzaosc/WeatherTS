import { useEffect } from "react";

import {
  joinChasers,
  leaveChasers,
  pushFix,
  startSharing,
  stopSharing,
} from "../lib/chasers";
import { watchPosition } from "../lib/geolocate";
import { cachedUsername } from "../lib/auth";
import { hasAccount } from "../store/useAccountGate";
import { useAuthStore } from "../store/useAuthStore";
import { useAppStore } from "../store/useAppStore";
import { useChaserStore } from "../store/useChaserStore";

/**
 * Wires the chasers channel to the app (renders nothing).
 *
 * Two switches feed it, and they stay independent:
 *   * the Chasers LAYER being on means join the channel and watch
 *   * the SHARING preference means also broadcast this device
 *
 * Sharing therefore keeps working with the layer switched off (you broadcast
 * without cluttering your own map), and the layer works without sharing.
 *
 * Both need an account. The channel refuses anyone without a session, and a
 * broadcast has no name to go out under, so for a visitor without one neither
 * starts -- whatever the switches say -- until they sign in.
 */
export function ChaserController() {
  // --- watching -----------------------------------------------------------
  useEffect(() => {
    const apply = (on: boolean) => {
      const store = useChaserStore.getState();
      if (on) {
        void joinChasers({
          onChasers: store.setChasers,
          onStatus: store.setStatus,
        });
      } else if (!hasAccount() || !useChaserStore.getState().sharing) {
        // Only actually leave when nothing else needs the channel -- or when
        // there is no account left to be on it with.
        void leaveChasers();
        store.setStatus("off");
        store.setChasers([]);
      }
    };

    const wanted = () => {
      const s = useAppStore.getState();
      return hasAccount() && ((s.layers.chasers?.visible ?? false) || useChaserStore.getState().sharing);
    };

    apply(wanted());
    const unsubLayer = useAppStore.subscribe(
      (s) => s.layers.chasers?.visible ?? false,
      () => apply(wanted()),
    );
    const unsubShare = useChaserStore.subscribe(
      (s) => s.sharing,
      () => apply(wanted()),
    );
    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.status !== prev.status) apply(wanted());
    });
    return () => {
      unsubLayer();
      unsubShare();
      unsubAuth();
      void leaveChasers();
    };
  }, []);

  // --- broadcasting -------------------------------------------------------
  useEffect(() => {
    let stopWatch: (() => void) | null = null;
    // Whether a broadcast is running, so a sign-in and the switch arriving in
    // the same moment cannot start two.
    let live = false;

    const begin = async () => {
      if (live) return;
      live = true;
      const store = useChaserStore.getState();
      // The handle from the live profile, because that is the key the other
      // clients look up to find your name and picture. cachedUsername is the
      // same string written at sign-in, kept as the fallback for the moment
      // before the profile row has loaded.
      const name = useAuthStore.getState().profile?.username || cachedUsername() || "chaser";
      await startSharing(name);
      // Stopped while that was on its way: starting the watch now would leave
      // one running that nothing is going to clear.
      if (!live) return;
      stopWatch = watchPosition(
        (fix) => {
          void pushFix(fix);
          useChaserStore.getState().setMyPosition({
            lat: fix.lat,
            lon: fix.lon,
            heading: fix.heading,
          });
          store.setShareError(null);
        },
        (err) => {
          // Off first, THEN the message: setSharing clears shareError, so
          // writing the message first would wipe it in the next statement.
          // Turning the switch off matters most either way -- an indicator that
          // stays lit while nothing is being sent is the one unacceptable state.
          useChaserStore.getState().setSharing(false);
          useChaserStore.getState().setShareError(
            err.code === err.PERMISSION_DENIED
              ? "Location permission refused."
              : // Not err.message. What the browser puts there for this case is
                // "Failed to query location from network service. Check the API
                // key and network connection" -- a message about a key the user
                // does not have and cannot set, on a service they never chose.
                // By the time this fires the IP fallback has failed too, so the
                // only true thing left to say is that neither route worked.
                "Could not read this device's location, and the network lookup failed too.",
          );
        },
      );
    };

    const end = () => {
      live = false;
      stopWatch?.();
      stopWatch = null;
      void stopSharing();
    };

    const sync = () => {
      if (useChaserStore.getState().sharing && hasAccount()) void begin();
      else end();
    };

    sync();

    const unsub = useChaserStore.subscribe((s) => s.sharing, sync);
    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.status !== prev.status) sync();
    });
    return () => {
      unsub();
      unsubAuth();
      end();
    };
  }, []);

  return null;
}
