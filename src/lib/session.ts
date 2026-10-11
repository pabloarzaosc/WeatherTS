/**
 * The workspace across reloads and restarts.
 *
 * Leaving the page, refreshing it or reopening the app brings back what was on
 * screen: which layers were on, at what opacity and in what order, where the
 * map was looking, the radar and its options, how each layer was set up, and
 * the hydrograph or dashboards that were open.
 *
 * The stores that already keep their own choices (models, satellite, theme,
 * drawings, the Tropical and Space dashboards' settings, the panels' layout)
 * are left to do so; this keeps the rest, in one localStorage entry written a
 * moment after anything changes and again as the page goes away.
 *
 * What it does not bring back on purpose: archive playback (the app opens on
 * the present), a location being shared (never resumed without being asked),
 * and anything that needs an account for a visitor without one -- those layers
 * are restored as they were and AccountGuard turns them off quietly, as it
 * always has.
 */
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore, type LayerUIState } from "../store/useAppStore";
import { useGlmStore } from "../store/useGlmStore";
import { useLsrStore } from "../store/useLsrStore";
import { useNexradStore } from "../store/useNexradStore";
import { useRiverStore } from "../store/useRiverStore";
import { useSurfaceObsStore } from "../store/useSurfaceObsStore";

const KEY = "weatherts.session.v1";
const SAVE_DELAY_MS = 400;

export interface SavedView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

type Pick<S, K extends keyof S> = { [P in K]?: S[P] };

const RADAR = ["site", "family", "tilt", "frames", "smooth", "threshold", "showRing", "showTracks", "showReadout", "autoUpdate"] as const;
const SURFACE = ["displayMode", "networks", "elements", "spacing", "size", "tempUnits", "windUnits", "presUnits", "visUnits", "maxAgeMin", "fadeStale"] as const;
const ALERTS = ["categoryFilters", "listOpen"] as const;
const LSR = ["span", "cats", "minSeverity", "showLabels", "fadeOld", "inView", "sort"] as const;
const RIVERS = ["filter", "networks", "nwm", "selected"] as const;
const GLM = ["sat", "minutes"] as const;

type NexradS = ReturnType<typeof useNexradStore.getState>;
type SurfaceS = ReturnType<typeof useSurfaceObsStore.getState>;
type AlertS = ReturnType<typeof useAlertStore.getState>;
type LsrS = ReturnType<typeof useLsrStore.getState>;
type RiverS = ReturnType<typeof useRiverStore.getState>;
type GlmS = ReturnType<typeof useGlmStore.getState>;

interface Saved {
  layers?: Record<string, LayerUIState>;
  order?: string[];
  view?: SavedView;
  radar?: Pick<NexradS, (typeof RADAR)[number]>;
  surface?: Pick<SurfaceS, (typeof SURFACE)[number]>;
  alerts?: Pick<AlertS, (typeof ALERTS)[number]>;
  lsr?: Pick<LsrS, (typeof LSR)[number]>;
  rivers?: Pick<RiverS, (typeof RIVERS)[number]>;
  glm?: Pick<GlmS, (typeof GLM)[number]>;
}

function read(): Saved {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "{}") as Saved;
  } catch {
    return {};
  }
}

function pick<S extends object, K extends keyof S>(state: S, keys: readonly K[]): Pick<S, K> {
  const out: Pick<S, K> = {};
  for (const k of keys) out[k] = state[k];
  return out;
}

/** Only the keys the store still has: a field renamed since the save is dropped,
 *  not written in under a name nothing reads. */
