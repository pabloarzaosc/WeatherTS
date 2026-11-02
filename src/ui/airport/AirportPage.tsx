import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Copy, Crosshair, ExternalLink, Loader2, RefreshCw, X } from "lucide-react";

import {
  densityAltitude,
  fetchAirport,
  fmtFt,
  fmtLevel,
  fmtVis,
  fmtVisMetric,
  fmtWind,
  HAZARD_COLOR,
  HAZARD_FALLBACK,
  hazardLabel,
  hpaToInHg,
  INTENSITY_COLOR,
  INTENSITY_LABEL,
  pressureAltitude,
  relHumidity,
  sunTimes,
  usesInHg,
  zDayClock,
  type AirportData,
  type AvnMetar,
  type ProfileModel,
  type TafPeriod,
} from "../../lib/aviation";
import { CATEGORY_COLOR, CATEGORY_LABEL, compassPoint, describeWx, relativeTime, SKY_WORDS } from "../../lib/metar";
import { decodeMetar, type DecodedGroup } from "../../lib/metarDecode";
import { getMap } from "../../map/mapInstance";
import { AIRPORT_RANGES, useAirportStore } from "../../store/useAirportStore";
import { AirportChart, type ChartUnits } from "./AirportChart";
import { AloftChart, AloftTable } from "./AloftChart";
import { RunwayComponents, RunwayDiagram, RunwayInUse, RunwayList } from "./Runways";

type Tab = "weather" | "metars" | "taf" | "aloft" | "airport" | "nearby";

const TABS: [Tab, string][] = [
  ["weather", "Weather"],
  ["metars", "METARs"],
  ["taf", "TAF"],
  ["aloft", "Aloft"],
  ["airport", "Airport"],
  ["nearby", "Nearby"],
];

const MODELS: [ProfileModel, string][] = [
  ["gfs", "GFS"],
  ["ecmwf", "ECMWF"],
  ["icon", "ICON"],
];

