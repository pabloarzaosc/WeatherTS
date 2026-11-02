import { isElectron } from "./auth";
import { wireCode } from "./nexrad";
import { eventById, RETIRED_SITES } from "./radarEvents";
import { getMap } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { LOOP_MINUTES, useNexradStore } from "../store/useNexradStore";
import { loopFor, useRadarEventStore } from "../store/useRadarEventStore";

/**
 * Links to a moment ("Copy link" in the map's right-click menu).
 *
 * A link carries the radar, live or archive, each pane's product and tilt, and
 * the time of the frame on screen -- or the notable event being played:
 *
 *   weatherts://view?site=KTLX&mode=archive&datetime=2013-05-20T20:16:43Z&panes=B.0,G.0
 *   weatherts://view?event=2013-moore&datetime=2013-05-20T20:16:43Z&panes=B.0
 *
 * The desktop app registers weatherts:// (electron/main.js hands view links to
 * the page); in a browser the same query on the app's own address does it.
 * Opening one: a past time opens the archive at the scan nearest it; a time
 * within the last 8 hours of a live link opens live, on the nearest frame. The
 * map position is not part of a link: it goes to the radar, or the event.
 */

export interface PaneSpec {
  family: string;
  tilt: string | null;
}

export interface ViewLinkSpec {
  /** The app's radar id (three letters for the WSR-88Ds), resolved. */
  site?: string;
  mode?: "live" | "archive";
  /** Unix seconds (UTC). */
  datetime?: number;
  event?: string;
  /** An event id this version does not know (the link says so on screen). */
  unknownEvent?: string;
  panes?: PaneSpec[];
}

const PANE_COUNTS = [1, 2, 3, 4, 6] as const;
/** A live link older than this opens the archive instead. */
const LIVE_REACH_S = LOOP_MINUTES[LOOP_MINUTES.length - 1] * 60;

const paneOrder = (id: string) => Number(id.replace(/^\D+/, "")) || 0;

function icaoOf(site: string): string {
  const s = useNexradStore.getState().sites.find((x) => x.id === site);
  return s?.icao ?? RETIRED_SITES[site]?.icao ?? (/^[A-Z]{3}$/.test(site) ? `K${site}` : site);
}

/** "KTLX" / "TLX" / "PABC" -> the app's id; null when it is not a radar. */
function resolveSite(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  const sites = useNexradStore.getState().sites;
  const hit = sites.find((s) => s.id === v || s.icao === v);
  if (hit) return hit.id;
  if (RETIRED_SITES[v]) return v;
  const retired = Object.entries(RETIRED_SITES).find(([, r]) => r.icao === v);
  if (retired) return retired[0];
  // A Brazilian or other id the list knows under its own name, or a 3-letter
  // id before the list arrives.
  if (/^K[A-Z]{3}$/.test(v)) return v.slice(1);
  return /^[A-Z0-9-]{3,8}$/.test(v) ? v : null;
}

