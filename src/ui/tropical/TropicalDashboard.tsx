import { useEffect, useState } from "react";
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";

import { loadStorms } from "../../lib/tropical/data";
import { useTropicalStore, type TropicalTab } from "../../store/useTropicalStore";
import { useSwpc } from "../space/common";
import { ActiveTab } from "./ActiveTab";
import { ClimoTab } from "./ClimoTab";
import { CatBadge } from "./common";
import { HurricaneIcon } from "./HurricaneIcon";
import { EnsoTab, OceanTab } from "./OceanTabs";
import { OutlooksTab, ProductsTab } from "./OutlookTabs";
import { ReconTab } from "./ReconTab";
import { SatelliteTab } from "./SatelliteTab";
import { SeasonTab } from "./SeasonTab";
import { StormTab } from "./StormTab";

export const TROPICAL_TABS: { id: TropicalTab; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "storm", label: "Storm" },
  { id: "outlooks", label: "Outlooks" },
  { id: "recon", label: "Recon" },
  { id: "season", label: "Season" },
  { id: "climo", label: "Climatology" },
  { id: "satellite", label: "Satellite" },
  { id: "ocean", label: "Ocean & SST" },
  { id: "enso", label: "ENSO & MJO" },
  { id: "products", label: "Text products" },
];

/** The active systems across the top of every tab, one click from their page. */
function StormStrip() {
  const { data } = useSwpc("trp-storms", loadStorms, 120);
  const open = useTropicalStore((s) => s.openTab);
  const storms = data?.storms ?? [];
  return (
    <div className="spc-kpis trp-strip">
      {!data && <div className="spc-kpi"><span>Active</span><b>…</b></div>}
      {data && storms.length === 0 && (
        <div className="spc-kpi">
          <span>Active</span>
          <b>None</b>
        </div>
      )}
      {storms.map((s) => (
        <button key={s.id} type="button" className="spc-kpi trp-strip__storm" onClick={() => open("storm", s.id)} title={`${s.name}: open its page`}>
          <span>
            {s.code} · {s.agency}
          </span>
          <b>
            <CatBadge cat={s.cat} /> {s.name}
            <small>
              {s.vmax ? ` ${Math.round(s.vmax)} kt` : ""}
              {s.mslp ? ` · ${Math.round(s.mslp)} mb` : ""}
            </small>
          </b>
        </button>
      ))}
    </div>
  );
}

/**
 * Tropical cyclones, full screen like the sounding viewer and the Space
 * dashboard: the storms worldwide, each storm's page, outlooks, recon flights,
 * seasons and the record, the ocean and ENSO, satellite and every text product.
 */
export function TropicalDashboard() {
  const open = useTropicalStore((s) => s.open);
  const tab = useTropicalStore((s) => s.tab);
  const setTab = useTropicalStore((s) => s.setTab);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) useTropicalStore.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className={`sv spc-screen trp-screen${expanded ? " is-expanded" : ""}`} role="dialog" aria-label="Tropical">
      <header className="sv__head">
        <div className="sv__title">
          <HurricaneIcon size={16} />
          <div>
            <strong>Tropical</strong>
            <span>NHC · CPHC · JTWC · Hurricane Hunters · IBTrACS · NOAA CPC · STAR · GIBS</span>
          </div>
        </div>
        <div className="sv__brand">NHC / JTWC</div>
        <div className="sv__headbtns">
          <a className="hydro__headlink" href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener" title="National Hurricane Center">
            <ExternalLink size={14} />
          </a>
          <button type="button" onClick={() => setExpanded((v) => !v)} title={expanded ? "Restore" : "Expand"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button type="button" onClick={() => useTropicalStore.getState().close()} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
      </header>
      <nav className="spc-tabs" role="tablist" aria-label="Tropical sections">
        {TROPICAL_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "is-on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <StormStrip />
      <div className="sv__body spc-body">
        {tab === "active" && <ActiveTab />}
        {tab === "storm" && <StormTab />}
        {tab === "outlooks" && <OutlooksTab />}
        {tab === "recon" && <ReconTab />}
        {tab === "season" && <SeasonTab />}
        {tab === "climo" && <ClimoTab />}
        {tab === "satellite" && <SatelliteTab />}
        {tab === "ocean" && <OceanTab />}
        {tab === "enso" && <EnsoTab />}
        {tab === "products" && <ProductsTab />}
      </div>
    </div>
  );
}
