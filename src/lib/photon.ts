export interface PlaceResult {
  id: string;
  label: string;
  lng: number;
  lat: number;
  kind?: string;
}

interface PhotonFeature {
  geometry?: { type: string; coordinates: [number, number] };
  properties?: Record<string, string | number | undefined>;
}
interface PhotonResponse {
  features?: PhotonFeature[];
}

/** Free, keyless geocoding via Komoot Photon. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!q) return [];

  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Photon request failed (${res.status})`);
  const data = (await res.json()) as PhotonResponse;

  const results: PlaceResult[] = [];
  (data.features ?? []).forEach((f, i) => {
    if (f.geometry?.type !== "Point") return;
    const [lng, lat] = f.geometry.coordinates;
    const p = f.properties ?? {};
    const label =
      [p.name, p.city ?? p.county, p.state, p.country].filter(Boolean).join(", ") ||
      String(p.name ?? `${lat.toFixed(3)}, ${lng.toFixed(3)}`);
    results.push({
      id: `${p.osm_type ?? "p"}:${p.osm_id ?? i}`,
      label,
      lng,
      lat,
      kind: typeof p.osm_value === "string" ? p.osm_value : undefined,
    });
  });
  return results;
}
