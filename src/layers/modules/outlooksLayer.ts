import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import type { LayerModule } from "../types";
import {
  cpcDrought,
  cpcOutlook,
  nadoCastVector,
  nhcTropicalOutlook,
  outlookAt,
  previousIssuance,
  spcFire,
  spcIssuanceOf,
  spcOutlook,
  wpcEro,
  wpcWssi,
  CIG_COLORS,
  type OutlookResponse,
  type OutlookWhen,
  type SpcDay,
  type SpcOutlookType,
} from "../../lib/outlooks";
import { useOutlookStore } from "../../store/useOutlookStore";
import { allMaps } from "../../map/mapInstance";
import { getSetting } from "../../settings/useSettingsStore";
import { markerUnderPoint } from "../clickPriority";

const ALERT_BEFORE_IDS = ["alerts-fill", "alerts-outline"];

// ---------------------------------------------------------------------------
// The products
// ---------------------------------------------------------------------------

/**
 * Every outlook the app offers, one entry per product; its variants are the
 * days (or periods) it is issued for. The map layers, the Outlooks panel and
 * the top-bar picker are all read off this, so they cannot disagree.
 */
export interface OutlookProduct {
  key: string;
  group: string;
  label: string;
  description: string;
  /** Days (1..8) or CPC periods ("6-10"); empty for a single product. */
  variants: { key: string; label: string }[];
  moduleId: (variant: string) => string;
  load: (variant: string, when: OutlookWhen | null) => Promise<OutlookResponse>;
  /** SPC's convective outlooks: past issuances can be picked and compared. */
  history?: boolean;
  /** Where its discussion is, for the panel. */
  discussion?: (variant: string) => SpcDay | "fire1" | "fire2" | "fire38" | null;
}

const days = (...list: number[]) => list.map((d) => ({ key: String(d), label: `Day ${d}` }));
const spc = (type: SpcOutlookType, label: string, list: number[], description: string): OutlookProduct => ({
  key: `spc-${type}`,
  group: "Severe weather · SPC",
  label,
  description,
  variants: days(...list),
  moduleId: (d) => `spc-d${d}-${type}`,
  load: (d, when) => spcOutlook(Number(d) as SpcDay, type, when),
  history: true,
  discussion: (d) => Number(d) as SpcDay,
});

