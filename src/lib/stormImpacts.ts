// Which towns a tracked storm cell is about to reach, and when.
//
// The corridor is projected from the cell's own motion vector rather than from
// the SCIT forecast polyline: the polyline stops at 60 minutes and bends with
// the algorithm's own smoothing, while a straight ray off the current heading
// is what the lead time actually assumes.

const PLACES_URL = `${import.meta.env.BASE_URL}data/us-places.json`;

/** Miles per degree of latitude. Longitude is scaled by cos(lat) per place. */
const MI_PER_DEG_LAT = 69.09;

/**
 * Half-width of the corridor counted as "hit", in miles. A severe core runs
 * roughly 5-10 miles across, so this errs towards the wider end -- a town just
 * outside the core still gets the wind and the hail.
 */
const CORRIDOR_HALF_MI = 5;

/** How far ahead to look. Matches the 60-minute SCIT forecast horizon. */
const MAX_LEAD_MIN = 60;

/** A storm this slow has no meaningful arrival time. */
const MIN_SPEED_MPH = 1;

export interface Place {
  name: string;
  state: string;
  lat: number;
  lon: number;
  population: number;
}

export interface PlaceImpact extends Place {
  /** Distance along the storm's path, miles. */
  distanceMi: number;
  /** Minutes until the storm reaches it. */
  etaMin: number;
}

interface PlacesPayload {
  fields: string[];
  places: [string, string, number, number, number][];
}

let pending: Promise<Place[]> | null = null;

/** The bundled US place list, fetched once and reused. */
export function loadPlaces(): Promise<Place[]> {
  if (!pending) {
    pending = fetch(PLACES_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`places ${r.status}`);
        return r.json() as Promise<PlacesPayload>;
      })
      .then((d) =>
        d.places.map(([name, state, lat, lon, population]) => ({
          name,
          state,
          lat,
          lon,
          population,
        })),
      )
      .catch((err) => {
        // Let a later call retry rather than caching the failure forever.
        pending = null;
        throw err;
      });
  }
  return pending;
}

export interface ImpactOptions {
  corridorHalfMi?: number;
  maxLeadMin?: number;
  limit?: number;
}

/**
 * Places the storm's path crosses, soonest first.
 *
 * `headingDeg` is the direction of travel (where the storm is going, not the
 * meteorological direction it came from), matching what the rest of the app
 * carries on a cell.
 */
export function computeImpacts(
  places: Place[],
  origin: { lat: number; lon: number },
  headingDeg: number | null,
  speedMph: number | null,
  opts: ImpactOptions = {},
): PlaceImpact[] {
  const {
    corridorHalfMi = CORRIDOR_HALF_MI,
    maxLeadMin = MAX_LEAD_MIN,
    limit = 8,
  } = opts;

  if (headingDeg == null || speedMph == null || speedMph < MIN_SPEED_MPH) return [];

  const reachMi = (speedMph * maxLeadMin) / 60;
  const rad = (headingDeg * Math.PI) / 180;
  // Unit vector of travel, in (east, north) miles.
  const east = Math.sin(rad);
  const north = Math.cos(rad);
  const miPerDegLon = MI_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  if (!Number.isFinite(miPerDegLon) || miPerDegLon <= 0) return [];

  // Cheap latitude gate before the trig: the corridor cannot reach further than
  // its own length in any direction, and this drops most of a national list.
  const latPad = (reachMi + corridorHalfMi) / MI_PER_DEG_LAT;
  const lonPad = (reachMi + corridorHalfMi) / miPerDegLon;

  const hits: PlaceImpact[] = [];
  for (const p of places) {
    if (Math.abs(p.lat - origin.lat) > latPad) continue;
    if (Math.abs(p.lon - origin.lon) > lonPad) continue;

    const dx = (p.lon - origin.lon) * miPerDegLon;
    const dy = (p.lat - origin.lat) * MI_PER_DEG_LAT;

    // Along-track: how far down the path it sits. Negative means behind the
    // storm, which has already passed it.
    const along = dx * east + dy * north;
    if (along <= 0 || along > reachMi) continue;

    const across = Math.abs(dx * north - dy * east);
    if (across > corridorHalfMi) continue;

    hits.push({
      ...p,
      distanceMi: Math.round(along * 10) / 10,
      etaMin: Math.round((along / speedMph) * 60),
    });
  }

  hits.sort((a, b) => a.distanceMi - b.distanceMi);
  return hits.slice(0, limit);
}
