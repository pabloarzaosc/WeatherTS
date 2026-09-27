import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

import { useAppStore } from "../../store/useAppStore";
import { LayerPower } from "../LayerPower";
import {
  LSR_CATEGORIES,
  LSR_LABELS,
  LSR_SHORT,
  type LsrCategory,
  type LsrFeature,
  fetchLsrTypes,
  lsrCsv,
  lsrEf,
  lsrGeoJson,
  lsrHm,
  lsrKey,
  lsrMph,
  lsrPlace,
  lsrSeverity,
  type LsrSeverity,
  type LsrTypeInfo,
} from "../../lib/lsr";
import {
  LSR_WINDOWS,
  isNewLsr,
  lsrFeed,
  selectVisibleLsr,
  useLsrStore,
  type LsrBounds,
  type LsrSpan,
} from "../../store/useLsrStore";
import { getMap } from "../../map/mapInstance";
import { downloadBlob } from "../../lib/gifExport";
import { LsrShape } from "../LsrShape";

const LAYER = "lsr";
/** Rows listed before "show more": a long list is scrolled, not read. */
const PAGE = 120;

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`sfc-switch${on ? " is-on" : ""}`}
      onClick={onClick}
      role="switch"
      aria-checked={on}
      aria-label={label}
    >
      <span className="sfc-switch__knob" />
    </button>
  );
}

function ago(unix: number): string {
  const m = (Date.now() / 1000 - unix) / 60;
  if (m < 60) return `${Math.max(0, Math.round(m))}m`;
  if (m < 48 * 60) return `${(m / 60).toFixed(m < 600 ? 1 : 0)}h`;
  return `${Math.round(m / 1440)}d`;
}

const SPANS: Array<{ id: LsrSpan; label: string; title: string }> = [
  ...LSR_WINDOWS.map((h) => ({ id: h as LsrSpan, label: `${h}h`, title: `The last ${h} hours` })),
  { id: "day", label: "12Z", title: "The convective day: since the last 12Z, as SPC's report pages count it" },
];

/** The four hazards a chaser asks about first, each a count and its worst. */
interface Tile {
  cat: LsrCategory;
  label: string;
  count: number;
  worst: string;
}

function summarise(features: LsrFeature[]): { tiles: Tile[]; severe: number; sig: number } {
  let severe = 0;
  let sig = 0;
  let ef: number | null = null;
  let funnels = 0;
  let hail = 0;
  let gust = 0;
  let damage = 0;
  let flash = 0;
  const n: Partial<Record<LsrCategory, number>> = {};
  for (const f of features) {
    const p = f.properties;
    n[p.cat] = (n[p.cat] ?? 0) + 1;
    const s = lsrSeverity(p);
    if (s >= 1) severe += 1;
    if (s === 2) sig += 1;
    if (p.code === "T") {
      const e = lsrEf(p);
      if (e != null) ef = Math.max(ef ?? 0, e);
    }
    if (p.cat === "funnel") funnels += 1;
    if (p.cat === "hail" && p.magf != null) hail = Math.max(hail, p.magf);
    if (p.cat === "tstorm") {
      const mph = lsrMph(p);
      if (mph != null) gust = Math.max(gust, mph);
      if (p.code === "D" || p.code === "B") damage += 1;
    }
    if (p.code === "F") flash += 1;
  }
  const tiles: Tile[] = [
    {
      cat: "tornado",
      label: "Tornado",
      count: n.tornado ?? 0,
      worst: ef != null ? `EF${ef} max` : n.tornado ? "unrated" : funnels ? `${funnels} funnel` : "none",
    },
    { cat: "hail", label: "Hail", count: n.hail ?? 0, worst: hail ? `max ${hail.toFixed(2)}"` : "none" },
    {
      cat: "tstorm",
      label: "Wind",
      count: n.tstorm ?? 0,
      worst: gust ? `max ${Math.round(gust)} mph` : damage ? `${damage} damage` : "none",
    },
    { cat: "flood", label: "Flood", count: n.flood ?? 0, worst: flash ? `${flash} flash` : "none" },
  ];
  return { tiles, severe, sig };
}

