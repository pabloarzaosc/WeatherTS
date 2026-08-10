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
  Sparkles,
  Megaphone,
  Waves,
  Plane,
} from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import type { CatalogTab } from "../../store/useAppStore";
import { ModelsView } from "./ModelsView";
import { SurfaceObsView } from "./SurfaceObsView";
import { LightningView } from "./LightningView";
import { RadarView } from "./RadarView";
import { LsrView } from "./LsrView";
import { FrontsView } from "./FrontsView";

const CAT_TABS: { id: CatalogTab; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "my", label: "Mine" },
  { id: "favorite", label: "Favorites" },
  { id: "advanced", label: "Advanced" },
];

const ALERT_LAYER_ID = "nws-alerts";

// Quick-launch grid à la pro workstation. Alerts toggles its layer directly;
// the rest are future-phase placeholders. (Outlooks live in the top toolbar.)
const CATEGORIES: {
  id: string;
  label: string;
  icon: ReactNode;
  ready: boolean;
  layerId?: string;
  panel?: "models" | "surface" | "radar" | "lightning" | "lsr" | "fronts";
}[] = [
  { id: "surface", label: "Surface", icon: <Activity size={15} />, ready: true, panel: "surface" },
  { id: "models", label: "Models", icon: <Grid3x3 size={15} />, ready: false, panel: "models" },
  { id: "radar", label: "Radar", icon: <Radar size={15} />, ready: true, panel: "radar" },
  { id: "sat", label: "Satellite", icon: <Satellite size={15} />, ready: false },
  { id: "alerts", label: "Alerts", icon: <AlertTriangle size={15} />, ready: true, layerId: ALERT_LAYER_ID },
  { id: "lightning", label: "Lightning", icon: <Zap size={15} />, ready: true, panel: "lightning" },
  { id: "lsr", label: "Storm Reports", icon: <Megaphone size={15} />, ready: true, panel: "lsr" },
  { id: "fronts", label: "Fronts", icon: <Waves size={15} />, ready: true, panel: "fronts" },
  { id: "acars", label: "Aircraft", icon: <Plane size={15} />, ready: true, layerId: "acars" },
  { id: "more", label: "Others in development...", icon: <Sparkles size={15} />, ready: false },
];

/** The Catalog tab — a quick category launcher. Clicking a category with an
 *  inline panel (Models) expands its options right below the grid. */
export function CatalogView() {
  const catalogTab = useAppStore((s) => s.catalogTab);
  const setCatalogTab = useAppStore((s) => s.setCatalogTab);
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);

  // Which category's inline panel is open.
  const [openPanel, setOpenPanel] = useState<
    "models" | "surface" | "radar" | "lightning" | "lsr" | "fronts" | null
  >(null);

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
          {openPanel === "lsr" && (
            <div className="catalog__panel">
              <LsrView />
            </div>
          )}
          {openPanel === "fronts" && (
            <div className="catalog__panel">
              <FrontsView />
            </div>
          )}
        </>
      )}
    </div>
  );
}
