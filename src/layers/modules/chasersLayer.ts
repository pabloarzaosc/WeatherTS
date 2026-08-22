import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";

import type { LayerModule } from "../types";
import { isStale } from "../../lib/chasers";
import { useChaserStore } from "../../store/useChaserStore";
import { useAuthStore } from "../../store/useAuthStore";
import { ROLE_COLOR, ROLE_LETTER } from "../../lib/auth";

const SOURCE_ID = "chasers";
const HALO_LAYER = "chasers-halo";
const ARROW_LAYER = "chasers-arrow";
const DOT_LAYER = "chasers-dot";
const AVATAR_LAYER = "chasers-avatar";
const BADGE_DOT = "chasers-badge-dot";
const BADGE_TEXT = "chasers-badge-text";
const LABEL_LAYER = "chasers-label";

/** Ordinary members, and a fix nobody has refreshed lately. Roles bring their
 *  own colours from ROLE_COLOR so the map, the card and the account panel can
 *  never disagree about what green or amber means. */
const MEMBER_COLOR = "#4ade80";
const STALE_COLOR = "#7c8896";

/** Your own marker. Blue, so it is never mistaken for another chaser. */
const SELF_COLOR = "#60a5fa";

/** Colour by role: your own marker first, then staleness, then the role's own
 *  colour, then plain member. `ring` is stamped on the feature rather than
 *  matched here so there is one table of colours, not two. */
/** The ring around a marker. The role wins here, and only here: the dot itself
 *  stays blue when it is you, so "which one am I" and "what is this account"
 *  are two separate signals instead of one fighting the other. A stale fix
 *  still greys out first -- an out-of-date position is the more urgent fact
 *  about it than the badge its owner carries. */
const ringColor = (): unknown => [
  "case",
  ["get", "stale"],
  STALE_COLOR,
  ["has", "ring"],
  ["get", "ring"],
  ["get", "self"],
  SELF_COLOR,
  MEMBER_COLOR,
];

const byRole = (): unknown => [
  "case",
  ["get", "self"],
  SELF_COLOR,
  ["get", "stale"],
  STALE_COLOR,
  ["has", "ring"],
  ["get", "ring"],
  MEMBER_COLOR,
];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const unsubs = new WeakMap<MapLibreMap, () => void>();

