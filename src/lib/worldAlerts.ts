/**
 * Alerts from outside the US: the backend's /api/alerts/world/<source>
 * (backend/world_alerts.py), which puts every source into the NWS alert's shape.
 * AlertController adds them to the set the map and the list read.
 */
import { BACKEND_BASE } from "./apiConfig";
import { registerEventKind, type AlertFeature, type AlertKind, type NwsAlert } from "./nwsAlerts";

export const WORLD_SOURCES: { id: string; label: string; hint: string }[] = [
  {
    id: "br-inmet",
    label: "Brazil: INMET alerts",
    hint: "The national weather service's yellow, orange and red notices: storm, heavy rain, low humidity and the rest. Listed with the watches.",
  },
  {
    id: "br-defesacivil",
    label: "Brazil: Defesa Civil warnings",
    hint: "From the national IDAP system, the one behind the phone alerts: every state and many cities that publish in it, and Paraná's own page.",
  },
  {
    id: "ca-eccc",
    label: "Canada: Environment Canada",
    hint: "Warnings, watches, advisories and statements, drawn in the NWS's colours where the product is the same.",
  },
  {
    id: "eu-meteoalarm",
    label: "Europe: MeteoAlarm",
    hint: "The yellow, orange and red warnings of 38 countries, from their weather services.",
  },
  {
    id: "world-cap",
    label: "Rest of the world",
    hint: "The official alerts of about 70 more countries, from the WMO's collection and national feeds. Names are translated; the text stays as issued.",
  },
];

export const worldSourceKey = (id: string) => `alerts.source.${id}`;

type WorldRecord = NwsAlert & { kind?: AlertKind; geometry?: GeoJSON.Geometry | null };

/** One source's alerts; `loading` when the backend is still reading it, a first
 *  read of the rest of the world being a few hundred files. */
export async function fetchWorldAlerts(
  source: string,
  sinceUnix: number,
  signal?: AbortSignal,
): Promise<{ features: AlertFeature[]; loading: boolean }> {
  const res = await fetch(`${BACKEND_BASE}/api/alerts/world/${encodeURIComponent(source)}?since=${sinceUnix}`, { signal });
  if (!res.ok) throw new Error(`Alerts ${source}: ${res.status}`);
  const data = (await res.json()) as { alerts?: WorldRecord[]; loading?: boolean };
  const features = (data.alerts ?? []).map(({ geometry, kind, color, ...alert }) => {
    if (kind) registerEventKind(alert.event, kind);
    return { alert: { ...alert, color: color ?? undefined }, geometry: geometry ?? null };
  });
  return { features, loading: !!data.loading };
}
