import { useMemo, useState } from "react";

import { load27Day, load45Day, loadF107, loadSolarCycle, type Series } from "../../lib/space/data";
import { TimeStack, type ChartPanel } from "./TimeStack";
import { Card, Seg, latest, useSwpc } from "./common";

type Span = "c25" | "4c" | "all";
const SPANS: { id: Span; label: string; from: number }[] = [
  { id: "c25", label: "Cycle 25", from: Date.UTC(2019, 0, 1) },
  { id: "4c", label: "Last 4 cycles", from: Date.UTC(1986, 0, 1) },
  { id: "all", label: "Since 1749", from: Date.UTC(1749, 0, 1) },
];

const ser = (t: number[], v: (number | null)[]): Series => ({ t: Float64Array.from(t), v: Float64Array.from(v.map((x) => (x == null ? NaN : x))) });

export function CycleTab() {
  const cyc = useSwpc("cycle", loadSolarCycle, 3600);
  const f107 = useSwpc("f107", loadF107, 1800);
  const o27 = useSwpc("27day", load27Day, 3600);
  const o45 = useSwpc("45day", load45Day, 3600);
  const [span, setSpan] = useState<Span>("c25");

  const domain = useMemo<[number, number]>(() => {
    const end = cyc.data?.predicted.length ? cyc.data.predicted[cyc.data.predicted.length - 1].t : Date.UTC(2031, 0, 1);
    return [SPANS.find((s) => s.id === span)!.from, end];
  }, [span, cyc.data]);

  const panels = useMemo<ChartPanel[]>(() => {
    const o = cyc.data?.observed ?? [];
    const p = cyc.data?.predicted ?? [];
    const ot = o.map((r) => r.t);
    const pt = p.map((r) => r.t);
    return [
      {
        id: "ssn",
        title: "Sunspot number",
        units: "SSN",
        include: [0],
        weight: 1.3,
        series: [
          { label: "Monthly", color: "var(--text-faint)", data: ser(ot, o.map((r) => r.ssn)), width: 1 },
          { label: "Smoothed", color: "#f6b93b", data: ser(ot, o.map((r) => r.smoothed)), width: 2.2 },
          { label: "Predicted", color: "#6c9dff", data: ser(pt, p.map((r) => r.ssn)), width: 2, dash: [5, 3] },
          { label: "High", color: "rgba(108,157,255,0.55)", data: ser(pt, p.map((r) => r.hi)), dash: [2, 3] },
          { label: "Low", color: "rgba(108,157,255,0.55)", data: ser(pt, p.map((r) => r.lo)), dash: [2, 3] },
        ],
        fmt: (v) => v.toFixed(1),
      },
      {
        id: "f107m",
        title: "F10.7 cm radio flux",
        units: "sfu",
        include: [60],
        series: [
          { label: "Monthly", color: "var(--text-faint)", data: ser(ot, o.map((r) => r.f107)), width: 1 },
          { label: "Smoothed", color: "#ff7ab6", data: ser(ot, o.map((r) => r.f107s)), width: 2.2 },
          { label: "Predicted", color: "#6c9dff", data: ser(pt, p.map((r) => r.f107)), width: 2, dash: [5, 3] },
          { label: "High", color: "rgba(108,157,255,0.55)", data: ser(pt, p.map((r) => r.f107hi)), dash: [2, 3] },
          { label: "Low", color: "rgba(108,157,255,0.55)", data: ser(pt, p.map((r) => r.f107lo)), dash: [2, 3] },
        ],
        fmt: (v) => v.toFixed(0),
      },
    ];
  }, [cyc.data]);

  const dailyDomain = useMemo<[number, number]>(() => {
    const t = f107.data?.series.t;
    const f = o45.data?.f107.t;
    const end = f?.length ? f[f.length - 1] + 86_400_000 : Date.now() + 27 * 86_400_000;
    if (!t?.length) return [Date.now() - 30 * 86_400_000, end];
    return [t[0], end];
  }, [f107.data, o45.data]);
  const daily = useMemo<ChartPanel[]>(
    () => [
      {
        id: "f107d",
        title: "F10.7, daily noon reading and the outlook",
        units: "sfu",
        series: [
          { label: "Observed", color: "#ff7ab6", data: f107.data?.series ?? { t: new Float64Array(), v: new Float64Array() }, kind: "step", width: 1.6 },
          {
            label: "27-day outlook",
            color: "#6c9dff",
            data: { t: Float64Array.from((o27.data ?? []).map((d) => d.t)), v: Float64Array.from((o27.data ?? []).map((d) => d.f107)) },
            kind: "step",
            dash: [5, 3],
          },
          { label: "45-day forecast", color: "#d08cff", data: o45.data?.f107 ?? { t: new Float64Array(), v: new Float64Array() }, kind: "step", dash: [2, 3] },
        ],
        lines: f107.data?.mean90 ? [{ y: f107.data.mean90, color: "rgba(200,200,200,0.6)", label: "90d" }] : [],
        fmt: (v) => v.toFixed(0),
      },
    ],
    [f107.data, o27.data, o45.data],
  );

  const lastSmoothed = cyc.data?.observed.filter((r) => r.smoothed != null).pop();
  const maxPred = cyc.data?.predicted.length ? cyc.data.predicted.reduce((a, b) => (b.ssn > a.ssn ? b : a)) : null;
  const ssnNow = latest(panels[0].series[0].data);

  return (
    <div className="spc-grid spc-grid--cycle">
      <Card
        className="spc-card--fill"
        title="The solar cycle"
        extra={
          <div className="spc-card__tools">
            <span className="spc-card__meta">
              {ssnNow ? `Last month ${ssnNow.v.toFixed(0)}` : ""}
              {lastSmoothed?.smoothed != null ? ` · smoothed ${lastSmoothed.smoothed.toFixed(0)}` : ""}
              {maxPred ? ` · NOAA panel predicts ${maxPred.ssn.toFixed(0)} by ${new Date(maxPred.t).getUTCFullYear()}` : ""}
            </span>
            <Seg label="Span" value={span} onChange={setSpan} options={SPANS.map((s) => ({ id: s.id, label: s.label }))} />
          </div>
        }
      >
        <TimeStack panels={panels} domain={domain} now />
      </Card>
      <Card className="spc-card--fill spc-card--short" title="Radio flux: the last month and the next 45 days" extra={f107.data?.latest != null && <span className="spc-card__meta">Today {f107.data.latest.toFixed(0)} sfu · 90-day mean {f107.data.mean90?.toFixed(0) ?? "--"}</span>}>
        <TimeStack panels={daily} domain={dailyDomain} />
      </Card>
    </div>
  );
}
