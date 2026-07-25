import { useEffect, useMemo, useState } from "react";
import { X, Copy, AlertTriangle, ChevronLeft, Clock, MapPin, Radio, Radar } from "lucide-react";

import { selectVisibleAlerts, useAlertStore } from "../store/useAlertStore";
import type { AlertFeature } from "../lib/nwsAlerts";
import {
  alertBounds,
  alertCentroid,
  alertPriority,
  alertSummaryFacts,
  eventColor,
  humanAlertParameters,
  param,
  formatDuration,
  formatTimeLeft,
} from "../lib/nwsAlerts";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { getMap } from "../map/mapInstance";
import { haversine, formatDistance } from "../lib/measure";
import type { NexradSite } from "../lib/nexrad";

type AlertListFilter = "all" | "warning" | "watch" | "advisory" | "statement" | "other";

const LIST_FILTERS: Array<{ id: AlertListFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "warning", label: "Warnings" },
  { id: "watch", label: "Watches" },
  { id: "advisory", label: "Advisories" },
  { id: "statement", label: "Statements" },
  { id: "other", label: "Other" },
];

function alertKind(event: string): Exclude<AlertListFilter, "all"> {
  if (/warning/i.test(event)) return "warning";
  if (/watch/i.test(event)) return "watch";
  if (/advisory/i.test(event)) return "advisory";
  if (/statement|message/i.test(event)) return "statement";
  return "other";
}

/** unix seconds -> "16 21:58Z", matching the timeline's chip. */
function fmtZ(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

function alertKindLabel(kind: Exclude<AlertListFilter, "all">): string {
  switch (kind) {
    case "warning":
      return "Warnings";
    case "watch":
      return "Watches";
    case "advisory":
      return "Advisories";
    case "statement":
      return "Statements";
    default:
      return "Other";
  }
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
      .filter((s) => s.online !== false && Number.isFinite(s.lat) && Number.isFinite(s.lon))
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
  const color = eventColor(a.event);

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
    statusText = `Starts in ${formatTimeLeft(startMs - now)}`;
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

      {(isEmergency || isPDS) && (
        <div className="al-badges">
          {isEmergency && (
            <span className="al-badge al-badge--emergency">
              <AlertTriangle size={12} /> EMERGENCY
            </span>
          )}
          {isPDS && <span className="al-badge al-badge--pds">PDS</span>}
        </div>
      )}

      <div className={`al-status al-status--${statusKind}`}>
        <Clock size={13} />
        <span className="al-status__text">{statusText}</span>
        {statusKind === "active" && (
          <span className="al-status__cd">expires in {formatTimeLeft(expireMs - now)}</span>
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
        {a.senderName && <p className="al-sender">{a.senderName}</p>}
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
  return [...features].sort((a, b) => {
    const priority = alertPriority(b.alert) - alertPriority(a.alert);
    if (priority !== 0) return priority;
    return Date.parse(a.alert.expires) - Date.parse(b.alert.expires);
  });
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
  const [filter, setFilter] = useState<AlertListFilter>("all");
  const sorted = sortAlerts(features);
  const visible = filter === "all" ? sorted : sorted.filter((feature) => alertKind(feature.alert.event) === filter);
  const groups =
    filter === "all"
      ? (["warning", "watch", "advisory", "statement", "other"] as const)
          .map((kind) => ({
            kind,
            alerts: visible.filter((feature) => alertKind(feature.alert.event) === kind),
          }))
          .filter((group) => group.alerts.length > 0)
      : [{ kind: filter as Exclude<AlertListFilter, "all">, alerts: visible }];

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
              : timeFilter !== null
                ? // the controller's message counts everything fetched, which is
                  // the wrong number once the timeline is holding a past frame
                  `${features.length} in force`
                : message ?? `${features.length} active`}
          </span>
        </div>
      </div>

      <div className="alert-list__filters" role="tablist" aria-label="Alert filter">
        {LIST_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`alert-list__filter${filter === item.id ? " is-active" : ""}`}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="alert-list__body">
        {status === "error" && <div className="alert-list__empty">{message ?? "Unable to load alerts."}</div>}
        {status !== "error" && visible.length === 0 && (
          <div className="alert-list__empty">No active alerts in this filter.</div>
        )}
        {groups.map((group) => (
          <section key={group.kind} className="alert-list__group">
            {filter === "all" && <h3 className="alert-list__group-title">{alertKindLabel(group.kind)}</h3>}
            {group.alerts.map((feature) => {
              const a = feature.alert;
              const color = eventColor(a.event);
              const facts = alertSummaryFacts(a, now).slice(0, 4);
              const expires = Date.parse(a.expires);
              return (
                <button
                  key={a.id}
                  type="button"
                  className="alert-list__row"
                  style={{ borderLeftColor: color }}
                  onClick={() => onSelect(a.id)}
                >
                  <span className="alert-list__event">{a.event}</span>
                  {facts.map((fact) => (
                    <span key={fact.key} className="alert-list__fact">
                      <b>{fact.label}:</b> {fact.value}
                    </span>
                  ))}
                  {!Number.isNaN(expires) && (
                    <span className="alert-list__expires">Expires in {formatTimeLeft(expires - now)}</span>
                  )}
                  {!feature.geometry && <span className="alert-list__nomap">No map polygon</span>}
                </button>
              );
            })}
          </section>
        ))}
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
  const selectedId = useAlertStore((s) => s.selectedId);
  const selectedIds = useAlertStore((s) => s.selectedIds);
  const allFeatures = useAlertStore((s) => s.features);
  const timeFilter = useAlertStore((s) => s.timeFilter);
  // the list follows the timeline for the same reason the map does
  const features = useMemo(
    () => selectVisibleAlerts({ features: allFeatures, timeFilter }),
    [allFeatures, timeFilter],
  );
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

  // Clicking a polygon opens the rail on that alert even when the list was
  // closed, so `detail` -- not `listOpen` alone -- decides whether we render.
  const detail = selectedFeatures.length > 0;
  if (!active || (!listOpen && !detail)) return null;

  const closeRail = () => {
    select(null);
    setListOpen(false);
  };

  // Clicking an alert in the side list frames it on the map. (Clicking the
  // polygon itself doesn't need this -- you're already looking at it.) Alerts
  // with no drawable footprint just open without moving the camera.
  const zoomToAlert = (id: string) => {
    const feature = features.find((f) => f.alert.id === id);
    const bounds = feature ? alertBounds(feature.geometry) : null;
    const map = getMap();
    if (map && bounds) {
      map.fitBounds(bounds, { padding: 64, maxZoom: 10.5, duration: 700, essential: true });
    }
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
          onSelect={(id) => {
            selectMany([id]);
            zoomToAlert(id);
          }}
        />
      )}
    </aside>
  );
}
