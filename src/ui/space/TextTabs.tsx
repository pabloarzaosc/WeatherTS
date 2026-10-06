import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";

import { TEXT_PRODUCTS, loadAlerts, loadIcao, loadText, type SwxAlert } from "../../lib/space/data";
import { SWPC } from "../../lib/space/swpc";
import { useSpaceStore } from "../../store/useSpaceStore";
import { fmtUtc } from "./TimeStack";
import { Card, Loading, Seg, useSwpc } from "./common";

type Kind = "all" | SwxAlert["kind"];
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "warning", label: "Warnings" },
  { id: "alert", label: "Alerts" },
  { id: "watch", label: "Watches" },
  { id: "summary", label: "Summaries" },
];

export function AlertsTab() {
  const { data, error } = useSwpc("alerts", loadAlerts);
  const picked = useSpaceStore((s) => s.pickedAlert);
  const [kind, setKind] = useState<Kind>("all");
  const [q, setQ] = useState("");
  const list = useMemo(
    () => (data ?? []).filter((a) => (kind === "all" || a.kind === kind) && (!q || a.text.toLowerCase().includes(q.toLowerCase()))),
    [data, kind, q],
  );
  const [sel, setSel] = useState<string | null>(picked);
  useEffect(() => {
    if (picked) setSel(picked);
  }, [picked]);
  const cur = list.find((a) => a.id === sel) ?? list[0];

  if (!data) return <Loading error={error} what="the alerts" />;
  return (
    <div className="spc-grid spc-grid--text">
      <Card
        className="spc-card--list"
        title={`SWPC alerts, warnings and watches (${list.length})`}
        extra={
          <div className="spc-card__tools">
            <input className="spc-search" placeholder="Filter text" value={q} onChange={(e) => setQ(e.target.value)} />
            <Seg label="Kind" value={kind} onChange={setKind} options={KINDS} />
          </div>
        }
      >
        <ul className="spc-alerts spc-alerts--full spc-scroll">
          {list.map((a) => (
            <li key={a.id} className={`is-${a.kind}${cur?.id === a.id ? " is-sel" : ""}`}>
              <button type="button" onClick={() => setSel(a.id)}>
                <span>
                  <b>{a.title}</b>
                  <small>
                    {a.code} #{a.serial} · {fmtUtc(a.issued)}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="spc-col">
        <Card className="spc-card--doc" title={cur?.title ?? "Alert"} extra={cur && <span className="spc-card__meta">{cur.code} · issued {fmtUtc(cur.issued)}</span>}>
          <pre className="spc-pre">{cur?.text ?? "Nothing matches."}</pre>
        </Card>
        <IcaoCard />
      </div>
    </div>
  );
}

/** The advisories ICAO's space weather centres issue for aviation: HF radio,
 *  GNSS and radiation at flight level. SWPC lists the ones in effect. */
function IcaoCard() {
  const { data, error } = useSwpc("icao", loadIcao, 300);
  const text = (a: Record<string, unknown>) => {
    for (const k of ["message", "text", "advisory", "body"]) if (typeof a[k] === "string") return a[k] as string;
    return JSON.stringify(a, null, 2);
  };
  return (
    <Card title="ICAO advisories for aviation" extra={<span className="spc-card__meta">HF communication, GNSS, radiation</span>}>
      {error ? (
        <div className="spc-msg">{error}</div>
      ) : !data ? (
        <div className="spc-msg">Reading…</div>
      ) : data.length === 0 ? (
        <div className="spc-msg">None in effect.</div>
      ) : (
        data.map((a, i) => (
          <pre key={i} className="spc-pre spc-pre--small">
            {text(a)}
          </pre>
        ))
      )}
    </Card>
  );
}

export function ReportsTab() {
  const [id, setId] = useState(TEXT_PRODUCTS[0].id);
  const p = TEXT_PRODUCTS.find((x) => x.id === id)!;
  const { data, error } = useSwpc(`text-${p.path}`, () => loadText(p.path), 300);
  return (
    <div className="spc-grid spc-grid--text">
      <Card className="spc-card--list" title="SWPC forecasts and reports">
        <ul className="spc-doclist spc-scroll">
          {TEXT_PRODUCTS.map((x) => (
            <li key={x.id}>
              <button type="button" className={x.id === id ? "is-on" : ""} onClick={() => setId(x.id)}>
                <b>{x.label}</b>
                <small>{x.about}</small>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card
        className="spc-card--doc"
        title={p.label}
        extra={
          <a className="spc-link" href={`${SWPC}${p.path}`} target="_blank" rel="noopener">
            Source <ExternalLink size={11} />
          </a>
        }
      >
        {data ? <pre className="spc-pre">{data}</pre> : <Loading error={error} what={p.label} />}
      </Card>
    </div>
  );
}
