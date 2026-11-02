import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Film, Link2, Link2Off, Pause, Play, X } from "lucide-react";

import { getActivePaneId, getMapById, subscribeMaps } from "../map/mapInstance";
import { getLayerModule } from "../layers/registry";
import { beginPaneDrag, dropAction } from "../lib/paneDrag";
import { closePane, focusPane, setCameraSync, setFollow, showOwnFrame, clearPane } from "../lib/paneOps";
import { getSetting } from "../settings/useSettingsStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { useObsStore } from "../store/useObsStore";
import { DEFAULT_SYNC, paneLetter, usePaneStore, type PaneDrag } from "../store/usePaneStore";
import { useRadarDisplayStore } from "../store/useRadarDisplayStore";
import { RadarEventChip } from "./RadarEventChip";
import { ANALYSIS_LABEL } from "../lib/paneWindows";
import { PaneMenuButton } from "./PaneWindows";

/**
 * Everything a split-screen pane carries besides its map (panes-layout):
 *   - the header chips: the radar product (with tilt), a mosaic / model field,
 *     outlooks and storm tracks when they are on, "Select product" when the
 *     pane is empty, "Out of view" when the map has left the radar's reach
 *     (the radar layer on; there is no centred note any more: Pablo found it
 *     in the way when moving around, 2026-10-30);
 *   - top right: Sync camera, Follow the animation, close;
 *   - the drop hint while a chip is dragged over the pane;
 *   - its own scrubber when it does not follow the animation.
 */
export function PaneChrome({ id }: { id: string }) {
  return (
    <>
      <PaneHeader id={id} />
      <PaneTools id={id} />
      <PaneDropHint id={id} />
      <PaneScrubber id={id} />
    </>
  );
}

/** Bring the product picker up for this pane. */
function pickProduct(id: string): void {
  focusPane(id);
  window.dispatchEvent(new CustomEvent("weatherts:products-open"));
}

function openPanel(panel: string): void {
  const app = useAppStore.getState();
  app.setCatalogTab("default");
  app.setDataView("catalog");
  usePaneStore.getState().requestPanel(panel);
}

/** "Reflectivity 0.5°" for a pane, as the chips and the drop hints name it. */
function paneProductLabel(id: string): string {
  const s = useNexradStore.getState();
  const p = s.paneRadar[id];
  if (!p || p.empty) return "";
  const fam = [...s.grids, ...s.catalog].find((f) => f.id === p.family);
  const elev = p.scan?.meta.elevation;
  const site = p.site ? `${s.sites.find((x) => x.id === p.site)?.icao ?? p.site} ` : "";
  return `${site}${fam?.label ?? p.family}${elev != null ? ` ${elev.toFixed(1)}°` : ""}`;
}

interface Overlay {
  id: string;
  label: string;
  panel: string;
  kind: "mosaic" | "model" | "outlook" | "storms";
}

