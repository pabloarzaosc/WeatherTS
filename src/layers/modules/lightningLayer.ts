import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchLightning, type LightningField, type LightningSat } from "../../lib/lightning";
import { paneIdOf } from "../../map/mapInstance";
import { useLightningStore } from "../../store/useLightningStore";

const SRC = "lightning-src";
const GLOW = "lightning-glow";
const DOT = "lightning-dot";
const ALL = [GLOW, DOT];

/** GLM publishes every 20 s; polling faster only burns requests. */
const POLL_MS = 25_000;
/** How often the age ramp is re-evaluated, so strikes visibly cool down. */
const AGE_TICK_MS = 2_000;
/** A flash counts as "new" — and gets the glow — for this long. */
const FRESH_S = 60;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * One fetch serves every pane. Split screen would otherwise pull the same
 * 20 000 flashes once per pane, which is the whole payload multiplied for
 * nothing — the flashes are not pane-specific.
 */
let shared: { key: string; at: number; promise: Promise<LightningField> } | null = null;

function sharedFetch(minutes: number, sat: LightningSat, endUnix: number | null, signal?: AbortSignal): Promise<LightningField> {
  const key = `${minutes}|${sat}|${endUnix ?? "live"}`;
  const now = Date.now();
  if (shared && shared.key === key && now - shared.at < POLL_MS - 2_000) return shared.promise;
  const promise = fetchLightning({ minutes, sat, endUnix }, signal);
  shared = { key, at: now, promise };
  // A rejected promise must not be handed to the next caller as a cached answer.
  promise.catch(() => {
    if (shared?.promise === promise) shared = null;
  });
  return promise;
}

/**
 * Colour by age: a strike lands white-hot and cools through yellow and orange
 * to violet as it ages out of the window. This is what makes a storm's motion
 * legible — a single colour would just be a static smear of dots.
 */
function ageColor(now: number): ExpressionSpecification {
  const age: ExpressionSpecification = ["-", now, ["get", "t"]];
  return [
    "interpolate",
    ["linear"],
    age,
    0, "#ffffff",
    20, "#fff6b0",
    90, "#ffc247",
    300, "#ff6b6b",
    900, "#c14ae0",
    2400, "#6d4bb8",
  ];
}

function ageOpacity(now: number, windowSec: number): ExpressionSpecification {
  const age: ExpressionSpecification = ["-", now, ["get", "t"]];
  return [
    "interpolate",
    ["linear"],
    age,
    0, 1,
    windowSec * 0.35, 0.85,
    windowSec * 0.75, 0.5,
    windowSec, 0.2,
  ];
}

// Radius by zoom. MapLibre requires ["zoom"] to be the *top-level* input of the
// interpolate -- wrapping one in ["*", ...] is rejected outright ("zoom
// expression may only be used as input to a top-level step/interpolate"). So the
// scaling goes into each stop's output instead, which is the legal
// zoom-and-property form.
const ZOOM_STOPS: [number, number][] = [
  [2, 1.5],
  [5, 2.4],
  [8, 3.6],
  [12, 6],
];

function zoomScaled(mult: number | ExpressionSpecification): ExpressionSpecification {
  const stops = ZOOM_STOPS.flatMap(([z, r]) =>
    typeof mult === "number" ? [z, r * mult] : [z, ["*", r, mult] as unknown as number],
  );
  return ["interpolate", ["linear"], ["zoom"], ...stops] as unknown as ExpressionSpecification;
}

/** Bigger flashes for more energetic ones, when the user asks for it. */
function radius(sizeByEnergy: boolean): ExpressionSpecification {
  if (!sizeByEnergy) return zoomScaled(1);
  return zoomScaled([
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "fJ"], 0],
    0, 0.75,
    20, 1.1,
    100, 1.6,
    400, 2.3,
  ]);
}

/** The freshest strikes only — the glow would be mud if it applied to all of them. */
function freshFilter(now: number): ExpressionSpecification {
  return ["<", ["-", now, ["get", "t"]], FRESH_S];
}

interface PaneState {
  abort: AbortController | null;
  poll: number;
  tick: number;
  unsub: () => void;
  seq: number;
}
const state = new WeakMap<import("maplibre-gl").Map, PaneState>();

/** Whether this particular pane should draw, honouring the sync setting. */
function visibleHere(map: import("maplibre-gl").Map): boolean {
  const { sync, panes } = useLightningStore.getState();
  if (sync) return true;
  const id = paneIdOf(map);
  return !id || panes[id] !== false;
}

function applyStyle(map: import("maplibre-gl").Map): void {
  const { minutes, sizeByEnergy, endUnix } = useLightningStore.getState();
  const now = endUnix ?? Date.now() / 1000;
  const windowSec = minutes * 60;
  const show = visibleHere(map) ? "visible" : "none";

  if (map.getLayer(DOT)) {
    map.setLayoutProperty(DOT, "visibility", show);
    map.setPaintProperty(DOT, "circle-color", ageColor(now));
    map.setPaintProperty(DOT, "circle-opacity", ageOpacity(now, windowSec));
    map.setPaintProperty(DOT, "circle-radius", radius(sizeByEnergy));
  }
  if (map.getLayer(GLOW)) {
    map.setLayoutProperty(GLOW, "visibility", show);
    map.setFilter(GLOW, freshFilter(now));
  }
}

