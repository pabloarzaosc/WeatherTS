import { create } from "zustand";

import { wireCode } from "../lib/nexrad";
import { eventById, EVENT_ZOOM, type EventFilter } from "../lib/radarEvents";
import { getActivePaneId, getMap } from "../map/mapInstance";
import { useAppStore } from "./useAppStore";
import { archiveMesoOn, useArchiveStore } from "./useArchiveStore";
import { LOOP_MINUTES, useNexradStore } from "./useNexradStore";
import { useObsStore } from "./useObsStore";

/**
 * Notable radar events (src/lib/radarEvents.ts) on the radar.
 *
 * Loading one is archive playback of its window: the loop starts at the
 * window's start and runs the loop length that covers it, opened on the peak
 * scan, lowest reflectivity in the focused pane. The event stays "loaded" for
 * as long as the radar plays that window -- picking another radar keeps it
 * (selectSite in archive keeps the window, so the same stretch loads from
 * there); going live or opening another moment ends it, and the loop length
 * the event changed goes back to what it was.
 */

interface EventState {
  /** The event the radar is playing, or null. */
  active: string | null;
  /** The loop length before an event changed it, for the way back to live. */
  prevLoop: number | null;
  /** The Notable events list: search words, category, which list. */
  query: string;
  filter: EventFilter;
  list: "radar" | "meso";
  setQuery: (q: string) => void;
  setFilter: (f: EventFilter) => void;
  setList: (l: "radar" | "meso") => void;
  /**
   * Open an event: its window on `site` (default the event's radar), on the
   * scan nearest `at` (default its peak). `frame` false leaves the map where it
   * is; `keepProducts` leaves the panes' products as they are (a link that
   * carries its own). Resolves false for an unknown id.
   */
  load: (id: string, opts?: { site?: string; at?: number; frame?: boolean; keepProducts?: boolean }) => Promise<boolean>;
}

/** While load() moves the radar, the watch below must not read the half-set
 *  state as "the window changed" and drop the event it is opening. */
let applying = false;

/** Level III's archive begins here (useNexradStore's LEVEL3_FIRST_DAY). */
const LEVEL3_FROM = Date.UTC(2022, 2, 1) / 1000;

/** The shortest loop length that covers a window of `minutes`. */
export function loopFor(minutes: number): number {
  return (LOOP_MINUTES as readonly number[]).find((m) => m >= minutes) ?? LOOP_MINUTES[LOOP_MINUTES.length - 1];
}

export const useRadarEventStore = create<EventState>((set, get) => ({
  active: null,
  prevLoop: null,
  query: "",
  filter: "all",
  list: "radar",
  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  setList: (list) => set({ list }),

  load: async (id, opts = {}) => {
    const e = eventById(id);
    if (!e) return false;
    const app = useAppStore.getState();
    // The radar list and the product grids, for the codes below.
    await useNexradStore.getState().loadCatalog();
    if (!app.layers.nexrad?.visible) app.setLayerVisible("nexrad", true);

    const nex = useNexradStore.getState();
    const site = opts.site ?? e.site;
    const focus = opts.at ?? e.peak;
    const loop = loopFor(Math.ceil((e.end - e.start) / 60));

    // Lowest reflectivity in the focused pane, set without a load of its own:
    // the window change below loads it (a product change first would load the
    // old window, then the new one). Before Level III's archive (March 2022)
    // the availability at the window recodes it to Level II's L2B0.
    const fam = [...nex.grids, ...nex.catalog].find((f) => f.id === "B");
    const tilt = fam?.tilts.find((t) => t.tilt === "0")?.tilt ?? fam?.tilts[0]?.tilt ?? "0";
    // Before Level III's archive only Level II has the window: its code at
    // once, rather than a Level III list that fails until the availability
    // at the window comes back and recodes it.
    const product = e.start < LEVEL3_FROM ? `L2B${tilt}` : (fam && wireCode(fam, tilt)) || nex.product;
    const ids = Object.keys(nex.paneRadar);
    const pid = getActivePaneId() ?? (ids.length === 1 ? ids[0] : null);
    const pane = pid ? nex.paneRadar[pid] : undefined;
    const paneRadar = pid && pane
      ? { ...nex.paneRadar, [pid]: { ...pane, family: "B", tilt, product, scan: null, mesh: null, meshRev: pane.meshRev + 1 } }
      : nex.paneRadar;

    applying = true;
    try {
      set({ active: e.id, prevLoop: get().active ? get().prevLoop : (get().prevLoop ?? nex.loopMinutes) });
      useNexradStore.setState(opts.keepProducts
        ? { loopMinutes: loop, error: null }
        : { family: "B", tilt, product, loopMinutes: loop, paneRadar, error: null });
      if (nex.site !== site) {
        nex.stopAutoRefresh();
        useNexradStore.setState({ archiveTime: e.start, archiveFocus: focus, archiveDate: null, archivePick: null });
        useNexradStore.getState().selectSite(site);
        // selectSite aims a radar change at the frame on screen; here the
        // scan asked for wins (the list is read after this, off the network).
        useNexradStore.setState({ archiveFocus: focus });
      } else if (nex.archiveTime === e.start && nex.archiveDate === null) {
        useNexradStore.setState({ archiveFocus: focus, scan: null, mesh: null, meshRev: nex.meshRev + 1 });
        void useNexradStore.getState().refresh();
      } else {
        useNexradStore.getState().setArchiveTime(e.start);
        useNexradStore.setState({ archiveFocus: focus });
      }
    } finally {
      applying = false;
    }

    // The Archive panel's moment follows, and the mesoanalysis with it when on.
    useArchiveStore.setState({ at: focus, site });
    if (archiveMesoOn() && e.peak >= Date.UTC(2005, 0, 1) / 1000) useObsStore.getState().setArchiveAt(focus);

    if (opts.frame !== false) {
      getMap()?.flyTo({ center: [e.lon, e.lat], zoom: EVENT_ZOOM[e.category], duration: 1200, essential: true });
    }
    return true;
  },
}));

// The event ends when the radar stops playing its window. Subscribers run
// inside the store's set(), so going live puts the loop length back before the
// live list is asked for (setArchiveTime refreshes after its set).
useNexradStore.subscribe((s) => {
  if (applying) return;
  const ev = useRadarEventStore.getState();
  const live = s.archiveTime === null && s.archiveDate === null;
  if (!ev.active) {
    // Ended into another past moment earlier: the loop length goes back on
    // the way to live all the same.
    if (live && ev.prevLoop != null) {
      useRadarEventStore.setState({ prevLoop: null });
      if (ev.prevLoop !== s.loopMinutes) useNexradStore.setState({ loopMinutes: ev.prevLoop });
    }
    return;
  }
  const e = eventById(ev.active);
  if (e && s.archiveTime === e.start && s.archiveDate === null) return;
  useRadarEventStore.setState({ active: null, prevLoop: live ? null : ev.prevLoop });
  if (live && ev.prevLoop != null && ev.prevLoop !== s.loopMinutes) useNexradStore.setState({ loopMinutes: ev.prevLoop });
});

/** The event the radar is playing (for the pane header). */
export function activeEvent() {
  return eventById(useRadarEventStore.getState().active);
}
