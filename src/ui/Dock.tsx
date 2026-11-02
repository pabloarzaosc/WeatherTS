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
  LayoutPanelTop,
  Rows2,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  LogIn,
  Map as MapIcon,
  Maximize,
  PenLine,
  Radio,
  Ruler,
  Settings,
  Square,
  Video,
  Keyboard,
  PanelTopClose,
  Tv,
} from "lucide-react";
import { useFeatureStore } from "../store/useFeatureStore";
import { useShellStore } from "../store/useShellStore";

import { useAppStore, type DataView } from "../store/useAppStore";
import { selectRailOpen, useAlertStore } from "../store/useAlertStore";
import { useGifStore } from "../store/useGifStore";
import { useNowStore } from "../store/useNowStore";
import { useDrawStore } from "../store/useDrawStore";
import { usePaneStore } from "../store/usePaneStore";
import { setLayout } from "../lib/paneOps";
import { useAccountGate } from "../store/useAccountGate";
import { useAuthStore } from "../store/useAuthStore";
import { getMap } from "../map/mapInstance";
import { INITIAL_VIEW } from "../map/mapStyle";
import { flyToMyLocation } from "../lib/geolocate";
import { toggleFullscreen } from "../lib/fullscreen";
import { openExport } from "../store/useExportStore";
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
  badgeTone,
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
  /** "alert": the badge in red, for the most serious items (Now). */
  badgeTone?: "alert";
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
      {badge != null && badge > 0 && (
        <span className={`dock__badge${badgeTone === "alert" ? " dock__badge--alert" : ""}`}>{badge > 99 ? "99+" : badge}</span>
      )}
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

// Layouts: count, stacked (two panes one above the other), icon, name.
// "Three" is two over one: the panel-top icon turned upside down.
const PANES = [
  [1, false, Square, "Single", ""],
  [2, false, Columns2, "Two", ""],
  [2, true, Rows2, "Stacked", ""],
  [3, false, LayoutPanelTop, "Three", "dock__pane-icon--flip"],
  [4, false, Grid2x2, "Four", ""],
  [6, false, Grid3x3, "Six", ""],
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
  const stacked = usePaneStore((s) => s.stacked);
  const openAnim = useGifStore((s) => s.setOpen);

  const alertsActive = useAlertStore((s) => s.active);
  const railOpen = useAlertStore(selectRailOpen);
  const alertCount = useAlertStore((s) => s.features.length);
  const nowBadge = useNowStore((s) => s.badge);
  // The Now panel's warnings are polled from here: the badge needs them with
  // the panel closed.
  useEffect(() => useNowStore.getState().start(), []);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const selectAlert = useAlertStore((s) => s.select);

  const [fly, setFly] = useState<Fly>(null);
  const root = useRef<HTMLElement | null>(null);
  // Settings > Features (ux-shell): a feature switched off loses its button.
  const featuresOff = useFeatureStore((s) => s.off);
  const feat = (id: string) => !featuresOff.includes(id);

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
      {feat("now") && (
      <DockButton
        icon={<Radio size={18} />}
        label={nowBadge > 0 ? `Now · ${nowBadge} serious` : "Now"}
        expanded={leftPanelOpen && dataView === "now"}
        badge={nowBadge}
        badgeTone="alert"
        onClick={() => drawer("now")}
      />
      )}
      {feat("alerts") && (
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
      )}

      <span className="dock__sep" />

      {feat("outlooks") && (
      <div className="dock__outlook">
        <OutlookTopButton />
      </div>
      )}
      {feat("measure") && (
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
      )}
      {feat("draw") && (
      <DockButton
        icon={<PenLine size={18} />}
        label="Draw"
        on={drawActive}
        onClick={() => {
          setFly(null);
          useDrawStore.getState().setActive(!drawActive);
        }}
      />
      )}

      {feat("multiPane") && (
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
              {PANES.map(([n, stack, Icon, name, iconCls]) => {
                const on = paneCount === n && (n !== 2 || stacked === stack);
                return (
                <button
                  key={name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className={`dock__pane${on ? " is-on" : ""}`}
                  onClick={done(() => setLayout(n, stack))}
                >
                  <Icon size={16} className={iconCls || undefined} />
                  <span>{name}</span>
                </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}

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
            {/* ux-shell: the map without the app around it */}
            <FlyItem icon={<PanelTopClose size={15} />} label="Minimal UI (Ctrl+\)" onClick={done(() => useShellStore.getState().setMode("minimal"))} />
            {feat("broadcast") && (
              <FlyItem icon={<Tv size={15} />} label="Broadcast mode" onClick={done(() => useShellStore.getState().setMode("broadcast"))} />
            )}
            <FlyItem icon={<Keyboard size={15} />} label="Keyboard shortcuts (?)" onClick={done(() => useShellStore.getState().setShortcutsOpen(true))} />
          </div>
        )}
      </div>

      <span className="dock__spacer" />

      {feat("export") && (
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
            <FlyItem icon={<ImageIcon size={15} />} label="Image, GIF or video…" onClick={done(() => openExport(null, true))} />
            <FlyItem icon={<Video size={15} />} label="Custom animation (GIF / MP4)" onClick={done(() => openAnim(true))} />
          </div>
        )}
      </div>
      )}
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
