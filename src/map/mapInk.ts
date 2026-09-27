import { basemapTone } from "./basemaps";
import { useAppStore } from "../store/useAppStore";

/**
 * The colours for what the layers write over the basemap -- names, badges,
 * magnitudes -- by whether the basemap is a dark surface or a light one.
 *
 * Every label was made for the dark basemap: pale text on a near-black halo.
 * On the Light basemap or the white chart that reads as dark blotches on
 * paper. Read when a layer adds itself; a basemap change rebuilds the style
 * and every layer is added again, so they follow it.
 *
 * Only for neutral labels. A label whose colour is the data (a front's H, a
 * watch's hazard, a temperature) keeps its colour and takes only the halo.
 */
export interface MapInk {
  tone: "dark" | "light";
  /** Neutral label text. */
  text: string;
  /** The halo behind any label. */
  halo: string;
  /** A badge's fill and edge, and the text on it (radar site names). */
  badge: string;
  badgeEdge: string;
  badgeText: string;
}

const DARK_INK: MapInk = {
  tone: "dark",
  text: "#dfe9f5",
  halo: "rgba(8,12,18,0.9)",
  badge: "rgba(20,20,20,0.85)",
  badgeEdge: "rgba(200,200,200,0.42)",
  badgeText: "#ececec",
};

const LIGHT_INK: MapInk = {
  tone: "light",
  text: "#111418",
  halo: "rgba(255,255,255,0.92)",
  badge: "rgba(255,255,255,0.95)",
  badgeEdge: "rgba(17,20,24,0.7)",
  badgeText: "#111418",
};

export function mapInk(): MapInk {
  return basemapTone(useAppStore.getState().basemapId) === "light" ? LIGHT_INK : DARK_INK;
}
