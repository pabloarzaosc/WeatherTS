import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { Box, Eraser, Lasso, Scan, Square, X } from "lucide-react";

import { allMaps, getMap, subscribeMaps } from "../map/mapInstance";
import { COMPACT_BAR_PX, useDock } from "../lib/radar3d/dock";
import {
  boxRing,
  capRing,
  kmBetween,
  MAX_BOX_KM,
  ringBBox,
  ringCenter,
  simplify,
  siteSpot,
  squareAround,
  translateRing,
  type LngLat,
  type Sel3D,
  type SelKind,
} from "../lib/radar3d/selection";
import { useNexradStore } from "../store/useNexradStore";
import { usePaneStore } from "../store/usePaneStore";
import { useRadar3DStore, type CamFoot, type DrawMode } from "../store/useRadar3DStore";

/**
 * The 3D view's map side: the selection drawn on every pane's map (a light
 * shade under the radar, an outline with handles above it), drawing a new box
 * or tracing an area, the camera and its view cone while the view is open, the
 * bar at the foot of the map, and a box that follows a storm cell.
 */

const SRC = "r3d-sel-src";
const FILL = "r3d-sel-fill";
const MAX_CORNERS = 32;
/** A click (no drag) with the Box tool takes a box this size around the spot. */
const CLICK_BOX_KM = 100;
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#6c9dff";
}

function polygonFC(ring: LngLat[] | null): GeoJSON.FeatureCollection {
  if (!ring || ring.length < 3) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } }],
  };
}

/** The part of a map not under the 3D view, in its own pixels. */
function visibleRect(map: MapLibreMap): { x0: number; y0: number; x1: number; y1: number } {
  const c = map.getContainer();
  const pad = map.getPadding();
  return { x0: pad.left ?? 0, y0: pad.top ?? 0, x1: c.clientWidth - (pad.right ?? 0), y1: c.clientHeight - (pad.bottom ?? 0) };
}

type Drag =
  | { type: "corner"; index: number; kind: SelKind; ring: LngLat[] }
  | { type: "move"; from: LngLat; ring: LngLat[]; kind: SelKind }
  | { type: "box"; from: LngLat; px: [number, number] }
  | { type: "area"; pts: [number, number][] };

interface OverlayProps {
  map: MapLibreMap;
  ring: LngLat[] | null;
  kind: SelKind | null;
  drawMode: DrawMode;
  cam: CamFoot | null;
  onLive: (ring: LngLat[] | null) => void;
  onCommit: (sel: Sel3D) => void;
  onClickBox: (at: LngLat) => void;
  onTraceTooShort: () => void;
}

/** One pane's drawing: the shade (a map layer, so it sits under the radar)
 *  and an SVG above the map for the outline, the handles and the camera. */
