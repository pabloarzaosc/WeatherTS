import { useMemo, useState } from "react";
import { Map as MapIcon } from "lucide-react";

import { ENSO_PICTURES, TWO_PICTURES, jtwcOutlook, latestProduct, loadStorms } from "../../lib/tropical/data";
import { getCached } from "../../lib/tropical/fetch";
import { ZoomImage } from "../space/ImageLoop";
import { fmtUtc } from "../space/TimeStack";
import { Card, Loading, Seg, useSwpc } from "../space/common";
import { showOnMap } from "./mapActions";

const TWO_LOC: Record<string, string> = { atl: "AT", pac: "EP", cpac: "CP" };

function TwoBasin({ id }: { id: string }) {
  const p = TWO_PICTURES.find((x) => x.id === id)!;
  const text = useSwpc(`trp-two-${id}`, () => latestProduct("TWO", TWO_LOC[id]), 600);
  const bust = Math.floor(Date.now() / 900_000);
  return (
    <div className="trp-two-basin">
      <div className="spc-loop trp-two">
        <ZoomImage src={`${p.url}?${bust}`} alt={`NHC outlook, ${p.label}`} />
      </div>
      {text.data ? <pre className="spc-pre trp-pre">{text.data.text.trim()}</pre> : <Loading error={text.error} what="the outlook" />}
    </div>
  );
}

export function OutlooksTab() {
  const [id, setId] = useState("atl");
  const [twd, setTwd] = useState("AT");
  const disc = useSwpc(`trp-twd-${twd}`, () => latestProduct("TWD", twd), 900);
  const [jt, setJt] = useState<"abpw" | "abio">("abpw");
  const jtwc = useSwpc(`jtwc-${jt}`, () => jtwcOutlook(jt), 600);
  const gth = ENSO_PICTURES.find((x) => x.id === "gth")!;
  const bust = Math.floor(Date.now() / 3_600_000);
  return (
    <div className="spc-grid spc-grid--overview">
      <div className="spc-col spc-col--main">
        <Card
          title="NHC tropical weather outlook"
          extra={
            <div className="spc-card__tools">
              <Seg value={id} onChange={setId} options={TWO_PICTURES.map((x) => ({ id: x.id, label: x.label }))} />
              <button type="button" className="spc-mapbtn" onClick={() => showOnMap("nhc-two")}>
                <MapIcon size={13} /> Formation areas on the map
              </button>
            </div>
          }
        >
          <TwoBasin key={id} id={id} />
        </Card>
        <Card title="Global tropics hazards, weeks 2 and 3" extra={<span className="spc-card__meta">NOAA CPC</span>}>
          <div className="spc-loop trp-two">
            <ZoomImage src={`${gth.url}?${bust}`} alt={gth.label} />
          </div>
        </Card>
      </div>
      <div className="spc-col spc-col--side">
        <Card title="Tropical weather discussion" extra={<Seg value={twd} onChange={setTwd} options={[{ id: "AT", label: "Atlantic" }, { id: "EP", label: "E Pacific" }]} />}>
          {disc.data ? <pre className="spc-pre trp-pre">{disc.data.text.trim()}</pre> : <Loading error={disc.error} what="the discussion" />}
        </Card>
        <Card title="JTWC significant tropical weather" extra={<Seg value={jt} onChange={setJt} options={[{ id: "abpw", label: "Pacific" }, { id: "abio", label: "Indian" }]} />}>
          {jtwc.data ? <pre className="spc-pre trp-pre">{jtwc.data.trim()}</pre> : <Loading error={jtwc.error} what="JTWC" />}
        </Card>
      </div>
    </div>
  );
}

interface Doc {
  id: string;
  label: string;
  about: string;
  group: string;
  load: () => Promise<{ text: string; issued: string } | null>;
}

const NWS = (type: string, loc: string, label: string, about: string, group: string): Doc => ({
  id: `${type}-${loc}`,
  label,
  about,
  group,
  load: () => latestProduct(type, loc),
});

const JT = (id: string, label: string, about: string): Doc => ({
  id,
  label,
  about,
  group: "JTWC",
  load: async () => ({ text: await getCached<string>(`https://www.metoc.navy.mil/jtwc/products/${id}web.txt`, 600, "text"), issued: "" }),
});