/** The overlays this pane shows that have a chip. */
function usePaneOverlays(id: string): Overlay[] {
  const layers = useAppStore((s) => s.layers);
  const hidden = usePaneStore((s) => s.hidden[id]);
  const tracks = useNexradStore((s) => s.showTracks);
  const obsSource = useObsStore((s) => s.source);
  const obsField = useObsStore((s) => s.field);
  const obsCatalog = useObsStore((s) => s.catalog);
  return useMemo(() => {
    const out: Overlay[] = [];
    const off = new Set(hidden ?? []);
    if (layers.observations?.visible && !off.has("observations")) {
      const src = obsCatalog?.sources.find((x) => x.id === obsSource);
      const prod = obsCatalog?.products.find((x) => x.id === obsField);
      const mosaic = /mrms/i.test(obsSource);
      out.push({
        id: "observations",
        kind: mosaic ? "mosaic" : "model",
        label: mosaic ? `Mosaic · ${prod?.label ?? obsField}` : `${src?.label ?? obsSource} · ${prod?.label ?? obsField}`,
        panel: "observations",
      });
    }
    for (const [lid, st] of Object.entries(layers)) {
      if (!st.visible || off.has(lid)) continue;
      const mod = getLayerModule(lid);
      if (mod?.category === "outlooks") out.push({ id: lid, kind: "outlook", label: mod.name, panel: "outlooks" });
    }
    if (tracks && layers.nexrad?.visible && !off.has("storms")) {
      out.push({ id: "storms", kind: "storms", label: "Storm tracks", panel: "radar" });
    }
    return out;
  }, [layers, hidden, tracks, obsSource, obsField, obsCatalog]);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The pane's radar when the map is looking where it cannot see, else null
 *  (always null while the radar layer is off). */
function useOutOfView(id: string): { name: string; lat: number; lon: number } | null {
  const radarOn = useAppStore((s) => !!s.layers.nexrad?.visible);
  const empty = useNexradStore((s) => !s.paneRadar[id] || !!s.paneRadar[id].empty);
  const siteId = useNexradStore((s) => s.paneRadar[id]?.site || s.site);
  const sites = useNexradStore((s) => s.sites);
  const meta = useNexradStore((s) => s.paneRadar[id]?.scan?.meta);
  const map = useSyncExternalStore(subscribeMaps, () => getMapById(id));
  const [out, setOut] = useState(false);
  const info = useMemo(() => {
    const st = sites.find((x) => x.id === siteId);
    const lat = meta?.siteLat ?? st?.lat;
    const lon = meta?.siteLon ?? st?.lon;
    if (lat == null || lon == null) return null;
    return { name: st?.icao ?? siteId ?? "This radar", lat, lon, rangeKm: meta?.maxRangeKm || 460 };
  }, [sites, siteId, meta?.siteLat, meta?.siteLon, meta?.maxRangeKm]);
  useEffect(() => {
    if (!map || !info) {
      setOut(false);
      return;
    }
    const check = () => {
      const b = map.getBounds();
      const lat = Math.max(b.getSouth(), Math.min(b.getNorth(), info.lat));
      const lon = Math.max(b.getWest(), Math.min(b.getEast(), info.lon));
      setOut(haversineKm(info.lat, info.lon, lat, lon) > info.rangeKm);
    };
    check();
    map.on("moveend", check);
    return () => {
      map.off("moveend", check);
    };
  }, [map, info]);
  return out && info && !empty && radarOn ? info : null;
}

function returnTo(id: string, lat: number, lon: number): void {
  const map = getMapById(id);
  if (!map) return;
  map.flyTo({ center: [lon, lat], zoom: Math.max(6, Math.min(map.getZoom(), 8)), bearing: 0, pitch: 0 });
}

/** The pane's title row of chips. */
function PaneHeader({ id }: { id: string }) {
  const pane = useNexradStore((s) => s.paneRadar[id]);
  const grids = useNexradStore((s) => s.grids);
  const catalog = useNexradStore((s) => s.catalog);
  const site = useNexradStore((s) => s.site);
  const paneCount = useNexradStore((s) => Object.keys(s.paneRadar).length);
  // More than one radar in the loop (archive-l2): each pane names its own.
  const radarName = useNexradStore((s) => {
    if (!Object.values(s.paneRadar).some((p) => !!p.site)) return null;
    const rid = s.paneRadar[id]?.site || s.site;
    return s.sites.find((x) => x.id === rid)?.icao ?? rid;
  });
  const active = useSyncExternalStore(subscribeMaps, getActivePaneId);
  // Maximum value trail on this pane (display-opts): "Trail" after the product.
  const trail = useRadarDisplayStore((s) => !!s.trail[id]);
  const overlays = usePaneOverlays(id);
  const out = useOutOfView(id);
  // A narrow pane: the first pane's header then goes under the search box
  // instead of beside it (fixes-b.css).
  const headRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const radarShown = !!pane && !!site && grids.length > 0;
  const shown = radarShown || overlays.length > 0;
  useEffect(() => {
    const head = headRef.current;
    const host = head?.parentElement;
    if (!shown || !head || !host || typeof ResizeObserver === "undefined") return;
    // Beside the search box the header has the pane minus ~344 px (fixes-b.css
    // padding); the chips must fit there.
    const check = () => {
      const name = head.querySelector<HTMLElement>(".panehead__name");
      let natural = 0;
      if (name) {
        const was = name.style.cssText;
        name.style.cssText = `${was};flex:none;width:max-content;max-width:none`;
        natural = name.getBoundingClientRect().width;
        name.style.cssText = was;
      }
      // ...and the pane's switches on the right (padding-right, panes.css).
      const right = parseFloat(getComputedStyle(head).paddingRight) || 0;
      setNarrow(host.clientWidth < Math.max(520, 344 + natural + 70 + right));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(host);
    // A chip coming or going (the event chip loads on its own) changes the need.
    const mo = new MutationObserver(check);
    mo.observe(head, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [shown, trail, pane?.family, pane?.empty, overlays.length, !!out, paneCount]);

  if (!shown) return null;
  const fam = pane ? grids.find((f) => f.id === pane.family) ?? catalog.find((f) => f.id === pane.family) : undefined;
  const isActive = active === id;
  const elev = pane?.scan?.meta.elevation;

  return (
    <div ref={headRef} className={`panehead${isActive ? " is-active" : ""}`} data-narrow={narrow ? "" : undefined}>
      <span className="panehead__name">
        {paneCount > 1 && (
          <button type="button" className="panehead__letter" onClick={() => focusPane(id)} title={`Pane ${paneLetter(id)} (key ${Number(id.slice(5)) + 1})`}>
            {paneLetter(id)}
          </button>
        )}
        {radarShown && pane && (pane.empty ? (
          <button type="button" className="panechip panechip--empty" onClick={() => pickProduct(id)} title="Pick a product for this pane, or drag one here from the product list">
            Select product
          </button>
        ) : (
          <span
            className="panechip panechip--radar"
            onPointerDown={(e) => beginPaneDrag(e, { kind: "radar", from: id, label: paneProductLabel(id) })}
          >
            <button
              type="button"
              className="panechip__main"
              onClick={() => pickProduct(id)}
              title={paneCount > 1 ? "Change this pane's product · drag onto another pane to move or swap" : "Change the product"}
            >
              {radarName && <span className="panehead__site">{radarName}</span>}
              {fam?.source === "level2" && <span className="panehead__l2">L2</span>}
              <span className="panechip__label">{fam?.label ?? pane.family}</span>
              {trail && <span className="panehead__trail" title="Maximum value trail since the loop's first frame (T)">Trail</span>}
              <RadarEventChip />
              {elev != null && <span className="panehead__tilt">{elev.toFixed(1)}°</span>}
            </button>
            {paneCount > 1 && (
              <button type="button" className="panechip__x" onClick={() => clearPane(id)} title="Take the product off this pane" aria-label="Remove product">
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {overlays.map((o) => (
          <span
            key={o.id}
            className={`panechip panechip--ov panechip--${o.kind}`}
            onPointerDown={(e) => paneCount > 1 && beginPaneDrag(e, { kind: "overlay", from: id, overlay: o.id, label: o.label })}
          >
            <button type="button" className="panechip__main" onClick={() => openPanel(o.panel)} title={`${o.label} · click to change${paneCount > 1 ? ", drag onto another pane to move" : ""}`}>
              <span className="panechip__label">{o.label}</span>
            </button>
            <button
              type="button"
              className="panechip__x"
              onClick={() => usePaneStore.getState().setHidden(id, o.id, true)}
              title={paneCount > 1 ? "Take this off this pane" : "Take this off the map"}
              aria-label={`Remove ${o.label}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {out && (
          <button type="button" className="panechip panechip--out" onClick={() => returnTo(id, out.lat, out.lon)} title={`${out.name} can't see this area · click to go back`}>
            Out of view
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * The product picker floats over the map's top-right corner, so whatever a
 * pane puts there (its switches, its own scrubber's right end) can be under
 * it. "shift" moves the element left of the picker, "shrink" pulls its right
 * edge in. Checked on resize and twice a second (the picker opens, folds and
 * can be dragged), written to the style without a re-render.
 */
function useClearOfPicker(ref: RefObject<HTMLDivElement | null>, mode: "shift" | "shrink", on: boolean): void {
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      if (mode === "shift") el.style.transform = "";
      else el.style.right = "";
      const a = el.getBoundingClientRect();
      const rpp = document.querySelector<HTMLElement>(".rpp");
      let dx = 0;
      if (rpp) {
        const b = rpp.getBoundingClientRect();
        if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) dx = a.right - b.left + 6;
      }
      if (!dx) return;
      if (mode === "shift") {
        // Moved left onto the pane's own chips: one row lower instead.
        const chips = el.parentElement?.querySelector<HTMLElement>(".panehead__name")?.getBoundingClientRect();
        const down = chips && chips.width > 0 && chips.right + 6 > a.left - dx && chips.bottom > a.top ? chips.bottom - a.top + 4 : 0;
        el.style.transform = `translate(${-dx}px, ${down}px)`;
      }
      else el.style.right = `${parseFloat(getComputedStyle(el).right) + dx}px`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    schedule();
    const t = window.setInterval(schedule, 500);
    window.addEventListener("resize", schedule);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref, mode, on]);
}

/** Top-right of a pane: the two sync switches and close. */
function PaneTools({ id }: { id: string }) {
  const count = useAppStore((s) => s.paneCount);
  const sync = usePaneStore((s) => s.sync[id] ?? DEFAULT_SYNC);
  const ref = useRef<HTMLDivElement>(null);
  useClearOfPicker(ref, "shift", true);
  // One pane: only its menu (Compare, ...), panes-compare.
  if (count < 2) {
    return (
      <div className="panetools" ref={ref}>
        <PaneMenuButton id={id} />
      </div>
    );
  }
  return (
    <div className="panetools" ref={ref}>
      <PaneMenuButton id={id} />
      <button
        type="button"
        className={`panetools__btn${sync.camera ? "" : " is-off"}`}
        aria-pressed={sync.camera}
        onClick={() => setCameraSync(id, !sync.camera)}
        title={sync.camera ? "Sync camera: on · this pane pans and zooms with the others" : "Sync camera: off · this pane moves on its own"}
      >
        {sync.camera ? <Link2 size={13} /> : <Link2Off size={13} />}
      </button>
      <button
        type="button"
        className={`panetools__btn${sync.follow ? "" : " is-off"}`}
        aria-pressed={sync.follow}
        onClick={() => setFollow(id, !sync.follow)}
        title={sync.follow ? "Follow the animation: on · this pane shows the timeline's frame" : "Follow the animation: off · this pane has its own scrubber"}
      >
        <Film size={13} />
      </button>
      <button type="button" className="panetools__btn panetools__close" onClick={() => closePane(id)} title="Close this pane" aria-label="Close this pane">
        <X size={13} />
      </button>
    </div>
  );
}

/** What dropping here would do: "Move … here", "Swap … ⇄ …", or null. */
function dropText(drag: PaneDrag): string | null {
  const to = drag.over;
  const act = to ? dropAction(drag.item, to) : null;
  if (!to || !act) return null;
  if (act === "swap") {
    const view = drag.item.kind === "analysis" ? usePaneStore.getState().analysis[to] : undefined;
    return `Swap ${drag.item.label} ⇄ ${view ? ANALYSIS_LABEL[view] : paneProductLabel(to)}`;
  }
  if (act === "show") return `Show ${drag.item.label} here`;
  return `Move ${drag.item.label} here`;
}

/** The target outline while a chip is dragged over this pane (the words go
 *  with the pointer, PaneDragGhost: a pane's middle can be under a panel). */
function PaneDropHint({ id }: { id: string }) {
  const drag = usePaneStore((s) => (s.drag?.over === id ? s.drag : null));
  if (!drag || !dropAction(drag.item, id)) return null;
  return <div className="panedrop" aria-hidden="true" />;
}

/** The chip following the pointer while dragging, saying what a drop does. */
export function PaneDragGhost() {
  const drag = usePaneStore((s) => s.drag);
  if (!drag) return null;
  const text = dropText(drag);
  // On <body>: the map area is a layer under the app's panels, the ghost is not.
  return createPortal(
    <div className={`panedrag-ghost${text ? " is-target" : ""}`} style={{ left: drag.x + 14, top: drag.y + 12 }} role="status" aria-live="polite">
      <span>{text ?? drag.item.label}</span>
      <small>{text ? "Release to drop · Esc cancels" : "Drop on a pane · Esc cancels"}</small>
    </div>,
    document.body,
  );
}

const OWN_SPEEDS = [0.5, 1, 2, 3, 5, 10, 20, 40, 80];
const OWN_DELAYS = [0, 0.5, 1, 2, 3, 5];

function nearestOf(scans: Array<{ time: number }>, t: number | null | undefined): number {
  if (t == null || !scans.length) return Math.max(0, scans.length - 1);
  let best = 0;
  for (let i = 1; i < scans.length; i++) if (Math.abs(scans[i].time - t) < Math.abs(scans[best].time - t)) best = i;
  return best;
}

function fmtTime(unix: number | undefined): string {
  if (!unix) return "--:--Z";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Follow the animation off: this pane's own play, rail, time, speed, delay. */
function PaneScrubber({ id }: { id: string }) {
  const count = useAppStore((s) => s.paneCount);
  const follow = usePaneStore((s) => (s.sync[id] ?? DEFAULT_SYNC).follow);
  const own = usePaneStore((s) => s.own[id]);
  const hasPane = useNexradStore((s) => !!s.paneRadar[id] && !s.paneRadar[id].empty);
  const ownTime = useNexradStore((s) => s.paneRadar[id]?.ownTime);
  const scans = useNexradStore((s) => s.scans);
  const site = useNexradStore((s) => s.site);
  const on = count > 1 && !follow && hasPane && !!site && scans.length > 0;
  const speed = own?.speed ?? (Number(getSetting<string>("timeline.speed")) || 1);
  const delay = own?.delay ?? (Number(getSetting<number>("timeline.loopDelay")) || 0);
  const playing = !!own?.playing;
  const barRef = useRef<HTMLDivElement>(null);
  useClearOfPicker(barRef, "shrink", on);

  // Follow turned off before a reload: park on the timeline's frame.
  useEffect(() => {
    if (on && ownTime == null) setFollow(id, false);
  }, [on, ownTime, id]);

  useEffect(() => {
    if (!on || !playing) return;
    let cancelled = false;
    void (async () => {
      while (!cancelled) {
        const t0 = performance.now();
        const s = useNexradStore.getState();
        const p = s.paneRadar[id];
        if (s.scans.length < 2 || !p || p.ownTime == null) break;
        const cur = nearestOf(s.scans, p.ownTime);
        const atEnd = cur >= s.scans.length - 1;
        if (atEnd && delay > 0) {
          await wait(delay * 1000);
          if (cancelled) break;
        }
        await showOwnFrame(id, atEnd ? 0 : cur + 1);
        const per = Number(getSetting<number>("timeline.radarMs")) / speed;
        await wait(Math.max(40, per - (performance.now() - t0)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [on, playing, speed, delay, id]);

  if (!on) return null;
  const at = nearestOf(scans, ownTime);
  const set = (patch: Partial<{ playing: boolean; speed: number; delay: number }>) =>
    usePaneStore.getState().setOwn(id, { playing, speed, delay, ...patch });

  return (
    <div className="paneplay" ref={barRef} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" className="paneplay__btn" onClick={() => set({ playing: !playing })} title={playing ? "Pause this pane" : "Play this pane's own loop"} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <input
        className="paneplay__rail"
        type="range"
        min={0}
        max={Math.max(0, scans.length - 1)}
        step={1}
        value={at}
        onChange={(e) => {
          set({ playing: false });
          void showOwnFrame(id, Number(e.target.value));
        }}
        aria-label="This pane's frame"
      />
      <span className="paneplay__time" title={scans[at] ? new Date(scans[at].time * 1000).toUTCString() : ""}>
        {fmtTime(scans[at]?.time)}
      </span>
      <select className="paneplay__sel" value={speed} onChange={(e) => set({ speed: Number(e.target.value) })} title="This pane's playback speed" aria-label="Speed">
        {(OWN_SPEEDS.includes(speed) ? OWN_SPEEDS : [...OWN_SPEEDS, speed].sort((a, b) => a - b)).map((v) => (
          <option key={v} value={v}>
            {v}×
          </option>
        ))}
      </select>
      <select className="paneplay__sel" value={delay} onChange={(e) => set({ delay: Number(e.target.value) })} title="Hold the last frame before the loop starts again" aria-label="Loop delay">
        {(OWN_DELAYS.includes(delay) ? OWN_DELAYS : [...OWN_DELAYS, delay].sort((a, b) => a - b)).map((v) => (
          <option key={v} value={v}>
            {v ? `${v} s hold` : "No hold"}
          </option>
        ))}
      </select>
    </div>
  );
}
