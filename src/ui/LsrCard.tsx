import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Crosshair,
  Gauge,
  MapPin,
  Radar,
  Radio,
  Send,
  X,
} from "lucide-react";

import {
  LSR_COLORS,
  LSR_LABELS,
  LSR_SEVERITY_LABELS,
  distanceKm,
  lsrHm,
  lsrKey,
  lsrPlace,
  lsrSeverity,
  lsrText,
  lsrUtc,
  type LsrFeature,
} from "../lib/lsr";
import { lsrFeed, selectVisibleLsr, useLsrStore, type LsrBounds } from "../store/useLsrStore";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { getMap } from "../map/mapInstance";
import { LsrShape } from "./LsrShape";

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

/** Nearby: other reports this close in space and time -- one storm's trail. */
const NEAR_KM = 25;
const NEAR_S = 90 * 60;
const NEAR_MAX = 6;
/** Farther than this from every radar, "radar at this time" has nothing to show. */
const RADAR_MAX_KM = 320;

function mapBounds(): LsrBounds | null {
  const b = getMap()?.getBounds();
  return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
}

function flyTo(f: LsrFeature, zoom = 7) {
  const map = getMap();
  map?.flyTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), zoom), essential: true });
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The clipboard API wants a focused, permitted page; the old way still works.
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** The full text of one Local Storm Report, opened by clicking its icon. */
export function LsrCard() {
  const selected = useLsrStore((s) => s.selected);
  const select = useLsrStore((s) => s.select);
  const data = useLsrStore((s) => s.data);
  const cats = useLsrStore((s) => s.cats);
  const minSeverity = useLsrStore((s) => s.minSeverity);
  const search = useLsrStore((s) => s.search);
  const sort = useLsrStore((s) => s.sort);
  const inView = useLsrStore((s) => s.inView);
  const sites = useNexradStore((s) => s.sites);
  const [copied, setCopied] = useState<"text" | "coords" | null>(null);

  const key = selected ? lsrKey(selected) : null;
  useEffect(() => setCopied(null), [key]);

  // The list the panel shows, to step through it from here.
  const feed = useMemo(
    () => (selected ? lsrFeed(selectVisibleLsr({ data, cats, minSeverity }), { search, sort, bounds: inView ? mapBounds() : null }) : []),
    // Bounds are read when the card opens on a report, not on every move:
    // stepping should not reshuffle the list as the map flies along it.
    [data, cats, minSeverity, search, sort, inView, key],
  );
  const at = key ? feed.findIndex((f) => lsrKey(f) === key) : -1;
  const step = (d: number) => {
    if (feed.length === 0) return;
    const next = feed[(at < 0 ? 0 : at + d + feed.length) % feed.length];
    select(next);
    flyTo(next);
  };

  const nearby = useMemo(() => {
    if (!selected || !data) return [];
    const here = selected.geometry.coordinates as [number, number];
    return data.features
      .filter((f) => lsrKey(f) !== key && Math.abs(f.properties.unix - selected.properties.unix) <= NEAR_S)
      .map((f) => ({ f, km: distanceKm(here, f.geometry.coordinates as [number, number]) }))
      .filter((x) => x.km <= NEAR_KM)
      .sort((a, b) => a.km - b.km);
  }, [selected, data, key]);

  const radar = useMemo(() => {
    if (!selected) return null;
    const here = selected.geometry.coordinates as [number, number];
    let best: { id: string; icao: string; km: number } | null = null;
    for (const s of sites) {
      if (s.online === false) continue;
      const km = distanceKm(here, [s.lon, s.lat]);
      if (!best || km < best.km) best = { id: s.id, icao: s.icao, km };
    }
    return best && best.km <= RADAR_MAX_KM ? best : null;
  }, [selected, sites]);

  // Up and down step through the list, Escape closes -- unless typing
  // somewhere. Left and right stay the timeline's. Caught on the way down, so a
  // focused map does not also pan with them.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") {
        select(null);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();
      step(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // The radar list comes with the radar catalogue; load it if the radar has
  // not been opened yet, so the button knows its nearest site.
  useEffect(() => {
    if (selected && sites.length === 0) void useNexradStore.getState().loadCatalog();
  }, [selected, sites.length]);

  if (!selected) return null;

  const p = selected.properties;
  const color = LSR_COLORS[p.cat] ?? LSR_COLORS.other;
  const [lon, lat] = selected.geometry.coordinates;
  const coords = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const sev = lsrSeverity(p);

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
      ) : p.code === "T" ? (
        // A rating comes from the damage survey, often a day later.
        <em>not rated yet</em>
      ) : (
        "--"
      ),
    ],
    [
      <Clock size={11} key="e" />,
      "Event time",
      <>
        {lsrUtc(p.unix)} <em>({fmtAgo(p.unix)})</em>
      </>,
    ],
    [<Send size={11} key="i" />, "Issued", lsrUtc(p.issuedUnix)],
    [<Radio size={11} key="s" />, "Source", p.source || "--"],
    [<Building2 size={11} key="o" />, "Office", p.wfo ? `K${p.wfo}` : "--"],
    [<MapPin size={11} key="c" />, "Coordinates", coords],
  ];

  const openRadar = () => {
    if (!radar) return;
    useAppStore.getState().setLayerVisible("nexrad", true);
    useNexradStore.getState().openAt(radar.id, p.unix);
    flyTo(selected, 7.5);
  };

  const doCopy = async (what: "text" | "coords") => {
    if (await copy(what === "text" ? lsrText(selected) : coords)) {
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
    }
  };

  return (
    <div className="lsrcard" role="dialog" aria-label={`Storm report: ${p.typeName}`}>
      <header className="lsrcard__head" style={{ borderColor: color }}>
        <div>
          <LsrShape cat={p.cat} size={14} />
          <strong style={{ color }}>{p.typeName || p.label}</strong>
          {p.mag && <b className="lsrcard__mag">{p.mag}</b>}
          <span className="lsrcard__cat">{LSR_LABELS[p.cat] ?? "Other"}</span>
          {sev > 0 && <span className={`lsrcard__sev lsrcard__sev--${sev}`}>{LSR_SEVERITY_LABELS[sev]}</span>}
        </div>
        <span className="lsrcard__step">
          <button type="button" onClick={() => step(-1)} disabled={feed.length < 2} title="Previous in the list (↑)" aria-label="Previous report">
            <ChevronLeft size={13} />
          </button>
          <span>{at >= 0 ? `${at + 1}/${feed.length}` : `–/${feed.length}`}</span>
          <button type="button" onClick={() => step(1)} disabled={feed.length < 2} title="Next in the list (↓)" aria-label="Next report">
            <ChevronRight size={13} />
          </button>
          <button type="button" className="lsrcard__close" onClick={() => select(null)} title="Close (Esc)" aria-label="Close">
            <X size={15} />
          </button>
        </span>
      </header>

      <div className="lsrcard__actions">
        <button type="button" onClick={() => flyTo(selected, 9)} title="Zoom the map in on this report">
          <Crosshair size={12} />
          Zoom
        </button>
        <button
          type="button"
          onClick={openRadar}
          disabled={!radar}
          title={
            radar
              ? `${radar.icao}, ${Math.round(radar.km)} km away: its loop from a little before ${lsrHm(p.unix)}, opened on the scan at that time`
              : "No radar close enough to this report"
          }
        >
          <Radar size={12} />
          Radar at {lsrHm(p.unix)}
        </button>
        <button type="button" onClick={() => void doCopy("text")} title="Copy the report as one line of text">
          {copied === "text" ? <Check size={12} /> : <Copy size={12} />}
          {copied === "text" ? "Copied" : "Copy"}
        </button>
      </div>

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
            <dd>
              {k === "Coordinates" ? (
                <button type="button" className="lsrcard__coords" onClick={() => void doCopy("coords")} title="Copy the coordinates">
                  {copied === "coords" ? "copied" : v}
                </button>
              ) : (
                v
              )}
            </dd>
          </div>
        ))}
      </dl>

      <div className="lsrcard__remarkhead">Remarks</div>
      {p.remark ? (
        <p className="lsrcard__remark">{p.remark}</p>
      ) : (
        <p className="lsrcard__remark lsrcard__remark--empty">No remark was filed with this report.</p>
      )}

      {nearby.length > 0 && (
        <>
          <div className="lsrcard__remarkhead lsrcard__nearhead">
            Nearby <em>within {NEAR_KM} km and 90 min · {nearby.length}</em>
          </div>
          <ul className="lsrcard__near">
            {nearby.slice(0, NEAR_MAX).map(({ f, km }) => (
              <li key={lsrKey(f)}>
                <button
                  type="button"
                  onClick={() => {
                    select(f);
                    flyTo(f);
                  }}
                >
                  <LsrShape cat={f.properties.cat} size={11} />
                  <span>
                    {f.properties.typeName || f.properties.label}
                    {f.properties.mag ? ` ${f.properties.mag}` : ""}
                  </span>
                  <em>
                    {Math.round(km)} km · {lsrHm(f.properties.unix)}
                  </em>
                </button>
              </li>
            ))}
            {nearby.length > NEAR_MAX && <li className="lsrcard__nearmore">+{nearby.length - NEAR_MAX} more</li>}
          </ul>
        </>
      )}

      {/* The office's own wording, when it differs from our canonical name. */}
      {p.label && p.typeName && p.label.toLowerCase() !== p.typeName.toLowerCase() && (
        <p className="lsrcard__asfiled">Filed as “{p.label}” · NWS Local Storm Reports</p>
      )}
    </div>
  );
}
