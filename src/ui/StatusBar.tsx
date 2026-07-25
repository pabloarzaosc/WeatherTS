import { useAppStore } from "../store/useAppStore";
import type { CoordFormat } from "../store/useAppStore";

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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="metric">
      <span className="metric__label">{label}</span>
      <span className="metric__value">{value}</span>
    </span>
  );
}

export function StatusBar() {
  const cursor = useAppStore((s) => s.cursor);
  const zoom = useAppStore((s) => s.zoom);
  const coordFormat = useAppStore((s) => s.coordFormat);
  const projection = useAppStore((s) => s.projection);

  return (
    <footer className="status">
      <div className="status__readout">
        <Metric label="LAT" value={cursor ? format(cursor.lat, "lat", coordFormat) : "—"} />
        <Metric label="LNG" value={cursor ? format(cursor.lng, "lng", coordFormat) : "—"} />
        <Metric label="Z" value={zoom.toFixed(2)} />
      </div>
      <div className="status__meta">
        <span className="status__chip">GRAY</span>
        <span className="status__chip">{projection === "globe" ? "GLOBE" : "MERCATOR"}</span>
        <span className="status__attrib">© OpenFreeMap · OpenStreetMap</span>
      </div>
    </footer>
  );
}
