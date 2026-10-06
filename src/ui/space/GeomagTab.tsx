import { useMemo, useState } from "react";

import { RANGES, load27Day, load45Day, loadBoulderK, loadDst, loadGeospace, loadKp1m, loadKp3h, loadMagnetometer, rangeMs, type Sat, type Series } from "../../lib/space/data";
import { useSpaceStore } from "../../store/useSpaceStore";
import { useNowDomain } from "./OverviewTab";
import { TimeStack, type ChartPanel } from "./TimeStack";
import { C, Card, SCALE_COLORS, SCALE_NAMES, Seg, kpColor, kpText, useSwpc } from "./common";
import { kpPanel } from "./panels";

const DAY = 86_400_000;

const G_TABLE: { g: number; kp: string; aurora: string; effects: string }[] = [
  { g: 1, kp: "5", aurora: "~60° geomagnetic (northern Michigan, Maine)", effects: "Weak power grid fluctuations, minor satellite effects." },
  { g: 2, kp: "6", aurora: "~55° (New York, Idaho)", effects: "High-latitude transformer alarms, HF fades at high latitudes." },
  { g: 3, kp: "7", aurora: "~50° (Illinois, Oregon)", effects: "Voltage corrections, intermittent GPS and HF problems." },
  { g: 4, kp: "8, 9-", aurora: "~45° (Alabama, northern California)", effects: "Widespread voltage control problems, HF sporadic, GPS degraded for hours." },
  { g: 5, kp: "9", aurora: "~40° (Florida, southern Texas)", effects: "Grid collapse possible, HF out for days, low-frequency navigation out for hours." },
];

