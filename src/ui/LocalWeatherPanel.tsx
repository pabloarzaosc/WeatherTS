import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, ExternalLink, MapPin, Radar, RefreshCw, X } from "lucide-react";

import { useLocalWeatherStore } from "../store/useLocalWeatherStore";
import { useSurfaceObsStore } from "../store/useSurfaceObsStore";
import { useNexradStore } from "../store/useNexradStore";
import { useAppStore } from "../store/useAppStore";
import { compass, type LocalObs, type LocalPeriod, type LocalWeather } from "../lib/localWeather";
import { eventColor, type AlertFeature } from "../lib/nwsAlerts";
import { alertTier } from "../lib/alertTiers";
import { expiryPhrase } from "../lib/alertGroups";
import { WFO_BY_ID } from "../lib/wfoOffices";
import { OfficeLink } from "./ForecastOfficePanel";

/**
 * Local weather for a US point (right-click "Local weather", or "My local
 * weather"): the alerts in force there, current conditions from the nearest
 * station, the next 24 hours, the 7-day forecast in the forecaster's words and
 * the office that writes it. Numbers follow the app's unit switches
 * (Settings > Surface observations).
 */

type Units = ReturnType<typeof useUnits>;

function useUnits() {
  const t = useSurfaceObsStore((s) => s.tempUnits);
  const w = useSurfaceObsStore((s) => s.windUnits);
  const p = useSurfaceObsStore((s) => s.presUnits);
  const v = useSurfaceObsStore((s) => s.visUnits);
  return useMemo(() => {
    const windFromKmh = (k: number) => (w === "kt" ? k / 1.852 : w === "mph" ? k / 1.609344 : k / 3.6);
    const windFromMph = (m: number) => (w === "kt" ? m / 1.15078 : w === "mph" ? m : m * 0.44704);
    const windLabel = w === "ms" ? "m/s" : w;
    return {
      tempC: (c: number | null) => (c == null ? "—" : `${Math.round(t === "C" ? c : (c * 9) / 5 + 32)}°`),
      tempF: (f: number | null) => (f == null ? "—" : `${Math.round(t === "C" ? ((f - 32) * 5) / 9 : f)}°`),
      tempUnit: t === "C" ? "°C" : "°F",
      windLabel,
      windKmh: (k: number | null) => (k == null ? "—" : `${Math.round(windFromKmh(k))} ${windLabel}`),
      /** "5 to 10 mph" as the forecast writes it, in the chosen unit. */
      windText: (s: string) =>
        w === "mph"
          ? s
          : s.replace(/\b(\d+)(\s+to\s+(\d+))?\s*mph\b/gi, (_m, a: string, _t, b: string | undefined) => {
              const c = (n: string) => Math.round(windFromMph(Number(n)));
              return `${c(a)}${b ? ` to ${c(b)}` : ""} ${windLabel}`;
            }),
      /** The forecaster's text with its temperatures ("low around 57") and
       *  winds in the chosen units. */
      prose: (s: string) => {
        let out =
          t === "C"
            ? s.replace(
                /\b(high|low|temperatures?(?:\s+(?:falling|rising))?(?:\s+to)?)\s+(near|around|of)\s+(-?\d+)/gi,
                (_m, a: string, b: string, n: string) => `${a} ${b} ${Math.round(((Number(n) - 32) * 5) / 9)}`,
              )
            : s;
        if (w !== "mph")
          out = out.replace(/\b(\d+)(\s+to\s+(\d+))?\s*mph\b/gi, (_m, a: string, _t, b: string | undefined) => {
            const c = (n: string) => Math.round(windFromMph(Number(n)));
            return `${c(a)}${b ? ` to ${c(b)}` : ""} ${windLabel}`;
          });
        return out;
      },
      pressure: (pa: number | null) =>
        pa == null ? "—" : p === "inHg" ? `${(pa / 3386.389).toFixed(2)} inHg` : `${(pa / 100).toFixed(1)} mb`,
      vis: (m: number | null) =>
        m == null ? "—" : v === "km" ? `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km` : `${(m / 1609.344).toFixed(m < 16_000 ? 1 : 0)} mi`,
      precip: (mm: number | null) => (mm == null ? "—" : t === "C" ? `${mm.toFixed(1)} mm` : `${(mm / 25.4).toFixed(2)} in`),
      dist: (km: number) => (v === "km" ? `${km.toFixed(km < 10 ? 1 : 0)} km` : `${(km / 1.609344).toFixed(km < 16 ? 1 : 0)} mi`),
    };
  }, [t, w, p, v]);
}

