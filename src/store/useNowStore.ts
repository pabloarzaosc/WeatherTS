import { create } from "zustand";

import { alertInForceAt, fetchActiveAlerts, fetchAlertsAt, fetchArchivedWarnings, ISSUE_LOOKBACK_S, NWS_ARCHIVE_S } from "../lib/nwsAlerts";
import { fetchLsr } from "../lib/lsr";
import { spcOutlook, type OutlookResponse } from "../lib/outlooks";
import { wireCode } from "../lib/nexrad";
import {
  buildArchive,
  buildOutlook,
  buildReports,
  buildWarnings,
  buildWatches,
  NOW_EVENTS,
  NOW_PRODUCT_NAMES,
  type NowGroupId,
  type NowItem,
  type SiteSpot,
} from "../lib/nowFeed";
import { nearestRadar } from "../layers/radarHold";
import { getActivePaneId, getMap } from "../map/mapInstance";
import { useAppStore } from "./useAppStore";
import { useArchiveStore } from "./useArchiveStore";
import { useNexradStore } from "./useNexradStore";
import { useRadarEventStore } from "./useRadarEventStore";

/**
 * The Now panel's data: what is happening across the US, refreshed every
 * minute. The warnings and watches are polled all the time (one small
 * api.weather.gov request for a short list of event types) because the dock's
 * red badge counts the most serious of them; storm reports and the SPC
 * outlooks are read only while the panel is open.
 */

const POLL_MS = 60_000;
const OUTLOOK_MS = 10 * 60_000;
const RADAR_KM = 460;

type Status = "idle" | "loading" | "ready" | "error";

interface NowState {
  items: Record<NowGroupId, NowItem[]>;
  errors: Partial<Record<NowGroupId, string>>;
  status: Status;
  /** When the last refresh finished (ms). */
  updated: number | null;
  /** A past instant (unix s) to build the panel for instead of now -- a
   *  developer hook (window.__now in DEV) for checking against real days. */
  at: number | null;
  /** Groups showing every line instead of three. */
  expanded: Partial<Record<NowGroupId, boolean>>;
  /** The serious items, for the dock badge. */
  badge: number;
  /** The panel is on screen (reports and outlooks are read then). */
  open: boolean;
  /** A refresh with reports and outlooks has finished (else they say Loading). */
  fullDone: boolean;

  refresh: (full?: boolean) => Promise<void>;
  setOpen: (open: boolean) => void;
  toggle: (g: NowGroupId) => void;
  setAt: (unix: number | null) => Promise<void>;
  start: () => () => void;
}

const EMPTY: Record<NowGroupId, NowItem[]> = { warnings: [], watches: [], reports: [], outlook: [], archive: [] };

let outlookAt = 0;
let outlooks: [OutlookResponse | null, OutlookResponse | null] = [null, null];
let inflight: AbortController | null = null;
let users = 0;
let timer: number | null = null;

