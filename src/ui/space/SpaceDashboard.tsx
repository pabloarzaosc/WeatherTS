import { useEffect, useState } from "react";
import { ExternalLink, Maximize2, Minimize2, Sun, X } from "lucide-react";

import { useSpaceStore, type SpaceTab } from "../../store/useSpaceStore";
import { AuroraTab } from "./AuroraTab";
import { CmeTab } from "./CmeTab";
import { CycleTab } from "./CycleTab";
import { FlaresTab } from "./FlaresTab";
import { GeomagTab } from "./GeomagTab";
import { IonoTab } from "./IonoTab";
import { KpiStrip } from "./KpiStrip";
import { OverviewTab } from "./OverviewTab";
import { SunTab } from "./SunTab";
import { AlertsTab, ReportsTab } from "./TextTabs";
import { WindTab } from "./WindTab";

export const SPACE_TABS: { id: SpaceTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "wind", label: "Solar wind" },
  { id: "sun", label: "Sun" },
  { id: "flares", label: "Flares & particles" },
  { id: "geomag", label: "Geomagnetic" },
  { id: "aurora", label: "Aurora" },
  { id: "iono", label: "Ionosphere & radio" },
  { id: "cme", label: "CMEs & Enlil" },
  { id: "cycle", label: "Solar cycle" },
  { id: "alerts", label: "Alerts" },
  { id: "reports", label: "Reports" },
];

/**
 * Space weather, full screen like the sounding viewer: NOAA SWPC's whole
 * public feed, read live in the browser. The numbers that matter run across
 * the top of every tab; the tabs go from the Sun out to the ground.
 */
export function SpaceDashboard() {
  const open = useSpaceStore((s) => s.open);
  const tab = useSpaceStore((s) => s.tab);
  const setTab = useSpaceStore((s) => s.setTab);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) useSpaceStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className={`sv spc-screen${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="Space weather">
      <header className="sv__head">
        <div className="sv__title">
          <Sun size={16} />
          <div>
            <strong>Space Weather</strong>
            <span>NOAA Space Weather Prediction Center, live · NASA SDO · SOHO</span>
          </div>
        </div>
        <div className="sv__brand">NOAA SWPC</div>
        <div className="sv__headbtns">
          <a className="hydro__headlink" href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener" title="SWPC's site">
            <ExternalLink size={14} />
          </a>
          <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={() => useSpaceStore.getState().close()} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>
      <nav className="spc-tabs" role="tablist" aria-label="Space weather sections">
        {SPACE_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <KpiStrip />
      <div className="sv__body spc-body">
        {tab === "overview" && <OverviewTab />}
        {tab === "wind" && <WindTab />}
        {tab === "sun" && <SunTab />}
        {tab === "flares" && <FlaresTab />}
        {tab === "geomag" && <GeomagTab />}
        {tab === "aurora" && <AuroraTab />}
        {tab === "iono" && <IonoTab />}
        {tab === "cme" && <CmeTab />}
        {tab === "cycle" && <CycleTab />}
        {tab === "alerts" && <AlertsTab />}
        {tab === "reports" && <ReportsTab />}
      </div>
    </div>
  );
}