export function ProductsTab() {
  const storms = useSwpc("trp-storms", loadStorms, 120);
  const docs = useMemo<Doc[]>(() => {
    const out: Doc[] = [
      NWS("TWO", "AT", "Outlook, Atlantic", "Where systems may form in 7 days.", "Outlooks"),
      NWS("TWO", "EP", "Outlook, East Pacific", "Where systems may form in 7 days.", "Outlooks"),
      NWS("TWO", "CP", "Outlook, Central Pacific", "CPHC's outlook.", "Outlooks"),
      NWS("TWD", "AT", "Discussion, Atlantic", "The synoptic picture across the tropics.", "Outlooks"),
      NWS("TWD", "EP", "Discussion, East Pacific", "The synoptic picture across the tropics.", "Outlooks"),
      NWS("TWS", "AT", "Monthly summary, Atlantic", "The month in the tropics.", "Outlooks"),
      NWS("STD", "AT", "Satellite disturbance summary", "SAB's Dvorak fixes on disturbances.", "Satellite"),
      NWS("TCS", "AT", "Satellite TC summary", "SAB's Dvorak fixes on cyclones.", "Satellite"),
      NWS("CHG", "AT", "Computer guidance, Atlantic", "The early track and intensity models in a table.", "Guidance"),
      NWS("CHG", "EP", "Computer guidance, E Pacific", "The early track and intensity models in a table.", "Guidance"),
      NWS("NOU", "AT", "Recon plan of the day", "Tomorrow's Hurricane Hunter flights (TCPOD).", "Recon"),
      NWS("URN", "AT", "Recon messages", "Vortex data and recon observations.", "Recon"),
      JT("abpw", "Western and South Pacific", "JTWC's significant tropical weather advisory."),
      JT("abio", "Indian Ocean", "JTWC's significant tropical weather advisory."),
    ];
    for (const s of storms.data?.storms ?? []) {
      if (s.nhc?.bin) {
        const g = `${s.name} (${s.nhc.bin})`;
        out.push(NWS("TCP", s.nhc.bin, "Public advisory", "Position, intensity, watches and warnings, hazards.", g));
        out.push(NWS("TCD", s.nhc.bin, "Discussion", "The forecaster's reasoning.", g));
        out.push(NWS("TCM", s.nhc.bin, "Forecast advisory", "Every forecast position and wind radius.", g));
        out.push(NWS("PWS", s.nhc.bin, "Wind speed probabilities", "Chance of 34, 50 and 64 kt winds at each place.", g));
        out.push(NWS("TCU", s.nhc.bin, "Update", "Unscheduled updates.", g));
      } else if (!s.invest && s.agency === "JTWC") {
        out.push(JT(`${s.basin}${String(s.number).padStart(2, "0")}${String(s.year).slice(2)}`, `${s.name} warning`, "JTWC's warning text."));
      }
    }
    return out;
  }, [storms.data]);
  const [id, setId] = useState(docs[0].id);
  const doc = docs.find((d) => d.id === id) ?? docs[0];
  const { data, error } = useSwpc(`trp-doc-${doc.id}`, doc.load, 300);
  const groups = [...new Set(docs.map((d) => d.group))];
  return (
    <div className="spc-grid spc-grid--text">
      <Card className="spc-card--list" title="Text products">
        <div className="spc-scroll">
          {groups.map((g) => (
            <div key={g}>
              <h4 className="trp-sub">{g}</h4>
              <ul className="spc-doclist">
                {docs
                  .filter((d) => d.group === g)
                  .map((d) => (
                    <li key={d.id}>
                      <button type="button" className={d.id === doc.id ? "is-on" : ""} onClick={() => setId(d.id)}>
                        <b>{d.label}</b>
                        <small>{d.about}</small>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      <Card
        className="spc-card--doc"
        title={doc.label}
        extra={<span className="spc-card__meta">{data?.issued ? `Issued ${fmtUtc(Date.parse(data.issued))}` : doc.group}</span>}
      >
        {data ? <pre className="spc-pre">{data.text.trim()}</pre> : data === null ? <div className="spc-msg">Not issued lately.</div> : <Loading error={error} what={doc.label} />}
      </Card>
    </div>
  );
}