function iso(unix: number): string {
  return new Date(Math.round(unix) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The address of what is on screen, or null without a radar. */
export function buildViewLink(): string | null {
  const s = useNexradStore.getState();
  if (!s.site) return null;
  const q = new URLSearchParams();
  const event = useRadarEventStore.getState().active;
  const ev = eventById(event);
  if (ev) q.set("event", ev.id);
  if (!ev || ev.site !== s.site) q.set("site", icaoOf(s.site));
  const archive = s.archiveTime !== null || s.archiveDate !== null;
  if (!ev) q.set("mode", archive ? "archive" : "live");
  const t = s.scans[s.index]?.time ?? s.archiveFocus ?? s.archiveTime;
  if (t != null) q.set("datetime", iso(t));
  const panes = Object.entries(s.paneRadar)
    .sort(([a], [b]) => paneOrder(a) - paneOrder(b))
    .map(([, p]) => (p.tilt ? `${p.family}.${p.tilt}` : p.family));
  if (panes.length) q.set("panes", panes.join(","));
  // Commas read better than %2C, and both parse back the same.
  const query = q.toString().replace(/%2C/gi, ",").replace(/%3A/gi, ":");
  const base = isElectron ? "weatherts://view" : `${window.location.origin}${window.location.pathname}`;
  return `${base}?${query}`;
}

/** The link's settings, from a whole address or just its query. Null when it
 *  carries nothing to open. */
export function parseViewLink(input: string): ViewLinkSpec | null {
  let query = input;
  const at = input.indexOf("?");
  if (at >= 0) query = input.slice(at + 1);
  const q = new URLSearchParams(query.replace(/#.*$/, ""));
  const spec: ViewLinkSpec = {};
  const site = q.get("site") ?? q.get("radar");
  if (site) spec.site = site.trim().toUpperCase();
  const mode = q.get("mode");
  if (mode === "live" || mode === "archive") spec.mode = mode;
  const dt = q.get("datetime") ?? q.get("time");
  if (dt) {
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(dt) ? dt : `${dt}Z`);
    if (Number.isFinite(ms)) spec.datetime = Math.floor(ms / 1000);
  }
  const event = q.get("event");
  if (event && eventById(event)) spec.event = event;
  else if (event) spec.unknownEvent = event.slice(0, 60);
  const panes = q.get("panes");
  if (panes) {
    spec.panes = panes
      .split(",")
      .map((p) => p.trim())
      .filter((p) => /^[A-Za-z0-9_]{1,12}(\.[A-Za-z0-9]{1,3})?$/.test(p))
      .slice(0, 6)
      .map((p) => {
        const [family, tilt] = p.split(".");
        return { family, tilt: tilt ?? null };
      });
    if (!spec.panes.length) delete spec.panes;
  }
  return spec.site || spec.event || spec.unknownEvent || spec.datetime != null ? spec : null;
}

function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (test()) return resolve(true);
    const t0 = Date.now();
    const id = window.setInterval(() => {
      if (test()) {
        window.clearInterval(id);
        resolve(true);
      } else if (Date.now() - t0 > ms) {
        window.clearInterval(id);
        resolve(false);
      }
    }, 100);
  });
}

/** The layout and each pane's product, set without loading anything: the
 *  radar/time change that follows loads every pane once. */
async function applyPanes(panes: PaneSpec[]): Promise<void> {
  const want = PANE_COUNTS.find((c) => c >= panes.length) ?? 6;
  const app = useAppStore.getState();
  if (app.paneCount !== want) app.setPaneCount(want);
  // Exactly: a pane going away takes the radar layer's clear() with it (site
  // back to null), which has to be over before the radar below is picked.
  await waitFor(() => Object.keys(useNexradStore.getState().paneRadar).length === want, 4000);
  const s = useNexradStore.getState();
  const families = [...s.grids, ...s.catalog];
  const paneRadar = { ...s.paneRadar };
  const ids = Object.keys(paneRadar).sort((a, b) => paneOrder(a) - paneOrder(b));
  let top: { family: string; tilt: string | null; product: string } | null = null;
  panes.forEach((spec, i) => {
    const id = ids[i];
    const fam = families.find((f) => f.id === spec.family);
    const pane = id ? paneRadar[id] : undefined;
    if (!fam || !pane) return;
    const tilt = fam.tilts.find((t) => t.tilt === spec.tilt)?.tilt ?? fam.tilts[0]?.tilt ?? null;
    const product = wireCode(fam, tilt);
    if (!product) return;
    paneRadar[id] = { ...pane, family: fam.id, tilt, product, scan: null, mesh: null, meshRev: pane.meshRev + 1 };
    if (i === 0) top = { family: fam.id, tilt, product };
  });
  // The first pane takes the product picker, as a fresh layout does.
  useNexradStore.setState({ paneRadar, ...(top ?? {}) });
}

