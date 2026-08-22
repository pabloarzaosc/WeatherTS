import { useEffect } from "react";
import type { GeoJSONSource } from "maplibre-gl";

import { getMap } from "../map/mapInstance";
import { useAlertStore } from "../store/useAlertStore";
import {
  alertsToFeatureCollection,
  alertWindow,
  applyCachedZoneGeometries,
  enrichAlertZoneGeometries,
  fetchActiveAlerts,
  fetchAlertsAt,
} from "../lib/nwsAlerts";
import { ALERT_SOURCE } from "../layers/modules/alertsLayer";

const POLL_MS = 180_000; // refresh active alerts every 3 min
const PRUNE_MS = 15_000; // drop expired alerts every 15 s

/** Inside this of now, the live feed already answers correctly and is cheaper
 *  than the archive query, so scrubbing near the leading edge stays live. */
const LIVE_SLACK_S = 600;
/** Scrubbing drags through many frames; wait for it to settle before asking. */
const SCRUB_DEBOUNCE_MS = 350;
/** Refetching per second of scrub would be pointless -- alerts change on the
 *  order of minutes, so requests are shared across a bucket of frames. */
const BUCKET_S = 300;

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

    /**
     * The alerts that were running at a scrubbed-to instant.
     *
     * Zone shapes matter MORE here than live, not less. Warnings carry their own
     * polygon and expire within the hour, so the further back the loop is
     * scrubbed the more of what is left is zone-based -- watches, advisories --
     * and skipping enrichment drew none of them. At twenty hours back that was
     * 59 of 86 alerts with nothing to draw, which reads as "there were no alerts
     * at that hour". The zone geometries are batched and cached in IndexedDB for
     * a month, so this is one round of requests on the first scrub and free
     * afterwards.
     *
     * Painted in two stages: the polygons first, so dragging still feels
     * immediate, then the same set again once the zones resolve.
     */
    const loadAt = async (unix: number) => {
      ctrl?.abort();
      ctrl = new AbortController();
      const signal = ctrl.signal;
      useAlertStore.getState().setStatus("loading", "reading alerts for this frame");
      try {
        const features = await fetchAlertsAt(unix, signal);
        if (signal.aborted) return;
        // Fill in from the zone cache before the first paint. Most alerts are
        // drawn from their zones rather than a polygon of their own, so painting
        // the raw response made them disappear and come back a few seconds
        // later on every scrub -- which reads as alerts flickering out.
        useAlertStore.getState().setFeatures(applyCachedZoneGeometries(features));
        useAlertStore
          .getState()
          .setStatus("loading", `${features.length} in force at this frame; mapping alert areas`);

        const enriched = await enrichAlertZoneGeometries(features, signal, (fetched, total) => {
          if (total > 0) {
            useAlertStore
              .getState()
              .setStatus(
                "loading",
                `${features.length} in force at this frame; zone shapes ${fetched}/${total}`,
              );
          }
        });
        if (signal.aborted) return;
        const mapped = enriched.filter((f) => f.geometry).length;
        useAlertStore.getState().setFeatures(enriched);
        useAlertStore
          .getState()
          .setStatus("ready", `${enriched.length} in force at this frame, ${mapped} mapped`);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          useAlertStore.getState().setStatus("error", (err as Error).message);
        }
      }
    };

    // Which frame the alert set currently belongs to: null means live, a number
    // means a scrubbed-to bucket, and undefined means nothing has loaded yet.
    // That third state has to be distinct: when "not loaded" was also null, the
    // first syncToFrame saw bucket === loadedBucket and returned early, so the
    // live alerts were never fetched at all.
    const NOT_LOADED = undefined;
    let loadedBucket: number | null | undefined = NOT_LOADED;
    let scrubTimer = 0;

    const syncToFrame = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      const t = s.timeFilter;
      const live = t === null || t >= Date.now() / 1000 - LIVE_SLACK_S;
      const bucket = live ? null : Math.round(t / BUCKET_S);
      if (bucket === loadedBucket) return;
      loadedBucket = bucket;
      if (live) void load();
      else void loadAt(t);
    };

    const onTimeFilter = () => {
      window.clearTimeout(scrubTimer);
      scrubTimer = window.setTimeout(syncToFrame, SCRUB_DEBOUNCE_MS);
    };

    const prune = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      // In archive mode "expired" is the whole point -- pruning against the wall
      // clock would delete exactly the warnings being replayed.
      if (loadedBucket !== null) return;
      // `expires` is when the TEXT lapses and has to be reissued; `ends` is when
      // the hazard is over. NWS routinely keeps an alert active well past its
      // expires -- measured 113 of 400 in the live feed, mostly marine and heat
      // products -- so pruning on expires deleted a quarter of the map every
      // fifteen seconds and the poll only put them back three minutes later.
      // Same window alertWindow defines, so the map, the list and this agree.
      //
      // Only the END is tested: a large share of the feed is pre-issued, and
      // dropping anything whose `effective` has not arrived would hide exactly
      // those.
      const now = Date.now() / 1000;
      const live = s.features.filter((f) => alertWindow(f.alert).end > now);
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
          // Switching the layer back on has nothing loaded, same as mount.
          loadedBucket = NOT_LOADED;
          syncToFrame();
        } else {
          ctrl?.abort();
          useAlertStore.getState().setFeatures([]);
          draw();
        }
      },
    );
    const unsubFeatures = useAlertStore.subscribe((s) => s.features, draw);
    const unsubTime = useAlertStore.subscribe((s) => s.timeFilter, onTimeFilter);

    const pollTimer = window.setInterval(() => {
      // Only the live set goes stale; a past frame's alerts are already settled.
      if (useAlertStore.getState().active && loadedBucket === null) load();
    }, POLL_MS);
    const pruneTimer = window.setInterval(prune, PRUNE_MS);

    if (useAlertStore.getState().active) syncToFrame(); // layer already on at mount

    return () => {
      unsubActive();
      unsubFeatures();
      unsubTime();
      window.clearTimeout(scrubTimer);
      window.clearInterval(pollTimer);
      window.clearInterval(pruneTimer);
      ctrl?.abort();
    };
  }, []);

  return null;
}
