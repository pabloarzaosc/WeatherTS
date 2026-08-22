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
      } else if (!useChaserStore.getState().sharing) {
        // Only actually leave when nothing else needs the channel.
        void leaveChasers();
        store.setStatus("off");
        store.setChasers([]);
      }
    };

    const wanted = () => {
      const s = useAppStore.getState();
      return (s.layers.chasers?.visible ?? false) || useChaserStore.getState().sharing;
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
    return () => {
      unsubLayer();
      unsubShare();
      void leaveChasers();
    };
  }, []);

  // --- broadcasting -------------------------------------------------------
  useEffect(() => {
    let stopWatch: (() => void) | null = null;

    const begin = async () => {
      const store = useChaserStore.getState();
      // The handle from the live profile, because that is the key the other
      // clients look up to find your name and picture. cachedUsername is the
      // same string written at sign-in, kept as the fallback for the moment
      // before the profile row has loaded.
      const name = useAuthStore.getState().profile?.username || cachedUsername() || "chaser";
      await startSharing(name);
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
              : err.message || "Could not read this device's location.",
          );
        },
      );
    };

    const end = () => {
      stopWatch?.();
      stopWatch = null;
      void stopSharing();
    };

    if (useChaserStore.getState().sharing) void begin();

    const unsub = useChaserStore.subscribe(
      (s) => s.sharing,
      (sharing) => {
        if (sharing) void begin();
        else end();
      },
    );
    return () => {
      unsub();
      end();
    };
  }, []);

  return null;
}
