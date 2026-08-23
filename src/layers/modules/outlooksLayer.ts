import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import type { LayerModule } from "../types";
import {
  cpcOutlook,
  nadoCastVector,
  spcOutlook,
  wpcEro,
  type CpcOutlookType,
  type CpcPeriod,
  type OutlookResponse,
  type SpcDay,
  type SpcOutlookType,
  CIG_COLORS,
} from "../../lib/outlooks";
import { useOutlookStore } from "../../store/useOutlookStore";

const ALERT_BEFORE_IDS = ["alerts-fill", "alerts-outline"];

type Loader = () => Promise<OutlookResponse>;

/**
 * A diagonal hatch, one per conditional-intensity group.
 *
 * Conditional intensity qualifies the probability underneath it -- "if a storm
 * goes severe here, this is how severe" -- so it has to be readable WITH the
 * risk colour, not instead of it. A second translucent fill would just muddy
 * the colour it is annotating; hatching is what SPC's own products use, and
 * what leaves the probability legible through it.
 *
 * fill-pattern takes an image rather than a colour, so the three groups need
 * three images; the feature carries which one in `cigPattern`.
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
  // Drawn three times, offset by a full tile each way, so the stroke that
  // leaves one edge arrives at the next tile unbroken.
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

// Everything that is not conditional intensity, and everything that is. A
// feature with no `cig` property at all is a plain outlook polygon.
const NOT_CIG = ["!=", ["coalesce", ["get", "cig"], false], true] as never;
const IS_CIG = ["==", ["coalesce", ["get", "cig"], false], true] as never;

function beforeAlerts(map: MapLibreMap): string | undefined {
  return ALERT_BEFORE_IDS.find((id) => map.getLayer(id));
}

function setGeoMeta(id: string, name: string, response: OutlookResponse) {
  useOutlookStore.getState().setMeta(id, {
    id,
    name,
    source: response.source,
    stale: response.stale,
    error: response.error,
    valid: response.valid,
    expire: response.expire,
    run: response.run ?? null,
    legend: response.legend,
  });
}

function createGeoOutlookLayer(id: string, name: string, description: string, loader: Loader): LayerModule {
  const sourceId = `${id}-src`;
  const fillId = `${id}-fill`;
  const hatchId = `${id}-hatch`;
  const lineId = `${id}-line`;

  return {
    id,
    name,
    description,
    category: "outlooks",
    source: "NOAA outlook services",
    defaultVisible: false,
    defaultOpacity: 0.72,

    async addTo(map) {
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      }
      ensureHatches(map);

      if (!map.getLayer(fillId)) {
        map.addLayer(
          {
            id: fillId,
            type: "fill",
            source: sourceId,
            filter: NOT_CIG,
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0.26 },
          },
          beforeAlerts(map),
        );
      }
      if (!map.getLayer(hatchId)) {
        map.addLayer(
          {
            id: hatchId,
            type: "fill",
            source: sourceId,
            filter: IS_CIG,
            paint: { "fill-pattern": ["get", "cigPattern"], "fill-opacity": 0.9 },
          },
          beforeAlerts(map),
        );
      }
      if (!map.getLayer(lineId)) {
        map.addLayer(
          {
            id: lineId,
            type: "line",
            source: sourceId,
            paint: { "line-color": ["get", "color"], "line-width": 1.25, "line-opacity": 0.82 },
          },
          beforeAlerts(map),
        );
      }

      try {
        const response = await loader();
        (map.getSource(sourceId) as GeoJSONSource | undefined)?.setData(response.geojson);
        setGeoMeta(id, name, response);
      } catch (err) {
        useOutlookStore.getState().setMeta(id, {
          id,
          name,
          source: "NOAA outlook services",
          stale: true,
          error: (err as Error).message,
          valid: null,
          expire: null,
          legend: [],
        });
      }
    },

    removeFrom(map) {
      if (map.getLayer(lineId)) map.removeLayer(lineId);
      if (map.getLayer(hatchId)) map.removeLayer(hatchId);
      if (map.getLayer(fillId)) map.removeLayer(fillId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      useOutlookStore.getState().clearMeta(id);
    },

    setOpacity(map, opacity) {
      if (map.getLayer(fillId)) map.setPaintProperty(fillId, "fill-opacity", 0.32 * opacity);
      if (map.getLayer(hatchId)) map.setPaintProperty(hatchId, "fill-opacity", opacity);
      if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-opacity", opacity);
    },

    getLayerIds() {
      return [fillId, hatchId, lineId];
    },
  };
}

const spcProducts: Array<{ type: SpcOutlookType; label: string; days: readonly SpcDay[] }> = [
  { type: "categorical", label: "Categorical", days: [1, 2, 3] },
  { type: "tornado", label: "Tornado", days: [1, 2] },
  { type: "wind", label: "Wind", days: [1, 2] },
  { type: "hail", label: "Hail", days: [1, 2] },
  { type: "probabilistic", label: "Probabilistic", days: [3, 4, 5] },
];

const cpcClimateTypes: Array<[CpcOutlookType, string]> = [
  ["temperature", "Temperature"],
  ["precipitation", "Precipitation"],
];

const cpcHazardPeriods: CpcPeriod[] = ["3-7", "8-14"];
const cpcClimatePeriods: CpcPeriod[] = ["6-10", "8-14"];

export const outlookLayers: LayerModule[] = [
  ...spcProducts.flatMap(({ type, label, days }) =>
    days.map((day) =>
      createGeoOutlookLayer(
        `spc-d${day}-${type}`,
        `SPC Day ${day} ${label}`,
        `Storm Prediction Center Day ${day} ${label} outlook.`,
        () => spcOutlook(day, type),
      ),
    ),
  ),
  ...([1, 2, 3] as const).map((day) =>
    createGeoOutlookLayer(
      `wpc-ero-d${day}`,
      `WPC ERO Day ${day}`,
      `Weather Prediction Center Excessive Rainfall Outlook Day ${day}.`,
      () => wpcEro(day),
    ),
  ),
  ...cpcHazardPeriods.map((period) =>
    createGeoOutlookLayer(
      `cpc-${period}-hazards`,
      `CPC ${period}d Hazards`,
      `Climate Prediction Center ${period} day hazards outlook.`,
      () => cpcOutlook("hazards", period),
    ),
  ),
  ...cpcClimatePeriods.flatMap((period) =>
    cpcClimateTypes.map(([type, label]) =>
      createGeoOutlookLayer(
        `cpc-${period}-${type}`,
        `CPC ${period}d ${label}`,
        `Climate Prediction Center ${period} day ${label} outlook.`,
        () => cpcOutlook(type, period),
      ),
    ),
  ),
  createGeoOutlookLayer(
    "nadocast-tornado",
    "NadoCast Tornado",
    "Latest NadoCast tornado probability, contoured to vector polygons.",
    () => nadoCastVector("tornado"),
  ),
  createGeoOutlookLayer(
    "nadocast-wind",
    "NadoCast Wind",
    "Latest NadoCast wind probability, contoured to vector polygons.",
    () => nadoCastVector("wind"),
  ),
  createGeoOutlookLayer(
    "nadocast-hail",
    "NadoCast Hail",
    "Latest NadoCast hail probability, contoured to vector polygons.",
    () => nadoCastVector("hail"),
  ),
  createGeoOutlookLayer(
    "nadocast-sig-tornado",
    "NadoCast Sig Tornado",
    "Latest NadoCast significant-tornado probability, contoured to vector polygons.",
    () => nadoCastVector("sig-tornado"),
  ),
];
