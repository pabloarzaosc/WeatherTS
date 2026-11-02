import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import maplibregl from "maplibre-gl";

import { INITIAL_VIEW } from "./mapStyle";
import { noteView, savedView } from "../lib/session";
import { buildBasemapStyle } from "./basemaps";
import { registerMap, setActivePane, allMaps, subscribeMaps, getActivePaneId, paneIdOf, PRIMARY_PANE } from "./mapInstance";
import { PaneChrome } from "../ui/PaneChrome";
import { paneLayerState, usePaneStore } from "../store/usePaneStore";
import { LayerManager } from "../layers/manager";
import { attachSettings } from "../settings/mapStyle";
import { useSettingsStore } from "../settings/useSettingsStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { ObsColorBar } from "../ui/ObsColorBar";
import { RadarColorBar } from "../ui/RadarColorBar";
import { RadarLiveNote } from "../ui/RadarLiveNote";
import { PaneConnNote } from "../ui/ConnectionBadge";
import { BroadcastCaption } from "../ui/BroadcastCaption";
import { PaneCompare } from "../ui/PaneCompare";
import { useCompareStore } from "../store/useCompareStore";
import { raise } from "../lib/paneWindows";

// One split-screen pane: a full MapLibre map with the whole layer stack, so a
// pane is a real workspace (alerts, sounding clicks, tools) and not a
// picture-in-picture. Panes share the camera and the timeline; only the radar
// product differs.

// Camera sync.
//
// Two things make the naive version unusable with 4-6 panes:
//   * `move` fires many times per drag, and each one did N-1 `jumpTo` calls --
//     so panning six panes meant ~5x the camera work per event and it felt like
//     dragging through treacle. The sync is coalesced onto one animation frame:
//     however many move events land in a frame, the followers are moved once.
//   * a follower's own `jumpTo` fires ITS `move`, which would bounce back and
//     fight the pane being dragged, so re-entry is guarded.
let syncing = false;
let pending: maplibregl.Map | null = null;
let frame = 0;

function flushSync() {
  frame = 0;
  const src = pending;
  pending = null;
  if (!src) return;
  syncing = true;
  const view = {
    center: src.getCenter(),
    zoom: src.getZoom(),
    bearing: src.getBearing(),
    pitch: src.getPitch(),
  };
  // Only the panes with Sync camera on move together (panes-layout).
  for (const m of allMaps()) if (m !== src && cameraShared(m)) m.jumpTo(view);
  syncing = false;
}

function cameraShared(m: maplibregl.Map): boolean {
  const id = paneIdOf(m);
  return !id || usePaneStore.getState().syncOf(id).camera;
}

function syncFrom(src: maplibregl.Map) {
  if (syncing || !cameraShared(src)) return;
  pending = src;
  if (!frame) frame = requestAnimationFrame(flushSync);
}

/** panes-compare: where MapView puts the pane -- a grid cell, or a floating
 *  window's box (the same element either way, so the map never remounts). */
export interface PanePlace {
  style?: CSSProperties;
  floating?: boolean;
}

