import { useAppStore } from "../store/useAppStore";
import { CatalogView } from "./panels/CatalogView";
import { LayersContent } from "./panels/LayersContent";
import { SettingsContent } from "./panels/SettingsContent";

/** The persistent left data panel. Stays mounted (so it can slide in/out and
 *  keep its content state); the tabs bar chooses what it shows. */
export function DataPanel() {
  const open = useAppStore((s) => s.leftPanelOpen);
  const dataView = useAppStore((s) => s.dataView);

  return (
    <aside className={`panel${open ? "" : " is-closed"}`} aria-label="Data panel" aria-hidden={!open}>
      <div className="panel__body">
        {/* keyed so switching tabs replays the entrance animation */}
        <div className="panel__view" key={dataView}>
          {dataView === "catalog" && <CatalogView />}
          {dataView === "layers" && <LayersContent />}
          {dataView === "settings" && <SettingsContent />}
        </div>
      </div>
    </aside>
  );
}
