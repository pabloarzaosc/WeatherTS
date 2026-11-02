import { useEffect, useMemo, useState } from "react";
import { Building2, ExternalLink, Loader2, Phone, Mail, Radar, Search, X, RefreshCw } from "lucide-react";

import { useAlertListStore } from "../store/useAlertListStore";
import { useAlertStore } from "../store/useAlertStore";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { getMap } from "../map/mapInstance";
import { WFO_BY_ID, WFO_OFFICES, WFO_REGIONS, type WfoOffice } from "../lib/wfoOffices";
import {
  fetchAfdList,
  fetchOffice,
  fetchProduct,
  fetchZoneNames,
  formatAfd,
  type AfdProduct,
  type OfficeInfo,
  type ProductRef,
  type ZoneName,
} from "../lib/nwsOffice";
import { alertWfo } from "../lib/alertTiers";
import { alertBounds, alertInForceAt, type AlertFeature } from "../lib/nwsAlerts";
import { alertDrawColor, tierOf } from "../lib/alertStyle";
import { compareAlerts, expiryPhrase, placesSummary } from "../lib/alertGroups";

/**
 * Forecast offices: every NWS office in a searchable list (code, place,
 * state, region or radar), and an office's page -- its alerts in force, its
 * latest Area Forecast Discussion (formatted or raw), address / phone /
 * website, the radars in its area and the counties and zones it covers.
 * Opened from an alert's office link and from the Radar panel.
 */

const LAYER = "nws-alerts";

