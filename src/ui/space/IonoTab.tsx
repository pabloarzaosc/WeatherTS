import { useState } from "react";

import { loadDrap, loadFrames } from "../../lib/space/data";
import { useSpaceStore, type SpaceField } from "../../store/useSpaceStore";
import { ShowOnMap } from "./AuroraTab";
import { ImageLoop } from "./ImageLoop";
import { fmtUtc } from "./TimeStack";
import { Card, Seg, useSwpc } from "./common";

export const FIELD_LAYER = "space-field";

interface Product {
  id: string;
  group: string;
  label: string;
  path: string;
  about: string;
  href?: string;
}

const A = "/products/animations";
export const IONO_PRODUCTS: Product[] = [
  { id: "drap-g", group: "Radio absorption (D-RAP)", label: "Global", path: `${A}/d-rap/global.json`, about: "The highest HF frequency absorbed by 1 dB on the dayside and over the poles, from X-rays and protons.", href: "https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap" },
  { id: "drap-n", group: "Radio absorption (D-RAP)", label: "North pole", path: `${A}/d-rap/north-pole.json`, about: "D-RAP over the north polar cap, where solar protons black out HF.", href: "https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap" },
  { id: "drap-s", group: "Radio absorption (D-RAP)", label: "South pole", path: `${A}/d-rap/south-pole.json`, about: "D-RAP over the south polar cap.", href: "https://www.swpc.noaa.gov/products/d-region-absorption-predictions-d-rap" },
  { id: "tec-a", group: "Total electron content (GloTEC)", label: "TEC, Atlantic", path: `${A}/glotec/100asm_urt.json`, about: "Vertical TEC and the GPS L1 range error it causes, centred on the Atlantic.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "tec-p", group: "Total electron content (GloTEC)", label: "TEC, Pacific", path: `${A}/glotec/100asmp_urt.json`, about: "Vertical TEC and GPS range error, centred on the Pacific.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "tec-na", group: "Total electron content (GloTEC)", label: "TEC, North America", path: `${A}/glotec/100na_urt.json`, about: "Vertical TEC over North America.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "tec-us", group: "Total electron content (GloTEC)", label: "TEC, CONUS", path: `${A}/glotec/100cus_urt.json`, about: "Vertical TEC over the contiguous US.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "anom-a", group: "Total electron content (GloTEC)", label: "Anomaly, Atlantic", path: `${A}/glotec/anomaly_urt.json`, about: "TEC against its 10-day median: storms push it well above or below.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "anom-p", group: "Total electron content (GloTEC)", label: "Anomaly, Pacific", path: `${A}/glotec/anomalyp_urt.json`, about: "TEC anomaly centred on the Pacific.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "anom-na", group: "Total electron content (GloTEC)", label: "Anomaly, N. America", path: `${A}/glotec/anomna_urt.json`, about: "TEC anomaly over North America.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "anom-us", group: "Total electron content (GloTEC)", label: "Anomaly, CONUS", path: `${A}/glotec/anomcus_urt.json`, about: "TEC anomaly over the contiguous US.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "ray-a", group: "Total electron content (GloTEC)", label: "Data coverage", path: `${A}/glotec/ray_urt.json`, about: "Where GloTEC has GNSS and radio-occultation rays to work from.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "ray-p", group: "Total electron content (GloTEC)", label: "Data coverage, Pacific", path: `${A}/glotec/rayp_urt.json`, about: "GloTEC's ray coverage, centred on the Pacific.", href: "https://www.swpc.noaa.gov/products/glotec" },
  { id: "ef-us", group: "Geoelectric field", label: "US-Canada 1D", path: `${A}/geoelectric/US-Canada-1D.json`, about: "The electric field induced in the ground, which drives currents into power lines. 1-D ground models.", href: "https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute" },
  { id: "ef-3d", group: "Geoelectric field", label: "EarthScope 3D", path: `${A}/geoelectric/InterMagEarthScope.json`, about: "The geoelectric field from measured EarthScope ground impedances.", href: "https://www.swpc.noaa.gov/products/geoelectric-field-models-1-minute" },
  { id: "gs-global", group: "Geospace model", label: "Magnetosphere", path: `${A}/geospace/global.json`, about: "The University of Michigan Geospace model's magnetosphere, run on the live solar wind.", href: "https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies" },
  { id: "gs-na", group: "Geospace model", label: "Ground dB/dt, N. America", path: `${A}/geospace/north_america.json`, about: "How fast the ground field changes: what drives induced currents.", href: "https://www.swpc.noaa.gov/products/geospace-ground-magnetic-perturbation-maps" },
  { id: "gs-polar", group: "Geospace model", label: "Polar, local time", path: `${A}/geospace/polar_lt.json`, about: "Ground magnetic perturbation over the pole, in local time.", href: "https://www.swpc.noaa.gov/products/geospace-ground-magnetic-perturbation-maps" },
  { id: "gs-dens", group: "Geospace model", label: "Plasma density", path: `${A}/geospace/density.json`, about: "Density through the magnetosphere's noon-midnight plane.", href: "https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies" },
  { id: "gs-pres", group: "Geospace model", label: "Pressure", path: `${A}/geospace/pressure.json`, about: "Plasma pressure through the magnetosphere.", href: "https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies" },
  { id: "gs-vel", group: "Geospace model", label: "Velocity", path: `${A}/geospace/velocity.json`, about: "Plasma flow through the magnetosphere.", href: "https://www.swpc.noaa.gov/products/geospace-magnetosphere-movies" },
  { id: "wam-i", group: "Upper atmosphere models", label: "WAM-IPE ionosphere", path: `${A}/wam-ipe/ionosphere.json`, about: "Whole Atmosphere Model and Ionosphere Plasmasphere Electrodynamics: TEC and MUF.", href: "https://www.swpc.noaa.gov/products/wam-ipe" },
  { id: "wam-n", group: "Upper atmosphere models", label: "WAM-IPE neutral", path: `${A}/wam-ipe/neutral.json`, about: "WAM-IPE's neutral density and winds in the thermosphere: satellite drag.", href: "https://www.swpc.noaa.gov/products/wam-ipe" },
  { id: "ctipe", group: "Upper atmosphere models", label: "CTIPe TEC", path: `${A}/ctipe-tec.json`, about: "The Coupled Thermosphere Ionosphere Plasmasphere model's TEC.", href: "https://www.swpc.noaa.gov/products/ctipe-total-electron-content-forecast" },
  { id: "ustec", group: "Upper atmosphere models", label: "US-TEC", path: `${A}/us-tec.json`, about: "The older US Total Electron Content product.", href: "https://www.swpc.noaa.gov/products/us-total-electron-content" },
  { id: "natec", group: "Upper atmosphere models", label: "North American TEC", path: `${A}/natec.json`, about: "The older North American TEC product.", href: "https://www.swpc.noaa.gov/products/north-american-total-electron-content" },
];

export const FIELD_OPTIONS: { id: SpaceField; label: string; title: string }[] = [
  { id: "drap", label: "D-RAP", title: "HF radio absorption, MHz" },
  { id: "tec", label: "TEC", title: "Total electron content, TECU" },
  { id: "anomaly", label: "TEC anomaly", title: "TEC against its recent median" },
  { id: "efield", label: "Geoelectric", title: "Ground electric field over the US and Canada, mV/km" },
];

export function FieldPicker() {
  const field = useSpaceStore((s) => s.field);
  const setField = useSpaceStore((s) => s.setField);
  return <Seg label="Map field" value={field} onChange={setField} options={FIELD_OPTIONS} />;
}

export function IonoTab() {
  const [id, setId] = useState("drap-g");
  const p = IONO_PRODUCTS.find((x) => x.id === id) ?? IONO_PRODUCTS[0];
  const frames = useSwpc(`frames-${p.path}`, () => loadFrames(p.path), 300);
  const drap = useSwpc("drap", loadDrap);
  const groups = [...new Set(IONO_PRODUCTS.map((x) => x.group))];
  return (
    <div className="spc-grid spc-grid--iono">
      <Card className="spc-card--viewer" title={`${p.group}: ${p.label}`}>
        <div className="spc-viewer">
          <div className="spc-viewer__tools">
            <span>{p.about}</span>
          </div>
          <ImageLoop key={p.id} frames={frames.data} error={frames.error} title={p.label} href={p.href} count={48} />
        </div>
      </Card>
      <div className="spc-col spc-col--side">
        <Card title="Radio now (D-RAP)" extra={drap.data && <span className="spc-card__meta">{fmtUtc(drap.data.valid)}</span>}>
          <dl className="spc-dl">
            <dt>X-rays</dt>
            <dd>{drap.data?.xray || "--"}</dd>
            <dt>Protons</dt>
            <dd>{drap.data?.proton || "--"}</dd>
            <dt>Recovery</dt>
            <dd>{drap.data?.recovery || "--"}</dd>
            <dt>Worst</dt>
            <dd>{drap.data ? `${Math.max(...drap.data.rows.flat()).toFixed(1)} MHz absorbed` : "--"}</dd>
          </dl>
        </Card>
        <Card title="On the map">
          <FieldPicker />
          <ShowOnMap layer={FIELD_LAYER} label="the field" />
        </Card>
        <Card title="Products">
          {groups.map((g) => (
            <div key={g} className="spc-pick">
              <h4>{g}</h4>
              <div className="spc-pick__list">
                {IONO_PRODUCTS.filter((x) => x.group === g).map((x) => (
                  <button key={x.id} type="button" className={x.id === id ? "is-on" : ""} onClick={() => setId(x.id)} title={x.about}>
                    {x.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
