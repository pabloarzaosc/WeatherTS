import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Eraser,
  GripVertical,
  Lock,
  Minus,
  PaintBucket,
  PenLine,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
} from "lucide-react";

import { getActivePaneId, getMap, subscribeMaps } from "../map/mapInstance";
import { useAppStore } from "../store/useAppStore";
import { DRAW_COLORS, DRAW_WIDTHS, useDrawStore, type DrawTool as Tool, type LngLat } from "../store/useDrawStore";
import { setDrawDraft, shapesAt } from "../layers/modules/drawLayer";
import { useDragOffset } from "../lib/useDragOffset";

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "pen", label: "Pen", key: "P", icon: <Pencil size={15} /> },
  { id: "line", label: "Line", key: "L", icon: <Minus size={15} /> },
  { id: "arrow", label: "Arrow", key: "A", icon: <ArrowUpRight size={15} /> },
  { id: "circle", label: "Circle", key: "C", icon: <Circle size={15} /> },
  { id: "rect", label: "Rectangle", key: "R", icon: <Square size={15} /> },
  { id: "text", label: "Text", key: "T", icon: <Type size={15} /> },
  { id: "eraser", label: "Eraser", key: "E", icon: <Eraser size={15} /> },
];

type Popover = "tool" | "color" | "width" | null;

/** Minimum pointer travel, in pixels, before a stroke is a stroke. */
const MIN_DRAG_PX = 4;
/** Pen points closer than this are dropped: they add weight, not shape. */
const PEN_STEP_PX = 2;

interface TextDraft {
  x: number;
  y: number;
  at: LngLat;
}

/**
 * Draw on the map: freehand, lines, arrows, circles, rectangles and text, in
 * any colour and width, with undo and an eraser.
 *
 * While the map is locked, dragging draws instead of panning; the wheel still
 * zooms. Unlocked, the map moves as usual and the drawings stay put. Every
 * shape is kept in latitude and longitude, so it stays on the ground it was
 * drawn over.
 */
export function DrawTool() {
  const active = useDrawStore((s) => s.active);
  const locked = useDrawStore((s) => s.locked);
  const tool = useDrawStore((s) => s.tool);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  // The focused pane is the one drawn on; clicking another moves the tool there.
  const paneId = useSyncExternalStore(subscribeMaps, getActivePaneId);

  // Drawing has to be visible: opening the tool switches the layer on.
  useEffect(() => {
    if (!active) return;
    const layer = useAppStore.getState().layers["drawings"];
    if (layer && !layer.visible) useAppStore.getState().setLayerVisible("drawings", true);
    // Measure also listens to map clicks; one tool at a time.
    if (useAppStore.getState().measureMode !== "off") useAppStore.getState().setMeasureMode("off");
  }, [active]);

  useEffect(() => {
    if (!active || !locked) return;
    const map = getMap();
    if (!map) return;
    return attach(map, tool, setTextDraft);
  }, [active, locked, tool, paneId]);

  // Shortcuts while the tool is open.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const st = useDrawStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "Escape") {
        st.setActive(false);
        return;
      }
      const t = TOOLS.find((x) => x.key === e.key.toUpperCase());
      if (t) st.setTool(t.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  useEffect(() => {
    if (!active) {
      setTextDraft(null);
      setDrawDraft(null);
    }
  }, [active]);

  if (!active) return null;
  return (
    <>
      <DrawBar />
      {textDraft && (
        <TextInput key={`${textDraft.x},${textDraft.y}`} draft={textDraft} onDone={() => setTextDraft(null)} />
      )}
    </>
  );
}

