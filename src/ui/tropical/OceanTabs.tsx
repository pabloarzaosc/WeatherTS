import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Map as MapIcon } from "lucide-react";

import { ENSO_PICTURES, MJO_PHASES, OCEAN_PICTURES, SST_FIRST_DAY, loadEnso, loadMjo, sstLatestDay, type Mjo, type Picture } from "../../lib/tropical/data";
import { useAppStore } from "../../store/useAppStore";
import { useTropicalStore } from "../../store/useTropicalStore";
import { ZoomImage } from "../space/ImageLoop";
import { TimeStack, type ChartPanel } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { SST_LAYER, showOnMap } from "./mapActions";

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
const month = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 15);
const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
const signed = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const monthly = (rows: [string, number][]) => ({
  t: Float64Array.from(rows.map((r) => month(r[0]))),
  v: Float64Array.from(rows.map((r) => r[1])),
});
const columns = (rows: [string, ...number[]][], i: number, toT: (s: string) => number) => ({
  t: Float64Array.from(rows.map((r) => toT(r[0]))),
  v: Float64Array.from(rows.map((r) => r[i] as number)),
});

/** A picture product picker: thumbnails' names down the side, the picture big. */
function PictureCard({ title, pictures }: { title: string; pictures: Picture[] }) {
  const [id, setId] = useState(pictures[0].id);
  const p = pictures.find((x) => x.id === id) ?? pictures[0];
  const bust = Math.floor(Date.now() / 3_600_000);
  return (
    <Card
      className="spc-card--viewer"
      title={title}
      extra={
        <select className="trp-select" value={id} onChange={(e) => setId(e.target.value)}>
          {pictures.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      }
    >
      {p.about && (
        <div className="spc-viewer__tools">
          <span>{p.about}</span>
        </div>
      )}
      <div className="spc-loop">
        <ZoomImage key={p.id} src={`${p.url}?${bust}`} alt={p.label} />
      </div>
    </Card>
  );
}

function phase(v: number): string {
  if (v >= 1.5) return "Strong El Niño";
  if (v >= 0.5) return "El Niño";
  if (v <= -1.5) return "Strong La Niña";
  if (v <= -0.5) return "La Niña";
  return "Neutral";
}
const phaseColor = (v: number) => (v >= 0.5 ? "#ff6b5e" : v <= -0.5 ? "#5aa9ff" : "var(--text)");
const ensoBar = (v: number) => (v >= 0.5 ? "#ff6b5e" : v <= -0.5 ? "#5aa9ff" : "#8e8e8e");

/** How far back a chart reaches: a number of years, or the whole record. */
type Span = number | "all";
const spanFrom = (span: Span, first: number, last: number) => (span === "all" ? first : Math.max(first, last - span * YEAR));

// ---------------------------------------------------------------- the MJO

const PHASE_COLORS = ["", "#a879ff", "#5aa9ff", "#38bdf8", "#4ade80", "#a3e635", "#ffc140", "#ff8f20", "#ff6b5e"];
const MONTH_COLORS = ["#5aa9ff", "#a879ff", "#ff6b5e", "#4ade80", "#ffc140", "#38bdf8", "#ff8f20", "#d08cff", "#a3e635", "#f472b6", "#2dd4bf", "#facc15"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The Wheeler-Hendon diagram: RMM1 across, RMM2 up, the eight phases round
 *  the circle (amplitude 1 inside it is a weak MJO), and the path of the days
 *  up to `end`, one dot a day, coloured by month. */
function PhaseDiagram({ days, end, length }: { days: Mjo["days"]; end: number; length: number }) {
  const S = 300;
  const C = S / 2;
  const K = 34; // px per unit, so +-4 fits
  const x = (v: number) => C + Math.max(-4.2, Math.min(4.2, v)) * K;
  const y = (v: number) => C - Math.max(-4.2, Math.min(4.2, v)) * K;
  const seg = days.slice(Math.max(0, end - length + 1), end + 1);
  const last = seg[seg.length - 1];
  const diag = 4.3 * K;
  const months = [...new Set(seg.map((d) => Number(d[0].slice(5, 7)) - 1))];
  return (
    <div className="trp-mjo">
      <svg viewBox={`0 0 ${S} ${S}`} className="trp-mjo__svg" role="img" aria-label="MJO phase diagram">
        <rect x={C - 4.3 * K} y={C - 4.3 * K} width={8.6 * K} height={8.6 * K} className="trp-mjo__frame" />
        <line x1={C - diag} y1={C} x2={C + diag} y2={C} className="trp-mjo__grid" />
        <line x1={C} y1={C - diag} x2={C} y2={C + diag} className="trp-mjo__grid" />
        <line x1={C - diag} y1={C - diag} x2={C + diag} y2={C + diag} className="trp-mjo__grid" />
        <line x1={C - diag} y1={C + diag} x2={C + diag} y2={C - diag} className="trp-mjo__grid" />
        <circle cx={C} cy={C} r={K} className="trp-mjo__weak" />
        {/* Phase numbers in the middle of each octant. */}
        {[1, 2, 3, 4, 5, 6, 7, 8].map((p) => {
          const a = ((-180 + 22.5 + (p - 1) * 45) * Math.PI) / 180;
          return (
            <text key={p} x={C + Math.cos(a) * 3.7 * K} y={C - Math.sin(a) * 3.7 * K} className="trp-mjo__phase">
              {p}
            </text>
          );
        })}
        <text x={C} y={C + 4.3 * K - 5} className="trp-mjo__side">Indian Ocean</text>
        <text x={C} y={C - 4.3 * K + 12} className="trp-mjo__side">Western Pacific</text>
        <text x={C + 4.3 * K - 5} y={C} className="trp-mjo__side" transform={`rotate(90 ${C + 4.3 * K - 5} ${C})`}>
          Maritime Continent
        </text>
        <text x={C - 4.3 * K + 5} y={C} className="trp-mjo__side" transform={`rotate(-90 ${C - 4.3 * K + 5} ${C})`}>
          W. Hemisphere, Africa
        </text>
        <polyline points={seg.map((d) => `${x(d[1])},${y(d[2])}`).join(" ")} className="trp-mjo__path" />
        {seg.map((d, i) => (
          <circle key={d[0]} cx={x(d[1])} cy={y(d[2])} r={i === seg.length - 1 ? 4.5 : 2.2} fill={MONTH_COLORS[Number(d[0].slice(5, 7)) - 1]} className={i === seg.length - 1 ? "trp-mjo__now" : undefined}>
            <title>{`${d[0]}: phase ${d[4]}, amplitude ${d[3].toFixed(2)}`}</title>
          </circle>
        ))}
        {seg[0] && (
          <text x={x(seg[0][1]) + 5} y={y(seg[0][2]) - 5} className="trp-mjo__label">
            {seg[0][0].slice(5)}
          </text>
        )}
        {last && (
          <text x={x(last[1]) + 7} y={y(last[2]) + 4} className="trp-mjo__label trp-mjo__label--now">
            {last[0].slice(5)}
          </text>
        )}
      </svg>
      <div className="trp-mjo__key">
        {months.map((m) => (
          <span key={m}>
            <i style={{ background: MONTH_COLORS[m] }} />
            {MONTHS[m]}
          </span>
        ))}
      </div>
    </div>
  );
}

function MjoCard() {
  const { data, error } = useSwpc("trp-mjo", loadMjo, 21600);
  const [span, setSpan] = useState<Span>(1);
  const [length, setLength] = useState(40);
  // The last day the diagram shows: picked on the slider, or under the cursor.
  const [end, setEnd] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const days = data?.days ?? [];
  const lastIdx = days.length - 1;
  const shown = hover ?? end ?? lastIdx;
  const ts = useMemo(() => Float64Array.from(days.map((d) => day(d[0]))), [days]);
  const indexAt = (t: number) => {
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const panels = useMemo<ChartPanel[]>(() => {
    if (!days.length) return [];
    return [
      {
        id: "amp",
        title: "MJO amplitude",
        units: "RMM",
        include: [0, 2],
        weight: 1.3,
        bands: [{ from: 1, to: 20, color: "rgba(255,193,64,0.07)", label: "Active" }],
        lines: [{ y: 1, color: "rgba(255,193,64,0.7)", label: "1" }],
        series: [{ label: "Amplitude", color: "#ffc140", data: columns(days, 3, day), width: 1.4, fmt: (v) => v.toFixed(2) }],
      },
      {
        id: "phase",
        title: "Phase (where the convection is)",
        units: "phase",
        y: [0.5, 8.5],
        step: 1,
        series: [
          {
            label: "Phase",
            color: "#a879ff",
            kind: "dots",
            data: columns(days, 4, day),
            colorOf: (v) => PHASE_COLORS[Math.round(v)] ?? "#a879ff",
            fmt: (v) => `${Math.round(v)}: ${MJO_PHASES[Math.round(v)] ?? ""}`,
          },
        ],
        fmt: (v) => String(Math.round(v)),
      },
      {
        id: "rmm",
        title: "RMM1 and RMM2",
        units: "RMM",
        symmetric: true,
        series: [
          { label: "RMM1", color: "#5aa9ff", data: columns(days, 1, day), fmt: (v) => signed(v, 2) },
          { label: "RMM2", color: "#ff6b5e", data: columns(days, 2, day), fmt: (v) => signed(v, 2) },
        ],
        fmt: (v) => signed(v, 2),
      },
    ];
  }, [days]);
  if (!data) return <Card title="Madden-Julian Oscillation"><Loading error={error} what="the MJO index" /></Card>;
  const lastT = ts[lastIdx];
  const domain: [number, number] = [spanFrom(span, ts[0], lastT), lastT + 2 * DAY];
  const cur = days[shown];
  return (
    <Card
      className="spc-card--fill trp-card--mjo"
      title="Madden-Julian Oscillation"
      extra={
        <Seg
          value={span}
          onChange={setSpan}
          options={[
            { id: 0.25 as Span, label: "90 d" },
            { id: 1 as Span, label: "1 yr" },
            { id: 5 as Span, label: "5 yr" },
            { id: "all" as Span, label: "Since 1991" },
          ]}
        />
      }
    >
      <div className="trp-mjo__wrap">
        <div className="trp-mjo__side-col">
          <PhaseDiagram days={days} end={shown} length={length} />
          <div className="trp-mjo__ctl">
            <div className="trp-mjo__now-row">
              <b>{cur?.[0]}</b>
              <span>
                Phase {cur?.[4]}, amplitude {cur?.[3].toFixed(2)}
                {cur && cur[3] < 1 ? " (weak)" : ""}
              </span>
            </div>
            <div className="trp-row">
              <button type="button" className="spc-mapbtn" onClick={() => setEnd(Math.max(0, shown - length))} title={`${length} days back`}>
                <ChevronLeft size={13} />
              </button>
              <input
                type="range"
                className="trp-mjo__range"
                min={length - 1}
                max={lastIdx}
                value={shown}
                onChange={(e) => setEnd(Number(e.target.value))}
                aria-label="Last day on the diagram"
              />
              <button type="button" className="spc-mapbtn" onClick={() => setEnd(Math.min(lastIdx, shown + length))} title={`${length} days on`}>
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="trp-row">
              <input
                type="date"
                className="trp-select"
                min={days[0][0]}
                max={days[lastIdx][0]}
                value={cur?.[0] ?? ""}
                onChange={(e) => e.target.value && setEnd(indexAt(day(e.target.value)))}
              />
              <select className="trp-select" value={length} onChange={(e) => setLength(Number(e.target.value))} title="Days on the diagram">
                {[20, 40, 60, 90].map((n) => (
                  <option key={n} value={n}>
                    {n} days
                  </option>
                ))}
              </select>
              <button type="button" className="spc-mapbtn" onClick={() => setEnd(null)} disabled={end == null}>
                Latest
              </button>
            </div>
            <p className="spc-note">{MJO_PHASES[cur?.[4] ?? 0] ? `Convection over the ${MJO_PHASES[cur![4]]}.` : ""} Point at the chart to move the diagram through time.</p>
          </div>
        </div>
        <TimeStack panels={panels} domain={domain} onHover={(t) => setHover(t == null ? null : Math.min(lastIdx, indexAt(t)))} />
      </div>
      <p className="spc-note">
        PSL's real-time OLR MJO index (ROMI) every day since 1991, on the RMM axes. An active MJO in phases 8 to 2 favours Atlantic and East Pacific storms; in
        phases 4 to 7 it favours the West Pacific.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- ENSO

export function EnsoTab() {
  const { data, error } = useSwpc("trp-enso", loadEnso, 21600);
  const [wSpan, setWSpan] = useState<Span>(2);
  const [span, setSpan] = useState<Span>(30);
  const weekly = useMemo<ChartPanel[]>(() => {
    if (!data) return [];
    const rows = data.weekly as unknown as [string, number, number, number, number][];
    return [
      {
        id: "nino",
        title: "Weekly Niño region SST anomalies",
        units: "°C",
        symmetric: true,
        bands: [
          { from: 0.5, to: 10, color: "rgba(255,107,94,0.07)", label: "El Niño" },
          { from: -10, to: -0.5, color: "rgba(90,169,255,0.07)", label: "La Niña" },
        ],
        lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
        series: [
          { label: "Niño 3.4", color: "#ff6b5e", data: columns(rows, 3, day), width: 2.2 },
          { label: "Niño 1+2", color: "#ffc140", data: columns(rows, 1, day) },
          { label: "Niño 3", color: "#a879ff", data: columns(rows, 2, day) },
          { label: "Niño 4", color: "#5aa9ff", data: columns(rows, 4, day) },
        ],
        fmt: (v) => signed(v),
      },
    ];
  }, [data]);
  const longPanels = useMemo<ChartPanel[]>(() => {
    if (!data) return [];
    const oni = data.oni;
    return [
      {
        id: "oni",
        title: "Oceanic Niño Index (3-month Niño 3.4), 1950 on",
        units: "°C",
        symmetric: true,
        weight: 1.3,
        lines: [
          { y: 0.5, color: "rgba(255,107,94,0.6)", label: "+0.5" },
          { y: -0.5, color: "rgba(90,169,255,0.6)", label: "-0.5" },
        ],
        series: [
          {
            label: "ONI",
            color: "#ff6b5e",
            kind: "bars",
            barMs: 28 * DAY,
            data: { t: Float64Array.from(oni.map((r) => month(r[0]))), v: Float64Array.from(oni.map((r) => r[2])) },
            colorOf: ensoBar,
            fmt: (v) => signed(v, 2),
          },
        ],
      },
      {
        id: "n34",
        title: "Niño 3.4 anomaly, monthly, 1870 on (HadISST)",
        units: "°C",
        symmetric: true,
        lines: [
          { y: 0.5, color: "rgba(255,107,94,0.5)" },
          { y: -0.5, color: "rgba(90,169,255,0.5)" },
        ],
        series: [{ label: "Niño 3.4", color: "#ff6b5e", kind: "bars", barMs: 28 * DAY, data: monthly(data.nino34long ?? []), colorOf: ensoBar, fmt: (v) => signed(v, 2) }],
        empty: "PSL's long Niño 3.4 record is not answering.",
      },
      {
        id: "mei",
        title: "Multivariate ENSO Index v2, 1979 on",
        units: "MEI",
        symmetric: true,
        lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
        series: [{ label: "MEI", color: "#d08cff", data: monthly(data.mei), width: 1.6, fmt: (v) => signed(v, 2) }],
      },
    ];
  }, [data]);
  if (!data) return <Loading error={error} what="the ENSO indices" />;
  const oni = data.oni[data.oni.length - 1];
  const wk = data.weekly[data.weekly.length - 1];
  const mei = data.mei[data.mei.length - 1];
  const wFirst = day(data.weekly[0][0]);
  const wLast = day(wk[0]);
  const wDomain: [number, number] = [spanFrom(wSpan, wFirst, wLast), wLast + 7 * DAY];
  const lFirst = data.nino34long?.length ? month(data.nino34long[0][0]) : month(data.oni[0][0]);
  const lDomain: [number, number] = [spanFrom(span, lFirst, Date.now()), Date.now() + 60 * DAY];
  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <div className="trp-kpis trp-kpis--card">
          <div>
            <span>ENSO now</span>
            <b style={{ color: phaseColor(oni[2]) }}>{phase(oni[2])}</b>
          </div>
          <div>
            <span>ONI ({oni[0]})</span>
            <b style={{ color: phaseColor(oni[2]) }}>{signed(oni[2], 2)}</b>
          </div>
          <div>
            <span>Niño 3.4 (week of {wk[0]})</span>
            <b style={{ color: phaseColor(wk[3]) }}>{signed(wk[3])}</b>
          </div>
          <div>
            <span>MEI v2 ({mei[0]})</span>
            <b style={{ color: phaseColor(mei[1]) }}>{signed(mei[1], 2)}</b>
          </div>
        </div>
        <Card
          className="spc-card--fill trp-card--weekly"
          title="Niño regions, week by week"
          extra={
            <Seg
              value={wSpan}
              onChange={setWSpan}
              options={[
                { id: 2 as Span, label: "2 yr" },
                { id: 5 as Span, label: "5 yr" },
                { id: 10 as Span, label: "10 yr" },
                { id: "all" as Span, label: `Since ${new Date(wFirst).getUTCFullYear()}` },
              ]}
            />
          }
        >
          <TimeStack panels={weekly} domain={wDomain} />
        </Card>
        <Card
          className="spc-card--fill trp-card--long"
          title="ONI, Niño 3.4 and MEI"
          extra={
            <Seg
              value={span}
              onChange={setSpan}
              options={[
                { id: 10 as Span, label: "10 yr" },
                { id: 30 as Span, label: "30 yr" },
                { id: 75 as Span, label: "75 yr" },
                { id: "all" as Span, label: "Since 1870" },
              ]}
            />
          }
        >
          <TimeStack panels={longPanels} domain={lDomain} />
          <p className="spc-note">
            El Niño raises wind shear over the Atlantic and quiets its seasons while it feeds the Central and East Pacific; La Niña does the reverse. Drag across a
            chart to zoom into any stretch of it.
          </p>
        </Card>
        <MjoCard />
      </div>
      <div className="spc-col spc-col--side">
        <PictureCard title="CPC: ENSO, the ocean below and the MJO" pictures={ENSO_PICTURES} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the ocean

/** The day the SST map shows, with a step back or on and a jump to the newest. */
export function SstDay() {
  const date = useTropicalStore((s) => s.sstDate);
  const latest = sstLatestDay();
  const cur = date ?? latest;
  const set = (d: string | null) => useTropicalStore.getState().set({ sstDate: d && d < latest ? (d < SST_FIRST_DAY ? SST_FIRST_DAY : d) : null });
  const step = (n: number) => set(new Date(day(cur) + n * DAY).toISOString().slice(0, 10));
  return (
    <div className="trp-sstday">
      <button type="button" className="spc-mapbtn" onClick={() => step(-1)} title="The day before">
        <ChevronLeft size={13} />
      </button>
      <input type="date" className="trp-select" min={SST_FIRST_DAY} max={latest} value={cur} onChange={(e) => e.target.value && set(e.target.value)} />
      <button type="button" className="spc-mapbtn" onClick={() => step(1)} disabled={!date} title="The day after">
        <ChevronRight size={13} />
      </button>
      <button type="button" className="spc-mapbtn" onClick={() => step(-365)} title="The same day a year before">
        -1 yr
      </button>
      <button type="button" className="spc-mapbtn" onClick={() => set(null)} disabled={!date}>
        Newest
      </button>
    </div>
  );
}

export function OceanTab() {
  const { data } = useSwpc("trp-enso", loadEnso, 21600);
  const sst = useTropicalStore((s) => s.sst);
  const on = useAppStore((s) => s.layers[SST_LAYER]?.visible ?? false);
  const [span, setSpan] = useState<Span>(45);
  const panels = useMemo<ChartPanel[]>(() => {
    if (!data) return [];
    const amo = data.amo ?? [];
    // A year's running mean over the noisy monthly AMO.
    const smooth = amo.map((r, i) => {
      const w = amo.slice(Math.max(0, i - 5), i + 7);
      return [r[0], w.reduce((a, x) => a + x[1], 0) / w.length] as [string, number];
    });
    return [
      {
        id: "tna",
        title: "Tropical North Atlantic SST anomaly, 1948 on",
        units: "°C",
        symmetric: true,
        lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
        series: [
          {
            label: "TNA",
            color: "#ff6b5e",
            kind: "bars",
            barMs: 28 * DAY,
            data: monthly(data.tna),
            colorOf: (v) => (v >= 0 ? "#ff6b5e" : "#5aa9ff"),
            fmt: (v) => signed(v, 2),
          },
        ],
      },
      {
        id: "amo",
        title: "Atlantic Multidecadal Oscillation, 1856 to 2023",
        units: "°C",
        symmetric: true,
        lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
        series: [
          { label: "AMO, monthly", color: "#8e8e8e", data: monthly(amo), width: 0.8, fmt: (v) => signed(v, 2) },
          { label: "12-month mean", color: "#ffc140", data: monthly(smooth), width: 2, fmt: (v) => signed(v, 2) },
        ],
        empty: "PSL's AMO record is not answering.",
      },
    ];
  }, [data]);
  const first = data?.amo?.length ? month(data.amo[0][0]) : Date.UTC(1948, 0, 1);
  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <PictureCard title="NOAA Coral Reef Watch, 5 km daily" pictures={OCEAN_PICTURES} />
        <Card
          className="spc-card--fill trp-card--tna"
          title="Atlantic warmth"
          extra={
            <Seg
              value={span}
              onChange={setSpan}
              options={[
                { id: 15 as Span, label: "15 yr" },
                { id: 45 as Span, label: "45 yr" },
                { id: 78 as Span, label: "Since 1948" },
                { id: "all" as Span, label: "Since 1856" },
              ]}
            />
          }
        >
          {data ? <TimeStack panels={panels} domain={[spanFrom(span, first, Date.now()), Date.now() + 30 * DAY]} /> : <Loading what="the Atlantic indices" />}
          <p className="spc-note">
            A warm tropical Atlantic, the main development region especially, is one of the two big levers on an Atlantic season; ENSO is the other. The AMO's warm
            phases (1930s-60s, 1995 on) brought the busy eras.
          </p>
        </Card>
      </div>
      <div className="spc-col spc-col--side">
        <Card title="Sea surface temperature on the map">
          <p className="spc-note spc-note--top">
            NASA's GHRSST MUR analysis, 1 km, from GIBS: the temperature itself, or its departure from normal, on any day since June 2002. Hurricanes need about
            26.5 °C under them.
          </p>
          <div className="trp-mapbtns">
            <Seg value={sst} onChange={(v) => useTropicalStore.getState().set({ sst: v })} options={[{ id: "sst" as const, label: "Temperature" }, { id: "anomaly" as const, label: "Anomaly" }]} />
            <button type="button" className={`spc-mapbtn${on ? " is-on" : ""}`} onClick={() => (on ? useAppStore.getState().setLayerVisible(SST_LAYER, false) : showOnMap(SST_LAYER))}>
              <MapIcon size={13} /> {on ? "Hide on the map" : "Show on the map"}
            </button>
          </div>
          <SstDay />
        </Card>
      </div>
    </div>
  );
}