function siteMap(): Map<string, SiteSpot> {
  const m = new Map<string, SiteSpot>();
  for (const s of useNexradStore.getState().sites) {
    if (s.online === false || String(s.id).startsWith("BR") || s.type === "TDWR" || !Number.isFinite(s.lat)) continue;
    m.set(s.icao, { id: s.id, icao: s.icao, name: s.name, lat: s.lat, lon: s.lon });
  }
  return m;
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

export const useNowStore = create<NowState>((set, get) => ({
  items: EMPTY,
  errors: {},
  status: "idle",
  updated: null,
  at: null,
  expanded: {},
  badge: 0,
  open: false,
  fullDone: false,

  refresh: async (full = get().open) => {
    inflight?.abort();
    const ac = new AbortController();
    inflight = ac;
    const { signal } = ac;
    const at = get().at;
    set({ status: get().updated ? get().status : "loading" });
    if (!useNexradStore.getState().sites.length) {
      try {
        await useNexradStore.getState().loadCatalog();
      } catch {
        /* lines without a radar still show */
      }
    }
    const nowMs = at != null ? at * 1000 : Date.now();
    const wantOutlook = full && (at != null || Date.now() - outlookAt > OUTLOOK_MS || !outlooks[0]);

    const [alerts, lsr, o1, o2] = await Promise.allSettled([
      at == null
        ? fetchActiveAlerts(signal, { event: NOW_EVENTS.join(",") })
        : // past a week api.weather.gov has nothing: IEM's storm-based warnings
          (at < Date.now() / 1000 - NWS_ARCHIVE_S
            ? fetchArchivedWarnings(at - ISSUE_LOOKBACK_S, at, signal).then((fs) => fs.filter((f) => alertInForceAt(f.alert, at)))
            : fetchAlertsAt(at, signal)
          ).then((fs) => fs.filter((f) => NOW_EVENTS.includes(f.alert.event))),
      full ? fetchLsr(1, at, signal) : Promise.resolve(null),
      wantOutlook ? spcOutlook(1, "categorical") : Promise.resolve(outlooks[0]),
      wantOutlook ? spcOutlook(2, "categorical") : Promise.resolve(outlooks[1]),
    ]);
    if (signal.aborted) return;
    if (wantOutlook) {
      outlooks = [o1.status === "fulfilled" ? o1.value : outlooks[0], o2.status === "fulfilled" ? o2.value : outlooks[1]];
      if (o1.status === "fulfilled") outlookAt = Date.now();
    }

    const sites = siteMap();
    const prev = get().items;
    const errors: Partial<Record<NowGroupId, string>> = {};
    const items: Record<NowGroupId, NowItem[]> = { ...prev };
    if (alerts.status === "fulfilled") {
      items.warnings = buildWarnings(alerts.value, sites, nowMs);
      items.watches = buildWatches(alerts.value, sites, nowMs);
    } else {
      errors.warnings = errors.watches = message(alerts.reason);
    }
    if (full) {
      if (lsr.status === "fulfilled" && lsr.value) items.reports = buildReports(lsr.value.features, nowMs);
      else if (lsr.status === "rejected") errors.reports = message(lsr.reason);
      items.outlook = buildOutlook(outlooks[0], outlooks[1], sites);
      if (o1.status === "rejected" && !outlooks[0]) errors.outlook = message(o1.reason);
      items.archive = buildArchive(nowMs);
    }
    const badge = [...items.warnings, ...items.watches].filter((i) => i.serious).length;
    set({
      items,
      errors: { ...(full ? {} : get().errors), ...errors },
      badge,
      updated: Date.now(),
      fullDone: full || get().fullDone,
      status: alerts.status === "fulfilled" ? "ready" : "error",
    });
  },

  setOpen: (open) => {
    if (open === get().open) return;
    set({ open });
    // opening shows the whole panel at once, not a minute later
    if (open) void get().refresh(true);
  },

  toggle: (g) => set((s) => ({ expanded: { ...s.expanded, [g]: !s.expanded[g] } })),

  setAt: async (at) => {
    set({ at });
    await get().refresh(true);
  },

  start: () => {
    users++;
    if (users === 1) {
      void get().refresh();
      timer = window.setInterval(() => {
        // a hidden window has no badge to update; the next visible minute does
        if (document.hidden && !get().open) return;
        void get().refresh();
      }, POLL_MS);
    }
    return () => {
      users--;
      if (users === 0 && timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  },
}));

/**
 * Act on a line: a radar event opens its archive window; everything else opens
 * the radar nearest it, live, on the product that shows the hazard best, and
 * frames the map on it. Returns what happened, for the panel to say.
 */
export async function openNowItem(item: NowItem): Promise<string> {
  if (item.eventId) {
    const ok = await useRadarEventStore.getState().load(item.eventId);
    return ok ? `Opened ${item.title}` : "That event is not in the table";
  }
  const app = useAppStore.getState();
  if (!useNexradStore.getState().sites.length) await useNexradStore.getState().loadCatalog();
  if (!app.layers.nexrad?.visible) app.setLayerVisible("nexrad", true);

  const map = getMap();
  if (map) {
    if (item.bounds && (item.bounds[1][0] - item.bounds[0][0] < 12 || item.group === "outlook"))
      map.fitBounds(item.bounds, { padding: 80, maxZoom: item.group === "outlook" ? 6.5 : 9, duration: 900, essential: true });
    else if (item.lat != null && item.lon != null)
      map.flyTo({ center: [item.lon, item.lat], zoom: Math.max(map.getZoom(), item.group === "reports" ? 8.5 : 7.5), duration: 900, essential: true });
  }
  if (item.lat == null || item.lon == null) return "No place to open";

  const near = nearestRadar(item.lat, item.lon);
  if (!near || near.km > RADAR_KM || String(near.site.id).startsWith("BR")) return "No radar covers this spot";

  // A past loop is not what "now" means: back to live first.
  let nx = useNexradStore.getState();
  if (nx.archiveTime !== null || nx.archiveDate !== null) useArchiveStore.getState().backToLive();
  nx = useNexradStore.getState();

  const name = NOW_PRODUCT_NAMES[item.product];
  if (near.site.id === nx.site) {
    nx.setFamily(item.product);
    return `${near.site.icao} · ${name}`;
  }
  // New radar: the product is set without a load of its own, so the radar
  // change below loads it once (setFamily first would load the old radar).
  const fam = [...nx.grids, ...nx.catalog].find((f) => f.id === item.product);
  const tilt = fam?.tilts.find((t) => t.tilt === "0")?.tilt ?? fam?.tilts[0]?.tilt ?? null;
  const code = fam ? wireCode(fam, tilt) : null;
  if (fam && code) {
    const ids = Object.keys(nx.paneRadar);
    const pid = getActivePaneId() ?? (ids.length === 1 ? ids[0] : null);
    const pane = pid ? nx.paneRadar[pid] : undefined;
    useNexradStore.setState({
      family: item.product,
      tilt,
      product: code,
      error: null,
      paneRadar:
        pid && pane
          ? { ...nx.paneRadar, [pid]: { ...pane, family: item.product, tilt, product: code, scan: null, mesh: null, meshRev: pane.meshRev + 1 } }
          : nx.paneRadar,
    });
  }
  useNexradStore.getState().selectSite(near.site.id);
  return `${near.site.icao} · ${name} · ${Math.round(near.km)} km`;
}

if (import.meta.env.DEV) {
  (window as unknown as { __now: unknown }).__now = { store: useNowStore, open: openNowItem };
}
