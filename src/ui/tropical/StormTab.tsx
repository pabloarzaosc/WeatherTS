import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Crosshair, ExternalLink, Map as MapIcon } from "lucide-react";

import {
  CAT_COLORS,
  SAT_BANDS,
  STORM_ID,
  TECH_NAMES,
  basinLabel,
  catOf,
  floaterFrames,
  hasFloater,
  isIbtracsId,
  latestProduct,
  loadGuidance,
  loadSeason,
  loadStorms,
  loadTrack,
  nhcGraphics,
  nhcWindProbFrames,
  typeName,
  type ActiveStorm,
  type Model,
  type TrackPoint,
} from "../../lib/tropical/data";
import { getCached } from "../../lib/tropical/fetch";
import { useTropicalStore } from "../../store/useTropicalStore";
import { ImageLoop, ZoomImage } from "../space/ImageLoop";
import { TimeStack, fmtUtc, type ChartPanel, type ChartSeries } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { CatBadge, latlonText, motionText, windText } from "./common";
import { SEASON_LAYER, fitTo, flyToStorm, showOnMap } from "./mapActions";

const H = 3_600_000;
const tint = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** The Saffir-Simpson bands behind an intensity chart. */
const WIND_BANDS = [
  { from: 34, to: 64, color: tint(CAT_COLORS.TS, 0.06), label: "TS" },
  { from: 64, to: 83, color: tint(CAT_COLORS.C1, 0.07), label: "1" },
  { from: 83, to: 96, color: tint(CAT_COLORS.C2, 0.07), label: "2" },
  { from: 96, to: 113, color: tint(CAT_COLORS.C3, 0.08), label: "3" },
  { from: 113, to: 137, color: tint(CAT_COLORS.C4, 0.08), label: "4" },
  { from: 137, to: 200, color: tint(CAT_COLORS.C5, 0.09), label: "5" },
];

/** The official forecast is white in the decks, which vanishes on the light theme: the accent instead. */
const officialColor = (m: Model) => (m.official ? "var(--accent)" : m.colour);

const ser = (pts: { t: number; v: number | null }[]) => ({
  t: Float64Array.from(pts.map((p) => p.t)),
  v: Float64Array.from(pts.map((p) => (p.v == null ? NaN : p.v))),
});

/** How much the wind changed over the 24 hours to each six-hourly fix: 30 kt
 *  or more is rapid intensification, -30 rapid weakening. */
function change24(pts: TrackPoint[]) {
  const at = new Map(pts.map((p) => [p.t, p.vmax]));
  const out: { t: number; v: number | null }[] = [];
  for (const p of pts) {
    if (new Date(p.t).getUTCHours() % 6) continue;
    const before = at.get(p.t - 24 * H);
    if (p.vmax != null && before != null) out.push({ t: p.t, v: p.vmax - before });
  }
  return ser(out);
}

/** The intensity aids shown at once; the rest start hidden in the legend. */
const SHOWN_INTENSITY = new Set(["OFCL", "JTWC", "IVCN", "ICNW", "HCCA", "SHIP", "LGEM", "HFAI", "HWFI", "CHIP"]);

