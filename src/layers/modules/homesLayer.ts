import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { fetchPublicHomes, ROLE_COLOR, ROLE_LETTER, type PublicProfile } from "../../lib/auth";
import { useAuthStore } from "../../store/useAuthStore";
import { mapInk } from "../../map/mapInk";

/**
 * Home pins: where people say they are based.
 *
 * The opposite of the live chaser layer in every way that matters. A position
 * there is unstored, expires on disconnect and answers "where is this person
 * right now". A pin here is written down, does not expire, and answers "whose
 * patch is this" -- so it is off unless its owner switched it on, and the
 * database view drops the coordinates of anyone who has not. What arrives in
 * this module is already only what its owners published.
 *
 * Its own layer rather than part of the chaser markers, because the two answer
 * different questions and a chase day wants the live one without the static
 * one cluttering the same pixels.
 */

const SRC = "chaser-homes";
const DOT = "chaser-home-dot";
const FACE = "chaser-home-face";
const LABEL = "chaser-home-label";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const REFRESH_MS = 5 * 60_000;
const FACE_PX = 56;

/** Your own pin, so it stands out from everyone else's regardless of role. */
const SELF_COLOR = "#60a5fa";

let homes: PublicProfile[] = [];
let loadedAt = 0;

interface PaneState {
  timer: number;
  unsub: () => void;
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  popup: maplibregl.Popup;
}
const state = new WeakMap<MapLibreMap, PaneState>();

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/* ------------------------------------------------------------- pictures */

const faceState = new WeakMap<MapLibreMap, Map<string, "loading" | "ready" | "failed">>();
const faceId = (url: string) => `home-face:${url}`;

function circular(bitmap: ImageBitmap): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = FACE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const r = FACE_PX / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 3, 0, Math.PI * 2);
  ctx.clip();
  const k = Math.max(FACE_PX / bitmap.width, FACE_PX / bitmap.height);
  ctx.drawImage(bitmap, (FACE_PX - bitmap.width * k) / 2, (FACE_PX - bitmap.height * k) / 2,
                bitmap.width * k, bitmap.height * k);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(226,236,247,0.85)";
  ctx.stroke();
  return ctx.getImageData(0, 0, FACE_PX, FACE_PX);
}

function ensureFace(map: MapLibreMap, url: string, onReady: () => void): void {
  let seen = faceState.get(map);
  if (!seen) {
    seen = new Map();
    faceState.set(map, seen);
  }
  if (seen.get(url) === "loading" || seen.get(url) === "ready" || seen.get(url) === "failed") return;
  const id = faceId(url);
  if (map.hasImage(id)) {
    seen.set(url, "ready");
    return;
  }
  seen.set(url, "loading");
  void (async () => {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!res.ok) throw new Error(String(res.status));
      const bitmap = await createImageBitmap(await res.blob());
      const image = circular(bitmap);
      bitmap.close?.();
      if (!image || !map.getStyle() || map.hasImage(id)) return;
      map.addImage(id, image, { pixelRatio: 2 });
      seen.set(url, "ready");
      onReady();
    } catch {
      seen.set(url, "failed");
    }
  })();
}

function faceFor(map: MapLibreMap, url: string | null, onReady: () => void): string | null {
  if (!url) return null;
  ensureFace(map, url, onReady);
  return faceState.get(map)?.get(url) === "ready" ? faceId(url) : null;
}

/* ---------------------------------------------------------------- data */

function build(map: MapLibreMap): GeoJSON.FeatureCollection {
  const again = () => push(map);
  const meId = useAuthStore.getState().user?.id ?? null;
  const features: GeoJSON.Feature[] = [];
  for (const p of homes) {
    if (p.homeLat == null || p.homeLon == null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.homeLon, p.homeLat] },
      properties: {
        id: p.id,
        username: p.username,
        name: p.displayName || p.username,
        role: p.role,
        letter: ROLE_LETTER[p.role],
        ring: ROLE_COLOR[p.role],
        where: p.homeLabel ?? "",
        self: p.id === meId,
        icon: faceFor(map, p.avatarUrl, again),
        label: p.displayName || p.username,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

function push(map: MapLibreMap): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(build(map));
}

async function refresh(map: MapLibreMap, force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < REFRESH_MS) {
    push(map);
    return;
  }
  const next = await fetchPublicHomes().catch(() => null);
  // A failed request must not empty the map; the pins that are already up are
  // still the last true answer.
  if (next) {
    homes = next;
    loadedAt = Date.now();
  }
  push(map);
}