function PaneOverlay({ map, ring, kind, drawMode, cam, onLive, onCommit, onClickBox, onTraceTooShort }: OverlayProps) {
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const dataRef = useRef<GeoJSON.FeatureCollection>(polygonFC(ring));

  // Follow the map as it moves.
  useEffect(() => {
    let raf = 0;
    const on = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          redraw();
        });
      }
    };
    map.on("move", on);
    map.on("resize", on);
    return () => {
      map.off("move", on);
      map.off("resize", on);
      cancelAnimationFrame(raf);
    };
  }, [map]);

  // The shade: added again whenever a style switch drops it. Left outside the
  // layer manager, it settles below every layer module, the radar included.
  useEffect(() => {
    const ensure = () => {
      try {
        if (!map.getSource(SRC)) map.addSource(SRC, { type: "geojson", data: dataRef.current });
        if (!map.getLayer(FILL)) {
          map.addLayer({ id: FILL, type: "fill", source: SRC, paint: { "fill-color": accent(), "fill-opacity": 0.14 } });
        }
      } catch {
        /* the style is still loading: its styledata comes back here */
      }
    };
    ensure();
    map.on("styledata", ensure);
    return () => {
      map.off("styledata", ensure);
      try {
        if (map.getLayer(FILL)) map.removeLayer(FILL);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        /* the map is already gone */
      }
    };
  }, [map]);
  useEffect(() => {
    dataRef.current = polygonFC(ring);
    (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(dataRef.current);
  }, [map, ring]);

  // Esc stops drawing.
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        drag.current = null;
        onLive(null);
        useRadar3DStore.getState().setDrawMode(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drawMode, onLive]);

  const c = map.getContainer();
  const W = c.clientWidth;
  const H = c.clientHeight;
  const P = (ll: LngLat): [number, number] => {
    const p = map.project(ll);
    return [p.x, p.y];
  };
  const local = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const toLL = (px: [number, number]): LngLat => {
    const l = map.unproject(px);
    return [l.lng, l.lat];
  };

  const grab = (e: React.PointerEvent, d: Drag) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (svg) {
      // The overlay lets the map have the pointer except over its handles;
      // while one is held it takes every move.
      svg.style.pointerEvents = "all";
      svg.setPointerCapture(e.pointerId);
    }
    drag.current = d;
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawMode || e.button !== 0) return;
    const px = local(e);
    if (drawMode === "box") {
      grab(e, { type: "box", from: toLL(px), px });
      onLive(null);
    } else {
      grab(e, { type: "area", pts: [px] });
    }
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const px = local(e);
    const ll = toLL(px);
    if (d.type === "box") {
      const [w, s, e2, n] = ringBBox([d.from, ll]);
      onLive(boxRing([w, s, e2, n]));
    } else if (d.type === "area") {
      const last = d.pts[d.pts.length - 1];
      if (Math.hypot(px[0] - last[0], px[1] - last[1]) >= 5) d.pts.push(px);
      onLive(d.pts.map(toLL));
    } else if (d.type === "corner") {
      if (d.kind === "area") {
        const r = d.ring.slice();
        r[d.index] = ll;
        onLive(r);
      } else {
        const opp = d.ring[(d.index + 2) % 4];
        onLive(boxRing(ringBBox([opp, ll])));
      }
    } else if (d.type === "move") {
      onLive(d.ring.map(([lo, la]) => [lo + ll[0] - d.from[0], la + ll[1] - d.from[1]] as LngLat));
    }
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (svgRef.current) svgRef.current.style.pointerEvents = "";
    if (!d) return;
    const px = local(e);
    const ll = toLL(px);
    if (d.type === "box") {
      if (Math.hypot(px[0] - d.px[0], px[1] - d.px[1]) < 6) {
        onLive(null);
        onClickBox(ll);
        return;
      }
      onCommit({ kind: "box", ring: boxRing(ringBBox([d.from, ll])) });
    } else if (d.type === "area") {
      d.pts.push(px);
      const pts = simplify(d.pts, MAX_CORNERS);
      if (pts.length < 3 || d.pts.length < 4) {
        onLive(null);
        onTraceTooShort();
        return;
      }
      onCommit({ kind: "area", ring: pts.map(toLL) });
    } else if (d.type === "corner") {
      if (d.kind === "area") {
        const r = d.ring.slice();
        r[d.index] = ll;
        onCommit({ kind: "area", ring: r });
      } else {
        onCommit({ kind: "box", ring: boxRing(ringBBox([d.ring[(d.index + 2) % 4], ll])) });
      }
    } else if (d.type === "move") {
      onCommit({ kind: d.kind, ring: d.ring.map(([lo, la]) => [lo + ll[0] - d.from[0], la + ll[1] - d.from[1]] as LngLat) });
    }
  };

  const editable = !drawMode && ring && kind && ring.length >= 3;
  const pts = ring ? ring.map(P) : [];
  const centre = ring && ring.length >= 3 ? P(ringCenter(ring)) : null;
  const camPts = cam ? cam.cone.map(P) : [];
  const eye = cam ? P(cam.eye) : null;
  const rot = cam ? cam.yaw - map.getBearing() : 0;

  return (
    <svg
      ref={svgRef}
      className={`r3d-ov${drawMode ? " is-drawing" : ""}`}
      width={W}
      height={H}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {camPts.length >= 3 && (
        <>
          <polygon className="r3d-ov__casing" points={camPts.map((p) => p.join(",")).join(" ")} />
          <polygon className="r3d-ov__cone" points={camPts.map((p) => p.join(",")).join(" ")} />
        </>
      )}
      {pts.length >= 2 && (
        <>
          <polygon className="r3d-ov__casing" points={pts.map((p) => p.join(",")).join(" ")} />
          <polygon className={`r3d-ov__ring${drawMode ? " is-live" : ""}`} points={pts.map((p) => p.join(",")).join(" ")} />
        </>
      )}
      {editable &&
        pts.length < MAX_CORNERS &&
        pts.map((p, i) => {
          const q = pts[(i + 1) % pts.length];
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 34) return null;
          const m: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          return (
            <g
              key={`e${i}`}
              className="r3d-ov__add"
              transform={`translate(${m[0]},${m[1]})`}
              onPointerDown={(e) => {
                if (e.button !== 0 || !ring) return;
                // A new corner on this edge, dragged straight away; a box becomes an area.
                const r = ring.slice();
                r.splice(i + 1, 0, toLL(m));
                onLive(r);
                grab(e, { type: "corner", index: i + 1, kind: "area", ring: r });
              }}
            >
              <title>Add a corner here</title>
              <circle r={6} />
              <path d="M-3 0H3M0 -3V3" />
            </g>
          );
        })}
      {editable &&
        pts.map((p, i) => (
          <circle
            key={`c${i}`}
            className="r3d-ov__corner"
            cx={p[0]}
            cy={p[1]}
            r={5.5}
            onPointerDown={(e) => {
              if (e.button !== 0 || !ring || !kind) return;
              grab(e, { type: "corner", index: i, kind: kind === "area" ? "area" : "box", ring });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!ring || kind !== "area" || ring.length <= 3) return;
              onCommit({ kind: "area", ring: ring.filter((_, k) => k !== i) });
            }}
          >
            <title>{kind === "area" ? "Drag to move this corner · right-click removes it" : "Drag to resize"}</title>
          </circle>
        ))}
      {editable && centre && (
        <g
          className="r3d-ov__move"
          transform={`translate(${centre[0]},${centre[1]})`}
          onPointerDown={(e) => {
            if (e.button !== 0 || !ring || !kind) return;
            grab(e, { type: "move", from: toLL(local(e)), ring, kind });
          }}
        >
          <title>Drag to move the box</title>
          <circle r={10} />
          <path d="M0 -6V6M-6 0H6M0 -6l-2 2.2M0 -6l2 2.2M0 6l-2 -2.2M0 6l2 -2.2M-6 0l2.2 -2M-6 0l2.2 2M6 0l-2.2 -2M6 0l-2.2 2" />
        </g>
      )}
      {eye && (
        <g className="r3d-ov__cam" transform={`translate(${eye[0]},${eye[1]}) rotate(${rot})`}>
          <title>The 3D view's camera</title>
          <path d="M-5 -1L0 -9L5 -1Z" />
          <rect x={-8} y={-1} width={16} height={11} rx={2.5} />
          <circle cx={0} cy={4.5} r={2.6} />
        </g>
      )}
    </svg>
  );
}

