import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CloudHail,
  Loader2,
  MapPin,
  Navigation,
  Tornado,
  TrendingUp,
  X,
} from "lucide-react";

import { fetchStormCellHistory, type StormCellSample } from "../lib/nexrad";
import { computeImpacts, loadPlaces, type Place, type PlaceImpact } from "../lib/stormImpacts";
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore } from "../store/useAppStore";
import { isTdwrId, useNexradStore } from "../store/useNexradStore";
import { useStormCellStore } from "../store/useStormCellStore";
import { useRadar3DStore } from "../store/useRadar3DStore";
import { currentFrame, squareAround } from "../lib/radar3d/selection";

/** Ray-cast point-in-ring, in lon/lat. */
function inRing(lon: number, lat: number, ring: GeoJSON.Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point-in-polygon over a Polygon or MultiPolygon, holes respected. */
function covers(geom: GeoJSON.Geometry | null, lon: number, lat: number): boolean {
  if (!geom) return false;
  const polys: GeoJSON.Position[][][] =
    geom.type === "Polygon"
      ? [geom.coordinates]
      : geom.type === "MultiPolygon"
        ? geom.coordinates
        : [];
  for (const poly of polys) {
    if (!poly.length || !inRing(lon, lat, poly[0])) continue;
    // inside the outer ring — reject if it falls in a hole
    if (poly.slice(1).some((hole) => inRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/** The attributes worth plotting, with the units and colour each is drawn in. */
const METRICS = [
  { key: "vilKgM2", label: "VIL", unit: "kg/m²", color: "#38bdf8", dec: 0 },
  { key: "maxRefDbz", label: "Max ref", unit: "dBZ", color: "#ff6b5e", dec: 0 },
  { key: "cellTopKft", label: "Cell top", unit: "kft", color: "#4ade80", dec: 1 },
  { key: "maxHailSizeIn", label: "Hail size", unit: "in", color: "#facc15", dec: 2 },
  { key: "probHailPct", label: "Prob hail", unit: "%", color: "#c7d2e4", dec: 0 },
] as const;

const hhmm = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** How many recent volumes to request. The backend clamps to [2, 40]; these
 *  are round numbers within that band, not tied to any particular time span
 *  since the scan cadence isn't fixed. */
const VOLUME_OPTIONS = [8, 14, 24, 40];

/**
 * One attribute across the recent volumes. Hand-drawn SVG for the same reason
 * the station report's chart is: it inherits the app's tokens rather than
 * fighting a chart library's own theme.
 */
function Chart({
  samples,
  metricKey,
  color,
  dec,
}: {
  samples: StormCellSample[];
  metricKey: string;
  color: string;
  dec: number;
}) {
  const pts = samples
    .map((s, i) => ({ i, v: (s as unknown as Record<string, number | undefined>)[metricKey] }))
    .filter((o): o is { i: number; v: number } => typeof o.v === "number");

  if (pts.length < 2) {
    return <div className="scp__chart-empty">Not enough scans to chart this yet.</div>;
  }

  const W = 320;
  const H = 132;
  const L = 40;
  const R = 8;
  const T = 10;
  const B = 20;
  const n = samples.length - 1 || 1;
  let lo = Math.min(...pts.map((o) => o.v));
  let hi = Math.max(...pts.map((o) => o.v));
  // A flat series still needs a band to draw in, and a value of 0 should sit on
  // the floor rather than in the middle of an invented range.
  if (hi - lo < 1e-9) {
    lo = Math.min(0, lo - 1);
    hi += 1;
  }
  const X = (i: number) => L + (i / n) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = pts.map((o, k) => `${k ? "L" : "M"}${X(o.i).toFixed(1)},${Y(o.v).toFixed(1)}`).join("");
  const area = `${line}L${X(pts[pts.length - 1].i).toFixed(1)},${H - B}L${X(pts[0].i).toFixed(1)},${H - B}Z`;
  // Deduped: with only two samples n is 1, so the "middle" tick collapses onto
  // the first and the two time labels render on top of each other.
  const marks = [...new Set([0, Math.floor(n / 2), n])];

  return (
    <svg className="scp__chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trend across scans">
      {[hi, (hi + lo) / 2, lo].map((v) => (
        <g key={v}>
          <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} className="scp__grid" />
          <text x={L - 6} y={Y(v) + 3} className="scp__ylab">
            {v.toFixed(dec)}
          </text>
        </g>
      ))}
      {marks.map((i, k) => (
        <text
          key={i}
          x={X(i)}
          y={H - 6}
          className="scp__xlab"
          // Anchored by position in the list, not a fixed index: after the
          // dedupe there may be only two marks, and the last must still hang
          // off the right edge rather than centre and overflow it.
          textAnchor={k === 0 ? "start" : k === marks.length - 1 ? "end" : "middle"}
        >
          {samples[i] ? hhmm(samples[i].unix) : ""}
        </text>
      ))}
      <path d={area} fill={color} opacity={0.13} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} />
      {pts.map((o) => (
        <circle key={o.i} cx={X(o.i)} cy={Y(o.v)} r={1.9} fill={color} />
      ))}
    </svg>
  );
}

/** Change between the first and last scan that reported this attribute. */
function trendOf(samples: StormCellSample[], key: string): number | null {
  const vals = samples
    .map((s) => (s as unknown as Record<string, number | undefined>)[key])
    .filter((v): v is number => typeof v === "number");
  if (vals.length < 2) return null;
  return vals[vals.length - 1] - vals[0];
}

/** The full report for one tracked storm cell, opened from the map's card. */
export function StormCellPanel() {
  const cellId = useStormCellStore((s) => s.cellId);
  const close = useStormCellStore((s) => s.close);
  const metricKey = useStormCellStore((s) => s.metric);
  const setMetric = useStormCellStore((s) => s.setMetric);
  const volumes = useStormCellStore((s) => s.volumes);
  const setVolumes = useStormCellStore((s) => s.setVolumes);

  const storms = useNexradStore((s) => s.storms);
  const site = useNexradStore((s) => s.site);

  const alertFeatures = useAlertStore((s) => s.features);
  const alertsActive = useAlertStore((s) => s.active);
  const selectMany = useAlertStore((s) => s.selectMany);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const cell = storms?.cells.find((c) => c.id === cellId) ?? null;
  const meso = storms?.mesos.find((m) => m.stormId === cellId) ?? null;

  // Warnings whose polygon contains the cell, tested against the alert
  // GEOMETRIES rather than against what the map happens to have rendered:
  // queryRenderedFeatures only answers when the alerts layer is switched on and
  // the polygon is painted at that exact pixel, so this came back empty
  // whenever alerts were off or the cell sat under another product.
  const related = useMemo(() => {
    if (!cell) return [];
    return alertFeatures.filter((f) => covers(f.geometry, cell.lon, cell.lat));
  }, [alertFeatures, cell]);

  // The place list is a bundled megabyte, so it loads with the first report
  // opened rather than at startup, and the module caches it from then on.
  const [places, setPlaces] = useState<Place[] | null>(null);
  useEffect(() => {
    if (!cellId || places) return;
    let live = true;
    loadPlaces().then(
      (p) => live && setPlaces(p),
      () => {}, // no place list just means no path section
    );
    return () => {
      live = false;
    };
  }, [cellId, places]);

  const impacts: PlaceImpact[] = useMemo(() => {
    if (!cell || !places) return [];
    return computeImpacts(
      places,
      { lat: cell.lat, lon: cell.lon },
      cell.headingDeg,
      cell.speedMph,
      { limit: 8 },
    );
  }, [places, cell]);

  const [samples, setSamples] = useState<StormCellSample[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!cellId || !site) return;
    const ac = new AbortController();
    setBusy(true);
    setFailed(false);
    fetchStormCellHistory(site, cellId, volumes, ac.signal)
      .then((rows) => {
        setSamples(rows);
        setBusy(false);
      })
      .catch((err) => {
        if (ac.signal.aborted) return;
        setFailed(true);
        setBusy(false);
        void err;
      });
    return () => ac.abort();
    // The radar re-polls constantly; refetching the whole series on every one
    // would hammer the feed, so this keys only on which cell is open and how
    // much history was asked for.
  }, [cellId, site, volumes]);

  useEffect(() => {
    if (!cellId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cellId, close]);

  const metric = useMemo(
    () => METRICS.find((m) => m.key === metricKey) ?? METRICS[0],
    [metricKey],
  );

  if (!cellId) return null;

  // How far ahead the track runs, and how much ground that covers -- the ticks
  // on the map are these same steps, so the two read together.
  const leadMin = cell && cell.forecast.length > 1 ? (cell.forecast.length - 1) * 15 : 0;
  const forecastLabel = !leadMin
    ? "—"
    : cell?.speedMph != null
      ? `${leadMin} min · ${Math.round((cell.speedMph * leadMin) / 60)} mi`
      : `${leadMin} min ahead`;

  const latest = samples.length ? samples[samples.length - 1] : null;
  const value = (key: string): number | undefined =>
    (cell as unknown as Record<string, number | undefined>)?.[key] ??
    (latest as unknown as Record<string, number | undefined>)?.[key];

  return (
    <div
      className="scp__back"
      // Clicking the dimmed area closes, the same way the station report does.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="scp" role="dialog" aria-label={`Storm cell ${cellId} report`}>
      <header className="scp__head">
        <div>
          <b>Cell {cellId}</b>
          <span className="scp__site">{storms?.meta.site ?? site ?? ""}</span>
        </div>
        <button type="button" onClick={close} title="Close" aria-label="Close">
          <X size={15} />
        </button>
      </header>

      {!cell && (
        <p className="scp__gone">
          This cell is no longer in the latest scan — the numbers below are its last report.
        </p>
      )}

      {cell && (
        <div className="scp__motion">
          <Navigation
            size={15}
            style={{ transform: `rotate(${cell.headingDeg ?? 0}deg)`, color: "var(--accent)" }}
          />
          <span>
            {cell.headingCompass && cell.speedMph != null
              ? `${cell.headingCompass} at ${cell.speedMph} mph`
              : "Motion not resolved"}
          </span>
          {meso?.tvs && (
            <em className="scp__tvs" title="Tornado vortex signature from the NWS Level III product">
              TVS · NWS L3
            </em>
          )}
        </div>
      )}

      {meso && !meso.tvs && (
        <div className="scp__meso">
          <Tornado size={14} /> Mesocyclone detected · NWS L3
        </div>
      )}

      {cell && (
        <section className="scp__sec">
          <dl className="scp__rows">
            <dt>Range / azimuth</dt>
            <dd>
              {Math.round(cell.rangeKm)} km · {Math.round(cell.azimuthDeg)}°
            </dd>
            <dt>Position</dt>
            <dd>
              {cell.lat.toFixed(3)}, {cell.lon.toFixed(3)}
            </dd>
            <dt>Forecast</dt>
            <dd>{forecastLabel}</dd>
          </dl>
          {site && !isTdwrId(site) && (
            <button
              type="button"
              className="scp__link"
              onClick={() => {
                // An 80 km box on the cell; it follows the cell as new scans come.
                useRadar3DStore.getState().openView({
                  site,
                  ...currentFrame(),
                  sel: { kind: "box", ring: squareAround(cell.lon, cell.lat, 80) },
                  follow: cell.id,
                });
                close();
              }}
              title="The cell in 3D; the box follows it as new scans come"
            >
              Render 3D <ArrowRight size={13} />
            </button>
          )}
        </section>
      )}

      <section className="scp__sec">
        <h4 className="scp__sechead">
          <CloudHail size={13} /> Hail
        </h4>
        <div className="scp__tiles">
          <Tile label="Prob. of hail" v={value("probHailPct")} unit="%" dec={0} />
          <Tile label="Prob. of severe" v={value("probSevereHailPct")} unit="%" dec={0} />
          <Tile label="Max size" v={value("maxHailSizeIn")} unit="in" dec={2} />
        </div>
      </section>

      <section className="scp__sec">
        <h4 className="scp__sechead">
          <TrendingUp size={13} /> Structure
        </h4>
        <div className="scp__tiles">
          <Tile label="Cell top" v={value("cellTopKft")} unit="kft" dec={1} />
          <Tile label="Cell base" v={value("cellBaseKft")} unit="kft" dec={1} />
          <Tile label="Max ref" v={value("maxRefDbz")} unit="dBZ" dec={0} />
          <Tile label="Max ref hgt" v={value("maxRefHeightKft")} unit="kft" dec={1} />
          <Tile label="Cell VIL" v={value("vilKgM2")} unit="kg/m²" dec={0} />
        </div>
      </section>

      <section className="scp__sec">
        <h4 className="scp__sechead">
          Trend across scans
          {samples.length > 0 && <span className="scp__count">{samples.length} of {volumes}</span>}
        </h4>

        <div className="scp__ranges">
          {VOLUME_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              className={`scp__rangebtn${n === volumes ? " is-on" : ""}`}
              onClick={() => setVolumes(n)}
            >
              {n}
            </button>
          ))}
        </div>

        <div className="scp__metrics">
          {METRICS.map((m) => {
            const d = trendOf(samples, m.key);
            return (
              <button
                key={m.key}
                type="button"
                className={`scp__metric${m.key === metric.key ? " is-on" : ""}`}
                onClick={() => setMetric(m.key)}
              >
                {m.label}
                {d != null && d !== 0 && (
                  <i className={d > 0 ? "is-up" : "is-down"}>{d > 0 ? "▲" : "▼"}</i>
                )}
              </button>
            );
          })}
        </div>

        {busy ? (
          <div className="scp__busy">
            <Loader2 size={14} className="scp__spin" /> Reading recent scans…
          </div>
        ) : failed ? (
          <div className="scp__chart-empty">Scan history unavailable.</div>
        ) : samples.length === 0 ? (
          <div className="scp__chart-empty">
            No scan history for this cell. Hail and structure come from the live feed, so
            they are not available while the timeline is in the archive.
          </div>
        ) : (
          <>
            <Chart
              samples={samples}
              metricKey={metric.key}
              color={metric.color}
              dec={metric.dec}
            />
            <p className="scp__unit">
              {metric.label} ({metric.unit})
            </p>
          </>
        )}
      </section>

      {impacts.length > 0 && (
        <section className="scp__sec">
          <h4 className="scp__sechead">
            <MapPin size={13} /> In the path
          </h4>
          <ul className="scp__impacts">
            {impacts.map((p) => (
              <li key={`${p.name}-${p.state}`}>
                <span className="scp__town">
                  {p.name}, {p.state}
                </span>
                <span className="scp__towndist">{p.distanceMi.toFixed(1)} mi</span>
                <span className="scp__towneta">+{p.etaMin}m</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="scp__sec">
        <h4 className="scp__sechead">Warnings over this cell</h4>
        {related.length > 0 ? (
          <>
            <ul className="scp__alerts">
              {related.map((f) => (
                <li key={f.alert.id}>{f.alert.event}</li>
              ))}
            </ul>
            <button
              type="button"
              className="scp__link"
              onClick={() => {
                selectMany(related.map((f) => f.alert.id));
                setListOpen(true);
              }}
            >
              Open in the alert rail <ArrowRight size={13} />
            </button>
          </>
        ) : !alertsActive ? (
          // "No warning covers this cell" would be a lie while the alert feed
          // is switched off -- nothing has been fetched to check against.
          <button
            type="button"
            className="scp__link"
            onClick={() => setLayerVisible("nws-alerts", true)}
          >
            Turn on alerts to check <ArrowRight size={13} />
          </button>
        ) : (
          <p className="scp__none">No warning covers this cell.</p>
        )}
      </section>
      </div>
    </div>
  );
}

function Tile({
  label,
  v,
  unit,
  dec,
}: {
  label: string;
  v: number | undefined;
  unit: string;
  dec: number;
}) {
  return (
    <div className="scp__tile">
      <span>{label}</span>
      <b>{v == null ? "—" : `${v.toFixed(dec)} ${unit}`}</b>
    </div>
  );
}
