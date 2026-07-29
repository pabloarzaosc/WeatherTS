import { useState, type ReactNode } from "react";
import {
  Lock,
  Layers as LayersIcon,
  Radar,
  Satellite,
  AlertTriangle,
  Grid3x3,
  Zap,
  Activity,
  Gauge,
  Sparkles,
} from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import type { CatalogTab } from "../../store/useAppStore";
import { ModelBar } from "../ModelBar";
import { ModelsView } from "./ModelsView";
import { SurfaceObsView } from "./SurfaceObsView";
import { PressureView } from "./PressureView";
import { LightningView } from "./LightningView";
import { RadarView } from "./RadarView";

const CAT_TABS: { id: CatalogTab; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "my", label: "Mine" },
  { id: "favorite", label: "Favorites" },
  { id: "advanced", label: "Advanced" },
];

const ALERT_LAYER_ID = "nws-alerts";

// Quick-launch grid à la pro workstation. Alerts toggles its layer directly;
// the rest are future-phase placeholders. (Outlooks live in the top toolbar.)
// `usesModel` decides whether the picker below stays live while this category's
// panel is open: observations and radar are measurements, not model output, so
// leaving the control active there would imply it does something.
const CATEGORIES: {
  id: string;
  label: string;
  icon: ReactNode;
  ready: boolean;
  usesModel: boolean;
  layerId?: string;
  panel?: "models" | "surface" | "radar" | "pressure" | "lightning";
}[] = [
  { id: "surface", label: "Surface", icon: <Activity size={15} />, ready: true, usesModel: false, panel: "surface" },
  { id: "pressure", label: "Pressure", icon: <Gauge size={15} />, ready: true, usesModel: true, panel: "pressure" },
  { id: "models", label: "Models", icon: <Grid3x3 size={15} />, ready: false, usesModel: true, panel: "models" },
  { id: "radar", label: "Radar", icon: <Radar size={15} />, ready: true, usesModel: false, panel: "radar" },
  { id: "sat", label: "Satellite", icon: <Satellite size={15} />, ready: false, usesModel: true },
  { id: "alerts", label: "Alerts", icon: <AlertTriangle size={15} />, ready: true, usesModel: false, layerId: ALERT_LAYER_ID },
  { id: "lightning", label: "Lightning", icon: <Zap size={15} />, ready: true, usesModel: false, panel: "lightning" },
  { id: "more", label: "Others in development...", icon: <Sparkles size={15} />, ready: false, usesModel: false },
];

/** The Catalog tab — a quick category launcher. Clicking a category with an
 *  inline panel (Models) expands its options right below the grid. */
export function CatalogView() {
  const catalogTab = useAppStore((s) => s.catalogTab);
  const setCatalogTab = useAppStore((s) => s.setCatalogTab);
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);

  // Which category's inline panel is open.
  const [openPanel, setOpenPanel] = useState<"models" | "surface" | "radar" | "pressure" | "lightning" | null>(null);

  // Dim the picker while a panel that ignores models is open; closing it (or
  // opening one that does use a model) brings the control straight back.
  const openCategory = openPanel ? CATEGORIES.find((c) => c.panel === openPanel) : null;
  const modelIdle = !!openCategory && !openCategory.usesModel;

  return (
    <div className="catalog">
      <div className="subtabs">
        {CAT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`subtab${catalogTab === t.id ? " is-active" : ""}`}
            onClick={() => setCatalogTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {catalogTab !== "default" ? (
        <div className="empty">
          <LayersIcon size={22} />
          <p>Nothing here yet.</p>
          <span>“Mine”, “Favorites” and “Advanced” arrive in future phases.</span>
        </div>
      ) : (
        <>
          <div className="catgrid">
            {CATEGORIES.map((c) => {
              const active = c.panel
                ? openPanel === c.panel
                : c.layerId
                  ? (layers[c.layerId]?.visible ?? false)
                  : false;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`catbtn${active ? " is-active" : ""}${c.ready ? "" : " is-locked"}`}
                  disabled={!c.ready}
                  onClick={() => {
                    if (!c.ready) return;
                    if (c.panel) setOpenPanel((p) => (p === c.panel ? null : c.panel!));
                    else if (c.layerId) toggleLayer(c.layerId);
                  }}
                  title={c.ready ? c.label : `${c.label} — soon`}
                  aria-pressed={active}
                >
                  {c.icon}
                  <span>{c.label}</span>
                  {!c.ready && <Lock size={11} className="catbtn__lock" />}
                </button>
              );
            })}
          </div>

          {/* Below the grid: pick the product first, then what feeds it. */}
          <ModelBar
            disabled={modelIdle}
            reason={openCategory ? `${openCategory.label} is observed data — no model involved.` : undefined}
          />

          {openPanel === "models" && (
            <div className="catalog__panel">
              <ModelsView />
            </div>
          )}
          {openPanel === "surface" && (
            <div className="catalog__panel">
              <SurfaceObsView />
            </div>
          )}
          {openPanel === "pressure" && (
            <div className="catalog__panel">
              <PressureView />
            </div>
          )}
          {openPanel === "radar" && (
            <div className="catalog__panel">
              <RadarView />
            </div>
          )}
          {openPanel === "lightning" && (
            <div className="catalog__panel">
              <LightningView />
            </div>
          )}
        </>
      )}
    </div>
  );
}