async function draw(map: import("maplibre-gl").Map): Promise<void> {
  const st = state.get(map);
  if (!st) return;
  const src = map.getSource(SRC) as GeoJSONSource | undefined;
  if (!src) return;

  st.abort?.abort();
  const ctrl = new AbortController();
  st.abort = ctrl;
  const seq = ++st.seq;

  const { minutes, sat, endUnix, followNewest } = useLightningStore.getState();
  useLightningStore.getState().setStatus({ busy: true, error: null });

  try {
    const field = await sharedFetch(minutes, sat, endUnix, ctrl.signal);
    if (seq !== st.seq || !map.getSource(SRC)) return;
    src.setData(field.geojson);
    applyStyle(map);
    useLightningStore.getState().setStatus({
      busy: false,
      error: null,
      count: field.count,
      perMinute: field.perMinute,
      rateSeries: field.rateSeries,
      newestUnix: field.newestUnix,
      granules: field.granules,
      satellites: field.satellites,
      updatedAt: Date.now(),
    });

    if (followNewest && field.newestUnix) {
      const newest = field.geojson.features.reduce<GeoJSON.Feature<GeoJSON.Point, { t: number }> | null>(
        (best, f) => (!best || f.properties.t > best.properties.t ? f : best),
        null,
      );
      if (newest) {
        map.easeTo({ center: newest.geometry.coordinates as [number, number], duration: 900 });
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted || seq !== st.seq) return;
    useLightningStore.getState().setStatus({
      busy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Live GOES GLM lightning: every flash of the last few minutes, cooling by age. */
export const lightningLayer: LayerModule = {
  id: "lightning",
  name: "Lightning strikes (GLM)",
  description: "Live GOES Lightning Mapper flashes, coloured by age.",
  category: "weather",
  source: "NOAA GOES GLM · open S3",
  defaultVisible: false,
  defaultOpacity: 1,

  async addTo(map) {
    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });
    const { minutes, sizeByEnergy, endUnix } = useLightningStore.getState();
    const now = endUnix ?? Date.now() / 1000;

    if (!map.getLayer(GLOW)) {
      map.addLayer({
        id: GLOW,
        type: "circle",
        source: SRC,
        filter: freshFilter(now),
        paint: {
          // A soft halo under the newest strikes so a fresh one reads instantly
          // against the older dots it lands among.
          "circle-color": "#fff8c4",
          "circle-radius": zoomScaled(3.2),
          "circle-opacity": 0.16,
          "circle-blur": 1,
        },
      });
    }
    if (!map.getLayer(DOT)) {
      map.addLayer({
        id: DOT,
        type: "circle",
        source: SRC,
        paint: {
          "circle-color": ageColor(now),
          "circle-radius": radius(sizeByEnergy),
          "circle-opacity": ageOpacity(now, minutes * 60),
          "circle-stroke-width": 0,
        },
      });
    }

    // Anything that changes what to request re-fetches; anything that only
    // changes how it looks just re-styles.
    const unsubQuery = useLightningStore.subscribe(
      (s) => `${s.minutes}|${s.sat}|${s.endUnix ?? "live"}`,
      () => void draw(map),
    );
    const unsubStyle = useLightningStore.subscribe(
      (s) => `${s.sizeByEnergy}|${s.sync}|${JSON.stringify(s.panes)}`,
      () => applyStyle(map),
    );

    const poll = window.setInterval(() => void draw(map), POLL_MS);
    // The ramp is a function of wall-clock time, so it has to be re-pushed even
    // when no new data arrives -- otherwise strikes never cool.
    const tick = window.setInterval(() => applyStyle(map), AGE_TICK_MS);

    state.set(map, {
      abort: null,
      seq: 0,
      poll,
      tick,
      unsub: () => {
        unsubQuery();
        unsubStyle();
      },
    });

    await draw(map);
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.abort?.abort();
      window.clearInterval(st.poll);
      window.clearInterval(st.tick);
      st.unsub();
      state.delete(map);
    }
    for (const id of ALL) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
    useLightningStore.getState().setStatus({ busy: false, error: null, count: 0, newestUnix: null });
  },

  setOpacity(map, opacity) {
    // Age already drives opacity, so the layer slider scales that curve rather
    // than replacing it.
    const { minutes, endUnix } = useLightningStore.getState();
    if (map.getLayer(DOT)) {
      map.setPaintProperty(DOT, "circle-opacity", [
        "*",
        opacity,
        ageOpacity(endUnix ?? Date.now() / 1000, minutes * 60),
      ] as ExpressionSpecification);
    }
    if (map.getLayer(GLOW)) map.setPaintProperty(GLOW, "circle-opacity", 0.16 * opacity);
  },

  getLayerIds() {
    return ALL;
  },

  // Individual flashes are small marks; buried under a radar mesh or an alert
  // fill they are invisible, and they are the most time-critical thing drawn.
  topLayerIds() {
    return ALL;
  },
};