// Per-map, because split-screen adds this module to several maps and
// module-level handlers would have each pane detaching the previous one's.
interface Handlers {
  onClick: (e: MapLayerMouseEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
}
const handlers = new WeakMap<MapLibreMap, Handlers>();


/* ------------------------------------------------------------- avatars ---
 * A profile picture has to become a map image before a symbol layer can draw
 * it, and it has to be round: a square photo among circular markers reads as a
 * different kind of thing entirely.
 *
 * One image per URL, shared by every pane. The id is derived from the URL, so
 * a chaser who changes their picture gets a new id and the old one is simply
 * never referenced again.
 */
const AVATAR_PX = 64; // device pixels; drawn at pixelRatio 2, so 32 CSS px

/** Which URLs are loaded or in flight, per map. */
const avatarState = new WeakMap<MapLibreMap, Map<string, "loading" | "ready" | "failed">>();
/** When a failed URL may be tried again. Avatar hosts rate-limit: Google
 *  answered 429 under repeated requests during testing, and treating that as
 *  permanent would leave a chaser drawn as a bare dot for the whole session
 *  over a refusal that lasts a minute. A 404 is different and stays failed. */
const avatarRetryAt = new WeakMap<MapLibreMap, Map<string, number>>();
const AVATAR_RETRY_MS = 60_000;

const avatarId = (url: string) => `chaser-avatar:${url}`;

function circularImage(bitmap: ImageBitmap): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const r = AVATAR_PX / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(r, r, r - 3, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  // Cover-fit: crop the long side rather than squash the face.
  const scale = Math.max(AVATAR_PX / bitmap.width, AVATAR_PX / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (AVATAR_PX - w) / 2, (AVATAR_PX - h) / 2, w, h);
  ctx.restore();

  // A ring, so the photo separates from whatever reflectivity is under it.
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.stroke();

  return ctx.getImageData(0, 0, AVATAR_PX, AVATAR_PX);
}

/**
 * Fetch a picture and register it with the map, once.
 *
 * Loaded through fetch rather than an <img> so a host without CORS headers
 * fails here, cleanly, instead of tainting a canvas and throwing on read. A
 * failure is remembered: the marker falls back to a plain dot and nothing
 * retries the same broken URL on every presence event.
 */
function ensureAvatar(map: MapLibreMap, url: string, onReady: () => void): void {
  let state = avatarState.get(map);
  if (!state) {
    state = new Map();
    avatarState.set(map, state);
  }
  let retry = avatarRetryAt.get(map);
  if (!retry) {
    retry = new Map();
    avatarRetryAt.set(map, retry);
  }
  const known = state.get(url);
  if (known === "loading" || known === "ready") return;
  if (known === "failed" && Date.now() < (retry.get(url) ?? 0)) return;

  const id = avatarId(url);
  if (map.hasImage(id)) {
    state.set(url, "ready");
    return;
  }
  state.set(url, "loading");

  void (async () => {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      // 429 and the 5xx family are the host saying "not now"; anything else in
      // the 4xx family is it saying "not ever", and re-asking would be noise.
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        state.set(url, "failed");
        retry.set(url, transient ? Date.now() + AVATAR_RETRY_MS : Number.MAX_SAFE_INTEGER);
        return;
      }
      const bitmap = await createImageBitmap(await res.blob());
      const image = circularImage(bitmap);
      bitmap.close?.();
      if (!image) throw new Error("no 2d context");
      if (!map.getStyle() || map.hasImage(id)) return;
      map.addImage(id, image, { pixelRatio: 2 });
      state.set(url, "ready");
      retry.delete(url);
      onReady();
    } catch {
      // A thrown fetch is the network or CORS, both worth one more try later.
      state.set(url, "failed");
      retry.set(url, Date.now() + AVATAR_RETRY_MS);
    }
  })();
}

/** The image id to draw for this chaser, or null while it is not ready. */
function avatarFor(map: MapLibreMap, url: string | null | undefined, onReady: () => void): string | null {
  if (!url) return null;
  ensureAvatar(map, url, onReady);
  return avatarState.get(map)?.get(url) === "ready" ? avatarId(url) : null;
}

function build(map: MapLibreMap): GeoJSON.FeatureCollection {
  const now = Date.now();
  const { chasers, myPosition } = useChaserStore.getState();
  const again = () => push(map);

  const features: GeoJSON.Feature[] = chasers.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      id: c.id,
      name: c.name,
      // A parked chaser has no heading to draw, so the arrow is swapped for a
      // plain dot rather than pointing an arbitrary direction.
      moving: c.heading != null && (c.speedMph ?? 0) >= 3,
      heading: c.heading ?? 0,
      stale: isStale(c, now),
      official: c.official,
      role: c.role,
      // Empty string rather than absent for a member, so `has` stays the test
      // for "carries a mark" everywhere.
      ...(c.role === "member" ? {} : { letter: ROLE_LETTER[c.role], ring: ROLE_COLOR[c.role] }),
      self: false,
      icon: avatarFor(map, c.avatarUrl, again),
      label:
        (c.official ? "★ " : "") +
        (c.speedMph != null && c.speedMph >= 3 ? `${c.name} · ${c.speedMph} mph` : c.name),
    },
  }));

  // Your own broadcast, drawn from local state rather than round-tripped
  // through presence. Seeing the dot you are putting on everyone else's screen
  // is the only way to be sure the switch is actually doing something.
  if (myPosition) {
    // Your own picture comes from your own profile, not from the channel --
    // the point of this marker is to show what you are putting on everyone
    // else's screen, so it has to be drawn the same way they will see it.
    const me = useAuthStore.getState().profile;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [myPosition.lon, myPosition.lat] },
      properties: {
        id: "__self",
        name: "You",
        moving: myPosition.heading != null,
        heading: myPosition.heading ?? 0,
        stale: false,
        official: (me?.role ?? "member") !== "member",
        role: me?.role ?? "member",
        ...(me && me.role !== "member"
          ? { letter: ROLE_LETTER[me.role], ring: ROLE_COLOR[me.role] }
          : {}),
        self: true,
        icon: avatarFor(map, me?.avatarUrl, again),
        label: "You",
      },
    });
  }

  return { type: "FeatureCollection", features };
}

