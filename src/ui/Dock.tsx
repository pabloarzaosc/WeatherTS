import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Columns2,
  Compass,
  Crosshair,
  Download,
  Globe,
  Globe2,
  Grid2x2,
  Grid3x3,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  LogIn,
  Map as MapIcon,
  Maximize,
  PenLine,
  Ruler,
  Settings,
  Square,
  Video,
} from "lucide-react";

import { useAppStore, type DataView } from "../store/useAppStore";
import { selectRailOpen, useAlertStore } from "../store/useAlertStore";
import { useGifStore } from "../store/useGifStore";
import { useDrawStore } from "../store/useDrawStore";
import { useAccountGate } from "../store/useAccountGate";
import { useAuthStore } from "../store/useAuthStore";
import { getMap } from "../map/mapInstance";
import { INITIAL_VIEW } from "../map/mapStyle";
import { flyToMyLocation } from "../lib/geolocate";
import { toggleFullscreen } from "../lib/fullscreen";
import { downloadBlob } from "../lib/gifExport";
import { BrandMark } from "./BrandMark";
import { OutlookTopButton } from "./OutlookControls";
import { AccountPanel } from "./auth/AccountPanel";

/**
 * The tool dock: one strip on the edge of the screen instead of a bar across
 * the top and a row of tabs under it.
 *
 * Fifteen tools in a horizontal row read as a toolbar you have to scan. Down
 * one edge they read as a place: the drawers you open live together at the
 * top, the things you do to the map sit in the middle, and the things about
 * you and your output settle at the bottom, where the eye goes last. The
 * drawers slide out of the dock itself, so where a panel came from is never a
 * question.
 *
 * Icon-only is only intuitive if every icon says its name the moment you
 * point at it, so each button carries a label that appears beside it on hover
 * and focus -- not a native title that takes a second to show and looks like
 * an error message when it does.
 */

type Fly = "view" | "map" | "export" | null;

/** Save the focused pane's current view as a PNG. */
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
          downloadBlob(
            blob,
            `radar_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`,
          );
        }
      }, "image/png"),
    ),
  );
}

const EDGE = 8;

/** Pull a menu that opened past the bottom (or top) of the window back inside
 *  it. A menu taller than the whole window scrolls instead. */
function keepInView(el: HTMLElement) {
  el.style.removeProperty("translate");
  el.style.removeProperty("max-height");
  el.style.removeProperty("overflow-y");
  const room = window.innerHeight - EDGE * 2;
  if (el.getBoundingClientRect().height > room) {
    el.style.setProperty("max-height", `${room}px`);
    el.style.setProperty("overflow-y", "auto");
  }
  const r = el.getBoundingClientRect();
  const shift =
    r.bottom > window.innerHeight - EDGE ? window.innerHeight - EDGE - r.bottom : r.top < EDGE ? EDGE - r.top : 0;
  if (shift) el.style.setProperty("translate", `0 ${Math.round(shift)}px`);
}

function DockButton({
  icon,
  label,
  onClick,
  on,
  expanded,
  badge,
  disabled,
  quiet,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  /** A toggle that is currently on (measure, the alert rail, split view). */
  on?: boolean;
  /** The drawer or flyout this button opened is showing. */
  expanded?: boolean;
  badge?: number;
  disabled?: boolean;
  /** Suppress the hover label -- while this button's own flyout is open, the
   *  label would sit on top of it. */
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      className={`dock__btn${on ? " is-on" : ""}${expanded ? " is-open" : ""}`}
      data-label={quiet ? undefined : label}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      aria-expanded={expanded === undefined ? undefined : expanded}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      {badge != null && badge > 0 && <span className="dock__badge">{badge > 99 ? "99+" : badge}</span>}
    </button>
  );
}