export function GeomagTab() {
  const range = useSpaceStore((s) => s.range);
  const setRange = useSpaceStore((s) => s.setRange);
  const [sat, setSat] = useState<Sat>("primary");
  const kp = useSwpc("kp3h", loadKp3h, 300);
  const kp1 = useSwpc("kp1m", loadKp1m);
  const geo = useSwpc("geospace", loadGeospace, 300);
  const dst = useSwpc("dst", loadDst, 300);
  const mag = useSwpc(`mag-${range}-${sat}`, () => loadMagnetometer(range, sat));
  const bk = useSwpc("boulderk", loadBoulderK);
  const o27 = useSwpc("27day", load27Day, 3600);
  const o45 = useSwpc("45day", load45Day, 3600);
  const outDomain = useMemo<[number, number]>(() => {
    const end = o45.data?.ap.t.length ? o45.data.ap.t[o45.data.ap.t.length - 1] + DAY : Date.now() + 45 * DAY;
    return [Date.now() - 2 * DAY, end];
  }, [o45.data]);
  const outlook = useMemo<ChartPanel[]>(() => {
    const d = o27.data ?? [];
    const ser = (v: number[]): Series => ({ t: Float64Array.from(d.map((x) => x.t)), v: Float64Array.from(v) });
    const e = { t: new Float64Array(), v: new Float64Array() };
    return [
      {
        id: "o-kp",
        title: "Largest Kp each day (27-day outlook)",
        units: "Kp",
        y: [0, 9],
        step: 3,
        tickFmt: (v) => String(v),
        lines: [{ y: 5, color: SCALE_COLORS[1], label: "G1" }],
        series: [{ label: "Kp", color: "#4caf50", kind: "bars", barMs: DAY, data: ser(d.map((x) => x.kp)), colorOf: (v) => kpColor(v), fmt: (v) => v.toFixed(0) }],
      },
      {
        id: "o-ap",
        title: "Planetary A index",
        units: "Ap",
        include: [0],
        series: [
          { label: "27-day outlook", color: C.dst, data: ser(d.map((x) => x.ap)), kind: "step", width: 1.6 },
          { label: "45-day forecast", color: C.model, data: o45.data?.ap ?? e, kind: "step", dash: [4, 3] },
        ],
        fmt: (v) => v.toFixed(0),
      },
    ];
  }, [o27.data, o45.data]);

  const weekDomain = useMemo<[number, number]>(() => {
    if (!kp.data?.length) return [Date.now() - 7 * DAY, Date.now() + 3 * DAY];
    return [kp.data[0].t, kp.data[kp.data.length - 1].t + 3 * 3_600_000];
  }, [kp.data]);
  const week = useMemo<ChartPanel[]>(() => {
    const e = { t: new Float64Array(), v: new Float64Array() };
    return [
      kpPanel(kp.data ?? null, [
        { label: "Geospace model Kp", color: C.model, data: geo.data?.kp ?? e, width: 1.2, fmt: (v) => v.toFixed(1) },
        { label: "Estimated Kp (1 min)", color: "var(--sx-wind)", data: kp1.data ?? e, width: 1.4, fmt: kpText },
      ], 1.4),
      {
        id: "dst",
        title: "Disturbance storm time (Dst)",
        units: "nT",
        include: [0, -50],
        lines: [
          { y: -50, color: SCALE_COLORS[2], label: "-50" },
          { y: -100, color: SCALE_COLORS[3], label: "-100" },
          { y: -250, color: SCALE_COLORS[5], label: "-250" },
        ],
        series: [
          { label: "Kyoto real-time", color: C.dst, data: dst.data ?? e, width: 1.6, kind: "step" },
          { label: "Geospace model", color: C.model, data: geo.data?.dst ?? e },
        ],
        fmt: (v) => v.toFixed(0),
      },
    ];
  }, [kp.data, kp1.data, geo.data, dst.data]);

  const magDomain = useNowDomain(rangeMs(range), mag.at);
  const magPanels = useMemo<ChartPanel[]>(() => {
    const e = { t: new Float64Array(), v: new Float64Array() };
    return [
      {
        id: "goesmag",
        title: `GOES${mag.data?.satellite ? `-${mag.data.satellite}` : ""} magnetometer`,
        units: "nT",
        weight: 1.4,
        series: [
          { label: "Hp", color: "#ff6b5e", data: mag.data?.hp ?? e, width: 1.5 },
          { label: "He", color: "#4ade80", data: mag.data?.he ?? e },
          { label: "Hn", color: "#5aa9ff", data: mag.data?.hn ?? e },
          { label: "Total", color: "var(--sx-wind)", data: mag.data?.total ?? e, off: true },
        ],
        fmt: (v) => v.toFixed(1),
      },
      {
        id: "boulder",
        title: "Boulder K index (1 min)",
        units: "K",
        y: [0, 9],
        tickFmt: (v) => String(v),
        lines: [{ y: 5, color: SCALE_COLORS[1], label: "5" }],
        series: [{ label: "Boulder K", color: "#f6b93b", data: bk.data ?? e, kind: "step" }],
        fmt: (v) => v.toFixed(2),
      },
    ];
  }, [mag.data, bk.data]);

  return (
    <div className="spc-grid spc-grid--geomag">
      <Card className="spc-card--fill" title="Kp and Dst: the last week and the forecast">
        <TimeStack panels={week} domain={weekDomain} />
      </Card>
      <Card
        className="spc-card--fill"
        title="Magnetic field at geostationary orbit and Boulder"
        extra={
          <div className="spc-card__tools">
            <Seg label="Satellite" value={sat} onChange={setSat} options={[{ id: "primary", label: "Primary" }, { id: "secondary", label: "Secondary" }]} />
            <Seg label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
          </div>
        }
      >
        <TimeStack panels={magPanels} domain={magDomain} />
        <p className="spc-note">Hp drops sharply, or turns negative, when the magnetopause is pushed inside geostationary orbit by a strong solar wind.</p>
      </Card>
      <Card className="spc-card--fill spc-card--outlook" title="The next weeks" extra={<span className="spc-card__meta">SWPC 27-day outlook and 45-day forecast, issued daily</span>}>
        <TimeStack panels={outlook} domain={outDomain} />
      </Card>
      <Card title="The G scale" className="spc-card--gtable">
        <table className="spc-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Kp</th>
              <th>Aurora seen overhead to about</th>
              <th>Effects</th>
            </tr>
          </thead>
          <tbody>
            {G_TABLE.map((r) => (
              <tr key={r.g}>
                <td>
                  <span className="spc-scale" style={{ background: SCALE_COLORS[r.g], color: r.g >= 4 ? "#fff" : "#1a1400" }}>
                    G{r.g}
                  </span>{" "}
                  {SCALE_NAMES[r.g]}
                </td>
                <td className="mono">{r.kp}</td>
                <td>{r.aurora}</td>
                <td>{r.effects}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