export const OUTLOOK_PRODUCTS: OutlookProduct[] = [
  spc("categorical", "Categorical", [1, 2, 3], "Thunderstorm and severe risk: marginal to high."),
  spc("tornado", "Tornado", [1, 2], "Chance of a tornado within 25 miles, with conditional intensity."),
  spc("wind", "Wind", [1, 2], "Chance of damaging wind within 25 miles, with conditional intensity."),
  spc("hail", "Hail", [1, 2], "Chance of 1\" hail within 25 miles, with conditional intensity."),
  spc("probabilistic", "Any severe", [3, 4, 5, 6, 7, 8], "Chance of any severe weather within 25 miles; days 4-8 at 15 and 30%."),
  {
    key: "spc-fire-windrh",
    group: "Fire weather · SPC",
    label: "Wind & RH",
    description: "Elevated, critical and extremely critical fire weather.",
    variants: days(1, 2),
    moduleId: (d) => `spc-fire-d${d}-windrh`,
    load: (d) => spcFire(Number(d) as 1 | 2, "windrh"),
    discussion: (d) => (d === "1" ? "fire1" : "fire2"),
  },
  {
    key: "spc-fire-dryt",
    group: "Fire weather · SPC",
    label: "Dry thunderstorms",
    description: "Isolated and scattered dry thunderstorms.",
    variants: days(1, 2),
    moduleId: (d) => `spc-fire-d${d}-dryt`,
    load: (d) => spcFire(Number(d) as 1 | 2, "dryt"),
    discussion: (d) => (d === "1" ? "fire1" : "fire2"),
  },
  {
    key: "wpc-ero",
    group: "Rain & winter · WPC",
    label: "Excessive rainfall",
    description: "Chance of rain exceeding flash flood guidance within 25 miles.",
    variants: days(1, 2, 3, 4, 5),
    moduleId: (d) => `wpc-ero-d${d}`,
    load: (d) => wpcEro(Number(d) as 1 | 2 | 3 | 4 | 5),
  },
  {
    key: "wpc-wssi",
    group: "Rain & winter · WPC",
    label: "Winter storm severity",
    description: "The WSSI: how much a winter storm will disrupt, from minor to extreme.",
    variants: days(1, 2, 3),
    moduleId: (d) => `wpc-wssi-d${d}`,
    load: (d) => wpcWssi(Number(d) as 1 | 2 | 3),
  },
  {
    key: "nhc-two",
    group: "Tropical · NHC",
    label: "Tropical formation",
    description: "Where a tropical cyclone may form, with its 2- and 7-day chances.",
    variants: [],
    moduleId: () => "nhc-two",
    load: () => nhcTropicalOutlook(),
  },
  {
    key: "cpc-temperature",
    group: "Climate · CPC",
    label: "Temperature",
    description: "Chance of above or below normal temperature.",
    variants: [
      { key: "6-10", label: "6-10 d" }, { key: "8-14", label: "8-14 d" },
      { key: "monthly", label: "Month" }, { key: "seasonal", label: "Season" },
    ],
    moduleId: (p) => `cpc-${p}-temperature`,
    load: (p) => cpcOutlook("temperature", p as "6-10"),
  },
  {
    key: "cpc-precipitation",
    group: "Climate · CPC",
    label: "Precipitation",
    description: "Chance of above or below normal precipitation.",
    variants: [
      { key: "6-10", label: "6-10 d" }, { key: "8-14", label: "8-14 d" },
      { key: "monthly", label: "Month" }, { key: "seasonal", label: "Season" },
    ],
    moduleId: (p) => `cpc-${p}-precipitation`,
    load: (p) => cpcOutlook("precipitation", p as "6-10"),
  },
  {
    key: "cpc-hazards",
    group: "Climate · CPC",
    label: "Hazards",
    description: "Heat, cold, heavy rain and snow, high wind, wildfire risk.",
    variants: [{ key: "3-7", label: "3-7 d" }, { key: "8-14", label: "8-14 d" }],
    moduleId: (p) => `cpc-${p}-hazards`,
    load: (p) => cpcOutlook("hazards", p as "3-7"),
  },
  {
    key: "cpc-drought",
    group: "Climate · CPC",
    label: "Drought",
    description: "Where drought is expected to develop, persist, improve or end.",
    variants: [{ key: "monthly", label: "Month" }, { key: "seasonal", label: "Season" }],
    moduleId: (p) => `cpc-drought-${p}`,
    load: (p) => cpcDrought(p as "monthly"),
  },
  ...(["tornado", "wind", "hail", "sig-tornado"] as const).map((hazard): OutlookProduct => ({
    key: `nadocast-${hazard}`,
    group: "NadoCast",
    label: { tornado: "Tornado", wind: "Wind", hail: "Hail", "sig-tornado": "Sig tornado" }[hazard],
    description: `The latest NadoCast ${hazard.replace("-", " ")} probability, contoured.`,
    variants: [],
    moduleId: () => `nadocast-${hazard}`,
    load: () => nadoCastVector(hazard),
  })),
];

/** The product and variant a layer module belongs to. */
export function outlookOfModule(id: string): { product: OutlookProduct; variant: string } | null {
  for (const product of OUTLOOK_PRODUCTS) {
    const variants = product.variants.length ? product.variants.map((v) => v.key) : [""];
    for (const variant of variants) if (product.moduleId(variant) === id) return { product, variant };
  }
  return null;
}

