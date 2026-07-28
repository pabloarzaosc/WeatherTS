import { useEffect, useRef } from "react";

import { alertsInArea, focusAlert } from "../lib/alertFocus";
import { alertPriority, type AlertFeature } from "../lib/nwsAlerts";
import { useAlertStore } from "../store/useAlertStore";
import { useWatchStore } from "../store/useWatchStore";

const api = () =>
  (
    window as unknown as {
      electronAPI?: {
        notifyAlert?: (p: { id: string; title: string; body: string }) => void;
        onNotificationClick?: (cb: (id: string | null) => void) => void;
      };
    }
  ).electronAPI;

function summarise(f: AlertFeature): { title: string; body: string } {
  const a = f.alert;
  const where = (a.areaDesc ?? "").split(";")[0]?.trim();
  return {
    title: a.event || "Weather alert",
    body: [where, a.headline].filter(Boolean).join(" — ").slice(0, 220) || "New alert in your watch area",
  };
}

/**
 * Announces alerts that enter the watch area, and takes the user to one when a
 * notification is clicked. Headless.
 */
export function WatchController() {
  const features = useAlertStore((s) => s.features);
  // Alerts already active when the area was set are not news. Seeding on the
  // first pass stops a fresh launch firing a dozen toasts at once.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    api()?.onNotificationClick?.((id) => {
      if (!id) return;
      const f = useAlertStore.getState().features.find((x) => x.alert.id === id);
      if (f) focusAlert(f.geometry, { withRadar: true });
    });
  }, []);

  useEffect(() => {
    const { enabled, center, notify, minPriority } = useWatchStore.getState();
    if (!enabled || !center) {
      // Forget history while off, so re-arming does not replay a backlog.
      seen.current = null;
      return;
    }

    const hits = alertsInArea(features, center, useWatchStore.getState().radiusKm);
    if (seen.current === null) {
      seen.current = hits;
      return;
    }

    for (const f of features) {
      if (!hits.has(f.alert.id) || seen.current.has(f.alert.id)) continue;
      if (notify && alertPriority(f.alert) >= minPriority) {
        const { title, body } = summarise(f);
        api()?.notifyAlert?.({ id: f.alert.id, title, body });
      }
    }
    seen.current = hits;
  }, [features]);

  return null;
}
