import { useMemo, useSyncExternalStore } from "react";

import { sampleScan } from "../lib/radarMesh";
import { getActivePaneId, getMap, getMapById, subscribeMaps } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";
import { useNexradStore } from "../store/useNexradStore";
import { HCA_CLASSES } from "../lib/hca";
import { formatValue } from "../lib/radarUnits";


const EARTH_KM = 6371;
/** Standard refraction: the beam bends less than the earth curves, which the
 *  usual four-thirds-radius trick models. */
const K = 4 / 3;
const KM_TO_KFT = 3.28084;

/**
 * How high the beam is at that range, above the radar.
 *
 * Not a detail: the same 46 dBZ means very different things at 2 kft and at
 * 25 kft, and at long range the beam is far above what is happening at the
 * ground. Quoting a value without its height invites reading a distant echo as
 * if it were a surface observation.
 */
function beamHeightKm(rangeKm: number, elevationDeg: number): number {
  const r = rangeKm;
  const ka = K * EARTH_KM;
  const t = (elevationDeg * Math.PI) / 180;
  return Math.sqrt(r * r + ka * ka + 2 * r * ka * Math.sin(t)) - ka;
}

export interface RadarSample {
  /** The product's name, e.g. "Base Reflectivity". */
  label: string;
  /** Formatted value with units, or the class name on classification products. */
  text: string;
  /** Beam height above the radar, formatted, or null when the cut is unknown. */
  height: string | null;
  site: string;
  azimuth: string;
  range: string;
}

/**
 * The radar's own measurement under the cursor.
 *
 * Read from the polar data rather than the rendered pixel -- the mesh bakes
 * colour into its vertices, so sampling the framebuffer would mean inverting a
 * palette, which is lossy wherever two values share a band and wrong entirely
 * once another layer is drawn on top.
 *
 * Classification products are categories, not quantities, so a decimal reading
 * of one would be nonsense; those get the class name instead.
 */
export function useRadarSample(): RadarSample | null {
  const radarUnits = useAppStore((st) => st.radarUnits);
  const cursor = useAppStore((s) => s.cursor);
  const threshold = useNexradStore((s) => s.threshold);
  const visible = useAppStore((s) => s.layers["nexrad"]?.visible ?? false);
  // The pane under the pointer, which need not be the focused one: the top level
  // mirrors the focused pane only, and each pane has its own product and scan.
  const activeId = useSyncExternalStore(subscribeMaps, getActivePaneId);
  const paneId = cursor?.pane ?? activeId;
  const leftScan = useNexradStore((s) => {
    const pane = paneId ? s.paneRadar[paneId] : undefined;
    return pane && paneId !== activeId ? pane.scan : s.scan;
  });
  // panes-compare: right of a compare divider the pane draws its second
  // product, so the value under the pointer is that product's.
  const cmpSplit = useCompareStore((s) => (paneId && s.slots[paneId] ? s.slots[paneId].split : null));
  const cmpScan = useCompareStore((s) => (paneId && s.slots[paneId] ? s.views[paneId]?.scan ?? null : null));
  let scan = leftScan;
  if (cmpScan && cmpSplit != null && cursor) {
    const map = paneId ? getMapById(paneId) : getMap();
    const w = map?.getCanvas().clientWidth ?? 0;
    if (map && w > 0 && map.project([cursor.lng, cursor.lat]).x / w > cmpSplit) scan = cmpScan;
  }

  return useMemo(() => {
    if (!visible || !scan || !cursor) return null;
    const hit = sampleScan(scan, cursor.lat, cursor.lng);
    if (!hit) return null;
    // The threshold removes gates from the mesh, so reporting one would put a
    // number over ground the scan is deliberately not drawing.
    if (threshold !== null && hit.value < threshold) return null;

    const { units, kind, productLabel, site, elevation } = scan.meta;
    const decimals = kind === "velocity" ? 0 : 1;
    const text =
      kind === "hca"
        ? (HCA_CLASSES[Math.round(hit.value)] ?? `class ${Math.round(hit.value)}`)
        : formatValue(hit.value, kind, units, radarUnits, decimals);

    // Only the tilted scans have a meaningful beam height. The derived products
    // -- echo tops, VIL, precipitation totals -- are column quantities, not a
    // single cut through the atmosphere, so a beam height for one is invented.
    //
    // Keyed off `tilt`, not off `elevation`: the backend sends elevation 0 for
    // those products rather than null, so the obvious null check silently let
    // them through and printed a height computed at 0 degrees. That is how Echo
    // Tops ended up reading "60.0 kft" over "1.6 kft" -- two unrelated numbers
    // in the same unit, one of them meaningless.
    const height =
      scan.meta.tilt == null || elevation == null
        ? null
        : `${(beamHeightKm(hit.rangeKm, elevation) * KM_TO_KFT).toFixed(1)} kft`;

    return {
      label: productLabel || "Radar",
      text,
      height,
      site,
      azimuth: `${hit.azimuth.toFixed(0)}°`,
      range: `${hit.rangeKm.toFixed(0)} km`,
    };
  }, [visible, scan, cursor, threshold]);
}