function clock(ms: number, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Date(ms).toLocaleString(undefined, { ...opts, timeZone: tz ?? undefined });
  } catch {
    return new Date(ms).toLocaleString(undefined, opts);
  }
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

/* ---------------------------------------------------------------- alerts --- */

/** NWS text is hard-wrapped at ~70 columns: join the lines, keep paragraphs. */
const unwrap = (t: string) => t.replace(/([^\n])\n(?=[^\n])/g, "$1 ");

function AlertRow({ f }: { f: AlertFeature }) {
  const [open, setOpen] = useState(false);
  const a = f.alert;
  const tier = alertTier(a);
  return (
    <div className={`lw__alert${open ? " is-open" : ""}`} style={{ "--lw-c": tier?.color ?? eventColor(a.event) } as CSSProperties}>
      <button type="button" className="lw__alerthead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="lw__alertname">
          {a.event}
          {tier && <em>{tier.label}</em>}
        </span>
        <span className="lw__alertwhen">{expiryPhrase(a, Date.now())}</span>
      </button>
      {open && (
        <div className="lw__alerttext">
          {a.headline && <p className="lw__alerthl">{a.headline}</p>}
          <p>{unwrap(a.description)}</p>
          {a.instruction && <p className="lw__alertdo">{unwrap(a.instruction)}</p>}
          <p className="lw__alertfrom">{a.senderName}</p>
        </div>
      )}
    </div>
  );
}

