import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Copy, AlertTriangle, ChevronLeft, Clock, MapPin, Radio, Radar, Eye, EyeOff, Crosshair, Search } from "lucide-react";

import { MesoscaleList } from "./MesoscaleList";
import { selectVisibleAlerts, useAlertStore } from "../store/useAlertStore";
import type { AlertFeature } from "../lib/nwsAlerts";
import {
  alertBounds,
  alertCentroid,
  alertSummaryFacts,
  humanAlertParameters,
  param,
  formatDuration,
  timeLeftPhrase,
} from "../lib/nwsAlerts";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { useSettingsStore } from "../settings/useSettingsStore";
import { alertDrawColor, alertFilters, passesAlertFilters, tierOf } from "../lib/alertStyle";
import { flashingIds, onFlashChange } from "../lib/alertFlash";
import { getMap, subscribeMaps } from "../map/mapInstance";
import { eventKey, useAlertListStore } from "../store/useAlertListStore";
import { useMesoscaleStore } from "../store/useMesoscaleStore";
import { alertWfo } from "../lib/alertTiers";
import {
  ALERT_GROUPS,
  SEVERITY_FILTERS,
  agePhrase,
  alertGroup,
  alertTags,
  compareAlerts,
  expiryPhrase,
  matchesText,
  passesSeverity,
  placesSummary,
  untilClock,
  type SeverityFilter,
} from "../lib/alertGroups";
import { OfficeLink } from "./ForecastOfficePanel";
import { haversine, formatDistance } from "../lib/measure";
import type { NexradSite } from "../lib/nexrad";

