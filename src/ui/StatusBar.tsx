import { useAppStore } from "../store/useAppStore";
import type { CoordFormat } from "../store/useAppStore";
import { useChaserStore } from "../store/useChaserStore";
import { useRadarSample } from "./useRadarSample";
import { basemapInfo } from "../map/basemaps";
import { ConnectionBadge } from "./ConnectionBadge";

function decimal(value: number, axis: "lat" | "lng"): string {
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  return `${Math.abs(value).toFixed(4)}° ${hemisphere}`;
}

function dms(value: number, axis: "lat" | "lng"): string {
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  let d = Math.floor(Math.abs(value));
  let m = Math.floor((Math.abs(value) - d) * 60);
  let s = Math.round((Math.abs(value) - d - m / 60) * 3600);
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d}° ${pad(m)}′ ${pad(s)}″ ${hemisphere}`;
}

function format(value: number, axis: "lat" | "lng", mode: CoordFormat): string {
  return mode === "dms" ? dms(value, axis) : decimal(value, axis);
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="metric" title={title}>
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
    </span>
  );
}

export function StatusBar() {
  const sample = useRadarSample();
  const cursor = useAppStore((s) => s.cursor);
  const zoom = useAppStore((s) => s.zoom);
  const coordFormat = useAppStore((s) => s.coordFormat);
  const projection = useAppStore((s) => s.projection);
  // Credit follows the basemap: the imagery ones are not OpenStreetMap's. The
  // control itself lives on the map (BasemapPicker); this stays a readout.
  const basemapId = useAppStore((s) => s.basemapId);
  const basemap = basemapInfo(basemapId);
  const sharing = useChaserStore((s) => s.sharing);
  const setSharing = useChaserStore((s) => s.setSharing);

  return (
    <footer className="status">
      <div className="status__readout">
        <Metric label="LAT" value={cursor ? format(cursor.lat, "lat", coordFormat) : "—"} />
        <Metric label="LNG" value={cursor ? format(cursor.lng, "lng", coordFormat) : "—"} />
        <Metric label="Z" value={zoom.toFixed(2)} />
        {/* Only present while a scan is loaded and the cursor is inside it,
            so the readout never claims a reading where there is no data. */}
        {sample && (
          <Metric
            label={sample.label}
            value={sample.height ? `${sample.text}  ${sample.height}` : sample.text}
            title={`${sample.azimuth} from ${sample.site}, ${sample.range}`}
          />
        )}
      </div>
      <div className="status__meta">
        {/* "OFFLINE" / "WEAK CONNECTION" while the data cannot be reached */}
        <ConnectionBadge />
        {/* Never let a location broadcast run without something on screen
            saying so, and make that thing the way to stop it. */}
        {sharing && (
          <button
            type="button"
            className="status__live"
            onClick={() => setSharing(false)}
            title="You are broadcasting your position — click to stop"
          >
            <span className="status__livedot" />
            SHARING
          </button>
        )}
        <span className="status__chip">{basemap.label.toUpperCase()}</span>
        <span className="status__chip">{projection === "globe" ? "GLOBE" : "MERCATOR"}</span>
        <span className="status__attrib">{basemap.attribution}</span>
      </div>
    </footer>
  );
}