function Alerts({ data }: { data: LocalWeather }) {
  return (
    <>
      <div className="stn__sec">
        <span>
          <AlertTriangle size={11} /> Alerts here
        </span>
        <b>{data.alerts.length || ""}</b>
      </div>
      {data.alertsError && <div className="lw__note is-err">{data.alertsError}</div>}
      {!data.alertsError && data.alerts.length === 0 && <div className="lw__note">No alerts in force at this point.</div>}
      <div className="lw__alerts">
        {data.alerts.map((f) => (
          <AlertRow key={f.alert.id} f={f} />
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- now --- */

function hiLo(daily: LocalPeriod[]): { hi: LocalPeriod | null; lo: LocalPeriod | null } {
  return { hi: daily.find((d) => d.isDay) ?? null, lo: daily.find((d) => !d.isDay) ?? null };
}

function Current({ data, u }: { data: LocalWeather; u: Units }) {
  const o: LocalObs | null = data.obs;
  const { hi, lo } = hiLo(data.daily);
  const feels = o ? (o.heatIndexC ?? o.windChillC ?? o.tempC) : null;
  const wind =
    o && o.windKmh != null
      ? o.windKmh < 1
        ? "Calm"
        : `${o.windDeg != null ? `${compass(o.windDeg)} ` : ""}${u.windKmh(o.windKmh)}`
      : "—";
  return (
    <>
      <div className="stn__sec">
        <span>Current conditions</span>
        {o && <b>{o.station}</b>}
      </div>
      {!o && <div className="lw__note">{data.obsError ?? "No current report."}</div>}
      {o && (
        <>
          <div className="lw__now">
            <b className="lw__temp">{u.tempC(o.tempC)}</b>
            <div>
              <span>{o.text || o.clouds || "—"}</span>
              <span>Feels like {u.tempC(feels)}</span>
            </div>
          </div>
          <div className="stn__tiles lw__tiles">
            <div className="stn__tile">
              <span>High / low</span>
              <b>
                {u.tempF(hi?.tempF ?? null)} / {u.tempF(lo?.tempF ?? null)}
              </b>
              <i>
                {o.max24C != null || o.min24C != null
                  ? `Past 24 h ${u.tempC(o.max24C)} / ${u.tempC(o.min24C)}`
                  : [hi?.name, lo?.name].filter(Boolean).join(" · ")}
              </i>
            </div>
            <div className="stn__tile">
              <span>Wind</span>
              <b>{wind}</b>
              {o.gustKmh != null && <i>Gusts {u.windKmh(o.gustKmh)}</i>}
            </div>
            <div className="stn__tile">
              <span>Humidity</span>
              <b>{o.rh == null ? "—" : `${Math.round(o.rh)}%`}</b>
            </div>
            <div className="stn__tile">
              <span>Dewpoint</span>
              <b>{u.tempC(o.dewC)}</b>
            </div>
            <div className="stn__tile">
              <span>Pressure</span>
              <b>{u.pressure(o.pressurePa)}</b>
            </div>
            <div className="stn__tile">
              <span>Visibility</span>
              <b>{u.vis(o.visM)}</b>
            </div>
            <div className="stn__tile">
              <span>Clouds</span>
              <b className="lw__small">{o.clouds || "—"}</b>
            </div>
            <div className="stn__tile">
              <span>Rain, last hour</span>
              <b>{u.precip(o.precip1hMm)}</b>
            </div>
          </div>
          <div className="lw__stn">
            {o.name} · {u.dist(o.km)} away · {ago(o.time)}
          </div>
        </>
      )}
    </>
  );
}

function Office({ data }: { data: LocalWeather }) {
  const office = WFO_BY_ID.get(data.wfo);
  const sites = useNexradStore((s) => s.sites);
  const radar = data.radar ? sites.find((s) => s.icao === data.radar) : undefined;
  const close = useLocalWeatherStore((s) => s.close);
  return (
    <>
      <div className="stn__sec">
        <span>Forecast office</span>
      </div>
      <div className="lw__office">
        <span>
          NWS {office?.name ?? data.wfo} <OfficeLink wfo={data.wfo} />
        </span>
        {radar && (
          <button
            type="button"
            className="lw__radar"
            onClick={() => {
              if (!useAppStore.getState().layers.nexrad?.visible) useAppStore.getState().setLayerVisible("nexrad", true);
              useNexradStore.getState().selectSite(radar.id);
              close();
            }}
            title={`Show ${radar.icao} on the map`}
          >
            <Radar size={12} /> {radar.icao}
          </button>
        )}
        <a className="lw__ext" href={data.link} target="_blank" rel="noreferrer">
          <ExternalLink size={11} /> Forecast on weather.gov
        </a>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- forecasts --- */

function Hourly({ data, u }: { data: LocalWeather; u: Units }) {
  const hrs = data.hourly;
  if (!hrs.length) return null;
  const temps = hrs.map((h) => h.tempF ?? NaN).filter(Number.isFinite);
  const lo = Math.min(...temps);
  const hi = Math.max(...temps);
  const span = Math.max(1, hi - lo);
  return (
    <>
      <div className="stn__sec">
        <span>Next 24 hours</span>
        <b>{data.timeZone ?? ""}</b>
      </div>
      <div className="lw__hours" role="list">
        {hrs.map((h) => (
          <div key={h.start} className={`lw__hour${h.isDay ? "" : " is-night"}`} role="listitem" title={h.short}>
            <span className="lw__hh">{clock(h.start, data.timeZone, { hour: "numeric" })}</span>
            <span className="lw__hbar">
              <i style={{ bottom: `${((Number(h.tempF) - lo) / span) * 70}%` }} />
            </span>
            <b>{u.tempF(h.tempF)}</b>
            <span className="lw__pop" style={{ "--pop": `${h.pop ?? 0}%` } as CSSProperties}>
              {h.pop != null && h.pop >= 5 ? `${h.pop}%` : ""}
            </span>
            <span className="lw__hw">
              {h.windDir} {u.windText(h.wind).replace(/\s*(mph|kt|m\/s)$/i, "")}
            </span>
          </div>
        ))}
      </div>
      <div className="lw__legend">
        Temperature {u.tempUnit} · chance of rain · wind {u.windLabel}
      </div>
    </>
  );
}

function Daily({ data, u }: { data: LocalWeather; u: Units }) {
  if (!data.daily.length) return null;
  return (
    <>
      <div className="stn__sec">
        <span>7-day forecast</span>
        {data.updated && <b>Updated {clock(data.updated, data.timeZone, { weekday: "short", hour: "numeric", minute: "2-digit" })}</b>}
      </div>
      <div className="lw__days">
        {data.daily.map((d) => (
          <div key={d.start} className={`lw__day${d.isDay ? "" : " is-night"}`}>
            <div className="lw__dayhead">
              <b>{d.name}</b>
              <span className="lw__short">{d.short}</span>
              <span className={`lw__dtemp${d.isDay ? " is-hi" : " is-lo"}`}>
                {d.isDay ? "High" : "Low"} {u.tempF(d.tempF)}
              </span>
              <span className="lw__dpop">{d.pop != null && d.pop >= 5 ? `${d.pop}%` : ""}</span>
            </div>
            <p>{u.prose(d.detailed)}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- shell --- */

export function LocalWeatherPanel() {
  const open = useLocalWeatherStore((s) => s.open);
  const status = useLocalWeatherStore((s) => s.status);
  const error = useLocalWeatherStore((s) => s.error);
  const data = useLocalWeatherStore((s) => s.data);
  const label = useLocalWeatherStore((s) => s.label);
  const lat = useLocalWeatherStore((s) => s.lat);
  const lon = useLocalWeatherStore((s) => s.lon);
  const close = useLocalWeatherStore((s) => s.close);
  const reload = useLocalWeatherStore((s) => s.reload);
  const u = useUnits();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // the office page opens on top of this card; Esc closes that first
      if (e.key === "Escape" && !document.querySelector(".stn.wfo")) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  const where = lat != null && lon != null ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : "";

  return (
    <div className="stn lw" role="dialog" aria-modal="true" aria-label="Local weather">
      <div className="stn__scrim" onClick={close} />
      <div className="stn__panel lw__panel">
        <header className="stn__top">
          <div className="stn__ident">
            <h2>
              <MapPin size={16} />
            </h2>
            <div>
              <b>{data?.place ?? (status === "locating" ? "Finding your location…" : "Local weather")}</b>
              <span>
                {[label, where, data ? `NWS ${data.wfo}` : null, "api.weather.gov"].filter(Boolean).join(" · ")}
              </span>
            </div>
          </div>
          <div className="stn__topright">
            {data && (
              <a className="lw__link" href={data.link} target="_blank" rel="noreferrer">
                <ExternalLink size={12} /> weather.gov
              </a>
            )}
            <button type="button" className="stn__icon" onClick={reload} title="Reload" aria-label="Reload" disabled={lat == null}>
              <RefreshCw size={14} className={status === "loading" || status === "locating" ? "stn__spin" : ""} />
            </button>
            <button type="button" className="stn__icon" onClick={close} title="Close (Esc)" aria-label="Close">
              <X size={14} />
            </button>
          </div>
        </header>
        {!data && (status === "loading" || status === "locating") && (
          <div className="lw__wait">{status === "locating" ? "Finding your location…" : "Reading api.weather.gov…"}</div>
        )}
        {status === "error" && <div className="lw__wait is-err">{error}</div>}
        {data && (
          <div className="stn__body lw__body">
            <aside className="stn__side lw__side">
              <Alerts data={data} />
              <Current data={data} u={u} />
              <Office data={data} />
            </aside>
            <main className="stn__main lw__main">
              {data.forecastError && <div className="lw__note is-err">Forecast: {data.forecastError}</div>}
              <Hourly data={data} u={u} />
              <Daily data={data} u={u} />
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
