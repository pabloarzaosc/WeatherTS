import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Search } from "lucide-react";

import { getMap } from "../../map/mapInstance";
import { BASINS, MJO_PHASES, catOf, loadClimo, loadEnso, loadFormation, loadMjo, loadStorms, type Cat } from "../../lib/tropical/data";
import { useAppStore } from "../../store/useAppStore";
import { useTropicalStore, type TropicalTab } from "../../store/useTropicalStore";
import { Seg, useSwpc } from "../space/common";
import { SstDay } from "../tropical/OceanTabs";
import { RECON_COLORS } from "../tropical/ReconTab";
import { SEASON_BASINS } from "../tropical/SeasonTab";
import { TROPICAL_TABS } from "../tropical/TropicalDashboard";
import { CatBadge } from "../tropical/common";
import { GUIDANCE_LAYER, RECON_LAYER, SEASON_LAYER, SST_LAYER, STORMS_LAYER, WSP_LAYER, flyToStorm, showOnMap } from "../tropical/mapActions";

function Toggle({ id, label, sub }: { id: string; label: string; sub: string }) {
  const on = useAppStore((s) => s.layers[id]?.visible ?? false);
  return (
    <label className="spcv__toggle">
      <input type="checkbox" checked={on} onChange={() => useAppStore.getState().setLayerVisible(id, !on)} />
      <span>
        <b>{label}</b>
        <small>{sub}</small>
      </span>
    </label>
  );
}

const open = (tab?: TropicalTab, storm?: string) => useTropicalStore.getState().openTab(tab, storm);
const short = (b: string) => BASINS.find((x) => x.id === b)?.short ?? b.toUpperCase();
const thisYear = new Date().getUTCFullYear();

/** Any storm in the record since 1842, every basin, by name and or year:
 *  "katrina", "1998", "mitch 1998". */
function FindStorm() {
  const climo = useSwpc("trp-climo", loadClimo, 86400);
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const text = q.trim().toLowerCase();
    if (!climo.data || text.length < 2) return [];
    const year = text.match(/\b(18|19|20)\d\d\b/)?.[0];
    const name = text.replace(/\b(18|19|20)\d\d\b/, "").trim();
    if (!name && !year) return [];
    const out: { basin: string; sid: string; name: string; year: number; start: number; peak: number }[] = [];
    for (const [basin, b] of Object.entries(climo.data.basins)) {
      for (const s of b.storms) {
        if (year && s[2] !== Number(year)) continue;
        const n = s[1].toLowerCase();
        if (name && !(n.startsWith(name) || n.split(/[\s-]/).some((w) => w.startsWith(name)))) continue;
        out.push({ basin, sid: s[0], name: s[1] || "Unnamed", year: s[2], start: s[3], peak: s[5] });
      }
    }
    // A name alone: the strongest first. A year: in the order they formed.
    out.sort((a, z) => (name ? z.peak - a.peak : a.start - z.start));
    return out;
  }, [climo.data, q]);
  return (
    <div className="trp-find">
      <label className="trp-find__box">
        <Search size={13} />
        <input type="search" placeholder="Find a storm: Katrina, Haiyan 2013, 1998…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a storm in the record" />
      </label>
      {q.trim().length >= 2 && (
        <div className="trp-find__list">
          {!climo.data && <span className="spc-note">Reading the record…</span>}
          {climo.data && hits.length === 0 && <span className="spc-note">No storm by that name or year since 1842.</span>}
          {hits.slice(0, 40).map((h) => (
            <button key={h.sid} type="button" onClick={() => open("storm", h.sid)} title="Open its page">
              <CatBadge cat={catOf(h.peak)} />
              <b>
                {h.name} {h.year}
              </b>
              <small>
                {short(h.basin)} · {Math.round(h.peak)} kt
              </small>
            </button>
          ))}
          {hits.length > 40 && <span className="spc-note">{hits.length - 40} more: add a year or more of the name.</span>}
        </div>
      )}
    </div>
  );
}

