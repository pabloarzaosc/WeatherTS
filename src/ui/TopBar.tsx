import type { ReactNode } from "react";
import { AlertTriangle, Compass, Crosshair, Download, Globe, Globe2, Maximize, Minus, PanelLeft, PenLine, Plus, Ruler, Video } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import { selectRailOpen, useAlertStore } from "../store/useAlertStore";
import { useGifStore } from "../store/useGifStore";
import { getMap } from "../map/mapInstance";
import { INITIAL_VIEW } from "../map/mapStyle";
import { flyToMyLocation } from "../lib/geolocate";
import { toggleFullscreen } from "../lib/fullscreen";
import { downloadBlob } from "../lib/gifExport";
import { BrandMark } from "./BrandMark";
import { SearchBar } from "./SearchBar";
import { OutlookTopButton } from "./OutlookControls";

/** Save the focused pane's current view as a PNG (the top bar's download icon). */
function saveViewPng() {
  const map = getMap();
  if (!map) return;
  // Force a fresh paint, then read the buffer two frames later (same rule the
  // animation exporter uses: WebGL needs the paint to land before readback).
  map.triggerRepaint();
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      map.getCanvas().toBlob((blob) => {
        if (blob) {
          const p = (n: number) => String(n).padStart(2, "0");
          const d = new Date();
          downloadBlob(blob, `radar_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`);
        }
      }, "image/png"),
    ),
  );
}

// Quick layer toggles (text chips, like a pro workstation's LSR/RAOB labels).
const QUICK: { id: string; label: string }[] = [
  { id: "boundaries", label: "BORDERS" },
  { id: "graticule", label: "GRID" },
  { id: "terminator", label: "DAY/NIGHT" },
  { id: "raob", label: "RAOB" },
  { id: "acars", label: "ACARS" },
  { id: "lsr", label: "LSR" },
  { id: "fronts", label: "FRONTS" },
];

function Tool({
  icon,
  label,
  onClick,
  active,
  disabled,
  desktopOnly,
  badge,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Dropped on phones, where the bar can't hold everything and touch/the map's
   *  own controls already cover it (pinch to zoom, drag to pan). */
  desktopOnly?: boolean;
  /** Small count chip in the corner (e.g. how many alerts are in force). */
  badge?: number;
}) {
  return (
    <button
      type="button"
      className={`tool${active ? " is-active" : ""}${desktopOnly ? " tool--desktop" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      disabled={disabled}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span className="tool__badge">{badge > 99 ? "99+" : badge}</span>
      )}
    </button>
  );
}

/** Opens/closes the docked alert rail, the way PanelLeft does the side panel. */
function AlertRailToggle() {
  const active = useAlertStore((s) => s.active);
  const open = useAlertStore(selectRailOpen);
  const count = useAlertStore((s) => s.features.length);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const select = useAlertStore((s) => s.select);

  return (
    <Tool
      icon={<AlertTriangle size={17} />}
      label={active ? (open ? "Hide alert rail" : "Show alert rail") : "Alerts layer is off"}
      active={open}
      disabled={!active}
      badge={active && !open ? count : undefined}
      onClick={() => {
        if (open) {
          // Closing has to clear the selection too, or a detail left open would
          // immediately re-open the rail.
          select(null);
          setListOpen(false);
        } else {
          setListOpen(true);
        }
      }}
    />
  );
}

export function TopBar() {
  const toggleLeftPanel = useAppStore((s) => s.toggleLeftPanel);
  const projection = useAppStore((s) => s.projection);
  const toggleProjection = useAppStore((s) => s.toggleProjection);
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const measureMode = useAppStore((s) => s.measureMode);
  const setMeasureMode = useAppStore((s) => s.setMeasureMode);
  const openAnim = useGifStore((s) => s.setOpen);

  const goLocation = () => void flyToMyLocation().catch(() => {});
  const resetView = () =>
    getMap()?.flyTo({
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      bearing: 0,
      pitch: 0,
      essential: true,
    });
  const fitWorld = () =>
    getMap()?.fitBounds(
      [
        [-179, -60],
        [179, 80],
      ],
      { padding: 28 },
    );

  return (
    <header className="topbar">
      <button
        type="button"
        className="tool tool--brand"
        onClick={goLocation}
        title="Go to my location"
      >
        <BrandMark size={20} />
      </button>
      <span className="tool__sep" />

      <Tool icon={<PanelLeft size={17} />} label="Data panel" onClick={toggleLeftPanel} />
      <Tool icon={<Crosshair size={17} />} label="Reset view" onClick={resetView} desktopOnly />
      <Tool icon={<Globe size={17} />} label="Fit world" onClick={fitWorld} desktopOnly />
      <Tool icon={<Plus size={17} />} label="Zoom in" onClick={() => getMap()?.zoomIn()} desktopOnly />
      <Tool icon={<Minus size={17} />} label="Zoom out" onClick={() => getMap()?.zoomOut()} desktopOnly />
      <Tool
        icon={<Compass size={17} />}
        label="Point north"
        onClick={() => getMap()?.easeTo({ bearing: 0 })}
        desktopOnly
      />
      <Tool
        icon={<Globe2 size={17} />}
        label={`Projection: ${projection}`}
        active={projection === "globe"}
        onClick={toggleProjection}
        desktopOnly
      />
      <Tool
        icon={<Ruler size={17} />}
        label="Measure (distance / diameter)"
        active={measureMode !== "off"}
        onClick={() => setMeasureMode(measureMode === "off" ? "distance" : "off")}
      />
      <AlertRailToggle />
      <Tool icon={<PenLine size={17} />} label="Draw (soon)" disabled desktopOnly />
      <Tool
        icon={<Maximize size={17} />}
        label="Fullscreen"
        onClick={() => void toggleFullscreen()}
        desktopOnly
      />
      <OutlookTopButton />

      <div className="topbar__quick">
        {QUICK.map((q) => (
          <button
            key={q.id}
            type="button"
            className={`qtoggle${layers[q.id]?.visible ? " is-on" : ""}`}
            onClick={() => toggleLayer(q.id)}
            title={`Toggle layer: ${q.label}`}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="topbar__right">
        <span className="tool__sep tool--desktop" />
        <Tool icon={<Download size={17} />} label="Save current view (PNG)" onClick={saveViewPng} />
        <Tool
          icon={<Video size={17} />}
          label="Export animation (GIF / MP4)"
          onClick={() => openAnim(true)}
        />
        <SearchBar />
      </div>
    </header>
  );
}
