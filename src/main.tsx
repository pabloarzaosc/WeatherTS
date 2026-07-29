import React from "react";
import ReactDOM from "react-dom/client";

import "maplibre-gl/dist/maplibre-gl.css";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/sounding.css";

// Side-effect import: every LayerModule registers itself here. The store and the
// catalog/layers panels are built from that registry, so a new phase only edits
// ./layers.
import "./layers";

import App from "./App";
import { LoginGate } from "./ui/LoginGate";
import { useAppStore } from "./store/useAppStore";
import { useSoundingViewerStore } from "./store/useSoundingViewerStore";
import { useSurfaceObsStore } from "./store/useSurfaceObsStore";
import { applyReduceMotion } from "./lib/theme";

// DEV-only hook so the sounding viewer can be driven without a right-click
// (headless preview can't size the WebGL map). Harmless in production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __openSounding?: (lat: number, lon: number) => void }).__openSounding = (lat, lon) =>
    useSoundingViewerStore.getState().openAt(lat, lon);
  // Read-only handles on the stores, for checking state from the console the
  // way __map already allows for the map.
  (window as unknown as { __stores?: Record<string, unknown> }).__stores = {
    app: useAppStore,
    surfaceObs: useSurfaceObsStore,
  };
}

// Seed per-layer UI state from the registry defaults, then apply the saved
// reduced-motion preference. The palette is a single fixed gray theme (CSS).
useAppStore.getState().initLayers();

// Coerce any stale persisted view (e.g. the removed "Tools" tab) to the catalog.
const persistedView = useAppStore.getState().dataView as string;
if (persistedView !== "catalog" && persistedView !== "layers" && persistedView !== "settings") {
  useAppStore.getState().setDataView("catalog");
}

applyReduceMotion(useAppStore.getState().reduceMotion);
useAppStore.subscribe((s) => s.reduceMotion, applyReduceMotion);

import { ErrorBoundary } from "./ErrorBoundary";

// The gate wraps App rather than living inside it: nothing of the workspace --
// no map, no layer fetches, no onboarding -- should mount before a session is
// accepted.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LoginGate>
        <App />
      </LoginGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
