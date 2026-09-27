import { useEffect } from "react";
import type { GeoJSONSource } from "maplibre-gl";

import { allMaps } from "../map/mapInstance";
import { useAlertStore } from "../store/useAlertStore";
import {
  alertsToFeatureCollection,
  alertWindow,
  applyCachedZoneGeometries,
  enrichAlertZoneGeometries,
  fetchActiveAlerts,
  fetchAlertsIssued,
  ISSUE_LOOKBACK_S,
  type AlertFeature,
} from "../lib/nwsAlerts";
import { ALERT_SOURCE } from "../layers/modules/alertsLayer";

const POLL_MS = 180_000; // refresh active alerts every 3 min
const PRUNE_MS = 15_000; // drop expired alerts every 15 s

/** Inside this of now, the live feed already answers correctly and is cheaper
 *  than the archive query, so scrubbing near the leading edge stays live. */
const LIVE_SLACK_S = 600;

/**
 * The past is read in stretches of issue time, kept once read. A frame of the
 * timeline needs every alert issued in the twelve hours before it (a watch is
 * issued hours ahead and runs six to eight), so a frame is the union of three
 * stretches, and the next frame of a playing loop almost always the same three:
 * the alerts in force at each frame are then the map's filter on what is here,
 * not a request per frame -- which could not keep up with a loop playing, so
 * the alerts lagged behind the frames or froze on one.
 */
const WINDOW_S = 6 * 3600;
/** Stretches read at once: api.weather.gov answers each in a second or two. */
const WINDOW_PARALLEL = 2;
/** A stretch that reaches to now is read again after this long. */
const OPEN_WINDOW_TTL_S = 300;
/** Stretches kept: two weeks of history, a week-long loop and some. */
const MAX_WINDOWS = 60;
/**
 * A timeline span up to this long puts every stretch it needs on the map at
 * once, whichever frame is on screen: the set then stays the same while a play
 * moves the time, and the map's filter picks what is in force at each frame.
 * Put together per frame instead, the set changed each time the time crossed a
 * stretch's edge -- four times a lap of a four-hour loop -- and each change sent
 * thousands of polygons to the map again: the play froze for two seconds every
 * few frames (Pablo, 2026-09-26). Longer spans fall back to per frame.
 */
const SPAN_UNION_S = 3 * 86400;

interface Stretch {
  features: AlertFeature[];
  /** When it was last read (unix s); 0 while never read. */
  readAt: number;
  /** Whether it ended before it was read: nothing more can be issued in it. */
  closed: boolean;
  loading: boolean;
}

/**
 * The alerts brain (renders nothing). When the alerts layer is on it fetches
 * api.weather.gov, feeds the map source, refreshes periodically, and removes
 * alerts from the map the moment they expire. When the timeline is on a past
 * instant it reads the alerts of that time -- of the timeline's whole span,
 * ahead of a play.
 */
