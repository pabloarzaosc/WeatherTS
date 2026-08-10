import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Navigation, Tornado, X } from "lucide-react";

import { getMap, subscribeMaps } from "../map/mapInstance";
import { useAlertStore } from "../store/useAlertStore";
import { useAppStore } from "../store/useAppStore";
import { useNexradStore } from "../store/useNexradStore";

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

/**
 * The card that opens when a tracked storm cell is clicked: where the cell is
 * headed and how fast, whether it has a mesocyclone, and which warnings cover
 * it — with one click through to those warnings.
 *
 * Anchored by projecting the cell's lon/lat to screen pixels on every map move,
 * rather than by a MapLibre popup, so it can be a real React component with the
 * app's own styling and buttons.
 */
export function StormPopup() {
  const storms = useNexradStore((s) => s.storms);
  const selectedCellId = useNexradStore((s) => s.selectedCellId);
  const selectCell = useNexradStore((s) => s.selectCell);
  const alertFeatures = useAlertStore((s) => s.features);
  const alertsActive = useAlertStore((s) => s.active);
  const selectMany = useAlertStore((s) => s.selectMany);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const cell = storms?.cells.find((c) => c.id === selectedCellId) ?? null;
  const meso = storms?.mesos.find((m) => m.stormId === selectedCellId) ?? null;

  // Re-project on every move so the card tracks the cell while panning/zooming.
  useEffect(() => {
    if (!cell) {
      setPos(null);
      return;
    }
    let map = getMap();
    const update = () => {
      map = getMap();
      if (!map) return;
      const p = map.project([cell.lon, cell.lat]);
      setPos({ x: p.x, y: p.y });
    };
    update();
    const bind = (m: ReturnType<typeof getMap>) => {
      m?.on("move", update);
      m?.on("resize", update);
      return () => {
        m?.off("move", update);
        m?.off("resize", update);
      };
    };
    let unbind = bind(map);
    const unsubPanes = subscribeMaps(() => {
      unbind();
      unbind = bind(getMap());
      update();
    });
    return () => {
      unbind();
      unsubPanes();
    };
  }, [cell]);

  // Warnings whose polygon contains the cell, tested against the alert
  // GEOMETRIES rather than against what the map happens to have rendered:
  // queryRenderedFeatures only answers when the alerts layer is switched on and
  // the polygon is painted at that exact pixel, so the impacts silently came
  // back empty whenever alerts were off or the cell sat under another product.
  const related = useMemo(() => {
    if (!cell) return [];
    return alertFeatures.filter((f) => covers(f.geometry, cell.lon, cell.lat));
  }, [alertFeatures, cell]);

  if (!cell || !pos) return null;

  const W = 232;
  const left = Math.max(8, Math.min(pos.x + 14, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(pos.y - 12, window.innerHeight - 220));

  return (
    <div className="stormpop" style={{ left, top, width: W }}>
      <header className="stormpop__head">
        <b>Cell {cell.id}</b>
        <button type="button" onClick={() => selectCell(null)} title="Close">
          <X size={14} />
        </button>
      </header>

      <div className="stormpop__motion">
        <Navigation
          size={15}
          style={{
            transform: `rotate(${(cell.headingDeg ?? 0)}deg)`,
            color: "var(--accent)",
          }}
        />
        <span>
          {cell.headingCompass && cell.speedMph != null
            ? `${cell.headingCompass} at ${cell.speedMph} mph`
            : "Motion not resolved"}
        </span>
      </div>

      <dl className="stormpop__rows">
        <dt>Range</dt>
        <dd>{Math.round(cell.rangeKm)} km / {Math.round(cell.azimuthDeg)}°</dd>
        <dt>Position</dt>
        <dd>
          {cell.lat.toFixed(2)}, {cell.lon.toFixed(2)}
        </dd>
        <dt>Forecast</dt>
        <dd>{cell.forecast.length > 1 ? `${(cell.forecast.length - 1) * 15} min ahead` : "--"}</dd>
      </dl>

      {meso && (
        <div className={`stormpop__meso${meso.tvs ? " is-tvs" : ""}`}>
          <Tornado size={14} />
          <span>{meso.tvs ? "TVS — tornado vortex signature" : "Mesocyclone detected"}</span>
        </div>
      )}

      {related.length > 0 ? (
        <>
          <ul className="stormpop__alerts">
            {related.slice(0, 3).map((f) => (
              <li key={f.alert.id}>{f.alert.event}</li>
            ))}
            {related.length > 3 && <li>+{related.length - 3} more</li>}
          </ul>
          <button
            type="button"
            className="stormpop__impacts"
            onClick={() => {
              selectMany(related.map((f) => f.alert.id));
              setListOpen(true);
            }}
          >
            See impacts <ArrowRight size={13} />
          </button>
        </>
      ) : !alertsActive ? (
        // "No warning covers this cell" would be a lie while the alert feed is
        // switched off -- nothing has been fetched to check against.
        <button
          type="button"
          className="stormpop__impacts"
          onClick={() => setLayerVisible("nws-alerts", true)}
        >
          Turn on alerts to check <ArrowRight size={13} />
        </button>
      ) : (
        <p className="stormpop__none">No warning covers this cell.</p>
      )}
    </div>
  );
}
