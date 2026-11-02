import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { registerMarkerLayers, unregisterMarkerLayers } from "../clickPriority";
import { EVENT_CATEGORIES, EVENT_COLORS, eventDay, searchEvents } from "../../lib/radarEvents";
import { mapInk } from "../../map/mapInk";
import { useRadarEventStore } from "../../store/useRadarEventStore";

/**
 * Notable radar events as dots ("Show on map" in the Archive panel): the
 * events the panel's search and category filter leave, coloured by category.
 * A click opens the event on the radar.
 */

const SRC = "radar-events-src";
const RING = "radar-events-ring";
const DOT = "radar-events-dot";
const LABEL = "radar-events-label";
const LAYERS = [RING, DOT, LABEL];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface PaneState {
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onMove: (e: MapLayerMouseEvent) => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
}
const state = new WeakMap<MapLibreMap, PaneState>();
let opacity = 1;

function build(): GeoJSON.FeatureCollection {
  const { query, filter, active } = useRadarEventStore.getState();
  return {
    type: "FeatureCollection",
    features: searchEvents(query, filter).map((e) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: {
        id: e.id,
        label: `${e.title} ${eventDay(e).slice(0, 4)}`,
        color: EVENT_COLORS[e.category],
        on: e.id === active ? 1 : 0,
      },
    })),
  };
}

function push(map: MapLibreMap): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(build());
}

export const radarEventsLayer: LayerModule = {
  id: "radarEvents",
  name: "Notable radar events",
  description: "Tornadoes, hurricanes, derechos and hailstorms from the Archive panel; click one to load it",
  category: "weather",
  source: "WeatherTS, checked against the NEXRAD Level II archive",
  defaultVisible: false,
  defaultOpacity: 1,

  addTo(map) {
    if (map.getSource(SRC)) return;
    const ink = mapInk();
    map.addSource(SRC, { type: "geojson", data: build() });
    map.addLayer({
      id: RING,
      type: "circle",
      source: SRC,
      filter: ["==", ["get", "on"], 1],
      paint: {
        "circle-radius": 11,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2,
        "circle-opacity": opacity,
        "circle-stroke-opacity": opacity,
      },
    });
    map.addLayer({
      id: DOT,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4, 8, 6.5],
        "circle-color": ["get", "color"],
        "circle-stroke-color": ink.halo,
        "circle-stroke-width": 1.5,
        "circle-opacity": opacity,
        "circle-stroke-opacity": opacity,
      },
    });
    map.addLayer({
      id: LABEL,
      type: "symbol",
      source: SRC,
      minzoom: 5.2,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": ink.text, "text-halo-color": ink.halo, "text-halo-width": 1.4, "text-opacity": opacity },
    });
    registerMarkerLayers([DOT]);

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "evdot-pop" });
    // Dots a few km apart sit on top of each other zoomed out (El Reno 2011
    // and 2013): a click on more than one zooms in instead of picking one.
    const under = (e: MapLayerMouseEvent) => {
      const ids = [...new Set((e.features ?? []).map((f) => f.properties?.id as string).filter(Boolean))];
      const all = searchEvents("", "all");
      return ids.map((id) => all.find((x) => x.id === id)!).filter(Boolean);
    };
    const onClick = (e: MapLayerMouseEvent) => {
      const evs = under(e);
      if (!evs.length) return;
      popup.remove();
      if (evs.length > 1 && map.getZoom() < 10) {
        map.easeTo({ center: e.lngLat, zoom: Math.min(map.getZoom() + 2.5, 10), duration: 600 });
        return;
      }
      void useRadarEventStore.getState().load(evs[0].id);
    };
    const onMove = (e: MapLayerMouseEvent) => {
      const evs = under(e);
      if (!evs.length) return;
      map.getCanvas().style.cursor = "pointer";
      const ev = evs[0];
      const cat = EVENT_CATEGORIES.find((c) => c.id === ev.category)?.label ?? "";
      popup
        .setLngLat([ev.lon, ev.lat])
        .setHTML(
          evs.length > 1
            ? evs.slice(0, 4).map((x) => `<b>${esc(x.title)}</b><span>${eventDay(x)} · K${esc(x.site)}</span>`).join("") +
                `<span>${evs.length} events here · click to zoom in</span>`
            : `<b>${esc(ev.title)}</b><span>${esc(ev.place)} · K${esc(ev.site)}</span>` +
                `<span>${esc(cat)} · ${eventDay(ev)} · click to load</span>`,
        )
        .addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    };
    map.on("click", DOT, onClick);
    map.on("mousemove", DOT, onMove);
    map.on("mouseleave", DOT, onLeave);
    const unsub = useRadarEventStore.subscribe((s, p) => {
      if (s.query !== p.query || s.filter !== p.filter || s.active !== p.active) push(map);
    });
    state.set(map, { unsub, onClick, onMove, onLeave, popup });
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.unsub();
      map.off("click", DOT, st.onClick);
      map.off("mousemove", DOT, st.onMove);
      map.off("mouseleave", DOT, st.onLeave);
      st.popup.remove();
      state.delete(map);
    }
    unregisterMarkerLayers([DOT]);
    for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, o) {
    opacity = o;
    if (map.getLayer(RING)) {
      map.setPaintProperty(RING, "circle-opacity", o);
      map.setPaintProperty(RING, "circle-stroke-opacity", o);
    }
    if (map.getLayer(DOT)) {
      map.setPaintProperty(DOT, "circle-opacity", o);
      map.setPaintProperty(DOT, "circle-stroke-opacity", o);
    }
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", o);
  },

  getLayerIds() {
    return LAYERS;
  },
};