const rangeLabel = (h: number) => (h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`);

/**
 * An airport's page, anywhere in the world: what it is reporting (decoded to
 * the last remark), what its TAF forecasts, how the wind sits on its runways
 * (drawn to scale), the air above it for three days, and what is going on
 * around it -- the airport's own version of the station page, for flying.
 */
export function AirportPage() {
  const icao = useAirportStore((s) => s.icao);
  const hours = useAirportStore((s) => s.hours);
  const close = useAirportStore((s) => s.close);
  const setHours = useAirportStore((s) => s.setHours);
  const openAirport = useAirportStore((s) => s.open);

  const [data, setData] = useState<AirportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("weather");
  const [utc, setUtc] = useState(true);
  const [reload, setReload] = useState(0);
  const [copied, setCopied] = useState(false);
  const [units, setUnits] = useState<ChartUnits>({ temp: "C", pres: "inHg" });
  const [model, setModel] = useState<ProfileModel>("gfs");

  useEffect(() => {
    if (!icao) return;
    const ctrl = new AbortController();
    setBusy(true);
    setError(null);
    fetchAirport(icao, hours, model, ctrl.signal)
      .then((d) => {
        setData(d);
        // The altimeter the airport itself reports in: inches in the US, hectopascals nearly everywhere else.
        const raw = d.metars.length ? d.metars[d.metars.length - 1].raw : null;
        setUnits((u) => ({ ...u, pres: usesInHg(d.info.icao, raw) ? "inHg" : "hPa" }));
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [icao, hours, model, reload]);

  // A fresh METAR every few minutes while the page is open.
  useEffect(() => {
    if (!icao) return;
    const t = window.setInterval(() => setReload((k) => k + 1), 5 * 60_000);
    return () => window.clearInterval(t);
  }, [icao]);

  useEffect(() => {
    if (!icao) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [icao, close]);

  useEffect(() => {
    if (icao && data && data.info.icao !== icao) setData(null);
  }, [icao, data]);

  const latest: AvnMetar | null = data?.metars.length ? data.metars[data.metars.length - 1] : null;
  const info = data?.info ?? null;
  const elev = info?.elevFt ?? null;
  const metric = !!latest?.raw && !/\dSM\b/.test(latest.raw);
  const decoded = useMemo(() => decodeMetar(latest?.raw), [latest?.raw]);

  const sun = useMemo(() => (info ? sunTimes(info.lat, info.lon, new Date()) : null), [info]);

  if (!icao) return null;

  const tile = (label: string, value: string, sub?: string | null) => (
    <div className="stn__tile" key={label}>
      <span>{label}</span>
      <b>{value}</b>
      {sub ? <i>{sub}</i> : null}
    </div>
  );

  const wdirNum = latest && typeof latest.wdir === "number" ? latest.wdir : null;
  const cat = latest?.cat ?? null;
  const pa = elev != null && latest?.altim != null ? pressureAltitude(elev, latest.altim) : null;
  const da = elev != null && latest?.altim != null && latest.temp != null ? densityAltitude(elev, latest.altim, latest.temp) : null;
  const clockOf = (t: number | null) =>
    t == null
      ? "—"
      : utc
        ? `${new Date(t * 1000).toISOString().slice(11, 16)}Z`
        : new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  const prof = data?.profile ?? null;
  const nowK = prof ? prof.times.reduce((best, t, k) => (Math.abs(t - Date.now() / 1000) < Math.abs(prof.times[best] - Date.now() / 1000) ? k : best), 0) : -1;
  const frzNow = prof && nowK >= 0 ? prof.freezing[nowK] : null;
  const tropNow = prof && nowK >= 0 ? prof.tropopause[nowK] : null;

  const showOnMap = () => {
    if (info) getMap()?.flyTo({ center: [info.lon, info.lat], zoom: Math.max(getMap()?.getZoom() ?? 8, 9) });
  };

  const copyAll = async () => {
    const text = [...(data?.metars ?? []).slice().reverse().map((m) => m.raw ?? ""), data?.taf?.raw ?? ""].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the clipboard refused; nothing to tell */
    }
  };

  const place = info ? [info.municipality, info.region ?? info.state, info.countryName ?? info.country].filter(Boolean) : [];
  const where = [...new Set(place)].join(", ");

  return (
    <div className="stn apt" role="dialog" aria-modal="true" aria-label={`Airport ${icao}`}>
      <div className="stn__scrim" onClick={close} />
      <div className="stn__panel apt__panel">
        <header className="stn__top">
          <div className="stn__ident">
            <h2>{icao}</h2>
            <div>
              <b>{info?.name || (busy ? "Loading…" : "—")}</b>
              <span>
                {[
                  info?.iata ? `IATA ${info.iata}` : null,
                  info?.faa && info.faa !== info.iata ? `FAA ${info.faa}` : null,
                  where || null,
                  info?.typeWord ?? null,
                  elev != null ? `${Math.round(elev).toLocaleString("en-US")} ft (${Math.round(elev * 0.3048)} m)` : null,
                  info ? `${Math.abs(info.lat).toFixed(3)}°${info.lat >= 0 ? "N" : "S"} ${Math.abs(info.lon).toFixed(3)}°${info.lon >= 0 ? "E" : "W"}` : null,
                  info?.magdec ? `Var ${info.magdec}` : null,
                  data?.fir ? `FIR ${data.fir.id} ${data.fir.name}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          </div>
          <div className="stn__topright">
            {cat && (
              <div className="stn__cat" style={{ ["--cat" as string]: CATEGORY_COLOR[cat] }} title={CATEGORY_LABEL[cat]}>
                {cat}
              </div>
            )}
            <button type="button" className="stn__icon" onClick={showOnMap} title="Centre the map here">
              <Crosshair size={14} />
            </button>
            <button type="button" className="stn__icon" onClick={() => setReload((k) => k + 1)} title="Reload">
              <RefreshCw size={14} className={busy ? "stn__spin" : undefined} />
            </button>
            <button type="button" className="stn__icon" onClick={close} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        </header>

        {error && !data ? (
          <div className="stn__loading is-error">{error}</div>
        ) : !data ? (
          <div className="stn__loading">
            <Loader2 size={15} className="stn__spin" /> Reading {icao}&rsquo;s METARs, TAF and the air above it&hellip;
          </div>
        ) : (
          <div className="stn__body">
            <aside className="stn__side">
              <div className="stn__sec">
                <span>Latest METAR</span>
                <b>{latest ? `${clockOf(latest.t)} · ${relativeTime(latest.t)}` : "none in this window"}</b>
              </div>
              {latest?.raw && <code className="apt__raw">{latest.raw}</code>}
              {!latest && <div className="apt__none">This airport sends no METARs; the forecast tabs still have the model&rsquo;s view of it.</div>}
              {latest && (
                <div className="stn__tiles">
                  {tile("Wind", fmtWind(latest.wdir, latest.wspd), latest.wgst ? `gusting ${Math.round(latest.wgst)} kt` : wdirNum != null ? `from the ${compassPoint(wdirNum)}` : null)}
                  {tile("Visibility", metric ? fmtVisMetric(latest.vis, latest.visRaw) : fmtVis(latest.vis, latest.visRaw),
                    metric ? fmtVis(latest.vis, latest.visRaw) : latest.vis != null ? fmtVisMetric(latest.vis, latest.visRaw) : null)}
                  {tile("Ceiling", latest.ceil != null ? fmtFt(latest.ceil) : "None", latest.ceil == null ? "no BKN/OVC layer" : `${Math.round(latest.ceil * 0.3048)} m`)}
                  {tile("Temperature", latest.temp != null ? `${latest.temp.toFixed(0)}°C` : "—", latest.temp != null ? `${((latest.temp * 9) / 5 + 32).toFixed(0)}°F` : null)}
                  {tile("Dew point", latest.dewp != null ? `${latest.dewp.toFixed(0)}°C` : "—",
                    latest.temp != null && latest.dewp != null ? `spread ${(latest.temp - latest.dewp).toFixed(0)}°` : null)}
                  {tile("Humidity", latest.temp != null && latest.dewp != null ? `${Math.round(relHumidity(latest.temp, latest.dewp))}%` : "—",
                    latest.temp != null && latest.dewp != null ? `cloud base ~${fmtFt(Math.max(0, (latest.temp - latest.dewp) * 400))}` : null)}
                  {tile(units.pres === "inHg" ? "Altimeter" : "QNH",
                    latest.altim != null ? (units.pres === "inHg" ? hpaToInHg(latest.altim).toFixed(2) : `${latest.altim.toFixed(0)}`) : "—",
                    latest.altim != null ? (units.pres === "inHg" ? `${latest.altim.toFixed(0)} hPa` : `${hpaToInHg(latest.altim).toFixed(2)} inHg`) : null)}
                  {tile("Density alt.", da != null ? fmtFt(da) : "—", pa != null ? `pressure alt. ${fmtFt(pa)}` : null)}
                  {tile("Freezing level", frzNow != null ? fmtFt(frzNow) : "—", frzNow != null ? `${prof?.modelLabel} now` : null)}
                  {latest.slp != null
                    ? tile("Sea-level pressure", `${latest.slp.toFixed(1)} hPa`, latest.presTend != null ? `3 h change ${latest.presTend > 0 ? "+" : ""}${latest.presTend.toFixed(1)}` : null)
                    : tile("Tropopause", tropNow != null ? `FL${Math.round(tropNow / 100)}` : "—", tropNow != null ? `${prof?.modelLabel} now` : null)}
                </div>
              )}
              {latest?.wx && (
                <div className="stn__wx">
                  {describeWx(latest.wx).map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
              )}

              {latest && (
                <>
                  <div className="stn__sec">
                    <span>Sky</span>
                  </div>
                  <div className="stn__sky">
                    {!latest.clouds.length && (
                      <div className="stn__skyrow">
                        <span>{latest.vv != null ? "Sky obscured" : "No layers reported"}</span>
                        <b>{latest.vv != null ? `VV ${fmtFt(latest.vv)}` : ""}</b>
                      </div>
                    )}
                    {latest.clouds.map((c, i) => (
                      <div key={`${c.cover}-${c.base}-${i}`} className="stn__skyrow">
                        <span>{SKY_WORDS[c.cover] ?? c.cover}{c.type ? ` (${c.type === "CB" ? "cumulonimbus" : c.type === "TCU" ? "towering cumulus" : c.type})` : ""}</span>
                        <b>{c.base == null ? "—" : `${fmtFt(c.base)} · ${Math.round(c.base * 0.3048)} m`}</b>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="stn__sec">
                <span>Runway in use</span>
                <button type="button" className="apt__more" onClick={() => setTab("airport")}>
                  all runways
                </button>
              </div>
              <RunwayDiagram runways={info!.runways} wdir={wdirNum} wspd={latest?.wspd ?? null} wgst={latest?.wgst ?? null} size={200} />
              <RunwayInUse runways={info!.runways} wdir={wdirNum} wspd={latest?.wspd ?? null} wgst={latest?.wgst ?? null} />

              {sun && (
                <>
                  <div className="stn__sec">
                    <span>Sun today</span>
                    <b>{utc ? "UTC" : "local"}</b>
                  </div>
                  <div className="stn__sum">
                    <div><span>Civil dawn</span><b>{clockOf(sun.dawn)}</b></div>
                    <div><span>Sunrise</span><b>{clockOf(sun.rise)}</b></div>
                    <div><span>Sunset</span><b>{clockOf(sun.set)}</b></div>
                    <div><span>Civil dusk</span><b>{clockOf(sun.dusk)}</b></div>
                  </div>
                </>
              )}

            </aside>

            <section className="stn__main">
              <div className="stn__tabs">
                {TABS.map(([id, label]) => (
                  <button key={id} type="button" className={`stn__tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
                    {label}
                    {id === "nearby" && data.advisories.length > 0 && <em className="apt__badge">{data.advisories.length}</em>}
                  </button>
                ))}
                <div className="stn__ranges">
                  {AIRPORT_RANGES.map((h) => (
                    <button key={h} type="button" className={`stn__range${hours === h ? " is-on" : ""}`} onClick={() => setHours(h)}>
                      {rangeLabel(h)}
                    </button>
                  ))}
                  <button type="button" className={`stn__range${utc ? " is-on" : ""}`} onClick={() => setUtc((v) => !v)} title="Times in UTC (Z)">
                    UTC
                  </button>
                </div>
              </div>

              {tab === "weather" && (
                <>
                  <div className="apt__units">
                    <button type="button" className={`stn__range${units.temp === "C" ? " is-on" : ""}`} onClick={() => setUnits({ ...units, temp: "C" })}>°C</button>
                    <button type="button" className={`stn__range${units.temp === "F" ? " is-on" : ""}`} onClick={() => setUnits({ ...units, temp: "F" })}>°F</button>
                    <button type="button" className={`stn__range${units.pres === "inHg" ? " is-on" : ""}`} onClick={() => setUnits({ ...units, pres: "inHg" })}>inHg</button>
                    <button type="button" className={`stn__range${units.pres === "hPa" ? " is-on" : ""}`} onClick={() => setUnits({ ...units, pres: "hPa" })}>hPa</button>
                    <span>
                      Past {rangeLabel(hours)} observed, then the TAF{data.taf ? ` to ${zDayClock(data.taf.to ?? 0)}` : " (none in force)"}
                      {prof ? `, and the ${prof.modelLabel} (faint) for the next three days` : ""}
                    </span>
                  </div>
                  <div className={busy ? "stn__charts is-busy" : "stn__charts"}>
                    <AirportChart metars={data.metars} taf={data.taf} runways={info!.runways} elevFt={elev} hours={hours} utc={utc} units={units} profile={prof} />
                  </div>
                </>
              )}

              {tab === "metars" && (
                <>
                  {latest?.raw && (
                    <>
                      <div className="stn__sec stn__sec--reports">
                        <span>Latest METAR, decoded · {clockOf(latest.t)}</span>
                        <b>every group</b>
                      </div>
                      <div className="apt__decwide">
                        <div>
                          <div className="apt__decwhat">Report</div>
                          <Decoded groups={decoded.body} />
                        </div>
                        {(decoded.trend.length > 0 || decoded.remarks.length > 0) && (
                          <div>
                            {decoded.trend.length > 0 && (
                              <>
                                <div className="apt__decwhat">Trend, next 2 hours</div>
                                <Decoded groups={decoded.trend} />
                              </>
                            )}
                            {decoded.remarks.length > 0 && (
                              <>
                                <div className="apt__decwhat">Remarks</div>
                                <Decoded groups={decoded.remarks} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  <div className="stn__sec stn__sec--reports">
                    <span>METARs ({data.metars.length}) · click one to decode it</span>
                    <button type="button" className="stn__copy" onClick={copyAll} disabled={!data.metars.length}>
                      {copied ? <Check size={11} /> : <Copy size={11} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div className="stn__reports apt__reports">
                    {data.metars.length === 0 && <div className="stn__loading">No METARs in this window.</div>}
                    {data.metars
                      .slice()
                      .reverse()
                      .map((m) => (
                        <MetarRow key={`${m.t}-${m.raw?.slice(0, 16)}`} m={m} clock={clockOf(m.t)} />
                      ))}
                  </div>
                </>
              )}

              {tab === "taf" && <TafView data={data} clockOf={clockOf} />}

              {tab === "aloft" && (
                <AloftTab data={data} utc={utc} model={model} setModel={setModel} busy={busy} />
              )}

              {tab === "airport" && (
                <div className="apt__grid">
                  <div className="apt__card">
                    <div className="stn__sec">
                      <span>Runways &amp; wind</span>
                      <b>{info!.runways.length ? `${info!.runways.length} runway${info!.runways.length === 1 ? "" : "s"}` : ""}</b>
                    </div>
                    <RunwayDiagram runways={info!.runways} wdir={wdirNum} wspd={latest?.wspd ?? null} wgst={latest?.wgst ?? null} size={320} />
                    <RunwayComponents runways={info!.runways} wdir={wdirNum} wspd={latest?.wspd ?? null} wgst={latest?.wgst ?? null} />
                  </div>
                  <div className="apt__card">
                    <div className="stn__sec">
                      <span>Runways</span>
                      <b>true headings, threshold elevations</b>
                    </div>
                    {info!.runways.length ? <RunwayList runways={info!.runways} /> : <div className="apt__none">No runway data for this airport.</div>}
                    <div className="stn__sec">
                      <span>Airport</span>
                    </div>
                    <div className="stn__sum">
                      {info!.typeWord && <div><span>Type</span><b>{info!.typeWord}</b></div>}
                      {info!.scheduled != null && <div><span>Airline service</span><b>{info!.scheduled ? "Scheduled" : "None"}</b></div>}
                      {info!.tower != null && <div><span>Control tower</span><b>{info!.tower ? "Yes" : "No"}</b></div>}
                      {elev != null && <div><span>Elevation</span><b>{Math.round(elev).toLocaleString("en-US")} ft · {Math.round(elev * 0.3048)} m</b></div>}
                      {info!.local && info!.local !== icao && <div><span>Local id</span><b>{info!.local}</b></div>}
                      {info!.magdec && <div><span>Magnetic variation</span><b>{info!.magdec}{info!.declinationSource === "navaid" ? " (nearest navaid)" : ""}</b></div>}
                      {data.fir && <div><span>FIR</span><b>{data.fir.id} {data.fir.name}</b></div>}
                    </div>
                    {(info!.wiki || info!.home) && (
                      <div className="apt__links">
                        {info!.wiki && <a href={info!.wiki} target="_blank" rel="noreferrer">Wikipedia <ExternalLink size={11} /></a>}
                        {info!.home && <a href={info!.home} target="_blank" rel="noreferrer">Website <ExternalLink size={11} /></a>}
                      </div>
                    )}
                  </div>
                  <div className="apt__card">
                    <div className="stn__sec">
                      <span>Frequencies</span>
                      <b>MHz</b>
                    </div>
                    {info!.freqs.length > 0 ? (
                      <div className="apt__freqs">
                        {info!.freqs.map((f, i) => (
                          <div key={`${f.name}-${f.mhz}-${i}`}>
                            {f.type && <em>{f.type}</em>}
                            <span>{f.name}</span>
                            <b>{f.mhz}</b>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="apt__none">No frequencies listed.</div>
                    )}
                  </div>
                  <div className="apt__card">
                    <div className="stn__sec">
                      <span>Navaids within 60 nm</span>
                      <b>bearing from the field</b>
                    </div>
                    {data.navaids.length > 0 ? (
                      <div className="apt__navs">
                        {data.navaids.map((n) => (
                          <div key={`${n.ident}-${n.type}-${n.nm}`}>
                            <b>{n.ident}</b>
                            <span>{n.type} · {n.name}</span>
                            <em>{n.freq ?? "—"}{n.dme ? ` · ch ${n.dme}` : ""}</em>
                            <i>{String(n.brgMag ?? n.brgTrue).padStart(3, "0")}°{n.brgMag != null ? "M" : "T"} {n.nm} nm</i>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="apt__none">No navaids within 60 nm.</div>
                    )}
                  </div>
                </div>
              )}

              {tab === "nearby" && <Nearby data={data} clockOf={clockOf} open={openAirport} />}

              <div className="stn__foot">
                NOAA Aviation Weather Center · FAA · OurAirports · VATSpy (FIRs) · {prof?.modelLabel ?? "GFS"} via Open-Meteo
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Decoded({ groups }: { groups: DecodedGroup[] }) {
  // The station id is the page's own airport: no need to spell it out again.
  const shown = groups.filter((g) => !(g.label === "Station" && /^[A-Z][A-Z0-9]{3}$/.test(g.code)));
  return (
    <div className="apt__dec">
      {shown.map((g, i) => (
        <div key={`${g.code}-${i}`} className={g.tone ? `is-${g.tone}` : undefined}>
          <code>{g.code}</code>
          <span>{g.label}</span>
          <b>{g.text}</b>
        </div>
      ))}
    </div>
  );
}

function MetarRow({ m, clock }: { m: AvnMetar; clock: string }) {
  const [open, setOpen] = useState(false);
  const d = useMemo(() => (open ? decodeMetar(m.raw) : null), [open, m.raw]);
  return (
    <div className={`stn__report apt__mrow${open ? " is-open" : ""}`}>
      <button type="button" className="apt__mhead" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="stn__dot" style={{ background: m.cat ? CATEGORY_COLOR[m.cat] : "var(--border)" }} title={m.cat ?? ""} />
        <time>{clock}</time>
        <code>{m.raw}</code>
        <ChevronDown size={12} className="apt__chev" />
      </button>
      {d && (
        <div className="apt__mbody">
          <Decoded groups={[...d.body, ...d.trend]} />
          {d.remarks.length > 0 && <Decoded groups={d.remarks} />}
        </div>
      )}
    </div>
  );
}

function periodLabel(p: TafPeriod): string {
  if (p.prob) return `PROB${p.prob}${p.change === "TEMPO" ? " TEMPO" : ""}`;
  return p.change ?? "Initial";
}

const ICG_WORD: Record<string, string> = {
  "0": "None", "1": "Light", "2": "Light in cloud", "3": "Light in precipitation", "4": "Moderate", "5": "Moderate in cloud",
  "6": "Moderate in precipitation", "7": "Severe", "8": "Severe in cloud", "9": "Severe in precipitation",
};
const TURB_WORD: Record<string, string> = {
  "0": "None", "1": "Light", "2": "Moderate in clear air, occasional", "3": "Moderate in clear air, frequent",
  "4": "Moderate in cloud, occasional", "5": "Moderate in cloud, frequent", "6": "Severe in clear air, occasional",
  "7": "Severe in clear air, frequent", "8": "Severe in cloud, occasional", "9": "Severe in cloud, frequent", X: "Extreme",
};

function periodWords(p: TafPeriod, clockOf: (t: number | null) => string): string {
  const parts: string[] = [];
  const when = p.change === "FM" ? `From ${clockOf(p.from)}` : p.change === "BECMG" ? `Becoming between ${clockOf(p.from)} and ${clockOf(p.to)}` :
    p.change === "TEMPO" || p.prob ? `${p.prob ? `${p.prob}% chance of` : "Temporarily"}${p.prob && p.change === "TEMPO" ? " temporary" : ""} between ${clockOf(p.from)} and ${clockOf(p.to)}` :
      `From ${clockOf(p.from)} to ${clockOf(p.to)}`;
  if (p.wspd != null) parts.push(`wind ${fmtWind(p.wdir, p.wspd, p.wgst).replace("Calm", "calm")}`);
  if (p.vis != null) parts.push(`visibility ${fmtVis(p.vis, p.visRaw)} (${fmtVisMetric(p.vis, p.visRaw)})`);
  if (p.wx) parts.push(describeWx(p.wx).join(", ").toLowerCase() || p.wx);
  const word = (cover: string) => {
    const w = SKY_WORDS[cover] ?? cover;
    return w === "CAVOK" ? w : w.toLowerCase();
  };
  const clouds = (p.clouds ?? []).map((c) => `${word(c.cover)}${c.base != null ? ` at ${fmtFt(c.base)}` : ""}${c.type === "CB" ? " (cumulonimbus)" : c.type === "TCU" ? " (towering cumulus)" : ""}`);
  if (clouds.length) parts.push(clouds.join(", "));
  if (p.vv != null) parts.push(`sky obscured, vertical visibility ${fmtFt(p.vv)}`);
  if (p.shear?.hgt != null) parts.push(`wind shear at ${fmtFt(p.shear.hgt)}: ${fmtWind(p.shear.dir, p.shear.spd)}`);
  if (p.altim != null) parts.push(`QNH ${p.altim.toFixed(0)} hPa (${hpaToInHg(p.altim).toFixed(2)} inHg)`);
  for (const g of p.icgTurb ?? []) {
    const w = g.kind === "ice" ? ICG_WORD[String(g.intensity)] ?? String(g.intensity) : TURB_WORD[String(g.intensity)] ?? String(g.intensity);
    parts.push(`${w.toLowerCase()} ${g.kind === "ice" ? "icing" : "turbulence"} ${g.lo != null ? fmtLevel(g.lo) : "?"} to ${g.hi != null ? fmtLevel(g.hi) : "?"}`);
  }
  if (p.notDecoded) parts.push(`(${p.notDecoded})`);
  return `${when}: ${parts.join("; ") || "no change given"}.`;
}

function TafView({ data, clockOf }: { data: AirportData; clockOf: (t: number | null) => string }) {
  const taf = data.taf;
  if (!taf) return <div className="stn__loading">No TAF in force for this airport. The Aloft tab and the faint model lines on the Weather chart still forecast it.</div>;
  return (
    <>
      <div className="stn__sec stn__sec--reports">
        <span>TAF issued {taf.issue ? zDayClock(taf.issue) : "—"}</span>
        <b>
          valid {taf.from ? zDayClock(taf.from) : "?"} to {taf.to ? zDayClock(taf.to) : "?"}
        </b>
      </div>
      <code className="apt__raw apt__raw--taf">{taf.raw}</code>
      {taf.temps && taf.temps.length > 0 && (
        <div className="apt__txtn">
          {taf.temps.map((t) => (
            <span key={`${t.kind}-${t.t}`} className={t.kind === "MAX" ? "is-max" : "is-min"}>
              {t.kind === "MAX" ? "Maximum" : "Minimum"} {t.temp != null ? `${t.temp}°C (${Math.round(((t.temp ?? 0) * 9) / 5 + 32)}°F)` : "—"} at {zDayClock(t.t)}
            </span>
          ))}
        </div>
      )}
      <div className="apt__table apt__table--taf">
        <div className="apt__trow apt__trow--head">
          <span>Group</span>
          <span>From</span>
          <span>To</span>
          <span>Wind</span>
          <span>Vis</span>
          <span>Weather</span>
          <span>Clouds</span>
          <span>Other</span>
          <span>Cat</span>
        </div>
        {taf.periods.map((p, i) => (
          <div key={`${p.from}-${i}`} className={`apt__trow${p.change === "TEMPO" || p.prob ? " is-temp" : ""}`}>
            <span>{periodLabel(p)}</span>
            <span>{clockOf(p.from)}</span>
            <span>{clockOf(p.to)}</span>
            <span>{p.wspd != null ? fmtWind(p.wdir, p.wspd, p.wgst) : "—"}</span>
            <span>{p.vis != null ? fmtVis(p.vis, p.visRaw) : "—"}</span>
            <span>{p.wx ? describeWx(p.wx).join(", ") || p.wx : "—"}</span>
            <span>
              {(p.clouds ?? []).map((c) => `${c.cover}${c.base != null ? ` ${Math.round(c.base).toLocaleString("en-US")}` : ""}${c.type ?? ""}`).join(", ") ||
                (p.vv != null ? `VV ${p.vv}` : "—")}
            </span>
            <span>
              {[
                p.shear?.hgt != null ? `WS ${fmtFt(p.shear.hgt)} ${fmtWind(p.shear.dir, p.shear.spd)}` : null,
                p.altim != null ? `QNH ${p.altim.toFixed(0)}` : null,
                ...(p.icgTurb ?? []).map((g) => `${g.kind === "ice" ? "ICE" : "TURB"} ${g.intensity} ${g.lo != null ? fmtLevel(g.lo) : ""}-${g.hi != null ? fmtLevel(g.hi) : ""}`),
              ]
                .filter(Boolean)
                .join(" · ") || "—"}
            </span>
            <span>
              {p.cat ? <i className="apt__catdot" style={{ background: CATEGORY_COLOR[p.cat] }} title={p.cat} /> : null}
              {p.cat ?? ""}
            </span>
          </div>
        ))}
      </div>
      <div className="stn__sec stn__sec--reports">
        <span>In words</span>
      </div>
      <div className="apt__words">
        {taf.periods.map((p, i) => (
          <p key={`${p.from}-${i}`} className={p.change === "TEMPO" || p.prob ? "is-temp" : undefined}>
            {periodWords(p, clockOf)}
          </p>
        ))}
      </div>
      {taf.remarks && <div className="apt__note">Remarks: {taf.remarks}</div>}
    </>
  );
}

function AloftTab({ data, utc, model, setModel, busy }: { data: AirportData; utc: boolean; model: ProfileModel; setModel: (m: ProfileModel) => void; busy: boolean }) {
  const [top, setTop] = useState(45000);
  const prof = data.profile;
  return (
    <>
      <div className="apt__units">
        {MODELS.map(([id, label]) => (
          <button key={id} type="button" className={`stn__range${model === id ? " is-on" : ""}`} onClick={() => setModel(id)}>
            {label}
          </button>
        ))}
        <span className="apt__gap" />
        {[
          [12000, "To 12,000 ft"],
          [24000, "To FL240"],
          [45000, "To FL450"],
          [55000, "To FL550"],
        ].map(([v, l]) => (
          <button key={v} type="button" className={`stn__range${top === v ? " is-on" : ""}`} onClick={() => setTop(Number(v))}>
            {l}
          </button>
        ))}
        {busy && <Loader2 size={12} className="stn__spin" />}
      </div>
      {!prof ? (
        <div className="apt__none">{data.errors?.profile ? `The model profile could not be read: ${data.errors.profile}` : "No model profile for this airport."}</div>
      ) : (
        <>
          <div className="stn__sec stn__sec--reports">
            <span>The air over {data.info.icao}: {prof.modelLabel}, hour by hour</span>
            <b>hover for the column</b>
          </div>
          <AloftChart profile={prof} utc={utc} top={top} />
        </>
      )}
      <div className="stn__sec stn__sec--reports">
        <span>Winds &amp; temperatures aloft</span>
        <b>{prof ? `${prof.modelLabel}${Object.keys(data.aloft).length ? " and the official FB" : ""}` : ""}</b>
      </div>
      <AloftTable profile={prof} official={data.aloft} utc={utc} />
    </>
  );
}

function Nearby({ data, clockOf, open }: { data: AirportData; clockOf: (t: number | null) => string; open: (icao: string) => void }) {
  return (
    <>
      {data.fir && (
        <div className="apt__fir">
          <b>FIR {data.fir.id}</b>
          <span>{data.fir.name}{data.fir.oceanic ? " (oceanic)" : ""}</span>
        </div>
      )}
      <div className="stn__sec stn__sec--reports">
        <span>Advisories over the airport ({data.advisories.length})</span>
      </div>
      {data.advisories.length === 0 && <div className="apt__none">No SIGMET{data.info.country === "US" ? ", G-AIRMET, CWA or TFR" : ""} covers the field right now.</div>}
      <div className="apt__advs">
        {data.advisories.map((a, i) => {
          const h = String(a.hazard ?? a.type ?? "");
          const colour = a.kind === "tfr" ? "#ef4444" : (HAZARD_COLOR[h] ?? HAZARD_FALLBACK);
          const title =
            a.kind === "tfr"
              ? `TFR ${String(a.id ?? "")}: ${String(a.type ?? "")}`
              : `${hazardLabel(h)}${a.qualifier ? ` (${String(a.qualifier).toLowerCase()})` : ""} · ${a.kind === "gairmet" ? "G-AIRMET" : a.kind === "cwa" ? "CWA" : a.kind === "sigmet" ? (a.sub === "convective" ? "Convective SIGMET" : a.sub === "airmet" ? "AIRMET" : a.region === "US" ? "SIGMET" : `SIGMET ${String(a.series ?? "")} · ${String(a.fir ?? a.region ?? "")}`) : String(a.kind)}`;
          const raw = (a.raw ?? a.description) as string | undefined;
          return (
            <details key={i} className="apt__adv" style={{ ["--hz" as string]: colour }}>
              <summary>
                <i />
                <b>{title}</b>
                <span>
                  {a.from || a.to ? `${a.from ? zDayClock(Number(a.from)) : "?"}–${a.to ? zDayClock(Number(a.to)) : "?"}` : ""}
                  {a.lo != null || a.hi != null ? ` · ${a.lo ? fmtLevel(a.lo) : "SFC"}–${a.hi ? fmtLevel(a.hi) : "?"}` : ""}
                  {a.kind === "gairmet" ? ` · ${a.base ?? ""}–${a.top ?? ""}` : ""}
                  {Number(a.spd) > 0 ? ` · moving ${String(a.dir ?? "")} ${String(a.spd)} kt` : a.dir === "STNR" || a.chng ? ` · ${a.dir === "STNR" ? "stationary" : ""}${a.chng ? ` ${String(a.chng).toLowerCase()}` : ""}` : ""}
                </span>
              </summary>
              {raw && <pre>{raw}</pre>}
            </details>
          );
        })}
      </div>

      <div className="stn__sec stn__sec--reports">
        <span>Airports reporting within 120 nm ({data.nearby.length})</span>
        <b>click one to open it</b>
      </div>
      {data.nearby.length === 0 && <div className="apt__none">No other airport reports within 120 nm.</div>}
      <div className="apt__table apt__table--near">
        {data.nearby.length > 0 && (
          <div className="apt__trow apt__trow--head">
            <span>Airport</span>
            <span>Distance</span>
            <span>Cat</span>
            <span>Wind</span>
            <span>Vis</span>
            <span>Ceiling</span>
            <span>Weather</span>
            <span>Obs</span>
          </div>
        )}
        {data.nearby.map((n) => (
          <button key={n.icao} type="button" className="apt__trow apt__trow--btn" onClick={() => open(n.icao)} title={n.raw ?? ""}>
            <span><b>{n.icao}</b> {n.name ?? ""}</span>
            <span>{n.nm} nm {compassPoint(n.brg)}</span>
            <span>{n.cat ? <i className="apt__catdot" style={{ background: CATEGORY_COLOR[n.cat] }} /> : null}{n.cat ?? "—"}</span>
            <span>{n.wspd != null ? fmtWind(n.wdir, n.wspd, n.wgst) : "—"}</span>
            <span>{fmtVis(n.vis)}</span>
            <span>{n.ceil != null ? fmtFt(n.ceil) : "—"}</span>
            <span>{n.wx ? describeWx(n.wx).join(", ") : "—"}</span>
            <span>{n.obs ? clockOf(Number(n.obs)) : "—"}</span>
          </button>
        ))}
      </div>

      <div className="stn__sec stn__sec--reports">
        <span>Pilot reports within 100 nm, last 6 h ({data.pireps.length})</span>
      </div>
      {data.pireps.length === 0 && <div className="apt__none">No PIREPs or AIREPs near the field in the last six hours.</div>}
      <div className="stn__reports apt__reports">
        {data.pireps.map((p, i) => {
          const lvl = Math.max(p.level, 0);
          const what =
            p.kind === "turb"
              ? lvl === 0 ? "No turbulence (NEG)" : `${INTENSITY_LABEL[lvl]} turbulence`
              : p.kind === "ice"
                ? lvl === 0 ? "No icing (NEG)" : `${INTENSITY_LABEL[lvl]} icing`
                : "Report";
          const extra = [
            ...p.turbs.map((t) => `turb ${t.int}${t.type ? ` ${t.type}` : ""}${t.base != null ? ` ${fmtLevel(t.base)}${t.top != null ? `–${fmtLevel(t.top)}` : ""}` : ""}`),
            ...p.ices.map((t) => `ice ${t.int}${t.type ? ` ${t.type}` : ""}${t.base != null ? ` ${fmtLevel(t.base)}${t.top != null ? `–${fmtLevel(t.top)}` : ""}` : ""}`),
            ...p.skies.map((s) => `${s.cover}${s.base != null ? ` ${fmtLevel(s.base)}` : ""}${s.top != null ? ` tops ${fmtLevel(s.top)}` : ""}`),
            p.temp != null ? `${p.temp}°C` : null,
            p.wspd != null ? fmtWind(p.wdir, p.wspd) : null,
          ].filter(Boolean);
          return (
            <div key={`${p.t}-${i}`} className="stn__report apt__pirep">
              <span className="stn__dot" style={{ background: p.kind === "other" ? "var(--text-faint)" : INTENSITY_COLOR[lvl] }} />
              <time>{clockOf(p.t)}</time>
              <code>
                <b>
                  {p.urgent ? "UUA · " : ""}
                  {what} · {p.alt != null ? fmtLevel(p.alt) : "?"} · {p.nm} nm{p.ac ? ` · ${p.ac}` : ""}
                </b>
                {extra.length > 0 && (
                  <>
                    <br />
                    <i>{extra.join(" · ")}</i>
                  </>
                )}
                <br />
                {p.raw}
              </code>
            </div>
          );
        })}
      </div>
    </>
  );
}
