import { useEffect, useState, type ReactNode } from "react";
import {
  Lock,
  Radar,
  Thermometer,
  AlertTriangle,

  Activity,
  Megaphone,
  Eye,
  Tornado,
  Satellite,
  Zap,
  Waves,
} from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import type { CatalogTab } from "../../store/useAppStore";
import { SurfaceObsView } from "./SurfaceObsView";
import { RadarView } from "./RadarView";
import { LsrView } from "./LsrView";
import { ObservationsView } from "./ObservationsView";
import { OutlooksView } from "./OutlooksView";
import { SatelliteView } from "./SatelliteView";
import { LightningView } from "./LightningView";
import { FloodView } from "./FloodView";
import { useOutlookStore } from "../../store/useOutlookStore";
import { AdvancedTab, FavoritesTab, MineTab } from "./CatalogTabs";
import { ActiveLayers } from "./ActiveLayers";
import { SoundingsContent } from "./SoundingsContent";

const CAT_TABS: { id: CatalogTab; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "my", label: "Mine" },
  { id: "favorite", label: "Favorites" },
  { id: "advanced", label: "Advanced" },
];

const ALERT_LAYER_ID = "nws-alerts";

type Panel = "surface" | "radar" | "satellite" | "lsr" | "pressure" | "sounding" | "observations" | "outlooks" | "lightning" | "flooding";

// Quick-launch grid à la pro workstation. Alerts toggles its layer directly;
// the rest open their panel below the grid. (The top toolbar's outlook picker
// is the quick way in; its panel is here.)
const CATEGORIES: {
  id: string;
  label: string;
  icon: ReactNode;
  ready: boolean;
  layerId?: string;
  panel?: Panel;
}[] = [
  { id: "surface", label: "Surface", icon: <Activity size={15} />, ready: true, panel: "surface" },
  { id: "radar", label: "Radar", icon: <Radar size={15} />, ready: true, panel: "radar" },
  { id: "satellite", label: "Satellite", icon: <Satellite size={15} />, ready: true, panel: "satellite" },
  // Locked for now: shown so people know it is coming, not yet switchable. The
  // layer is unregistered in layers/index.ts; flip both back to unlock it.
  { id: "sounding", label: "Sounding", icon: <Thermometer size={15} />, ready: true, panel: "sounding" },
  { id: "alerts", label: "Alerts", icon: <AlertTriangle size={15} />, ready: true, layerId: ALERT_LAYER_ID },
  { id: "lsr", label: "Storm Reports", icon: <Megaphone size={15} />, ready: true, panel: "lsr" },
  { id: "observations", label: "Models", icon: <Eye size={15} />, ready: true, panel: "observations" },
  { id: "outlooks", label: "Outlooks", icon: <Tornado size={15} />, ready: true, panel: "outlooks" },
  { id: "lightning", label: "Lightning", icon: <Zap size={15} />, ready: true, panel: "lightning" },
  { id: "flooding", label: "Flooding", icon: <Waves size={15} />, ready: true, panel: "flooding" },
];

/** The Catalog tab — a quick category launcher. Clicking a category with an
 *  inline panel expands its options right below the grid. */
export function CatalogView() {
  const catalogTab = useAppStore((s) => s.catalogTab);
  const setCatalogTab = useAppStore((s) => s.setCatalogTab);
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);

  // Which category's inline panel is open.
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  // The top-bar outlook picker's "Outlooks panel" link.
  const panelRequest = useOutlookStore((s) => s.panelRequest);
  useEffect(() => {
    if (panelRequest > 0) setOpenPanel("outlooks");
  }, [panelRequest]);

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

      {catalogTab === "my" ? (
        <MineTab />
      ) : catalogTab === "favorite" ? (
        <FavoritesTab />
      ) : catalogTab === "advanced" ? (
        <AdvancedTab />
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

          <ActiveLayers />

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
          {openPanel === "lsr" && (
            <div className="catalog__panel">
              <LsrView />
            </div>
          )}
          {openPanel === "observations" && (
            <div className="catalog__panel">
              <ObservationsView />
            </div>
          )}
          {openPanel === "satellite" && (
            <div className="catalog__panel">
              <SatelliteView />
            </div>
          )}
          {openPanel === "outlooks" && (
            <div className="catalog__panel">
              <OutlooksView />
            </div>
          )}
          {openPanel === "flooding" && (
            <div className="catalog__panel">
              <FloodView />
            </div>
          )}
          {openPanel === "lightning" && (
            <div className="catalog__panel">
              <LightningView />
            </div>
          )}
          {openPanel === "sounding" && (
            <div className="catalog__panel">
              <SoundingsContent />
            </div>
          )}
        </>
      )}
    </div>
  );
}
