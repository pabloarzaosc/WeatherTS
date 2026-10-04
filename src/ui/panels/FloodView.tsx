import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Search, X } from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { useAlertStore } from "../../store/useAlertStore";
import { useRiverStore, type RiverFilter } from "../../store/useRiverStore";
import {
  NWM_PRODUCTS,
  RIVER_COLORS,
  fetchNwmLegend,
  gaugeId,
  gaugeName,
  riverRank,
  statusLabel,
  type NwmLegendItem,
  type RiverGauge,
  type RiverNet,
  type RiverStatus,
} from "../../lib/rivers";
import { getMap } from "../../map/mapInstance";
import { LayerPower } from "../LayerPower";

const LAYER = "rivers";
const NWM_LAYER = "nwm";
const ALERT_LAYER = "nws-alerts";
const ERO_LAYER = "wpc-ero-d1";
const LIST_MAX = 150;
const SEARCH_MAX = 40;

const FILTERS: { id: RiverFilter; label: string; title: string }[] = [
  { id: "levels", label: "With flood levels", title: "Gauges with flood levels set (NWS categories, SGB's alert levels)" },
  { id: "flooding", label: "In flood", title: "At action stage (SGB: attention) or above, now or in the forecast" },
  { id: "all", label: "All", title: "Every gauge, out-of-service ones included" },
];

const NETS: { id: RiverNet; label: string; title: string }[] = [
  { id: "nws", label: "US · NWS", title: "NWS river gauges across the US, Puerto Rico and Alaska, with forecasts" },
  { id: "sgb", label: "Brazil · SGB", title: "The Geological Survey of Brazil's flood alert systems (SACE), with alert levels" },
  { id: "ana", label: "Brazil · ANA", title: "ANA's telemetry river stations: level, flow and rain, no alert levels" },
];

const US_TILES: RiverStatus[] = ["major", "moderate", "minor", "action"];
const BR_TILES: RiverStatus[] = ["moderate", "minor", "action", "no_flooding"];

/** Search text: lower case, accents off, so "muçum" finds "Muçum" and "Mucum". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function fmtStage(g: RiverGauge): string {
  if (g.stage == null) return "no reading";
  return `${g.units === "cm" ? g.stage.toFixed(0) : g.stage} ${g.units}`;
}

/** The flood alerts in force, by kind; a flash flood warning with a
 *  catastrophic damage threat is a flash flood emergency. */
const FLOOD_EVENTS = [
  "Flash Flood Emergency",
  "Flash Flood Warning",
  "Flood Warning",
  "Flash Flood Watch",
  "Flood Watch",
  "Flood Advisory",
  "Coastal Flood Warning",
  "Coastal Flood Watch",
  "Coastal Flood Advisory",
  "Lakeshore Flood Warning",
  "Lakeshore Flood Advisory",
  "Hydrologic Outlook",
];

/** The flooding panel: rivers in flood now and in the forecast in the US and
 *  Brazil, a search over every gauge, the flood alerts, and NOAA's water model. */