function moduleName(product: OutlookProduct, variant: string): string {
  const v = product.variants.find((x) => x.key === variant)?.label;
  const org = product.group.split("·").pop()?.trim() ?? "";
  return [org, v, product.label].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * A diagonal hatch, one per conditional-intensity group. It qualifies the
 * probability underneath -- "if a storm goes severe here, this is how severe"
 * -- so it is drawn over the colour, not instead of it, as SPC's own maps do.
 */
function hatchImage(color: string): ImageData | null {
  const size = 8;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "square";
  // Drawn three times, a tile apart, so a stroke leaving one edge arrives at
  // the next tile unbroken.
  for (const offset of [-size, 0, size]) {
    ctx.beginPath();
    ctx.moveTo(offset, size);
    ctx.lineTo(offset + size, 0);
    ctx.stroke();
  }
  return ctx.getImageData(0, 0, size, size);
}

function ensureHatches(map: MapLibreMap): void {
  for (const [group, color] of Object.entries(CIG_COLORS)) {
    const id = `cig-hatch-${group.slice(3)}`;
    if (map.hasImage(id)) continue;
    const image = hatchImage(color);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  }
}

const NOT_CIG = ["!=", ["coalesce", ["get", "cig"], false], true] as never;
const IS_CIG = ["==", ["coalesce", ["get", "cig"], false], true] as never;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function beforeAlerts(map: MapLibreMap): string | undefined {
  return ALERT_BEFORE_IDS.find((id) => map.getLayer(id));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function utc(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return `${t.toISOString().slice(5, 10).replace("-", "/")} ${t.toISOString().slice(11, 16).replace(":", "")}Z`;
}

function row(p: Record<string, unknown>, prefix = ""): string {
  const swatch = p.cig
    ? `<span class="olpop__sw olpop__sw--cig"></span>`
    : `<span class="olpop__sw" style="background:${escapeHtml(String(p.color ?? "#888"))}"></span>`;
  const name = String(p.name ?? p.label ?? "");
  const label = String(p.label ?? "");
  return `<div class="olpop__row">${swatch}<span>${prefix ? `<em>${escapeHtml(prefix)}</em> ` : ""}<b>${escapeHtml(label)}</b>${name && name !== label ? ` · ${escapeHtml(name)}` : ""}</span></div>`;
}

/** The popup for a point: what this outlook says there, and for SPC's
 *  categorical outlook, the tornado, wind and hail chances beneath it. */
function popupHtml(title: string, meta: { issued?: string | null; valid?: string | null; expire?: string | null },
  top: Record<string, unknown> | null, cig: Record<string, unknown> | null, extra: string): string {
  const when = [meta.issued ? `issued ${utc(meta.issued)}` : "", meta.valid ? `valid ${utc(meta.valid)}${meta.expire ? ` - ${utc(meta.expire)}` : ""}` : ""]
    .filter(Boolean).join(" · ");
  return `<div class="olpop">
    <div class="olpop__head"><b>${escapeHtml(title)}</b>${when ? `<span>${escapeHtml(when)}</span>` : ""}</div>
    ${top ? row(top) : `<div class="olpop__none">No area here</div>`}
    ${cig ? row(cig) : ""}
    ${extra}
  </div>`;
}

async function spcBreakdown(day: SpcDay, when: OutlookWhen | null, lon: number, lat: number): Promise<string> {
  const parts: [string, SpcOutlookType][] = day <= 2
    ? [["Tornado", "tornado"], ["Wind", "wind"], ["Hail", "hail"]]
    : [["Any severe", "probabilistic"]];
  const rows = await Promise.all(parts.map(async ([name, type]) => {
    try {
      const o = await spcOutlook(day, type, when);
      const at = outlookAt(o.geojson, lon, lat);
      if (!at.top && !at.cig) return `<div class="olpop__row olpop__row--dim"><span class="olpop__sw"></span><span><em>${name}</em> below the lowest level</span></div>`;
      return (at.top ? row(at.top, name) : "") + (at.cig ? row(at.cig, name) : "");
    } catch {
      return "";
    }
  }));
  return rows.join("") ? `<div class="olpop__sub">At this point</div>${rows.join("")}` : "";
}

function createOutlookLayer(product: OutlookProduct, variant: string): LayerModule {
  const id = product.moduleId(variant);
  const name = moduleName(product, variant);
  const sourceId = `${id}-src`;
  const prevSourceId = `${id}-prev-src`;
  const fillId = `${id}-fill`;
  const hatchId = `${id}-hatch`;
  const lineId = `${id}-line`;
  const casingId = `${id}-casing`;
  const prevId = `${id}-prev`;
  const state = new WeakMap<MapLibreMap, { unsub: () => void; onClick: (e: MapLayerMouseEvent) => void; popup: maplibregl.Popup }>();
  // Per map: with the screen split, each pane loads its own copy.
  const generations = new WeakMap<MapLibreMap, number>();

  const whenOf = () => (product.history ? useOutlookStore.getState().when : null);

  async function load(map: MapLibreMap): Promise<void> {
    const mine = (generations.get(map) ?? 0) + 1;
    generations.set(map, mine);
    const when = whenOf();
    try {
      const response = await product.load(variant, when);
      if (mine !== generations.get(map)) return;
      (map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(response.geojson);
      useOutlookStore.getState().setData(id, response.geojson);
      useOutlookStore.getState().setMeta(id, {
        id, name, source: response.source, stale: response.stale, error: response.error,
        valid: response.valid, expire: response.expire, issued: response.issued ?? null,
        forecaster: response.forecaster ?? null, run: response.run ?? null, legend: response.legend,
        note: response.geojson.features.length
          ? null
          : response.note ?? "No areas in this outlook right now",
      });
      await loadPrevious(map, response, when, mine);
    } catch (err) {
      if (mine !== generations.get(map)) return;
      (map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(EMPTY);
      useOutlookStore.getState().setData(id, null);
      useOutlookStore.getState().setMeta(id, {
        id, name, source: product.group.split("·").pop()?.trim() ?? "NOAA", stale: true,
        error: (err as Error).message, valid: null, expire: null, legend: [],
      });
    }
  }

  /** The issuance before the one shown, as a dashed outline -- when asked. */
  async function loadPrevious(map: MapLibreMap, shown: OutlookResponse, when: OutlookWhen | null, mine: number) {
    const src = map.getSource(prevSourceId) as GeoJSONSource | undefined;
    if (!src) return;
    if (!product.history || !useOutlookStore.getState().compare) {
      src.setData(EMPTY);
      return;
    }
    const day = Number(variant) as SpcDay;
    const current = when ?? spcIssuanceOf(day, shown.valid, shown.issued ?? null);
    if (!current) return;
    try {
      const prev = await product.load(variant, previousIssuance(day, current));
      if (mine === generations.get(map)) src.setData(prev.geojson);
    } catch {
      if (mine === generations.get(map)) src.setData(EMPTY);
    }
  }

  return {
    id,
    name,
    description: product.description,
    category: "outlooks",
    source: product.group.split("·").pop()?.trim() ?? "NOAA",
    defaultVisible: false,
    defaultOpacity: 0.72,

    async addTo(map) {
      state.get(map)?.unsub();
      if (!map.getSource(sourceId)) map.addSource(sourceId, { type: "geojson", data: EMPTY });
      if (!map.getSource(prevSourceId)) map.addSource(prevSourceId, { type: "geojson", data: EMPTY });
      ensureHatches(map);
      const before = beforeAlerts(map);
      if (!map.getLayer(fillId)) {
        map.addLayer({ id: fillId, type: "fill", source: sourceId, filter: NOT_CIG,
          paint: { "fill-color": ["get", "color"], "fill-opacity": 0.26 } }, before);
      }
      if (!map.getLayer(hatchId)) {
        map.addLayer({ id: hatchId, type: "fill", source: sourceId, filter: IS_CIG,
          paint: { "fill-pattern": ["get", "cigPattern"], "fill-opacity": 0.9 } }, before);
      }
      if (!map.getLayer(casingId)) {
        // A dark edge under the line: over a Models field or radar a pale
        // outline (a 5% area's tan) vanished into the colours beneath.
        map.addLayer({ id: casingId, type: "line", source: sourceId, filter: NOT_CIG,
          paint: { "line-color": "rgba(6,10,16,0.7)", "line-width": 2.9, "line-opacity": 0.82 } }, before);
      }
      if (!map.getLayer(lineId)) {
        map.addLayer({ id: lineId, type: "line", source: sourceId,
          paint: { "line-color": ["get", "color"], "line-width": 1.25, "line-opacity": 0.82 } }, before);
      }
      if (!map.getLayer(prevId)) {
        // The previous issuance: dashed, in each area's own colour, so a risk
        // that grew or shrank reads as the gap between the dash and the fill.
        map.addLayer({ id: prevId, type: "line", source: prevSourceId, filter: NOT_CIG,
          paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.95 } }, before);
      }

      const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: "340px", className: "olpopwrap" });
      const onClick = (e: MapLayerMouseEvent) => {
        if (markerUnderPoint(map, e.point)) return;
        const { lng, lat } = e.lngLat;
        const fc = useOutlookStore.getState().data[id];
        const at = outlookAt(fc, lng, lat);
        const meta = useOutlookStore.getState().metas[id] ?? {};
        const base = (extra: string) => popupHtml(name, meta, at.top, at.cig, extra);
        popup.setLngLat(e.lngLat).setHTML(base("")).addTo(map);
        if (product.key === "spc-categorical") {
          void spcBreakdown(Number(variant) as SpcDay, whenOf(), lng, lat).then((extra) => {
            if (popup.isOpen()) popup.setHTML(base(extra));
          });
        }
      };
      map.on("click", fillId, onClick);
      map.on("click", hatchId, onClick);

      const unsubStore = useOutlookStore.subscribe((s, prev) => {
        if (product.history && (s.when !== prev.when || s.compare !== prev.compare)) void load(map);
      });
      state.set(map, {
        onClick,
        popup,
        unsub: () => {
          unsubStore();
          map.off("click", fillId, onClick);
          map.off("click", hatchId, onClick);
          popup.remove();
        },
      });
      await load(map);
    },

    removeFrom(map, styleSwap) {
      generations.set(map, (generations.get(map) ?? 0) + 1);
      state.get(map)?.unsub();
      state.delete(map);
      for (const layer of [prevId, lineId, casingId, hatchId, fillId]) if (map.getLayer(layer)) map.removeLayer(layer);
      for (const source of [prevSourceId, sourceId]) if (map.getSource(source)) map.removeSource(source);
      // Taken off one pane only (its chip's x, or the pane closing): the
      // other panes still show it, so its data and legend stay (panes-layout).
      if (styleSwap || allMaps().some((m) => m !== map && m.getSource(sourceId))) return;
      useOutlookStore.getState().clearMeta(id);
      useOutlookStore.getState().setData(id, null);
    },

    setOpacity(map, opacity) {
      // Fill and hatching strengths are outlooks.fill (0.32) and outlooks.hatch (1) in Settings.
      const fill = +(getSetting<number>("outlooks.fill") * opacity).toFixed(4);
      const hatch = +(getSetting<number>("outlooks.hatch") * opacity).toFixed(4);
      if (map.getLayer(fillId)) map.setPaintProperty(fillId, "fill-opacity", fill);
      if (map.getLayer(hatchId)) map.setPaintProperty(hatchId, "fill-opacity", hatch);
      if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-opacity", opacity);
      if (map.getLayer(casingId)) map.setPaintProperty(casingId, "line-opacity", opacity);
    },

    getLayerIds() {
      return [fillId, hatchId, casingId, lineId, prevId];
    },

    // The outline, the hatching and the previous issuance over everything --
    // under a Models field or the radar the whole outlook was hidden -- while
    // the colour stays where the order puts it, under them, as the alerts do.
    // Below the alerts' own lifted lines: a warning is the sharper fact.
    topPriority: -1,
    topLayerIds() {
      return [hatchId, casingId, lineId, prevId];
    },
  };
}

export const outlookLayers: LayerModule[] = OUTLOOK_PRODUCTS.flatMap((product) =>
  (product.variants.length ? product.variants.map((v) => v.key) : [""]).map((variant) => createOutlookLayer(product, variant)),
);
