import { X } from "lucide-react";

import { useAppStore, type DataView } from "../store/useAppStore";
import { CatalogView } from "./panels/CatalogView";
import { LayersContent } from "./panels/LayersContent";
import { SettingsContent } from "./panels/SettingsContent";
import { NowView } from "./panels/NowView";

const TITLES: Record<DataView, string> = {
  catalog: "Catalog",
  layers: "Layers",
  settings: "Settings",
  now: "Now",
};

/** The drawer that slides out of the tool dock. Stays mounted (so it can slide
 *  in/out and keep its content state); the dock chooses what it shows. It names
 *  itself and carries its own close, because with the tab strip gone nothing
 *  else on screen says which drawer this is. */
export function DataPanel() {
  const open = useAppStore((s) => s.leftPanelOpen);
  const dataView = useAppStore((s) => s.dataView);
  const toggleLeftPanel = useAppStore((s) => s.toggleLeftPanel);

  return (
    <aside className={`panel${open ? "" : " is-closed"}`} aria-label={TITLES[dataView]} aria-hidden={!open}>
      <header className="panel__head">
        <h2 className="panel__title">{TITLES[dataView]}</h2>
        <button
          type="button"
          className="panel__close"
          onClick={toggleLeftPanel}
          aria-label={`Close ${TITLES[dataView].toLowerCase()}`}
        >
          <X size={15} />
        </button>
      </header>
      <div className="panel__body">
        {/* keyed so switching drawers replays the entrance animation */}
        <div className="panel__view" key={dataView}>
          {dataView === "catalog" && <CatalogView />}
          {dataView === "layers" && <LayersContent />}
          {dataView === "settings" && <SettingsContent />}
          {dataView === "now" && <NowView />}
        </div>
      </div>
    </aside>
  );
}
