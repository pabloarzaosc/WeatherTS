import { Building2, Clock, Database, Gauge, MapPin, Radio, Send, X } from "lucide-react";

import { LSR_COLORS, LSR_LABELS, lsrPlace } from "../lib/lsr";
import { useLsrStore } from "../store/useLsrStore";
import { LsrShape } from "./LsrShape";

function fmtAbs(unix: number | null): string {
  if (!unix) return "--";
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/** "2 days ago" / "18 min ago" — the same relative form a report list uses. */
function fmtAgo(unix: number | null): string {
  if (!unix) return "";
  const mins = (Date.now() / 1000 - unix) / 60;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const hrs = mins / 60;
  if (hrs < 36) return `${hrs.toFixed(hrs < 10 ? 1 : 0)} h ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/** The full text of one Local Storm Report, opened by clicking its icon. */
export function LsrCard() {
  const selected = useLsrStore((s) => s.selected);
  const select = useLsrStore((s) => s.select);
  if (!selected) return null;

  const p = selected.properties;
  const color = LSR_COLORS[p.cat] ?? LSR_COLORS.other;
  const [lon, lat] = selected.geometry.coordinates;
  const coords = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

  const rows: Array<[React.ReactNode, string, React.ReactNode]> = [
    [<MapPin size={11} key="l" />, "Location", lsrPlace(p) || coords],
    [
      <Gauge size={11} key="m" />,
      "Magnitude",
      p.mag ? (
        <>
          {p.mag}
          {p.qualifierText && <em> ({p.qualifierText})</em>}
        </>
      ) : (
        "--"
      ),
    ],
    [
      <Clock size={11} key="e" />,
      "Event time",
      <>
        {fmtAbs(p.unix)} <em>({fmtAgo(p.unix)})</em>
      </>,
    ],
    [<Send size={11} key="i" />, "Issued", fmtAbs(p.issuedUnix)],
    [<Radio size={11} key="s" />, "Source", p.source || "--"],
    [<Building2 size={11} key="o" />, "Office", p.wfo ? `K${p.wfo}` : "--"],
    [<MapPin size={11} key="c" />, "Coordinates", coords],
    [<Database size={11} key="d" />, "Database", "NWS Local Storm Reports"],
  ];

  return (
    <div className="lsrcard" role="dialog" aria-label={`Storm report: ${p.typeName}`}>
      <header className="lsrcard__head" style={{ borderColor: color }}>
        <div>
          <LsrShape cat={p.cat} size={14} />
          <strong style={{ color }}>{p.typeName || p.label}</strong>
          {p.mag && <b className="lsrcard__mag">{p.mag}</b>}
          <span className="lsrcard__cat">{LSR_LABELS[p.cat] ?? "Other"}</span>
        </div>
        <button type="button" onClick={() => select(null)} title="Close">
          <X size={15} />
        </button>
      </header>

      {/* What this report TYPE means — the reason a wind gust report and a wind
          damage report are different things. */}
      {p.desc && <p className="lsrcard__desc">{p.desc}</p>}

      <dl className="lsrcard__rows">
        {rows.map(([icon, k, v]) => (
          <div key={k}>
            <dt>
              {icon}
              {k}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      <div className="lsrcard__remarkhead">Remarks</div>
      {p.remark ? (
        <p className="lsrcard__remark">{p.remark}</p>
      ) : (
        <p className="lsrcard__remark lsrcard__remark--empty">
          No remark was filed with this report.
        </p>
      )}

      {/* The office's own wording, when it differs from our canonical name. */}
      {p.label && p.typeName && p.label.toLowerCase() !== p.typeName.toLowerCase() && (
        <p className="lsrcard__asfiled">Filed as “{p.label}”</p>
      )}
    </div>
  );
}
