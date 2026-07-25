import { Square, Columns2, Grid2x2, LayoutGrid, RotateCw, PanelLeftClose } from "lucide-react";

import { useAppStore } from "../store/useAppStore";
import type { DataView } from "../store/useAppStore";
import { getMap } from "../map/mapInstance";
import { INITIAL_VIEW } from "../map/mapStyle";

const TABS: { id: DataView; label: string }[] = [
  { id: "catalog", label: "Catalog" },
  { id: "layers", label: "Layers" },
  { id: "settings", label: "Settings" },
];

export function TabsBar() {
  const dataView = useAppStore((s) => s.dataView);
  const setDataView = useAppStore((s) => s.setDataView);
  const leftPanelOpen = useAppStore((s) => s.leftPanelOpen);
  const toggleLeftPanel = useAppStore((s) => s.toggleLeftPanel);
  const paneCount = useAppStore((s) => s.paneCount);
  const setPaneCount = useAppStore((s) => s.setPaneCount);

  const resetView = () =>
    getMap()?.flyTo({
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      bearing: 0,
      pitch: 0,
      essential: true,
    });

  return (
    <div className="tabsbar">
      <div className="tabsbar__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${dataView === t.id && leftPanelOpen ? " is-active" : ""}`}
            onClick={() => setDataView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabsbar__view">
        <span className="tabsbar__label">VIEW</span>
        {([
          [1, Square, "Single view"],
          [2, Columns2, "Two panes"],
          [4, Grid2x2, "Four panes"],
          [6, LayoutGrid, "Six panes"],
        ] as const).map(([n, Icon, title]) => (
          <button
            key={n}
            type="button"
            className={`vbtn${paneCount === n ? " is-active" : ""}`}
            title={title}
            aria-pressed={paneCount === n}
            onClick={() => setPaneCount(n)}
          >
            <Icon size={15} />
          </button>
        ))}
        <button type="button" className="vbtn" title="Reset view" onClick={resetView}>
          <RotateCw size={15} />
        </button>
        <button type="button" className="vbtn" title="Collapse panel" onClick={toggleLeftPanel}>
          <PanelLeftClose size={15} />
        </button>
      </div>
    </div>
  );
}