export function MapPane({ id, place }: { id: string; place?: PanePlace }) {
  const host = useRef<HTMLDivElement | null>(null);
  const primary = id === PRIMARY_PANE;
  const focused = useSyncExternalStore(subscribeMaps, getActivePaneId) === id;
  // The product was taken off this pane ("Select product"): no radar scale.
  const empty = useNexradStore((s) => !!s.paneRadar[id]?.empty);
  // Compare (panes-compare): where the divider is, for the two scales.
  const cmpSplit = useCompareStore((s) => s.slots[id]?.split);

  useEffect(() => {
    if (!host.current) return;
    const store = useAppStore;

    // A new pane opens on the view the others are already at, rather than
    // snapping the user back out to the world; the first one on the view the
    // last visit ended on.
    const peer = allMaps()[0];
    const last = savedView();
    const start = peer
      ? { center: peer.getCenter(), zoom: peer.getZoom(), bearing: peer.getBearing(), pitch: peer.getPitch() }
      : (last ?? { center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom, bearing: 0, pitch: 0 });

    const map = new maplibregl.Map({
      container: host.current,
      // A freshly built object per pane: MapLibre takes ownership of the style
      // it is handed, so panes sharing one literal would corrupt each other's
      // layer bookkeeping.
      style: buildBasemapStyle(store.getState().basemapId),
      center: start.center,
      zoom: start.zoom,
      bearing: start.bearing,
      pitch: start.pitch,
      attributionControl: false,
      // Split screen multiplies every frame's cost by the pane count, so drop
      // the work that buys nothing here: the cross-fade on tile/label changes
      // (visible as churn while panning) and the repeated world copies either
      // side of the antimeridian, which no radar view needs.
      fadeDuration: 0,
      renderWorldCopies: false,
      // preserveDrawingBuffer is required to read pixels back off the canvas
      // (the GIF export). Without it the drawing buffer is cleared after each
      // paint and every capture comes back blank -- and WebGL context
      // attributes cannot be changed after construction.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    registerMap(id, map);
    // The camera the next visit opens on. The panes share one camera, so the
    // primary's is enough, kept as it settles rather than on every frame.
    if (primary) {
      map.on("moveend", () => {
        const c = map.getCenter();
        noteView({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
      });
    }
    useNexradStore.getState().addPane(id);
    if (import.meta.env.DEV) {
      const w = window as unknown as { __map?: maplibregl.Map; __panes?: Record<string, maplibregl.Map> };
      if (primary) w.__map = map;
      w.__panes = { ...(w.__panes ?? {}), [id]: map };
    }

    const manager = new LayerManager(map);
    // Settings restyle whatever the modules draw, on this pane as on every other.
    const detachSettings = attachSettings(map);

    /**
     * Sync only once the style can actually take layers, and re-run when it can.
     *
     * addSource/addLayer throw while the style is still loading, and the "load"
     * event is one-shot: if the style request to the tile host is slow or
     * fails, that event never fires and NOTHING is ever added -- not radar, not
     * alerts, not boundaries. That is the "nothing works at all" state, and
     * without this it never recovered, because every later toggle threw too.
     *
     * The gate is a latch, NOT map.isStyleLoaded(). That method answers "is
     * everything in the style settled right now", which folds in whether every
     * source has finished loading -- so a layer holding an unsettled source
     * (a live feed, a custom WebGL layer) pins it to false for as long as the
     * app runs. Gating on it meant that after the first successful sync every
     * later toggle took the "not ready yet" branch and parked itself on a
     * style.load that only fires on setStyle: pendingSync latched true and no
     * layer switched on again until the page was reloaded or the basemap
     * changed. That is the "I turn it on and nothing happens" bug, and it was
     * never about the layer being toggled.
     *
     * style.load fires again after each setStyle, so waiting on it also covers
     * a basemap switch that lands mid-sync.
     */
    let styleReady = false;
    let pendingSync = false;
    const syncLayers = () => {
      if (styleReady) {
        void manager.sync(paneLayerState(store.getState(), id));
        return;
      }
      if (pendingSync) return;
      pendingSync = true;
      map.once("style.load", () => {
        pendingSync = false;
        styleReady = true;
        void manager.sync(paneLayerState(store.getState(), id));
      });
    };

    // MapLibre swallows style/tile failures into an "error" event that nothing
    // was listening for, so a map that never finished loading looked identical
    // to one with no data. Log it -- this is the breadcrumb for "nothing works".
    map.on("error", (e) => {
      console.error("[map]", (e as { error?: Error }).error?.message ?? e);
    });

    map.on("load", () => {
      styleReady = true;
      map.setProjection({ type: store.getState().projection });
      if (primary) {
        const c = map.getCenter();
        store.getState().setReadout(c.lng, c.lat, map.getZoom());
      }
      syncLayers();
    });

    /**
     * The safety net under that latch.
     *
     * "load" and "style.load" are one-shot per style, and a sync that arrives
     * before either of them parks itself on an event that may already have
     * passed -- the layer then reads as ON in the panel with nothing on the
     * map, and only switching it off and on again fixes it. styledata fires
     * every time the style becomes usable, including that first parse and
     * every setStyle after it, so it is the signal that always comes. Adding a
     * layer twice is a no-op in every module, and the manager catches an add
     * that lands too early, so re-running the reconcile here is free.
     */
    //
    // Once per task: a burst of style writes (a module adding five layers, a
    // filter per step of the timeline) is one reconcile, not five.
    let styleSync: ReturnType<typeof setTimeout> | 0 = 0;
    const onStyleData = () => {
      styleReady = true;
      pendingSync = false;
      if (styleSync) return;
      styleSync = setTimeout(() => {
        styleSync = 0;
        void manager.sync(paneLayerState(store.getState(), id));
      }, 0);
    };
    map.on("styledata", onStyleData);

    // Every pane drives the readout and says which one it is: the value under the
    // pointer is that pane's product. The zoom stays the primary's, like setZoom.
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const app = store.getState();
      app.setReadout(e.lngLat.lng, e.lngLat.lat, primary ? map.getZoom() : app.zoom, id);
    };
    map.on("mousemove", onMouseMove);

    const onMove = () => {
      if (primary) store.getState().setZoom(map.getZoom());
      syncFrom(map);
    };
    map.on("move", onMove);

    // Interacting with a pane focuses it, so getMap()-based tools follow.
    //
    // The store has to be told as well. Without this the registry knew which
    // pane was focused but the radar store's family/tilt still mirrored the
    // pane focused *before*, so the top-right picker showed one pane's product
    // while editing another's -- the "one button that changes all the screens"
    // bug. focusPane() pulls the newly focused pane's state up to the top level
    // that the picker, colour bar and readout all read.
    const focus = () => {
      setActivePane(id);
      useNexradStore.getState().focusPane(id);
    };
    map.on("mousedown", focus);
    map.on("touchstart", focus);

    // The pane's box changes when the panel pushes the map, when the layout
    // switches, and on window resize. MapLibre only re-reads its size when told,
    // so watch the container instead of hooking each of those separately.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(host.current);

    const unsubLayers = store.subscribe((s) => s.layers, syncLayers);
    const unsubOrder = store.subscribe((s) => s.layerOrder, syncLayers);
    // Fill strengths in Settings are part of each module's opacity, which the
    // manager pushes on every reconcile.
    const unsubSettings = useSettingsStore.subscribe((s) => s.values, syncLayers);
    // Overlays taken off this pane (its chips' x), panes-layout.
    const unsubHidden = usePaneStore.subscribe((s, p) => s.hidden[id] !== p.hidden[id] && syncLayers());
    const unsubProjection = store.subscribe(
      (s) => s.projection,
      (projection) => map.setProjection({ type: projection }),
    );
    // setStyle() throws away every source and layer the app added, so the
    // manager has to forget what it thinks is on the map and add it all back
    // once the new style is live. Projection is style-independent state that
    // setStyle also resets, hence re-applying it here too.
    const unsubBasemap = store.subscribe(
      (s) => s.basemapId,
      (basemapId) => {
        // The new style has no custom layers yet, so the latch drops until its
        // own style.load lands -- otherwise a toggle arriving mid-swap would be
        // told the style was ready and throw against a style being replaced.
        styleReady = false;
        map.setStyle(buildBasemapStyle(basemapId), { diff: false });
        map.once("style.load", () => {
          styleReady = true;
          map.setProjection({ type: store.getState().projection });
          manager.reset(paneLayerState(store.getState(), id));
          syncLayers();
        });
      },
    );

    return () => {
      ro.disconnect();
      detachSettings();
      if (styleSync) clearTimeout(styleSync);
      map.off("styledata", onStyleData);
      unsubLayers();
      unsubOrder();
      unsubSettings();
      unsubHidden();
      unsubProjection();
      unsubBasemap();
      map.off("move", onMove);
      map.off("mousedown", focus);
      map.off("touchstart", focus);
      map.off("mousemove", onMouseMove);
      useNexradStore.getState().dropPane(id);
      registerMap(id, null);
      // Before remove(), not after: the modules unsubscribe from their stores
      // in removeFrom, and a listener that outlives the map fires against a
      // destroyed style on the next store write.
      manager.destroy();
      map.remove();
    };
  }, [id, primary]);

  return (
    <div
      className={`mappane${focused ? " is-focused" : ""}${place?.floating ? " is-floating" : ""}`}
      data-pane={id}
      data-empty={empty ? "" : undefined}
      data-compare={cmpSplit != null && !empty ? "" : undefined}
      style={{ ...place?.style, ...(cmpSplit != null ? ({ "--cmp-split": String(cmpSplit) } as CSSProperties) : {}) }}
      onMouseDown={() => {
        setActivePane(id);
        useNexradStore.getState().focusPane(id);
      }}
      onPointerDown={() => place?.floating && raise(id)}
    >
      <div ref={host} className="mappane__canvas" />
      <PaneChrome id={id} />
      <PaneCompare id={id} />
      {/* broadcast mode: "KTLX REF 0.5°" + scan time, top-left (ux-shell) */}
      <BroadcastCaption paneId={id} />
      {/* each pane carries its own scale -- one shared bar across six different
          products was meaningless, and it spanned the panes it didn't describe */}
      <div className="mappane__cbar">
        {/* Streaming line + "isn't scanned yet" notes, just above the scale:
            the top-left corner belongs to the search box and the pane header. */}
        <PaneConnNote paneId={id} />
        <RadarLiveNote paneId={id} />
        <RadarColorBar paneId={id} />
        <ObsColorBar />
        {/* The mosaic is not a per-pane product -- one grid covers the app --
            so its scale is drawn once, under the pane that owns the tools. */}
      </div>
    </div>
  );
}