function fmtIssued(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const local = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${local} (${d.toISOString().slice(11, 16)}Z)`;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** ".ABQ WATCHES/WARNINGS/ADVISORIES" -> "ABQ watches/warnings/advisories":
 *  sentence case, with office ids and short acronyms kept. */
function sectionTitle(t: string, office: string): string {
  const keep = new Set([office, "AFD", "TAF", "TAFS", "VFR", "MVFR", "IFR", "LIFR", "NWS", "SPC", "WPC", "NHC", "UTC", "CDT", "CST", "EDT", "EST", "MDT", "MST", "PDT", "PST", "AKDT", "HST"]);
  return t
    .split(/(\s+|\/)/)
    .map((w, i) => (keep.has(w.toUpperCase()) ? w.toUpperCase() : i === 0 ? w.charAt(0) + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join("");
}

/** The office whose warning area holds a radar (KTLX -> OUN). */
export function officeForRadar(icao: string | null | undefined): WfoOffice | null {
  if (!icao) return null;
  const k = icao.toUpperCase();
  return WFO_OFFICES.find((o) => o.radars.includes(k)) ?? null;
}

function matches(o: WfoOffice, q: string): boolean {
  const words = q.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [o.id, o.name.toUpperCase(), ...o.states, WFO_REGIONS[o.region]?.toUpperCase() ?? "", ...o.radars, ...o.radars.map((r) => r.slice(1))].join(" ");
  return words.every((w) => hay.includes(w));
}

/* ------------------------------------------------------------ the radars --- */

function useChooseRadar() {
  const sites = useNexradStore((s) => s.sites);
  const selectSite = useNexradStore((s) => s.selectSite);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const close = useAlertListStore((s) => s.closeOffice);
  return (icao: string) => {
    const s = sites.find((x) => x.icao === icao) ?? sites.find((x) => x.id === icao.slice(1));
    setLayerVisible("nexrad", true);
    selectSite(s?.id ?? icao.slice(1));
    const map = getMap();
    if (map && s) map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 6.6), essential: true });
    close();
  };
}

/* ------------------------------------------------------------ the alerts --- */

function OfficeAlerts({ id }: { id: string }) {
  const active = useAlertStore((s) => s.active);
  const features = useAlertStore((s) => s.features);
  const timeFilter = useAlertStore((s) => s.timeFilter);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const close = useAlertListStore((s) => s.closeOffice);
  const list = useMemo(
    () =>
      features
        .filter((f) => alertWfo(f.alert) === id && (timeFilter === null || alertInForceAt(f.alert, timeFilter)))
        .sort((a, b) => compareAlerts(a.alert, b.alert)),
    [features, id, timeFilter],
  );
  const now = timeFilter !== null ? timeFilter * 1000 : Date.now();
  const open = (f: AlertFeature) => {
    close();
    useAlertStore.getState().selectMany([f.alert.id]);
    const b = alertBounds(f.geometry);
    const map = getMap();
    if (map && b) map.fitBounds(b, { padding: 64, maxZoom: 10.5, duration: 700, essential: true });
  };
  if (!active) {
    return (
      <div className="wfo__empty">
        The alerts layer is off.{" "}
        <button type="button" className="wfo__textbtn" onClick={() => setLayerVisible(LAYER, true)}>
          Show NWS alerts
        </button>
      </div>
    );
  }
  if (!list.length) return <div className="wfo__empty">No alerts from {id} in force{timeFilter !== null ? " at this frame" : ""}.</div>;
  return (
    <div className="wfo__alerts">
      {list.map((f) => {
        const a = f.alert;
        const color = alertDrawColor(a);
        const tier = tierOf(a);
        return (
          <button key={a.id} type="button" className="wfo__alert" style={{ borderLeftColor: color }} onClick={() => open(f)}>
            <span className="wfo__alert-top">
              <b>{a.event}</b>
              {tier && (
                <span className="al-tierchip" style={{ ["--chip" as string]: color }}>
                  {tier.label}
                </span>
              )}
              <em>{expiryPhrase(a, now)}</em>
            </span>
            <span className="wfo__alert-places">{placesSummary(a, 4)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ discussion --- */

function Discussion({ id }: { id: string }) {
  const [refs, setRefs] = useState<ProductRef[] | null>(null);
  const [pick, setPick] = useState(0);
  const [prod, setProd] = useState<AfdProduct | null>(null);
  const [raw, setRaw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setRefs(null);
    setProd(null);
    setPick(0);
    setErr(null);
    setBusy(true);
    fetchAfdList(id, ac.signal)
      .then((r) => setRefs(r.slice(0, 16)))
      .catch((e) => !ac.signal.aborted && (setErr(String(e?.message ?? e)), setBusy(false)));
    return () => ac.abort();
  }, [id, nonce]);

  useEffect(() => {
    if (!refs) return;
    if (!refs.length) {
      setBusy(false);
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    fetchProduct(refs[Math.min(pick, refs.length - 1)].id, ac.signal)
      .then((p) => (setProd(p), setErr(null)))
      .catch((e) => !ac.signal.aborted && setErr(String(e?.message ?? e)))
      .finally(() => !ac.signal.aborted && setBusy(false));
    return () => ac.abort();
  }, [refs, pick]);

  const doc = useMemo(() => (prod ? formatAfd(prod.text) : null), [prod]);

  return (
    <section className="wfo__sec">
      <div className="wfo__sechead">
        <h4>Area Forecast Discussion</h4>
        {refs && refs.length > 1 && (
          <select className="wfo__select" value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Discussion issue time">
            {refs.map((r, i) => (
              <option key={r.id} value={i}>
                {i === 0 ? "Latest · " : ""}
                {fmtIssued(r.issued)}
              </option>
            ))}
          </select>
        )}
        <div className="stn__tabs">
          <button type="button" className={`stn__tab${!raw ? " is-on" : ""}`} onClick={() => setRaw(false)}>
            Formatted
          </button>
          <button type="button" className={`stn__tab${raw ? " is-on" : ""}`} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
        <button type="button" className="stn__icon" title="Check for a newer discussion" onClick={() => setNonce((n) => n + 1)}>
          {busy ? <Loader2 size={13} className="stn__spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      {err && <div className="wfo__empty">{err}</div>}
      {refs && refs.length === 0 && <div className="wfo__empty">{id} has no discussion on api.weather.gov.</div>}
      {prod && (
        <div className="wfo__afdmeta">
          Issued {fmtIssued(prod.issued)} · {ago(prod.issued)}
        </div>
      )}
      {prod && raw && <pre className="wfo__raw">{prod.text.trim()}</pre>}
      {prod && !raw && doc && (
        <div className="wfo__afd">
          {doc.sections.length === 0 && <pre className="wfo__raw">{prod.text.trim()}</pre>}
          {doc.sections.map((s, i) => (
            <article key={`${s.title}-${i}`} className="wfo__afdsec">
              <h5>{sectionTitle(s.title, id)}</h5>
              {s.sub.length > 0 && <div className="wfo__afdsub">{s.sub.join(" · ")}</div>}
              {s.blocks.map((b, j) =>
                b.kind === "p" ? (
                  <p key={j}>{b.text}</p>
                ) : b.kind === "list" ? (
                  <ul key={j}>
                    {b.text
                      .split(/\n(?=\s*(?:[-*]|\d+\.)\s)/)
                      .map((li) => li.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\s*\n\s*/g, " "))
                      .map((li, k) => (
                        <li key={k}>{li}</li>
                      ))}
                  </ul>
                ) : (
                  <pre key={j} className="wfo__raw wfo__raw--block">
                    {b.text}
                  </pre>
                ),
              )}
              {s.author && <div className="wfo__author">{s.author}</div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------- counties, zones --- */

type ZoneTab = "counties" | "zones" | "fire";

function Coverage({ info }: { info: OfficeInfo }) {
  const [tab, setTab] = useState<ZoneTab>("counties");
  const [names, setNames] = useState<ZoneName[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ids = tab === "counties" ? info.countyIds : tab === "zones" ? info.zoneIds : info.fireZoneIds;
  useEffect(() => {
    const ac = new AbortController();
    setNames(null);
    setErr(null);
    if (!ids.length) {
      setNames([]);
      return;
    }
    fetchZoneNames(ids, ac.signal)
      .then((n) => setNames([...n].sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name))))
      .catch((e) => !ac.signal.aborted && setErr(String(e?.message ?? e)));
    return () => ac.abort();
  }, [info.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const byState = useMemo(() => {
    const m = new Map<string, ZoneName[]>();
    for (const z of names ?? []) m.set(z.state || "--", [...(m.get(z.state || "--") ?? []), z]);
    return [...m.entries()];
  }, [names]);

  return (
    <section className="wfo__sec">
      <div className="wfo__sechead">
        <h4>Coverage</h4>
        <div className="stn__tabs">
          {(
            [
              ["counties", `Counties ${info.countyIds.length}`],
              ["zones", `Forecast zones ${info.zoneIds.length}`],
              ["fire", `Fire zones ${info.fireZoneIds.length}`],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={`stn__tab${tab === k ? " is-on" : ""}`} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="wfo__empty">{err}</div>}
      {!names && !err && (
        <div className="wfo__empty">
          <Loader2 size={12} className="stn__spin" /> Reading zone names
        </div>
      )}
      {names && names.length === 0 && <div className="wfo__empty">None listed.</div>}
      {byState.map(([st, zs]) => (
        <div key={st} className="wfo__zones">
          <span className="wfo__zst">{st}</span>
          <div className="wfo__zlist">
            {zs.map((z) => (
              <span key={z.id} className="wfo__zone" title={z.id}>
                {z.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------ the office --- */

function OfficePage({ id }: { id: string }) {
  const base = WFO_BY_ID.get(id);
  const [info, setInfo] = useState<OfficeInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const choose = useChooseRadar();

  useEffect(() => {
    const ac = new AbortController();
    setInfo(null);
    setErr(null);
    fetchOffice(id, ac.signal)
      .then(setInfo)
      .catch((e) => !ac.signal.aborted && setErr(String(e?.message ?? e)));
    return () => ac.abort();
  }, [id]);

  return (
    <div className="wfo__page">
      <header className="wfo__pagehead">
        <h3>
          <span>{id}</span> {info?.name ?? base?.name ?? ""}
        </h3>
        <div className="wfo__pagesub">
          {[
            "NWS Weather Forecast Office",
            WFO_REGIONS[info?.region ?? base?.region ?? ""] ? `${WFO_REGIONS[info?.region ?? base?.region ?? ""]} Region` : null,
            base?.states.length ? base.states.join(", ") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </header>

      <div className="wfo__grid">
        <section className="wfo__sec wfo__contact">
          <h4>Office</h4>
          {err && <div className="wfo__empty">{err}</div>}
          {!info && !err && (
            <div className="wfo__empty">
              <Loader2 size={12} className="stn__spin" /> Reading api.weather.gov
            </div>
          )}
          {info && (
            <>
              <address>
                {info.street.split("\n").map((l) => (
                  <span key={l}>{l}</span>
                ))}
                <span>{[info.city, [info.state, info.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</span>
              </address>
              {info.phone && (
                <a className="wfo__line" href={`tel:${info.phone.replace(/[^\d+]/g, "")}`}>
                  <Phone size={12} /> {info.phone}
                </a>
              )}
              {info.email && (
                <a className="wfo__line" href={`mailto:${info.email}`}>
                  <Mail size={12} /> {info.email}
                </a>
              )}
              <a className="wfo__line" href={info.website} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> {info.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            </>
          )}
          {base && base.radars.length > 0 && (
            <div className="wfo__radars">
              <span className="wfo__label">
                <Radar size={12} /> Radars in its area
              </span>
              <div className="wfo__radarbtns">
                {base.radars.map((r) => (
                  <button key={r} type="button" className="wfo__radar" onClick={() => choose(r)} title={`Load ${r}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
        <section className="wfo__sec">
          <h4>Alerts in force</h4>
          <OfficeAlerts id={id} />
        </section>
      </div>

      <Discussion id={id} />
      {info && <Coverage info={info} />}
    </div>
  );
}

