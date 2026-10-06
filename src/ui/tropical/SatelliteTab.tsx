import { useState } from "react";

import { SAT_BANDS, SAT_SECTORS, floaterFrames, hasFloater, loadStorms, sectorFrames } from "../../lib/tropical/data";
import { ImageLoop } from "../space/ImageLoop";
import { Card, useSwpc } from "../space/common";
import { CatBadge } from "./common";

/** STAR's GOES sectors over the tropics, and the floaters it keeps on each storm. */
export function SatelliteTab() {
  const storms = useSwpc("trp-storms", loadStorms, 120);
  const [where, setWhere] = useState<string>("taw");
  const [band, setBand] = useState("GEOCOLOR");
  // West Pacific, Indian Ocean and southern storms have no STAR floater.
  const floaters = storms.data?.storms.filter((s) => hasFloater(s.id)) ?? [];
  const storm = floaters.find((s) => s.id === where);
  const sector = SAT_SECTORS.find((s) => s.id === where);
  const key = `trp-sat-${where}-${band}`;
  const frames = useSwpc(
    key,
    // The whole list (up to 400 frames, a day or more): the loop thins it to
    // the count picked, so asking for 96 or every frame finds them.
    () => (storm ? floaterFrames(storm.id, band) : sectorFrames(sector!.id, sector!.sat, band, sector!.size)),
    300,
  );
  return (
    <div className="spc-grid spc-grid--sun">
      <Card
        className="spc-card--viewer"
        title={storm ? `${storm.name}, floater` : sector?.label ?? ""}
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
        <ImageLoop
          key={key}
          frames={frames.data}
          error={frames.error ? "STAR has no imagery for this view and band right now." : null}
          title={storm ? storm.name : sector?.label}
          count={storm ? 48 : 36}
          href="https://www.star.nesdis.noaa.gov/goes/"
        />
      </Card>
      <div className="spc-col spc-col--side">
        <Card title="Storms">
          <div className="spc-pick__list trp-pad">
            {floaters.map((s) => (
              <button key={s.id} type="button" className={where === s.id ? "is-on" : ""} onClick={() => setWhere(s.id)}>
                <CatBadge cat={s.cat} /> {s.name}
              </button>
            ))}
            {storms.data && floaters.length === 0 && <span className="spc-note">No active storms with a floater.</span>}
          </div>
        </Card>
        <Card title="Regions">
          <div className="spc-pick__list trp-pad">
            {SAT_SECTORS.map((s) => (
              <button key={s.id} type="button" className={where === s.id ? "is-on" : ""} onClick={() => setWhere(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          <p className="spc-note">NOAA STAR's GOES-19 (East) and GOES-18 (West) imagery, every 10 minutes; floaters follow each Atlantic and Eastern/Central Pacific storm, up to about 3 days back.</p>
        </Card>
      </div>
    </div>
  );
}
