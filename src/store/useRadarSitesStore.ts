import { create } from "zustand";
import { persist } from "zustand/middleware";

import { fetchSiteDetail, type SiteClass, type SiteDetail, type SiteStatusFeed, type SiteStatusRow } from "../lib/radarSites";
import { isBrazilSite } from "../lib/brazilRadar";
import { useNexradStore } from "./useNexradStore";

/**
 * radar-sites: the live standing of every radar (polled by radarSitesInstall),
 * the favourites and recent radars (kept), the site list's sort and filters,
 * and the card that says why a radar is down.
 */

export type SortCol = "id" | "place" | "state" | "country" | "type" | "distance" | "status";

export interface SiteFilters {
  text: string;
  fav: boolean;
  recent: boolean;
  /** "" = any, else a typeOf() value. */
  type: string;
  /** "" = any, else a state code. */
  state: string;
}

interface DetailEntry {
  at: number;
  loading: boolean;
  data?: SiteDetail;
  error?: string;
}

const RECENT_MAX = 5;
/** A standing older than this is shown as unknown: the poll has stopped answering. */
export const FEED_STALE_MS = 10 * 60_000;
const DETAIL_TTL_MS = 60_000;

interface RadarSitesState {
  feed: SiteStatusFeed | null;
  /** Date.now() when the feed came in. */
  feedAt: number;
  feedError: string | null;
  favourites: string[];
  recents: string[];
  listOpen: boolean;
  sort: { col: SortCol; dir: 1 | -1 };
  filters: SiteFilters;
  /** The down radar whose reasons are showing, and where the card sits (client px). */
  notice: { site: string; x: number; y: number } | null;
  details: Record<string, DetailEntry>;
  /** Where the list measures distance from: the user's position once asked
   *  for. Kept in memory only, never saved. */
  from: { lat: number; lon: number; label: string } | null;
  /** The list measures from the user: asked for once, then each time it opens.
   *  The choice is kept, the position never is. */
  fromMine: boolean;

  setFeed: (feed: SiteStatusFeed) => void;
  setFeedError: (msg: string | null) => void;
  toggleFavourite: (id: string) => void;
  pushRecent: (id: string) => void;
  setListOpen: (open: boolean) => void;
  setSort: (col: SortCol) => void;
  setFilters: (patch: Partial<SiteFilters>) => void;
  openNotice: (site: string, x: number, y: number) => void;
  closeNotice: () => void;
  loadDetail: (site: string, force?: boolean) => Promise<void>;
  setFrom: (from: RadarSitesState["from"], mine: boolean) => void;
}

export const useRadarSitesStore = create<RadarSitesState>()(
  persist(
    (set, get) => ({
      feed: null,
      feedAt: 0,
      feedError: null,
      favourites: [],
      recents: [],
      listOpen: false,
      sort: { col: "id", dir: 1 },
      filters: { text: "", fav: false, recent: false, type: "", state: "" },
      notice: null,
      details: {},
      from: null,
      fromMine: false,

      setFeed: (feed) => set({ feed, feedAt: Date.now(), feedError: null }),
      setFeedError: (feedError) => {
        // A standing this old says nothing any more: gray until the feed answers.
        const stale = Date.now() - get().feedAt > FEED_STALE_MS;
        set(stale ? { feedError, feed: null } : { feedError });
      },
      toggleFavourite: (id) => {
        const f = get().favourites;
        set({ favourites: f.includes(id) ? f.filter((x) => x !== id) : [...f, id] });
      },
      pushRecent: (id) => {
        const r = get().recents;
        if (r[0] === id) return;
        set({ recents: [id, ...r.filter((x) => x !== id)].slice(0, RECENT_MAX) });
      },
      setListOpen: (listOpen) => set({ listOpen }),
      setSort: (col) => {
        const s = get().sort;
        set({ sort: s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 } });
      },
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      openNotice: (site, x, y) => {
        set({ notice: { site, x, y } });
        void get().loadDetail(site);
      },
      closeNotice: () => set({ notice: null }),
      loadDetail: async (site, force = false) => {
        const held = get().details[site];
        if (held && (held.loading || (!force && Date.now() - held.at < DETAIL_TTL_MS && held.data))) return;
        set({ details: { ...get().details, [site]: { ...held, at: Date.now(), loading: true } } });
        try {
          const data = await fetchSiteDetail(site);
          set({ details: { ...get().details, [site]: { at: Date.now(), loading: false, data } } });
        } catch (e) {
          set({ details: { ...get().details, [site]: { at: Date.now(), loading: false, error: (e as Error).message } } });
        }
      },
      setFrom: (from, fromMine) => set({ from, fromMine }),
    }),
    {
      name: "weatherts-radar-sites",
      version: 1,
      partialize: (s) => ({ favourites: s.favourites, recents: s.recents, sort: s.sort, fromMine: s.fromMine }),
    },
  ),
);

/** True while the radar shows a past moment: the live colours do not apply. */
export function radarInArchive(): boolean {
  const s = useNexradStore.getState();
  return s.archiveTime !== null || s.archiveDate !== null;
}

/** The feed's row for a radar, while the feed is fresh. */
export function siteRow(id: string | null | undefined): SiteStatusRow | null {
  if (!id) return null;
  const { feed, feedAt } = useRadarSitesStore.getState();
  if (!feed || Date.now() - feedAt > FEED_STALE_MS) return null;
  return feed.sites[id] ?? null;
}

/**
 * Seconds since a radar's newest data, now. A radar that is sending has sent
 * more since the feed was read, so its age stays what the feed said; a quiet
 * one's age moves on with the clock.
 */
export function siteAgeNow(row: SiteStatusRow | null | undefined): number | null {
  if (!row || row.age == null) return null;
  if (row.st === "ok" || row.st === "late") return row.age;
  const { feedAt } = useRadarSitesStore.getState();
  return row.age + Math.max(0, (Date.now() - feedAt) / 1000);
}

/**
 * A radar's live class. "none" while the radar shows the past (no live
 * colours then, and every radar can be picked), and in the seconds before the
 * first standing comes in (the NWS feed takes about 10 s). A radar the feed
 * does not list falls back to the archive's word: nothing since yesterday is
 * down.
 */
export function siteClass(id: string | null | undefined): SiteClass | "none" {
  if (!id) return "unknown";
  if (radarInArchive()) return "none";
  const site = useNexradStore.getState().sites.find((s) => s.id === id);
  if (isBrazilSite(id)) return site?.live ? "ok" : "unknown";
  const { feed, feedError } = useRadarSitesStore.getState();
  if (!feed && !feedError) return site?.online === false ? "down" : "none";
  const row = siteRow(id);
  if (row) return row.st;
  if (site?.online === false) return "down";
  return "unknown";
}

/** A live radar that is down: it cannot be picked (its reasons show instead). */
export function siteIsDown(id: string | null | undefined): boolean {
  return siteClass(id) === "down";
}
