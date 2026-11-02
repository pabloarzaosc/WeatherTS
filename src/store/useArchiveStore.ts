import { create } from "zustand";

import type { MesoEvent } from "../lib/mesoEvents";
import { getMap } from "../map/mapInstance";
import { useAppStore } from "./useAppStore";
import { useNexradStore } from "./useNexradStore";
import { useObsStore } from "./useObsStore";

/**
 * The Archive panel: one moment in the past, and what is shown at it.
 *
 * Nothing here draws. The mesoanalysis is the Models layer on its archive
 * source, the radar is the radar layer in archive playback at a chosen site;
 * this only points both at the same moment, so picking a date (or a notable
 * day) turns them on there together, and moving the moment moves both.
 */

const K_AT = "weatherts.archive.at";
const K_SITE = "weatherts.archive.site";
const K_LIVE = "weatherts.archive.liveSource";
export const ARCHIVE_SOURCE = "rap-archive";
const OBS_LAYER = "observations";
const RADAR_LAYER = "nexrad";
const DEFAULT_LIVE_SOURCE = "hrrr-anl";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* not remembered across restarts, which is harmless */
  }
}

/** Yesterday at 21Z: an afternoon, when a picked day has nothing else to go on. */
function yesterdayAfternoon(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 21) / 1000;
}

/** The NEXRAD nearest the middle of the map. */
function nearestSite(): string | null {
  const sites = useNexradStore.getState().sites;
  const c = getMap()?.getCenter();
  if (!sites.length || !c) return null;
  const k = Math.cos((c.lat * Math.PI) / 180);
  let best: string | null = null;
  let dist = Infinity;
  for (const s of sites) {
    if (s.type === "TDWR") continue;
    const d = (s.lat - c.lat) ** 2 + ((s.lon - c.lng) * k) ** 2;
    if (d < dist) {
      dist = d;
      best = s.id;
    }
  }
  return best;
}

interface ArchiveState {
  /** The moment, unix seconds (UTC). */
  at: number;
  /** The radar the archive plays (three letters), once one is picked. */
  site: string | null;
  setMoment: (unix: number) => void;
  setSite: (site: string) => void;
  /** The mesoanalysis on or off at the moment. */
  setMeso: (on: boolean) => Promise<void>;
  /** The radar on or off at the moment. */
  setRadar: (on: boolean) => Promise<void>;
  /** A notable day: both on, at its hour, its radar, the map over it. */
  openEvent: (e: MesoEvent) => Promise<void>;
  /** Everything back to now: the analyses the Models panel had, live radar. */
  backToLive: () => void;
}

export const useArchiveStore = create<ArchiveState>((set, get) => ({
  at: Number(read(K_AT)) || yesterdayAfternoon(),
  site: read(K_SITE),

  setMoment: (unix) => {
    const at = Math.floor(unix);
    write(K_AT, String(at));
    set({ at });
    if (archiveMesoOn()) useObsStore.getState().setArchiveAt(at);
    if (archiveRadarOn() && get().site) useNexradStore.getState().openAt(get().site!, at);
  },

  setSite: (site) => {
    write(K_SITE, site);
    set({ site });
    if (archiveRadarOn()) useNexradStore.getState().openAt(site, get().at);
  },

  setMeso: async (on) => {
    const obs = useObsStore.getState();
    const app = useAppStore.getState();
    if (on) {
      await obs.load();
      if (obs.source !== ARCHIVE_SOURCE) write(K_LIVE, obs.source);
      // The moment first, so the archive's first list of hours is that day's.
      useObsStore.getState().setArchiveAt(get().at);
      useObsStore.getState().setSource(ARCHIVE_SOURCE);
      if (!app.layers[OBS_LAYER]?.visible) app.setLayerVisible(OBS_LAYER, true);
      return;
    }
    if (obs.source === ARCHIVE_SOURCE) obs.setSource(read(K_LIVE) || DEFAULT_LIVE_SOURCE);
    if (app.layers[OBS_LAYER]?.visible) app.setLayerVisible(OBS_LAYER, false);
  },

  setRadar: async (on) => {
    const app = useAppStore.getState();
    const nex = useNexradStore.getState();
    if (on) {
      // The radar list, for the nearest radar and for the site check.
      await nex.loadCatalog();
      const site = get().site ?? nearestSite();
      if (!site) return;
      if (site !== get().site) {
        write(K_SITE, site);
        set({ site });
      }
      if (!app.layers[RADAR_LAYER]?.visible) app.setLayerVisible(RADAR_LAYER, true);
      nex.openAt(site, get().at);
      return;
    }
    nex.setArchiveTime(null);
    if (app.layers[RADAR_LAYER]?.visible) app.setLayerVisible(RADAR_LAYER, false);
  },

  openEvent: async (e) => {
    write(K_AT, String(e.at));
    write(K_SITE, e.radar);
    set({ at: e.at, site: e.radar });
    getMap()?.flyTo({ center: e.center, zoom: e.zoom, duration: 1200, essential: true });
    await get().setMeso(true);
    // A day picked for its storms opens on what made them, unless a severe
    // product is already on.
    const obs = useObsStore.getState();
    const product = obs.catalog?.products.find((p) => p.id === obs.field);
    if (product?.group !== "Severe Weather") obs.setField("stp_eff");
    await get().setRadar(true);
  },

  backToLive: () => {
    const obs = useObsStore.getState();
    if (obs.source === ARCHIVE_SOURCE) obs.setSource(read(K_LIVE) || DEFAULT_LIVE_SOURCE);
    const nex = useNexradStore.getState();
    // A day out of the NEXRAD archive (archive-l2) is not a window: drop it too.
    if (nex.archiveDate !== null) void nex.setArchiveDate(null);
    else nex.setArchiveTime(null);
  },
}));

/** The mesoanalysis archive is what the Models layer is showing. */
export function archiveMesoOn(): boolean {
  return !!useAppStore.getState().layers[OBS_LAYER]?.visible && useObsStore.getState().source === ARCHIVE_SOURCE;
}

/** The radar layer is on and playing the archive. */
export function archiveRadarOn(): boolean {
  return !!useAppStore.getState().layers[RADAR_LAYER]?.visible && useNexradStore.getState().archiveTime != null;
}