/** NHC's disturbances and their chances of becoming a tropical cyclone. */
function Formation() {
  const { data, error } = useSwpc("trp-two-points", loadFormation, 600);
  const color = (p: number) => (p >= 60 ? "#ff6060" : p >= 40 ? "#ffc140" : "#ffe775");
  if (error) return <span className="spc-note">NHC's outlook is not answering.</span>;
  if (!data) return <span className="spc-note">Reading…</span>;
  if (!data.length) return <span className="spc-note">Nothing NHC is watching in the Atlantic or the Eastern and Central Pacific.</span>;
  return (
    <div className="trp-mini">
      {data.map((a, i) => (
        <div key={i} className="trp-mini__row">
          <button type="button" onClick={() => getMap()?.flyTo({ center: [a.lon, a.lat], zoom: Math.max(getMap()?.getZoom() ?? 4, 4.5), essential: true })} title="Go to it on the map">
            <i className="trp-dot" style={{ background: color(a.prob7) }} />
            <b>{a.basin}</b>
            <small>
              2 d <em style={{ color: color(a.prob2) }}>{a.prob2}%</em> · 7 d <em style={{ color: color(a.prob7) }}>{a.prob7}%</em>
            </small>
          </button>
        </div>
      ))}
    </div>
  );
}

/** ENSO and the MJO in two lines. */
function Climate() {
  const enso = useSwpc("trp-enso", loadEnso, 21600);
  const mjo = useSwpc("trp-mjo", loadMjo, 21600);
  const oni = enso.data?.oni[enso.data.oni.length - 1];
  const wk = enso.data?.weekly[enso.data.weekly.length - 1];
  const m = mjo.data?.days[mjo.data.days.length - 1];
  const ensoName = (v: number) => (v >= 0.5 ? "El Niño" : v <= -0.5 ? "La Niña" : "Neutral");
  const tint = (v: number) => (v >= 0.5 ? "#ff6b5e" : v <= -0.5 ? "#5aa9ff" : undefined);
  return (
    <button type="button" className="trp-climate" onClick={() => open("enso")} title="Open ENSO and the MJO">
      <span>
        <em>ENSO</em>
        {oni ? (
          <>
            <b style={{ color: tint(oni[2]) }}>{ensoName(oni[2])}</b>
            <small>
              ONI {oni[2] > 0 ? "+" : ""}
              {oni[2].toFixed(1)}
              {wk ? ` · Niño 3.4 ${wk[3] > 0 ? "+" : ""}${wk[3].toFixed(1)}` : ""}
            </small>
          </>
        ) : (
          <small>{enso.error ? "unavailable" : "reading…"}</small>
        )}
      </span>
      <span>
        <em>MJO</em>
        {m ? (
          <>
            <b>{m[3] < 1 ? "Weak" : `Phase ${m[4]}`}</b>
            <small>
              {m[3] < 1 ? `phase ${m[4]}, ` : ""}
              {MJO_PHASES[m[4]]} · {m[3].toFixed(2)}
            </small>
          </>
        ) : (
          <small>{mjo.error ? "unavailable" : "reading…"}</small>
        )}
      </span>
    </button>
  );
}

/** The Tropical category in the catalog: what is up now and what may form,
 *  the seasons and the climate behind them, any storm in the record, the map
 *  layers with their dates, and the way into the dashboard. */
