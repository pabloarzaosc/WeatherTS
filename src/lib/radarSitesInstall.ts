// radar-sites wiring: the status poll behind the coloured site labels, the
// new-scan blink, the recent radars, and the default radar site.

import type { Map as MapLibreMap } from "maplibre-gl";

import { fetchSiteScans, fetchSiteStatus, resolveSiteId } from "./radarSites";
import { isBrazilSite } from "./brazilRadar";
import { radarInArchive, siteClass, siteIsDown, useRadarSitesStore } from "../store/useRadarSitesStore";
import { isTdwrId, setSiteFilter, setSiteGate, useNexradStore } from "../store/useNexradStore";
import { featureOn, useFeatureStore } from "../store/useFeatureStore";
import { useAppStore } from "../store/useAppStore";
import { allMaps, getMap } from "../map/mapInstance";
import { getSetting } from "../settings/useSettingsStore";

/** The radar layer's site source (layers/modules/nexradLayer.ts). */
export const SITE_SOURCE = "nexrad-sites-src";

const STATUS_MS = 60_000;
const SCANS_MS = 30_000;
/** The radars in view asked about per scan poll, nearest the middle first. */
const BLINK_MAX = 40;
/** dim, back, dim, back: two blinks. */
const BLINK_STEPS = [true, false, true, false];
const BLINK_STEP_MS = 300;
const BLINK_GAP_MS = 1800;

let installed = false;
let statusBusy = false;
let scansBusy = false;
/** sid -> the newest N0B time seen, so a newer one is a scan just finished. */
const seenScan = new Map<string, number>();

const radarOn = () => !!useAppStore.getState().layers.nexrad?.visible;

async function pollStatus(force = false): Promise<void> {
  if (statusBusy || document.hidden) return;
  const st = useRadarSitesStore.getState();
  if (!force && !radarOn() && !st.listOpen) return;
  if (!force && Date.now() - st.feedAt < STATUS_MS - 5_000) return;
  statusBusy = true;
  try {
    st.setFeed(await fetchSiteStatus());
  } catch (e) {
    useRadarSitesStore.getState().setFeedError((e as Error).message);
  } finally {
    statusBusy = false;
  }
}

/** The label of one radar blinks twice on every pane that shows the site markers. */
export function blinkSite(id: string): void {
  const maps = allMaps().filter((m: MapLibreMap) => !!m.getSource(SITE_SOURCE));
  if (!maps.length) return;
  let i = 0;
  const step = () => {
    const on = BLINK_STEPS[i];
    for (const m of maps) {
      try {
        // The source can have left with a style reload since the first step:
        // asking anyway fires the map's error event, it does not throw.
        if (m.getSource(SITE_SOURCE)) m.setFeatureState({ source: SITE_SOURCE, id }, { blink: on });
      } catch {
        /* the map itself went with its pane */
      }
    }
    i += 1;
    if (i < BLINK_STEPS.length) window.setTimeout(step, BLINK_STEP_MS);
  };
  step();
}

/** The radars a pane is showing: theirs is not "another radar's" scan. */
function shownSites(): Set<string> {
  const s = useNexradStore.getState();
  const out = new Set<string>();
  if (s.site) out.add(s.site);
  for (const p of Object.values(s.paneRadar)) if (p?.site) out.add(p.site);
  return out;
}

async function pollScans(): Promise<void> {
  if (scansBusy || document.hidden || !radarOn() || radarInArchive()) return;
  if (!getSetting<boolean>("radar.siteBlink") || !getSetting<boolean>("radar.siteLabels")) return;
  const map = getMap();
  if (!map) return;
  const b = map.getBounds();
  const c = map.getCenter();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const mx = (e - w) * 0.08, my = (n - s) * 0.08;
  const shown = shownSites();
  const inView = useNexradStore
    .getState()
    .sites.filter(
      (x) =>
        !isBrazilSite(x.id) &&
        x.lon >= w - mx && x.lon <= e + mx && x.lat >= s - my && x.lat <= n + my &&
        siteClass(x.id) !== "down",
    )
    .map((x) => ({ id: x.id, d: (x.lon - c.lng) ** 2 + (x.lat - c.lat) ** 2 }))
    .sort((a, b2) => a.d - b2.d)
    .slice(0, BLINK_MAX)
    .map((x) => x.id);
  if (!inView.length) return;
  scansBusy = true;
  try {
    const got = await fetchSiteScans(inView);
    let fresh = 0;
    for (const [id, unix] of Object.entries(got)) {
      if (unix == null) continue;
      const prev = seenScan.get(id);
      seenScan.set(id, unix);
      if (prev != null && unix > prev && !shown.has(id)) {
        // the scans a poll finds came in over its 30 s: not all in one beat
        window.setTimeout(() => blinkSite(id), fresh * BLINK_GAP_MS);
        fresh += 1;
      }
    }
  } catch {
    /* the next poll tries again */
  } finally {
    scansBusy = false;
  }
}

