import React from "react";
import ReactDOM from "react-dom/client";

import "maplibre-gl/dist/maplibre-gl.css";
// The whole UI speaks Recursive: one variable family whose MONO and CASL axes
// cover labels, headings and numbers. "full" is the file carrying every axis;
// the others ship weight only, and MONO would silently do nothing.
import "@fontsource-variable/recursive/full.css";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/sounding.css";
import "./styles/storms.css";
import "./styles/space.css";
import "./styles/tropical.css";
import "./styles/aviation.css";
import "./styles/auth.css";
import "./styles/radar3d.css";
import "./styles/radar3d-polish.css";
import "./styles/detections.css";
import "./styles/readout.css";
import "./styles/derived.css";
import "./styles/looplive.css";
import "./styles/frames.css";
import "./styles/archive-l2.css";
import "./styles/events-links.css";
import "./styles/alerts-core.css";
import "./styles/alerts-list.css";
import "./styles/now-local.css";
import "./styles/fixes-b.css";
import "./styles/display-opts.css";
import "./styles/panes.css";
import "./styles/panes-compare.css";
import "./styles/color-tables.css";
import "./styles/ux-shell.css";
import "./styles/export.css";
import "./styles/radar-sites.css";
import "./styles/tdwr.css";

// Side-effect import: every LayerModule registers itself here. The store and the
// catalog/layers panels are built from that registry, so a new phase only edits
// ./layers.
import "./layers";

import App from "./App";
import { LoginGate } from "./ui/LoginGate";
import { useAlertStore } from "./store/useAlertStore";
import { useAppStore } from "./store/useAppStore";
import { useAuthStore } from "./store/useAuthStore";
import { useChaserStore } from "./store/useChaserStore";
import { useMesoscaleStore } from "./store/useMesoscaleStore";
import { useSoundingViewerStore } from "./store/useSoundingViewerStore";
import { useSoundingViewStore } from "./store/useSoundingViewStore";
import { useAcarsStore } from "./store/useAcarsStore";
import { useNexradStore } from "./store/useNexradStore";
import { useVwpStore } from "./store/useVwpStore";
import { useSurfaceObsStore } from "./store/useSurfaceObsStore";
import { useThemeStore } from "./store/useThemeStore";
import { applyReduceMotion, applyTheme, resolveTheme, type ResolvedTheme } from "./lib/theme";
import { installRadarKeys } from "./lib/radarKeys";
import { installRadarDisplay } from "./lib/radarDisplayInstall";
import { installRadarSweep } from "./layers/radarSweep";
import { installPaneCompare } from "./lib/paneCompare";
import { installAnalysisPanes } from "./lib/paneWindows";
import { installRadarLive } from "./store/useRadarLiveStore";
import { installBackground } from "./lib/backgroundMode";
import { installColorTables } from "./lib/colorTableInstall";
import { installViewLinks } from "./lib/viewLink";
import { installShellKeys } from "./lib/shellKeys";
import { installUiScale } from "./lib/uiScale";
import { installRadarSites } from "./lib/radarSitesInstall";
import { restoreShell } from "./store/useShellStore";
import { themeLinkedBasemap } from "./map/basemaps";

// Product keys (R V S W Z C P K E L D N O) and up/down tilts, once for the app.
installRadarKeys();
// Display options: gate filter / trail redraws, T for the trail, the scan line.
installRadarDisplay();
installRadarSweep();
// Compare halves follow their panes; analysis views open where they went last.
installPaneCompare();
installAnalysisPanes();
// The Level II volume being written: streaming status + in-progress frames.
installRadarLive();
// Offline / weak-connection watch, and the hidden-window pause + catch-up.
installBackground();
// Colour tables: ] / [ step the focused pane's tables; any table change recolours every pane.
installColorTables();
// The shell: ? (shortcut list), / (search), Ctrl+\ (minimal UI); interface size
// and density; a broadcast setup kept from the last visit.
installShellKeys();
installUiScale();
restoreShell();
// radar-sites: the radars' live standing behind the coloured labels, the
// new-scan blink, recent radars and the default radar site.
installRadarSites();