export function TropicalView() {
  const { data } = useSwpc("trp-storms", loadStorms, 120);
  const st = useTropicalStore();
  const layers = useAppStore((s) => s.layers);
  const storms = data?.storms ?? [];
  const stepYear = (n: number) => {
    const first = st.seasonBasin === "ep" ? 1949 : st.seasonBasin === "al" ? 1851 : 1842;
    st.set({ seasonYear: Math.max(first, Math.min(thisYear, st.seasonYear + n)) });
  };
  return (
    <div className="spcv">
      <button type="button" className="spcv__open" onClick={() => open()}>
        <Maximize2 size={13} /> Open the Tropical dashboard
      </button>

      <div className="spcv__section">Active now</div>
      <div className="trp-mini">
        {!data && <span className="spc-note">Reading…</span>}
        {data && storms.length === 0 && <span className="spc-note">No active tropical cyclones.</span>}
        {storms.map((s) => (
          <div key={s.id} className="trp-mini__row">
            <button type="button" onClick={() => open("storm", s.id)} title="Open its page">
              <CatBadge cat={s.cat as Cat} />
              <b>{s.name}</b>
              <small>
                {s.vmax ? `${Math.round(s.vmax)} kt` : ""}
                {s.mslp ? ` · ${Math.round(s.mslp)} mb` : ""}
              </small>
            </button>
            <button
              type="button"
              className="spc-link"
              onClick={() => showOnMap(STORMS_LAYER, () => flyToStorm(s))}
              title="Show it on the map"
            >
              Map
            </button>
          </div>
        ))}
      </div>

      <div className="spcv__section">May form</div>
      <Formation />

      <div className="spcv__section">Find any storm since 1842</div>
      <FindStorm />

      <div className="spcv__section">Climate</div>
      <Climate />

      <div className="spcv__section">On the map</div>
      <Toggle id={STORMS_LAYER} label="Tropical cyclones" sub="Cones, forecast and past tracks, wind radii, watches and warnings" />
      <Toggle id={GUIDANCE_LAYER} label="Model guidance" sub={storms.find((x) => x.id === st.storm) ? `Track models for ${storms.find((x) => x.id === st.storm)!.name}` : "Pick an active storm first"} />
      <Toggle id={WSP_LAYER} label="Wind speed probabilities" sub="NHC, next 5 days" />
      {layers[WSP_LAYER]?.visible && (
        <div className="spcv__field">
          <Seg value={st.wspKt} onChange={(v) => st.set({ wspKt: v })} options={[{ id: 34 as const, label: "34 kt" }, { id: 50 as const, label: "50 kt" }, { id: 64 as const, label: "64 kt" }]} />
        </div>
      )}
      <Toggle id="nhc-two" label="Formation areas" sub="NHC 7-day tropical weather outlook" />
      <Toggle id={RECON_LAYER} label="Hurricane Hunter flights" sub={`${st.reconBasin.toUpperCase()}, ${st.reconSpan ? "archive span" : `last ${st.reconHours} h`}`} />
      {layers[RECON_LAYER]?.visible && (
        <div className="spcv__field">
          <select className="trp-select" value={st.reconColor} onChange={(e) => st.set({ reconColor: e.target.value as typeof st.reconColor })}>
            {RECON_COLORS.map((c) => (
              <option key={c.id} value={c.id}>
                Colour by {c.label.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      )}
      <Toggle id={SEASON_LAYER} label="Season tracks" sub={`${st.seasonBasin === "all" ? "Every basin" : SEASON_BASINS.find((b) => b.id === st.seasonBasin)?.label ?? ""} ${st.seasonYear}, any season since 1842`} />
      {layers[SEASON_LAYER]?.visible && (
        <div className="spcv__field trp-row trp-row--wrap">
          <select className="trp-select" value={st.seasonBasin} onChange={(e) => st.set({ seasonBasin: e.target.value })}>
            <option value="all">Every basin</option>
            {SEASON_BASINS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <button type="button" className="spc-mapbtn" onClick={() => stepYear(-1)} title="The season before">
            <ChevronLeft size={13} />
          </button>
          <input
            className="trp-select trp-year"
            type="number"
            min={1842}
            max={thisYear}
            value={st.seasonYear}
            onChange={(e) => {
              const y = Number(e.target.value);
              if (y >= 1842 && y <= thisYear) st.set({ seasonYear: y });
            }}
          />
          <button type="button" className="spc-mapbtn" onClick={() => stepYear(1)} disabled={st.seasonYear >= thisYear} title="The season after">
            <ChevronRight size={13} />
          </button>
          <button type="button" className="spc-mapbtn" onClick={() => open("season")}>
            Open
          </button>
        </div>
      )}
      <Toggle id={SST_LAYER} label="Sea surface temperature" sub={`GHRSST MUR, 1 km, ${st.sstDate ?? "newest day"}`} />
      {layers[SST_LAYER]?.visible && (
        <div className="spcv__field trp-sstfield">
          <Seg value={st.sst} onChange={(v) => st.set({ sst: v })} options={[{ id: "sst" as const, label: "Temperature" }, { id: "anomaly" as const, label: "Anomaly" }]} />
          <SstDay />
        </div>
      )}

      <div className="spcv__section">Sections</div>
      <div className="spcv__tabs">
        {TROPICAL_TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => open(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

