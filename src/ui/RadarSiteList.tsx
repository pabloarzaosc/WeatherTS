import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, LocateFixed, Search, Star, X } from "lucide-react";

import type { NexradSite } from "../lib/nexrad";
import { classLine, countryName, distanceKm, fmtKm, isUS, placeOf, typeOf, US_STATES, type SiteClass } from "../lib/radarSites";
import { useSetting } from "../settings/useSettingsStore";
import { pickRadar } from "../lib/radarSitesInstall";
import { useDragOffset } from "../lib/useDragOffset";
import { currentFix } from "../lib/geolocate";
import { getMap } from "../map/mapInstance";
import { hasAccount, requireAccount } from "../store/useAccountGate";
import { useNexradStore } from "../store/useNexradStore";
import { siteAgeNow, siteClass, siteRow, useRadarSitesStore, type SortCol } from "../store/useRadarSitesStore";

/**
 * Every radar in one table (radar-sites): sortable by any column, a filter
 * box, filters for favourites / recent / type / state, in sections Recent,
 * United States, TDWR and Other. Double-click (or Enter) opens a radar; a radar
 * that is down shows why instead.
 */

const RANK: Record<SiteClass | "none", number> = { ok: 0, late: 1, stale: 2, unknown: 3, none: 3, down: 4 };

interface Row {
  s: NexradSite;
  cls: SiteClass | "none";
  km: number;
  fav: boolean;
  place: string;
  type: string;
}

const COLS: { col: SortCol; label: string; cls?: string }[] = [
  { col: "status", label: "", cls: "sitelist__c-dot" },
  { col: "id", label: "ID" },
  { col: "place", label: "Place" },
  { col: "state", label: "State" },
  { col: "country", label: "Country" },
  { col: "type", label: "Type" },
  { col: "distance", label: "Distance", cls: "sitelist__c-num" },
];

function compare(a: Row, b: Row, col: SortCol): number {
  switch (col) {
    case "status":
      return RANK[a.cls] - RANK[b.cls];
    case "place":
      return a.place.localeCompare(b.place);
    case "state":
      return (a.s.state || "~").localeCompare(b.s.state || "~");
    case "country":
      return countryName(a.s.country).localeCompare(countryName(b.s.country));
    case "type":
      return a.type.localeCompare(b.type);
    case "distance":
      return a.km - b.km;
    default:
      return a.s.icao.localeCompare(b.s.icao);
  }
}

function matches(r: Row, words: string[]): boolean {
  if (!words.length) return true;
  const st = r.s.state || "";
  const hay = [r.s.icao, r.s.id, r.place, r.s.name, st, US_STATES[st] ?? "", countryName(r.s.country), r.type, r.s.wfo ?? ""]
    .join(" ")
    .toUpperCase();
  return words.every((w) => hay.includes(w));
}

export function RadarSiteList() {
  const open = useRadarSitesStore((s) => s.listOpen);
  return open ? <SiteListPanel /> : null;
}

