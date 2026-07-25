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
} from "../../lib/outlooks";
import { useOutlookStore } from "../../store/useOutlookStore";

const ALERT_BEFORE_IDS = ["alerts-fill", "alerts-outline"];

type Loader = () => Promise<OutlookResponse>;

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
      if (!map.getLayer(fillId)) {
        map.addLayer(
          {
            id: fillId,
            type: "fill",
            source: sourceId,
            paint: { "fill-color": ["get", "color"], "fill-opacity": 0.26 },
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
      if (map.getLayer(fillId)) map.removeLayer(fillId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      useOutlookStore.getState().clearMeta(id);
    },

    setOpacity(map, opacity) {
      if (map.getLayer(fillId)) map.setPaintProperty(fillId, "fill-opacity", 0.32 * opacity);
      if (map.getLayer(lineId)) map.setPaintProperty(lineId, "line-opacity", opacity);
    },

    getLayerIds() {
      return [fillId, lineId];
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
