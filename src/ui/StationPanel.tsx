import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Crosshair, Loader2, MapPin, RefreshCw, X } from "lucide-react";

import {
  CATEGORY_COLOR,
  CATEGORY_LABEL,
  SKY_WORDS,
  compassPoint,
  describeWx,
  relativeTime,
} from "../lib/metar";
import {
  fetchStationDirectory,
  fetchStationSeries,
  lookupStation,
  type StationObs,
} from "../lib/stations";
import { getMap } from "../map/mapInstance";
import { useStationStore, STATION_RANGES, type StationProduct } from "../store/useStationStore";
import { useSurfaceObsStore } from "../store/useSurfaceObsStore";
import { Meteogram, type MeteoPanel } from "./station/Meteogram";

// Tab names deliberately unlike the tiles beside them: "Temperature" over a
// chart and "Temperature" over a reading were two different things wearing the
// same word.
const PRODUCTS: { id: StationProduct; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "temp", label: "Temps" },
  { id: "wind", label: "Winds" },
  { id: "pressure", label: "Barometer" },
  { id: "sky", label: "Sky" },
  { id: "precip", label: "Rainfall" },
];

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
};

const MB_PER_INHG = 33.8638866667;

/**
 * The map's station plots come from the AWC feed in metric; the history comes
 * from IEM in the units a METAR is written in. This turns one into the other so
 * the panel has something to show in the moment before the history lands.
 */
/** Which network a clicked station belongs to: only an airport has a METAR. */
type Kind = "metar" | "synop" | "inmet" | "mesonet";
const kindOf = (current: Record<string, unknown> | undefined): Kind => {
  const k = current?.kind;
  return k === "synop" || k === "inmet" || k === "mesonet" ? k : "metar";
};
/** The station series endpoint's name for each network. */
const SERIES_NETWORK: Record<Exclude<Kind, "metar">, string> = { synop: "SYNOP", inmet: "INMET", mesonet: "MESONET" };

function obsFromClicked(current: Record<string, unknown> | undefined): StationObs | null {
  if (!current) return null;
  const kind = kindOf(current);
  const c = (v: unknown) => {
    const n = num(v);
    return n == null ? null : n * 1.8 + 32;
  };
  const altimMb = num(current.altim);
  let skies: { cover: string; base: number | null }[] = [];
  const rawClouds = current.clouds;
  try {
    const parsed = typeof rawClouds === "string" ? JSON.parse(rawClouds) : rawClouds;
    if (Array.isArray(parsed)) {
      skies = parsed
        .filter((l) => l && typeof l === "object")
        .map((l) => ({ cover: String((l as Record<string, unknown>).cover ?? ""), base: num((l as Record<string, unknown>).base) }))
        .filter((l) => l.cover);
    }
  } catch {
    skies = [];
  }
  const ceiling = skies.find((l) => ["BKN", "OVC", "VV"].includes(l.cover) && l.base != null)?.base ?? null;
  const obsTime = num(current.obsTime);
  return {
    valid: obsTime == null ? Date.now() / 1000 : obsTime > 1e11 ? obsTime / 1000 : obsTime,
    tmpf: c(current.temp),
    dwpf: c(current.dewp),
    relh: num(current.rh),
    feel: null,
    drct: num(current.wdir),
    sknt: num(current.wspd),
    gust: num(current.wgst),
    vsby: num(current.visib),
    // SYNOP and INMET send sea-level pressure; an airport and a mesonet the altimeter.
    alti: altimMb == null || kind === "synop" || kind === "inmet" ? null : altimMb / MB_PER_INHG,
    mslp: num(current.mslp),
    p01i: null,
    skies,
    wx: (current.wx as string) ?? null,
    raw: (current.raw as string) ?? null,
    ceiling,
    cover: (current.cover as string) ?? null,
    cat: null,
    precipMm: num(current.precip),
    precipHours: num(current.precipHours),
    tmaxC: num(current.tmax),
    tminC: num(current.tmin),
    extremesHours: kind === "inmet" ? 1 : null,
    oktas: num(current.oktas),
  };
}

