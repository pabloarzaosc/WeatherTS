/**
 * The best satellite picture of a storm right now, on the app's own satellite
 * layer: which imager sees it most nearly from above, and which of its scans
 * covers it most often.
 *
 * The fastest scans move: GOES's two mesoscale boxes (every minute) and
 * Himawari's target box (every 2.5 minutes) are put over the storms that
 * matter, so their boxes are read live from the frame lists. Then the fixed
 * sectors and regions (GOES CONUS every 5 minutes, the full-disk regions every
 * 10). Among scans as fast, the satellite looking straighter down wins, then
 * the tighter box.
 */
import { getMap } from "../../map/mapInstance";
import { useAppStore } from "../../store/useAppStore";
import { useSatStore } from "../../store/useSatStore";
import { fetchSatFrames, type SatRegion, type SatSatellite } from "../satellite";

export type SatView = "best" | "ir" | "wv" | "vis";
export const SAT_VIEWS: { id: SatView; label: string }[] = [
  { id: "best", label: "GeoColor (best)" },
  { id: "ir", label: "Infrared" },
  { id: "wv", label: "Water vapor" },
  { id: "vis", label: "Visible" },
];

const SATELLITE_LAYER = "satellite";

/** Where each geostationary imager sits over the equator. */
const SUBPOINT: Record<string, number> = { goes19: -75.2, goes18: -137.2, himawari9: 140.7, meteosat12: 0, meteosat9: 45.5 };

/** How far from straight down a satellite sees a place, in degrees of arc. */
function viewAngle(lat: number, lon: number, sub: number): number {
  const r = Math.PI / 180;
  return Math.acos(Math.max(-1, Math.min(1, Math.cos(lat * r) * Math.cos((lon - sub) * r)))) / r;
}

/** Inside a box with room to spare; the boxes may run past 180 either way. */
function inside(b: [number, number, number, number], lat: number, lon: number, margin: number): boolean {
  if (lat < b[1] + margin || lat > b[3] - margin) return false;
  return [lon, lon - 360, lon + 360].some((x) => x >= b[0] + margin && x <= b[2] - margin);
}

const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);

/** The region's product for a kind of view, matched by name across imagers. */
function productFor(region: SatRegion, view: SatView): SatRegion["products"][number] | undefined {
  const p = region.products;
  const ir = () => p.find((x) => /^Clean I|IR Window 10\.8/i.test(x.label));
  if (view === "best") return p.find((x) => x.id === "geo_color") ?? p.find((x) => /natural col/i.test(x.label)) ?? ir();
  if (view === "ir") return ir();
  if (view === "wv") return p.find((x) => /mid-level/i.test(x.label) && /water vapo/i.test(x.label)) ?? p.find((x) => /upper-level/i.test(x.label) && /water vapo/i.test(x.label));
  return p.find((x) => /^Red\b|Visible 0\.6/i.test(x.label));
}

export interface SatPick {
  sat: string;
  region: string;
  product: string;
  /** "GOES-East Mesoscale 1, GeoColor" */
  label: string;
  cadence: number;
}

interface Candidate {
  s: SatSatellite;
  r: SatRegion;
  box: [number, number, number, number];
  angle: number;
}

export async function bestSatellite(lat: number, lon: number, view: SatView): Promise<SatPick | null> {
  await useSatStore.getState().load();
  const cat = useSatStore.getState().catalog;
  if (!cat) throw new Error(useSatStore.getState().error ?? "The satellite service is not answering");
  const sats = cat.satellites
    .filter((s) => SUBPOINT[s.id] != null)
    .map((s) => ({ s, angle: viewAngle(lat, lon, SUBPOINT[s.id]) }))
    // Past ~72 degrees the picture is a smear along the limb.
    .filter((x) => x.angle < 72);
  // The boxes the frame lists place: GOES mesoscale and CONUS, Himawari's target.
  const live = await Promise.all(
    sats.flatMap(({ s, angle }) =>
      s.regions
        .filter((r) => !r.bounds && angle < 66)
        .map(async (r): Promise<Candidate | null> => {
          try {
            const probe = productFor(r, "ir") ?? r.products[0];
            const f = await fetchSatFrames(s.id, r.id, probe.id, 1, AbortSignal.timeout(10_000));
            return f.bounds && f.frames.length && inside(f.bounds, lat, lon, 1) ? { s, r, box: f.bounds, angle } : null;
          } catch {
            return null;
          }
        }),
    ),
  );
  const fixed: Candidate[] = sats.flatMap(({ s, angle }) =>
    s.regions.filter((r) => r.bounds && inside(r.bounds, lat, lon, 1.5)).map((r) => ({ s, r, box: r.bounds!, angle })),
  );
  const all = [...live.filter((c): c is Candidate => !!c), ...fixed].filter((c) => productFor(c.r, view));
  all.sort((a, b) => a.r.cadence - b.r.cadence || Math.round(a.angle / 10) - Math.round(b.angle / 10) || area(a.box) - area(b.box));
  const c = all[0];
  if (!c) return null;
  const p = productFor(c.r, view)!;
  return { sat: c.s.id, region: c.r.id, product: p.id, label: `${c.s.label} ${c.r.label}, ${p.label}`, cadence: c.r.cadence };
}

/** Put the best picture of a place on the map and go there; `below` px
 *  puts the place that far under the middle, clear of a card above it. */
export async function showBestSatellite(lat: number, lon: number, view: SatView, below = 0): Promise<SatPick | null> {
  const pick = await bestSatellite(lat, lon, view);
  if (!pick) return null;
  useSatStore.getState().select({ sat: pick.sat, region: pick.region, product: pick.product });
  useAppStore.getState().setLayerVisible(SATELLITE_LAYER, true);
  const map = getMap();
  map?.flyTo({ center: [lon, lat], offset: [0, below], zoom: Math.max(map.getZoom(), pick.cadence <= 60 ? 6 : 5), essential: true });
  return pick;
}

/** "every minute", "every 10 minutes". */
export function cadenceText(s: number): string {
  if (s <= 60) return "every minute";
  return s % 60 ? `every ${(s / 60).toFixed(1)} minutes` : `every ${s / 60} minutes`;
}