function SiteListPanel() {
  const sites = useNexradStore((s) => s.sites);
  const current = useNexradStore((s) => s.site);
  // re-classed on each new standing and on archive switches
  const feed = useRadarSitesStore((s) => s.feed);
  const archive = useNexradStore((s) => s.archiveTime !== null || s.archiveDate !== null);
  const favourites = useRadarSitesStore((s) => s.favourites);
  const recents = useRadarSitesStore((s) => s.recents);
  const sort = useRadarSitesStore((s) => s.sort);
  const filters = useRadarSitesStore((s) => s.filters);
  const from = useRadarSitesStore((s) => s.from);
  const unit = useSetting<string>("radar.readoutDistance");
  const { setSort, setFilters, setListOpen, toggleFavourite, setFrom } = useRadarSitesStore.getState();
  const drag = useDragOffset("siteList");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [noFix, setNoFix] = useState(false);
  const [centre, setCentre] = useState(() => getMap()?.getCenter() ?? null);

  useEffect(() => {
    inputRef.current?.focus();
    const map = getMap();
    if (!map) return;
    const onMove = () => setCentre(map.getCenter());
    map.on("moveend", onMove);
    return () => {
      map.off("moveend", onMove);
    };
  }, []);

  const ref = from ?? (centre ? { lat: centre.lat, lon: centre.lng, label: "the map centre" } : null);

  const rows: Row[] = useMemo(
    () =>
      sites.map((s) => ({
        s,
        cls: siteClass(s.id),
        km: ref ? distanceKm(ref.lat, ref.lon, s.lat, s.lon) : 0,
        fav: favourites.includes(s.id),
        place: placeOf(s),
        type: typeOf(s),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sites, favourites, ref?.lat, ref?.lon, feed, archive],
  );

  const types = useMemo(() => [...new Set(rows.map((r) => r.type))].sort(), [rows]);
  const states = useMemo(() => [...new Set(rows.map((r) => r.s.state).filter(Boolean) as string[])].sort(), [rows]);

  const sections = useMemo(() => {
    const words = filters.text.trim().toUpperCase().split(/\s+/).filter(Boolean);
    const keep = rows.filter(
      (r) =>
        matches(r, words) &&
        (!filters.fav || r.fav) &&
        (!filters.recent || recents.includes(r.s.id)) &&
        (!filters.type || r.type === filters.type) &&
        (!filters.state || r.s.state === filters.state),
    );
    const by = (a: Row, b: Row) => sort.dir * compare(a, b, sort.col) || a.s.icao.localeCompare(b.s.icao);
    const recent = recents.map((id) => keep.find((r) => r.s.id === id)).filter(Boolean) as Row[];
    // the Recent chip keeps the recent radars: once each, not twice
    const rest = filters.recent ? [] : keep;
    const us = rest.filter((r) => isUS(r.s) && r.s.type !== "TDWR").sort(by);
    const tdwr = rest.filter((r) => r.s.type === "TDWR").sort(by);
    const other = rest.filter((r) => !isUS(r.s)).sort(by);
    return [
      { id: "recent", label: "Recent", rows: recent },
      { id: "us", label: "United States", rows: us },
      { id: "tdwr", label: "TDWR · airport radars", rows: tdwr },
      { id: "other", label: "Other", rows: other },
    ].filter((sec) => sec.rows.length);
  }, [rows, filters, sort, recents]);

  // keyboard order: as drawn
  const order = useMemo(() => sections.flatMap((sec) => sec.rows.map((r) => `${sec.id}:${r.s.id}`)), [sections]);
  const total = useMemo(() => new Set(sections.flatMap((sec) => sec.rows.map((r) => r.s.id))).size, [sections]);

  useEffect(() => {
    if (active && order.includes(active)) {
      bodyRef.current?.querySelector(`[data-key="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }, [active, order]);

  const openRow = (id: string, e?: { clientX: number; clientY: number }) => {
    if (pickRadar(id, e ? { x: e.clientX, y: e.clientY } : undefined)) setListOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // a down radar's reasons on top: Esc closes those first
      if (useRadarSitesStore.getState().notice) return;
      e.preventDefault();
      setListOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!order.length) return;
      const i = active ? order.indexOf(active) : -1;
      const next = e.key === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
      setActive(order[next]);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      openRow(active.split(":")[1]);
    }
  };

  const fixPosition = async (): Promise<boolean> => {
    setLocating(true);
    setNoFix(false);
    try {
      const fix = await currentFix({ maximumAge: 300_000 });
      setFrom({ lat: fix.lat, lon: fix.lon, label: fix.source === "device" ? "your location" : "your location (approximate)" }, true);
      return true;
    } catch {
      // denied or unavailable: distances stay from the map centre
      setNoFix(true);
      return false;
    } finally {
      setLocating(false);
    }
  };

  const locate = async () => {
    if (from) {
      setFrom(null, false);
      return;
    }
    if (!requireAccount("location")) return;
    if (await fixPosition()) useRadarSitesStore.setState({ sort: { col: "distance", dir: 1 } });
  };

  // Asked for once: each time the list opens after that.
  useEffect(() => {
    const st = useRadarSitesStore.getState();
    if (st.fromMine && !st.from && hasAccount()) void fixPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={drag.ref}
      className={`sitelist${drag.dragging ? " is-dragging" : ""}`}
      style={drag.style}
      role="dialog"
      aria-label="Radar sites"
      // a click on a row keeps the keys here (arrows, Enter, Esc)
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="sitelist__head" {...drag.handle}>
        <b>Radar sites</b>
        <span className="sitelist__sub">
          {total} of {sites.length} · double-click to open
        </span>
        <button type="button" className="sitelist__x" onClick={() => setListOpen(false)} title="Close (Esc)">
          <X size={14} />
        </button>
      </div>

      <div className="sitelist__tools">
        <label className="sitelist__search">
          <Search size={13} />
          <input
            ref={inputRef}
            type="text"
            value={filters.text}
            placeholder="Filter: id, place, state…"
            spellCheck={false}
            onChange={(e) => {
              setFilters({ text: e.target.value });
              setActive(null);
            }}
          />
        </label>
        <button
          type="button"
          className={`sitelist__chip${filters.fav ? " is-on" : ""}`}
          aria-pressed={filters.fav}
          onClick={() => setFilters({ fav: !filters.fav })}
        >
          <Star size={11} /> Favourites
        </button>
        <button
          type="button"
          className={`sitelist__chip${filters.recent ? " is-on" : ""}`}
          aria-pressed={filters.recent}
          onClick={() => setFilters({ recent: !filters.recent })}
        >
          Recent
        </button>
        <select
          className="sitelist__select"
          value={filters.type}
          aria-label="Type"
          onChange={(e) => setFilters({ type: e.target.value })}
        >
          <option value="">Any type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="sitelist__select"
          value={filters.state}
          aria-label="State"
          onChange={(e) => setFilters({ state: e.target.value })}
        >
          <option value="">Any state</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
              {US_STATES[s] ? ` · ${US_STATES[s]}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="sitelist__from">
        <span>
          Distance from {ref?.label ?? "—"}
          {noFix ? " · your location is not available" : ""}
        </span>
        <button type="button" className="sitelist__link" onClick={() => void locate()} disabled={locating}>
          <LocateFixed size={11} />
          {from ? "Use the map centre" : locating ? "Locating…" : "From my location"}
        </button>
      </div>

      <div className="sitelist__body" ref={bodyRef}>
        <table className="sitelist__table">
          <thead>
            <tr>
              <th className="sitelist__c-fav" aria-label="Favourite" />
              {COLS.map((c) => (
                <th
                  key={c.col}
                  className={`${c.cls ?? ""}${sort.col === c.col ? " is-sorted" : ""}`}
                  aria-sort={sort.col === c.col ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                >
                  <button type="button" onClick={() => setSort(c.col)} title={c.col === "status" ? "Sort by status" : `Sort by ${c.label.toLowerCase()}`}>
                    {c.col === "status" ? <span className="sitedot sitedot--unknown" /> : c.label}
                    {sort.col === c.col && (sort.dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          {sections.map((sec) => (
            <tbody key={sec.id}>
              <tr className="sitelist__sec">
                <th colSpan={COLS.length + 1}>
                  {sec.label} <span>{sec.rows.length}</span>
                </th>
              </tr>
              {sec.rows.map((r) => {
                const key = `${sec.id}:${r.s.id}`;
                const row = siteRow(r.s.id);
                const why = r.cls === "none" ? (archive ? "Archive: any radar can be opened" : "Reading the radars' status…") : classLine(row, siteAgeNow(row));
                return (
                  <tr
                    key={key}
                    data-key={key}
                    className={`sitelist__row${active === key ? " is-active" : ""}${r.s.id === current ? " is-current" : ""}${r.cls === "down" ? " is-down" : ""}`}
                    onClick={() => setActive(key)}
                    onDoubleClick={(e) => openRow(r.s.id, e)}
                    title={r.cls === "down" ? `${why} · double-click for the reason` : why}
                  >
                    <td className="sitelist__c-fav">
                      <button
                        type="button"
                        className={`sitestar${r.fav ? " is-on" : ""}`}
                        aria-label={r.fav ? `Remove ${r.s.icao} from favourites` : `Add ${r.s.icao} to favourites`}
                        aria-pressed={r.fav}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavourite(r.s.id);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <Star size={12} />
                      </button>
                    </td>
                    <td className="sitelist__c-dot">
                      <span className={`sitedot sitedot--${r.cls}`} />
                    </td>
                    <td className="sitelist__c-id">{r.s.icao}</td>
                    <td className="sitelist__c-place">{r.place}</td>
                    <td>{r.s.state || "—"}</td>
                    <td>{countryName(r.s.country)}</td>
                    <td>{r.type}</td>
                    <td className="sitelist__c-num">{ref ? fmtKm(r.km, unit) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
        {!sections.length && <div className="sitelist__empty">No radar matches these filters.</div>}
      </div>
    </div>
  );
}