/** The bar at the foot of the map while the 3D view is open. */
function MapBar({ onWhole }: { onWhole: () => void }) {
  const st = useRadar3DStore();
  const spot = siteSpot(st.site);
  // Split panes: the bar sits at the foot of the focused pane; where the map
  // part is narrow it shows icons only (the hint goes in its tooltip).
  const dock = useDock();
  const anchorRef = useRef<HTMLDivElement>(null);
  const avail = dock.focus
    ? dock.view
      ? dock.focus.width
      : window.innerWidth >= 900
        ? dock.focus.width * 0.42
        : dock.focus.width
    : Infinity;
  const compact = avail < COMPACT_BAR_PX;
  const host = (anchorRef.current?.offsetParent as HTMLElement | null | undefined)?.getBoundingClientRect();
  const anchorStyle =
    dock.view && dock.focus
      ? { left: dock.focus.left - (host?.left ?? 0) + dock.focus.width / 2, maxWidth: dock.focus.width - 16 }
      : undefined;
  const hint =
    st.drawMode === "box"
      ? "Drag a box on the map, or click for a 100 km box · Esc"
      : st.drawMode === "area"
        ? "Press and trace around the storm; let go to close it · Esc"
        : !st.sel
          ? "Draw a box, trace an area, or take the whole view"
          : st.follow
            ? `Following cell ${st.follow}`
            : st.sel.kind === "area"
              ? "Drag the corners · click an edge to add one · right-click a corner removes it"
              : "Drag the corners or the centre · click an edge to add a corner";
  return (
    <div ref={anchorRef} className={`r3d-bar-anchor${compact ? " is-compact" : ""}`} style={anchorStyle}>
      <div className="r3d-bar" role="toolbar" aria-label="3D view selection" title={compact ? (st.notice ?? hint) : undefined}>
        <span className="r3d-bar__title">
          <Box size={14} />
          <span className="r3d-bar__txt">3D · {spot?.icao ?? st.site ?? ""}</span>
        </span>
        <span className="r3d-bar__sep" />
        <button
          type="button"
          className={`r3d-bar__btn${st.drawMode === "box" ? " is-on" : ""}`}
          onClick={() => st.setDrawMode(st.drawMode === "box" ? null : "box")}
          aria-pressed={st.drawMode === "box"}
          title="Drag a box on the map"
        >
          <Square size={14} />
          <span className="r3d-bar__txt">Box</span>
        </button>
        <button
          type="button"
          className={`r3d-bar__btn${st.drawMode === "area" ? " is-on" : ""}`}
          onClick={() => st.setDrawMode(st.drawMode === "area" ? null : "area")}
          aria-pressed={st.drawMode === "area"}
          title="Trace an area by hand: only what is inside it is drawn"
        >
          <Lasso size={14} />
          <span className="r3d-bar__txt">Area</span>
        </button>
        <button type="button" className={`r3d-bar__btn${st.sel?.kind === "whole" ? " is-on" : ""}`} onClick={onWhole} title={`What the map shows, up to ${MAX_BOX_KM} km`}>
          <Scan size={14} />
          <span className="r3d-bar__txt">Whole view</span>
        </button>
        <button type="button" className="r3d-bar__btn" onClick={() => st.clearSelection()} disabled={!st.sel} title="Clear the selection">
          <Eraser size={14} />
          <span className="r3d-bar__txt">Clear</span>
        </button>
        <span className="r3d-bar__sep" />
        <button type="button" className="r3d-bar__btn r3d-bar__btn--close" onClick={() => st.close()} title="Close the 3D view" aria-label="Close the 3D view">
          <X size={15} />
        </button>
      </div>
      {(!compact || st.notice) && (
        <div className={`r3d-bar__note${st.notice ? " is-warn" : ""}`} role="status">
          {st.notice ?? hint}
        </div>
      )}
    </div>
  );
}

