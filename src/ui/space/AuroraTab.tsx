import { useMemo } from "react";
import { Map as MapIcon } from "lucide-react";

import { loadFrames, loadHemiPower, loadOvation } from "../../lib/space/data";
import { SWPC } from "../../lib/space/swpc";
import { useAppStore } from "../../store/useAppStore";
import { useSpaceStore } from "../../store/useSpaceStore";
import { ImageLoop, ZoomImage } from "./ImageLoop";
import { TimeStack, fmtUtc, type ChartPanel } from "./TimeStack";
import { C, Card, latest, useSwpc } from "./common";

export const AURORA_LAYER = "space-aurora";

export function ShowOnMap({ layer, label, onShow }: { layer: string; label: string; onShow?: () => void }) {
  const on = useAppStore((s) => s.layers[layer]?.visible ?? false);
  return (
    <button
      type="button"
      className={`spc-mapbtn${on ? " is-on" : ""}`}
      onClick={() => {
        onShow?.();
        useAppStore.getState().setLayerVisible(layer, !on);
        if (!on) useSpaceStore.getState().close();
      }}
    >
      <MapIcon size={13} />
      {on ? `Hide ${label} on the map` : `Show ${label} on the map`}
    </button>
  );
}

export function AuroraTab() {
  const north = useSwpc("ov-n", () => loadFrames("/products/animations/ovation_north_24h.json"), 300);
  const south = useSwpc("ov-s", () => loadFrames("/products/animations/ovation_south_24h.json"), 300);
  const hp = useSwpc("hemi", loadHemiPower, 120);
  const ov = useSwpc("ovation", loadOvation, 300);
  const domain = useMemo<[number, number]>(() => {
    const t = hp.data?.north.t;
    if (!t?.length) return [Date.now() - 86_400_000, Date.now()];
    return [t[0], t[t.length - 1]];
  }, [hp.data]);
  const panels = useMemo<ChartPanel[]>(
    () => [
      {
        id: "hp",
        title: "Hemispheric power (OVATION)",
        units: "GW",
        include: [0, 50],
        lines: [{ y: 50, color: "rgba(255,200,0,0.6)", label: "50" }, { y: 100, color: "rgba(255,90,80,0.6)", label: "100" }],
        series: [
          { label: "North", color: C.north, data: hp.data?.north ?? { t: new Float64Array(), v: new Float64Array() }, width: 1.6 },
          { label: "South", color: C.south, data: hp.data?.south ?? { t: new Float64Array(), v: new Float64Array() } },
        ],
        fmt: (v) => v.toFixed(0),
      },
    ],
    [hp.data],
  );
  const n = latest(hp.data?.north);
  const bust = Math.floor(Date.now() / 900_000);
  return (
    <div className="spc-grid spc-grid--aurora">
      <Card
        className="spc-card--viewer"
        title="Aurora forecast, northern hemisphere"
        extra={<span className="spc-card__meta">{ov.data ? `OVATION valid ${fmtUtc(ov.data.forecast)}` : ""}</span>}
      >
        <ImageLoop frames={north.data} error={north.error} title="OVATION north" count={96} href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" />
      </Card>
      <Card className="spc-card--viewer" title="Aurora forecast, southern hemisphere">
        <ImageLoop frames={south.data} error={south.error} title="OVATION south" count={96} href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" />
      </Card>
      <div className="spc-col spc-col--side">
        <Card title="On the map">
          <p className="spc-note spc-note--top">
            The 30-minute OVATION forecast drawn over the map: the chance of aurora overhead, from SWPC's grid every 5 minutes. Hover the map for the value.
          </p>
          <ShowOnMap layer={AURORA_LAYER} label="the aurora" />
        </Card>
        <Card title="Power right now">
          <div className="spc-bigfig">
            <b>{n ? n.v.toFixed(0) : "--"}</b>
            <span>GW, north</span>
            <b>{latest(hp.data?.south)?.v.toFixed(0) ?? "--"}</b>
            <span>GW, south</span>
          </div>
          <p className="spc-note">Over 50 GW the oval is bright and wide; over 100 GW it reaches well into mid latitudes.</p>
        </Card>
      </div>
      <Card className="spc-card--fill spc-card--hp" title="Hemispheric power, today">
        <TimeStack panels={panels} domain={domain} />
      </Card>
      <Card title="Tonight" className="spc-card--night">
        <div className="spc-loop">
          <ZoomImage src={`${SWPC}/experimental/images/aurora_dashboard/tonights_static_viewline_forecast.png?${bust}`} alt="Tonight's aurora view line" />
        </div>
      </Card>
      <Card title="Tomorrow night" className="spc-card--night">
        <div className="spc-loop">
          <ZoomImage src={`${SWPC}/experimental/images/aurora_dashboard/tomorrow_nights_static_viewline_forecast.png?${bust}`} alt="Tomorrow night's aurora view line" />
        </div>
      </Card>
    </div>
  );
}
