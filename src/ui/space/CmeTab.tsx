import { useMemo, useState } from "react";
import { Bell } from "lucide-react";

import { loadAlerts, loadEnlil, loadFrames } from "../../lib/space/data";
import { useSpaceStore } from "../../store/useSpaceStore";
import { ImageLoop } from "./ImageLoop";
import { TimeStack, fmtUtc, type ChartPanel, type XBand } from "./TimeStack";
import { C, Card, Seg, useSwpc } from "./common";

const CORONAGRAPHS = [
  { id: "lasco-c2", label: "LASCO C2", path: "/products/animations/lasco-c2.json" },
  { id: "lasco-c3", label: "LASCO C3", path: "/products/animations/lasco-c3.json" },
  { id: "ccor1", label: "CCOR-1", path: "/products/animations/ccor1/ccor1.json" },
  { id: "ccor1-diff", label: "CCOR-1 diff", path: "/products/animations/ccor1-diff/ccor1-diff.json" },
];

/** Alerts that speak of a CME on its way, or of the radio bursts that mark one leaving. */
const CME_RE = /CME|Coronal Mass|Type II|Type IV|Sudden Impulse|Geomagnetic Sudden/i;

export function CmeTab() {
  const enlilFrames = useSwpc("enlil-frames", () => loadFrames("/products/animations/enlil.json"), 600);
  const enlil = useSwpc("enlil", loadEnlil, 900);
  const [cg, setCg] = useState("lasco-c3");
  const cgp = CORONAGRAPHS.find((c) => c.id === cg)!;
  const cgFrames = useSwpc(`frames-${cgp.path}`, () => loadFrames(cgp.path), 300);
  const alerts = useSwpc("alerts", loadAlerts);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const domain = useMemo<[number, number]>(() => {
    const t = enlil.data?.speed.t;
    if (!t?.length) return [Date.now() - 2 * 86_400_000, Date.now() + 5 * 86_400_000];
    return [t[0], t[t.length - 1]];
  }, [enlil.data]);
  const xBands = useMemo<XBand[]>(() => (enlil.data?.cloud ?? []).map(([a, b]) => ({ from: a, to: b, color: "rgba(255,90,80,0.14)", label: "CME" })), [enlil.data]);
  const panels = useMemo<ChartPanel[]>(() => {
    const e = { t: new Float64Array(), v: new Float64Array() };
    const d = enlil.data;
    return [
      { id: "ev", title: "Speed at Earth (WSA-Enlil)", units: "km/s", include: [300, 600], series: [{ label: "Radial speed", color: C.speed, data: d?.speed ?? e, width: 1.6 }], fmt: (v) => v.toFixed(0) },
      { id: "en", title: "Density at Earth", units: "p/cm³", include: [0], series: [{ label: "Density", color: C.density, data: d?.density ?? e }], fmt: (v) => v.toFixed(1) },
      {
        id: "eb",
        title: "Radial field and polarity",
        units: "nT",
        symmetric: true,
        lines: [{ y: 0, color: "rgba(150,150,150,0.6)", dash: [2, 3] }],
        series: [
          { label: "Br", color: C.bx, data: d?.br ?? e },
          { label: "Polarity", color: C.phi, data: d?.polarity ?? e, off: true },
        ],
        fmt: (v) => v.toFixed(2),
      },
      { id: "et", title: "Temperature", units: "K", log: true, series: [{ label: "Temperature", color: C.temp, data: d?.temp ?? e }], fmt: (v) => `${(v / 1000).toFixed(0)}k` },
    ];
  }, [enlil.data]);
  const cmeAlerts = (alerts.data ?? []).filter((a) => CME_RE.test(a.text)).slice(0, 12);

  return (
    <div className="spc-grid spc-grid--cme">
      <Card className="spc-card--viewer" title="WSA-Enlil solar wind model" extra={<span className="spc-card__meta">Density and speed out to Earth, Mars and the STEREO spacecraft</span>}>
        <ImageLoop frames={enlilFrames.data} error={enlilFrames.error} title="WSA-Enlil" count={0} syncT={hoverT} startAt={Date.now()} href="https://www.swpc.noaa.gov/products/wsa-enlil-solar-wind-prediction" staleMs={5 * 86_400_000} />
      </Card>
      <Card className="spc-card--fill" title="Enlil at Earth" extra={<span className="spc-card__meta">Hover to step the movie; red shading is a modelled CME</span>}>
        <TimeStack panels={panels} domain={domain} xBands={xBands} onHover={setHoverT} />
      </Card>
      <Card className="spc-card--viewer" title="Coronagraphs" extra={<Seg label="Coronagraph" value={cg} onChange={setCg} options={CORONAGRAPHS.map((c) => ({ id: c.id, label: c.label }))} />}>
        <ImageLoop key={cg} frames={cgFrames.data} error={cgFrames.error} title={cgp.label} count={96} />
      </Card>
      <Card title="CME alerts and radio bursts" className="spc-card--list">
        <ul className="spc-alerts">
          {cmeAlerts.map((a) => (
            <li key={a.id} className={`is-${a.kind}`}>
              <button type="button" onClick={() => useSpaceStore.getState().pickAlert(a.id)}>
                <Bell size={12} />
                <span>
                  <b>{a.title}</b>
                  <small>
                    {a.code} · {fmtUtc(a.issued)}
                  </small>
                </span>
              </button>
            </li>
          ))}
          {alerts.data && !cmeAlerts.length && <li className="spc-msg">No CME alerts in SWPC's current list.</li>}
        </ul>
        <p className="spc-note">NASA's DONKI CME catalogue is offline while CCMC moves it; SWPC's alerts and the Enlil run are what is public now.</p>
      </Card>
    </div>
  );
}