function IntensityCard({ id, past }: { id: string; past?: boolean }) {
  const track = useSwpc(`trp-track-${id}`, () => loadTrack(id), past ? 86400 : 300);
  const g = useSwpc(past ? "none" : `trp-guid-${id}`, () => (past ? Promise.resolve(null) : loadGuidance(id)), 600);
  const domain = useMemo<[number, number]>(() => {
    const pts = track.data?.points ?? [];
    const first = pts[0]?.t ?? Date.now() - 3 * 86_400_000;
    let last = pts[pts.length - 1]?.t ?? Date.now();
    for (const m of g.data?.models ?? []) if (m.intensity) for (const p of m.points) if (p.vmax != null && p.t > last) last = p.t;
    return [first - 3 * H, last + 3 * H];
  }, [track.data, g.data]);
  const panels = useMemo<ChartPanel[]>(() => {
    const pts = track.data?.points ?? [];
    const models = (g.data?.models ?? []).filter((m) => m.intensity);
    const wind: ChartSeries[] = [
      { label: "Best track", color: "var(--sx-wind)", data: ser(pts.filter((p) => p.vmax != null).map((p) => ({ t: p.t, v: p.vmax }))), width: 2.4, kind: "step" },
      ...models.map((m) => ({
        label: m.tech,
        color: officialColor(m),
        data: ser(m.points.filter((p) => p.vmax != null).map((p) => ({ t: p.t, v: p.vmax }))),
        width: m.official ? 2.2 : 1.2,
        dash: m.official ? [6, 3] : undefined,
        off: !SHOWN_INTENSITY.has(m.tech),
        fmt: (v: number) => `${Math.round(v)} kt`,
      })),
    ];
    const pres: ChartSeries[] = [
      { label: "Best track", color: "var(--sx-wind)", data: ser(pts.filter((p) => p.mslp != null).map((p) => ({ t: p.t, v: p.mslp }))), width: 2.2, kind: "step" },
      ...models
        .filter((m) => m.points.filter((p) => p.mslp != null).length >= 2)
        .map((m) => ({
          label: m.tech,
          color: officialColor(m),
          data: ser(m.points.filter((p) => p.mslp != null).map((p) => ({ t: p.t, v: p.mslp }))),
          width: m.official ? 2 : 1.1,
          dash: m.official ? [6, 3] : undefined,
          off: !SHOWN_INTENSITY.has(m.tech),
          fmt: (v: number) => `${Math.round(v)} mb`,
        })),
    ];
    return [
      {
        id: "wind",
        title: "Maximum wind",
        units: "kt",
        include: [0, 70],
        weight: 1.6,
        bands: WIND_BANDS,
        series: wind,
        fmt: (v) => `${Math.round(v)} kt`,
      },
      { id: "pres", title: "Minimum pressure", units: "mb", include: [1010], series: pres, fmt: (v) => `${Math.round(v)} mb` },
      {
        id: "d24",
        title: "Wind change over 24 hours",
        units: "kt",
        symmetric: true,
        weight: 0.8,
        lines: [
          { y: 30, color: "rgba(255,96,96,0.8)", label: "RI" },
          { y: -30, color: "rgba(94,186,255,0.8)", label: "RW" },
        ],
        series: [
          {
            label: "Best track",
            color: "#ff6b5e",
            kind: "bars",
            barMs: 6 * H,
            data: change24(pts),
            colorOf: (v) => (v >= 30 ? "#ff4040" : v > 0 ? "#ff9a6a" : v <= -30 ? "#2f80ff" : "#7fb2ff"),
            fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v)} kt`,
          },
        ],
      },
    ];
  }, [track.data, g.data]);
  return (
    <Card
      className="spc-card--fill trp-card--intensity"
      title={past ? "Intensity" : "Intensity: best track, official forecast and the aids"}
      extra={<span className="spc-card__meta">{g.data?.cycle ? `Guidance from ${fmtUtc(g.data.cycle)} · ` : ""}click a name to show it</span>}
    >
      {!track.data && <Loading error={track.error} what="the best track" />}
      <TimeStack panels={panels} domain={domain} />
    </Card>
  );
}

const TAUS = [24, 48, 72, 96, 120];

function posAt(m: Model, tau: number): string {
  const p = m.points.find((x) => x.tau === tau);
  if (!p || p.lat == null || p.lon == null) return "";
  return `${Math.abs(p.lat).toFixed(1)}${p.lat >= 0 ? "N" : "S"} ${Math.abs(p.lon).toFixed(1)}${p.lon >= 0 ? "E" : "W"}`;
}

function GuidanceCard({ s }: { s: ActiveStorm }) {
  const all = useTropicalStore((st) => st.guidanceAll);
  const g = useSwpc(`trp-guid-${s.id}`, () => loadGuidance(s.id), 600);
  const models = (g.data?.models ?? []).filter((m) => m.track);
  return (
    <Card
      title="Track guidance"
      extra={
        <div className="spc-card__tools">
          <span className="spc-card__meta">{g.data?.cycle ? fmtUtc(g.data.cycle) : ""}</span>
          <label className="trp-check">
            <input type="checkbox" checked={all} onChange={(e) => useTropicalStore.getState().set({ guidanceAll: e.target.checked })} />
            Every model on the map
          </label>
          <button type="button" className="spc-mapbtn" onClick={() => flyToStorm(s)}>
            <MapIcon size={13} /> Guidance on the map
          </button>
        </div>
      }
    >
      {!g.data ? (
        <Loading error={g.error} what="the guidance" />
      ) : models.length === 0 ? (
        <div className="spc-msg">No track guidance in the deck for this storm yet.</div>
      ) : (
        <div className="trp-scrollx">
          <table className="spc-table trp-guidance">
            <thead>
              <tr>
                <th>Model</th>
                {TAUS.map((t) => (
                  <th key={t}>{t} h</th>
                ))}
                <th>Peak</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const peak = Math.max(...m.points.map((p) => p.vmax ?? 0));
                return (
                  <tr key={m.tech} className={m.official ? "is-hot" : ""}>
                    <td title={TECH_NAMES[m.tech] ?? m.tech}>
                      <i className="trp-swatch" style={{ background: officialColor(m) }} />
                      <b>{m.tech}</b> <small>{TECH_NAMES[m.tech] ?? ""}</small>
                    </td>
                    {TAUS.map((t) => (
                      <td key={t} className="mono">
                        {posAt(m, t) || "--"}
                      </td>
                    ))}
                    <td className="mono">{peak > 0 ? `${Math.round(peak)} kt` : "--"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function GraphicsCard({ s }: { s: ActiveStorm }) {
  const pics = nhcGraphics(s.id);
  const [pick, setPick] = useState("cone");
  const [kt, setKt] = useState<34 | 50 | 64>(34);
  const bust = Math.floor(Date.now() / 600_000);
  const wsp = pick === "wsp";
  const frames = useMemo(() => nhcWindProbFrames(s.id, kt).map((f) => ({ url: `${f.url}?${bust}`, t: null })), [s.id, kt, bust]);
  const p = pics.find((x) => x.id === pick);
  return (
    <Card
      className="spc-card--viewer"
      title="NHC graphics"
      extra={
        <div className="spc-card__tools">
          <select className="trp-select" value={pick} onChange={(e) => setPick(e.target.value)}>
            {pics.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
            <option value="wsp">Wind speed probabilities, 0-120 h</option>
          </select>
          {wsp && <Seg value={kt} onChange={setKt} options={[{ id: 34, label: "34 kt" }, { id: 50, label: "50 kt" }, { id: 64, label: "64 kt" }]} />}
          <a className="spc-link" href={s.nhc?.graphics ?? "https://www.nhc.noaa.gov/"} target="_blank" rel="noopener">
            NHC <ExternalLink size={11} />
          </a>
        </div>
      }
    >
      {wsp ? (
        <ImageLoop frames={frames} title={`${kt} kt probability`} count={0} />
      ) : (
        <div className="spc-loop">{p && <ZoomImage src={`${p.url}?${bust}`} alt={p.label} />}</div>
      )}
    </Card>
  );
}

function SatelliteCard({ s }: { s: ActiveStorm }) {
  const [band, setBand] = useState("GEOCOLOR");
  const f = useSwpc(`trp-floater-${s.id}-${band}`, () => floaterFrames(s.id, band), 300);
  return (
    <Card
      className="spc-card--viewer"
      title="Satellite, following the storm"
      extra={
        <select className="trp-select" value={band} onChange={(e) => setBand(e.target.value)}>
          {SAT_BANDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      }
    >
      {f.data && f.data.length === 0 ? (
        <div className="spc-loop spc-loop--msg">STAR has no floater over this system right now.</div>
      ) : (
        <ImageLoop key={band} frames={f.data} error={f.error ? "STAR has no floater over this system right now." : null} title={`${s.name} ${band}`} count={48} href="https://www.star.nesdis.noaa.gov/goes/floater.php" />
      )}
    </Card>
  );
}

type Prod = "TCP" | "TCD" | "TCM" | "PWS" | "JTWC";

function ProductsCard({ s }: { s: ActiveStorm }) {
  const nhc = !!s.nhc?.bin;
  const [prod, setProd] = useState<Prod>(nhc ? "TCP" : "JTWC");
  useEffect(() => setProd(nhc ? "TCP" : "JTWC"), [s.id, nhc]);
  const key = `trp-prod-${s.id}-${prod}`;
  const { data, error } = useSwpc(
    key,
    async () => {
      if (prod === "JTWC") {
        const t = await getCached<string>(`https://www.metoc.navy.mil/jtwc/products/${s.basin}${String(s.number).padStart(2, "0")}${String(s.year).slice(2)}web.txt`, 600, "text");
        return { text: t, issued: "" };
      }
      return latestProduct(prod, s.nhc!.bin);
    },
    300,
  );
  const opts = nhc
    ? [
        { id: "TCP" as Prod, label: "Public advisory" },
        { id: "TCD" as Prod, label: "Discussion" },
        { id: "TCM" as Prod, label: "Forecast advisory" },
        { id: "PWS" as Prod, label: "Wind probabilities" },
      ]
    : [{ id: "JTWC" as Prod, label: "JTWC warning" }];
  return (
    <Card title="Official text" extra={<Seg value={prod} onChange={setProd} options={opts} />} className="spc-card--doc">
      {data ? (
        <pre className="spc-pre trp-pre">{data.text.trim()}</pre>
      ) : data === null ? (
        <div className="spc-msg">Not issued for this storm.</div>
      ) : (
        <Loading error={error} what="the text" />
      )}
    </Card>
  );
}

function FactsCard({ s }: { s: ActiveStorm }) {
  const track = useSwpc(`trp-track-${s.id}`, () => loadTrack(s.id), 300);
  const pts = track.data?.points ?? [];
  const peak = pts.reduce((a, p) => Math.max(a, p.vmax ?? 0), 0);
  const low = pts.reduce((a, p) => (p.mslp && p.mslp < a ? p.mslp : a), 9999);
  const last = pts[pts.length - 1];
  const r34 = last?.radii["34"];
  return (
    <Card title="Now">
      <dl className="trp-facts">
        <dt>Maximum wind</dt>
        <dd>{windText(s.vmax)}</dd>
        <dt>Pressure</dt>
        <dd>{s.mslp ? `${Math.round(s.mslp)} mb` : "--"}</dd>
        <dt>Position</dt>
        <dd>{latlonText(s.lat, s.lon)}</dd>
        <dt>Moving</dt>
        <dd>{motionText(s.nhc?.movementDir ?? s.dir, s.nhc?.movementSpeed ?? s.speed)}</dd>
        <dt>34 kt radii</dt>
        <dd>{r34 ? `NE ${r34[0]} · SE ${r34[1]} · SW ${r34[2]} · NW ${r34[3]} nm` : "--"}</dd>
        <dt>Eye / RMW</dt>
        <dd>{last?.rmw ? `${last.rmw} nm` : "--"}</dd>
        <dt>Peak so far</dt>
        <dd>
          {peak ? `${Math.round(peak)} kt` : "--"}
          {low < 9999 ? ` · ${Math.round(low)} mb` : ""}
        </dd>
        <dt>ACE</dt>
        <dd>{s.ace.toFixed(2)}</dd>
        <dt>First fix</dt>
        <dd>{fmtUtc(s.first)}</dd>
        <dt>Basin</dt>
        <dd>
          {basinLabel(s.basin)} · {s.agency}
        </dd>
      </dl>
    </Card>
  );
}

function PastStorm({ id, storms }: { id: string; storms: ActiveStorm[] }) {
  const setStorm = useTropicalStore((s) => s.setStorm);
  const track = useSwpc(`trp-track-${id}`, () => loadTrack(id), 86400);
  const pts = track.data?.points ?? [];
  const peak = pts.reduce<TrackPoint | null>((a, p) => ((p.vmax ?? 0) > (a?.vmax ?? -1) ? p : a), null);
  const low = pts.reduce<TrackPoint | null>((a, p) => (p.mslp && (!a?.mslp || p.mslp < a.mslp) ? p : a), null);
  let ri = 0;
  const byT = new Map(pts.map((p) => [p.t, p.vmax]));
  for (const p of pts) {
    const b = byT.get(p.t - 24 * H);
    if (p.vmax != null && b != null) ri = Math.max(ri, p.vmax - b);
  }
  // A deck id carries its basin and year; an IBTrACS one only its year, so
  // the track's own say wins once it is in.
  const year = track.data?.year ?? (isIbtracsId(id) ? Number(id.slice(0, 4)) : Number(id.slice(4)));
  const basin = track.data?.basin ?? (isIbtracsId(id) ? "" : id.slice(0, 2));
  const seasonBasin = basin === "cp" ? "ep" : basin;
  const code = track.data?.code ?? (isIbtracsId(id) ? "" : `${id.slice(2, 4)}${id.slice(0, 2).toUpperCase()}`);
  const landfalls = pts.filter((p) => (p as TrackPoint & { landfall?: boolean }).landfall).length;
  // The storms before and after it in its season, to walk back through the record.
  const season = useSwpc(seasonBasin ? `trp-season-${seasonBasin}-${year}` : "none", () => (seasonBasin ? loadSeason(seasonBasin, year) : Promise.resolve(null)), 86400);
  const list = (season.data?.storms ?? []).filter((x) => x.id && x.peak >= 34);
  // The season may come from another record than the storm (HURDAT2 against
  // an IBTrACS id): the same storm is the one of that name that began then.
  const at = list.findIndex((x) => x.id === id || (!!pts.length && x.name === track.data?.name && Math.abs(x.start - pts[0].t) < 3 * 86_400_000));
  const prev = at > 0 ? list[at - 1] : null;
  const next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;
  const showTrack = () =>
    showOnMap(SEASON_LAYER, () => {
      useTropicalStore.getState().set({ seasonBasin, seasonYear: year });
      fitTo(pts.map((p) => [p.lon, p.lat] as [number, number]), 6);
    });
  return (
    <div className="trp-stormtab">
      <div className="trp-picker">
        {storms.map((x) => (
          <button key={x.id} type="button" onClick={() => setStorm(x.id)}>
            <CatBadge cat={x.cat} />
            {x.name}
          </button>
        ))}
        <button type="button" className="is-on">
          <CatBadge vmax={peak?.vmax} />
          {track.data?.name ?? id} {year}
        </button>
      </div>
      <header className="trp-head">
        <CatBadge vmax={peak?.vmax} big />
        <div>
          <h2>
            {track.data?.name ?? id} {year}
          </h2>
          <span>
            {code ? `${code} · ` : ""}
            {basin ? basinLabel(basin) : "--"} · peak {windText(peak?.vmax)}
            {low?.mslp ? ` · ${Math.round(low.mslp)} mb` : ""}
          </span>
        </div>
        <div className="trp-head__tools">
          <button type="button" className="spc-mapbtn" disabled={!prev} onClick={() => prev && setStorm(prev.id)} title={prev ? `${prev.name}, the storm before it` : "The first storm of its season"}>
            <ChevronLeft size={13} /> {prev ? prev.name : "Previous"}
          </button>
          <button type="button" className="spc-mapbtn" disabled={!next} onClick={() => next && setStorm(next.id)} title={next ? `${next.name}, the storm after it` : "The last storm of its season"}>
            {next ? next.name : "Next"} <ChevronRight size={13} />
          </button>
          <button type="button" className="spc-mapbtn" onClick={showTrack} disabled={!pts.length || !seasonBasin || seasonBasin === "sl"}>
            <MapIcon size={13} /> Its season on the map
          </button>
        </div>
      </header>
      {!track.data ? (
        <Loading error={track.error} what="the best track" />
      ) : (
        <div className="spc-grid spc-grid--overview">
          <div className="spc-col spc-col--main">
            <IntensityCard id={id} past />
          </div>
          <div className="spc-col spc-col--side">
            <Card title="Life">
              <dl className="trp-facts">
                <dt>First fix</dt>
                <dd>{pts[0] ? fmtUtc(pts[0].t) : "--"}</dd>
                <dt>Last fix</dt>
                <dd>{pts.length ? fmtUtc(pts[pts.length - 1].t) : "--"}</dd>
                <dt>Days</dt>
                <dd>{pts.length > 1 ? ((pts[pts.length - 1].t - pts[0].t) / 86_400_000).toFixed(1) : "--"}</dd>
                <dt>Peak wind</dt>
                <dd>{peak ? `${windText(peak.vmax)} on ${fmtUtc(peak.t)}` : "--"}</dd>
                <dt>Lowest</dt>
                <dd>{low?.mslp ? `${Math.round(low.mslp)} mb on ${fmtUtc(low.t)}` : "--"}</dd>
                <dt>Fastest 24 h</dt>
                <dd>{ri ? `+${Math.round(ri)} kt${ri >= 30 ? " (rapid intensification)" : ""}` : "--"}</dd>
                <dt>ACE</dt>
                <dd>{track.data.ace.toFixed(2)}</dd>
                <dt>Landfalls</dt>
                <dd>{landfalls || "--"}</dd>
                <dt>Record</dt>
                <dd>{track.data.source === "IBTrACS" ? "IBTrACS v04r01" : track.data.source === "HURDAT2" ? "NHC HURDAT2" : "ATCF best track"}</dd>
              </dl>
            </Card>
            <Card title="Its season">
              {!season.data ? (
                <Loading error={season.error} what="the season" />
              ) : (
                <ol className="trp-rank trp-rank--click">
                  {list.map((x) => (
                    <li key={x.id} className={x === list[at] ? "is-hot" : ""} onClick={() => setStorm(x.id)}>
                      <CatBadge cat={x.cat ?? catOf(x.peak)} />
                      <span>{x.name}</span>
                      <b>{Math.round(x.peak)} kt</b>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

export function StormTab() {
  const id = useTropicalStore((s) => s.storm);
  const setStorm = useTropicalStore((s) => s.setStorm);
  const { data, error } = useSwpc("trp-storms", loadStorms, 120);
  const storms = data?.storms ?? [];
  const active = storms.find((x) => x.id === id);
  const s = active ?? (id ? undefined : storms.find((x) => !x.invest) ?? storms[0]);
  useEffect(() => {
    if (!id && s) setStorm(s.id);
  }, [s, id, setStorm]);
  if (!data) return <Loading error={error} what="the active storms" />;
  // A storm that is not up now: one picked from a season or the record.
  if (id && !active && STORM_ID.test(id)) {
    return <PastStorm id={id} storms={storms} />;
  }
  if (!s) return <div className="spc-msg">No active tropical cyclones right now. The Season and Climatology tabs have the rest of the year and the record.</div>;
  const nhc = !!s.nhc?.bin;
  return (
    <div className="trp-stormtab">
      <div className="trp-picker">
        {storms.map((x) => (
          <button key={x.id} type="button" className={x.id === s.id ? "is-on" : ""} onClick={() => setStorm(x.id)}>
            <CatBadge cat={x.cat} />
            {x.name}
          </button>
        ))}
      </div>
      <header className="trp-head">
        <CatBadge cat={s.cat} big />
        <div>
          <h2>{s.invest ? s.name : `${typeName(s.type, s.vmax, s.basin)} ${s.name}`}</h2>
          <span>
            {s.code} · {s.agency} · {windText(s.vmax)} · {s.mslp ? `${Math.round(s.mslp)} mb` : "--"} · {motionText(s.nhc?.movementDir ?? s.dir, s.nhc?.movementSpeed ?? s.speed)}
          </span>
        </div>
        <button type="button" className="spc-mapbtn" onClick={() => flyToStorm(s)}>
          <Crosshair size={13} /> Go to it on the map
        </button>
      </header>
      <div className="spc-grid spc-grid--overview">
        <div className="spc-col spc-col--main">
          <IntensityCard id={s.id} />
          <GuidanceCard s={s} />
          {nhc && <GraphicsCard s={s} />}
          {hasFloater(s.id) && <SatelliteCard s={s} />}
        </div>
        <div className="spc-col spc-col--side">
          <FactsCard s={s} />
          <ProductsCard s={s} />
        </div>
      </div>
    </div>
  );
}
