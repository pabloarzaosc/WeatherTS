import { useEffect, useRef, useSyncExternalStore } from "react";
import maplibregl from "maplibre-gl";

import { INITIAL_VIEW } from "./mapStyle";
import { buildBasemapStyle } from "./basemaps";
import { registerMap, setActivePane, allMaps, subscribeMaps, getActivePaneId, PRIMARY_PANE } from "./mapInstance";
import { LayerManager } from "../layers/manager";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";
import { RadarColorBar } from "../ui/RadarColorBar";

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
  for (const m of allMaps()) if (m !== src) m.jumpTo(view);
  syncing = false;
}

function syncFrom(src: maplibregl.Map) {
  if (syncing) return;
  pending = src;
  if (!frame) frame = requestAnimationFrame(flushSync);
}

export function MapPane({ id }: { id: string }) {
  const host = useRef<HTMLDivElement | null>(null);
  const primary = id === PRIMARY_PANE;
  const focused = useSyncExternalStore(subscribeMaps, getActivePaneId) === id;

  useEffect(() => {
    if (!host.current) return;
    const store = useAppStore;

    // A new pane opens on the view the others are already at, rather than
    // snapping the user back out to the world.
    const peer = allMaps()[0];
    const start = peer
      ? { center: peer.getCenter(), zoom: peer.getZoom(), bearing: peer.getBearing(), pitch: peer.getPitch() }
      : { center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom, bearing: 0, pitch: 0 };

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
    useNexradStore.getState().addPane(id);
    if (import.meta.env.DEV) {
      const w = window as unknown as { __map?: maplibregl.Map; __panes?: Record<string, maplibregl.Map> };
      if (primary) w.__map = map;
      w.__panes = { ...(w.__panes ?? {}), [id]: map };
    }

    const manager = new LayerManager(map);
    const syncLayers = () => void manager.sync(store.getState());

    map.on("load", () => {
      map.setProjection({ type: store.getState().projection });
      if (primary) {
        const c = map.getCenter();
        store.getState().setReadout(c.lng, c.lat, map.getZoom());
      }
      syncLayers();
    });

    // Only the primary pane drives the status-bar readout; every pane shares
    // the camera, so the numbers would be identical anyway.
    const onMouseMove = (e: maplibregl.MapMouseEvent) =>
      store.getState().setReadout(e.lngLat.lng, e.lngLat.lat, map.getZoom());
    if (primary) map.on("mousemove", onMouseMove);

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
        map.setStyle(buildBasemapStyle(basemapId), { diff: false });
        map.once("style.load", () => {
          map.setProjection({ type: store.getState().projection });
          manager.reset();
          syncLayers();
        });
      },
    );

    return () => {
      ro.disconnect();
      unsubLayers();
      unsubOrder();
      unsubProjection();
      unsubBasemap();
      map.off("move", onMove);
      map.off("mousedown", focus);
      map.off("touchstart", focus);
      if (primary) map.off("mousemove", onMouseMove);
      useNexradStore.getState().dropPane(id);
      registerMap(id, null);
      map.remove();
    };
  }, [id, primary]);

  return (
    <div
      className={`mappane${focused ? " is-focused" : ""}`}
      data-pane={id}
      onMouseDown={() => {
        setActivePane(id);
        useNexradStore.getState().focusPane(id);
      }}
    >
      <div ref={host} className="mappane__canvas" />
      <PaneHeader id={id} />
      {/* each pane carries its own scale -- one shared bar across six different
          products was meaningless, and it spanned the panes it didn't describe */}
      <div className="mappane__cbar">
        <RadarColorBar paneId={id} />
      </div>
    </div>
  );
}

/**
 * The pane's title bar: what this window is showing, and the way to aim the
 * product picker at it.
 *
 * The picker itself is a single panel top-right (there is no room for a full
 * product list per pane), so the header is what makes "which pane am I editing"
 * answerable: clicking it focuses this pane, and the focused pane is marked.
 */
function PaneHeader({ id }: { id: string }) {
  const pane = useNexradStore((s) => s.paneRadar[id]);
  const grids = useNexradStore((s) => s.grids);
  const site = useNexradStore((s) => s.site);
  const paneCount = useNexradStore((s) => Object.keys(s.paneRadar).length);
  const active = useSyncExternalStore(subscribeMaps, getActivePaneId);

  if (!pane || !site || grids.length === 0) return null;
  const fam = grids.find((f) => f.id === pane.family);
  const isActive = active === id;

  return (
    <div className={`panehead${isActive ? " is-active" : ""}`}>
      <button
        type="button"
        className="panehead__focus"
        onClick={() => {
          setActivePane(id);
          useNexradStore.getState().focusPane(id);
        }}
        title={isActive ? "This pane has the product picker" : "Edit this pane"}
      >
        <span className="panehead__name">
          {fam?.source === "level2" && <span className="panehead__l2">L2</span>}
          {fam?.label ?? pane.family}
        </span>
        <span className="panehead__tilt">
          {pane.scan?.meta.elevation != null ? `${pane.scan.meta.elevation.toFixed(1)}°` : ""}
        </span>
      </button>
      {paneCount > 1 && !isActive && <span className="panehead__hint">click to edit</span>}
    </div>
  );
}
