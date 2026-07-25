import maplibregl, { type MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";

const SRC = "raob-src";
const DOTS = "raob-dots";
// Bundled global upper-air station network (IGRA active + IEM North America).
// BASE_URL is "./" in the packaged Electron build, so an absolute "/data"
// would point at the filesystem root instead of the bundled asset.
const DATA_URL = `${import.meta.env.BASE_URL}data/raob-stations.geojson`;
const DEFAULT_OPACITY = 0.9;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Per-map: with split-screen this module is added to several maps, and shared
// handler variables would have each pane detaching the previous pane's.
interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: (e: MapLayerMouseEvent) => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

// Salmon dots like a pro workstation's RAOB plot. Data is global now (IEM for
// North America, University of Wyoming BUFR worldwide), so all sites share one
// colour; only stations with neither an IEM id nor a WMO number are dimmed.
const dotColor = (o: number) => [
  "case",
  ["==", ["get", "src"], "none"],
  ["rgba", 200, 150, 150, Math.max(0, o - 0.4)],
  ["rgba", 247, 138, 138, o],
] as const;

/** Observed radiosonde (RAOB) launch sites. Click a dot to open its sounding. */
export const raobLayer: LayerModule = {
  id: "raob",
  name: "RAOB Stations",
  description: "Upper-air radiosonde launch sites. Click a station for its observed sounding.",
  category: "weather",
  source: "IGRA (NOAA) + IEM observations",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: DATA_URL });
    }
    if (!map.getLayer(DOTS)) {
      map.addLayer({
        id: DOTS,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.2, 4, 3.2, 8, 5.5],
          "circle-color": dotColor(DEFAULT_OPACITY) as never,
          "circle-stroke-color": "rgba(255,255,255,0.85)",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1],
        },
      });
    }

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties || {};
      const geom = f.geometry;
      const [lon, lat] = geom.type === "Point" ? (geom.coordinates as [number, number]) : [e.lngLat.lng, e.lngLat.lat];
      useSoundingViewerStore.getState().openRaob({
        id: String(p.sid || p.id), // IEM sid where available; else station id
        name: String(p.name || p.id || "RAOB"),
        lat,
        lon,
        wmo: p.wmo != null ? String(p.wmo) : undefined, // global (Wyoming) source
      });
    };
    // Soundings stay as dots (the user wanted that), but hovering one shows its
    // name + location in a small tooltip.
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 10,
      className: "raobpop",
    });
    const onEnter = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      const name = String(p.name || p.id || "RAOB");
      popup
        .setLngLat([lon, lat])
        .setHTML(
          `<div class="raobtip"><b>${esc(name)}</b><span>${lat.toFixed(2)}°, ${lon.toFixed(2)}°</span></div>`,
        )
        .addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    map.on("click", DOTS, onClick);
    map.on("mouseenter", DOTS, onEnter);
    map.on("mouseleave", DOTS, onLeave);
    state.set(map, { onClick, onEnter, onLeave, popup });
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      map.off("click", DOTS, st.onClick);
      map.off("mouseenter", DOTS, st.onEnter);
      map.off("mouseleave", DOTS, st.onLeave);
      st.popup.remove();
      state.delete(map);
    }
    if (map.getLayer(DOTS)) map.removeLayer(DOTS);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(DOTS)) map.setPaintProperty(DOTS, "circle-color", dotColor(opacity) as never);
  },

  getLayerIds() {
    return [DOTS];
  },
};
