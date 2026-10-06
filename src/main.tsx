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
import "./styles/auth.css";

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
import { themeLinkedBasemap } from "./map/basemaps";

// DEV-only hook so the sounding viewer can be driven without a right-click
// (headless preview can't size the WebGL map). Harmless in production builds.
if (import.meta.env.DEV) {
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

// The gate wraps App rather than living inside it: the workspace mounts once
// the session check has answered -- for a guest as much as for an account -- so
// nothing in it starts out assuming the wrong one.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LoginGate>
        <App />
      </LoginGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
