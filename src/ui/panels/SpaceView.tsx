import { Bell, Maximize2 } from "lucide-react";

import { flareClass, loadAlerts, loadKp1m, loadScales, loadSolarWind, loadXrays } from "../../lib/space/data";
import { useAppStore } from "../../store/useAppStore";
import { useSpaceStore, type SpaceTab } from "../../store/useSpaceStore";
import { FieldPicker } from "../space/IonoTab";
import { SPACE_TABS } from "../space/SpaceDashboard";
import { fmtUtc } from "../space/TimeStack";
import { SCALE_NAMES, ScaleBadge, gOfKp, kpColor, kpText, latest, useSwpc } from "../space/common";

function LayerToggle({ id, label, sub }: { id: string; label: string; sub: string }) {
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

/** The Space category in the catalog: where things stand, the map layers, and the way into the dashboard. */
export function SpaceView() {
  const scales = useSwpc("scales", loadScales);
  const kp = useSwpc("kp1m", loadKp1m);
  const sw = useSwpc("sw-1d", () => loadSolarWind("1d"));
  const xr = useSwpc("xr-6h", () => loadXrays("6h"));
  const alerts = useSwpc("alerts", loadAlerts);
  const field = useAppStore((s) => s.layers["space-field"]?.visible ?? false);
  const open = (tab?: SpaceTab) => useSpaceStore.getState().openTab(tab);

  const k = latest(kp.data);
  const bz = latest(sw.data?.bz);
  const v = latest(sw.data?.speed);
  const x = latest(xr.data?.long);
  const s = scales.data;

  return (
    <div className="spcv">
      <button type="button" className="spcv__open" onClick={() => open()}>
        <Maximize2 size={13} /> Open the Space Weather dashboard
      </button>

      <div className="spcv__now">
        <div className="spcv__scales">
          {(["R", "S", "G"] as const).map((key) => (
            <div key={key} title={`${key === "R" ? "Radio blackouts" : key === "S" ? "Solar radiation storms" : "Geomagnetic storms"}: ${SCALE_NAMES[s?.now[key] ?? 0]}`}>
              <ScaleBadge k={key} level={s?.now[key] ?? 0} big />
              <small>{SCALE_NAMES[s?.now[key] ?? 0]}</small>
            </div>
          ))}
        </div>
        <dl className="spcv__nums">
          <dt>Kp</dt>
          <dd style={k ? { color: kpColor(k.v) } : undefined}>
            {k ? kpText(k.v) : "--"}
            {k && gOfKp(k.v) > 0 && <small> G{gOfKp(k.v)}</small>}
          </dd>
          <dt>Bz</dt>
          <dd>{bz ? `${bz.v.toFixed(1)} nT` : "--"}</dd>
          <dt>Wind</dt>
          <dd>{v ? `${v.v.toFixed(0)} km/s` : "--"}</dd>
          <dt>X-ray</dt>
          <dd>{x ? flareClass(x.v) : "--"}</dd>
        </dl>
        {s && (
          <div className="spcv__fcst">
            {s.days.map((d) => (
              <span key={d.date} title={`${d.date}: R1-R2 ${d.rMinor}%, R3+ ${d.rMajor}%, S1+ ${d.sProb}%`}>
                {new Date(`${d.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}
                <ScaleBadge k="G" level={d.G} />
                <em>R {d.rMinor ?? "-"}%</em>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="spcv__section">On the map</div>
      <LayerToggle id="space-aurora" label="Aurora forecast" sub="OVATION, both hemispheres, every 5 min" />
      <LayerToggle id="space-field" label="Ionosphere and ground field" sub="D-RAP, TEC, TEC anomaly or geoelectric field" />
      {field && (
        <div className="spcv__field">
          <FieldPicker />
        </div>
      )}

      <div className="spcv__section">Sections</div>
      <div className="spcv__tabs">
        {SPACE_TABS.map((t) => (
          <button key={t.id} type="button" onClick={() => open(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="spcv__section">Latest from SWPC</div>
      <ul className="spc-alerts spc-alerts--mini">
        {(alerts.data ?? []).slice(0, 4).map((a) => (
          <li key={a.id} className={`is-${a.kind}`}>
            <button
              type="button"
              onClick={() => {
                useSpaceStore.getState().pickAlert(a.id);
                useSpaceStore.getState().openTab("alerts");
              }}
            >
              <Bell size={12} />
              <span>
                <b>{a.title}</b>
                <small>{fmtUtc(a.issued)}</small>
              </span>
            </button>
          </li>
        ))}
        {!alerts.data && <li className="spc-msg">Reading…</li>}
      </ul>
    </div>
  );
}