export function FloodView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const nwmOn = useAppStore((s) => s.layers[NWM_LAYER]?.visible ?? false);
  const alertsOn = useAppStore((s) => s.layers[ALERT_LAYER]?.visible ?? false);
  const eroOn = useAppStore((s) => s.layers[ERO_LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);
  const data = useRiverStore((s) => s.data);
  const brazil = useRiverStore((s) => s.brazil);
  const all = useRiverStore((s) => s.all);
  const busy = useRiverStore((s) => s.busy);
  const brBusy = useRiverStore((s) => s.brBusy);
  const error = useRiverStore((s) => s.error);
  const brError = useRiverStore((s) => s.brError);
  const filter = useRiverStore((s) => s.filter);
  const networks = useRiverStore((s) => s.networks);
  const nwm = useRiverStore((s) => s.nwm);
  const alertFeatures = useAlertStore((s) => s.features);
  const [query, setQuery] = useState("");
  const [legend, setLegend] = useState<NwmLegendItem[] | null>(null);

  useEffect(() => {
    if (enabled && !data && !brazil && !busy && !brBusy) void useRiverStore.getState().load();
  }, [enabled, data, brazil, busy, brBusy]);

  const product = NWM_PRODUCTS.find((p) => p.id === nwm) ?? null;
  useEffect(() => {
    setLegend(null);
    if (!product || !nwmOn) return;
    let live = true;
    fetchNwmLegend(product)
      .then((l) => live && setLegend(l))
      .catch(() => live && setLegend([]));
    return () => {
      live = false;
    };
  }, [product, nwmOn]);

  const counts = useMemo(() => {
    const us: Record<string, number> = {};
    const fc: Record<string, number> = {};
    const br: Record<string, number> = {};
    for (const g of all) {
      if (g.net === "sgb") br[g.status] = (br[g.status] ?? 0) + 1;
      else if (!g.net || g.net === "nws") {
        us[g.status] = (us[g.status] ?? 0) + 1;
        if (g.fstatus) fc[g.fstatus] = (fc[g.fstatus] ?? 0) + 1;
      }
    }
    return { us, fc, br };
  }, [all]);

  // In flood now or forecast to be, worst first, both countries.
  const flooding = useMemo(() => {
    const worst = (g: RiverGauge) => Math.max(riverRank(g.status), riverRank(g.fstatus));
    return all
      .filter((g) => networks[g.net ?? "nws"] && worst(g) > 0)
      .sort((a, b) => worst(b) - worst(a) || riverRank(b.status) - riverRank(a.status) || a.river.localeCompare(b.river));
  }, [all, networks]);

  const haystack = useMemo(
    () => all.map((g) => fold(`${gaugeName(g)} ${g.place} ${g.state} ${gaugeId(g.lid)} ${g.wfo}`)),
    [all],
  );
  const found = useMemo(() => {
    const q = fold(query.trim());
    if (q.length < 2) return [];
    const words = q.split(/\s+/);
    const out: RiverGauge[] = [];
    for (let i = 0; i < all.length && out.length < SEARCH_MAX; i++) {
      if (words.every((w) => haystack[i].includes(w))) out.push(all[i]);
    }
    return out.sort((a, b) => riverRank(b.status) - riverRank(a.status));
  }, [query, all, haystack]);

  const floodAlerts = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const f of alertFeatures) {
      const a = f.alert;
      let ev = a.event;
      if (ev === "Flash Flood Warning" && (a.parameters?.flashFloodDamageThreat ?? []).some((t) => /catastrophic/i.test(t))) {
        ev = "Flash Flood Emergency";
      }
      if (!FLOOD_EVENTS.includes(ev)) continue;
      by.set(ev, [...(by.get(ev) ?? []), a.id]);
    }
    return FLOOD_EVENTS.filter((e) => by.has(e)).map((e) => ({ event: e, ids: by.get(e)! }));
  }, [alertFeatures]);

  const open = (g: RiverGauge) => {
    if (!enabled) setLayerVisible(LAYER, true);
    if (!networks[g.net ?? "nws"]) useRiverStore.getState().setNetwork(g.net ?? "nws", true);
    getMap()?.flyTo({ center: [g.lon, g.lat], zoom: Math.max(getMap()?.getZoom() ?? 0, 8), duration: 900 });
    useRiverStore.getState().select(g.lid);
  };

  const pickNwm = (id: string | null) => {
    if (!id) {
      setLayerVisible(NWM_LAYER, false);
      return;
    }
    useRiverStore.getState().setNwm(id);
    if (!nwmOn) setLayerVisible(NWM_LAYER, true);
  };

  const row = (g: RiverGauge) => {
    const br = g.net === "sgb" || g.net === "ana";
    const worse = !br && g.fstatus && riverRank(g.fstatus) > riverRank(g.status);
    return (
      <button key={g.lid} type="button" className="floodv__row" onClick={() => open(g)} title={`${gaugeId(g.lid)}: open the hydrograph`}>
        <i className="floodv__dot" style={{ background: RIVER_COLORS[g.status] ?? RIVER_COLORS.not_defined }} />
        <span className="floodv__name">
          {gaugeName(g)}
          <small>
            {br
              ? `${g.state ? `${g.state} · ` : ""}${g.net === "sgb" ? `${g.wfo} · ` : "ANA · "}${g.stage != null ? `${fmtStage(g)} · ` : ""}${statusLabel(g.status, g.net)}`
              : `${g.state} · ${fmtStage(g)}${worse ? ` → ${statusLabel(g.fstatus as RiverStatus, "nws").toLowerCase()}` : ""}`}
          </small>
        </span>
        {worse && <i className="floodv__ring" style={{ borderColor: RIVER_COLORS[g.fstatus as RiverStatus] }} title="Forecast to get worse" />}
      </button>
    );
  };

  return (
    <div className="sfcobs lsrv floodv">
      <LayerPower label="River gauges" on={enabled} error={!!(error && brError)} onToggle={() => setLayerVisible(LAYER, !enabled)} />

      {(error || brError) && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{[error, brError].filter(Boolean).join(" ")}</span>
          <button type="button" className="sfcobs__retry" onClick={() => void useRiverStore.getState().load()}>
            Retry
          </button>
        </div>
      )}

      <div className="lsrv__field">
        <label className="lsrv__search">
          <Search size={12} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a gauge: river, town, code…"
            aria-label="Find a river gauge"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear the search">
              <X size={12} />
            </button>
          )}
        </label>
        {query.trim().length >= 2 && (
          <div className="floodv__list floodv__list--found">
            {found.map(row)}
            {!found.length && <div className="floodv__more">{all.length ? "No gauge by that name." : "The gauges are still loading…"}</div>}
          </div>
        )}
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Networks</span>
          <em>{busy || brBusy ? "loading…" : ""}</em>
        </div>
        <div className="floodv__nets">
          {NETS.map((n) => {
            const count = n.id === "nws" ? data?.count : n.id === "sgb" ? brazil?.sgb : brazil?.ana;
            return (
              <button
                key={n.id}
                type="button"
                className={`floodv__net${networks[n.id] ? " is-on" : ""}`}
                onClick={() => useRiverStore.getState().setNetwork(n.id, !networks[n.id])}
                aria-pressed={networks[n.id]}
                title={n.title}
              >
                <span>{n.label}</span>
                <em>{count != null ? count.toLocaleString("en-US") : "–"}</em>
              </button>
            );
          })}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>United States</span>
          <em>now · forecast</em>
        </div>
        <div className="lsrv__tiles floodv__tiles">
          {US_TILES.map((s) => (
            <div key={s} className={`lsrv__tile glmv__tile${counts.us[s] ? "" : " is-empty"}`}>
              <span className="glmv__label">
                <i className="floodv__dot" style={{ background: RIVER_COLORS[s] }} />
                {statusLabel(s, "nws").replace(" flood", "").replace(" stage", "")}
              </span>
              <b>{data ? (counts.us[s] ?? 0) : "–"}</b>
              <small>{data ? `${counts.fc[s] ?? 0} fcst` : ""}</small>
            </div>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Brazil · SGB alert stations</span>
          <em>{brazil ? `${brazil.sgb ?? 0} stations` : brBusy ? "loading…" : ""}</em>
        </div>
        <div className="lsrv__tiles floodv__tiles">
          {BR_TILES.map((s) => (
            <div key={s} className={`lsrv__tile glmv__tile${counts.br[s] ? "" : " is-empty"}`}>
              <span className="glmv__label">
                <i className="floodv__dot" style={{ background: RIVER_COLORS[s] }} />
                {statusLabel(s, "sgb")}
              </span>
              <b>{brazil ? (counts.br[s] ?? 0) : "–"}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Gauges on the map</span>
        </div>
        <div className="lsrv__seg lsrv__seg--sev" role="group" aria-label="Which gauges">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? "is-on" : ""}
              onClick={() => useRiverStore.getState().setFilter(f.id)}
              aria-pressed={filter === f.id}
              title={f.title}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>In flood, or forecast to be</span>
          <em>{flooding.length ? `${flooding.length} gauges` : all.length ? "none" : ""}</em>
        </div>
        <div className="floodv__list">
          {flooding.slice(0, LIST_MAX).map(row)}
          {flooding.length > LIST_MAX && <div className="floodv__more">and {flooding.length - LIST_MAX} more on the map</div>}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Flood alerts (NWS)</span>
          <em>{alertsOn ? `${floodAlerts.reduce((n, a) => n + a.ids.length, 0)} in force` : ""}</em>
        </div>
        {!alertsOn ? (
          <button type="button" className="floodv__link" onClick={() => setLayerVisible(ALERT_LAYER, true)}>
            <span>Turn on the Alerts layer to list flood warnings, watches and advisories</span>
            <em>off</em>
          </button>
        ) : floodAlerts.length ? (
          <div className="floodv__alerts">
            {floodAlerts.map((a) => (
              <button
                key={a.event}
                type="button"
                className="floodv__alert"
                onClick={() => {
                  useAlertStore.getState().setListOpen(true);
                  useAlertStore.getState().selectMany(a.ids);
                }}
                title="List them in the alerts panel"
              >
                <span className={a.event === "Flash Flood Emergency" ? "is-emergency" : ""}>{a.event}</span>
                <b>{a.ids.length}</b>
              </button>
            ))}
          </div>
        ) : (
          <p className="glmv__note">No flood alerts in force.</p>
        )}
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>National Water Model (US)</span>
          <em>{nwmOn && product ? "on" : "off"}</em>
        </div>
        <div className="floodv__nwm" role="radiogroup" aria-label="National Water Model product">
          <button type="button" className={!nwmOn ? "is-on" : ""} onClick={() => pickNwm(null)} role="radio" aria-checked={!nwmOn}>
            Off
          </button>
          {NWM_PRODUCTS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={nwmOn && nwm === p.id ? "is-on" : ""}
              onClick={() => pickNwm(p.id)}
              role="radio"
              aria-checked={nwmOn && nwm === p.id}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>
        {nwmOn && product && (
          <>
            <p className="glmv__note">
              {product.hint}
              {product.minzoom ? " Zoom in to see it." : ""}
            </p>
            {legend && legend.length > 0 && (
              <div className="floodv__legend">
                {legend.map((l) => (
                  <span key={l.label}>
                    <img src={l.image} alt="" />
                    {l.label}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Colours</span>
        </div>
        <div className="glmv__key">
          {(["no_flooding", "action", "minor", "moderate", "major", "not_defined", "obs_not_current"] as RiverStatus[]).map((s) => (
            <span key={s} className="glmv__keyitem">
              <i style={{ background: RIVER_COLORS[s] }} />
              {s === "not_defined"
                ? "No levels set · ANA telemetry"
                : s === "no_flooding" || s === "obs_not_current" || s === "major"
                  ? statusLabel(s, "nws")
                  : `${statusLabel(s, "nws")} · SGB ${statusLabel(s, "sgb").toLowerCase()}`}
            </span>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>More for flooding</span>
        </div>
        <button type="button" className={`floodv__link${eroOn ? " is-on" : ""}`} onClick={() => setLayerVisible(ERO_LAYER, !eroOn)}>
          <span>WPC Excessive Rainfall Outlook, day 1</span>
          <em>{eroOn ? "on" : "off"}</em>
        </button>
        <p className="glmv__note">
          Rainfall against flash flood guidance, and radar rainfall totals, are MRMS sources in the Models panel.
        </p>
      </div>

      <p className="glmv__note">
        NWS river gauges (US), SGB's flood alert stations and ANA's telemetry (Brazil). A ring around a gauge marks one forecast to
        reach a worse category. Click a gauge for its hydrograph: level, flow, rain, the flood levels and the forecast.
      </p>
    </div>
  );
}
