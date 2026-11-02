import { useEffect } from "react";

import { allMaps } from "../map/mapInstance";
import { useAlertStore } from "../store/useAlertStore";
import { getSetting } from "../settings/useSettingsStore";
import { alertBounds, alertPriority, alertWindow, type AlertFeature, type NwsAlert } from "../lib/nwsAlerts";
import { alertUrgency, alertVtec } from "../lib/alertTiers";
import { alertFilters, alertFlashMs, alertSound, passesAlertFilters, tierOf } from "../lib/alertStyle";
import { flashAlert } from "../lib/alertFlash";
import { alertHiddenOnMap } from "../store/useAlertListStore";
import { installAudioUnlock, playAlertSound, renderAlertSound, soundLog } from "../lib/alertSounds";

/** An alert sounds only while it is this fresh. */
const FRESH_MS = 10 * 60_000;
/** While fresh alerts wait outside the view, look again this often. */
const VIEW_CHECK_MS = 4_000;
/** A flash for an alert reached by playback. */
const PLAYBACK_FLASH_MS = 2_500;

/** A VTEC action that makes something new: a new event, or more area. */
const NEW_ACTIONS = new Set(["NEW", "EXA", "EXB"]);

/**
 * New alerts: flashes them on the map and plays their sound (renders nothing).
 *
 * - Never on start: the alerts of the first live read are known already.
 * - Live only: the past's stretches are history, not news.
 * - An alert is new when it is an Alert (or a VTEC NEW/EXA/EXB), or an update
 *   that reaches a higher tier than its event had: a warning upgraded to PDS
 *   sounds, a routine continuation does not.
 * - It sounds while issued in the last 10 minutes, the first time it is in
 *   view on any pane -- so a fresh warning panned to later still sounds.
 * - One sound per batch, the most urgent one's; a new sound replaces a playing one.
 * - Filters (types switched off, states, offices) silence what they hide.
 */