/**
 * Pick a radar from the site list, the search or a panel: the radar layer on,
 * the radar selected, the map over it when it is out of view. A radar that is
 * down is not picked; its reasons open instead (at `at`, client px).
 */
export function pickRadar(id: string, at?: { x: number; y: number }): boolean {
  if (siteIsDown(id)) {
    useRadarSitesStore.getState().openNotice(id, at?.x ?? window.innerWidth / 2, at?.y ?? window.innerHeight / 3);
    return false;
  }
  const app = useAppStore.getState();
  if (!app.layers.nexrad?.visible) app.setLayerVisible("nexrad", true);
  const nx = useNexradStore.getState();
  nx.selectSite(id);
  const site = nx.sites.find((x) => x.id === id);
  const map = getMap();
  if (site && map) {
    const inView = map.getBounds().contains([site.lon, site.lat]) && map.getZoom() >= 5;
    if (!inView) map.flyTo({ center: [site.lon, site.lat], zoom: Math.max(map.getZoom(), 6.6), essential: true });
  }
  return true;
}

/** The default radar site (Settings > Radar > Sites), when the radar is on and has none. */
function applyDefaultSite(): void {
  const raw = getSetting<string>("radar.defaultSite");
  if (!raw || !raw.trim()) return;
  const nx = useNexradStore.getState();
  if (nx.site || !radarOn() || !nx.sites.length) return;
  const id = resolveSiteId(raw, nx.sites);
  if (!id) return;
  nx.selectSite(id);
  // Down: its reasons are up instead.
  if (useNexradStore.getState().site !== id) return;
  const site = nx.sites.find((x) => x.id === id);
  const map = getMap();
  if (site && map && !map.getBounds().contains([site.lon, site.lat])) {
    map.flyTo({ center: [site.lon, site.lat], zoom: Math.max(map.getZoom(), 6.6), essential: true });
  }
}

/** The standing for a pick about to happen with the radar off (the search box). */
export function refreshSiteStatus(): void {
  if (!useRadarSitesStore.getState().feed) void pollStatus(true);
}

export function installRadarSites(): void {
  if (installed) return;
  installed = true;

  // Every way of opening a radar goes through selectSite: alert cards, station
  // popups, office pages, links. A live radar that is down shows why instead,
  // beside the click that asked for it.
  let lastPointer: { x: number; y: number } | null = null;
  window.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    true,
  );
  setSiteGate((id) => {
    if (!siteIsDown(id)) return true;
    const at = lastPointer ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    useRadarSitesStore.getState().openNotice(id, at.x, at.y);
    return false;
  });

  // Settings > Features: the airport radars in or out of every list and the map.
  setSiteFilter((list) => (featureOn("tdwr") ? list : list.filter((s) => s.type !== "TDWR")));
  useFeatureStore.subscribe((s, p) => {
    if (s.off.includes("tdwr") === p.off.includes("tdwr")) return;
    const nx = useNexradStore.getState();
    if (s.off.includes("tdwr") && isTdwrId(nx.site)) nx.selectSite(null);
    void useNexradStore.getState().reloadSites();
  });

  window.setInterval(() => void pollStatus(), STATUS_MS);
  window.setInterval(() => void pollScans(), SCANS_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollStatus();
  });

  // The radar coming on, or the site list opening: the standing now.
  let wasOn = radarOn();
  useAppStore.subscribe((s) => {
    const on = !!s.layers.nexrad?.visible;
    if (on && !wasOn) {
      void pollStatus();
      // A site the session puts back comes first; the default only when none did.
      window.setTimeout(applyDefaultSite, 1500);
    }
    wasOn = on;
  });
  useRadarSitesStore.subscribe((s, p) => {
    if (s.listOpen && !p.listOpen) void pollStatus();
  });

  // Every radar picked joins the recent ones; the first site list after start
  // gets the default radar once the session has had its turn.
  let defaultTried = false;
  useNexradStore.subscribe((s, p) => {
    if (s.site && s.site !== p.site) useRadarSitesStore.getState().pushRecent(s.site);
    if (!defaultTried && s.sites.length && !p.sites.length) {
      defaultTried = true;
      window.setTimeout(applyDefaultSite, 2500);
    }
    // back to live: the labels' scan memory starts over (no blink for the gap)
    if ((p.archiveTime !== null || p.archiveDate !== null) && s.archiveTime === null && s.archiveDate === null) seenScan.clear();
  });

  if (radarOn()) void pollStatus(true);

  if (import.meta.env.DEV) {
    (window as unknown as { __sites?: unknown }).__sites = { pollStatus, pollScans, blinkSite, seenScan, applyDefaultSite };
  }
}