function push(map: MapLibreMap) {
  (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(build(map));
}

/** Other chasers sharing their position right now. */
export const chasersLayer: LayerModule = {
  id: "chasers",
  name: "Chasers",
  description:
    "Live positions of others sharing theirs. Nothing is stored — a position exists only while its owner is connected.",
  category: "chasers",
  source: "WeatherTS peers (Supabase Realtime presence)",
  // On by default: the layer costs nothing when nobody is sharing, and a map
  // that hides other chasers until you go looking for the switch is a feature
  // most people would never find they had.
  defaultVisible: true,
  defaultOpacity: 1,

  addTo(map) {
    if (!map.getSource(SOURCE_ID)) {
      map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });
    }

    // A ring under officials only, so the badge survives the marker itself
    // being an arrow one moment and a dot the next.
    if (!map.getLayer(HALO_LAYER)) {
      map.addLayer({
        id: HALO_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "ring"],
        paint: {
          "circle-radius": ["case", ["has", "icon"], 20, 11],
          "circle-color": "rgba(255,255,255,0.10)",
          "circle-stroke-color": ringColor() as never,
          "circle-stroke-width": 1.6,
        },
      });
    }
    if (!map.getLayer(ARROW_LAYER)) {
      map.addLayer({
        id: ARROW_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["==", ["get", "moving"], true],
        layout: {
          "text-field": "▲", // a triangle rotated to the heading
          "text-font": ["Noto Sans Bold"],
          // Bigger behind a photo so the tip still shows past the circle --
          // otherwise the picture swallows the one thing that says where
          // someone is going.
          "text-size": ["case", ["has", "icon"], 30, 15],
          "text-rotate": ["get", "heading"],
          "text-rotation-alignment": "map",
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": byRole() as never,
          "text-halo-color": "rgba(5,8,13,0.95)",
          "text-halo-width": 1.6,
        },
      });
    }
    if (!map.getLayer(DOT_LAYER)) {
      map.addLayer({
        id: DOT_LAYER,
        type: "circle",
        source: SOURCE_ID,
        filter: ["all", ["==", ["get", "moving"], false], ["!", ["has", "icon"]]],
        paint: {
          "circle-radius": 5,
          "circle-color": byRole() as never,
          "circle-stroke-color": "rgba(5,8,13,0.95)",
          "circle-stroke-width": 1.6,
        },
      });
    }
    if (!map.getLayer(AVATAR_LAYER)) {
      map.addLayer({
        id: AVATAR_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "icon"],
        layout: {
          "icon-image": ["get", "icon"],
          "icon-size": 1,
          "icon-allow-overlap": true,
          // Upright whatever the map does: a rotated face is unreadable, and
          // this is the one marker meant to be recognised at a glance.
          "icon-rotation-alignment": "viewport",
        },
        paint: {
          "icon-opacity": ["case", ["get", "stale"], 0.45, 1],
        },
      });
    }
    if (!map.getLayer(BADGE_DOT)) {
      map.addLayer({
        id: BADGE_DOT,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "letter"],
        paint: {
          "circle-radius": 7.5,
          "circle-color": ["get", "ring"],
          "circle-stroke-color": "rgba(5,8,13,0.95)",
          "circle-stroke-width": 1.4,
          // Pixels, and a CONSTANT: circle-translate is one of the paint
          // properties that refuses a data expression, and a rejected layer
          // takes the whole module down with it rather than degrading. One
          // offset has to sit right on a 32 px photo and on a 10 px dot, so it
          // is tucked close enough to read as attached to either.
          "circle-translate": [12, -12],
        },
      });
    }
    if (!map.getLayer(BADGE_TEXT)) {
      map.addLayer({
        id: BADGE_TEXT,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "letter"],
        layout: {
          "text-field": ["get", "letter"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          // Dark on a bright disc: the letter is the label, the colour is the
          // category, and neither should be fighting a halo to be read.
          "text-color": "#0b0f15",
          // Matches the disc above exactly, and constant for the same reason.
          "text-translate": [12, -12],
        },
      });
    }
    if (!map.getLayer(LABEL_LAYER)) {
      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": ["case", ["has", "icon"], ["literal", [0, 1.9]], ["literal", [0, 1.1]]],
          "text-anchor": "top",
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": byRole() as never,
          "text-halo-color": "rgba(5,8,13,0.95)",
          "text-halo-width": 1.4,
        },
      });
    }

    // Clicking a chaser opens their card. Bound on the marker layers only, so
    // a click on the label text behaves the same as one on the marker.
    const onClick = (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id !== "string" || id === "__self") return;
      const store = useChaserStore.getState();
      store.select(store.selectedId === id ? null : id);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    for (const id of [ARROW_LAYER, DOT_LAYER, AVATAR_LAYER, LABEL_LAYER]) {
      map.on("click", id, onClick);
      map.on("mouseenter", id, onEnter);
      map.on("mouseleave", id, onLeave);
    }
    handlers.set(map, { onClick, onEnter, onLeave });

    unsubs.set(
      map,
      useChaserStore.subscribe((s, prev) => {
        if (s.chasers !== prev.chasers || s.myPosition !== prev.myPosition) push(map);
      }),
    );
    push(map);
  },

  removeFrom(map) {
    unsubs.get(map)?.();
    unsubs.delete(map);
    const h = handlers.get(map);
    if (h) {
      for (const id of [ARROW_LAYER, DOT_LAYER, AVATAR_LAYER, LABEL_LAYER]) {
        map.off("click", id, h.onClick);
        map.off("mouseenter", id, h.onEnter);
        map.off("mouseleave", id, h.onLeave);
      }
      handlers.delete(map);
    }
    for (const id of [LABEL_LAYER, BADGE_TEXT, BADGE_DOT, AVATAR_LAYER, DOT_LAYER, ARROW_LAYER, HALO_LAYER]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    // The pictures go with the layer. Left behind they would survive a basemap
    // switch as orphaned images, and the loader would then skip re-adding them
    // to a style that no longer has them.
    const cached = avatarState.get(map);
    if (cached) {
      for (const url of cached.keys()) {
        const id = avatarId(url);
        if (map.hasImage(id)) map.removeImage(id);
      }
      avatarState.delete(map);
    }
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  },

  setOpacity(map, opacity) {
    if (map.getLayer(HALO_LAYER)) map.setPaintProperty(HALO_LAYER, "circle-opacity", opacity);
    if (map.getLayer(ARROW_LAYER)) map.setPaintProperty(ARROW_LAYER, "text-opacity", opacity);
    if (map.getLayer(DOT_LAYER)) map.setPaintProperty(DOT_LAYER, "circle-opacity", opacity);
    if (map.getLayer(AVATAR_LAYER)) map.setPaintProperty(AVATAR_LAYER, "icon-opacity", opacity);
    if (map.getLayer(BADGE_DOT)) map.setPaintProperty(BADGE_DOT, "circle-opacity", opacity);
    if (map.getLayer(BADGE_TEXT)) map.setPaintProperty(BADGE_TEXT, "text-opacity", opacity);
    if (map.getLayer(LABEL_LAYER)) map.setPaintProperty(LABEL_LAYER, "text-opacity", opacity);
  },

  getLayerIds() {
    return [HALO_LAYER, ARROW_LAYER, AVATAR_LAYER, DOT_LAYER, BADGE_DOT, BADGE_TEXT, LABEL_LAYER];
  },
};
