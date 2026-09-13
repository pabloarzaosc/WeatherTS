import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Maximize2,
  Minimize2,
  Scan,
  Square,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Select } from "../Select";

import { useSoundingViewerStore } from "../../store/useSoundingViewerStore";

// Mirrors backend/sounding_core.py MODELS (used only when the backend is offline).
const FALLBACK_MODELS = [
  { id: "auto", label: "Auto / Best", group: "Recommended" },
  // Global
  { id: "gfs", label: "GFS (NOAA)", group: "Global" },
  { id: "ecmwf", label: "ECMWF IFS", group: "Global" },
  { id: "ecmwf_aifs", label: "ECMWF AIFS (AI)", group: "Global" },
  { id: "icon", label: "ICON (DWD)", group: "Global" },
  { id: "gem", label: "GEM (Canada)", group: "Global" },
  { id: "ukmo", label: "UKMO (Met Office)", group: "Global" },
  { id: "arpege", label: "ARPEGE (Météo-France)", group: "Global" },
  { id: "jma", label: "JMA GSM (Japan)", group: "Global" },
  { id: "cma", label: "CMA GRAPES (China)", group: "Global" },
  // United States
  { id: "hrrr", label: "HRRR (3 km)", group: "United States" },
  // Europe
  { id: "icon_eu", label: "ICON-EU (7 km)", group: "Europe" },
  { id: "icon_d2", label: "ICON-D2 (2 km)", group: "Europe" },
  { id: "arpege_eu", label: "ARPEGE-EU (11 km)", group: "Europe" },
  { id: "arome_fr", label: "AROME France (1.3 km)", group: "Europe" },
  { id: "ukmo_uk", label: "UKMO UK (2 km)", group: "Europe" },
  { id: "knmi", label: "HARMONIE KNMI (NL)", group: "Europe" },
  { id: "dmi", label: "HARMONIE DMI (DK)", group: "Europe" },
  { id: "icon_2i", label: "ICON-2I (Italy)", group: "Europe" },
  // North America
  { id: "gem_regional", label: "GEM Regional (10 km)", group: "North America" },
  { id: "hrdps", label: "HRDPS (2.5 km)", group: "North America" },
  // Asia-Pacific
  { id: "jma_msm", label: "JMA MSM (5 km)", group: "Asia-Pacific" },
];

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Skew-T zoom. The plot is a PNG, so we zoom/pan it with a CSS transform on the
// <img>; the frame already clips overflow. 1x = fit-to-frame, 8x = deep inspect.
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.4; // per button click / wheel notch
const ZOOM_RESET = { zoom: 1, x: 0, y: 0 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function fmtValid(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}Z`;
}

// Compact obs-time chip for the RAOB stepper, e.g. "12·00Z".
function fmtObsShort(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${d.getUTCDate()}·${hh}Z`;
}