export function AlertController() {
  useEffect(() => {
    let liveCtrl: AbortController | null = null;
    let life = new AbortController();
    let live: AlertFeature[] = [];
    let liveRead = false;
    const stretches = new Map<number, Stretch>();
    const queue: number[] = [];
    let running = 0;
    /** Bumped whenever what is here changes, so a frame that needs the same
     *  alerts as the last one costs no new GeoJSON. */
    let epoch = 0;
    let shownSig = "";

    const now = () => Date.now() / 1000;
    /** The status line, set only when it changes: compose runs on every frame. */
    const status = (st: "loading" | "ready", message: string) => {
      const s = useAlertStore.getState();
      if (s.status !== st || s.message !== message) s.setStatus(st, message);
    };
    const isPast = (t: number | null): t is number => t !== null && t < now() - LIVE_SLACK_S;
    /** The stretches holding every alert that can be in force at `t`. */
    const stretchesFor = (t: number): number[] => {
      const out: number[] = [];
      for (let w = Math.floor((t - ISSUE_LOOKBACK_S) / WINDOW_S); w <= Math.floor(t / WINDOW_S); w++) out.push(w);
      return out;
    };
    /** Every stretch of the timeline's span, when `t` is in it and the span is
     *  short enough to hold at once (SPAN_UNION_S); null otherwise. */
    const spanFor = (t: number, range: [number, number] | null): number[] | null => {
      if (!range || range[1] - range[0] > SPAN_UNION_S) return null;
      if (range[0] >= now() - LIVE_SLACK_S) return null; // all of it live: the live set answers
      if (t < range[0] - WINDOW_S || t > range[1] + WINDOW_S) return null;
      const out: number[] = [];
      const last = Math.min(range[1], now());
      for (let w = Math.floor((range[0] - ISSUE_LOOKBACK_S) / WINDOW_S); w <= Math.floor(last / WINDOW_S); w++) out.push(w);
      return out;
    };
    /** What of the live set the map shows: a poll that brings the same alerts
     *  (the same shapes known) changes nothing, and sends nothing to the map. */
    const liveSig = (features: AlertFeature[]): string =>
      features.map((f) => `${f.alert.id}${f.geometry ? "+" : "-"}`).join(",");

    // Every pane, not the focused one: with the screen split, only the pane
    // last clicked was getting new alerts, and a warning issued after the split
    // showed on one side of the screen and not the other.
    const draw = () => {
      const data = alertsToFeatureCollection(useAlertStore.getState().features);
      for (const map of allMaps()) {
        const src = map.getSource(ALERT_SOURCE) as GeoJSONSource | undefined;
        src?.setData(data);
      }
    };

    /** Put on the map what the timeline's instant needs: the live set now or
     *  ahead of now; the stretches around it (and the live set, for anything
     *  still running since then) for a past instant. The map and the list
     *  filter it down to what is in force at that instant. */
    const compose = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      const t = s.timeFilter;
      const span = t !== null ? spanFor(t, s.timeRange) : null;
      if (!span && !isPast(t)) {
        const sig = `live|${epoch}`;
        if (sig !== shownSig) {
          shownSig = sig;
          s.setFeatures(live);
        }
        if (liveRead) status("ready", `${live.length} active`);
        return;
      }
      const need = span ?? stretchesFor(t as number);
      const sig = `${need.join(",")}|${epoch}`;
      const waiting = need.filter((w) => !stretches.get(w)?.readAt).length;
      if (sig !== shownSig) {
        shownSig = sig;
        const byId = new Map<string, AlertFeature>();
        for (const w of need) for (const f of stretches.get(w)?.features ?? []) byId.set(f.alert.id, f);
        for (const f of live) if (!byId.has(f.alert.id)) byId.set(f.alert.id, f);
        s.setFeatures([...byId.values()]);
      }
      if (waiting > 0) status("loading", "reading the alerts of this time");
      else status("ready", "alerts of this time");
    };

    const load = async () => {
      liveCtrl?.abort();
      liveCtrl = new AbortController();
      const signal = liveCtrl.signal;
      if (!isPast(useAlertStore.getState().timeFilter)) useAlertStore.getState().setStatus("loading");
      try {
        const features = await fetchActiveAlerts(signal);
        const cached = applyCachedZoneGeometries(features);
        if (!liveRead || liveSig(cached) !== liveSig(live)) {
          live = cached;
          epoch++;
        }
        liveRead = true;
        compose();
        const enriched = await enrichAlertZoneGeometries(features, signal, (fetched, total) => {
          if (total > 0 && !isPast(useAlertStore.getState().timeFilter)) {
            useAlertStore
              .getState()
              .setStatus("loading", `${features.length} active; zone shapes ${fetched}/${total}`);
          }
        });
        if (liveSig(enriched) !== liveSig(live)) {
          live = enriched;
          epoch++;
        }
        compose();
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          useAlertStore.getState().setStatus("error", (err as Error).message);
        }
      }
    };

    /**
     * One stretch of the past. Zone shapes matter MORE here than live, not
     * less: warnings carry their own polygon and expire within the hour, so the
     * further back the more of what is left is zone-based -- watches,
     * advisories -- and skipping them drew none (59 of 86 alerts twenty hours
     * back). Painted twice: from the zone cache (IndexedDB, a month) at once,
     * then again once the missing zones come.
     */
    const readStretch = async (w: number) => {
      const signal = life.signal;
      const entry = stretches.get(w) ?? { features: [], readAt: 0, closed: false, loading: false };
      entry.loading = true;
      stretches.set(w, entry);
      const end = (w + 1) * WINDOW_S;
      const asked = now();
      try {
        const raw = await fetchAlertsIssued(w * WINDOW_S, Math.min(end, asked), signal);
        if (signal.aborted) return;
        entry.features = applyCachedZoneGeometries(raw);
        entry.readAt = asked;
        entry.closed = end <= asked;
        epoch++;
        compose();
        const enriched = await enrichAlertZoneGeometries(raw, signal);
        if (signal.aborted) return;
        entry.features = enriched;
        epoch++;
        compose();
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Tried: not again until the stretch would be read again anyway.
        entry.readAt = entry.readAt || asked;
        epoch++;
        compose();
      } finally {
        entry.loading = false;
      }
    };

    const pump = () => {
      while (running < WINDOW_PARALLEL && queue.length > 0) {
        const w = queue.shift()!;
        running++;
        void readStretch(w).finally(() => {
          running--;
          pump();
        });
      }
    };

    /** Read stretch `w` unless it is here (or coming); `first` jumps the queue. */
    const want = (w: number, first: boolean) => {
      const e = stretches.get(w);
      if (e?.loading) return;
      if (e && e.readAt && (e.closed || now() - e.readAt < OPEN_WINDOW_TTL_S)) return;
      const at = queue.indexOf(w);
      if (at >= 0) {
        if (!first) return;
        queue.splice(at, 1);
      }
      if (first) queue.unshift(w);
      else queue.push(w);
    };

    /** The stretches the instant on screen needs, first; then the rest of the
     *  timeline's span, so a play finds them here. */
    const fetchPast = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      const t = s.timeFilter;
      const range = s.timeRange;
      if (range && range[0] < now() - LIVE_SLACK_S) {
        const last = Math.min(range[1], now());
        for (let w = Math.floor((range[0] - ISSUE_LOOKBACK_S) / WINDOW_S); w <= Math.floor(last / WINDOW_S); w++) {
          want(w, false);
        }
      }
      if (isPast(t)) for (const w of stretchesFor(t).reverse()) want(w, true);
      pump();
      // Only a span's worth of history is kept.
      if (stretches.size > MAX_WINDOWS) {
        const keepFrom = Math.floor(((range?.[0] ?? t ?? now()) - ISSUE_LOOKBACK_S) / WINDOW_S);
        const keepTo = Math.floor((range?.[1] ?? t ?? now()) / WINDOW_S);
        for (const [w, e] of stretches) {
          if ((w < keepFrom || w > keepTo) && !e.loading) stretches.delete(w);
        }
      }
    };

    const onTime = () => {
      compose();
      fetchPast();
    };

    const prune = () => {
      const s = useAlertStore.getState();
      if (!s.active) return;
      // `expires` is when the TEXT lapses and has to be reissued; `ends` is when
      // the hazard is over. NWS routinely keeps an alert active well past its
      // expires -- measured 113 of 400 in the live feed, mostly marine and heat
      // products -- so pruning on expires deleted a quarter of the map every
      // fifteen seconds and the poll only put them back three minutes later.
      // Same window alertWindow defines, so the map, the list and this agree.
      //
      // Only the END is tested: a large share of the feed is pre-issued, and
      // dropping anything whose `effective` has not arrived would hide exactly
      // those. The past's stretches are never pruned: expired is their point.
      const t = now();
      const kept = live.filter((f) => alertWindow(f.alert).end > t);
      if (kept.length === live.length) return;
      live = kept;
      epoch++;
      compose();
      if (!isPast(s.timeFilter) && s.selectedIds.length > 0) {
        const liveIds = new Set(kept.map((f) => f.alert.id));
        const selectedIds = s.selectedIds.filter((id) => liveIds.has(id));
        if (selectedIds.length !== s.selectedIds.length) {
          if (selectedIds.length > 0) s.selectMany(selectedIds);
          else s.select(null);
        }
      }
    };

    const start = () => {
      shownSig = "";
      void load();
      onTime();
    };

    const unsubActive = useAlertStore.subscribe(
      (s) => s.active,
      (active) => {
        if (active) {
          start();
        } else {
          liveCtrl?.abort();
          life.abort();
          life = new AbortController();
          stretches.clear();
          queue.length = 0;
          live = [];
          liveRead = false;
          shownSig = "";
          useAlertStore.getState().setFeatures([]);
          draw();
        }
      },
    );
    const unsubFeatures = useAlertStore.subscribe((s) => s.features, draw);
    const unsubTime = useAlertStore.subscribe((s) => s.timeFilter, onTime);
    const unsubRange = useAlertStore.subscribe((s) => s.timeRange, fetchPast);

    const pollTimer = window.setInterval(() => {
      // The live set goes stale; so does the stretch reaching to now.
      if (!useAlertStore.getState().active) return;
      void load();
      fetchPast();
    }, POLL_MS);
    const pruneTimer = window.setInterval(prune, PRUNE_MS);

    if (useAlertStore.getState().active) start(); // layer already on at mount

    return () => {
      unsubActive();
      unsubFeatures();
      unsubTime();
      unsubRange();
      window.clearInterval(pollTimer);
      window.clearInterval(pruneTimer);
      liveCtrl?.abort();
      life.abort();
    };
  }, []);

  return null;
}