/* ------------------------------------------------------------ the dialog --- */

export function ForecastOfficePanel() {
  const open = useAlertListStore((s) => s.officeOpen);
  const officeId = useAlertListStore((s) => s.officeId);
  const openOffice = useAlertListStore((s) => s.openOffice);
  const close = useAlertListStore((s) => s.closeOffice);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const list = useMemo(() => WFO_OFFICES.filter((o) => matches(o, q)), [q]);
  if (!open) return null;

  return (
    <div className="stn wfo" role="dialog" aria-modal="true" aria-label="Forecast offices">
      <div className="stn__scrim" onClick={close} />
      <div className="stn__panel wfo__panel">
        <header className="stn__top">
          <div className="stn__ident">
            <h2>
              <Building2 size={16} />
            </h2>
            <div>
              <b>Forecast offices</b>
              <span>{WFO_OFFICES.length} NWS offices · api.weather.gov</span>
            </div>
          </div>
          <div className="stn__topright">
            <button type="button" className="stn__icon" onClick={close} title="Close (Esc)" aria-label="Close">
              <X size={14} />
            </button>
          </div>
        </header>
        <div className="stn__body wfo__body">
          <aside className="stn__side wfo__side">
            <label className="evl__search">
              <Search size={13} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Code, place, state or radar"
                aria-label="Search offices"
                autoFocus
              />
            </label>
            <div className="wfo__count">
              {list.length === WFO_OFFICES.length ? `${list.length} offices` : `${list.length} of ${WFO_OFFICES.length}`}
            </div>
            <div className="wfo__list">
              {list.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`wfo__item${officeId === o.id ? " is-on" : ""}`}
                  onClick={() => openOffice(o.id)}
                >
                  <span className="wfo__code">{o.id}</span>
                  <span className="wfo__name">{o.name}</span>
                  <span className="wfo__meta">{o.radars.join(" ") || o.states.join(" ")}</span>
                </button>
              ))}
              {list.length === 0 && <div className="wfo__empty">No office matches "{q}".</div>}
            </div>
          </aside>
          <main className="stn__main wfo__main">
            {officeId ? (
              <OfficePage key={officeId} id={officeId} />
            ) : (
              <div className="wfo__pick">
                <Building2 size={22} />
                <p>Pick an office on the left, or search by its code, a place, a state or one of its radars.</p>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ entry points --- */

/** The issuing office as a link: opens its page. */
export function OfficeLink({ wfo, className }: { wfo: string; className?: string }) {
  const openOffice = useAlertListStore((s) => s.openOffice);
  if (!wfo) return null;
  return (
    <button
      type="button"
      className={className ?? "wfo-link"}
      onClick={(e) => {
        e.stopPropagation();
        openOffice(wfo);
      }}
      title={`NWS ${wfo}${WFO_BY_ID.get(wfo) ? ` (${WFO_BY_ID.get(wfo)!.name})` : ""}: alerts, discussion, contact`}
    >
      NWS {wfo}
    </button>
  );
}

/** Radar panel row: the office whose area holds the radar, and the browser. */
export function RadarOfficeRow() {
  const siteId = useNexradStore((s) => s.site);
  const sites = useNexradStore((s) => s.sites);
  const openOffice = useAlertListStore((s) => s.openOffice);
  const here = sites.find((s) => s.id === siteId);
  const icao = here?.icao ?? (siteId && siteId.length === 3 ? `K${siteId}` : siteId);
  // An airport radar is not on the offices' lists of radars: its record names the office.
  const office = (here?.type === "TDWR" ? WFO_OFFICES.find((o) => o.id === here.wfo) : null) ?? officeForRadar(icao);
  return (
    <div className="sfcobs__toggle-row wfo-row">
      <span>
        Forecast office
        {office ? <small> {office.id} · {office.name}</small> : null}
      </span>
      <button type="button" className="wfo-row__btn" onClick={() => openOffice(office?.id ?? null)}>
        {office ? "Open" : "Browse"}
      </button>
    </div>
  );
}