export function SoundingViewer() {
  const open = useSoundingViewerStore((s) => s.open);
  const lat = useSoundingViewerStore((s) => s.lat);
  const lon = useSoundingViewerStore((s) => s.lon);
  const model = useSoundingViewerStore((s) => s.model);
  const mode = useSoundingViewerStore((s) => s.mode);
  const station = useSoundingViewerStore((s) => s.station);
  const airport = useSoundingViewerStore((s) => s.airport);
  const setAreaSelecting = useSoundingViewerStore((s) => s.setAreaSelecting);
  const hour = useSoundingViewerStore((s) => s.hour);
  const models = useSoundingViewerStore((s) => s.models);
  const data = useSoundingViewerStore((s) => s.data);
  const loading = useSoundingViewerStore((s) => s.loading);
  const busy = useSoundingViewerStore((s) => s.busy);
  const error = useSoundingViewerStore((s) => s.error);
  const close = useSoundingViewerStore((s) => s.close);
  const setModel = useSoundingViewerStore((s) => s.setModel);
  const stepHour = useSoundingViewerStore((s) => s.stepHour);
  const loadModels = useSoundingViewerStore((s) => s.loadModels);

  const pendingHour = useSoundingViewerStore((s) => s.pendingHour);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState(ZOOM_RESET);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // Zoom by `factor` around a point (mx,my) given relative to the frame centre.
  // Buttons pass (0,0) to zoom around the centre; the wheel passes the cursor so
  // the spot under the pointer stays put. Snapping back to 1x recentres the plot.
  const zoomAt = useCallback((factor: number, mx = 0, my = 0) => {
    setView((v) => {
      const nz = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
      if (nz <= ZOOM_MIN) return ZOOM_RESET;
      const cx = (mx - v.x) / v.zoom;
      const cy = (my - v.y) / v.zoom;
      return { zoom: nz, x: mx - cx * nz, y: my - cy * nz };
    });
  }, []);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setView(ZOOM_RESET);
    }
  }, [open]);

  // A new point or model reloads the plot from scratch, so drop any stale zoom.
  useEffect(() => {
    setView(ZOOM_RESET);
  }, [lat, lon, model]);

  // Wheel-to-zoom, centred on the cursor. Bound natively (not via React's onWheel)
  // so we can preventDefault the page scroll -- React attaches wheel as passive.
  const hasImage = !loading && !error && !!data?.image;
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !hasImage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - (r.left + r.width / 2);
      const my = e.clientY - (r.top + r.height / 2);
      zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, mx, my);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasImage, zoomAt]);

  useEffect(() => {
    if (!open) return;
    // Arrow-key scrubbing is owned by the global MapTimeline; the viewer only
    // handles Escape so the two don't double-step.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (view.zoom <= ZOOM_MIN) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: view.x, py: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) }));
  };
  const endPan = () => {
    dragRef.current = null;
  };

  if (!open) return null;

  const modelList = models.length ? models : FALLBACK_MODELS;
  const modelGroups = Array.from(new Set(modelList.map((item) => item.group)));
  const nTimes = data?.meta.nTimes ?? 1;
  const maxHour = Math.max(data?.meta.forecastMaxHour ?? nTimes - 1, 0);
  const validUnix = data?.meta.validUnix ?? null;
  const selectedUnix = data?.meta.times?.[hour] ?? validUnix;
  const coord = lat !== null && lon !== null ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : "";
  const isRaob = mode === "raob";
  const isArea = mode === "area";
  const isAcars = mode === "acars";
  const usedModel =
    data?.meta.modelLabel ??
    (isRaob
      ? `${station?.name ?? "RAOB"} (RAOB)`
      : isAcars
        ? `${airport ?? "ACARS"} aircraft sounding`
        : modelList.find((item) => item.id === model)?.label ?? model.toUpperCase());
  const imageSrc = data?.image ? `data:image/png;base64,${data.image}` : null;
  const area = data?.meta.area;

  return (
    <div className={`sv${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="Sounding viewer">
      <header className="sv__head">
        <div className="sv__title">
          <Activity size={16} />
          <div>
            <strong>{usedModel}{isRaob || isAcars ? "" : " Sounding"}</strong>
            <span>
              {coord}
              {area ? ` / ${area.widthKm}x${area.heightKm} km mean of ${area.used} pts` : ""}
              {isAcars && data?.meta.ascending != null
                ? ` / ${data.meta.ascending ? "ascent" : "descent"}`
                : ""}
              {/* Guarded: a mode whose meta omits elevation used to take the
                  whole app down with it -- a red error screen instead of a
                  sounding, from one missing number in a subtitle. */}
              {data?.meta.elevation != null ? ` / ${data.meta.elevation.toFixed(0)} m` : ""}
              {data ? ` / ${data.meta.source}` : ""}
            </span>
          </div>
        </div>
        <div className="sv__brand">SHARPpy SPCWidget</div>
        <div className="sv__headbtns">
          <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={close} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="sv__controls">
        {isRaob ? (
          <div className="sv__ctl">
            <span>STATION</span>
            <div className="sv__valid" title={station?.name}>{station?.name ?? "RAOB"}</div>
          </div>
        ) : isAcars ? (
          <div className="sv__ctl">
            <span>AIRPORT</span>
            <div className="sv__valid">{airport ?? "--"}</div>
          </div>
        ) : (
          <label className="sv__ctl">
            <span>MODEL</span>
            <Select
              value={model}
              onChange={setModel}
              aria-label="Model"
              options={modelGroups.flatMap((group) =>
                modelList
                  .filter((item) => item.group === group)
                  .map((item) => ({ value: item.id, label: item.label, group })),
              )}
            />
          </label>
        )}
        {isArea && (
          <div className="sv__ctl">
            <span>AREA</span>
            <button
              type="button"
              className="sv__redraw"
              onClick={() => setAreaSelecting(true)}
              title="Draw a new box on the map"
            >
              <Square size={13} /> Redraw box
            </button>
          </div>
        )}
        <div className="sv__ctl">
          <span>VALID</span>
          <div className="sv__valid">{fmtValid(selectedUnix)}</div>
        </div>
        <div className="sv__ctl sv__ctl--fcst">
          <span>{isRaob ? "OBS TIME" : isAcars ? "ASCENT" : "FORECAST"}</span>
          <div className="sv__stepper">
            {/* Two at a time as well as one: consecutive ascents from the same
                airport are often minutes apart and near-identical, so the jump
                that actually shows a change is the one two back. */}
            <button
              type="button"
              onClick={() => stepHour(-2)}
              disabled={hour <= 0}
              title="Back 2"
              aria-label="Back 2 frames"
            >
              <ChevronsLeft size={16} />
            </button>
            <button type="button" onClick={() => stepHour(-1)} disabled={hour <= 0} title="Previous (Left arrow)">
              <ChevronLeft size={16} />
            </button>
            <b>
              {isRaob || isAcars ? fmtObsShort(selectedUnix) : `F${String(hour).padStart(3, "0")}`}
            </b>
            <button type="button" onClick={() => stepHour(1)} disabled={hour >= maxHour} title="Next (Right arrow)">
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={() => stepHour(2)}
              disabled={hour >= maxHour}
              title="Forward 2"
              aria-label="Forward 2 frames"
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
        {data?.meta.fallbackReason && <div className="sv__notice">{data.meta.fallbackReason}</div>}
        {busy && !loading && <Loader2 size={15} className="sv__busy spin" />}
      </div>

      <div className="sv__body">
        {loading && (
          <div className="sv__state">
            <Loader2 size={26} className="spin" />
            <span>Rendering SHARPpy sounding...</span>
          </div>
        )}
        {!loading && error && (
          <div className="sv__state sv__state--err">
            <AlertTriangle size={22} />
            <span>{error}</span>
            {!isRaob && <small>The local sounding service is not responding. Please restart WeatherTS and try again.</small>}
          </div>
        )}
        {!loading && !error && data && imageSrc && (
          <div
            className="sv__sharppy-frame"
            ref={frameRef}
            data-zoomed={view.zoom > 1 ? "" : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerLeave={endPan}
            onDoubleClick={() => setView(ZOOM_RESET)}
          >
            <img
              className="sv__sharppy-img"
              src={imageSrc}
              alt={`${usedModel} SHARPpy sounding`}
              draggable={false}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                transition: dragRef.current ? "none" : "transform 0.08s ease-out",
              }}
            />
            <div className="sv__zoomctl" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
              <button type="button" onClick={() => zoomAt(ZOOM_STEP)} disabled={view.zoom >= ZOOM_MAX} title="Zoom in (scroll up)">
                <ZoomIn size={15} />
              </button>
              <button type="button" onClick={() => zoomAt(1 / ZOOM_STEP)} disabled={view.zoom <= ZOOM_MIN} title="Zoom out (scroll down)">
                <ZoomOut size={15} />
              </button>
              <button type="button" onClick={() => setView(ZOOM_RESET)} disabled={view.zoom <= ZOOM_MIN} title="Reset zoom (double-click)">
                <Scan size={15} />
              </button>
              {view.zoom > 1 && <span className="sv__zoomval">{view.zoom.toFixed(1)}&times;</span>}
            </div>
            {busy && (
              <div className="sv__rendering">
                <Loader2 size={16} className="spin" />
                <span>Rendering F{String(pendingHour ?? hour).padStart(3, "0")}</span>
              </div>
            )}
          </div>
        )}
        {!loading && !error && data && !imageSrc && (
          <div className="sv__state sv__state--err">
            <AlertTriangle size={22} />
            <span>SHARPpy could not render this sounding.</span>
            <small>{data.imageError || "No image was returned by the backend."}</small>
          </div>
        )}
      </div>
    </div>
  );
}