/** The map's view as [west, south, east, north], kept current while wanted. */
function useMapBounds(on: boolean): LsrBounds | null {
  const [bounds, setBounds] = useState<LsrBounds | null>(null);
  useEffect(() => {
    if (!on) {
      setBounds(null);
      return;
    }
    const map = getMap();
    if (!map) return;
    const read = () => {
      const b = map.getBounds();
      setBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    read();
    map.on("moveend", read);
    return () => {
      map.off("moveend", read);
    };
  }, [on]);
  return bounds;
}

/** "Tue 21:00Z": a window of a day or more has the same clock time at both ends. */
function dayHm(unix: number): string {
  return `${new Date(unix * 1000).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${lsrHm(unix)}`;
}

function fileStamp(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

/** Local Storm Reports panel: what came in, how bad, where -- and the feed. */
export function LsrView() {
  const enabled = useAppStore((s) => s.layers[LAYER]?.visible ?? false);
  const setLayerVisible = useAppStore((s) => s.setLayerVisible);

  const span = useLsrStore((s) => s.span);
  const setSpan = useLsrStore((s) => s.setSpan);
  const cats = useLsrStore((s) => s.cats);
  const toggleCat = useLsrStore((s) => s.toggleCat);
  const soloCats = useLsrStore((s) => s.soloCats);
  const setAllCats = useLsrStore((s) => s.setAllCats);
  const minSeverity = useLsrStore((s) => s.minSeverity);
  const setMinSeverity = useLsrStore((s) => s.setMinSeverity);
  const showLabels = useLsrStore((s) => s.showLabels);
  const setShowLabels = useLsrStore((s) => s.setShowLabels);
  const fadeOld = useLsrStore((s) => s.fadeOld);
  const setFadeOld = useLsrStore((s) => s.setFadeOld);
  const inView = useLsrStore((s) => s.inView);
  const setInView = useLsrStore((s) => s.setInView);
  const search = useLsrStore((s) => s.search);
  const setSearch = useLsrStore((s) => s.setSearch);
  const sort = useLsrStore((s) => s.sort);
  const setSort = useLsrStore((s) => s.setSort);
  const busy = useLsrStore((s) => s.busy);
  const error = useLsrStore((s) => s.error);
  const endUnix = useLsrStore((s) => s.endUnix);
  const updatedAt = useLsrStore((s) => s.updatedAt);
  const data = useLsrStore((s) => s.data);
  const arrived = useLsrStore((s) => s.arrived);
  const selected = useLsrStore((s) => s.selected);
  const select = useLsrStore((s) => s.select);
  const setHovered = useLsrStore((s) => s.setHovered);

  // NOT `useLsrStore(selectVisibleLsr)`: zustand v5 compares the selector's
  // result by identity, so a selector that builds a new array every call
  // re-renders forever ("Maximum update depth exceeded"). Filter in a memo off
  // stable store values instead -- the same shape AlertPanel uses for
  // selectVisibleAlerts.
  const visible = useMemo(() => selectVisibleLsr({ data, cats, minSeverity }), [data, cats, minSeverity]);
  const bounds = useMapBounds(inView);
  const feed = useMemo(() => lsrFeed(visible, { search, sort, bounds }), [visible, search, sort, bounds]);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [data, cats, minSeverity, search, sort, bounds]);

  const summary = useMemo(() => summarise(data?.features ?? []), [data]);
  const selectedKey = selected ? lsrKey(selected) : null;

  useEffect(() => {
    if (enabled && !data) void useLsrStore.getState().load();
  }, [enabled, data]);
  // Leaving the panel must not leave a row's ring on the map.
  useEffect(() => () => useLsrStore.getState().setHovered(null), []);

  // The full type reference: every LSR code the NWS issues, grouped by the
  // category that colours it, with what each one actually means. Fetched once
  // and only when opened -- it is documentation, not live data.
  const [refOpen, setRefOpen] = useState(false);
  const [types, setTypes] = useState<LsrTypeInfo[] | null>(null);
  useEffect(() => {
    if (!refOpen || types) return;
    const ctrl = new AbortController();
    fetchLsrTypes(ctrl.signal)
      .then((r) => setTypes(r.types))
      .catch(() => setTypes([]));
    return () => ctrl.abort();
  }, [refOpen, types]);

  const typesByCat = useMemo(() => {
    const out = new Map<string, LsrTypeInfo[]>();
    for (const ty of types ?? []) {
      const list = out.get(ty.cat) ?? [];
      list.push(ty);
      out.set(ty.cat, list);
    }
    for (const list of out.values()) list.sort((a, b) => b.rank - a.rank);
    return out;
  }, [types]);

  // Per-category counts over everything fetched, so a filter shows what turning
  // it on would actually add.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of data?.features ?? []) out.set(f.properties.cat, (out.get(f.properties.cat) ?? 0) + 1);
    return out;
  }, [data]);
  const sevCounts: Record<LsrSeverity, number> = {
    0: data?.features.length ?? 0,
    1: summary.severe,
    2: summary.sig,
  };
  const onlyCat = LSR_CATEGORIES.filter((c) => cats[c]);
  const solo = onlyCat.length === 1 ? onlyCat[0] : null;

  const exportAs = (kind: "csv" | "geojson") => {
    if (!data || feed.length === 0) return;
    const name = `storm-reports_${fileStamp(data.meta.startUnix)}_${fileStamp(data.meta.endUnix)}`;
    if (kind === "csv") {
      downloadBlob(new Blob([lsrCsv(feed)], { type: "text/csv" }), `${name}.csv`);
    } else {
      const meta = { ...data.meta, count: feed.length, exported: new Date().toISOString() };
      downloadBlob(new Blob([lsrGeoJson(feed, meta)], { type: "application/geo+json" }), `${name}.geojson`);
    }
  };

  const windowText = data ? `${dayHm(data.meta.startUnix)} – ${dayHm(data.meta.endUnix)}` : "";

  return (
    <div className="sfcobs lsrv">
      <LayerPower
        label="Local Storm Reports"
        on={enabled}
        error={!!error}
        onToggle={() => setLayerVisible(LAYER, !enabled)}
      />

      {error && (
        <div className="sfcobs__error" role="alert">
          <AlertTriangle size={14} />
          <span>{error}</span>
          <button type="button" className="sfcobs__retry" onClick={() => void useLsrStore.getState().load()}>
            Retry
          </button>
        </div>
      )}

      {/* The summary first: how many of each hazard, and the worst of each. A
          tile narrows the map and the list to its hazard; again, back to all. */}
      <div className="lsrv__tiles">
        {summary.tiles.map((t) => (
          <button
            key={t.cat}
            type="button"
            className={`lsrv__tile${solo === t.cat ? " is-on" : ""}${t.count ? "" : " is-empty"}`}
            onClick={() => soloCats([t.cat])}
            aria-pressed={solo === t.cat}
            title={solo === t.cat ? "Show every type again" : `Only ${LSR_LABELS[t.cat].toLowerCase()} reports`}
          >
            <span className="lsrv__tilehead">
              <LsrShape cat={t.cat} size={12} />
              {t.label}
              <b>{t.count}</b>
            </span>
            <small>{t.worst}</small>
          </button>
        ))}
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Window</span>
          <em>
            {windowText}
            {endUnix != null ? " · on the timeline" : " · live"}
          </em>
        </div>
        <div className="lsrv__seg" role="group" aria-label="Time window">
          {SPANS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={span === s.id ? "is-on" : ""}
              onClick={() => setSpan(s.id)}
              aria-pressed={span === s.id}
              title={s.title}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="lsrv__field">
        <div className="lsrv__fieldhead">
          <span>Severity</span>
          <em>SPC criteria</em>
        </div>
        <div className="lsrv__seg lsrv__seg--sev" role="group" aria-label="Severity">
          {(
            [
              [0, "All"],
              [1, "Severe"],
              [2, "Significant"],
            ] as Array<[LsrSeverity, string]>
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              className={minSeverity === v ? "is-on" : ""}
              onClick={() => setMinSeverity(v)}
              aria-pressed={minSeverity === v}
              title={
                v === 0
                  ? "Every report in the window"
                  : v === 1
                    ? 'Tornadoes, hail 1" or larger, thunderstorm gusts of 58 mph or more, wind damage'
                    : 'EF2 or stronger, hail 2" or larger, gusts of 75 mph (65 kt) or more'
              }
            >
              {label}
              <b>{sevCounts[v]}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="sfcobs__section">
        Types
        <span className="lsrv__all">
          <button type="button" onClick={() => setAllCats(true)}>all</button>
          <button type="button" onClick={() => setAllCats(false)}>none</button>
        </span>
      </div>
      <div className="lsrv__cats">
        {LSR_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`lsrv__cat${cats[c] ? " is-on" : ""}`}
            onClick={(e) => (e.altKey ? soloCats([c]) : toggleCat(c))}
            onDoubleClick={() => soloCats([c])}
            aria-pressed={cats[c]}
            title={`${LSR_LABELS[c]} — double-click for only this type`}
          >
            <LsrShape cat={c} size={12} dim={!cats[c]} />
            <span>{LSR_SHORT[c]}</span>
            <b>{counts.get(c) ?? 0}</b>
          </button>
        ))}
      </div>

      <div className="lsrv__switches">
        <label>
          <span>Magnitudes on the map</span>
          <Toggle on={showLabels} onClick={() => setShowLabels(!showLabels)} label="Magnitudes on the map" />
        </label>
        <label>
          <span>Fade older reports</span>
          <Toggle on={fadeOld} onClick={() => setFadeOld(!fadeOld)} label="Fade older reports" />
        </label>
        <label>
          <span>List only what is on screen</span>
          <Toggle on={inView} onClick={() => setInView(!inView)} label="List only what is on screen" />
        </label>
      </div>

      <div className="sfcobs__section lsrv__feedhead">
        Feed
        {busy && <Loader2 size={12} className="spin" />}
        <span className="lsrv__updated">
          {updatedAt ? `updated ${lsrHm(updatedAt)}${endUnix == null ? " · every 2 min" : ""}` : ""}
        </span>
        <button
          type="button"
          className="lsrv__iconbtn"
          onClick={() => void useLsrStore.getState().load()}
          title="Check for new reports now"
          aria-label="Refresh"
          disabled={busy}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="lsrv__tools">
        <label className="lsrv__search">
          <Search size={12} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search town, county, office…"
            aria-label="Search the reports"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} aria-label="Clear the search">
              <X size={12} />
            </button>
          )}
        </label>
        <div className="lsrv__seg lsrv__seg--sort" role="group" aria-label="Order">
          <button type="button" className={sort === "new" ? "is-on" : ""} onClick={() => setSort("new")}>
            Newest
          </button>
          <button type="button" className={sort === "strong" ? "is-on" : ""} onClick={() => setSort("strong")}>
            Strongest
          </button>
        </div>
      </div>

      <div className="lsrv__count">
        <span>
          {feed.length} listed of {data?.features.length ?? 0}
          {inView ? " · on screen" : ""}
        </span>
        <span className="lsrv__export">
          <Download size={11} />
          <button type="button" onClick={() => exportAs("csv")} disabled={!feed.length} title="The listed reports as a spreadsheet">
            CSV
          </button>
          <button type="button" onClick={() => exportAs("geojson")} disabled={!feed.length} title="The listed reports as GeoJSON, for GIS">
            GeoJSON
          </button>
        </span>
      </div>

      {feed.length === 0 && !busy && (
        <div className="lsrv__none">
          {data?.features.length ? "No report matches the filters." : "No reports in this window."}
        </div>
      )}
      <ul className="lsrv__list" onMouseLeave={() => setHovered(null)}>
        {feed.slice(0, shown).map((f) => {
          const p = f.properties;
          const key = lsrKey(f);
          const sev = lsrSeverity(p);
          const fresh = isNewLsr(arrived, key);
          return (
            <li key={key}>
              <button
                type="button"
                className={`${selectedKey === key ? "is-on" : ""}${sev === 2 ? " is-sig" : ""}`}
                onMouseEnter={() => setHovered(key)}
                onFocus={() => setHovered(key)}
                onClick={() => {
                  select(f);
                  const map = getMap();
                  map?.flyTo({
                    center: f.geometry.coordinates as [number, number],
                    zoom: Math.max(map.getZoom(), 7),
                    essential: true,
                  });
                }}
              >
                <LsrShape cat={p.cat} size={13} />
                <span className="lsrv__what" title={p.desc}>
                  {p.typeName || p.label}
                  {p.mag && <b className={`lsrv__mag lsrv__mag--${sev}`}>{p.mag}</b>}
                  {fresh && <i className="lsrv__new">new</i>}
                </span>
                <span className="lsrv__where">{lsrPlace(p)}</span>
                <span className="lsrv__age">
                  <span>{lsrHm(p.unix)}</span>
                  <span>{ago(p.unix)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {feed.length > shown && (
        <button type="button" className="lsrv__morebtn" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, feed.length - shown)} more of {feed.length - shown}
        </button>
      )}

      <div className="sfcobs__section">Report types</div>
      <button
        type="button"
        className="lsrv__refbtn"
        onClick={() => setRefOpen((v) => !v)}
        aria-expanded={refOpen}
      >
        {refOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        What each report type means
        {types && <b>{types.length}</b>}
      </button>
      {refOpen && (
        <div className="lsrv__ref">
          {types === null && (
            <div className="lsrv__none">
              <Loader2 size={13} className="spin" /> Loading the type table…
            </div>
          )}
          {types?.length === 0 && <div className="lsrv__none">Type table unavailable.</div>}
          {LSR_CATEGORIES.filter((c) => typesByCat.has(c)).map((c) => (
            <section key={c}>
              <h5>
                <LsrShape cat={c} size={12} />
                {LSR_LABELS[c]}
              </h5>
              {(typesByCat.get(c) ?? []).map((ty) => (
                <div key={ty.code} className="lsrv__type">
                  <code>{ty.code}</code>
                  <div>
                    <b>{ty.label}</b>
                    <span>{ty.desc}</span>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