/** unix seconds -> "16 21:58Z", matching the timeline's chip. */
function fmtZ(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function fmtTime(iso?: string | null): { local: string; utc: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const local = d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const utc = `${d.toISOString().slice(0, 16).replace("T", " ")}Z`;
  return { local, utc };
}

function TimeRow({ label, iso }: { label: string; iso?: string | null }) {
  const t = fmtTime(iso);
  if (!t) return null;
  return (
    <div className="al-time">
      <span className="al-time__label">{label}</span>
      <span className="al-time__local">{t.local}</span>
      <span className="al-time__utc">{t.utc}</span>
    </div>
  );
}

/**
 * The two NEXRAD sites closest to an alert's footprint. Clicking one turns the
 * radar layer on, loads that site's scan, and recenters the map on the alert --
 * so a warning polygon (clicked on the map, or opened from the side list) is one
 * click away from the radar underneath it. Nothing renders for alerts without a
 * drawable footprint, or before the site catalog has loaded.
 */
function NearestRadars({ feature }: { feature: AlertFeature }) {
  const sites = useNexradStore((s) => s.sites);
  const activeSite = useNexradStore((s) => s.site);
  const selectSite = useNexradStore((s) => s.selectSite);
  const loadCatalog = useNexradStore((s) => s.loadCatalog);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  // The catalog is loaded lazily by the radar panel; pull it in here too so this
  // works even if the user opens an alert before ever touching radar. Idempotent.
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const center = useMemo(() => alertCentroid(feature.geometry), [feature.geometry]);
  const picks = useMemo(() => {
    if (!center) return [] as Array<{ s: NexradSite; m: number }>;
    return sites
      .filter((s) => s.online !== false && s.type !== "TDWR" && Number.isFinite(s.lat) && Number.isFinite(s.lon))
      .map((s) => ({ s, m: haversine(center, [s.lon, s.lat]) }))
      .sort((a, b) => a.m - b.m)
      .slice(0, 2);
  }, [center, sites]);

  if (!center || picks.length === 0) return null;

  const choose = (s: NexradSite) => {
    setLayerVisible("nexrad", true);
    selectSite(s.id);
    const map = getMap();
    // keep the alert the user clicked centered; the scan loads over it
    if (map) map.flyTo({ center, zoom: Math.max(map.getZoom(), 7.2), essential: true });
  };

  return (
    <section className="al-section">
      <h4 className="al-section__label">
        <Radar size={12} /> Nearest radar
      </h4>
      <div className="al-radars">
        {picks.map(({ s, m }) => (
          <button
            key={s.id}
            type="button"
            className={`al-radar${activeSite === s.id ? " is-active" : ""}`}
            onClick={() => choose(s)}
            title={`Load ${s.icao} — ${s.name}`}
          >
            <span className="al-radar__icao">{s.icao}</span>
            <span className="al-radar__name">{s.name}</span>
            <span className="al-radar__dist">{formatDistance(m, "imperial")}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function AlertDetail({
  feature,
  now,
}: {
  feature: AlertFeature;
  now: number;
}) {
  const a = feature.alert;
  const p = a.parameters;
  const color = alertDrawColor(a);
  const tier = tierOf(a);

  const startMs = Date.parse(a.onset ?? a.effective);
  const expireMs = Date.parse(a.expires);
  const endMs = a.ends ? Date.parse(a.ends) : expireMs;
  const duration = formatDuration(endMs - startMs);

  let statusKind: "active" | "upcoming" | "expired";
  let statusText: string;
  if (now >= expireMs) {
    statusKind = "expired";
    statusText = "Expired";
  } else if (now < startMs) {
    statusKind = "upcoming";
    statusText = `Starts ${timeLeftPhrase(startMs - now)}`;
  } else {
    statusKind = "active";
    statusText = "Active now";
  }

  const upper = `${a.event} ${a.headline ?? ""} ${a.description}`.toUpperCase();
  const tornadoThreat = param(p, "tornadoDamageThreat");
  const flashThreat = param(p, "flashFloodDamageThreat");
  const isEmergency =
    upper.includes("TORNADO EMERGENCY") ||
    upper.includes("FLASH FLOOD EMERGENCY") ||
    tornadoThreat === "CATASTROPHIC" ||
    flashThreat === "CATASTROPHIC";
  const isPDS =
    upper.includes("PARTICULARLY DANGEROUS SITUATION") || tornadoThreat === "CONSIDERABLE";

  const summaryFacts = alertSummaryFacts(a, now);
  const params = humanAlertParameters(a);

  const zones = a.areaDesc
    .split(";")
    .map((z) => z.trim())
    .filter(Boolean);

  const copyText = () => {
    const t = (iso?: string | null) => {
      const ft = fmtTime(iso);
      return ft ? `${ft.local}  (${ft.utc})` : "---";
    };
    const lines = [
      `${a.event}${a.headline ? ` - ${a.headline}` : ""}`,
      "",
      `Status:    ${statusText}`,
      `Severity:  ${a.severity}  -  Certainty: ${a.certainty}  -  Urgency: ${a.urgency}`,
      `Message:   ${a.messageType}  -  Category: ${a.category}`,
      "",
      `Sent:      ${t(a.sent)}`,
      `Effective: ${t(a.effective)}`,
      ...(a.onset ? [`Onset:     ${t(a.onset)}`] : []),
      `Expires:   ${t(a.expires)}`,
      ...(a.ends ? [`Ends:      ${t(a.ends)}`] : []),
      `Duration:  ${duration}`,
      ...(params.length ? ["", "Parameters:", ...params.map((pr) => `  ${pr.label}: ${pr.value}`)] : []),
      "",
      `Area (${zones.length}): ${a.areaDesc}`,
      `Issued by: ${a.senderName}`,
      "",
      a.description,
      ...(a.instruction ? ["", "PRECAUTIONARY/PREPAREDNESS ACTIONS...", "", a.instruction] : []),
    ];
    if (navigator.clipboard) navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  };

  return (
    <article className="al-detail">
      <header className="al-detail__head">
        <span className="al-detail__dot" style={{ color }} />
        <div className="al-detail__title">
          <span className="al-detail__event">{a.event}</span>
          {a.headline && <span className="al-detail__headline">{a.headline}</span>}
        </div>
      </header>

      {summaryFacts.length > 0 && (
        <div className="al-summary" style={{ color }}>
          {summaryFacts.map((fact) => (
            <div key={fact.key} className="al-summary__item">
              <b>{fact.label}:</b> {fact.value}
            </div>
          ))}
        </div>
      )}

      {(isEmergency || isPDS || tier) && (
        <div className="al-badges">
          {tier && (
            <span className="al-tierchip" style={{ ["--chip" as string]: color }} title={tier.hint}>
              {tier.label}
            </span>
          )}
          {isEmergency && !tier && (
            <span className="al-badge al-badge--emergency">
              <AlertTriangle size={12} /> EMERGENCY
            </span>
          )}
          {isPDS && !tier && <span className="al-badge al-badge--pds">PDS</span>}
        </div>
      )}

      <div className={`al-status al-status--${statusKind}`}>
        <Clock size={13} />
        <span className="al-status__text">{statusText}</span>
        {statusKind === "active" && (
          <span className="al-status__cd">expires {timeLeftPhrase(expireMs - now)}</span>
        )}
      </div>

      <NearestRadars feature={feature} />

      <section className="al-section">
        <h4 className="al-section__label">Timing - total {duration}</h4>
        <div className="al-times">
          <TimeRow label="Sent" iso={a.sent} />
          <TimeRow label="Effective" iso={a.effective} />
          {a.onset && <TimeRow label="Onset" iso={a.onset} />}
          <TimeRow label="Expires" iso={a.expires} />
          {a.ends && <TimeRow label="Ends" iso={a.ends} />}
        </div>
      </section>

      {params.length > 0 && (
        <section className="al-section">
          <h4 className="al-section__label">
            <Radio size={12} /> Parameters
          </h4>
          <div className="al-params">
            {params.map((pr) => (
              <div key={pr.key} className="al-param">
                <span>{pr.label}</span>
                <b>{pr.value}</b>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="al-section">
        <h4 className="al-section__label">
          <MapPin size={12} /> Affected area - {zones.length} {zones.length === 1 ? "zone" : "zones"}
        </h4>
        <div className="al-zones">
          {zones.map((z, i) => (
            <span key={`${z}-${i}`} className="al-zone">
              {z}
            </span>
          ))}
        </div>
        {a.senderName && (
          <p className="al-sender">
            {a.senderName} <OfficeLink wfo={alertWfo(a)} />
          </p>
        )}
      </section>

      <section className="al-section">
        <div className="al-section__bar">
          <h4 className="al-section__label">Full text</h4>
          <button type="button" className="al-copy" onClick={copyText}>
            <Copy size={12} /> Copy
          </button>
        </div>
        <pre className="al-text">{a.description}</pre>
        {a.instruction && (
          <>
            <h5 className="al-instr-label">Precautionary / preparedness actions</h5>
            <pre className="al-text al-text--instr">{a.instruction}</pre>
          </>
        )}
      </section>
    </article>
  );
}

function sortAlerts(features: AlertFeature[]): AlertFeature[] {
  return [...features].sort((a, b) => compareAlerts(a.alert, b.alert));
}

/** When each alert id first reached the list (ms), for the slide-in glow.
 *  Module-level so an alert that came in while the detail was open still
 *  slides in when the list comes back; the first fill is the silent baseline. */
const firstSeen = new Map<string, number>();
let baselineDone = false;
const NEW_MS = 10_000;

/** A map frame in lon/lat, for "in view". */
type View = [number, number, number, number] | null;

function useMapView(enabled: boolean): View {
  const [view, setView] = useState<View>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const m = getMap();
      if (!m) return;
      const b = m.getBounds();
      setView([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    let bound: ReturnType<typeof getMap> = null;
    const bind = () => {
      bound?.off("moveend", read);
      bound = getMap();
      bound?.on("moveend", read);
      read();
    };
    bind();
    const unsub = subscribeMaps(bind);
    return () => {
      unsub();
      bound?.off("moveend", read);
    };
  }, [enabled]);
  return enabled ? view : null;
}

function inView(f: AlertFeature, v: View): boolean {
  if (!v) return true;
  const b = alertBounds(f.geometry);
  if (!b) return false;
  return b[0][0] <= v[2] && b[1][0] >= v[0] && b[0][1] <= v[3] && b[1][1] >= v[1];
}

/**
 * One alert of the list: colour stripe, name, tier, places, age, hail / wind,
 * end time, the office link, Focus on map and Hide on map. Drawn again only
 * when its alert, the minute or its flags change (a playing timeline redraws
 * the list every frame).
 */
const AlertRow = memo(function AlertRow({
  feature,
  minute,
  flashing,
  fresh,
  hidden,
  onSelect,
}: {
  feature: AlertFeature;
  minute: number;
  flashing: boolean;
  fresh: boolean;
  hidden: boolean;
  onSelect: (id: string) => void;
}) {
  const a = feature.alert;
  const now = minute * 60_000;
  const color = alertDrawColor(a);
  const tier = tierOf(a);
  const tags = alertTags(a);
  const wfo = alertWfo(a);
  const hideAlert = useAlertListStore((s) => s.hideAlert);
  const focus = () => {
    const b = alertBounds(feature.geometry);
    const map = getMap();
    if (map && b) map.fitBounds(b, { padding: 64, maxZoom: 10.5, duration: 700, essential: true });
  };
  const upper = `${a.event} ${a.headline ?? ""}`.toUpperCase();
  const isEmergency = upper.includes("EMERGENCY") && /TORNADO|FLASH FLOOD/.test(upper);
  return (
    <div
      className={`alrow${flashing ? " is-flashing" : ""}${fresh ? " is-new" : ""}${hidden ? " is-hidden" : ""}`}
      style={{ ["--al" as string]: color }}
    >
      <button type="button" className="alrow__main" onClick={() => onSelect(a.id)} title="Full text">
        <span className="alrow__top">
          <b className="alrow__event">{a.event}</b>
          {tier ? (
            <span className="al-tierchip" style={{ ["--chip" as string]: color }} title={tier.hint}>
              {tier.label}
            </span>
          ) : isEmergency ? (
            <span className="alert-list__flag alert-list__flag--emergency">Emergency</span>
          ) : null}
          <span className="alrow__age">{agePhrase(a, now).replace(/^Issued /, "")}</span>
        </span>
        <span className="alrow__places">{placesSummary(a)}</span>
        <span className="alrow__facts">
          {tags.map((t) => (
            <span key={t.key} className={`alpt__tag${t.hot ? " is-hot" : ""}`}>
              {t.text}
            </span>
          ))}
          <span className="alrow__until">{expiryPhrase(a, now) === "Expired" ? "Expired" : untilClock(a, now)}</span>
          {!feature.geometry && <span className="alrow__nomap">No map polygon</span>}
        </span>
      </button>
      <span className="alrow__acts">
        <OfficeLink wfo={wfo} className="wfo-link" />
        <button type="button" className="alrow__act" onClick={focus} title="Focus on map" aria-label="Focus on map" disabled={!feature.geometry}>
          <Crosshair size={13} />
        </button>
        <button
          type="button"
          className="alrow__act"
          onClick={() => hideAlert(a.id, !hidden)}
          title={hidden ? "Show on map" : "Hide on map"}
          aria-label={hidden ? "Show on map" : "Hide on map"}
        >
          {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </span>
    </div>
  );
});

function EyeButton({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`algrp__eye${on ? "" : " is-off"}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={on ? `Hide ${label} on the map` : `Show ${label} on the map`}
      aria-label={on ? `Hide ${label} on the map` : `Show ${label} on the map`}
      aria-pressed={!on}
    >
      {on ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
}

function AlertList({
  features,
  status,
  message,
  now,
  timeFilter,
  onSelect,
}: {
  features: AlertFeature[];
  status: string;
  message: string | null;
  now: number;
  timeFilter: number | null;
  onSelect: (id: string) => void;
}) {
  const hiddenGroups = useAlertListStore((s) => s.hiddenGroups);
  const hiddenTypes = useAlertListStore((s) => s.hiddenTypes);
  const hiddenIds = useAlertListStore((s) => s.hiddenIds);
  const severity = useAlertListStore((s) => s.severity);
  const text = useAlertListStore((s) => s.text);
  const inViewOn = useAlertListStore((s) => s.inView);
  const toggleGroup = useAlertListStore((s) => s.toggleGroup);
  const toggleType = useAlertListStore((s) => s.toggleType);
  const setSeverity = useAlertListStore((s) => s.setSeverity);
  const setText = useAlertListStore((s) => s.setText);
  const setInView = useAlertListStore((s) => s.setInView);
  const showAll = useAlertListStore((s) => s.showAll);
  const mds = useMesoscaleStore((s) => s.mds);
  const mdOn = useAppStore((s) => s.layers["spc-md"]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const view = useMapView(inViewOn);

  // New alerts glow while their map flash runs, and slide in when they reach the list.
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set(flashingIds()));
  useEffect(() => onFlashChange(() => setFlashing(new Set(flashingIds()))), []);
  const nowMs = Date.now();
  for (const f of features) if (!firstSeen.has(f.alert.id)) firstSeen.set(f.alert.id, baselineDone ? nowMs : 0);
  if (features.length) baselineDone = true;
  // drop the glow class once its 10 s are over
  const [, setTick] = useState(0);
  const freshCount = features.filter((f) => nowMs - (firstSeen.get(f.alert.id) ?? 0) < NEW_MS).length;
  useEffect(() => {
    if (!freshCount) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), NEW_MS + 50);
    return () => window.clearTimeout(t);
  }, [freshCount]);

  const minute = Math.floor((timeFilter !== null ? timeFilter * 1000 : now) / 60_000);
  const shown = features.filter((f) => passesSeverity(f.alert, severity) && matchesText(f.alert, text, alertWfo(f.alert)) && inView(f, view));
  const narrowed = severity !== "any" || text.trim() !== "" || inViewOn;

  const groups = ALERT_GROUPS.map((g) => {
    const alerts = sortAlerts(shown.filter((f) => alertGroup(f.alert) === g.id));
    const types = new Map<string, { event: string; alerts: AlertFeature[] }>();
    for (const f of alerts) {
      const k = eventKey(f.alert.event);
      const t = types.get(k) ?? { event: f.alert.event, alerts: [] };
      t.alerts.push(f);
      types.set(k, t);
    }
    return { ...g, alerts, types: [...types.entries()] };
  });
  const mdLive = mds.filter((md) => {
    const t = timeFilter ?? now / 1000;
    return md.validStartUnix == null || md.validEndUnix == null || (md.validStartUnix <= t && t <= md.validEndUnix);
  }).length;
  const anyHidden = hiddenGroups.length + hiddenTypes.length + hiddenIds.length > 0;
  const emptyText = status === "loading" && features.length === 0 ? "Loading" : inViewOn ? "None in view" : narrowed ? "None match" : "None";

  return (
    <>
      <div className="alert-list__head">
        <div>
          <span className="alert-list__title">
            NWS Alerts{timeFilter !== null && <span className="alert-list__astag"> at {fmtZ(timeFilter)}</span>}
          </span>
          <span className="alert-list__count">
            {status === "loading"
              ? "Loading..."
              : narrowed
                ? `${shown.length} of ${features.length} ${timeFilter !== null ? "in force" : "active"}`
                : timeFilter !== null
                  ? `${features.length} in force`
                  : message ?? `${features.length} active`}
          </span>
        </div>
      </div>

      <div className="alfilt">
        <label className="evl__search alfilt__search">
          <Search size={13} />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter: county, event, office, text" aria-label="Filter the alert list" />
          {text && (
            <button type="button" className="alfilt__clear" onClick={() => setText("")} aria-label="Clear the filter">
              <X size={12} />
            </button>
          )}
        </label>
        <div className="alfilt__row">
          <select className="alfilt__sev" value={severity} onChange={(e) => setSeverity(e.target.value as SeverityFilter)} aria-label="Severity">
            {SEVERITY_FILTERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="button" className={`alfilt__chip${inViewOn ? " is-on" : ""}`} onClick={() => setInView(!inViewOn)} aria-pressed={inViewOn} title="List only the alerts inside the map view">
            In view
          </button>
          {anyHidden && (
            <button type="button" className="alfilt__chip" onClick={showAll} title="Show every hidden group, type and alert on the map again">
              Show all
            </button>
          )}
        </div>
        <span className="alfilt__note">Filters change the list only; the eyes change the map.</span>
      </div>

      <div className="alert-list__body">
        {status === "error" && <div className="alert-list__empty">{message ?? "Unable to load alerts."}</div>}
        {groups.map((g) => {
          if (g.id === "discussion") {
            return (
              <section key={g.id} className="algrp">
                <header className="algrp__head">
                  <EyeButton on={mdOn} onClick={() => setLayerVisible("spc-md", !mdOn)} label="discussions" />
                  <span className="algrp__label">{g.label}</span>
                  <span className="algrp__count">{mdLive}</span>
                  {mdLive === 0 && <span className="algrp__none">{inViewOn ? "None in view" : "None"}</span>}
                </header>
                {/* SPC and WPC discussions: on a chase day "is a watch coming" is answered here. */}
                <MesoscaleList />
              </section>
            );
          }
          const groupHidden = hiddenGroups.includes(g.id);
          return (
            <section key={g.id} className={`algrp${groupHidden ? " is-hidden" : ""}`}>
              <header className="algrp__head">
                <EyeButton on={!groupHidden} onClick={() => toggleGroup(g.id)} label={g.label.toLowerCase()} />
                <span className="algrp__label">{g.label}</span>
                <span className="algrp__count">{g.alerts.length}</span>
                {g.alerts.length === 0 && <span className="algrp__none">{emptyText}</span>}
                {groupHidden && g.alerts.length > 0 && <span className="algrp__none">Hidden on map</span>}
              </header>
              {!groupHidden &&
                g.types.map(([k, t]) => {
                  const typeHidden = hiddenTypes.includes(k);
                  return (
                    <div key={k} className={`altype${typeHidden ? " is-hidden" : ""}`}>
                      <div className="altype__head">
                        <EyeButton on={!typeHidden} onClick={() => toggleType(k)} label={t.event} />
                        <span className="altype__sw" style={{ background: alertDrawColor(t.alerts[0].alert) }} />
                        <span className="altype__label">{t.event}</span>
                        <span className="algrp__count">{t.alerts.length}</span>
                        {typeHidden && <span className="algrp__none">Hidden on map</span>}
                      </div>
                      {!typeHidden &&
                        t.alerts.map((feature) => (
                          // At a past instant of the timeline times count from that instant.
                          <AlertRow
                            key={feature.alert.id}
                            feature={feature}
                            minute={minute}
                            flashing={flashing.has(feature.alert.id)}
                            fresh={nowMs - (firstSeen.get(feature.alert.id) ?? 0) < NEW_MS}
                            hidden={hiddenIds.includes(feature.alert.id)}
                            onSelect={onSelect}
                          />
                        ))}
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>
    </>
  );
}

/**
 * The docked alert rail. It holds either the list or the full record of the
 * alerts you clicked (overlapping polygons show every one in sequence).
 *
 * It is a column, not a floating card: `.app--alerts-open` gives it --alert-w
 * and the map shrinks to match, so it can't cover the radar chrome. Opening and
 * closing is the top bar's job, the same as the left side panel.
 */
export function AlertPanel() {
  // Colours come from eventColor(), which reads Settings: subscribing here
  // repaints the list and the detail the moment one is changed.
  const settingsValues = useSettingsStore((s) => s.values);
  const selectedId = useAlertStore((s) => s.selectedId);
  const selectedIds = useAlertStore((s) => s.selectedIds);
  const allFeatures = useAlertStore((s) => s.features);
  const timeFilter = useAlertStore((s) => s.timeFilter);
  const categoryFilters = useAlertStore((s) => s.categoryFilters);
  // Settings' filters (types switched off, states, offices, only active)
  // change the list as they change the map.
  const features = useMemo(() => {
    const f = alertFilters();
    const t = timeFilter ?? Date.now() / 1000;
    return selectVisibleAlerts({ features: allFeatures, timeFilter, categoryFilters }).filter((x) => passesAlertFilters(x.alert, f, t));
  }, [allFeatures, timeFilter, categoryFilters, settingsValues]);
  const active = useAlertStore((s) => s.active);
  const status = useAlertStore((s) => s.status);
  const message = useAlertStore((s) => s.message);
  const select = useAlertStore((s) => s.select);
  const selectMany = useAlertStore((s) => s.selectMany);
  const listOpen = useAlertStore((s) => s.listOpen);
  const setListOpen = useAlertStore((s) => s.setListOpen);
  const ids = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
  const selectedFeatures = sortAlerts(
    ids
      .map((id) => features.find((f) => f.alert.id === id))
      .filter((feature): feature is AlertFeature => Boolean(feature)),
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Clicking an alert in the side list frames it on the map. (Clicking the
  // polygon itself doesn't need this -- you're already looking at it.) Alerts
  // with no drawable footprint just open without moving the camera. One
  // function for the panel's life, so the rows (memoised) are not all drawn
  // again at each render of the list.
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const onSelectAlert = useCallback(
    (id: string) => {
      selectMany([id]);
      const feature = featuresRef.current.find((f) => f.alert.id === id);
      const bounds = feature ? alertBounds(feature.geometry) : null;
      const map = getMap();
      if (map && bounds) {
        map.fitBounds(bounds, { padding: 64, maxZoom: 10.5, duration: 700, essential: true });
      }
    },
    [selectMany],
  );

  // Clicking a polygon opens the rail on that alert even when the list was
  // closed, so `detail` -- not `listOpen` alone -- decides whether we render.
  const detail = selectedFeatures.length > 0;
  if (!active || (!listOpen && !detail)) return null;

  const closeRail = () => {
    select(null);
    setListOpen(false);
  };

  return (
    <aside className="alert-panel alert-panel--list">
      {detail && (
        <div className="alert-rail__bar">
          <button
            type="button"
            className="alert-back"
            onClick={() => {
              select(null);
              setListOpen(true);
            }}
          >
            <ChevronLeft size={14} /> All alerts
          </button>
          <button
            type="button"
            className="alert-list__close"
            onClick={closeRail}
            title="Close the rail (alerts stay on the map)"
            aria-label="Close alert rail"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {!detail && (
        <button
          type="button"
          className="alert-list__close alert-list__close--corner"
          onClick={closeRail}
          title="Close the rail (alerts stay on the map)"
          aria-label="Close alert rail"
        >
          <X size={15} />
        </button>
      )}

      {detail ? (
        <div className="alert-panel__body">
          {selectedFeatures.map((feature) => (
            <AlertDetail key={feature.alert.id} feature={feature} now={now} />
          ))}
        </div>
      ) : (
        <AlertList
          features={features}
          status={status}
          message={message}
          now={now}
          timeFilter={timeFilter}
          onSelect={onSelectAlert}
        />
      )}
    </aside>
  );
}
