import { useEffect } from "react";
import type { GeoJSONSource } from "maplibre-gl";

import { getMap } from "../map/mapInstance";
import { useAlertStore } from "../store/useAlertStore";
import { alertsToFeatureCollection, enrichAlertZoneGeometries, fetchActiveAlerts } from "../lib/nwsAlerts";
import { ALERT_SOURCE } from "../layers/modules/alertsLayer";

const POLL_MS = 180_000; // refresh active alerts every 3 min
const PRUNE_MS = 15_000; // drop expired alerts every 15 s

/**
 * The alerts brain (renders nothing). When the alerts layer is on it fetches
 * api.weather.gov, feeds the map source, refreshes periodically, and removes
 * alerts from the map the moment they expire.
 */
export function AlertController() {
  useEffect(() => {
    let ctrl: AbortController | null = null;

    const draw = () => {
      const map = getMap();
      const src = map?.getSource(ALERT_SOURCE) as GeoJSONSource | undefined;
      if (!src) return;
      src.setData(alertsToFeatureCollection(useAlertStore.getState().features));
    };

    const load = async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      useAlertStore.getState().setStatus("loading");
      try {
        const features = await fetchActiveAlerts(ctrl.signal);
        useAlertStore.getState().setStatus("loading", `${features.length} active; mapping alert areas`);

        const enriched = await enrichAlertZoneGeometries(features, ctrl.signal, (fetched, total) => {
          if (total > 0) {
            useAlertStore
              .getState()
              .setStatus("loading", `${features.length} active; zone shapes ${fetched}/${total}`);
          }
        });
        const enrichedMapped = enriched.filter((f) => f.geometry).length;
        useAlertStore.getState().setFeatures(enriched);
        useAlertStore.getState().setStatus("ready", `${enriched.length} active, ${enrichedMapped} mapped`);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          useAlertStore.getState().setStatus("error", (err as Error).message);
        }
      }
    };

    const prune = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      const now = Date.now();
      const live = s.features.filter((f) => {
        const exp = Date.parse(f.alert.expires);
        return Number.isNaN(exp) || exp > now;
      });
      if (live.length !== s.features.length) {
        s.setFeatures(live);
        if (s.selectedIds.length > 0) {
          const liveIds = new Set(live.map((f) => f.alert.id));
          const selectedIds = s.selectedIds.filter((id) => liveIds.has(id));
          if (selectedIds.length !== s.selectedIds.length) {
            if (selectedIds.length > 0) s.selectMany(selectedIds);
            else s.select(null);
          }
        }
      }
    };

    const unsubActive = useAlertStore.subscribe(
      (s) => s.active,
      (active) => {
        if (active) {
          load();
        } else {
          ctrl?.abort();
          useAlertStore.getState().setFeatures([]);
          draw();
        }
      },
    );
    const unsubFeatures = useAlertStore.subscribe((s) => s.features, draw);

    const pollTimer = window.setInterval(() => {
      if (useAlertStore.getState().active) load();
    }, POLL_MS);
    const pruneTimer = window.setInterval(prune, PRUNE_MS);

    if (useAlertStore.getState().active) load(); // layer already on at mount

    return () => {
      unsubActive();
      unsubFeatures();
      window.clearInterval(pollTimer);
      window.clearInterval(pruneTimer);
      ctrl?.abort();
    };
  }, []);

  return null;
}