/** The full station report: current conditions, meteograms and the reports. */
export function StationPanel() {
  const station = useStationStore((s) => s.station);
  const hours = useStationStore((s) => s.hours);
  const product = useStationStore((s) => s.product);
  const close = useStationStore((s) => s.close);
  const setHours = useStationStore((s) => s.setHours);
  const setProduct = useStationStore((s) => s.setProduct);
  const open = useStationStore((s) => s.open);

  const tempUnits = useSurfaceObsStore((s) => s.tempUnits);
  const windUnits = useSurfaceObsStore((s) => s.windUnits);
  const presUnits = useSurfaceObsStore((s) => s.presUnits);
  const visUnits = useSurfaceObsStore((s) => s.visUnits);

  const [rows, setRows] = useState<StationObs[]>([]);
  /** Which IEM service answered: the bulk one gives the hourly reports, the
   *  per-day stand-in gives the five-minute ones, and the charts look it. */
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [utc, setUtc] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const info = station?.info ?? null;
  const current = station?.current as Record<string, unknown> | undefined;
  const kind = kindOf(current);
  const airport = kind === "metar";
  const seriesId = info?.id || station?.id || "";
  const network = airport ? info?.network || "" : SERIES_NETWORK[kind];

  // The station the map knows about is an ICAO; the history is filed under the
  // IEM id. Match it in the directory once, then keep the entry on the station.
  useEffect(() => {
    if (!station || station.info !== undefined) return;
    // The directory is the airports'; a synoptic or mesonet station is not in it.
    if (kindOf(station.current as Record<string, unknown> | undefined) !== "metar") {
      open({ ...station, info: null });
      return;
    }
    let cancelled = false;
    fetchStationDirectory()
      .then((list) => {
        if (cancelled) return;
        const found = lookupStation(list, station.id);
        open({ ...station, info: found });
      })
      .catch(() => {
        if (!cancelled) open({ ...station, info: null });
      });
    return () => {
      cancelled = true;
    };
  }, [station, open]);

  useEffect(() => {
    if (!seriesId) return;
    const ctrl = new AbortController();
    setBusy(true);
    setError(null);
    fetchStationSeries(seriesId, hours, network, ctrl.signal)
      .then((data) => {
        setRows(data.observations ?? []);
        setSource(data.source ?? "");
        setBusy(false);
        if (!data.observations?.length) {
          setError(
            network === "MESONET"
              ? "History builds up while the app runs: MADIS is read an hour at a time."
              : "No observations in this window.",
          );
        }
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setBusy(false);
        setError(String(err instanceof Error ? err.message : err));
      });
    return () => ctrl.abort();
  }, [seriesId, hours, network, reloadKey]);

  useEffect(() => {
    setRows([]);
  }, [seriesId]);

  // A station page left open should not go quietly stale: reports land hourly,
  // specials whenever the weather changes. The backend caches for four minutes,
  // so this costs a request every five.
  useEffect(() => {
    if (!station) return;
    const timer = window.setInterval(() => setReloadKey((k) => k + 1), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [station]);

  useEffect(() => {
    if (!station) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [station, close]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [seriesId]);

  const clicked = useMemo(
    () => obsFromClicked(station?.current as Record<string, unknown> | undefined),
    [station],
  );
  const latest = rows.length ? rows[rows.length - 1] : clicked;

  // Display conversions. IEM reports °F, knots, inches of mercury, statute
  // miles and inches of rain; the app's unit switches decide what is shown.
  const conv = useMemo(() => {
    const metricDepth = tempUnits === "C"; // °C and inches of rain do not belong together
    return {
      temp: (f: number) => (tempUnits === "C" ? ((f - 32) * 5) / 9 : f),
      tempUnit: tempUnits === "C" ? "°C" : "°F",
      wind: (kt: number) => (windUnits === "mph" ? kt * 1.15078 : windUnits === "ms" ? kt * 0.514444 : kt),
      windUnit: windUnits === "ms" ? " m/s" : ` ${windUnits}`,
      /** Altimeter arrives in inHg, sea-level pressure in millibars. */
      pres: (inHg: number) => (presUnits === "mb" ? inHg * MB_PER_INHG : inHg),
      mslp: (mb: number) => (presUnits === "mb" ? mb : mb / MB_PER_INHG),
      presUnit: presUnits === "mb" ? " mb" : " inHg",
      presDec: presUnits === "mb" ? 1 : 2,
      vis: (mi: number) => (visUnits === "km" ? mi * 1.60934 : mi),
      visUnit: visUnits === "km" ? " km" : " mi",
      depth: (inches: number) => (metricDepth ? inches * 25.4 : inches),
      depthUnit: metricDepth ? " mm" : '"',
      depthDec: metricDepth ? 1 : 2,
      height: (ft: number) => (visUnits === "km" ? ft * 0.3048 : ft),
      heightUnit: visUnits === "km" ? " m" : " ft",
    };
  }, [tempUnits, windUnits, presUnits, visUnits]);

  const panels = useMemo<MeteoPanel[]>(() => buildPanels(product, conv), [product, conv]);

  // An automated station often reports the altimeter setting and no sea-level
  // pressure at all. Rather than draw an empty panel, the overview falls back
  // to the altimeter -- the Pressure tab still shows the two apart.
  const chartRows = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        presMb: r.mslp ?? (r.alti != null ? r.alti * MB_PER_INHG : null),
      })),
    [rows],
  );

  const summary = useMemo(() => {
    const vals = (key: keyof StationObs) =>
      rows.map((r) => num(r[key])).filter((v): v is number => v != null);
    const temps = vals("tmpf");
    const gusts = [...vals("gust"), ...vals("sknt")];
    const precip = rows.reduce((sum, r) => sum + (num(r.p01i) ?? 0), 0);
    const pres = rows.map((r) => num(r.mslp) ?? (num(r.alti) != null ? num(r.alti)! * MB_PER_INHG : null));
    const recent = pres.filter((v): v is number => v != null);
    const threeHoursAgo = rows.findIndex((r) => r.valid >= (rows[rows.length - 1]?.valid ?? 0) - 3 * 3600);
    const then = threeHoursAgo >= 0 ? pres[threeHoursAgo] : null;
    const trend = then != null && recent.length ? recent[recent.length - 1] - then : null;
    return {
      high: temps.length ? Math.max(...temps) : null,
      low: temps.length ? Math.min(...temps) : null,
      gust: gusts.length ? Math.max(...gusts) : null,
      precip,
      trend,
    };
  }, [rows]);

  if (!station) return null;

  // The newest report that had a gust in it, for when the current one has none.
  const gustNow = latest?.gust ?? null;
  const lastGust = gustNow == null ? [...rows].reverse().find((r) => r.gust != null) ?? null : null;

  const skies = latest?.skies ?? [];
  const cat = airport ? (latest?.cat ?? null) : null;
  const netBadge = kind === "synop" ? "SYNOP" : kind === "inmet" ? "INMET" : String(current?.network || "Mesonet");
  /** Newest first, for the observations table that stands in for the reports. */
  const obsRows = (rows.length ? rows : latest ? [latest] : []).slice().reverse();
  const wxWords = describeWx(latest?.wx);
  const reports = rows.filter((r) => r.raw).slice().reverse();
  const title = info?.icao || station.id;
  const place = [info?.name || station.name, info?.state].filter(Boolean).join(", ");

  const copyAll = () => {
    const text = reports
      .slice(0, 50)
      .map((r) => r.raw)
      .join("\n");
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };

  const showOnMap = () => {
    const map = getMap();
    const lat = info?.lat ?? station.lat;
    const lon = info?.lon ?? station.lon;
    if (map && Number.isFinite(lat) && Number.isFinite(lon)) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: 900 });
    }
  };

  const tile = (label: string, value: string, sub?: string | null) => (
    <div className="stn__tile" key={label}>
      <span>{label}</span>
      <b>{value}</b>
      {sub ? <i>{sub}</i> : null}
    </div>
  );

  const fmt = (v: number | null | undefined, to: (n: number) => number, unit: string, dec = 0) =>
    v == null ? "—" : `${to(v).toFixed(dec)}${unit}`;

  return (
    <div className="stn" role="dialog" aria-modal="true" aria-label={`Station ${title}`}>
      <div className="stn__scrim" onClick={close} />
      <div className="stn__panel">
        <header className="stn__top">
          <div className="stn__ident">
            <h2>{title}</h2>
            <div>
              <b>{place || "—"}</b>
              <span>
                {[
                  info?.county ? `${info.county} County` : null,
                  info?.wfo ? `WFO ${info.wfo}` : null,
                  info?.elev != null
                    ? `${conv.height(info.elev * 3.28084).toFixed(0)}${conv.heightUnit}`
                    : num(current?.elev) != null
                      ? `${conv.height(num(current?.elev)! * 3.28084).toFixed(0)}${conv.heightUnit}`
                      : null,
                  `${(info?.lat ?? station.lat).toFixed(3)}, ${(info?.lon ?? station.lon).toFixed(3)}`,
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
            {!airport && (
              <div className="stn__net" title="Not an airport: no flight category or METAR -- the readings the network sends">
                {netBadge}
              </div>
            )}
            <button type="button" className="stn__icon" onClick={showOnMap} title="Centre the map here">
              <Crosshair size={14} />
            </button>
            <button
              type="button"
              className="stn__icon"
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload observations"
            >
              <RefreshCw size={14} className={busy ? "stn__spin" : undefined} />
            </button>
            <button type="button" className="stn__icon" onClick={close} aria-label="Close">
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="stn__body" ref={bodyRef}>
          <aside className="stn__side">
            <div className="stn__sec">
              <span>Current conditions</span>
              <b>{latest ? relativeTime(latest.valid) : busy ? "loading" : "—"}</b>
            </div>
            <div className="stn__tiles">
              {tile("Temperature", fmt(latest?.tmpf, conv.temp, conv.tempUnit))}
              {tile("Dewpoint", fmt(latest?.dwpf, conv.temp, conv.tempUnit))}
              {tile(
                "Feels like",
                fmt(latest?.feel ?? latest?.tmpf, conv.temp, conv.tempUnit),
                latest?.feel == null ? "no departure" : null,
              )}
              {tile("Humidity", latest?.relh == null ? "—" : `${Math.round(latest.relh)}%`)}
              {tile(
                "Wind",
                latest?.sknt == null
                  ? "—"
                  : latest.sknt < 1
                    ? "Calm"
                    : `${conv.wind(latest.sknt).toFixed(0)}${conv.windUnit}`,
                latest?.drct != null && (latest.sknt ?? 0) >= 1
                  ? `${compassPoint(latest.drct)} ${Math.round(latest.drct)}°`
                  : null,
              )}
              {tile(
                "Gust",
                gustNow != null
                  ? `${conv.wind(gustNow).toFixed(0)}${conv.windUnit}`
                  : lastGust
                    ? `${conv.wind(lastGust.gust!).toFixed(0)}${conv.windUnit}`
                    : "None",
                gustNow != null
                  ? null
                  : lastGust
                    ? `last, ${relativeTime(lastGust.valid)}`
                    : `not in ${hours} h`,
              )}
              {tile(
                "Pressure",
                latest?.mslp != null
                  ? `${conv.mslp(latest.mslp).toFixed(conv.presDec)}${conv.presUnit}`
                  : fmt(latest?.alti, conv.pres, conv.presUnit, conv.presDec),
                latest?.mslp != null ? "sea level" : "altimeter",
              )}
              {airport || latest?.vsby != null ? tile("Visibility", fmt(latest?.vsby, conv.vis, conv.visUnit, 1)) : null}
              {airport
                ? tile(
                    "Ceiling",
                    latest?.ceiling == null ? "unlimited" : `${conv.height(latest.ceiling).toFixed(0)}${conv.heightUnit}`,
                    latest?.cover ? (SKY_WORDS[latest.cover] ?? latest.cover) : null,
                  )
                : kind === "synop"
                  ? tile(
                      "Cloud cover",
                      latest?.oktas == null ? "—" : latest.oktas === 9 ? "Obscured" : `${latest.oktas}/8`,
                      latest?.cloudBaseM != null ? `lowest ~${conv.height(latest.cloudBaseM * 3.28084).toFixed(0)}${conv.heightUnit}` : null,
                    )
                  : latest?.tmaxC == null && latest?.tminC == null
                    ? null
                    : tile(
                      kind === "inmet" ? "Max / min (hour)" : "Max / min 24 h",
                      latest?.tmaxC == null && latest?.tminC == null
                        ? "—"
                        : `${latest?.tmaxC == null ? "—" : conv.temp(latest.tmaxC * 1.8 + 32).toFixed(0)} / ${
                            latest?.tminC == null ? "—" : conv.temp(latest.tminC * 1.8 + 32).toFixed(0)
                          }${conv.tempUnit}`,
                    )}
              {airport
                ? tile("Precip 1 h", fmt(latest?.p01i, conv.depth, conv.depthUnit, conv.depthDec))
                : tile(
                    "Rain",
                    latest?.precipMm == null
                      ? "—"
                      : `${conv.depth(latest.precipMm / 25.4).toFixed(conv.depthDec)}${conv.depthUnit}`,
                    latest?.precipHours ? `last ${latest.precipHours} h` : kind === "mesonet" ? "station's own total" : null,
                  )}
            </div>

            {wxWords.length > 0 && (
              <div className="stn__wx">
                {wxWords.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
            )}

            <div className="stn__sec">
              <span>Last {hours} h</span>
            </div>
            <div className="stn__sum">
              <div>
                <span>High</span>
                <b>{fmt(summary.high, conv.temp, conv.tempUnit)}</b>
              </div>
              <div>
                <span>Low</span>
                <b>{fmt(summary.low, conv.temp, conv.tempUnit)}</b>
              </div>
              <div>
                <span>Peak wind</span>
                <b>{summary.gust == null ? "—" : `${conv.wind(summary.gust).toFixed(0)}${conv.windUnit}`}</b>
              </div>
              <div>
                <span>Precip</span>
                <b>{`${conv.depth(summary.precip).toFixed(conv.depthDec)}${conv.depthUnit}`}</b>
              </div>
              <div>
                <span>3 h pressure</span>
                <b>
                  {summary.trend == null
                    ? "—"
                    : `${summary.trend > 0 ? "+" : ""}${(presUnits === "mb" ? summary.trend : summary.trend / MB_PER_INHG).toFixed(
                        conv.presDec,
                      )}${conv.presUnit}`}
                </b>
              </div>
            </div>

            {airport && (
            <>
            <div className="stn__sec">
              <span>Sky</span>
            </div>
            <div className="stn__sky">
              {skies.length === 0 && (
                <div className="stn__skyrow">
                  <span>{latest?.cover ? (SKY_WORDS[latest.cover] ?? latest.cover) : "No layers reported"}</span>
                  <b />
                </div>
              )}
              {skies.map((layer, i) => (
                <div key={`${layer.cover}-${layer.base}-${i}`} className="stn__skyrow">
                  <span>{SKY_WORDS[layer.cover] ?? layer.cover}</span>
                  <b>
                    {layer.base == null
                      ? "—"
                      : `${Math.round(conv.height(layer.base)).toLocaleString()}${conv.heightUnit}`}
                  </b>
                </div>
              ))}
            </div>
            </>
            )}
          </aside>

          <section className="stn__main">
            <div className="stn__tabs">
              {PRODUCTS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`stn__tab${product === p.id ? " is-on" : ""}`}
                  onClick={() => setProduct(p.id)}
                >
                  {p.label}
                </button>
              ))}
              <div className="stn__ranges">
                {STATION_RANGES.map((h) => (
                  <button
                    key={h}
                    type="button"
                    className={`stn__range${hours === h ? " is-on" : ""}`}
                    onClick={() => setHours(h)}
                  >
                    {h}h
                  </button>
                ))}
                <button
                  type="button"
                  className={`stn__range${utc ? " is-on" : ""}`}
                  onClick={() => setUtc((v) => !v)}
                  title="Read the crosshair in UTC"
                >
                  UTC
                </button>
              </div>
            </div>

            {busy && !rows.length ? (
              <div className="stn__loading">
                <Loader2 size={15} className="stn__spin" /> Reading {title}&rsquo;s last {hours} hours&hellip;
              </div>
            ) : error && !rows.length ? (
              <div className="stn__loading is-error">{error}</div>
            ) : (
              <div className={busy ? "stn__charts is-busy" : "stn__charts"}>
                <Meteogram rows={chartRows} panels={panels} utc={utc} />
              </div>
            )}

            {airport ? (
            <>
            <div className="stn__sec stn__sec--reports">
              <span>
                <MapPin size={11} /> Reports ({reports.length})
              </span>
              <button type="button" className="stn__copy" onClick={copyAll} disabled={!reports.length}>
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="stn__reports">
              {reports.length === 0 && <div className="stn__loading">No reports in this window.</div>}
              {reports.map((r) => (
                <div key={`${r.valid}-${r.raw?.slice(0, 12)}`} className="stn__report">
                  <span
                    className="stn__dot"
                    style={{ background: r.cat ? CATEGORY_COLOR[r.cat] : "var(--border)" }}
                    title={r.cat ?? ""}
                  />
                  <time>
                    {utc
                      ? `${new Date(r.valid * 1000).toISOString().slice(11, 16)}Z`
                      : new Date(r.valid * 1000).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}
                  </time>
                  <code>{r.raw}</code>
                </div>
              ))}
            </div>

            <div className="stn__foot">
              ASOS via Iowa Environmental Mesonet{source === "obhistory" ? " · 5-minute reports" : ""}
              {info?.tz ? ` · ${info.tz}` : ""}
            </div>
            </>
            ) : (
            <>
            {/* Not an airport: no METAR to list, so its readings, hour by hour. */}
            <div className="stn__sec stn__sec--reports">
              <span>
                <MapPin size={11} /> Observations ({obsRows.length})
              </span>
            </div>
            <div className="stn__obs">
              <div className="stn__obsrow stn__obsrow--head">
                <span>Time</span>
                <span>Temp</span>
                <span>Dewpt</span>
                <span>RH</span>
                <span>Wind</span>
                <span>Gust</span>
                <span>Pressure</span>
                <span>Rain</span>
              </div>
              {obsRows.map((r) => (
                <div key={r.valid} className="stn__obsrow">
                  <time>
                    {utc
                      ? `${new Date(r.valid * 1000).toISOString().slice(11, 16)}Z`
                      : new Date(r.valid * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                  </time>
                  <span>{fmt(r.tmpf, conv.temp, "°")}</span>
                  <span>{fmt(r.dwpf, conv.temp, "°")}</span>
                  <span>{r.relh == null ? "—" : `${Math.round(r.relh)}%`}</span>
                  <span>
                    {r.sknt == null
                      ? "—"
                      : r.sknt < 1
                        ? "Calm"
                        : `${r.drct != null ? `${compassPoint(r.drct)} ` : ""}${conv.wind(r.sknt).toFixed(0)}`}
                  </span>
                  <span>{r.gust == null ? "—" : conv.wind(r.gust).toFixed(0)}</span>
                  <span>
                    {r.mslp != null
                      ? conv.mslp(r.mslp).toFixed(conv.presDec)
                      : r.alti != null
                        ? conv.pres(r.alti).toFixed(conv.presDec)
                        : "—"}
                  </span>
                  <span>{r.precipMm == null ? "—" : conv.depth(r.precipMm / 25.4).toFixed(conv.depthDec)}</span>
                </div>
              ))}
            </div>
            <div className="stn__foot">
              {kind === "synop"
                ? `WMO synoptic station ${station.id} · SYNOP via OGIMET`
                : kind === "inmet"
                  ? `INMET automatic station ${station.id} · hourly`
                  : `${netBadge} via NOAA MADIS · public mesonet data`}
              {` · wind in${conv.windUnit}, pressure in${conv.presUnit}`}
            </div>
            </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

type Conv = {
  temp: (v: number) => number;
  tempUnit: string;
  wind: (v: number) => number;
  windUnit: string;
  pres: (v: number) => number;
  mslp: (v: number) => number;
  presUnit: string;
  presDec: number;
  vis: (v: number) => number;
  visUnit: string;
  depth: (v: number) => number;
  depthUnit: string;
  depthDec: number;
  height: (v: number) => number;
  heightUnit: string;
};

/** Which panels a product draws. Overview is the four a chaser reads first. */
function buildPanels(product: StationProduct, c: Conv): MeteoPanel[] {
  const temp: MeteoPanel = {
    id: "temp",
    title: `Temperature (${c.tempUnit})`,
    height: 122,
    series: [
      { key: "tmpf", label: "Temp", color: "var(--sx-temp)", to: c.temp, unit: c.tempUnit, fill: true },
      { key: "dwpf", label: "Dewpoint", color: "var(--sx-dewp)", to: c.temp, unit: c.tempUnit },
      { key: "feel", label: "Feels like", color: "var(--sx-feel)", to: c.temp, unit: c.tempUnit, dashed: true },
    ],
  };
  const wind: MeteoPanel = {
    id: "wind",
    title: `Wind (${c.windUnit.trim()})`,
    height: 118,
    arrows: true,
    zero: true,
    series: [
      { key: "gust", label: "Gust", color: "var(--sx-gust)", kind: "bar", to: c.wind, unit: c.windUnit },
      { key: "sknt", label: "Wind", color: "var(--sx-wind)", to: c.wind, unit: c.windUnit },
    ],
  };
  const pressure: MeteoPanel = {
    id: "pressure",
    title: `Pressure (${c.presUnit.trim()})`,
    height: 110,
    series: [
      { key: "presMb", label: "Pressure", color: "var(--sx-pres)", to: c.mslp, unit: c.presUnit, dec: c.presDec, fill: true },
    ],
  };
  const mslpOnly: MeteoPanel = {
    ...pressure,
    id: "mslp",
    title: `Sea-level pressure (${c.presUnit.trim()})`,
    series: [
      { key: "mslp", label: "MSLP", color: "var(--sx-pres)", to: c.mslp, unit: c.presUnit, dec: c.presDec, fill: true },
    ],
  };
  const precip: MeteoPanel = {
    id: "precip",
    title: `Hourly precipitation (${c.depthUnit.trim()})`,
    height: 104,
    zero: true,
    series: [
      { key: "p01i", label: "Precip", color: "var(--sx-precip)", kind: "bar", to: c.depth, unit: c.depthUnit, dec: c.depthDec },
    ],
  };
  const humidity: MeteoPanel = {
    id: "rh",
    title: "Relative humidity (%)",
    height: 104,
    domain: [0, 100],
    ticks: [0, 25, 50, 75, 100],
    series: [{ key: "relh", label: "Humidity", color: "var(--sx-precip)", unit: "%", fill: true }],
  };
  const direction: MeteoPanel = {
    id: "drct",
    title: "Wind direction",
    height: 96,
    domain: [0, 360],
    ticks: [0, 90, 180, 270, 360],
    tickLabel: (v) => ["N", "E", "S", "W", "N"][Math.round(v / 90)] ?? "",
    series: [{ key: "drct", label: "Direction", color: "var(--sx-wind)", kind: "dots", unit: "°" }],
  };
  const visibility: MeteoPanel = {
    id: "vsby",
    title: `Visibility (${c.visUnit.trim()})`,
    height: 108,
    zero: true,
    ribbon: true,
    series: [{ key: "vsby", label: "Visibility", color: "var(--sx-vis)", to: c.vis, unit: c.visUnit, dec: 1, fill: true }],
  };
  const ceiling: MeteoPanel = {
    id: "ceiling",
    title: `Ceiling (${c.heightUnit.trim()})`,
    height: 108,
    zero: true,
    series: [{ key: "ceiling", label: "Ceiling", color: "var(--sx-ceil)", to: c.height, unit: c.heightUnit, fill: true }],
  };
  const altimeter: MeteoPanel = {
    id: "alti",
    title: `Altimeter (${c.presUnit.trim()})`,
    height: 104,
    series: [{ key: "alti", label: "Altimeter", color: "var(--sx-vis)", to: c.pres, unit: c.presUnit, dec: c.presDec }],
  };

  switch (product) {
    case "temp":
      return [temp, humidity];
    case "wind":
      return [wind, direction];
    case "pressure":
      return [mslpOnly, altimeter];
    case "sky":
      return [ceiling, visibility];
    case "precip":
      return [precip, humidity];
    default:
      return [temp, wind, pressure, precip];
  }
}
