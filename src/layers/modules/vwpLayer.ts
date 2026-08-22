import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import { fetchNexradSites } from "../../lib/nexrad";
import { useVwpStore } from "../../store/useVwpStore";

const SRC = "vwp-src";
const DOTS = "vwp-dots";
const LABEL = "vwp-label";
const DEFAULT_OPACITY = 0.95;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

interface PaneState {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: (e: MapLayerMouseEvent) => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Radars, as a source of wind profiles.
 *
 * Deliberately a separate layer from the radar product itself: this is not
 * "which radar am I looking at", it is "whose wind profile can I open", which
 * is the same question the RAOB and ACARS dots answer. Clicking one opens that
 * radar's VAD wind profile as the classic time-height display -- the winds it
 * actually measured, volume by volume, not a sounding built around them.
 */
export const vwpLayer: LayerModule = {
  id: "vwp",
  name: "VAD Wind Profiles (radar)",
  description:
    "Radar sites, as wind profiles. Click one for its VAD wind profile over time.",
  category: "weather",
  source: "NEXRAD Level III VAD wind profile",
  defaultVisible: false,
  defaultOpacity: DEFAULT_OPACITY,

  addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    if (!map.getLayer(DOTS)) {
      map.addLayer({
        id: DOTS,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 5, 5, 9, 7],
          "circle-color": `rgba(125, 211, 252, ${DEFAULT_OPACITY})`,
          "circle-stroke-color": "rgba(255,255,255,0.85)",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 2, 0.5, 6, 1.2],
        },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        minzoom: 5,
        layout: {
          "text-field": ["get", "icao"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": "#dfe9f5",
          "text-halo-color": "rgba(8,12,18,0.9)",
          "text-halo-width": 1.2,
        },
      });
    }

    // The site list is a day-long cache in the store's fetch layer, so this is
    // one request the first time the layer is switched on and nothing after.
    void fetchNexradSites()
      .then((sites) => {
        const fc: GeoJSON.FeatureCollection = {
          type: "FeatureCollection",
          features: sites
            .filter((s) => s.online !== false)
            .map((s) => ({
              type: "Feature" as const,
              geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
              properties: { id: s.id, icao: s.icao, name: s.name, lat: s.lat, lon: s.lon },
            })),
        };
        (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(fc);
      })
      .catch(() => {
        /* no sites, no dots -- the layer simply shows nothing */
      });

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "raobpop",
    });

    const onEnter = (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      popup
        .setLngLat([lon, lat])
        .setHTML(
          `<div class="raobtip"><b>${esc(String(p.icao))}</b>` +
            `<span>${esc(String(p.name ?? ""))}</span>` +
            `<span>VAD wind profile — time and height</span></div>`,
        )
        .addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      // The panel fetches by site id, so the click needs nothing but that:
      // the profile belongs to the radar, not to the spot that was clicked.
      useVwpStore.getState().setOpen(true, String((f.properties || {}).id));
    };

    registerMarkerLayers([DOTS]);
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
    unregisterMarkerLayers([DOTS]);
    for (const id of [LABEL, DOTS]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(DOTS)) {
      map.setPaintProperty(DOTS, "circle-color", `rgba(125, 211, 252, ${opacity})`);
    }
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
  },

  getLayerIds() {
    return [DOTS, LABEL];
  },

  // Same reasoning as the RAOB and ACARS dots: a small clickable marker that
  // opens a sounding must not end up under a radar sweep or an alert fill.
  topLayerIds() {
    return [DOTS, LABEL];
  },
  topPriority: 36,
};