/** Open a link. Resolves with a message when it could not be opened. */
export async function openViewLink(spec: ViewLinkSpec): Promise<string | null> {
  if (spec.unknownEvent && !spec.event && !spec.site) {
    return `this version of WeatherTS has no notable event "${spec.unknownEvent}"`;
  }
  const app = useAppStore.getState();
  await useNexradStore.getState().loadCatalog();
  if (!app.layers.nexrad?.visible) app.setLayerVisible("nexrad", true);
  await waitFor(() => Object.keys(useNexradStore.getState().paneRadar).length > 0, 15000);

  if (spec.panes?.length) await applyPanes(spec.panes);
  const site = resolveSite(spec.site);

  if (spec.event) {
    const ok = await useRadarEventStore.getState().load(spec.event, {
      site: site ?? undefined, at: spec.datetime, keepProducts: !!spec.panes?.length,
    });
    return ok ? null : `No notable event ${spec.event}`;
  }
  if (!site) return "That link names no radar";

  const nex = useNexradStore.getState();
  const t = spec.datetime;
  const now = Date.now() / 1000;
  const live = t == null || (spec.mode !== "archive" && now - t >= -600 && now - t <= LIVE_REACH_S);
  const before = { site: nex.site, archiveTime: nex.archiveTime, archiveDate: nex.archiveDate };

  let reload = false;
  if (live) {
    // Long enough a loop to reach the frame asked for.
    if (t != null && now - t > nex.loopMinutes * 60) {
      useNexradStore.setState({ loopMinutes: loopFor((now - t) / 60 + 10) });
      reload = true;
    }
    if (nex.archiveDate !== null) await nex.setArchiveDate(null);
    else if (nex.archiveTime !== null) nex.setArchiveTime(null);
    useNexradStore.getState().selectSite(site);
    const moved = useNexradStore.getState();
    if (reload && before.site === moved.site && before.archiveTime === null && before.archiveDate === null) {
      void moved.refresh();
    }
    if (t != null) {
      // The list loads off the network; then the frame nearest the time,
      // once the list reaches back to it.
      const ready = () => {
        const s = useNexradStore.getState();
        return s.site === site && s.archiveTime === null && s.scans.length > 0 && s.scans[0].time <= t + 600;
      };
      if (await waitFor(ready, 20000)) {
        const s = useNexradStore.getState();
        let best = 0;
        s.scans.forEach((f, i) => {
          if (Math.abs(f.time - t) < Math.abs(s.scans[best].time - t)) best = i;
        });
        await s.showIndex(best);
      }
    }
  } else {
    useNexradStore.getState().openAt(site, t!);
  }
  const after = useNexradStore.getState();
  if (!reload && before.site === after.site && before.archiveTime === after.archiveTime && before.archiveDate === after.archiveDate) {
    // Nothing moved the radar, so nothing reloaded the panes' new products.
    void after.showIndex(after.index);
  }

  const spot = after.sites.find((x) => x.id === site) ?? RETIRED_SITES[site];
  if (spot) getMap()?.flyTo({ center: [spot.lon, spot.lat], zoom: 7.2, duration: 1000, essential: true });
  return null;
}

/** For the desktop bridge (electron/preload.cjs). */
interface LinkBridge {
  onOpenLink?: (cb: (url: string) => void) => void;
  getPendingLink?: () => Promise<string | null>;
}

let lastError: string | null = null;
/** The last link that failed to open, for a probe or a note. */
export function viewLinkError(): string | null {
  return lastError;
}

/** Say on screen why a link did nothing (the app's toast look, bottom centre). */
function showLinkError(text: string): void {
  document.querySelector(".linkerr")?.remove();
  const el = document.createElement("div");
  el.className = "update-toast update-toast--err linkerr";
  el.setAttribute("role", "status");
  el.title = "Click to close";
  el.textContent = `Couldn't open the link: ${text}`;
  el.addEventListener("click", () => el.remove());
  (document.querySelector(".app") ?? document.body).appendChild(el);
  window.setTimeout(() => el.remove(), 8000);
}

function open(input: string): void {
  const spec = parseViewLink(input);
  if (!spec) {
    lastError = "This link is not a WeatherTS view link.";
    showLinkError(lastError);
    return;
  }
  void openViewLink(spec).then((err) => {
    lastError = err;
    if (err) {
      console.warn("[link]", err);
      showLinkError(err);
    }
  });
}

/** Once at start: a link in the page's own address (browser), and the desktop
 *  app's weatherts:// links, now and later. */
export function installViewLinks(): void {
  const search = window.location.search;
  if (search && parseViewLink(search)) {
    // Out of the address bar, so a reload does not open it again over
    // whatever has been done since.
    const q = new URLSearchParams(search);
    for (const k of ["site", "radar", "mode", "datetime", "time", "event", "panes"]) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    open(search);
  }
  const api = (window as unknown as { electronAPI?: LinkBridge }).electronAPI;
  api?.onOpenLink?.((url) => open(url));
  void api?.getPendingLink?.().then((url) => url && open(url)).catch(() => undefined);
}

// DEV: drive links from a probe.
if (import.meta.env.DEV) {
  (window as unknown as { __links?: unknown }).__links = { buildViewLink, parseViewLink, openViewLink, open, viewLinkError };
}
