import { flareClass, loadDst, loadF107, loadHemiPower, loadKp1m, loadProtons, loadScales, loadSolarWind, loadXrays } from "../../lib/space/data";
import { ScaleBadge, gOfKp, kpColor, kpText, latest, useSwpc } from "./common";

function Kpi({ label, value, unit, tone, title }: { label: string; value: string; unit?: string; tone?: string; title?: string }) {
  return (
    <div className="spc-kpi" title={title}>
      <span>{label}</span>
      <b style={tone ? { color: tone } : undefined}>
        {value}
        {unit && <small>{unit}</small>}
      </b>
    </div>
  );
}

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The numbers that matter right now, across the top of every tab. */
export function KpiStrip() {
  const scales = useSwpc("scales", loadScales);
  const kp = useSwpc("kp1m", loadKp1m);
  const sw = useSwpc("sw-1d", () => loadSolarWind("1d"));
  const xr = useSwpc("xr-6h", () => loadXrays("6h"));
  const pr = useSwpc("pr-6h", () => loadProtons("6h"));
  const dst = useSwpc("dst", loadDst, 300);
  const hp = useSwpc("hemi", loadHemiPower, 120);
  const f107 = useSwpc("f107", loadF107, 1800);

  const k = latest(kp.data);
  const bz = latest(sw.data?.bz);
  const bt = latest(sw.data?.bt);
  const v = latest(sw.data?.speed);
  const n = latest(sw.data?.density);
  const temp = latest(sw.data?.temp);
  const x = latest(xr.data?.long);
  const p10 = latest(pr.data?.get(">=10 MeV"));
  const d = latest(dst.data);
  const hpn = latest(hp.data?.north);
  const lead = sw.data?.arrival != null && v ? sw.data.arrival - Date.now() : null;
  const s = scales.data;

  return (
    <div className="spc-kpis">
      <div className="spc-kpi spc-kpi--scales" title="NOAA space weather scales now: radio blackouts, solar radiation storms, geomagnetic storms">
        <span>NOAA scales</span>
        <div>
          <ScaleBadge k="R" level={s?.now.R ?? 0} />
          <ScaleBadge k="S" level={s?.now.S ?? 0} />
          <ScaleBadge k="G" level={s?.now.G ?? 0} />
        </div>
      </div>
      <Kpi label="Kp" value={k ? kpText(k.v) : "--"} unit={k && gOfKp(k.v) ? ` G${gOfKp(k.v)}` : undefined} tone={k ? kpColor(k.v) : undefined} title="Estimated planetary K index, this minute" />
      <Kpi label="Bz" value={bz ? bz.v.toFixed(1) : "--"} unit=" nT" tone={bz && bz.v <= -10 ? "#ff5a4f" : bz && bz.v <= -5 ? "#ff9600" : undefined} title="North-south part of the interplanetary field (GSM): southward, negative, couples into the magnetosphere" />
      <Kpi label="Bt" value={bt ? bt.v.toFixed(1) : "--"} unit=" nT" title="Total interplanetary magnetic field" />
      <Kpi label="Speed" value={v ? v.v.toFixed(0) : "--"} unit=" km/s" tone={v && v.v >= 700 ? "#ff5a4f" : v && v.v >= 500 ? "#ff9600" : undefined} title="Solar wind speed at L1" />
      <Kpi label="Density" value={n ? n.v.toFixed(1) : "--"} unit=" p/cm³" title="Solar wind proton density at L1" />
      <Kpi label="Temp" value={temp ? (temp.v / 1000).toFixed(0) : "--"} unit=" kK" title="Solar wind proton temperature, thousands of kelvin" />
      <Kpi label="X-ray" value={x ? flareClass(x.v) : "--"} tone={x && x.v >= 1e-5 ? "#ff5a4f" : x && x.v >= 1e-6 ? "#ffc800" : undefined} title="GOES long-channel X-ray flux (0.1-0.8 nm) as a flare class" />
      <Kpi label="Protons" value={p10 ? (p10.v >= 10 ? p10.v.toFixed(0) : p10.v.toFixed(2)) : "--"} unit=" pfu" tone={p10 && p10.v >= 10 ? "#ff9600" : undefined} title="GOES integral protons at 10 MeV and above; 10 pfu is S1" />
      <Kpi label="Dst" value={d ? d.v.toFixed(0) : "--"} unit=" nT" tone={d && d.v <= -100 ? "#ff5a4f" : d && d.v <= -50 ? "#ff9600" : undefined} title="Kyoto real-time Dst: the ring current; under -50 nT is a storm" />
      <Kpi label="Aurora N" value={hpn ? hpn.v.toFixed(0) : "--"} unit=" GW" title="OVATION hemispheric power, north" />
      <Kpi label="F10.7" value={f107.data?.latest != null ? f107.data.latest.toFixed(0) : "--"} unit=" sfu" title="10.7 cm solar radio flux, today's noon reading" />
      {lead != null && lead > 0 && (
        <Kpi label="L1 to Earth" value={`${minutes(lead)}`} unit=" min" title={`Wind measured at L1 now reaches Earth in about ${minutes(lead)} minutes (${sw.data?.source})`} />
      )}
    </div>
  );
}