/** Wire pointer input on one map. Returns the detach. */
function attach(map: MapLibreMap, tool: Tool, openText: (d: TextDraft) => void): () => void {
  const container = map.getCanvasContainer();
  const screen = (e: PointerEvent): [number, number] => {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const geo = (xy: [number, number]): LngLat => {
    const ll = map.unproject(xy);
    return [ll.lng, ll.lat];
  };

  let pointerId: number | null = null;
  let startXY: [number, number] = [0, 0];
  let lastXY: [number, number] = [0, 0];
  let points: LngLat[] = [];

  const pen = () => {
    const s = useDrawStore.getState();
    return { color: s.color, width: s.width, dashed: s.dashed, fill: s.fill };
  };

  const erase = (xy: [number, number]) => {
    const ids = shapesAt(map, xy);
    if (ids.length) useDrawStore.getState().remove(ids);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || pointerId !== null) return;
    e.preventDefault();
    const xy = screen(e);
    if (tool === "text") {
      openText({ x: e.clientX, y: e.clientY, at: geo(xy) });
      return;
    }
    pointerId = e.pointerId;
    try {
      container.setPointerCapture(e.pointerId);
    } catch {
      /* the window keeps delivering moves either way */
    }
    startXY = xy;
    lastXY = xy;
    if (tool === "eraser") {
      erase(xy);
      return;
    }
    points = [geo(xy)];
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const xy = screen(e);
    if (tool === "eraser") {
      erase(xy);
      return;
    }
    if (tool === "pen") {
      if (Math.hypot(xy[0] - lastXY[0], xy[1] - lastXY[1]) < PEN_STEP_PX) return;
      lastXY = xy;
      points.push(geo(xy));
    } else {
      lastXY = xy;
      points = [points[0], geo(xy)];
    }
    if (tool !== "text") setDrawDraft({ kind: tool, points: [...points], ...pen() });
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    try {
      container.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setDrawDraft(null);
    if (tool === "eraser" || tool === "text") return;
    const travelled = Math.hypot(lastXY[0] - startXY[0], lastXY[1] - startXY[1]);
    if (tool === "pen") {
      // A click with the pen leaves a dot: a stroke of two nearly equal points.
      if (points.length === 1) {
        const [x, y] = startXY;
        points.push(geo([x + 0.5, y + 0.5]));
      }
      useDrawStore.getState().add({ kind: "pen", points, ...pen() });
    } else if (travelled >= MIN_DRAG_PX) {
      useDrawStore.getState().add({ kind: tool, points: [points[0], geo(lastXY)], ...pen() });
    }
    points = [];
  };

  // Keep the map's own mouse and touch handling out of it while drawing: no
  // pan, no click through to alerts or radar sites. The wheel is left alone,
  // so zooming in to draw finer still works.
  const block = (e: Event) => {
    e.stopPropagation();
  };
  const blocked = ["mousedown", "mouseup", "click", "dblclick", "touchstart", "touchmove", "touchend"];

  container.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  for (const type of blocked) container.addEventListener(type, block, true);
  const previousCursor = map.getCanvas().style.cursor;
  map.getCanvas().style.cursor = tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair";
  container.style.touchAction = "none";

  return () => {
    container.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    for (const type of blocked) container.removeEventListener(type, block, true);
    map.getCanvas().style.cursor = previousCursor;
    container.style.touchAction = "";
    setDrawDraft(null);
  };
}

function TextInput({ draft, onDone }: { draft: TextDraft; onDone: () => void }) {
  const [value, setValue] = useState("");
  const color = useDrawStore((s) => s.color);
  const width = useDrawStore((s) => s.width);
  const ref = useRef<HTMLInputElement | null>(null);
  // What is typed, and whether it has been placed yet. Clicking somewhere else
  // on the map starts a new label without a blur ever reaching this one, so the
  // text left in it is placed when it goes away.
  const typed = useRef("");
  const placed = useRef(false);

  const place = () => {
    if (placed.current) return;
    placed.current = true;
    const text = typed.current.trim();
    if (!text) return;
    const s = useDrawStore.getState();
    s.add({ kind: "text", points: [draft.at], text, color: s.color, width: s.width, dashed: false, fill: false });
  };

  useEffect(() => {
    // Re-armed on every mount: React's development double-mount runs the
    // cleanup once straight away, which would otherwise mark it placed.
    placed.current = false;
    ref.current?.focus();
    return place;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = () => {
    place();
    onDone();
  };

  return (
    <input
      ref={ref}
      className="drawtext"
      style={{ left: draft.x, top: draft.y, color, fontSize: Math.round(12 + width * 1.2) }}
      value={value}
      placeholder="Type, then Enter"
      onChange={(e) => {
        typed.current = e.target.value;
        setValue(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          placed.current = true;
          onDone();
        }
      }}
    />
  );
}

function DrawBar() {
  const tool = useDrawStore((s) => s.tool);
  const color = useDrawStore((s) => s.color);
  const width = useDrawStore((s) => s.width);
  const dashed = useDrawStore((s) => s.dashed);
  const fill = useDrawStore((s) => s.fill);
  const locked = useDrawStore((s) => s.locked);
  const count = useDrawStore((s) => s.shapes.length);
  const canUndo = useDrawStore((s) => s.past.length > 0);
  const canRedo = useDrawStore((s) => s.future.length > 0);
  const st = useDrawStore.getState();
  const [pop, setPop] = useState<Popover>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const drag = useDragOffset("drawbar");
  const current = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];

  // A popover closes on a click anywhere else.
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pop && !confirmClear) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        setPop(null);
        setConfirmClear(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [pop, confirmClear]);

  const toggle = (p: Popover) => setPop((cur) => (cur === p ? null : p));

  return (
    <div className="drawbar-anchor">
      <div
        className="drawbar"
        ref={(el) => {
          drag.ref.current = el;
          root.current = el;
        }}
        style={drag.style}
        role="toolbar"
        aria-label="Draw on the map"
      >
        <button type="button" className="drawbar__grip" {...drag.handle} title="Drag to move" aria-label="Move toolbar">
          <GripVertical size={14} />
        </button>

        <div className="drawbar__slot">
          <button
            type="button"
            className={`drawbar__btn drawbar__btn--pick${pop === "tool" ? " is-open" : ""}`}
            onClick={() => toggle("tool")}
            title={`${current.label} (${current.key})`}
            aria-haspopup="menu"
            aria-expanded={pop === "tool"}
          >
            {current.icon}
            <ChevronDown size={12} />
          </button>
          {pop === "tool" && (
            <div className="drawbar__pop" role="menu">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.id === tool}
                  className={`drawbar__item${t.id === tool ? " is-on" : ""}`}
                  onClick={() => {
                    st.setTool(t.id);
                    setPop(null);
                  }}
                >
                  {t.icon}
                  <span>{t.label}</span>
                  <kbd>{t.key}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="drawbar__slot">
          <button
            type="button"
            className={`drawbar__btn drawbar__swatchbtn${pop === "color" ? " is-open" : ""}`}
            onClick={() => toggle("color")}
            title="Colour"
            aria-label="Colour"
            aria-expanded={pop === "color"}
          >
            <span className="drawbar__swatch" style={{ background: color }} />
          </button>
          {pop === "color" && (
            <div className="drawbar__pop drawbar__pop--colors">
              <div className="drawbar__colors">
                {DRAW_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`drawbar__color${c === color ? " is-on" : ""}`}
                    style={{ background: c }}
                    onClick={() => {
                      st.setColor(c);
                      setPop(null);
                    }}
                    aria-label={c}
                  >
                    {c === color && <Check size={12} />}
                  </button>
                ))}
              </div>
              <label className="drawbar__custom">
                <span>Custom</span>
                <input type="color" value={color} onChange={(e) => st.setColor(e.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className="drawbar__slot">
          <button
            type="button"
            className={`drawbar__btn drawbar__btn--pick${pop === "width" ? " is-open" : ""}`}
            onClick={() => toggle("width")}
            title={tool === "text" ? "Text size" : "Line width"}
            aria-expanded={pop === "width"}
          >
            <PenLine size={14} />
            <span className="drawbar__num">{width}</span>
            <ChevronDown size={12} />
          </button>
          {pop === "width" && (
            <div className="drawbar__pop">
              {DRAW_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`drawbar__item${w === width ? " is-on" : ""}`}
                  onClick={() => {
                    st.setWidth(w);
                    setPop(null);
                  }}
                >
                  <span className="drawbar__weight">
                    <i style={{ height: Math.max(1, Math.min(w, 14)), background: color }} />
                  </span>
                  <span>{w} px</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`drawbar__btn${dashed ? " is-on" : ""}`}
          onClick={() => st.setDashed(!dashed)}
          title="Dashed line"
          aria-pressed={dashed}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M1 8h3M6.5 8h3M12 8h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`drawbar__btn${fill ? " is-on" : ""}`}
          onClick={() => st.setFill(!fill)}
          title="Fill circles and rectangles"
          aria-pressed={fill}
          disabled={tool !== "circle" && tool !== "rect"}
        >
          <PaintBucket size={15} />
        </button>

        <span className="drawbar__sep" />

        <button type="button" className="drawbar__btn" onClick={st.undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Undo2 size={15} />
        </button>
        <button type="button" className="drawbar__btn" onClick={st.redo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">
          <Redo2 size={15} />
        </button>

        <span className="drawbar__sep" />

        <button
          type="button"
          className={`drawbar__btn${locked ? " is-on" : ""}`}
          onClick={() => st.setLocked(!locked)}
          title={locked ? "Map locked: dragging draws. Click to move the map." : "Map moves: click to draw again."}
          aria-pressed={locked}
        >
          {locked ? <Lock size={15} /> : <Unlock size={15} />}
        </button>

        <div className="drawbar__slot">
          <button
            type="button"
            className="drawbar__btn drawbar__btn--danger"
            onClick={() => setConfirmClear((v) => !v)}
            disabled={count === 0}
            title="Clear all drawings"
            aria-label="Clear all drawings"
          >
            <Trash2 size={15} />
          </button>
          {confirmClear && (
            <div className="drawbar__pop drawbar__pop--confirm">
              <span>
                Clear {count} drawing{count === 1 ? "" : "s"}?
              </span>
              <button
                type="button"
                className="drawbar__confirm"
                onClick={() => {
                  st.clear();
                  setConfirmClear(false);
                }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        <button type="button" className="drawbar__btn" onClick={() => st.setActive(false)} title="Close (Esc)" aria-label="Close">
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