/** "Whole view": what the focused map shows beside the 3D view, up to 400 km. */
export function takeWholeView(): boolean {
  const map = getMap();
  if (!map) return false;
  const r = visibleRect(map);
  const corners: LngLat[] = (
    [
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x1, r.y1],
      [r.x0, r.y1],
    ] as [number, number][]
  ).map((p) => {
    const l = map.unproject(p);
    return [l.lng, l.lat];
  });
  return useRadar3DStore.getState().setSelection({ kind: "whole", ring: capRing(boxRing(ringBBox(corners)), MAX_BOX_KM) }, null);
}

/** Every pane's overlay, the bar, the map padding, and the cell the box follows. */
export function Radar3DBoxTool() {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeMaps(bump), []);
  const sel = useRadar3DStore((s) => s.sel);
  const drawMode = useRadar3DStore((s) => s.drawMode);
  const cam = useRadar3DStore((s) => s.cam);
  const expanded = useRadar3DStore((s) => s.expanded);
  const notice = useRadar3DStore((s) => s.notice);
  const [live, setLive] = useState<LngLat[] | null>(null);
  const ring = live ?? sel?.ring ?? null;

  // A refused box (or any message) clears itself after a while.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => useRadar3DStore.getState().setNotice(null), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const commit = (s: Sel3D) => {
    setLive(null);
    useRadar3DStore.getState().setSelection(s, null);
  };
  const clickBox = (at: LngLat) => commit({ kind: "box", ring: squareAround(at[0], at[1], CLICK_BOX_KM) });
  const tooShort = () => useRadar3DStore.getState().setNotice("Trace a little further round the storm, then let go.");
  const whole = () => {
    setLive(null);
    takeWholeView();
  };

  // The map keeps the half the 3D view leaves it: padding moves its centre there.
  // Not when the view has a pane (or a window) of its own: it covers no map
  // side then, and a window over a map must not push that map's centre away.
  const inPane = usePaneStore((s) => Object.values(s.analysis).includes("r3d"));
  useEffect(() => {
    const apply = () => {
      const panel = document.querySelector<HTMLElement>(".r3d-screen");
      for (const m of allMaps()) {
        let right = 0;
        if (panel && !panel.closest(".apane") && !useRadar3DStore.getState().expanded) {
          const pr = panel.getBoundingClientRect();
          const mr = m.getContainer().getBoundingClientRect();
          const over = mr.right - pr.left;
          if (over > 0 && over < mr.width - 160) right = Math.round(over);
        }
        const cur = m.getPadding();
        if (Math.abs((cur.right ?? 0) - right) > 1) m.setPadding({ ...cur, right });
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    const panel = document.querySelector<HTMLElement>(".r3d-screen");
    if (panel) ro.observe(panel);
    window.addEventListener("resize", apply);
    // The panel moves into (or out of) a pane after mounting: look again then.
    const t = window.setTimeout(apply, 120);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [expanded, inPane]);
  useEffect(
    () => () => {
      for (const m of allMaps()) {
        const cur = m.getPadding();
        if (cur.right) m.setPadding({ ...cur, right: 0 });
      }
    },
    [],
  );

  // A selection made elsewhere (right-click, a storm cell, a followed cell
  // moving on) is brought into the visible part of the focused map.
  useEffect(() => {
    if (!sel) return;
    const map = getMap();
    if (!map) return;
    const r = visibleRect(map);
    const pts = sel.ring.map((p) => map.project(p));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const inView = Math.min(...xs) >= r.x0 - 2 && Math.max(...xs) <= r.x1 + 2 && Math.min(...ys) >= r.y0 - 2 && Math.max(...ys) <= r.y1 + 2;
    if (inView) return;
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    const fit = Math.min((r.x1 - r.x0) / Math.max(1, bw), (r.y1 - r.y0) / Math.max(1, bh)) * 0.8;
    const zoom = map.getZoom() + (fit < 1 ? Math.log2(fit) : 0);
    map.easeTo({ center: ringCenter(sel.ring), zoom, duration: 600 });
  }, [sel]);

  // Render 3D on a storm cell: the box follows it as new scans come.
  const storms = useNexradStore((s) => s.storms);
  useEffect(() => {
    const s = useRadar3DStore.getState();
    if (!s.follow || !s.sel || !storms || useNexradStore.getState().site !== s.site) return;
    const cell = storms.cells.find((c) => c.id === s.follow);
    if (!cell) return;
    const [cx, cy] = ringCenter(s.sel.ring);
    if (kmBetween(cy, cx, cell.lat, cell.lon) < 1) return;
    s.setSelection({ kind: s.sel.kind === "whole" ? "box" : s.sel.kind, ring: translateRing(s.sel.ring, [cell.lon, cell.lat]) }, s.follow);
  }, [storms]);

  const maps = allMaps();
  return (
    <>
      {maps.map((m, i) =>
        createPortal(
          <PaneOverlay
            map={m}
            ring={ring}
            kind={sel?.kind ?? (live ? "box" : null)}
            drawMode={drawMode}
            cam={cam}
            onLive={setLive}
            onCommit={commit}
            onClickBox={clickBox}
            onTraceTooShort={tooShort}
          />,
          m.getContainer(),
          `r3d-ov-${i}`,
        ),
      )}
      {!expanded && <MapBar onWhole={whole} />}
    </>
  );
}