function known<S extends object>(state: S, saved: object | undefined): Partial<S> {
  const out: Partial<S> = {};
  if (!saved) return out;
  for (const [k, v] of Object.entries(saved)) if (k in state && v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

let view: SavedView | null = null;
/** The radar last shown: kept while the layer is off, so it comes back with it. */
let lastSite: string | null = null;

/** Where the map was looking, for the first pane to open on. */
export function savedView(): SavedView | null {
  return view;
}

/** Call after the layer registry has seeded the defaults (initLayers). */
export function restoreSession(): void {
  const saved = read();
  view = saved.view && Array.isArray(saved.view.center) && Number.isFinite(saved.view.zoom) ? saved.view : null;

  // Layers: what was on and how, straight into the store (not through
  // setLayerVisible, whose account check would put a sign-in prompt up at boot).
  const app = useAppStore.getState();
  if (saved.layers) {
    const layers = { ...app.layers };
    for (const [id, l] of Object.entries(saved.layers)) {
      if (layers[id] && typeof l?.visible === "boolean") {
        layers[id] = { visible: l.visible, opacity: typeof l.opacity === "number" ? l.opacity : layers[id].opacity };
      }
    }
    useAppStore.setState({ layers });
  }
  if (saved.order?.length) {
    // The saved stack, with any layer added since slotted in after the one it
    // follows in the registry's own order.
    const defaults = app.layerOrder;
    const order = saved.order.filter((id) => defaults.includes(id));
    defaults.forEach((id, i) => {
      if (order.includes(id)) return;
      const before = defaults.slice(0, i).reverse().find((d) => order.includes(d));
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    });
    useAppStore.setState({ layerOrder: order });
  }

  // The radar's options now; its site once the catalogue is in, because
  // selectSite checks the site against it (and only then loads the scans).
  // The radar layer clears its site whenever it leaves the map, and the map
  // reloads its style once at start, so the saved site waits until it has
  // been on screen a while, put back each time the layer returns without
  // one, unless someone picks another radar first.
  const nexrad = useNexradStore.getState();
  const { site, ...radar } = known(nexrad, saved.radar);
  useNexradStore.setState(radar);
  lastSite = site ?? null;
  let pending = site ?? null;
  let settled = 0;
  useNexradStore.subscribe((s) => {
    if (s.site) lastSite = s.site;
    if (!pending) return;
    if (s.site && s.site !== pending) {
      pending = null;
      return;
    }
    if (s.site === pending) {
      settled ||= window.setTimeout(() => (pending = null), 30_000);
      return;
    }
    const on = useAppStore.getState().layers.nexrad?.visible;
    if (on && s.sites.some((x) => x.id === pending)) s.selectSite(pending);
  });

  useSurfaceObsStore.setState(known(useSurfaceObsStore.getState(), saved.surface));
  useAlertStore.setState(known(useAlertStore.getState(), saved.alerts));
  useLsrStore.setState(known(useLsrStore.getState(), saved.lsr));
  useGlmStore.setState(known(useGlmStore.getState(), saved.glm));
  const { selected, ...rivers } = known(useRiverStore.getState(), saved.rivers);
  useRiverStore.setState(rivers);
  // A hydrograph that was open opens again (it fetches its own data).
  if (selected) useRiverStore.getState().select(selected);

  watch();
}

let timer = 0;

function snapshot(): Saved {
  const app = useAppStore.getState();
  return {
    layers: app.layers,
    order: app.layerOrder,
    view: view ?? undefined,
    radar: { ...pick(useNexradStore.getState(), RADAR), site: useNexradStore.getState().site ?? lastSite },
    surface: pick(useSurfaceObsStore.getState(), SURFACE),
    alerts: pick(useAlertStore.getState(), ALERTS),
    lsr: pick(useLsrStore.getState(), LSR),
    rivers: pick(useRiverStore.getState(), RIVERS),
    glm: pick(useGlmStore.getState(), GLM),
  };
}

function writeNow(): void {
  window.clearTimeout(timer);
  timer = 0;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snapshot()));
  } catch {
    /* storage full or blocked: the session simply is not kept */
  }
}

function save(): void {
  if (!timer) timer = window.setTimeout(writeNow, SAVE_DELAY_MS);
}

/** The map's camera, from the pane that leads (called on its moveend). */
export function noteView(v: SavedView): void {
  view = v;
  save();
}

function watch(): void {
  // Each store's changes, but only the fields above matter; the comparisons
  // keep a radar loop's frames or a data refresh from rewriting the entry.
  const fields = <S extends object>(keys: readonly (keyof S)[]) => (s: S, p: S) => keys.some((k) => s[k] !== p[k]);
  useAppStore.subscribe((s, p) => (s.layers !== p.layers || s.layerOrder !== p.layerOrder) && save());
  const radarChanged = fields<NexradS>(RADAR);
  useNexradStore.subscribe((s, p) => radarChanged(s, p) && save());
  const surfaceChanged = fields<SurfaceS>(SURFACE);
  useSurfaceObsStore.subscribe((s, p) => surfaceChanged(s, p) && save());
  const alertsChanged = fields<AlertS>(ALERTS);
  useAlertStore.subscribe((s, p) => alertsChanged(s, p) && save());
  const lsrChanged = fields<LsrS>(LSR);
  useLsrStore.subscribe((s, p) => lsrChanged(s, p) && save());
  const riversChanged = fields<RiverS>(RIVERS);
  useRiverStore.subscribe((s, p) => riversChanged(s, p) && save());
  const glmChanged = fields<GlmS>(GLM);
  useGlmStore.subscribe((s, p) => glmChanged(s, p) && save());
  // Whatever is still waiting goes down as the page does.
  window.addEventListener("pagehide", writeNow);
  window.addEventListener("beforeunload", writeNow);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && timer && writeNow());
}