function FlyItem({
  icon,
  label,
  onClick,
  on,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  on?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className={`dock__fly-item${on ? " is-on" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Who is signed in, and the way into their account -- the last thing in the
 *  dock, because it is the one control about the person rather than the map.
 *  Without an account it is the way in instead, and says so in words: an icon
 *  alone would not tell anyone that signing in is there, or that it is optional. */
function AccountButton() {
  const status = useAuthStore((s) => s.status);
  const profile = useAuthStore((s) => s.profile);
  const openAuth = useAccountGate((s) => s.openAuth);
  const [open, setOpen] = useState(false);

  if (status === "signedOut") {
    return (
      <button
        type="button"
        className="dock__btn dock__signin"
        data-label="Sign in or create an account"
        aria-label="Sign in or create an account"
        onClick={() => openAuth("signin")}
      >
        <LogIn size={16} />
        <span>Sign in</span>
      </button>
    );
  }
  const label = profile?.displayName || profile?.username || "Account";
  const initial = (profile?.displayName || profile?.username || "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <button
        type="button"
        className="dock__btn dock__acct"
        data-label={label}
        aria-label={`Account — ${label}`}
        onClick={() => setOpen(true)}
      >
        {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <span>{initial}</span>}
      </button>
      {open && <AccountPanel onClose={() => setOpen(false)} />}
    </>
  );
}

const PANES = [
  [1, Square, "Single"],
  [2, Columns2, "Two"],
  [4, Grid2x2, "Four"],
  [6, Grid3x3, "Six"],
] as const;

export function Dock() {
  const leftPanelOpen = useAppStore((s) => s.leftPanelOpen);
  const dataView = useAppStore((s) => s.dataView);
  const setDataView = useAppStore((s) => s.setDataView);
  const toggleLeftPanel = useAppStore((s) => s.toggleLeftPanel);
  const projection = useAppStore((s) => s.projection);
  const toggleProjection = useAppStore((s) => s.toggleProjection);
  const measureMode = useAppStore((s) => s.measureMode);
  const drawActive = useDrawStore((s) => s.active);
  const setMeasureMode = useAppStore((s) => s.setMeasureMode);
  const paneCount = useAppStore((s) => s.paneCount);
  const setPaneCount = useAppStore((s) => s.setPaneCount);
  const openAnim = useGifStore((s) => s.setOpen);

  const alertsActive = useAlertStore((s) => s.active);
  const railOpen = useAlertStore(selectRailOpen);
  const alertCount = useAlertStore((s) => s.features.length);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const selectAlert = useAlertStore((s) => s.select);

  const [fly, setFly] = useState<Fly>(null);
  const root = useRef<HTMLElement | null>(null);

  // A flyout is a moment, not a mode: it goes on any click outside the dock
  // and on Escape, the way every menu the user has ever used behaves.
  useEffect(() => {
    if (!fly) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setFly(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFly(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [fly]);

  // Menus open level with the button that asked for them, which on a short
  // window runs Map tools and the outlook picker off the bottom. Watched rather
  // than measured at open, because the outlook menu belongs to its own
  // component and opens without the dock hearing about it. Only added and
  // removed nodes are observed, so the styles set here never re-trigger it.
  useEffect(() => {
    const dock = root.current;
    if (!dock) return;
    const fit = () => dock.querySelectorAll<HTMLElement>(".dock__fly, .outlook-menu").forEach(keepInView);
    const watch = new MutationObserver(fit);
    watch.observe(dock, { childList: true, subtree: true });
    window.addEventListener("resize", fit);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  // Pressing the button for the drawer that is already out puts it away. The
  // same button opens and closes it; there is no separate close to hunt for.
  const drawer = (id: DataView) => {
    setFly(null);
    if (leftPanelOpen && dataView === id) toggleLeftPanel();
    else setDataView(id);
  };
  const flyout = (id: Exclude<Fly, null>) => setFly((f) => (f === id ? null : id));
  const done = (fn: () => void) => () => {
    fn();
    setFly(null);
  };

  const resetView = () =>
    getMap()?.flyTo({ center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom, bearing: 0, pitch: 0, essential: true });
  const fitWorld = () =>
    getMap()?.fitBounds(
      [
        [-179, -60],
        [179, 80],
      ],
      { padding: 28 },
    );

  return (
    <nav className="dock" ref={root} aria-label="Tools">
      <button
        type="button"
        className="dock__btn dock__brand"
        data-label="Go to my location"
        aria-label="Go to my location"
        onClick={() => void flyToMyLocation().catch(() => {})}
      >
        <BrandMark size={20} />
      </button>

      <span className="dock__sep" />

      <DockButton
        icon={<LayoutGrid size={18} />}
        label="Catalog"
        expanded={leftPanelOpen && dataView === "catalog"}
        onClick={() => drawer("catalog")}
      />
      <DockButton
        icon={<Layers size={18} />}
        label="Layers"
        expanded={leftPanelOpen && dataView === "layers"}
        onClick={() => drawer("layers")}
      />
      <DockButton
        icon={<AlertTriangle size={18} />}
        label={alertsActive ? (railOpen ? "Hide alerts" : "Alerts") : "Alerts layer is off"}
        on={railOpen}
        disabled={!alertsActive}
        badge={alertsActive && !railOpen ? alertCount : undefined}
        onClick={() => {
          setFly(null);
          if (railOpen) {
            // Closing has to clear the selection too, or a detail left open
            // would immediately re-open the rail.
            selectAlert(null);
            setListOpen(false);
          } else {
            setListOpen(true);
          }
        }}
      />

      <span className="dock__sep" />

      <div className="dock__outlook">
        <OutlookTopButton />
      </div>
      <DockButton
        icon={<Ruler size={18} />}
        label="Measure"
        on={measureMode !== "off"}
        onClick={() => {
          setFly(null);
          if (measureMode === "off") useDrawStore.getState().setActive(false);
          setMeasureMode(measureMode === "off" ? "distance" : "off");
        }}
      />
      <DockButton
        icon={<PenLine size={18} />}
        label="Draw"
        on={drawActive}
        onClick={() => {
          setFly(null);
          useDrawStore.getState().setActive(!drawActive);
        }}
      />

      <div className="dock__slot">
        <DockButton
          icon={<Columns2 size={18} />}
          label="Split view"
          on={paneCount > 1}
          expanded={fly === "view"}
          quiet={fly === "view"}
          onClick={() => flyout("view")}
        />
        {fly === "view" && (
          <div className="dock__fly" role="menu" aria-label="Split view">
            <span className="dock__fly-title">Split view</span>
            <div className="dock__fly-row">
              {PANES.map(([n, Icon, name]) => (
                <button
                  key={n}
                  type="button"
                  role="menuitemradio"
                  aria-checked={paneCount === n}
                  className={`dock__pane${paneCount === n ? " is-on" : ""}`}
                  onClick={done(() => setPaneCount(n))}
                >
                  <Icon size={16} />
                  <span>{name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="dock__slot">
        <DockButton
          icon={<MapIcon size={18} />}
          label="Map tools"
          expanded={fly === "map"}
          quiet={fly === "map"}
          onClick={() => flyout("map")}
        />
        {fly === "map" && (
          <div className="dock__fly" role="menu" aria-label="Map tools">
            <span className="dock__fly-title">Map tools</span>
            <FlyItem icon={<Crosshair size={15} />} label="Reset view" onClick={done(resetView)} />
            <FlyItem icon={<Globe size={15} />} label="Fit the world" onClick={done(fitWorld)} />
            <FlyItem
              icon={<Compass size={15} />}
              label="Point north"
              onClick={done(() => getMap()?.easeTo({ bearing: 0 }))}
            />
            <FlyItem
              icon={<Globe2 size={15} />}
              label={projection === "globe" ? "Globe (on)" : "Globe"}
              on={projection === "globe"}
              onClick={done(toggleProjection)}
            />
            <FlyItem icon={<Maximize size={15} />} label="Fullscreen" onClick={done(() => void toggleFullscreen())} />
          </div>
        )}
      </div>

      <span className="dock__spacer" />

      <div className="dock__slot">
        <DockButton
          icon={<Download size={18} />}
          label="Export"
          expanded={fly === "export"}
          quiet={fly === "export"}
          onClick={() => flyout("export")}
        />
        {fly === "export" && (
          <div className="dock__fly dock__fly--up" role="menu" aria-label="Export">
            <span className="dock__fly-title">Export</span>
            <FlyItem icon={<ImageIcon size={15} />} label="Save view as PNG" onClick={done(saveViewPng)} />
            <FlyItem icon={<Video size={15} />} label="Animation (GIF / MP4)" onClick={done(() => openAnim(true))} />
          </div>
        )}
      </div>
      <DockButton
        icon={<Settings size={18} />}
        label="Settings"
        expanded={leftPanelOpen && dataView === "settings"}
        onClick={() => drawer("settings")}
      />
      <AccountButton />
    </nav>
  );
}