// DEV-only hook so the sounding viewer can be driven without a right-click
// (headless preview can't size the WebGL map). Harmless in production builds.
// VITE_PROBE turns them on in a test build of the web version.
if (import.meta.env.DEV || import.meta.env.VITE_PROBE) {
  (window as unknown as { __openSounding?: (lat: number, lon: number) => void }).__openSounding = (lat, lon) =>
    useSoundingViewerStore.getState().openAt(lat, lon);
  // Read-only handles on the stores, for checking state from the console the
  // way __map already allows for the map.
  // These must be the app's own instances: a dynamic import() from the console
  // returns a second copy of the module, whose state is always empty and looks
  // exactly like a broken fetch.
  (window as unknown as { __stores?: Record<string, unknown> }).__stores = {
    app: useAppStore,
    auth: useAuthStore,
    chasers: useChaserStore,
    surfaceObs: useSurfaceObsStore,
    alerts: useAlertStore,
    mesoscale: useMesoscaleStore,
    soundingViewer: useSoundingViewerStore,
    soundingView: useSoundingViewStore,
    acars: useAcarsStore,
    nexrad: useNexradStore,
    vwp: useVwpStore,
  };
}

// Seed per-layer UI state from the registry defaults, then apply the saved
// reduced-motion preference.
useAppStore.getState().initLayers();
// Then put back the workspace the last visit left: layers, radar, map view...
restoreSession();
// A link to a moment (weatherts:// in the desktop app, ?site=...&datetime=... in
// a browser) opens over the restored workspace once the radar list is in.
installViewLinks();

// Coerce any stale persisted view (e.g. the removed "Tools" tab) to the catalog.
const persistedView = useAppStore.getState().dataView as string;
if (persistedView !== "catalog" && persistedView !== "layers" && persistedView !== "settings") {
  useAppStore.getState().setDataView("catalog");
}

applyReduceMotion(useAppStore.getState().reduceMotion);
useAppStore.subscribe((s) => s.reduceMotion, applyReduceMotion);

// "auto" theme follows the visitor's own clock, so re-resolve on every mode
// change plus a slow tick that catches the day/night boundary without a reload.
// The map's basemap rides along too, but only on an actual theme transition --
// not every tick -- so a manual basemap pick made mid-theme isn't fought.
let lastTheme: ResolvedTheme | null = null;
const syncTheme = () => {
  const theme = resolveTheme(useThemeStore.getState().mode);
  applyTheme(theme);
  if (theme !== lastTheme) {
    const nextBasemap = themeLinkedBasemap(theme, useAppStore.getState().basemapId);
    if (nextBasemap) useAppStore.getState().setBasemap(nextBasemap);
  }
  lastTheme = theme;
};
syncTheme();
useThemeStore.subscribe(syncTheme);
setInterval(syncTheme, 60_000);

import { ErrorBoundary } from "./ErrorBoundary";
import { restoreSession } from "./lib/session";
import { DesktopLogin, isDesktopLogin } from "./ui/auth/DesktopLogin";
import { WEB_OFFLINE, WebOffline } from "./ui/WebOffline";
import { IS_WEB } from "./lib/apiConfig";
import { isElectron } from "./lib/auth";

// The gate wraps App rather than living inside it: the workspace mounts once
// the session check has answered -- for a guest as much as for an account -- so
// nothing in it starts out assuming the wrong one.
// weatherts.tech/app/?desktop-login=1 is the Windows app's Google sign-in
// page (ui/auth/DesktopLogin), not the workspace.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {!isElectron && isDesktopLogin() ? (
        <DesktopLogin />
      ) : IS_WEB && WEB_OFFLINE ? (
        // The web version switched off (ui/WebOffline); the sign-in page above stays.
        <WebOffline />
      ) : (
        <LoginGate>
          <App />
        </LoginGate>
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
