import { useMemo, useState } from "react";

import { RANGES, loadElectrons, loadEpam, loadFlares, loadProtons, loadXrays, rangeMs, type Flare, type Sat } from "../../lib/space/data";
import { useSpaceStore } from "../../store/useSpaceStore";
import { useNowDomain } from "./OverviewTab";
import { TimeStack, fmtUtc, type ChartPanel, type XBand } from "./TimeStack";
import { Card, Seg, useSwpc } from "./common";
import { electronPanel, epamPanel, protonPanel, xrayPanel } from "./panels";

const H = 3_600_000;

function flareTone(cls: string): string {
  return cls.startsWith("X") ? "rgba(255,0,0,0.16)" : cls.startsWith("M") ? "rgba(255,150,0,0.14)" : "rgba(246,235,20,0.07)";
}

export function FlaresTab() {
  const range = useSpaceStore((s) => s.range);
  const setRange = useSpaceStore((s) => s.setRange);
  const [sat, setSat] = useState<Sat>("primary");
  const [pkind, setPkind] = useState<"integral" | "differential">("integral");
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const xr = useSwpc(`xr-${range}-${sat}`, () => loadXrays(range, sat));
  const pr = useSwpc(`pr-${range}-${pkind}-${sat}`, () => loadProtons(range, pkind, sat));
  const el = useSwpc(`el-${range}-${sat}`, () => loadElectrons(range, sat));
  const ep = useSwpc("epam", loadEpam);
  const fl = useSwpc("flares", loadFlares);
  const domain = useNowDomain(rangeMs(range), xr.at);

  const xBands = useMemo<XBand[]>(
    () =>
      (fl.data ?? [])
        .filter((f) => /^[CMX]/.test(f.cls))
        .map((f) => ({ from: f.begin, to: f.end ?? f.max + 10 * 60_000, color: flareTone(f.cls), label: /^[MX]/.test(f.cls) ? f.cls : undefined })),
    [fl.data],
  );
  const panels = useMemo<ChartPanel[]>(
    () => [
      xrayPanel(xr.data?.short ?? null, xr.data?.long ?? null),
      protonPanel(pr.data ?? null, pkind),
      electronPanel(el.data ?? null),
      { ...epamPanel(ep.data ?? null), weight: 0.9 },
    ],
    [xr.data, pr.data, el.data, ep.data, pkind],
  );

  const pick = (f: Flare) => {
    setPicked(f.begin);
    const end = f.end ?? f.max + H;
    const pad = Math.max(H, (end - f.begin) * 0.6);
    // The flare may be older than the range: widen to 7 days so it is there.
    if (Date.now() - f.begin > rangeMs(range)) setRange("7d");
    setFocus([f.begin - pad, end + pad]);
  };

  return (
    <div className="spc-grid spc-grid--flares">
      <Card
        className="spc-card--fill"
        title="Flares and particles"
        extra={
          <div className="spc-card__tools">
            <span className="spc-card__meta">{xr.data?.satellite ? `GOES-${xr.data.satellite}` : ""}</span>
            <Seg label="Satellite" value={sat} onChange={setSat} options={[{ id: "primary", label: "Primary" }, { id: "secondary", label: "Secondary" }]} />
            <Seg label="Protons" value={pkind} onChange={setPkind} options={[{ id: "integral", label: "Integral" }, { id: "differential", label: "Differential" }]} />
            <Seg label="Range" value={range} onChange={setRange} options={RANGES.map((r) => ({ id: r.id, label: r.label }))} />
          </div>
        }
      >
        <TimeStack panels={panels} domain={domain} xBands={xBands} focus={focus} />
      </Card>
      <Card title="Flares, last 7 days" extra={<span className="spc-card__meta">{fl.data?.length ?? 0} events · click to zoom</span>} className="spc-card--list">
        <div className="spc-scroll">
          <table className="spc-table spc-table--flares">
            <thead>
              <tr>
                <th>Class</th>
                <th>Begin</th>
                <th>Peak</th>
                <th>End</th>
                <th>Dur</th>
              </tr>
            </thead>
            <tbody>
              {(fl.data ?? []).map((f) => (
                <tr key={f.begin} className={`is-click${picked === f.begin ? " is-hot" : ""}`} onClick={() => pick(f)}>
                  <td>
                    <span className={`spc-fclass spc-fclass--${f.cls.charAt(0)}`}>{f.cls}</span>
                  </td>
                  <td className="mono">{fmtUtc(f.begin)}</td>
                  <td className="mono">{fmtUtc(f.max, false)}</td>
                  <td className="mono">{f.end ? fmtUtc(f.end, false) : "--"}</td>
                  <td className="mono">{f.end ? `${Math.round((f.end - f.begin) / 60_000)}m` : "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
