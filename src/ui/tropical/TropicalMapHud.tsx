import { useEffect, useState } from "react";

import { CAT_COLORS, CAT_SHORT, type Cat } from "../../lib/tropical/data";
import { useDragOffset } from "../../lib/useDragOffset";
import { useAppStore } from "../../store/useAppStore";
import { useTropicalStore } from "../../store/useTropicalStore";
import { HurricaneIcon } from "./HurricaneIcon";
import { RECON_COLORS } from "./ReconTab";
import { RECON_LAYER, SEASON_LAYER, SST_LAYER, STORMS_LAYER, WSP_LAYER } from "./mapActions";

const WW: [string, string][] = [
  ["#ff1f1f", "Hurricane warning"],
  ["#ff8ad8", "Hurricane watch"],
  ["#1f6bff", "TS warning"],
  ["#ffe14d", "TS watch"],
];
const WSP: [string, string][] = [
  ["#1f7a1f", "5"],
  ["#7acc3a", "20"],
  ["#ffe14d", "40"],
  ["#ff8a1f", "60"],
  ["#d91f1f", "80"],
  ["#9a1fb5", "90+"],
];
const RECON_STOPS: Record<string, [string, string][]> = {
  fl: [["#5ebaff", "0"], ["#00faf4", "34"], ["#ffffcc", "64"], ["#ffc140", "96"], ["#ff6060", "137"], ["#c53bff", "160 kt"]],
  sfmr: [["#5ebaff", "0"], ["#00faf4", "34"], ["#ffffcc", "64"], ["#ffc140", "96"], ["#ff6060", "137"], ["#c53bff", "160 kt"]],
  xsp: [["#c53bff", "900"], ["#ff4040", "940"], ["#ff9a1f", "970"], ["#ffe14d", "990"], ["#7acc3a", "1005"], ["#5ebaff", "1015 mb"]],
  alt: [["#ff9a1f", "0"], ["#ffe14d", "1.5"], ["#7acc3a", "3"], ["#5ebaff", "6"], ["#a879ff", "13 km"]],
};

function Steps({ stops }: { stops: [string, string][] }) {
  return (
    <div className="trp-steps">
      {stops.map(([c, l]) => (
        <span key={l}>
          <i style={{ background: c }} />
          {l}
        </span>
      ))}
    </div>
  );
}

/** The tropical layers' keys on the map, bottom left, stepping over the colour bars. */
export function TropicalMapHud() {
  const layers = useAppStore((s) => s.layers);
  const wspKt = useTropicalStore((s) => s.wspKt);
  const reconColor = useTropicalStore((s) => s.reconColor);
  const sst = useTropicalStore((s) => s.sst);
  const storms = layers[STORMS_LAYER]?.visible;
  const season = layers[SEASON_LAYER]?.visible;
  const wsp = layers[WSP_LAYER]?.visible;
  const recon = layers[RECON_LAYER]?.visible;
  const sstOn = layers[SST_LAYER]?.visible;
  const drag = useDragOffset("tropicalLegend", { boundsSelector: ".mappane" });
  const [lift, setLift] = useState(0);
  const any = storms || season || wsp || recon || sstOn;

  useEffect(() => {
    if (!any) return;
    const check = () => {
      const me = drag.ref.current?.getBoundingClientRect();
      if (!me) return;
      let up = 0;
      for (const bar of document.querySelectorAll<HTMLElement>(".cbar, .outlook-legend")) {
        const r = bar.getBoundingClientRect();
        if (r.width > 0 && r.left < me.right && r.right > me.left) up += r.height + 8;
      }
      setLift((l) => (l === up ? l : up));
    };
    check();
    const id = window.setInterval(check, 1500);
    window.addEventListener("resize", check);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", check);
    };
  }, [any, drag.ref]);

  if (!any) return null;
  return (
    <aside ref={drag.ref} className={`trp-legend hud-grip${drag.dragging ? " is-dragging" : ""}`} style={{ ...drag.style, marginBottom: lift }} aria-label="Tropical legend">
      <div className="spc-legend__title">
        <HurricaneIcon size={12} /> Tropical
        <button type="button" onClick={() => useTropicalStore.getState().openTab()}>
          Dashboard
        </button>
      </div>
      {(storms || season) && (
        <div className="trp-legend__item">
          <b>Category</b>
          <div className="trp-steps">
            {(Object.keys(CAT_COLORS) as Cat[]).map((c) => (
              <span key={c}>
                <i style={{ background: CAT_COLORS[c] }} />
                {CAT_SHORT[c].replace("Cat ", "")}
              </span>
            ))}
          </div>
        </div>
      )}
      {storms && (
        <div className="trp-legend__item">
          <b>Coast</b>
          <Steps stops={WW} />
          <small>White: NHC cone and forecast track. Rings: 34, 50, 64 kt wind radii.</small>
        </div>
      )}
      {wsp && (
        <div className="trp-legend__item">
          <b>Chance of {wspKt} kt winds, 5 days (%)</b>
          <Steps stops={WSP} />
        </div>
      )}
      {recon && (
        <div className="trp-legend__item">
          <b>Recon: {RECON_COLORS.find((c) => c.id === reconColor)?.label}</b>
          <Steps stops={RECON_STOPS[reconColor]} />
        </div>
      )}
      {sstOn && (
        <div className="trp-legend__item">
          <b>{sst === "sst" ? "Sea surface temperature" : "SST anomaly"}</b>
          <small>{sst === "sst" ? "GHRSST MUR: purple below 10 °C to red near 32 °C." : "GHRSST MUR against 2003-2014: blue cooler, red warmer, ±5 °C."}</small>
        </div>
      )}
    </aside>
  );
}