export function AlertNotifier() {
  useEffect(() => {
    installAudioUnlock();
    let baseline = false;
    /** Ids judged already: sounded, flashed, or too old to. */
    const handled = new Set<string>();
    /** Fresh, new and not yet in view: id -> alert. */
    const waiting = new Map<string, AlertFeature>();
    /** The highest tier rank seen per VTEC event. */
    const eventRank = new Map<string, number>();
    let viewTimer: number | null = null;

    const isLive = () => {
      const t = useAlertStore.getState().timeFilter;
      return t === null || t >= Date.now() / 1000 - 600;
    };
    const rankOf = (a: NwsAlert) => tierOf(a)?.rank ?? 0;
    const sentMs = (a: NwsAlert) => {
      const t = Date.parse(a.sent || a.effective);
      return Number.isNaN(t) ? 0 : t;
    };

    /** Whether an alert is news, and remember its event's tier either way. */
    const isNews = (a: NwsAlert): boolean => {
      if (a.messageType === "Cancel") return false;
      const v = alertVtec(a);
      const rank = rankOf(a);
      if (!v) return a.messageType !== "Update";
      const before = eventRank.get(v.key);
      eventRank.set(v.key, Math.max(before ?? 0, rank));
      if (NEW_ACTIONS.has(v.action)) return true;
      if (["CAN", "EXP", "UPG"].includes(v.action)) return false;
      // CON / EXT / COR: only an upgrade is news.
      return before !== undefined ? rank > before : a.messageType === "Alert";
    };

    const inView = (f: AlertFeature): boolean => {
      const b = alertBounds(f.geometry);
      if (!b) return false;
      for (const map of allMaps()) {
        const v = map.getBounds();
        if (b[0][0] <= v.getEast() && b[1][0] >= v.getWest() && b[0][1] <= v.getNorth() && b[1][1] >= v.getSouth()) return true;
      }
      return false;
    };

    const sound = (batch: AlertFeature[]) => {
      if (!getSetting<boolean>("alerts.sounds") || batch.length === 0) return;
      const ranked = batch
        .map((f) => ({ f, s: alertSound(f.alert) }))
        .filter((x) => x.s !== "none")
        .sort((x, y) => alertUrgency(y.f.alert) - alertUrgency(x.f.alert) || alertPriority(y.f.alert) - alertPriority(x.f.alert));
      if (ranked.length === 0) return;
      playAlertSound(ranked[0].s, getSetting<number>("alerts.volume"));
      last = { id: ranked[0].f.alert.id, event: ranked[0].f.alert.event, tier: tierOf(ranked[0].f.alert)?.id ?? "", sound: ranked[0].s, of: batch.length };
    };
    let last: { id: string; event: string; tier: string; sound: string; of: number } | null = null;

    /** The waiting fresh alerts that came into view: one batch, one sound. */
    const checkView = () => {
      const now = Date.now();
      const filters = alertFilters();
      const batch: AlertFeature[] = [];
      for (const [id, f] of waiting) {
        if (now - sentMs(f.alert) > FRESH_MS || alertWindow(f.alert).end * 1000 < now) {
          waiting.delete(id);
          continue;
        }
        if (!passesAlertFilters(f.alert, filters, now / 1000) || alertHiddenOnMap(f.alert)) continue;
        if (inView(f)) {
          waiting.delete(id);
          batch.push(f);
        }
      }
      sound(batch);
      if (waiting.size === 0 && viewTimer !== null) {
        window.clearInterval(viewTimer);
        viewTimer = null;
      } else if (waiting.size > 0 && viewTimer === null) {
        viewTimer = window.setInterval(checkView, VIEW_CHECK_MS);
      }
    };

    const onFeatures = (features: AlertFeature[]) => {
      if (!isLive() || !useAlertStore.getState().active) return;
      if (!baseline) {
        // The first live read: everything here was already in force.
        if (features.length === 0) return;
        for (const f of features) {
          handled.add(f.alert.id);
          isNews(f.alert);
        }
        baseline = true;
        return;
      }
      const now = Date.now();
      for (const f of features) {
        const a = f.alert;
        if (handled.has(a.id)) {
          // A zone-based alert gets its shape after the first paint: let a
          // waiting one find its geometry.
          if (waiting.has(a.id)) waiting.set(a.id, f);
          continue;
        }
        handled.add(a.id);
        if (!isNews(a)) continue;
        const fresh = now - sentMs(a) <= FRESH_MS;
        if (!fresh) continue;
        if (getSetting<boolean>("alerts.flashNew")) flashAlert(a.id, alertFlashMs(a, now));
        waiting.set(a.id, f);
      }
      checkView();
    };

    // Playback: alerts flash as the timeline reaches their issue time.
    let prevT: number | null = useAlertStore.getState().timeFilter;
    const onTime = (t: number | null) => {
      const before = prevT;
      prevT = t;
      if (t === null || before === null || !getSetting<boolean>("alerts.animatePlayback")) return;
      if (t <= before || t - before > 3 * 3600) return;
      for (const f of useAlertStore.getState().features) {
        const start = alertWindow(f.alert).start;
        if (start > before && start <= t && f.geometry) flashAlert(f.alert.id, PLAYBACK_FLASH_MS);
      }
    };

    const unsubFeatures = useAlertStore.subscribe((s) => s.features, onFeatures);
    const unsubTime = useAlertStore.subscribe((s) => s.timeFilter, onTime);
    const unsubActive = useAlertStore.subscribe(
      (s) => s.active,
      (on) => {
        if (on) return;
        // The layer off and on again is a new start: no sounds for what it finds.
        baseline = false;
        waiting.clear();
      },
    );
    onFeatures(useAlertStore.getState().features);

    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__alertNotify = {
        state: () => ({ baseline, handled: handled.size, waiting: [...waiting.keys()], last }),
        soundLog,
        render: renderAlertSound,
        play: playAlertSound,
      };
    }

    return () => {
      unsubFeatures();
      unsubTime();
      unsubActive();
      if (viewTimer !== null) window.clearInterval(viewTimer);
    };
  }, []);

  return null;
}