export const homesLayer: LayerModule = {
  id: "chaser-homes",
  name: "Chaser home pins",
  description:
    "Where chasers say they are based, for those who chose to show it. Set yours in your account.",
  category: "chasers",
  source: "WeatherTS accounts",
  defaultVisible: false,
  defaultOpacity: 1,
  requiresAccount: "homes",

  addTo(map) {
    state.get(map)?.unsub();

    if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: EMPTY });

    if (!map.getLayer(DOT)) {
      map.addLayer({
        id: DOT,
        type: "circle",
        source: SRC,
        // Only for accounts with no picture; the rest draw as a face.
        filter: ["!", ["has", "icon"]],
        paint: {
          "circle-radius": 6,
          "circle-color": ["case", ["get", "self"], SELF_COLOR, ["get", "ring"]],
          "circle-stroke-color": "rgba(5,8,13,0.95)",
          "circle-stroke-width": 1.6,
        },
      });
    }
    if (!map.getLayer(FACE)) {
      map.addLayer({
        id: FACE,
        type: "symbol",
        source: SRC,
        filter: ["has", "icon"],
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          "icon-rotation-alignment": "viewport",
        },
        // Softer than a live position on purpose: this says "based here", not
        // "here now", and the two must not compete for the same attention.
        paint: { "icon-opacity": 0.85 },
      });
    }
    if (!map.getLayer(LABEL)) {
      map.addLayer({
        id: LABEL,
        type: "symbol",
        source: SRC,
        minzoom: 4,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10.5,
          "text-offset": ["case", ["has", "icon"], ["literal", [0, 1.7]], ["literal", [0, 1.0]]],
          "text-anchor": "top",
          "text-optional": true,
        },
        paint: {
          "text-color": ["case", ["get", "self"], SELF_COLOR, mapInk().text],
          "text-halo-color": mapInk().halo,
          "text-halo-width": 1.3,
        },
      });
    }

    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 14, className: "raobpop" });

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties || {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      // Exactly the fields the public view serves -- so what this card shows is
      // also the honest answer to "what can everyone see about me".
      popup
        .setLngLat([lon, lat])
        .setHTML(
          `<div class="raobtip"><b>${esc(String(p.name))}${p.letter ? ` (${esc(String(p.letter))})` : ""}</b>` +
            `<span>@${esc(String(p.username))}</span>` +
            (p.where ? `<span>Based in ${esc(String(p.where))}</span>` : "") +
            (p.self ? `<span>This is you, as everyone else sees you.</span>` : "") +
            `</div>`,
        )
        .addTo(map);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    for (const id of [DOT, FACE, LABEL]) {
      map.on("click", id, onClick);
      map.on("mouseenter", id, onEnter);
      map.on("mouseleave", id, onLeave);
    }

    void refresh(map, true);
    const timer = window.setInterval(() => void refresh(map), REFRESH_MS);

    // Your own pin has to appear the moment you save it, not five minutes
    // later, and it has to disappear just as fast when you switch it off.
    const unsubStore = useAuthStore.subscribe((s, prev) => {
      if (s.profile !== prev.profile || s.user?.id !== prev.user?.id) void refresh(map, true);
    });

    state.set(map, {
      timer,
      unsub: () => {
        window.clearInterval(timer);
        unsubStore();
      },
      onClick,
      onEnter,
      onLeave,
      popup,
    });
  },

  removeFrom(map) {
    const st = state.get(map);
    if (st) {
      st.unsub();
      for (const id of [DOT, FACE, LABEL]) {
        map.off("click", id, st.onClick);
        map.off("mouseenter", id, st.onEnter);
        map.off("mouseleave", id, st.onLeave);
      }
      st.popup.remove();
      state.delete(map);
    }
    for (const id of [LABEL, FACE, DOT]) if (map.getLayer(id)) map.removeLayer(id);
    const seen = faceState.get(map);
    if (seen) {
      for (const url of seen.keys()) {
        const id = faceId(url);
        if (map.hasImage(id)) map.removeImage(id);
      }
      faceState.delete(map);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(DOT)) map.setPaintProperty(DOT, "circle-opacity", opacity);
    if (map.getLayer(FACE)) map.setPaintProperty(FACE, "icon-opacity", 0.85 * opacity);
    if (map.getLayer(LABEL)) map.setPaintProperty(LABEL, "text-opacity", opacity);
  },

  getLayerIds() {
    return [DOT, FACE, LABEL];
  },
};
