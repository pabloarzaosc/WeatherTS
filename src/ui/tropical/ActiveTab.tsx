import { useMemo, useState } from "react";
import { ChevronRight, Crosshair, ExternalLink } from "lucide-react";

import { TWO_PICTURES, basinLabel, jtwcOutlook, loadClimo, loadSeason, loadStorms, typeName, type ActiveStorm } from "../../lib/tropical/data";
import { standing } from "../../lib/tropical/climo";
import { useTropicalStore } from "../../store/useTropicalStore";
import { ZoomImage } from "../space/ImageLoop";
import { fmtUtc } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { CatBadge, ago, latlonText, motionText, windText } from "./common";
import { flyToStorm } from "./mapActions";

function StormCard({ s }: { s: ActiveStorm }) {
  const open = useTropicalStore((st) => st.openTab);
  return (
    <div className={`trp-storm${s.invest ? " is-invest" : ""}`}>
      <button type="button" className="trp-storm__main" onClick={() => open("storm", s.id)}>
        <CatBadge cat={s.cat} big />
        <span className="trp-storm__name">
          <b>{s.invest ? s.name : `${typeName(s.type, s.vmax, s.basin)} ${s.name}`}</b>
          <small>
            {s.code} · {s.agency} · {basinLabel(s.basin)}
          </small>
        </span>
        <ChevronRight size={14} />
      </button>
      <dl className="trp-storm__facts">
        <dt>Wind</dt>
        <dd>{windText(s.vmax)}</dd>
        <dt>Pressure</dt>
        <dd>{s.mslp ? `${Math.round(s.mslp)} mb` : "--"}</dd>
        <dt>Position</dt>
        <dd>{latlonText(s.lat, s.lon)}</dd>
        <dt>Moving</dt>
        <dd>{motionText(s.nhc?.movementDir ?? s.dir, s.nhc?.movementSpeed ?? s.speed)}</dd>
        <dt>Updated</dt>
        <dd>
          {fmtUtc(s.nhc?.lastUpdate ? Date.parse(s.nhc.lastUpdate) : s.t)} ({ago(s.nhc?.lastUpdate ? Date.parse(s.nhc.lastUpdate) : s.t)})
        </dd>
        <dt>ACE so far</dt>
        <dd>{s.ace.toFixed(1)}</dd>
      </dl>
      <div className="trp-storm__tools">
        <button type="button" className="spc-link" onClick={() => flyToStorm(s)}>
          <Crosshair size={12} /> On the map
        </button>
        {s.nhc?.advisory && <span className="spc-card__meta">Advisory {Number(s.nhc.advisory)}</span>}
      </div>
    </div>
  );
}

export function StormList({ compact }: { compact?: boolean }) {
  const { data, error } = useSwpc("trp-storms", loadStorms, 120);
  if (!data) return <Loading error={error} what="the active storms" />;
  const named = data.storms.filter((s) => !s.invest);
  const invests = data.storms.filter((s) => s.invest);
  return (
    <div className={`trp-storms${compact ? " is-compact" : ""}`}>
      {named.length === 0 && <div className="spc-msg">No named or numbered tropical cyclones anywhere right now.</div>}
      {named.map((s) => (
        <StormCard key={s.id} s={s} />
      ))}
      {invests.length > 0 && <h4 className="trp-sub">Invests</h4>}
      {invests.map((s) => (
        <StormCard key={s.id} s={s} />
      ))}
    </div>
  );
}

function OutlookCard() {
  const [id, setId] = useState("atl");
  const p = TWO_PICTURES.find((x) => x.id === id)!;
  const bust = Math.floor(Date.now() / 900_000);
  return (
    <Card
      title="NHC 7-day outlook"
      extra={
        <div className="spc-card__tools">
          <Seg value={id} onChange={setId} options={TWO_PICTURES.map((x) => ({ id: x.id, label: x.label }))} />
          <a className="spc-link" href={p.href} target="_blank" rel="noopener">
            NHC <ExternalLink size={11} />
          </a>
        </div>
      }
    >
      <div className="spc-loop trp-two">
        <ZoomImage src={`${p.url}?${bust}`} alt={`NHC outlook, ${p.label}`} />
      </div>
    </Card>
  );
}

function JtwcCard() {
  const [which, setWhich] = useState<"abpw" | "abio">("abpw");
  const { data, error } = useSwpc(`jtwc-${which}`, () => jtwcOutlook(which), 600);
  return (
    <Card
      title="JTWC outlook"
      extra={<Seg value={which} onChange={setWhich} options={[{ id: "abpw", label: "Pacific" }, { id: "abio", label: "Indian Ocean" }]} />}
    >
      {data ? <pre className="spc-pre spc-pre--small">{data.trim()}</pre> : <Loading error={error} what="JTWC" />}
    </Card>
  );
}

const SUMMARY_BASINS = ["al", "ep", "wp", "io", "sh"];

function SeasonRow({ basin }: { basin: string }) {
  const climo = useSwpc("trp-climo", loadClimo, 86400);
  const year = new Date().getUTCFullYear() + (basin === "sh" && new Date().getUTCMonth() >= 6 ? 1 : 0);
  const season = useSwpc(`trp-season-${basin}-${year}`, () => loadSeason(basin, year), 600);
  const st = useMemo(() => (climo.data && season.data ? standing(climo.data, basin, season.data) : null), [climo.data, season.data, basin]);
  const set = useTropicalStore((s) => s.set);
  const s = season.data;
  return (
    <tr className="is-click" onClick={() => set({ open: true, tab: "season", seasonBasin: basin, seasonYear: year })}>
      <td>
        <b>{basinLabel(basin)}</b>
        {basin === "sh" && <small> {year - 1}-{String(year).slice(2)}</small>}
      </td>
      <td className="mono">{s ? s.ace.toFixed(1) : season.error ? "!" : "…"}</td>
      <td className="mono">{st?.pct != null ? `${Math.round(st.pct)}%` : "--"}</td>
      <td className="mono">{st ? `${st.rank} of ${st.of}` : "--"}</td>
      <td className="mono">{s ? s.named : "--"}</td>
      <td className="mono">{s ? s.hurricanes : "--"}</td>
      <td className="mono">{s ? s.majors : "--"}</td>
    </tr>
  );
}

function SeasonSummary() {
  return (
    <Card title="This season so far" extra={<span className="spc-card__meta">ACE against 1991-2020 to the same date · click a row</span>}>
      <div className="trp-scrollx">
        <table className="spc-table">
          <thead>
            <tr>
              <th>Basin</th>
              <th title="Accumulated cyclone energy">ACE</th>
              <th title="ACE against the 1991-2020 mean to this date">Normal</th>
              <th title="Rank of this season's ACE to date since 1950">Rank</th>
              <th title="Tropical storms or stronger">Named</th>
              <th title="Hurricanes, typhoons, cyclones (64 kt)">Hurr.</th>
              <th title="Category 3 or stronger (96 kt)">Major</th>
            </tr>
          </thead>
          <tbody>
            {SUMMARY_BASINS.map((b) => (
              <SeasonRow key={b} basin={b} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ActiveTab() {
  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <Card title="Active tropical cyclones, worldwide" extra={<span className="spc-card__meta">NHC, CPHC and JTWC best tracks</span>}>
          <StormList />
        </Card>
        <SeasonSummary />
      </div>
      <div className="spc-col spc-col--side">
        <OutlookCard />
        <JtwcCard />
      </div>
    </div>
  );
}
